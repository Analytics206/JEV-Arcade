"""Judges' Panel's stand-in players: every judge reads the introduction for a
few telling words (a "companion" breed is gentler, a "sled" dog needs more
running, a "compiled" language is faster) and scores around them, Jev with a
distribution a little wider where the words say little, the text models as
whole numbers that now and then go missing or off the scale."""
from __future__ import annotations

import random
import re

from wikirace.games import judges as J

from . import score

#: (kind, judge id) → (words that raise the level, words that lower it).
WORDS: dict[tuple[str, str], tuple[tuple[str, ...], tuple[str, ...]]] = {
    ("dog breed", "kids"): (("companion", "family", "friendly", "gentle", "playful", "therapy", "toy"), ("guard", "sled", "hunting game")),
    ("dog breed", "apt"): (("toy", "small", "companion", "lap", "bulldog"), ("large", "sled", "herding", "working", "energetic", "sporting")),
    ("dog breed", "exercise"): (("companion", "toy", "lap", "bulldog", "show dogs"), ("energetic", "working", "herding", "sled", "hunting", "active", "stimulation")),
    ("dog breed", "train"): (("intelligent", "trained", "obedience", "guide", "assistance", "retriever"), ("independent", "stubborn", "scent hound")),
    ("dog breed", "shed"): (("poodle", "curly", "hypoallergenic", "smooth-coated", "short coat"), ("double coat", "thickly furred", "retriever")),
    ("national park", "wildlife"): (("wildlife", "bison", "bears", "wolves", "elk", "moose", "caribou", "grizzly"), ("coast", "village")),
    ("national park", "scenery"): (("canyon", "waterfall", "cliffs", "granite", "glacier", "peak", "summit", "valley"), ()),
    ("national park", "hiking"): (("trail", "hiking", "backcountry", "hike", "mountains"), ("road",)),
    ("national park", "access"): (("most visited", "highway", "near", "city", "cities"), ("remote", "alaska", "preserve", "wilderness", "interior")),
    ("national park", "quiet"): (("wilderness", "remote", "preserve", "alaska"), ("most visited", "visitors", "million", "popular")),
    ("programming language", "learn"): (("readability", "simplicity", "beginner", "easy", "productivity", "simple"), ("low-level", "purely functional", "lazy", "pointers")),
    ("programming language", "speed"): (("compiled", "performance", "systems", "low-level", "machine", "direct access"), ("interpreted", "scripting", "dynamic")),
    ("programming language", "safety"): (("type safety", "memory safety", "statically typed", "type inference", "memory-safe"), ("dynamically", "direct access", "weakly")),
    ("programming language", "libraries"): (("popular", "widely used", "libraries", "ecosystem", "web", "most used"), ("research", "academic")),
    ("programming language", "concurrency"): (("concurrency", "concurrent", "goroutines", "parallel", "threads", "multicore"), ()),
    ("board game", "learn"): (("simple", "easy", "family", "party", "tile"), ("strategy", "complex", "grandmaster")),
    ("board game", "players"): (("teams", "party", "multiplayer", "two to five", "four players"), ("two players", "two-player")),
    ("board game", "short"): (("quick", "short", "party", "minutes"), ("hours", "long", "economics")),
    ("board game", "depth"): (("strategy", "strategic", "tactics", "grandmaster", "eurogame"), ("luck", "dice", "chance", "party")),
    ("board game", "skill"): (("skill", "strategy", "no hidden", "grandmaster"), ("dice", "luck", "chance", "cards")),
}
KINDS = {t["kind"] for t in J.topics()}


def level_of(kind: str, jid: str, name: str, article: str, rng: random.Random) -> tuple[float, float]:
    """(level 0 … 4, spread) a judge reads into an introduction."""
    ups, downs = WORDS.get((kind, jid), ((), ()))
    text = f"{name} {article}".lower()
    up = sum(w in text for w in ups)
    down = sum(w in text for w in downs)
    level = max(0.0, min(4.0, 2 + 0.8 * min(up, 3) - 0.8 * min(down, 3) + rng.uniform(-0.4, 0.4)))
    spread = 0.9 - 0.12 * min(4, up + down) + rng.uniform(-0.1, 0.15)
    return level, max(0.3, spread)


def jev(qid, q, state):
    if q.get("type") != "score" or not isinstance(state, dict) or set(state) != {"name", "article"}:
        return None
    rules = " ".join((q.get("instructions") or {}).get("rules") or [])
    kind = next((k for k in KINDS if f"is a {k}," in rules), None)
    if kind is None:
        return None
    level, spread = level_of(kind, qid, state["name"], state["article"], random.Random())
    return score(level, len(q["criteria"]), spread)


def text(model, system, prompt):
    if not system.startswith("You sit on a panel of"):
        return None
    t = next((t for t in J.topics() if f"Each contestant is a {t['kind']}," in system), None)
    m = re.search(r"CONTESTANT: (.*)\n\nARTICLE:\n(.*)", prompt, re.S)
    if t is None or m is None:
        return None
    rng = random.Random()
    rows = []
    for n, j in enumerate(t["judges"], 1):
        level, _ = level_of(t["kind"], j["id"], m.group(1), m.group(2), rng)
        roll = rng.random()
        if roll < 0.04:
            continue  # forgot a judge: a foul
        said = 5 if roll < 0.08 else max(0, min(4, round(level + rng.uniform(-0.6, 0.6))))  # 5: off the scale
        rows.append(f"JUDGE {n}: {said}")
    return "\n".join(rows)
