"""Switchboard: every caller patched to the right line, or to a human when unsure.

TypeSafe's intent routing, gated on confidence. Callers arrive on a clock, one
every `interval_ms`. Each lane is one operator working its own queue a call at
a time, and a caller who has waited longer than `patience_ms` hangs up: a slow
operator drops callers however right it would have been.

**Jev** answers one choice over 151 lines, the 150 intents of the CLINC150
taxonomy plus `out_of_scope`, in one question. Code routes on its confidence,
TypeSafe's second axis: under `threshold` the call goes to the human operator,
whatever the top pick; otherwise the caller is connected to the line Jev chose
(or told, politely, that the assistant cannot help, for out of scope).

**A text model** is shown the same 151 lines and answers `LINE: <name>`, or
`LINE: operator` when it is unsure. A name that is not a line is a foul.

Per call: right +2, to the operator 0, wrong −1, a foul −1, dropped −1.
"""
from __future__ import annotations

import asyncio
import json
import random
import time
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .core import choice, fold, match_option, opaque, read_choice, read_field
from .players import Player, ask_jev, ask_text
from .runs import GameRun

OOS = "out_of_scope"
OPERATOR = "operator"
POINTS = {"right": 2, "operator": 0, "wrong": -1, "foul": -1, "dropped": -1}
#: How often each lane's queue length is sampled, for the page's sparkline.
_SAMPLE_S = 0.5

INSTRUCTIONS: dict[str, Any] = {
    "question": "Which line should the caller in `caller_said` be connected to?",
    "rules": [
        "Choose the line whose request is what the caller asks for, in their own words.",
        f"Choose {OOS} when no line covers the request.",
    ],
}


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "switchboard.json", encoding="utf-8") as f:
        return json.load(f)


@cache
def lines() -> tuple[tuple[str, str], ...]:
    """Every line as (name, domain), in the switchboard's order, out of scope last."""
    out = [(intent, domain) for domain, intents in data()["domains"].items() for intent in intents]
    return (*out, (OOS, "none"))


def describe(intent: str, domain: str) -> str:
    """What a line is for, as Jev reads it."""
    if intent == OOS:
        return f"{OOS}: none of the other lines; a request this assistant does not handle"
    gloss = data()["glosses"].get(intent) or intent.replace("_", " ")
    return f"{intent} ({domain}): {gloss}"


def text_system() -> str:
    listing = "\n".join(f"{name} ({domain})" for name, domain in lines()[:-1])
    return (
        "You are the operator of a telephone switchboard for a digital assistant. Each caller says "
        "one thing, and you connect them to exactly one line.\n\n"
        f"The lines, one per row as `name (domain)`:\n{listing}\n"
        f"{OOS} (none of these: a request the assistant does not handle)\n\n"
        "Rules:\n"
        "- Answer with the line's name, copied exactly as written above.\n"
        f"- If you are not sure which line is right, answer `{OPERATOR}` and a human takes the call.\n"
        "- A name that is not one of the lines is a foul.\n\n"
        "Reply with exactly one line and nothing else:\n"
        f"LINE: <a line name, {OOS}, or {OPERATOR}>"
    )


def read_line(reply: str) -> str | None:
    """What a text model's reply names: its LINE field, else its last line."""
    claimed = read_field(reply, "LINE")
    if claimed is None:
        rows = [r.strip() for r in (reply or "").splitlines() if r.strip()]
        claimed = rows[-1] if rows else None
    return claimed


def judge(route: str, intent: str | None, gold: str | None) -> str:
    """How one call went: right | wrong | operator | foul | dropped."""
    if route in ("operator", "foul", "dropped"):
        return route
    if route == "oos":
        return "right" if gold is None else "wrong"
    return "right" if intent == gold else "wrong"


def jev_route(option: str, confidence: float, threshold: float) -> str:
    """Where code sends a call Jev answered: operator | oos | connect."""
    if confidence < threshold:
        return "operator"
    return "oos" if option == OOS else "connect"


