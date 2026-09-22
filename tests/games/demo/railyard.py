"""Rail Yard's stand-in players.

Jev routes sensibly: easy prompts to the small station, hard ones to the large
one, private ones flagged; now and then it is unsure (so the rule sends the
train one tier up) or picks the wrong size. The stations are the demo's text
models, tiered by name (demo/fast small, demo/steady medium, demo/slow large):
right more often on easy prompts, the large one better on hard ones, and now
and then a reply with no ANSWER line (a foul).
"""
from __future__ import annotations

import random

from wikirace.games import railyard as R

from . import choice, noul, score, spread

PROMPTS = {q["text"]: q for q in R.prompts()}
TIER_OF_MODEL = {"demo/fast": "small", "demo/steady": "medium", "demo/slow": "large"}
#: P(right) by tier, per difficulty 0 … 3.
RIGHT = {
    "local": (0.93, 0.78, 0.40, 0.15), "small": (0.95, 0.82, 0.48, 0.20),
    "medium": (0.97, 0.92, 0.72, 0.45), "large": (0.99, 0.97, 0.90, 0.78),
}
WANT = ("small", "small", "medium", "large")


def jev(qid, q, state):
    if not isinstance(state, dict) or "prompt_to_route" not in state:
        return None
    item = PROMPTS.get(state["prompt_to_route"])
    if item is None:
        return None
    d = item["difficulty"]
    if qid == "station":
        ids = q["criteria"]
        tier_of = {o: desc.split(" station", 1)[0] for o, desc in ids.items()}
        want = "local" if item["private"] else WANT[d]
        if random.random() < 0.15 and not item["private"]:
            want = random.choice(["small", "medium", "large"])
        options = [o for o, t in tier_of.items() if t == want] or [
            min(ids, key=lambda o: abs(R.RANK.get(tier_of[o], 2) - R.RANK[want]))]
        best = random.choice(options)
        p = random.uniform(0.38, 0.5) if random.random() < 0.15 else random.uniform(0.72, 0.95)
        return choice(spread(best, list(ids), p))
    if qid == "difficulty":
        return score(min(3.0, max(0.0, d + random.uniform(-0.6, 0.6))), 4, spread_=random.uniform(0.4, 0.8))
    truth = {"needs_code": item["code"], "needs_maths": item["maths"], "private_data": item["private"],
             "long_output": False}.get(qid)
    if truth is None:
        return None
    return noul(random.uniform(0.8, 0.98) if truth else random.uniform(0.01, 0.15))


def text(model, system, prompt):
    if "rail yard of language models" not in system or "PROMPT:\n" not in prompt:
        return None
    item = PROMPTS.get(prompt.split("PROMPT:\n", 1)[1])
    if item is None:
        return "ANSWER: I don't know"
    tier = TIER_OF_MODEL.get(model, "medium")
    roll = random.random()
    if roll < 0.04:
        return "Let me think about this one. It is probably what it looks like."
    gold = item["answers"][0]
    if roll < RIGHT[tier][item["difficulty"]]:
        return f"Working it through step by step.\nANSWER: {gold}"
    n = R.as_number(gold)
    wrong = f"{n * 2:g}" if n is not None and n else "I am not sure"
    return f"Here is my best attempt.\nANSWER: {wrong}"
