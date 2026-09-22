"""Judges' Panel: Jev scores each quality once; you decide what matters.

TypeSafe's composite scoring. A topic (dog breeds, national parks,
programming languages, board games) brings six to eight contestants, each a
Wikipedia article, and five judges, each one quality with a 0 to 4 rubric
("good with kids", "fits an apartment", …).

**Jev** is asked once per contestant: one request over the contestant's
name and its Wikipedia introduction, holding five Score questions, one per
judge, the rubric as the levels. Every contestant is asked at once. Each
answer is a distribution over the five levels; the run keeps its mean (the
card a judge holds up), its spread and the level probabilities.

The weights are not Jev's business: the page applies them in code,
composite = Σ w·(score/4) / Σ w, so dragging a weight re-ranks the board
with no new request. That is the pattern: measure each quality once, decide
what matters afterwards.

**A text model** on the panel reads the same introduction and answers one
line per judge, `JUDGE <n>: <0-4>`. A missing score, or one outside 0 to 4,
is a foul for that judge, and that judge holds up no card.

A lane's score is the number of cards its judges held up.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
from functools import cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..race.wiki import WikiError, article_url
from .base import Context, Game, GameSourceError
from .core import read_field, read_score, score
from .players import Player, ask_jev, ask_text, together
from .runs import GameRun

#: Every rubric has five levels, 0 … 4.
LEVELS = 5
#: How much of an introduction the judges read, cut at a sentence.
ARTICLE_CHARS = 1800
#: Requests a lane has out at once.
JEV_PARALLEL = 16
TEXT_PARALLEL = 4


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "judges.json", encoding="utf-8") as f:
        return json.load(f)


def topics() -> list[dict[str, Any]]:
    return data()["topics"]


def topic_of(tid: str | None) -> dict[str, Any] | None:
    return next((t for t in topics() if t["id"] == tid), None)


def public_topic(t: dict[str, Any]) -> dict[str, Any]:
    """What the page shows of a topic: everything but its contestants' titles."""
    return {
        "id": t["id"], "title": t["title"], "kind": t["kind"], "plural": t["plural"], "heading": t["heading"],
        "judges": [{k: j[k] for k in ("id", "label", "short", "question", "levels")} for j in t["judges"]],
        "presets": t["presets"],
    }


# ── Jev ───────────────────────────────────────────────────────────────────────


def instructions(t: dict[str, Any], judge: dict[str, Any]) -> dict[str, Any]:
    return {
        "question": judge["question"],
        "rules": [
            f"`name` is a {t['kind']}, and `article` is the introduction of its Wikipedia article.",
            "Judge from `article`; where it says nothing about this, use what is commonly known about `name`.",
            "Choose the one level whose description fits `name` best.",
        ],
    }


