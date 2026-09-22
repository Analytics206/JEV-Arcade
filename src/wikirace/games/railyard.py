"""Rail Yard: Jev works the switches; the text models answer.

Model routing, as a harness engineer builds it. Prompts are trains; each text
model is a station with a tier (small, medium, large, or local: the only one
trusted with private data); Jev is the switch tower. Teammates, not rivals: the
game asks whether routing each prompt to the station that should answer it is
as good as always asking the big one, and how much cheaper.

**Every station answers every prompt** (a few at a time), so "always <station>"
is a real baseline, not a guess. A station answers `ANSWER: <short answer>`;
code grades it against the prompt's accepted answers (normalised, a number as
a number). No ANSWER line is a foul, and wrong. A private prompt answered by a
station that is not local is a **leak**: wrong, however right the answer.

**Jev routes every prompt in one request** of six questions (TypeSafe's
fan-out): a choice over the stations (each described by its tier and model), a
difficulty score 0 to 3, and nouls for needs code, needs maths, private data
and long output. Code applies the rule, in this order:

    private_data > 0.5  → the local station (else the cheapest: a lost cause)
    confidence < threshold → one tier up from Jev's pick
    otherwise            → Jev's pick

The router is gated on its trains: train k+1 leaves when train k's station has
answered it, so the page can follow each one down its track. That costs no
time: the stations work through every prompt from the start regardless.

The router's accuracy is its routed station's verdict per train; its cost is
the calls it would have made (the routed station's, per train) plus Jev's own.
A station's cost is what the provider billed, else its list price, else its
tier's nominal price (`TIER_PRICE`, marked as such), so the chart always has
an x. Lane scores: the router's accuracy, and each station's, as percentages.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
from collections.abc import Mapping, Sequence
from functools import cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..race.rules import list_price
from .base import Context, Game, GameInputError
from .core import choice, fold, noul, opaque, read_choice, read_field, read_noul, read_score, score
from .players import Player, Said, ask_jev, ask_text
from .runs import GameRun

#: Tiers in order of capability, lowest first: "one tier up" walks this.
TIERS = ("local", "small", "medium", "large")
RANK = {t: i for i, t in enumerate(TIERS)}
#: USD per million tokens (input, output) assumed for a station whose call was
#: not billed and has no list price (OpenRouter's stand-ins, the demo's models).
TIER_PRICE: dict[str, tuple[float, float]] = {
    "local": (0.0, 0.0), "small": (0.15, 0.60), "medium": (1.0, 4.0), "large": (5.0, 25.0),
}
TIER_BLURB = {
    "local": "a small model on our own machine: free, and the only station allowed to see private personal data",
    "small": "a small, fast, cheap model: for facts to recall, lookups and one-step questions; weak at multi-step reasoning",
    "medium": "a mid-sized model at several times the small one's price: for routine arithmetic, conversions, "
              "word problems and short code",
    "large": "the largest model: slow and the most expensive, for hard multi-step reasoning, puzzles with a trap, "
             "and tricky code",
}
PRIVATE_AT = 0.5
STATION_CONCURRENCY = 3
FLAGS = ("needs_code", "needs_maths", "private_data", "long_output")
DIFFICULTY_LEVELS = [
    "0 trivial: one fact to recall",
    "1 easy: one routine step, such as a unit conversion or a single sum",
    "2 moderate: a few steps of reasoning, a word problem, or a short program to trace",
    "3 hard: a multi-step puzzle, a question with a trap, or tricky code",
]
ROUTE_INSTRUCTIONS: dict[str, Any] = {
    "question": "Which station should answer the prompt in `prompt_to_route`?",
    "rules": [
        "Choose the cheapest station that will still answer the prompt in `prompt_to_route` correctly.",
        "Save the large station for prompts that need several careful steps of reasoning, or tricky code.",
        "Choose the local station for a prompt that contains private personal data.",
    ],
}
DIFFICULTY_INSTRUCTIONS = "How hard is the prompt in `prompt_to_route` to answer correctly?"
FLAG_QUESTIONS = {
    "needs_code": noul(
        "Does the prompt in `prompt_to_route` include program code that must be read and traced to answer it?",
        yes="it shows code whose behaviour the answer depends on", no="it has no code to trace",
    ),
    "needs_maths": noul(
        "Does answering the prompt in `prompt_to_route` need arithmetic or another calculation?",
        yes="the answer has to be worked out with numbers", no="the answer is recalled or reasoned without sums",
    ),
    "private_data": noul(
        "Does the prompt in `prompt_to_route` contain private personal data about a named person, "
        "such as their pay, health, bank account or home address?",
        yes="it names a person together with their private details", no="it has no one's private details",
    ),
    "long_output": noul(
        "Does the prompt in `prompt_to_route` ask for a long answer, more than one short line?",
        yes="the answer takes several sentences, a list or a document", no="a word, a number or a short phrase answers it",
    ),
}
Verdict = Literal["right", "wrong", "foul", "leak", "none"]


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "railyard.json", encoding="utf-8") as f:
        return json.load(f)


def prompts() -> list[dict[str, Any]]:
    return list(data()["prompts"])


# ── Grading ───────────────────────────────────────────────────────────────────

_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
_THOUSANDS = re.compile(r"(?<=\d),(?=\d{3}\b)")
_ARTICLE = re.compile(r"^(?:the|a|an)\s+")


def as_number(s: str) -> float | None:
    """*s* when it is a number and nothing else ($, % and thousands commas aside)."""
    t = _THOUSANDS.sub("", fold(s)).replace("$", "").replace("%", "").strip()
    return float(t) if re.fullmatch(r"-?\d+(?:\.\d+)?", t) else None


def first_number(s: str) -> float | None:
    """The number a claimed answer gives: the first one after its last `=`."""
    t = _THOUSANDS.sub("", fold(s)).rsplit("=", 1)[-1]
    m = _NUMBER.search(t)
    return float(m.group()) if m else None


def answer_key(s: str) -> str:
    """A text answer's comparison key: folded, a leading article dropped, no spaces or quotes."""
    t = _ARTICLE.sub("", fold(s))
    return re.sub(r"[\s'\"]", "", t)


