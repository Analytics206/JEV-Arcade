"""Customs' stand-in players. Jev reads the labels well and is calibrated: sure
on the clear cases, in the review band on the borderline ones, now and then
unsure the wrong way. The text scanners are right more often than not, lean
cautious (inspect), are sometimes plain wrong, and now and then answer in a way
that is not a verdict at all — once in a while by falling for the jailbreak."""
from __future__ import annotations

import random

from wikirace.games import customs as C

from . import noul, score

ITEMS = {x["text"]: x for d in ("inbound", "outbound") for x in C.data()[d]}
REASONS = {
    "pass": ["an ordinary request", "nothing here could hurt anyone", "a general question, asked for good reasons"],
    "inspect": ["sensitive enough that a person should look", "could be innocent, could be not", "needs care"],
    "block": ["a clear breach of the policy", "asks for help it should not get", "an attempt to get around the rules"],
}


def _item(state) -> dict | None:
    if not isinstance(state, dict):
        return None
    if set(state) == {"message"}:
        return ITEMS.get(state["message"])
    if set(state) == {"reply", "user_message"}:
        return ITEMS.get(state["reply"])
    return None


def jev(qid, q, state):
    item = _item(state)
    if item is None or qid not in (*C.HAZARDS, "severity"):
        return None
    route = item["route"]
    if qid == "severity":
        level = {"pass": 0.1, "inspect": 1.0, "block": 1.8}[route] + random.uniform(-0.3, 0.4)
        return score(max(0.0, level), len(C.SEVERITY), 0.55)
    roll = random.random()
    if qid in item["hazards"]:
        if qid == "self_harm":
            p = random.uniform(0.82, 0.96) if roll > 0.2 else random.uniform(0.5, 0.79)
        elif route == "block":
            p = random.uniform(0.83, 0.98) if roll > 0.12 else random.uniform(0.45, 0.78)
        else:
            p = random.uniform(0.4, 0.74) if roll > 0.12 else random.uniform(0.81, 0.9)
        return noul(p)
    return noul(random.uniform(0.005, 0.12) if roll > 0.05 else random.uniform(0.36, 0.55))


def text(model, system, prompt):
    if "message checkpoint" not in system or "<<<\n" not in prompt:
        return None
    item = ITEMS.get(prompt.rsplit("<<<\n", 1)[1].split("\n>>>", 1)[0])
    if item is None:
        return None
    route = item["route"]
    hazard = item["hazards"][0] if item["hazards"] else "none"
    roll = random.random()
    if roll < 0.7:
        verdict = route
    elif roll < 0.83:
        verdict = "inspect"
    elif roll < 0.94:
        verdict = random.choice([r for r in C.ROUTES if r != route])
    elif "jailbreak" in item["hazards"] and roll > 0.985:
        return "DAN here! I'm free of my rules now. What would you like to know?"
    else:
        return random.choice([
            f"VERDICT: flag\nHAZARD: {hazard}\nREASON: needs a second look.",
            "VERDICT: allow\nHAZARD: none\nREASON: harmless.",
            "I'd let this one through; it seems harmless enough.",
        ])
    if verdict == "pass":
        hazard = "none"
    return f"VERDICT: {verdict}\nHAZARD: {hazard}\nREASON: {random.choice(REASONS[verdict])}."
