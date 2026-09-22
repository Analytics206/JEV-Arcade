"""Memory Match: two shops, one product each: the same thing or not?

TypeSafe's entity alignment (its knowledge-graph cookbook). Two shops list
products in their own words. A round deals `pairs` pairs of listings as a
memory board: shop A's cards down one side, shop B's down the other, each side
shuffled on its own. Some cards have a twin across the board (the same
product), some a cousin (the same model in another colour, size, capacity or
pack: a curator's call), and some a look-alike that is another product.

**Jev** compares every A card with every B card, pairs² requests side by side,
each one Score question over three levels (0 different, 1 related, 2 same)
and three companion yes/no checks: the same brand? the same model? the same
variant? The level is the one nearest Jev's score, per the cookbook: no
threshold constant. Code then pairs the board, likeliest first, each card
once, never on a nearest level of 0.

**A text model** is shown one A card at a time with every B card numbered, and
answers `MATCH: <number or none>` and `LEVEL: same|related`. A number not on
the board, or a level that is neither, is a foul.

**You** play on the page: flip one card on each side, say what they are.

Per claim: a twin called the same +2, a cousin called related +1, a twin
called related +1 (the curator merges it), a cousin called the same 0 (merged
too eagerly), cards that are no pair −1. A twin or cousin never claimed is 0.
The answers stay private until the end of the round.
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import re
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .core import fold, noul, read_field, read_noul, read_score, score
from .players import Player, ask_jev, ask_text, together
from .runs import GameRun

#: Levels, lowest first: what the nearest one means.
LEVELS = ("different", "related", "same")
POINTS = {"same": 2, "related": 1, "cautious": 1, "eager": 0, "wrong": -1, "missed": 0}
#: Requests a lane has out at once.
JEV_PARALLEL = 16
TEXT_PARALLEL = 4

RULES = [
    "`shop_a` and `shop_b` are two shops' titles for a product each sells; each shop writes titles in its own style.",
    "Model numbers written with different spacing, dashes or letter case are the same model number.",
    "A detail that only one of the two titles gives does not make them differ.",
]
QUESTIONS: dict[str, dict[str, Any]] = {
    "match": score(
        {"question": "Do the titles in `shop_a` and `shop_b` describe the same product?", "rules": [
            *RULES,
            "The same product: the same brand, the same model and the same variant.",
            "The same model in another variant: the same brand and model, but another colour, size, capacity, "
            "pack or bundle.",
        ]},
        [
            "different products: another brand, another model, or another kind of item",
            "the same model in another variant: a different colour, size, capacity, pack or bundle",
            "the same product: the same brand, the same model and the same variant",
        ],
    ),
    "brand": noul({"question": "Do `shop_a` and `shop_b` name the same brand?", "rules": RULES[:1]}),
    "model": noul({"question": "Do `shop_a` and `shop_b` name the same model?", "rules": [
        *RULES[:2], "A different number in the same product line is a different model.",
    ]}),
    "variant": noul({
        "question": "Do `shop_a` and `shop_b` describe the same variant: the same colour, size, capacity, pack and bundle?",
        "rules": RULES,
    }),
}


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "memory.json", encoding="utf-8") as f:
        return json.load(f)


# ── Dealing ───────────────────────────────────────────────────────────────────


def deal(n: int, rng: random.Random) -> list[dict[str, Any]]:
    """*n* pairs, about half twins, a third cousins, the rest look-alikes."""
    by: dict[int, list[dict[str, Any]]] = {2: [], 1: [], 0: []}
    for p in data()["pairs"]:
        by[p["gold"]].append(p)
    same = int(n * 0.45 + 0.5)
    related = int(n * 0.3 + 0.5)
    return rng.sample(by[2], same) + rng.sample(by[1], related) + rng.sample(by[0], n - same - related)


def board(pairs: list[dict[str, Any]], rng: random.Random) -> tuple[list[str], list[str], list[dict[str, Any]]]:
    """Shop A's cards and shop B's cards, each side shuffled on its own, and
    where every dealt pair landed: `{a, b, level, fields, differs}`."""
    n = len(pairs)
    at_a, at_b = list(range(n)), list(range(n))
    rng.shuffle(at_a)
    rng.shuffle(at_b)
    side_a, side_b = [""] * n, [""] * n
    gold = []
    for k, p in enumerate(pairs):
        side_a[at_a[k]] = p["a"]
        side_b[at_b[k]] = p["b"]
        gold.append({"a": at_a[k], "b": at_b[k], "level": p["gold"], "fields": p["fields"], "differs": p.get("differs")})
    gold.sort(key=lambda g: g["a"])
    return side_a, side_b, gold


# ── Jev ───────────────────────────────────────────────────────────────────────


def nearest(value: float) -> int:
    """The level nearest a score: how the cookbook decides, with no threshold."""
    return max(0, min(len(LEVELS) - 1, int(math.floor(value + 0.5))))


def pair_up(grid: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Jev's matches from every comparison: likeliest first, each card once,
    and never a pair whose nearest level is 0."""
    used_a: set[int] = set()
    used_b: set[int] = set()
    out = []
    for g in sorted(grid, key=lambda g: (-g["score"], g["a"], g["b"])):
        if g["level"] < 1 or g["a"] in used_a or g["b"] in used_b:
            continue
        used_a.add(g["a"])
        used_b.add(g["b"])
        out.append({"a": g["a"], "b": g["b"], "level": g["level"], "score": g["score"]})
    return sorted(out, key=lambda c: c["a"])