class Params(BaseModel):
    calls: int = Field(default=30, ge=5, le=74, description="callers in the round")
    interval_ms: int = Field(default=300, ge=100, le=5000, description="a new caller every …")
    patience_ms: int = Field(default=8000, ge=1000, le=60_000, description="a caller hangs up after waiting …")
    threshold: float = Field(default=0.5, ge=0.0, le=0.95, description="below this confidence, Jev sends the call to a human")
    seed: int | None = Field(default=None, description="the same seed draws the same callers")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    rng = random.Random(p.seed)
    pool = list(data()["calls"])
    picked = rng.sample(pool, min(p.calls, len(pool)))
    ctx.private["calls"] = picked
    domains = data()["domains"]
    return {
        "calls": [], "total": len(picked), "domains": domains, "threshold": p.threshold,
        "points": POINTS, "gold": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    calls: list[dict[str, Any]] = ctx.private["calls"]
    queues: list[asyncio.Queue[tuple[int, float] | None]] = [asyncio.Queue() for _ in ctx.players]
    ids = opaque([name for name, _ in lines()], f"switchboard|{run.id}", prefix="l")
    domain_of = dict(lines())
    question = choice(INSTRUCTIONS, {oid: describe(name, domain_of[name]) for oid, name in ids.items()})
    system = text_system()
    names = [name for name, _ in lines()]
    t0 = time.monotonic()
    for i in range(len(ctx.players)):
        run.lane(i, queue=0, busy=None, answered=0, right=0, wrong=0, operator=0, dropped=0, score=0)

    async def arrivals() -> None:
        for k, call in enumerate(calls):
            delay = t0 + k * p.interval_ms / 1000 - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            run.push("calls", {"i": k, "text": call["text"], "at_ms": run.elapsed_ms()})
            now = time.monotonic()
            for i, q in enumerate(queues):
                q.put_nowait((k, now))
                run.lane(i, queue=q.qsize())
        for q in queues:
            q.put_nowait(None)

    async def sampler() -> None:
        while True:
            for i, q in enumerate(queues):
                run.lane_push(i, "backlog", q.qsize())
            await asyncio.sleep(_SAMPLE_S)

    def record(pl: Player, answer: dict[str, Any], call_cost: Any = None) -> None:
        i = pl.index
        ln = run.state["lanes"][i]
        verdict = answer["verdict"]
        tally = {
            "score": ln["score"] + POINTS[verdict],
            "answered": ln["answered"] + (verdict in ("right", "wrong")),
            "right": ln["right"] + (verdict == "right"),
            "wrong": ln["wrong"] + (verdict in ("wrong", "foul")),
            "operator": ln["operator"] + (verdict == "operator"),
            "dropped": ln["dropped"] + (verdict == "dropped"),
            "busy": None,
        }
        if verdict == "foul":
            tally["fouls"] = ln["fouls"] + 1
        run.lane_push(i, "answers", answer)
        if call_cost is not None:
            run.account(i, call_cost, **tally)
        else:
            run.lane(i, **tally)

    async def answer_jev(pl: Player, k: int, gold: str | None, base: dict[str, Any]) -> None:
        asked = await ask_jev(pl, {"caller_said": calls[k]["text"]}, {"line": question}, on_wait=run.waiting(pl.index))
        pick = read_choice(asked.answers["line"], ids)
        route = jev_route(pick.option, pick.confidence, p.threshold)
        intent = pick.option if route == "connect" else None
        record(pl, {
            **base, "route": route, "intent": intent, "guess": pick.option, "p": round(pick.p, 4),
            "confidence": round(pick.confidence, 4), "top": pick.top(5), "ms": asked.latency_ms,
            "verdict": judge(route, intent, gold),
        }, asked)

    async def answer_text(pl: Player, k: int, gold: str | None, base: dict[str, Any]) -> None:
        said = await ask_text(pl, system, f'CALLER: "{calls[k]["text"]}"', on_wait=run.waiting(pl.index))
        claimed = read_line(said.text)
        if claimed is not None and fold(claimed) == OPERATOR:
            route, intent = "operator", None
        else:
            opt = match_option(claimed, names)
            if opt is None:
                route, intent = "foul", None
            elif opt == OOS:
                route, intent = "oos", None
            else:
                route, intent = "connect", opt
        record(pl, {
            **base, "route": route, "intent": intent, "said": (claimed or "")[:120], "ms": said.latency_ms,
            "verdict": judge(route, intent, gold),
        }, said)

    async def lane(pl: Player) -> None:
        q = queues[pl.index]
        while True:
            item = await q.get()
            if item is None:
                break
            k, arrived = item
            waited = int((time.monotonic() - arrived) * 1000)
            run.lane(pl.index, queue=q.qsize())
            base = {"call": k, "waited_ms": waited}
            if waited > p.patience_ms:
                record(pl, {**base, "route": "dropped", "intent": None, "verdict": "dropped"})
                continue
            run.lane(pl.index, busy=k)
            gold = calls[k]["intent"]
            await (answer_jev if pl.is_jev else answer_text)(pl, k, gold, base)

    helpers = [asyncio.ensure_future(arrivals()), asyncio.ensure_future(sampler())]
    try:
        await run.each_lane(lane)
    finally:
        for t in helpers:
            t.cancel()
        await asyncio.gather(*helpers, return_exceptions=True)
        run.patch(gold=[c["intent"] for c in calls])


GAME = Game(
    id="switchboard", title="Switchboard",
    tagline="Every caller patched to the right line, or to a human when unsure",
    use_case="intent routing", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
