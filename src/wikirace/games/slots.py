"""Slot Machine: one borderline post, pulled again and again — does the verdict hold still?

TypeSafe's self-consistency cookbooks, as a one-armed bandit. One forum post
that sits between two moderation verdicts is judged `pulls` times by every
lane, each time as a separate request with exactly the same words: a lever
pull spins three reels, three requests side by side, and each reel stops on
its own verdict. A judge worth automating gives the same answer every time.

**Jev** answers one choice, allow / warn / remove (under opaque ids, the same
question on every pull). Code reads its top probability: under `threshold`
the pull is UNCERTAIN, and a human decides; otherwise it is Jev's top label.

**A text model** is given the same policy and answers `VERDICT: allow | warn |
remove`; anything else is a foul.

Per lane: the tally of outcomes; raw agreement, the share of pulls that gave
the most common label (for Jev its top label, uncertain or not); agreement,
the share that gave the most common outcome, uncertain counting as a decision
(the cookbook's measure, and the lane's score, in percent); how many pulls were
decided automatically; and, for Jev, the spread of each label's probability
across pulls. There is no right answer: why the post is borderline is revealed
at the end.
"""
from __future__ import annotations

import json
import random
from collections import Counter
from collections.abc import Iterable
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .core import choice, match_option, opaque, read_choice, read_field
from .players import Player, ask_jev, ask_text, together
from .runs import GameRun

LABELS = ("allow", "warn", "remove")
UNCERTAIN = "uncertain"
FOUL = "foul"
OUTCOMES = (*LABELS, UNCERTAIN, FOUL)
#: Reels on a machine: one lever pull sends this many requests at once.
REELS = 3
#: TypeSafe's published self-consistency result: agreement across repeats
#: without and with "uncertain" allowed, and the share still decided automatically.
COOKBOOK = {"agreement_raw": 0.908, "agreement_uncertain": 0.992, "decided": 0.742}

MEANINGS = {
    "allow": "allow: the post stays up as written. It may be blunt, rude about things, dark or exaggerated, "
             "but it threatens and targets no one",
    "warn": "warn: the post stays up and its author is warned. It is hostile or insulting toward a person or a "
            "group, or it could be read as a threat, though it most likely is not one",
    "remove": "remove: the post is taken down. It is a real threat of violence or damage, harassment of a "
              "person, hate against a group, or it urges someone to hurt themselves or others",
}

INSTRUCTIONS: dict[str, Any] = {
    "question": "What should a moderator do with the forum post in `post`?",
    "rules": [
        "Judge the post as written, in the place it was posted (`posted_in`): its author cannot be asked what "
        "they meant.",
        "Choose the option whose description fits the post.",
    ],
}

TEXT_SYSTEM = (
    "You are a content moderator for an online community. You read one post and decide what happens to it, "
    "by this policy:\n\n"
    f"allow    {MEANINGS['allow'].split(': ', 1)[1]}.\n"
    f"warn     {MEANINGS['warn'].split(': ', 1)[1]}.\n"
    f"remove   {MEANINGS['remove'].split(': ', 1)[1]}.\n\n"
    "Judge the post as written, in the place it was posted: you cannot ask its author what they meant.\n\n"
    "Reply with exactly two lines and nothing else:\n"
    "REASON: <one short sentence>\n"
    "VERDICT: <allow, warn or remove>"
)


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "slots.json", encoding="utf-8") as f:
        return json.load(f)


def text_prompt(post: dict[str, Any]) -> str:
    return f"POSTED IN: {post['where']}\nPOST:\n<<<\n{post['text']}\n>>>"


def jev_outcome(top: str, top_p: float, threshold: float) -> str:
    """What code makes of Jev's pick: its label, or uncertain under the threshold."""
    return top if top_p >= threshold else UNCERTAIN


def read_verdict(reply: str) -> tuple[str | None, str | None]:
    """(the label a text model's VERDICT names or None, what it said)."""
    said = read_field(reply, "VERDICT")
    return match_option(said, LABELS), said


def _most(counts: dict[str, int] | Counter[str], among: Iterable[str]) -> str | None:
    """The most common of *among* (ties to the earlier one), or None when none occurs."""
    order = list(among)
    best = max(order, key=lambda k: (counts.get(k, 0), -order.index(k)))
    return best if counts.get(best, 0) else None