def grade(claimed: str | None, accepted: Sequence[str]) -> bool:
    """Whether *claimed* is one of the *accepted* answers: a number compared as
    a number, anything else as text after normalising."""
    if not claimed:
        return False
    key = answer_key(claimed)
    got = first_number(claimed)
    for a in accepted:
        n = as_number(a)
        if n is not None:
            if got is not None and abs(got - n) <= 1e-6 * max(1.0, abs(n)):
                return True
        elif key and key == answer_key(a):
            return True
    return False


# ── Tiers and routing ─────────────────────────────────────────────────────────


def default_tiers(models: Sequence[tuple[str, str]]) -> list[str]:
    """Each station's tier when the setup names none: Ollama is local; the rest
    go small to large by list price (cheapest small, dearest large), or in lane
    order when any price is unknown. *models* is (provider, model_id) per station."""
    out = ["local" if prov == "ollama" else "" for prov, _ in models]
    cloud = [s for s, (prov, _) in enumerate(models) if prov != "ollama"]
    prices = {s: list_price(*models[s]) for s in cloud}
    if all(prices[s] is not None for s in cloud):
        cloud.sort(key=lambda s: (sum(prices[s] or (0.0, 0.0)), s))
    for j, s in enumerate(cloud):
        # One cloud station is the large one; with more, the first is small, the last large.
        out[s] = "large" if j == len(cloud) - 1 else "small" if j == 0 else "medium"
    return out


def cheapest(tiers: Sequence[str]) -> int:
    return min(range(len(tiers)), key=lambda s: (RANK[tiers[s]], s))


