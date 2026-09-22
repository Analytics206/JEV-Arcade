"""Ghost Maze's stand-in players (demo_server.py): they read the words a
player is given, as the real ones must.

Jev mostly takes the way that is safe and has the most pellets, sure of it
when one way is plainly better and spread when it is close. The text models
do the same after their (slow) delay, but now and then pick an open way at
random, steer into a wall, or forget the MOVE line, so the page's fouls show.

Self-contained on purpose (nothing imported from this package), so a test can
load it by its path without every other game's handler.
"""
from __future__ import annotations

import math
import random
import re
from typing import Any

DIRS = ("up", "left", "down", "right")
_PELLETS = re.compile(r"(\d+) pellets? in a straight line")
_GHOST = re.compile(r"toward (\w+), (dangerous|frightened)[,:] ([^;]*)")


def rate(meaning: str) -> float:
    """How good a way looks from its meaning: pellets up, danger down."""
    s = 0.0
    if m := _PELLETS.search(meaning):
        s += min(int(m.group(1)), 6) * 4
    if "a power pellet that way" in meaning:
        s += 6
    if "toward the nearest pellet" in meaning:
        s += 8
    if "toward the nearest power pellet" in meaning:
        s += 3
    for m in _GHOST.finditer(meaning):
        kind, how = m.group(2), m.group(3)
        if kind == "frightened":
            s += 25
        elif "right next to you" in how:
            s -= 200
        elif "very close" in how:
            s -= 120
        elif "close" in how and "some way" not in how:
            s -= 60
        elif "some way off" in how:
            s -= 6
    return s


def _softmax(scores: dict[str, float], temp: float) -> dict[str, float]:
    top = max(scores.values())
    ws = {k: math.exp((v - top) / temp) for k, v in scores.items()}
    total = sum(ws.values())
    return {k: w / total for k, w in ws.items()}


def jev(qid: str, q: dict[str, Any], state: Any) -> dict[str, Any] | None:
    if not isinstance(state, dict) or "you" not in state or "exits" not in state or q.get("type") != "choice":
        return None
    ids = q["criteria"]
    scores = {oid: rate(str(m)) + random.gauss(0, 3) for oid, m in ids.items()}
    probs = _softmax(scores, 6.0)
    ranked = sorted(probs.values(), reverse=True)
    conf = max(0.0, min(1.0, ranked[0] - (ranked[1] if len(ranked) > 1 else 0.0) + 0.1))
    return {"type": "choice", "choice": max(probs, key=probs.get), "probabilities": probs,
            "confidence": round(conf, 3)}


def text(model: str, system: str, prompt: str) -> str | None:
    if "maze game like Pac-Man" not in system:
        return None
    ways = dict(re.findall(r"^- (up|down|left|right): (.*)$", prompt, re.M))
    if not ways:
        return "MOVE: left"
    roll = random.random()
    walls = [d for d in DIRS if d not in ways]
    if roll < 0.07 and walls:
        return f"MOVE: {random.choice(walls)}"
    if roll < 0.1:
        return "Probably left, away from the ghost."
    if roll < 0.3:
        return f"MOVE: {random.choice(list(ways))}"
    best = max(ways, key=lambda d: rate(f"{d}: {ways[d]}"))
    return f"MOVE: {best}"
