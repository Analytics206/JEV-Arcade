"""Slot Machine's stand-in players. Jev is steady: every post has its own lean,
the same on every pull give or take a hair, and on the most borderline posts
that lean sits near the 0.60 threshold, so a pull may land either side of it.
The text models wobble between the two verdicts a post sits between, now and
then pick the third, and once in a while answer with no verdict at all."""
from __future__ import annotations

import random

from wikirace.games import slots as S

from . import choice

POSTS = {p["text"]: p for p in S.data()["posts"]}
REASONS = {
    "allow": "a figure of speech that targets no one",
    "warn": "hostile toward a person, though not a real threat",
    "remove": "reads as a threat",
}


def _lean(post: dict) -> float:
    """Jev's top probability for this post, fixed per post."""
    return random.Random(f"slots-demo|{post['id']}").uniform(0.52, 0.82)


def jev(qid, q, state):
    if not isinstance(state, dict) or set(state) != {"post", "posted_in"} or q.get("type") != "choice":
        return None
    post = POSTS.get(state["post"])
    if post is None:
        return None
    first, second = post["between"]
    third = next(lb for lb in S.LABELS if lb not in (first, second))
    top = min(0.97, _lean(post) + random.uniform(-0.012, 0.012))
    by_label = {first: top, second: (1 - top) * 0.82, third: (1 - top) * 0.18}
    return choice({oid: by_label[meaning.split(":", 1)[0]] for oid, meaning in q["criteria"].items()})


def text(model, system, prompt):
    if "content moderator for an online community" not in system or "<<<\n" not in prompt:
        return None
    post = POSTS.get(prompt.rsplit("<<<\n", 1)[1].split("\n>>>", 1)[0])
    if post is None:
        return None
    first, second = post["between"]
    roll = random.random()
    if roll < 0.55:
        verdict = first
    elif roll < 0.87:
        verdict = second
    elif roll < 0.95:
        verdict = next(lb for lb in S.LABELS if lb not in (first, second))
    else:
        return random.choice([
            "REASON: it depends on who wrote it.\nVERDICT: warn or allow",
            "REASON: a moderator should look.\nVERDICT: escalate",
            "Honestly, this one could go either way.",
        ])
    return f"REASON: {REASONS[verdict]}.\nVERDICT: {verdict}"
