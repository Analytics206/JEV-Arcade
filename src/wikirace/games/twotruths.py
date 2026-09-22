"""Two Truths and a Lie: a text model writes the claims; Jev checks them against the source.

TypeSafe's universal verification (citation checking): is a statement
supported by its source, contradicted by it, or not in it at all?

**The writer**, a text model named in the params, reads a Wikipedia
article's introduction and writes three one-sentence claims about it: two
true, one a plausible lie the introduction contradicts. That happens in
`prepare`, inside the request that starts the game, so a writer that cannot
keep to the format (after one retry) is a 502 with its reason, not a broken
run. The claims are shuffled (seeded) so the lie's place means nothing; which
one it is stays in `ctx.private` until the end.

**Jev** checks each claim: three Choice questions, supported / contradicted /
not_in_article, asked as three requests side by side, each over its own state
`{"article": intro, "claim": that claim}`. One request with the three claims
in one state would make every question read two claims it is not about, and
irrelevant state costs a System One model accuracy (TypeSafe's jev-1.13
notes); three states keep each question to what it judges, for the price of
the introduction read three times (a few hundred tokens at $0.042 a million).
Jev's pick for the lie is the claim with the highest p(contradicted), ties to
the higher p(not_in_article).

**A text judge** is shown the introduction and the three claims and answers
`LIE: <1|2|3>` with a REASON; anything else is a foul.

**The visitor** picks too, on the page, before it shows any verdict.

Score per judge: 1 when it found the lie, else 0.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import time
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..race.wiki import article_url
from .base import Context, Game, GameInputError, GameSourceError
from .core import choice, fold, opaque, read_choice, read_field
from .players import Asked, BadPlayers, Player, PlayError, ask_jev, ask_text, resolve_players
from .runs import GameRun

VERDICTS = ("supported", "contradicted", "not_in_article")
#: What each verdict means, as Jev reads it (under opaque ids).
MEANING = {
    "supported": "supported: the text in `article` states what `claim` says, or directly implies it",
    "contradicted": "contradicted: the text in `article` states something that makes `claim` false",
    "not_in_article": "not_in_article: the text in `article` says nothing about what `claim` states",
}
INSTRUCTIONS: dict[str, Any] = {
    "question": "Is the statement in `claim` supported by the text in `article`, contradicted by it, or not in it?",
    "rules": [
        "Judge `claim` only against the text in `article`, not against anything known from elsewhere.",
        "Choose contradicted when `article` states a fact that makes `claim` false: another place, name, "
        "kind, cause, maker or amount than the one `claim` gives.",
        "Choose supported when `article` states or directly implies everything `claim` says.",
        "Choose not_in_article when `article` says nothing that settles `claim` either way.",
    ],
}
#: An introduction is cut here: enough to read in a minute and write from.
INTRO_CHARS = 1400
INTRO_MIN = 200
CLAIM_MIN, CLAIM_MAX = 12, 320

WRITER_SYSTEM = """\
You write rounds of the game Two Truths and a Lie from the introduction of a \
Wikipedia article. Write three claims about the article's subject: two true \
and one a lie.

Rules:
- Each claim is one sentence in your own words, under 30 words.
- The two true claims are each stated in the introduction, or directly implied by it.
- The lie is plausible and CONTRADICTED by the introduction: take a fact the \
introduction states and change it (a place, a name, a kind of thing, a cause, \
who did it, which came first). A reader of the introduction must be able to \
see that it is false; a claim the introduction simply does not mention is not a lie.
- Prefer changing a place, a name, a kind or a relation over changing a bare number or date.
- Write the three in the same style and length, so nothing but the facts gives the lie away.
- The lie may be any of the three.

Reply with exactly these five lines and nothing else:
CLAIM 1: <one sentence>
CLAIM 2: <one sentence>
CLAIM 3: <one sentence>
LIE: <1, 2 or 3>
WHY: <one short sentence: what the introduction actually says>"""

JUDGE_SYSTEM = """\
You are a judge in the game Two Truths and a Lie. A writer read the \
introduction of a Wikipedia article and wrote three claims about it: two are \
true to the introduction and one is a lie that the introduction contradicts. \
Find the lie.

Rules:
- Judge by the introduction you are given, not by what you know from elsewhere.
- Exactly one claim is the lie: name its number.
- An answer that is not 1, 2 or 3 is a foul.

Reply with exactly two lines and nothing else:
REASON: <one short sentence: what the introduction says that the lie gets wrong>
LIE: <1, 2 or 3>"""


class ClaimsError(ValueError):
    """The writer's reply is not three claims and a lie."""


@cache
def articles() -> tuple[str, ...]:
    with open(Path(__file__).parent / "data" / "twotruths.json", encoding="utf-8") as f:
        return tuple(json.load(f)["articles"])


#: A pronunciation in square brackets, as an extract keeps it: `[aːˈʃoːloːtɬ]`.
_IPA = re.compile(r"\s*\[[^\]\n]*[ˈˌːɐɑɒæɔəɛɜɪʊʌʃʒθðŋɡɹɾʔɬ][^\]\n]*\]")