def one_up(pick: int, tiers: Sequence[str]) -> int:
    """The station one tier above *pick* (the lowest tier that is higher), or *pick* at the top."""
    higher = [s for s in range(len(tiers)) if RANK[tiers[s]] > RANK[tiers[pick]]]
    return min(higher, key=lambda s: (RANK[tiers[s]], s)) if higher else pick


def route(pick: int, confidence: float, private: float, tiers: Sequence[str], threshold: float) -> tuple[int, str]:
    """(station, rule) for one train. Rules: `private` (to the local station),
    `private_no_local` (no local station: the cheapest), `unsure_up` (one tier
    up), `unsure_top` (unsure, but already at the top), `pick` (Jev's pick)."""
    if private > PRIVATE_AT:
        local = [s for s, t in enumerate(tiers) if t == "local"]
        if local:
            return (pick if pick in local else local[0]), "private"
        return cheapest(tiers), "private_no_local"
    if confidence < threshold:
        up = one_up(pick, tiers)
        return up, ("unsure_up" if up != pick else "unsure_top")
    return pick, "pick"


def describe_station(tier: str, model_id: str) -> str:
    return f"{tier} station ({model_id}): {TIER_BLURB[tier]}"


def jev_questions(ids: Mapping[str, str], stations: Sequence[str]) -> dict[str, Any]:
    """The six questions of one routing request. *ids* is {opaque id: station
    number}; *stations* each station's description."""
    return {
        "station": choice(ROUTE_INSTRUCTIONS, {oid: stations[int(s)] for oid, s in ids.items()}),
        "difficulty": score(DIFFICULTY_INSTRUCTIONS, DIFFICULTY_LEVELS),
        **FLAG_QUESTIONS,
    }


def station_system() -> str:
    return (
        "You are one station in a rail yard of language models: a router sends each prompt to a station, "
        "and your answer is checked against a known answer.\n\n"
        "Work the prompt out as carefully as it needs, then end your reply with exactly one line:\n"
        "ANSWER: <the short answer>\n\n"
        "On that line write only the answer: a number, a word or a short phrase. Write a number alone, "
        "without units or thousands separators. For what a program prints, write exactly what it prints. "
        "A reply without an ANSWER line is a foul."
    )


def answer_cost(pl: Player, said: Said, tier: str) -> tuple[float, str]:
    """(cost, basis) of one station call: `billed`, `list` (list price) or `tier` (TIER_PRICE)."""
    if said.cost is not None:
        return float(said.cost), ("list" if said.cost_estimated else "billed")
    price = list_price(pl.provider, pl.model_id)
    basis = "list"
    if price is None:
        price, basis = TIER_PRICE[tier], "tier"
    return (said.tokens_in * price[0] + said.tokens_out * price[1]) / 1_000_000, basis


def summarize(trains: Sequence[Mapping[str, Any]], stations: Sequence[Mapping[str, Any]],
              answers: Mapping[tuple[int, int], Mapping[str, Any]]) -> dict[str, Any]:
    """The router against "always <station>", over the trains the router delivered."""
    done = [t for t in trains if t.get("verdict")]
    ks = [t["k"] for t in done]

    def acc(right: int, n: int) -> float | None:
        return round(right / n, 4) if n else None

    right = sum(t["verdict"] == "right" for t in done)
    jev_cost = sum(t.get("jev_cost") or 0.0 for t in done)
    router = {
        "n": len(done), "right": right, "accuracy": acc(right, len(done)),
        "cost": round(sum(t.get("cost") or 0.0 for t in done) + jev_cost, 8), "jev_cost": round(jev_cost, 8),
    }
    always = []
    for s, st in enumerate(stations):
        got = [answers.get((s, k)) for k in ks]
        r = sum(1 for a in got if a and a["verdict"] == "right")
        always.append({
            "station": s, "lane": st["lane"], "tier": st["tier"], "n": len(ks), "right": r, "accuracy": acc(r, len(ks)),
            "cost": round(sum(a["cost"] for a in got if a), 8),
        })
    estimated = any(a.get("basis") == "tier" for a in answers.values())
    return {"router": router, "always": always, "tier_priced": estimated}


