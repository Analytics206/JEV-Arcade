"""Switchboard's stand-in players: Jev is right and sure most of the time; the
text models are right more often than not, pass some calls to the operator,
and now and then name a line that does not exist."""
from __future__ import annotations

import random

from wikirace.games import switchboard as S

from . import choice, spread

GOLD = {c["text"]: c["intent"] for c in S.data()["calls"]}
NAMES = [n for n, _ in S.lines()]


def jev(qid, q, state):
    if not isinstance(state, dict) or "caller_said" not in state:
        return None
    gold = GOLD.get(state["caller_said"]) or S.OOS
    ids = q["criteria"]
    right = next((o for o, d in ids.items() if d.startswith(f"{gold} (") or d.startswith(f"{gold}:")), None)
    roll = random.random()
    if right is None or roll < 0.08:
        best = random.choice(list(ids))
    else:
        best = right
    p = random.uniform(0.35, 0.55) if roll > 0.85 else random.uniform(0.7, 0.97)
    return choice(spread(best, list(ids), p))


def text(model, system, prompt):
    if "telephone switchboard" not in system:
        return None
    said = prompt.split('"', 1)[1].rsplit('"', 1)[0] if '"' in prompt else ""
    gold = GOLD.get(said) or S.OOS
    roll = random.random()
    if roll < 0.72:
        line = gold
    elif roll < 0.84:
        line = random.choice(NAMES)
    elif roll < 0.93:
        line = S.OPERATOR
    else:
        line = random.choice(["customer_service", "billing_department", "tech_support"])
    return f"LINE: {line}"
