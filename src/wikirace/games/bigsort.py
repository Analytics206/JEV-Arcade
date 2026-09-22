"""The Big Sort: thousands of Wikipedia articles sorted into topics while you watch.

TypeSafe's map-reduce over big data. The round is `count` random Wikipedia
articles, the first two sentences of each; every lane sorts every one of them
into one of eight topics (the map), and code tallies what came back (the
reduce): per-topic counts, throughput, what it cost and what all of it would
cost, and, where two lanes labelled the same articles, how often they agree.

**Jev** answers one choice per article over the eight topics, `concurrency`
questions in flight at once. **A text model** is asked the same thing, one
article a call, `text_concurrency` calls at once, and answers `TOPIC: <name>`;
a name that is not a topic is a foul. Every lane has `time_limit_s`: when it is
up, the lane stops where it is. A lane's score is the articles it sorted.

Each answer is one small push to the page (`labels`: `[article, topic, p]`,
topic −1 for a foul); costs and counts go out a few times a second.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..race.wiki import WikiError
from .base import Context, Game, GameSourceError
from .core import choice, match_option, opaque, read_choice, read_field
from .players import Asked, Player, Said, ask_jev, ask_text
from .runs import GameRun

#: Extracts per request: TextExtracts' ceiling for intros (`exlimit`).
PER_REQUEST = 20
#: Wikipedia requests in flight at once while the round is drawn.
_WIKI_PARALLEL = 3
#: An introduction longer than this is cut (two sentences rarely are).
TEXT_MAX = 400
#: How often a lane's counters and costs go to the page.
_FLUSH_S = 0.4
FOUL = -1

INSTRUCTIONS: dict[str, Any] = {
    "question": (
        "Which topic is the Wikipedia article about, whose title is in `title` and whose opening "
        "sentences are in `intro`?"
    ),
    "rules": [
        "Judge by what the article's subject is, as `intro` describes it.",
        "An article about one person is people, whatever the person is known for.",
        "Choose other only when no other topic fits.",
    ],
}


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "bigsort.json", encoding="utf-8") as f:
        return json.load(f)


@cache
def topics() -> tuple[dict[str, str], ...]:
    return tuple(data()["topics"])


def criterion(t: Mapping[str, str]) -> dict[str, str]:
    """A topic as Jev reads it."""
    return {"what": f"{t['name']}: {t['what']}", "not_for": t["not_for"]}


@cache
def text_system() -> str:
    listing = "\n".join(f"- {t['name']}: {t['what']} (not for: {t['not_for']})" for t in topics())
    return (
        "You sort Wikipedia articles into topics, one topic per article. You are shown an article's title "
        "and the first sentences of its introduction.\n\n"
        f"The topics:\n{listing}\n\n"
        "Rules:\n"
        "- An article about one person is people, whatever the person is known for.\n"
        "- Choose other only when no other topic fits.\n"
        "- Answer with a topic's name exactly as written above; anything else is a foul.\n\n"
        "Reply with exactly one line and nothing else:\n"
        "TOPIC: <a topic name>"
    )


def prompt_for(item: Mapping[str, str]) -> str:
    return f"TITLE: {item['title']}\nINTRO: {item['text']}"


@cache
def _topic_names() -> dict[str, int]:
    """Every way of naming a topic a reply may use, to its index: its name,
    its key, and `and` for `&`."""
    out: dict[str, int] = {}
    for k, t in enumerate(topics()):
        for alias in (t["name"], t["key"], t["name"].replace("&", "and")):
            out.setdefault(alias, k)
    return out


def read_topic(reply: str | None) -> tuple[int | None, str | None]:
    """(topic index or None for a foul, what the reply said)."""
    said = read_field(reply, "TOPIC")
    if said is None:
        rows = [r.strip() for r in (reply or "").splitlines() if r.strip()]
        said = rows[-1] if rows else None
    names = _topic_names()
    hit = match_option(said, list(names))
    return (names[hit] if hit is not None else None), (said[:60] if said else None)


def clean_text(text: str) -> str:
    t = " ".join((text or "").split())
    if len(t) <= TEXT_MAX:
        return t
    cut = t[:TEXT_MAX]
    return cut[: cut.rfind(" ")].rstrip(",;:") + "…"


_DISAMBIG = re.compile(r"\b(may|might|can) (also )?refer to\b", re.I)


def usable(page: Mapping[str, Any]) -> bool:
    """A random page worth sorting: an article with an introduction, not a
    disambiguation page."""
    if "disambiguation" in (page.get("pageprops") or {}):
        return False
    text = page.get("extract")
    if not isinstance(text, str) or len(text.strip()) < 20:
        return False
    return not _DISAMBIG.search(text[:200])


async def fetch_random(ctx: Context, count: int) -> list[dict[str, str]]:
    """*count* distinct random articles as [{title, text}]: twenty to a request
    (the extracts ceiling), a few requests at once, empty and disambiguation
    pages skipped."""
    params = {
        "action": "query", "generator": "random", "grnnamespace": 0, "grnlimit": PER_REQUEST,
        "prop": "extracts|pageprops", "ppprop": "disambiguation", "exintro": 1, "explaintext": 1,
        "exsentences": 2, "exlimit": PER_REQUEST,
    }
    wanted = math.ceil(count / PER_REQUEST)
    budget = wanted + wanted // 3 + 2
    seen: set[str] = set()
    items: list[dict[str, str]] = []
    sent = 0

    async def one() -> Any:
        try:
            body = await ctx.wiki.query(params)
        except WikiError as exc:
            raise GameSourceError(f"Wikipedia did not answer: {exc}") from exc
        if not isinstance(body, dict) or isinstance(body.get("error"), dict):
            err = body.get("error") if isinstance(body, dict) else None
            raise GameSourceError(f"Wikipedia: {(err or {}).get('info') or 'an unexpected answer'}")
        return body

    while len(items) < count and sent < budget:
        wave = min(_WIKI_PARALLEL, budget - sent, math.ceil((count - len(items)) / (PER_REQUEST * 0.9)))
        bodies = await asyncio.gather(*(one() for _ in range(max(1, wave))))
        sent += max(1, wave)
        for body in bodies:
            for page in (body.get("query") or {}).get("pages") or []:
                title = page.get("title")
                if not isinstance(title, str) or title in seen or not usable(page):
                    continue
                seen.add(title)
                items.append({"title": title, "text": clean_text(page["extract"])})
    if len(items) < min(count, PER_REQUEST):
        raise GameSourceError("Wikipedia gave too few random articles for this game")
    return items[:count]


# ── Tallies ───────────────────────────────────────────────────────────────────


def agreement(a: Mapping[int, int], b: Mapping[int, int], n_topics: int) -> dict[str, Any]:
    """Where two lanes both sorted an article (fouls left out): how many, how
    many the same, and the confusion table, rows *a*'s topic, columns *b*'s."""
    table = [[0] * n_topics for _ in range(n_topics)]
    both = agree = 0
    for k, ta in a.items():
        tb = b.get(k)
        if tb is None or ta < 0 or tb < 0:
            continue
        both += 1
        agree += ta == tb
        table[ta][tb] += 1
    return {"both": both, "agree": agree, "rate": round(agree / both, 4) if both else None, "confusion": table}


def pairs(kinds: Sequence[str]) -> list[tuple[int, int]]:
    """The lanes to compare: every Jev lane against every text lane, or every
    pair when they are all of one kind."""
    every = [(a, b) for a in range(len(kinds)) for b in range(a + 1, len(kinds))]
    mixed = [(a, b) for a, b in every if kinds[a] != kinds[b]]
    return [(a, b) if kinds[a] == "judgment" else (b, a) for a, b in mixed] or every


@dataclass
class Tally:
    """What a lane has answered since it last told the page."""

    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float = 0.0
    unpriced: bool = False
    estimated: bool = False
    latency_ms: int = 0
    fouls: int = 0
    dirty: bool = False

    def add(self, call: Asked | Said) -> None:
        self.calls += 1
        self.tokens_in += call.tokens_in
        self.tokens_out += getattr(call, "tokens_out", 0)
        if call.cost is None:
            self.unpriced = True
        else:
            self.cost += call.cost
        self.estimated |= isinstance(call, Asked) or bool(getattr(call, "cost_estimated", False))
        self.latency_ms += call.latency_ms
        self.dirty = True

    def as_call(self, jev: bool) -> Asked | Said:
        if jev:
            return Asked(answers={}, tokens_in=self.tokens_in, cost=self.cost, latency_ms=self.latency_ms,
                         model="", requests=self.calls)
        return Said(text="", tokens_in=self.tokens_in, tokens_out=self.tokens_out,
                    cost=None if self.unpriced and not self.cost else self.cost,
                    cost_estimated=self.estimated, latency_ms=self.latency_ms)


async def in_pool(n: int, workers: int, job: Callable[[int], Awaitable[None]]) -> None:
    """job(0 … n−1), *workers* at a time. The first failure calls the rest off."""
    todo = iter(range(n))

    async def worker() -> None:
        for k in todo:
            await job(k)

    tasks = [asyncio.ensure_future(worker()) for _ in range(max(1, min(workers, n)))]
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


# ── The game ──────────────────────────────────────────────────────────────────


class Params(BaseModel):
    count: int = Field(default=500, ge=20, le=2000, description="random articles to sort")
    concurrency: int = Field(default=32, ge=1, le=64, description="Jev's questions in flight at once")
    text_concurrency: int = Field(default=2, ge=1, le=8, description="a text model's calls in flight at once")
    time_limit_s: float = Field(default=120, ge=1, le=900, description="every lane stops where it is after this long")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    items = await fetch_random(ctx, p.count)
    return {
        "items": items, "total": len(items), "time_limit_s": p.time_limit_s,
        "topics": [{"key": t["key"], "name": t["name"]} for t in topics()],
        "agreement": [],
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    items: list[dict[str, str]] = run.state["items"]
    n, n_topics = len(items), len(topics())
    ids = opaque([t["key"] for t in topics()], f"bigsort|{run.id}", prefix="t")
    index_of = {t["key"]: k for k, t in enumerate(topics())}
    question = choice(INSTRUCTIONS, {oid: criterion(topics()[index_of[key]]) for oid, key in ids.items()})
    system = text_system()
    lanes = ctx.players
    labels: list[dict[int, int]] = [{} for _ in lanes]
    tallies = [Tally() for _ in lanes]
    in_flight = [0] * len(lanes)
    started = [0.0] * len(lanes)
    compare = pairs([pl.kind for pl in lanes])
    shown: dict[tuple[int, int], tuple[int, int]] = {}
    for i in range(len(lanes)):
        run.lane(i, sorted=0, topics=[0] * n_topics, rate=0.0, elapsed_ms=0, in_flight=0,
                 projected_cost=None, timed_out=False, score=0)

    def flush(i: int, **final: Any) -> None:
        t = tallies[i]
        if not t.dirty and not final:
            return
        ln = run.state["lanes"][i]
        got = labels[i]
        counts = [0] * n_topics
        for topic in got.values():
            if topic >= 0:
                counts[topic] += 1
        done = sum(counts)
        secs = max(1e-3, time.monotonic() - started[i]) if started[i] else 0.0
        cost = ln["cost"] + t.cost
        # Unpriced calls (no bill, no list price) would make any projection a guess.
        priced = not (ln["cost_unknown"] or t.unpriced)
        fields: dict[str, Any] = {
            "sorted": done, "score": done, "topics": counts, "in_flight": in_flight[i],
            "rate": round(len(got) / secs, 2) if secs else 0.0, "elapsed_ms": int(secs * 1000),
            "projected_cost": round(cost / len(got) * n, 6) if got and priced else None, **final,
        }
        if t.calls:
            if t.fouls:
                fields["fouls"] = ln["fouls"] + t.fouls
            if t.unpriced:
                fields["cost_unknown"] = True
            run.account(i, t.as_call(lanes[i].is_jev), calls=ln["calls"] + t.calls, **fields)
        else:
            run.lane(i, **fields)
        tallies[i] = Tally()

    def compare_all() -> None:
        now = {(a, b): agreement(labels[a], labels[b], n_topics) for a, b in compare}
        key = {ab: (r["both"], r["agree"]) for ab, r in now.items()}
        if key != shown:
            shown.clear()
            shown.update(key)
            run.patch(agreement=[{"a": a, "b": b, **r} for (a, b), r in now.items()])

    async def ticker() -> None:
        while True:
            await asyncio.sleep(_FLUSH_S)
            for i in range(len(lanes)):
                flush(i)
            compare_all()

    async def lane(pl: Player) -> None:
        i = pl.index
        started[i] = time.monotonic()
        on_wait = run.waiting(i)

        async def sort_jev(k: int) -> None:
            in_flight[i] += 1
            try:
                asked = await ask_jev(pl, {"title": items[k]["title"], "intro": items[k]["text"]},
                                      {"topic": question}, on_wait=on_wait)
            finally:
                in_flight[i] -= 1
            pick = read_choice(asked.answers["topic"], ids)
            topic = index_of[pick.option]
            labels[i][k] = topic
            tallies[i].add(asked)
            run.lane_push(i, "labels", [k, topic, round(pick.p, 3)])

        async def sort_text(k: int) -> None:
            in_flight[i] += 1
            try:
                said = await ask_text(pl, system, prompt_for(items[k]), on_wait=on_wait)
            finally:
                in_flight[i] -= 1
            topic, words = read_topic(said.text)
            tallies[i].add(said)
            if topic is None:
                labels[i][k] = FOUL
                tallies[i].fouls += 1
                run.lane_push(i, "labels", [k, FOUL, None, words])
            else:
                labels[i][k] = topic
                run.lane_push(i, "labels", [k, topic, None])

        job, workers = (sort_jev, p.concurrency) if pl.is_jev else (sort_text, p.text_concurrency)
        try:
            async with asyncio.timeout(p.time_limit_s):
                await in_pool(n, workers, job)
        except TimeoutError:
            done = sum(1 for topic in labels[i].values() if topic >= 0)
            flush(i, timed_out=True, in_flight=0,
                  note=f"time's up after {p.time_limit_s:g} s: sorted {done} of {n}")
            return
        finally:
            in_flight[i] = 0
        flush(i, in_flight=0)

    tick = asyncio.ensure_future(ticker())
    try:
        await run.each_lane(lane)
    finally:
        tick.cancel()
        await asyncio.gather(tick, return_exceptions=True)
        for i in range(len(lanes)):
            flush(i)
        compare_all()


GAME = Game(
    id="bigsort", title="The Big Sort",
    tagline="Thousands of articles sorted into topics while you watch",
    use_case="map-reduce over big data", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
