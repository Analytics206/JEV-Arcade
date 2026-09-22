"""The Big Sort's stand-in players: a topic guessed from keywords in the
article's opening. Jev is right that way most of the time, with a probability
to match; the text models are noisier and now and then name a topic that
does not exist."""
from __future__ import annotations

import random
import re

from wikirace.games import bigsort as B

from . import choice, spread

#: Words that give a topic away, by topic key, strongest first.
WORDS = {
    "people": r"born|died|footballer|politician|actor|actress|singer|writer|author|painter|musician|poet|"
              r"journalist|coach|cricketer|athlete|composer|director|businessman|bishop|player|he was|she was",
    "sport": r"season|league|cup|championship|tournament|club|olympic|match|racing|football team|qualif",
    "nature": r"species|genus|family [A-Z]|moth|beetle|plant|fungus|bird|fish|snail|spider|flowering|endemic",
    "places": r"village|town|city|municipality|river|lake|mountain|county|district|island|commune|located in|"
              r"railway station|road|highway|bridge|building|neighbourhood|suburb",
    "arts": r"album|film|song|novel|book|band|television|series|episode|video game|magazine|painting|opera|"
            r"musical|newspaper|comic|record label|poem",
    "history": r"battle|war|election|party|treaty|army|regiment|ship|navy|empire|dynasty|kingdom|parliament|"
               r"minister|revolution|legislat|constituency|military",
    "science": r"software|programming|protein|gene|chemical|compound|disease|theorem|mathemat|algorithm|"
               r"aircraft|engine|galaxy|asteroid|computer|technolog|scientific",
    "other": r"company|organi[sz]ation|school|university|college|brand|association|foundation|charity",
}
_RX = {k: re.compile(rf"\b(?:{v})", re.I) for k, v in WORDS.items()}
KEYS = [t["key"] for t in B.topics()]


def guess(title: str, intro: str) -> tuple[str, int]:
    """(topic key, how many clues it matched)."""
    text = f"{title}. {intro}"
    scored = sorted(((len(rx.findall(text)), -KEYS.index(k), k) for k, rx in _RX.items()), reverse=True)
    hits, _, key = scored[0]
    return (key, hits) if hits else ("other", 0)


def jev(qid, q, state):
    if qid != "topic" or not isinstance(state, dict) or set(state) != {"title", "intro"}:
        return None
    key, hits = guess(state["title"], state["intro"])
    name = next(t["name"] for t in B.topics() if t["key"] == key)
    ids = list(q["criteria"])
    best = next((o for o, c in q["criteria"].items() if str(c.get("what", "")).startswith(name + ":")), ids[0])
    if random.random() < 0.06:
        best = random.choice(ids)
    p = min(0.97, 0.5 + 0.12 * hits + random.uniform(0, 0.2)) if hits else random.uniform(0.3, 0.5)
    return choice(spread(best, ids, p))


def text(model, system, prompt):
    if "You sort Wikipedia articles into topics" not in system:
        return None
    title = prompt.split("TITLE: ", 1)[-1].split("\n", 1)[0]
    intro = prompt.split("INTRO: ", 1)[-1]
    key, _ = guess(title, intro)
    roll = random.random()
    if roll < 0.04:
        return "TOPIC: miscellaneous"
    if roll < 0.18:
        key = random.choice(KEYS)
    name = next(t["name"] for t in B.topics() if t["key"] == key)
    return f"TOPIC: {name}"
