"""Memory Match's stand-in players: Jev knows twins from cousins most of the
time, now and then scoring a cousin nearer "same" or a twin nearer "related";
the text models find most pairs, fall for a look-alike now and then, and once
in a while name a card that is not on the board."""
from __future__ import annotations

import random
import re

from wikirace.games import memory as M

from . import noul, score

PAIRS = {(p["a"], p["b"]): p for p in M.data()["pairs"]}
PARTNER = {p["a"]: p for p in M.data()["pairs"]}
BRANDS = sorted({p["a"].split()[0] for p in M.data()["pairs"]}, key=len, reverse=True)


def brand_of(text: str) -> str | None:
    low = text.lower()
    return next((b for b in BRANDS if b.lower() in low), None)


def jev(qid, q, state):
    if not isinstance(state, dict) or set(state) != {"shop_a", "shop_b"}:
        return None
    p = PAIRS.get((state["shop_a"], state["shop_b"]))
    level = p["gold"] if p else 0
    roll = random.random()
    if q["type"] == "score":
        mean = float(level)
        if level == 1 and roll < 0.25:
            mean = 1.6  # a cousin that reads like a twin
        elif level == 2 and roll < 0.1:
            mean = 1.3  # a twin sent to a curator
        elif p and level == 0 and roll < 0.2:
            mean = 0.7  # a look-alike, nearly a cousin
        return score(mean, len(q["criteria"]), 0.35)
    if p:
        yes = p["fields"][qid]
    elif qid == "brand":
        yes = brand_of(state["shop_a"]) == brand_of(state["shop_b"])
    else:
        yes = False
    return noul((0.88 if yes else 0.1) + random.uniform(-0.08, 0.08))


def text(model, system, prompt):
    if not system.startswith("You match products between two shops"):
        return None
    m = re.search(r'SHOP A LISTING: "(.*)"', prompt)
    if not m or "SHOP B LISTINGS:\n" not in prompt:
        return None
    bs = [ln.split(". ", 1)[-1] for ln in prompt.split("SHOP B LISTINGS:\n", 1)[1].splitlines() if ln.strip()]
    p = PARTNER.get(m.group(1))
    k = bs.index(p["b"]) + 1 if p and p["b"] in bs else None
    roll = random.random()
    if roll < 0.06:
        return f"MATCH: {len(bs) + random.randint(1, 5)}\nLEVEL: same"  # not on the board: a foul
    if k is None:
        return "MATCH: none"
    if p["gold"] == 0:
        return f"MATCH: {k}\nLEVEL: related" if roll < 0.3 else "MATCH: none"
    level = "same" if p["gold"] == 2 else "related"
    if roll < 0.2:
        level = "related" if level == "same" else "same"
    return f"MATCH: {k}\nLEVEL: {level}"