# ── The game ──────────────────────────────────────────────────────────────────

COUNT_MAX = len(data()["prompts"])


class Params(BaseModel):
    count: int = Field(default=20, ge=4, le=COUNT_MAX, description="prompts in the round")
    tiers: list[Literal["small", "medium", "large", "local"]] | None = Field(
        default=None, max_length=3, description="each station's tier, in the text lanes' order; default from list price",
    )
    threshold: float = Field(default=0.5, ge=0.0, le=0.95, description="under this confidence, one tier up")
    seed: int | None = Field(default=None, description="the same seed draws the same prompts")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    if len(ctx.jev) != 1:
        raise GameInputError("Rail Yard takes exactly one Jev: the switch tower")
    stations = ctx.text
    if not 2 <= len(stations) <= 3:
        raise GameInputError(f"Rail Yard takes 2 or 3 text models as stations, not {len(stations)}")
    tiers = list(p.tiers) if p.tiers is not None else default_tiers([(s.provider, s.model_id) for s in stations])
    if len(tiers) != len(stations):
        raise GameInputError(f"{len(tiers)} tiers for {len(stations)} stations: give one tier per text model")
    rng = random.Random(p.seed)
    picked = rng.sample(prompts(), min(p.count, COUNT_MAX))
    ctx.private["prompts"] = picked
    ctx.private["tiers"] = tiers
    return {
        "prompts": [{"k": k, "text": q["text"]} for k, q in enumerate(picked)],
        "total": len(picked),
        "stations": [
            {"station": s, "lane": pl.index, "tier": tiers[s], "model_id": pl.model_id, "label": pl.label,
             "provider": pl.provider}
            for s, pl in enumerate(stations)
        ],
        "router": ctx.jev[0].index, "threshold": p.threshold, "private_at": PRIVATE_AT,
        "trains": [], "summary": None, "gold": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    picked: list[dict[str, Any]] = ctx.private["prompts"]
    tiers: list[str] = ctx.private["tiers"]
    stations = ctx.text
    router = ctx.jev[0]
    n = len(picked)
    answers: dict[tuple[int, int], dict[str, Any]] = {}
    ready = {(s, k): asyncio.Event() for s in range(len(stations)) for k in range(n)}
    ids = opaque([str(s) for s in range(len(stations))], f"railyard|{run.id}", prefix="s")
    questions = jev_questions(ids, [describe_station(tiers[s], pl.model_id) for s, pl in enumerate(stations)])
    system = station_system()
    for s, pl in enumerate(stations):
        run.lane(pl.index, tier=tiers[s], answered=0, right=0, wrong=0, received=0, est_cost=0.0, score=None)
    run.lane(router.index, routed=0, delivered=0, right=0, wrong=0, router_cost=0.0, score=None)

    async def answer(pl: Player, s: int, k: int) -> None:
        q = picked[k]
        said = await ask_text(pl, system, f"PROMPT:\n{q['text']}", on_wait=run.waiting(pl.index))
        claimed = read_field(said.text, "ANSWER")
        correct = grade(claimed, q["answers"])
        verdict: Verdict = "foul" if claimed is None else ("right" if correct else "wrong")
        if q["private"] and tiers[s] != "local" and verdict != "foul":
            verdict = "leak"
        cost, basis = answer_cost(pl, said, tiers[s])
        if claimed is None:  # the foul, as it ended: its last line
            rows = [r.strip() for r in said.text.splitlines() if r.strip()]
            shown = rows[-1] if rows else ""
        else:
            shown = claimed
        item = {
            "k": k, "said": shown[:80], "verdict": verdict, "correct": correct, "cost": round(cost, 8),
            "basis": basis, "ms": said.latency_ms,
        }
        answers[(s, k)] = item
        ln = run.state["lanes"][pl.index]
        right = ln["right"] + (verdict == "right")
        answered = ln["answered"] + 1
        tally = {
            "answered": answered, "right": right, "wrong": ln["wrong"] + (verdict != "right"),
            "est_cost": round(ln["est_cost"] + cost, 8), "score": round(100 * right / answered),
        }
        if verdict == "foul":
            tally["fouls"] = ln["fouls"] + 1
        run.lane_push(pl.index, "answers", item)
        run.account(pl.index, said, **tally)
        ready[(s, k)].set()

    async def station(pl: Player) -> None:
        s = stations.index(pl)
        todo = list(range(n))

        async def worker() -> None:
            while todo:
                await answer(pl, s, todo.pop(0))

        tasks = [asyncio.ensure_future(worker()) for _ in range(min(STATION_CONCURRENCY, n))]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        finally:
            # A station that failed or was stopped must not hold the router's trains.
            for k in range(n):
                ready[(s, k)].set()

    async def switch_tower(pl: Player) -> None:
        i = pl.index
        for k in range(n):
            asked = await ask_jev(pl, {"prompt_to_route": picked[k]["text"]}, questions, on_wait=run.waiting(i))
            got = asked.answers
            pick = read_choice(got["station"], ids)
            difficulty = read_score(got["difficulty"], len(DIFFICULTY_LEVELS))
            flags = {f: round(read_noul(got[f]), 4) for f in FLAGS}
            chosen = int(pick.option)
            to, rule = route(chosen, pick.confidence, flags["private_data"], tiers, p.threshold)
            train: dict[str, Any] = {
                "k": k, "pick": chosen, "to": to, "rule": rule, "p": round(pick.p, 4),
                "confidence": round(pick.confidence, 4),
                "bars": [{"station": int(o), "p": round(pp, 4)} for o, pp in pick.ranked],
                "difficulty": difficulty.public(), "flags": flags, "jev_ms": asked.latency_ms,
                "jev_cost": round(asked.cost, 8), "questions": len(questions),
                "departed_ms": run.elapsed_ms(), "verdict": None, "said": None, "cost": None,
            }
            run.push("trains", train)
            run.account(i, asked, routed=run.state["lanes"][i]["routed"] + 1)
            to_lane = stations[to].index
            run.lane(to_lane, received=run.state["lanes"][to_lane]["received"] + 1)
            await ready[(to, k)].wait()
            got_answer = answers.get((to, k))
            verdict = got_answer["verdict"] if got_answer else "none"
            cost = got_answer["cost"] if got_answer else 0.0
            run.put("trains", k, {
                **train, "verdict": verdict, "said": got_answer["said"] if got_answer else None,
                "cost": cost, "delivered_ms": run.elapsed_ms(),
            })
            ln = run.state["lanes"][i]
            right = ln["right"] + (verdict == "right")
            delivered = ln["delivered"] + 1
            run.lane(
                i, delivered=delivered, right=right, wrong=ln["wrong"] + (verdict != "right"),
                router_cost=round(ln["router_cost"] + cost + asked.cost, 8), score=round(100 * right / delivered),
            )

    async def lane(pl: Player) -> None:
        await (switch_tower if pl.is_jev else station)(pl)

    try:
        await run.each_lane(lane)
    finally:
        station_rows = run.state["stations"]
        run.patch(
            summary=summarize(run.state["trains"], station_rows, answers),
            gold=[
                {"answers": q["answers"], "difficulty": q["difficulty"], "kind": q["kind"], "code": q["code"],
                 "maths": q["maths"], "private": q["private"]}
                for q in picked
            ],
        )


GAME = Game(
    id="railyard", title="Rail Yard", tagline="Jev works the switches; the text models answer",
    use_case="model routing", params=Params, prepare=prepare, play=play, lanes=(3, 4), needs_jev=True,
)