def questions(t: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """The five Score questions asked about every contestant, by judge id."""
    return {j["id"]: score(instructions(t, j), j["levels"]) for j in t["judges"]}


# ── Text models ───────────────────────────────────────────────────────────────


def text_system(t: dict[str, Any]) -> str:
    n = len(t["judges"])
    blocks = []
    for k, j in enumerate(t["judges"], 1):
        rubric = "\n".join(f"  {lv} = {text}" for lv, text in enumerate(j["levels"]))
        blocks.append(f"JUDGE {k}, {j['label']}: {j['question'].replace('`name`', 'CONTESTANT')}\n{rubric}")
    lines = "\n".join(f"JUDGE {k}: <0-4>" for k in range(1, n + 1))
    return (
        f"You sit on a panel of {n} judges scoring {t['plural']}. Each contestant is a {t['kind']}, and "
        f"each judge scores one quality from 0 to 4 by its rubric.\n\n"
        + "\n\n".join(blocks)
        + "\n\nRules:\n"
        "- Score the CONTESTANT from its ARTICLE (the introduction of its Wikipedia article) and from what is "
        "commonly known about it.\n"
        "- Each score is one whole number from 0 to 4: the level whose description fits best.\n"
        "- A missing score, or one outside 0 to 4, is a foul for that judge.\n\n"
        f"Reply with exactly {n} lines and nothing else:\n{lines}"
    )


def text_prompt(c: dict[str, Any]) -> str:
    return f"CONTESTANT: {c['name']}\n\nARTICLE:\n{c['article']}"


_NUMBER = re.compile(r"^[\s(\[]*([+-]?\d+(?:[.,]\d+)?)")


def read_judge(reply: str | None, n: int) -> float | None:
    """Judge *n*'s score in a text model's reply, or None (a foul): missing,
    not a number, or outside 0 … 4."""
    value = read_field(reply, f"JUDGE {n}")
    if value is None and reply:
        # `JUDGE 2 (Fits an apartment): 3`: a label between the name and the colon.
        found = re.findall(rf"^[ \t>*_`#-]*JUDGE[ \t]*{n}\b[^:：\n]*[:：][ \t*_`]*([^\n]*)$", reply, re.I | re.M)
        value = found[-1].strip() if found else None
    if not value:
        return None
    m = _NUMBER.match(value)
    if m is None:
        return None
    x = float(m.group(1).replace(",", "."))
    return x if 0 <= x <= LEVELS - 1 else None


# ── Wikipedia ─────────────────────────────────────────────────────────────────


def trim_article(text: str, limit: int = ARTICLE_CHARS) -> str:
    """An introduction as the judges read it: blank lines and empty
    pronunciation brackets gone, cut at a sentence past *limit*."""
    t = re.sub(r"\(\s*[;,]?\s*\)", "", text or "")
    t = re.sub(r"[ \t]+", " ", t)
    t = "\n".join(p.strip() for p in t.splitlines() if p.strip())
    if len(t) <= limit:
        return t
    cut = t.rfind(". ", 0, limit)
    return t[: cut + 1] if cut > limit // 3 else t[:limit].rstrip() + "…"


async def fetch_intros(wiki: Any, titles: list[str]) -> dict[str, str]:
    """{title: introduction} for every title, in one request. Raises
    GameSourceError when Wikipedia fails or leaves one out."""
    try:
        body = await wiki.query({
            "action": "query", "prop": "extracts", "exintro": "1", "explaintext": "1",
            "exlimit": "max", "redirects": "1", "titles": "|".join(titles),
        })
    except WikiError as exc:
        raise GameSourceError(f"Wikipedia did not send the contestants' introductions: {exc}") from exc
    q = (body or {}).get("query") or {}
    # Follow Wikipedia's normalisation, then its redirects, back to the titles asked for.
    now = {t: t for t in titles}
    for step in [*(q.get("normalized") or []), *(q.get("redirects") or [])]:
        for asked, current in now.items():
            if current == step.get("from"):
                now[asked] = step.get("to")
    pages = {pg.get("title"): pg for pg in q.get("pages") or [] if isinstance(pg, dict)}
    out: dict[str, str] = {}
    for t in titles:
        pg = pages.get(now[t]) or {}
        text = trim_article(pg.get("extract") or "") if not pg.get("missing") else ""
        if text:
            out[t] = text
    lost = [t for t in titles if t not in out]
    if lost:
        raise GameSourceError(f"Wikipedia sent no introduction for {', '.join(lost[:3])}")
    return out


# ── The game ──────────────────────────────────────────────────────────────────




#: The topics' ids, as the setup may name one (a Literal: an unknown one is a 422).
TopicId = Literal[tuple(t["id"] for t in topics())]  # type: ignore[valid-type]


class Params(BaseModel):
    topic: TopicId | None = Field(  # type: ignore[valid-type]
        default=None, description="what the panel judges; none draws one",
        json_schema_extra={"options": [{"id": t["id"], "title": t["title"]} for t in topics()]},
    )
    seed: int | None = Field(default=None, description="the same seed draws the same topic")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    t = topic_of(p.topic) if p.topic else random.Random(p.seed).choice(topics())
    titles = [c["title"] for c in t["contestants"]]
    intros = await fetch_intros(ctx.wiki, titles)
    ctx.private["topic"] = t
    contestants = [
        {"i": k, "name": c["name"], "title": c["title"], "url": article_url(c["title"]), "article": intros[c["title"]]}
        for k, c in enumerate(t["contestants"])
    ]
    return {"topic": public_topic(t), "contestants": contestants, "levels": LEVELS}


async def play(run: GameRun, ctx: Context) -> None:
    t: dict[str, Any] = ctx.private["topic"]
    contestants: list[dict[str, Any]] = run.state["contestants"]
    judge_ids = [j["id"] for j in t["judges"]]
    asked_of = questions(t)
    system = text_system(t)
    for i in range(len(ctx.players)):
        run.lane(i, scored=[], score=0)

    def record(pl: Player, call: Any, item: dict[str, Any]) -> None:
        i = pl.index
        ln = run.state["lanes"][i]
        given = sum(1 for j in item["judges"] if j is not None)
        missing = len(item["judges"]) - given
        run.lane_push(i, "scored", item)
        also: dict[str, Any] = {"score": ln["score"] + given}
        if missing:
            also["fouls"] = ln["fouls"] + missing
        run.account(i, call, **also)

    async def jev_one(pl: Player, c: dict[str, Any]) -> None:
        state = {"name": c["name"], "article": c["article"]}
        asked = await ask_jev(pl, state, asked_of, on_wait=run.waiting(pl.index))
        judged = [read_score(asked.answers[jid], LEVELS).public() for jid in judge_ids]
        record(pl, asked, {"c": c["i"], "judges": judged, "ms": asked.latency_ms})

    async def text_one(pl: Player, c: dict[str, Any]) -> None:
        said = await ask_text(pl, system, text_prompt(c), on_wait=run.waiting(pl.index))
        judged: list[dict[str, Any] | None] = []
        for n in range(1, len(judge_ids) + 1):
            x = read_judge(said.text, n)
            judged.append(None if x is None else {"score": x, "spread": 0.0, "level": int(x + 0.5), "probabilities": None})
        record(pl, said, {"c": c["i"], "judges": judged, "ms": said.latency_ms, "said": said.text.strip()[:400]})

    async def lane(pl: Player) -> None:
        gate = asyncio.Semaphore(JEV_PARALLEL if pl.is_jev else TEXT_PARALLEL)
        one = jev_one if pl.is_jev else text_one

        async def judged(c: dict[str, Any]) -> None:
            async with gate:
                await one(pl, c)

        await together(judged(c) for c in contestants)

    await run.each_lane(lane)


GAME = Game(
    id="judges", title="Judges' Panel",
    tagline="Jev scores each quality once; you decide what matters",
    use_case="composite scoring", params=Params, prepare=prepare, play=play, lanes=(1, 4), needs_jev=True,
)