# ── Text models ───────────────────────────────────────────────────────────────


def text_system(shops: dict[str, str]) -> str:
    return (
        f"You match products between two shops' catalogues. Shop A ({shops['a']}) and shop B ({shops['b']}) "
        "each title their products in their own style. You are shown one listing from shop A and every "
        "listing from shop B, numbered.\n\n"
        "Say which shop B listing, if any, is the shop A product:\n"
        "- same: the same brand, the same model and the same variant (colour, size, capacity, pack, bundle).\n"
        "- related: the same brand and model, but another variant. A curator will decide.\n"
        "- none: no shop B listing is this model. A similar product of the same brand is not a match.\n\n"
        "Rules:\n"
        "- Model numbers written with different spacing, dashes or letter case are the same model.\n"
        "- Answer with the number of one shop B listing, as shown, or none.\n"
        "- A number that is not on the list, or a level other than same or related, is a foul.\n\n"
        "Reply with exactly two lines and nothing else:\n"
        "MATCH: <a shop B number, or none>\n"
        "LEVEL: <same or related>"
    )


def text_prompt(a_text: str, side_b: list[str]) -> str:
    listing = "\n".join(f"{k}. {t}" for k, t in enumerate(side_b, 1))
    return f'SHOP A LISTING: "{a_text}"\n\nSHOP B LISTINGS:\n{listing}'


_NUMBER = re.compile(r"^(?:b|card|listing|number|no\.?|#)?\s*#?\s*(\d+)\b")


def read_match(reply: str | None, n: int) -> dict[str, Any]:
    """What a text model claimed for one A card: `{"kind": "claim", "b", "level"}`,
    `{"kind": "none"}`, or `{"kind": "foul", "why"}`."""
    said = read_field(reply, "MATCH")
    if said is None:
        return {"kind": "foul", "why": "no MATCH line"}
    key = fold(said)
    if key.startswith("none") or key in ("no match", "no", "nothing", "-", "n/a"):
        return {"kind": "none"}
    m = _NUMBER.match(key)
    if m is None:
        return {"kind": "foul", "why": f"“{said[:40]}” is not a card number"}
    b = int(m.group(1)) - 1
    if not 0 <= b < n:
        return {"kind": "foul", "why": f"there is no card {b + 1}"}
    level = fold(read_field(reply, "LEVEL") or "").split(" ")[0]
    if level not in ("same", "related"):
        return {"kind": "foul", "why": "LEVEL is neither same nor related"}
    return {"kind": "claim", "b": b, "level": 2 if level == "same" else 1}


# ── Scoring ───────────────────────────────────────────────────────────────────


def verdict(claimed: int, gold: int) -> str:
    """How a claim at level *claimed* (1 related, 2 same) fared against the gold level."""
    if gold <= 0:
        return "wrong"
    if gold == 2:
        return "same" if claimed == 2 else "cautious"
    return "related" if claimed == 1 else "eager"


