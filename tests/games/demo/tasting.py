"""Blind Tasting's stand-in players: Jev's measurements follow the note's own
words (a "long, lingering" finish scores high, "short" low; "cellar" says it
will age; "bitter" names a flaw), so the model in code has something real to
fit; the text models guess near the critic, a little high as often as not,
and now and then name a score off the scale."""
from __future__ import annotations

import random
import re

from wikirace.games import tasting as T

from . import noul, score

#: feature → (words that raise it, words that lower it), all lower case.
WORDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "fruit": (("concentrat", "dense", "ripe", "deep", "layer", "luscious", "plush", "generous", "dark"),
              ("dilute", "faint", "watery", "dull", "neutral", "thin", "light red")),
    "structure": (("tannin", "firm", "structure", "grip", "full-bodied", "powerful", "massive", "backbone", "frame"),
                  ("thin", "light-bodied", "shapeless", "flabby", "hollow", "very light", "soft,")),
    "acidity": (("crisp", "bright", "zesty", "vibrant", "electric", "fresh", "taut", "lively", "tense", "zippy", "mouthwatering"),
                ("flabby", "low acidity", "soft acidity", "faded", "flat")),
    "complexity": (("complex", "layer", "nuance", "unfold", "evolv", "profound", "remarkable", "endless"),
                   ("simple", "straightforward", "neutral", "one-note")),
    "finish": (("long", "endless", "linger", "echo", "on and on", "haunting", "minute"),
               ("short", "brief", "almost no finish")),
    "balance": (("balance", "seamless", "integrated", "perfect", "polished", "harmon", "in place"),
                ("hot", "burn", "bitter", "harsh", "coarse", "flabby", "blowsy", "astringent")),
}
OAK = ("oak", "vanilla", "toast", "cedar", "coconut", "dill", "sawdust", "mocha")
AGES = ("cellar", "decade", "age well", "age gracefully", "improve", "evolve", "develop", "blossom", "will last",
        "will keep", "will age", "reward", "thirty", "twenty", "forty", "hold for")
FLAWS = ("dilute", "hollow", "bitter", "hot", "burn", "flabby", "oxidised", "funky", "rotten", "reduced", "coarse",
         "astringent", "watery", "flat", "tired", "past its best", "overripe", "sawdust", "blowsy", "stalky")
NOW = ("drink now", "drink up", "drink this", "drink young", "drink within", "drink over", "for drinking",
       "drinking this", "drinks well now", "lovely now")
SCORE_OF = {n["note"]: n["score"] for n in T.notes()}


def count(text: str, words: tuple[str, ...]) -> int:
    return sum(text.count(w) for w in words)


def measure(qid: str, note: str, rng: random.Random) -> tuple[float, float] | float:
    """A Score's (level, spread), or a yes/no's probability, read from the words."""
    t = note.lower()
    if qid == "oak":
        n = count(t, OAK)
        level = min(4.0, 1.1 * n + (1.0 if n and re.search(r"heavy|dominat|prominent", t) else 0.0))
        return max(0.0, level + rng.uniform(-0.2, 0.3)), 0.35 + rng.uniform(0, 0.3)
    if qid in WORDS:
        up, down = (count(t, w) for w in WORDS[qid])
        level = max(0.0, min(4.0, 1.6 + 0.8 * min(up, 3) - 0.9 * min(down, 3) + rng.uniform(-0.35, 0.35)))
        return level, max(0.3, 0.85 - 0.1 * min(4, up + down) + rng.uniform(-0.1, 0.15))
    words = {"ages": AGES, "flaw": FLAWS, "now": NOW}[qid]
    return min(0.97, 0.06 + 0.45 * count(t, words)) + rng.uniform(-0.04, 0.04)


def jev(qid, q, state):
    if not isinstance(state, dict) or set(state) != {"note"}:
        return None
    if "tasting note" not in " ".join((q.get("instructions") or {}).get("rules") or []):
        return None
    got = measure(qid, state["note"], random.Random())
    if q["type"] == "score":
        level, spread = got
        return score(level, len(q["criteria"]), spread)
    return noul(got)


def text(model, system, prompt):
    if not system.startswith("You are a contestant in a blind tasting"):
        return None
    m = re.search(r'TASTING NOTE \(.*?\): "(.*)"', prompt, re.S)
    critic = SCORE_OF.get(m.group(1)) if m else None
    if critic is None:
        return None
    roll = random.random()
    if roll < 0.06:
        return "REASON: a remarkable wine.\nSCORE: 104"  # off the scale: a foul
    guess = max(80, min(100, critic + random.choice([-3, -2, -1, -1, 0, 1, 1, 2])))
    return f"REASON: {'firm, long and built to age' if critic >= 90 else 'pleasant but simple'}.\nSCORE: {guess}"