def clean_intro(text: str, limit: int = INTRO_CHARS) -> str:
    """An extract's introduction, readable: pronunciations and the husks a
    stripped one leaves (`( ; from …`) removed, paragraphs kept, cut on a
    sentence end."""
    t = _IPA.sub("", text)
    t = re.sub(r"[ \t]+([;,])", r"\1", t)
    t = re.sub(r"\(\s*[;,]\s*", "(", t)
    t = re.sub(r"[;,]\s*\)", ")", t)
    t = re.sub(r"\(\s*\)", "", t)
    paras = [" ".join(p.split()) for p in t.split("\n")]
    t = "\n\n".join(p for p in paras if p)
    if len(t) <= limit:
        return t
    cut = t[:limit]
    end = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind("? "), cut.rfind("! "))
    return cut[: end + 1].strip() if end >= INTRO_MIN else cut.rstrip() + "…"


def read_lie(value: str | None) -> int | None:
    """The claim a LIE field names, 0-based: `2`, `Claim 2`, `#2`; else None."""
    if not value:
        return None
    m = re.fullmatch(r"(?:claim\s*)?(?:#|no\.?\s*)?([123])", fold(value))
    return int(m.group(1)) - 1 if m else None


def parse_claims(text: str) -> tuple[list[str], int, str | None]:
    """(claims, lie index 0-based, why) from the writer's reply. Raises ClaimsError."""
    claims: list[str] = []
    for n in (1, 2, 3):
        c = read_field(text, f"CLAIM {n}")
        if not c:
            raise ClaimsError(f"there is no CLAIM {n} line")
        c = c.strip().strip('"“”').strip()
        if not CLAIM_MIN <= len(c) <= CLAIM_MAX:
            raise ClaimsError(f"claim {n} is {len(c)} characters: a claim is one sentence")
        claims.append(c)
    if len({fold(c) for c in claims}) < 3:
        raise ClaimsError("two of the claims are the same")
    raw = read_field(text, "LIE")
    lie = read_lie(raw)
    if lie is None:
        raise ClaimsError(f"LIE must be 1, 2 or 3, not {raw!r}" if raw else "there is no LIE line")
    why = read_field(text, "WHY")
    return claims, lie, (why[:300] if why else None)


def article_block(title: str, intro: str) -> str:
    return f'ARTICLE: {title}\nINTRODUCTION:\n"""\n{intro}\n"""'


def judge_prompt(title: str, intro: str, claims: list[str]) -> str:
    listed = "\n".join(f"CLAIM {n}: {c}" for n, c in enumerate(claims, 1))
    return f"{article_block(title, intro)}\n\n{listed}"


def jev_lie(verdicts: list[dict[str, float]]) -> int:
    """Jev's pick for the lie: the likeliest contradicted, ties to not_in_article."""
    return max(range(len(verdicts)), key=lambda k: (verdicts[k]["contradicted"], verdicts[k]["not_in_article"], -k))


@dataclass
class _Seat:
    key: str
    thinking: str | None = None


class Params(BaseModel):
    writer: str | None = Field(default=None, max_length=300, description="the text model that writes the claims (provider:model)")
    title: str | None = Field(default=None, max_length=250, description="the Wikipedia article (else a random one)")
    seed: int | None = Field(default=None, description="the same seed draws the same article and order")


async def fetch_intro(ctx: Context, title: str) -> dict[str, str]:
    data = await ctx.wiki.query({
        "action": "query", "prop": "extracts|pageprops|info", "ppprop": "disambiguation", "inprop": "url",
        "exintro": 1, "explaintext": 1, "redirects": 1, "titles": title,
    })
    pages = (data.get("query") or {}).get("pages") or []
    page = pages[0] if pages else {}
    if not page or page.get("missing") or page.get("invalid"):
        raise GameInputError(f"No Wikipedia article is titled “{title}”")
    name = str(page.get("title") or title)
    if "disambiguation" in (page.get("pageprops") or {}):
        raise GameInputError(f"“{name}” is a disambiguation page: name one article")
    intro = clean_intro(str(page.get("extract") or ""))
    if len(intro) < INTRO_MIN:
        raise GameInputError(f"“{name}” has too short an introduction to make three claims from")
    return {"title": name, "intro": intro, "url": str(page.get("fullurl") or article_url(name))}