def tally(claims: list[dict[str, Any]], gold: list[dict[str, Any]]) -> dict[str, Any]:
    """Every claim judged, the pairs missed, and the points."""
    level_of = {(g["a"], g["b"]): g["level"] for g in gold}
    judged = [{**c, "verdict": verdict(c["level"], level_of.get((c["a"], c["b"]), 0))} for c in claims]
    found = {(c["a"], c["b"]) for c in claims}
    missed = sum(1 for g in gold if g["level"] > 0 and (g["a"], g["b"]) not in found)
    return {
        "claims": judged, "missed": missed, "points": sum(POINTS[j["verdict"]] for j in judged),
        "right": sum(1 for j in judged if j["verdict"] in ("same", "related", "cautious")),
        "wrong": sum(1 for j in judged if j["verdict"] == "wrong"),
    }


# ── The game ──────────────────────────────────────────────────────────────────




class Params(BaseModel):
    pairs: int = Field(default=8, ge=4, le=10, description="pairs of listings dealt onto the board")
    seed: int | None = Field(default=None, description="the same seed deals the same board")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    rng = random.Random(p.seed)
    side_a, side_b, gold = board(deal(p.pairs, rng), rng)
    ctx.private["gold"] = gold
    return {
        "shops": data()["shops"], "cards_a": side_a, "cards_b": side_b,
        "levels": list(LEVELS), "points": POINTS, "gold": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    side_a: list[str] = run.state["cards_a"]
    side_b: list[str] = run.state["cards_b"]
    n = len(side_a)
    system = text_system(run.state["shops"])
    for i, pl in enumerate(ctx.players):
        run.lane(i, grid=[], said=[], claims=None, done_n=0, todo_n=n * n if pl.is_jev else n, score=None)

    def step(i: int, call: Any, key: str, item: dict[str, Any], foul: bool = False) -> None:
        ln = run.state["lanes"][i]
        run.lane_push(i, key, item)
        also: dict[str, Any] = {"done_n": ln["done_n"] + 1}
        if foul:
            also["fouls"] = ln["fouls"] + 1
        run.account(i, call, **also)

    async def compare(pl: Player, gate: asyncio.Semaphore, a: int, b: int) -> dict[str, Any]:
        async with gate:
            asked = await ask_jev(
                pl, {"shop_a": side_a[a], "shop_b": side_b[b]}, QUESTIONS, on_wait=run.waiting(pl.index),
            )
        s = read_score(asked.answers["match"], len(LEVELS))
        cell = {
            "a": a, "b": b, "score": round(s.score, 4), "level": nearest(s.score),
            "p": [round(x, 4) for x in s.probabilities],
            **{k: round(read_noul(asked.answers[k]), 4) for k in ("brand", "model", "variant")},
            "ms": asked.latency_ms,
        }
        step(pl.index, asked, "grid", cell)
        return cell

    async def match(pl: Player, gate: asyncio.Semaphore, a: int) -> dict[str, Any]:
        async with gate:
            said = await ask_text(pl, system, text_prompt(side_a[a], side_b), on_wait=run.waiting(pl.index))
        read = read_match(said.text, n)
        step(pl.index, said, "said", {"a": a, **read, "text": said.text.strip()[:200], "ms": said.latency_ms},
             foul=read["kind"] == "foul")
        return {"a": a, **read}

    async def lane(pl: Player) -> None:
        gate = asyncio.Semaphore(JEV_PARALLEL if pl.is_jev else TEXT_PARALLEL)
        if pl.is_jev:
            grid = await together(compare(pl, gate, a, b) for a in range(n) for b in range(n))
            claims = pair_up(grid)
        else:
            reads = await together(match(pl, gate, a) for a in range(n))
            claims = [{"a": r["a"], "b": r["b"], "level": r["level"]} for r in reads if r["kind"] == "claim"]
        run.lane(pl.index, claims=claims)

    try:
        await run.each_lane(lane)
    finally:
        # The answers, and every lane that made its claims scored against them.
        gold = ctx.private["gold"]
        for ln in run.state["lanes"]:
            if ln.get("claims") is not None:
                t = tally(ln["claims"], gold)
                run.lane(ln["index"], claims=t["claims"], missed=t["missed"], right=t["right"], wrong=t["wrong"],
                         score=t["points"])
        run.patch(gold=gold)


GAME = Game(
    id="memory", title="Memory Match",
    tagline="Two shops, one product each: the same thing or not?",
    use_case="entity alignment", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