def summarize(pulls: list[dict[str, Any]]) -> dict[str, Any]:
    """A lane's numbers after *pulls* (each with `outcome`, `top` and, for Jev, `p`)."""
    n = len(pulls)
    tally = {k: 0 for k in OUTCOMES}
    for x in pulls:
        tally[x["outcome"]] += 1
    tops = Counter(x["top"] for x in pulls if x.get("top") in LABELS)
    plurality = _most(tops, LABELS)
    consensus = _most(tally, (*LABELS, UNCERTAIN))
    raw = tops[plurality] / n if n and plurality else 0.0
    agreement = tally[consensus] / n if n and consensus else 0.0
    probs = [x["p"] for x in pulls if isinstance(x.get("p"), dict)]
    spread = {lb: [min(q[lb] for q in probs), max(q[lb] for q in probs)] for lb in LABELS} if probs else None
    return {
        "tally": tally, "plurality": plurality, "consensus": consensus,
        "raw_agreement": round(raw, 4), "agreement": round(agreement, 4),
        "decided": sum(tally[lb] for lb in LABELS), "spread": spread,
        "score": round(agreement * 100, 1) if n else None,
    }




class Params(BaseModel):
    post: int | None = Field(
        default=None, ge=0, le=len(data()["posts"]) - 1, description="which post, by number; none draws one",
        # The setup offers the posts by their words (never why they are borderline).
        json_schema_extra={"x-posts": [{"where": x["where"], "text": x["text"]} for x in data()["posts"]]},
    )
    pulls: int = Field(default=15, ge=3, le=30, description="times every lane judges the post")
    threshold: float = Field(default=0.60, ge=0.34, le=0.95,
                             description="under this top probability, Jev's pull is uncertain")
    seed: int | None = Field(default=None, description="the same seed draws the same post")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    posts = data()["posts"]
    index = p.post if p.post is not None else random.Random(p.seed).randrange(len(posts))
    post = posts[index]
    ctx.private["post"] = post
    return {
        "post": {"index": index, "id": post["id"], "text": post["text"], "where": post["where"]},
        "posts": len(posts), "total": p.pulls, "threshold": p.threshold, "labels": list(LABELS),
        "reels": REELS, "cookbook": COOKBOOK, "borderline": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    post: dict[str, Any] = ctx.private["post"]
    ids = opaque(LABELS, f"slots|{run.id}", prefix="v")
    question = {"verdict": choice(INSTRUCTIONS, {oid: MEANINGS[label] for oid, label in ids.items()})}
    state = {"post": post["text"], "posted_in": post["where"]}
    prompt = text_prompt(post)
    spinning: list[list[int | None]] = [[None] * REELS for _ in ctx.players]
    for i in range(len(ctx.players)):
        run.lane(i, spinning=[None] * REELS, lever=0, **summarize([]))

    async def pull(pl: Player, n: int) -> None:
        i = pl.index
        call: Any
        if pl.is_jev:
            call = await ask_jev(pl, state, question, on_wait=run.waiting(i))
            pick = read_choice(call.answers["verdict"], ids)
            item = {
                "n": n, "reel": n % REELS, "top": pick.option, "top_p": round(pick.p, 4),
                "confidence": round(pick.confidence, 4), "p": {lb: round(q, 4) for lb, q in pick.ranked},
                "outcome": jev_outcome(pick.option, pick.p, p.threshold), "ms": call.latency_ms,
            }
        else:
            call = await ask_text(pl, TEXT_SYSTEM, prompt, on_wait=run.waiting(i))
            label, said = read_verdict(call.text)
            item = {
                "n": n, "reel": n % REELS, "top": label, "outcome": label or FOUL,
                "said": (said or "")[:60], "reason": (read_field(call.text, "REASON") or "")[:200],
                "ms": call.latency_ms,
            }
        spinning[i][n % REELS] = None
        run.lane_push(i, "pulls", item)
        ln = run.state["lanes"][i]
        also = {**summarize(ln["pulls"]), "spinning": list(spinning[i])}
        if item["outcome"] == FOUL:
            also["fouls"] = ln["fouls"] + 1
        run.account(i, call, **also)

    async def lane(pl: Player) -> None:
        i = pl.index
        for start in range(0, p.pulls, REELS):
            batch = range(start, min(start + REELS, p.pulls))
            for n in batch:
                spinning[i][n % REELS] = n
            run.lane(i, spinning=list(spinning[i]), lever=run.state["lanes"][i]["lever"] + 1)
            try:
                await together(pull(pl, n) for n in batch)
            finally:
                if any(s is not None for s in spinning[i]):
                    spinning[i] = [None] * REELS
                    run.lane(i, spinning=list(spinning[i]))

    try:
        await run.each_lane(lane)
    finally:
        run.patch(borderline={"between": list(post["between"]), "note": post["note"]})


GAME = Game(
    id="slots", title="Slot Machine",
    tagline="One borderline post, fifteen pulls: does the verdict hold still?",
    use_case="self-consistency", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