async def write_claims(writer: Player, article: dict[str, str]) -> tuple[list[str], int, str | None, dict[str, Any]]:
    """The writer's claims, lie and why, and what writing them cost: one
    retry when the first reply is malformed. Raises GameSourceError."""
    prompt = article_block(article["title"], article["intro"])
    spent: dict[str, Any] = {
        "key": writer.key, "label": writer.label, "provider": writer.provider, "model_id": writer.model_id,
        "tokens_in": 0, "tokens_out": 0, "cost": 0.0, "cost_estimated": False, "cost_unknown": False,
        "ms": 0, "attempts": 0,
    }
    problem = ""
    for attempt in range(2):
        ask = prompt if attempt == 0 else (
            f"{prompt}\n\nYour last reply could not be read: {problem}. "
            "Reply again with exactly the five lines asked for."
        )
        try:
            said = await ask_text(writer, WRITER_SYSTEM, ask)
        except PlayError as exc:
            raise GameSourceError(f"the writer could not write the claims: {exc}") from exc
        spent["attempts"] += 1
        spent["tokens_in"] += said.tokens_in
        spent["tokens_out"] += said.tokens_out
        spent["ms"] += said.latency_ms
        if said.cost is None:
            spent["cost_unknown"] = True
        else:
            spent["cost"] = round(spent["cost"] + said.cost, 8)
            spent["cost_estimated"] = spent["cost_estimated"] or said.cost_estimated
        try:
            claims, lie, why = parse_claims(said.text)
        except ClaimsError as exc:
            problem = str(exc)
            continue
        return claims, lie, why, spent
    raise GameSourceError(f"{writer.label} did not write three claims and a lie as asked: {problem}")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    key = (p.writer or "").strip() or next((pl.key for pl in ctx.text), "")
    if not key:
        raise GameInputError("pick a text model to write the claims")
    cfg = ctx.settings.provider(key.partition(":")[0])
    if cfg is not None and cfg.kind != "text":
        raise GameInputError("the writer must be a text model: Jev writes no text")
    try:
        (writer,) = resolve_players([_Seat(key)], ctx.settings, ctx.providers, kinds=frozenset({"text"}))
    except BadPlayers as exc:
        raise GameInputError(f"the writer: {exc}") from exc
    rng = random.Random(p.seed)
    title = (p.title or "").strip() or rng.choice(articles())
    article = await fetch_intro(ctx, title)
    claims, lie, why, spent = await write_claims(writer, article)
    order = [0, 1, 2]
    rng.shuffle(order)
    ctx.private["lie"] = order.index(lie)
    ctx.private["why"] = why
    return {
        "article": article,
        "claims": [{"n": n, "text": claims[j]} for n, j in enumerate(order, 1)],
        "writer": spent, "lie": None, "why": None, "verdicts": list(VERDICTS),
    }


async def play(run: GameRun, ctx: Context) -> None:
    article = run.state["article"]
    claims = [c["text"] for c in run.state["claims"]]
    for i in range(len(ctx.players)):
        run.lane(i, pick=None, found=None, score=None)

    async def jev(pl: Player) -> None:
        wait = run.waiting(pl.index)

        async def check(k: int) -> tuple[Asked, dict[str, str]]:
            ids = opaque(list(VERDICTS), f"twotruths|{run.id}|{k}", prefix="v")
            q = choice(INSTRUCTIONS, {oid: MEANING[v] for oid, v in ids.items()})
            state = {"article": article["intro"], "claim": claims[k]}
            return await ask_jev(pl, state, {"verdict": q}, on_wait=wait), ids

        started = time.monotonic()
        tasks = [asyncio.ensure_future(check(k)) for k in range(len(claims))]
        try:
            results = await asyncio.gather(*tasks)
        except BaseException:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        wall = int((time.monotonic() - started) * 1000)
        verdicts = []
        for asked, ids in results:
            picked = read_choice(asked.answers["verdict"], ids)
            probs = dict(picked.ranked)
            verdicts.append({**{v: round(probs[v], 4) for v in VERDICTS},
                             "top": picked.option, "confidence": round(picked.confidence, 4)})
        merged = Asked(
            answers={}, tokens_in=sum(a.tokens_in for a, _ in results), cost=sum(a.cost for a, _ in results),
            latency_ms=wall, model=results[0][0].model, requests=len(results),
        )
        run.account(pl.index, merged, verdicts=verdicts, pick=jev_lie(verdicts), ms=wall, requests=len(results))

    async def text(pl: Player) -> None:
        i = pl.index
        said = await ask_text(pl, JUDGE_SYSTEM, judge_prompt(article["title"], article["intro"], claims),
                              on_wait=run.waiting(i))
        claimed = read_field(said.text, "LIE")
        pick = read_lie(claimed)
        fields: dict[str, Any] = {
            "pick": pick, "said": (claimed or "")[:80], "reason": (read_field(said.text, "REASON") or "")[:300],
            "ms": said.latency_ms, "foul": pick is None,
        }
        if pick is None:
            fields["fouls"] = run.state["lanes"][i]["fouls"] + 1
        run.account(i, said, **fields)

    async def lane(pl: Player) -> None:
        await (jev if pl.is_jev else text)(pl)

    try:
        await run.each_lane(lane)
    finally:
        lie = ctx.private["lie"]
        run.patch(lie=lie, why=ctx.private.get("why"))
        for ln in run.state["lanes"]:
            if "ms" in ln:  # it answered, a foul included
                found = ln["pick"] == lie
                run.lane(ln["index"], found=found, score=int(found))


GAME = Game(
    id="twotruths", title="Two Truths and a Lie",
    tagline="A text model writes the claims; Jev checks them against the source",
    use_case="verification", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
