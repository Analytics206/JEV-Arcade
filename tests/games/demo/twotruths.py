"""Two Truths and a Lie's stand-in players.

The writer takes three sentences of whatever introduction it is given, word
for word, and alters one of them (a verb negated, a place swapped) into the
lie. Jev puts a high p(contradicted) on the altered claim most of the time,
and now and then reads it as merely not in the article; the text judges find
it more often than not, sometimes pick a true claim, and now and then name no
claim at all (a foul)."""
from __future__ import annotations

import random
import re

from wikirace.games import twotruths as T
from wikirace.games.needle_doc import sentences

from . import choice, spread

#: How the lie is made from a true sentence: the first of these that fits.
_ALTER = (
    (r"\bis the largest\b", "is the smallest"), (r"\bis the first\b", "is the last"),
    (r"\bis a\b", "is not a"), (r"\bis an\b", "is not an"), (r"\bwas a\b", "was never a"),
    (r"\bwas the\b", "was never the"), (r"\bare\b", "are not"), (r"\bwere\b", "were not"),
    (r"\bhas\b", "has never"), (r"\bcan\b", "cannot"), (r"\bis\b", "is not"), (r"\bwas\b", "was not"),
)
_FALLBACK = ("Mexico", "Brazil", "Norway", "Egypt", "Japan", "Peru", "Kenya")


def _flat(s: str) -> str:
    return " ".join(s.split())


def _intro(prompt: str) -> str:
    m = re.search(r'INTRODUCTION:\n"""\n(.*?)\n"""', prompt, re.S)
    return m.group(1) if m else ""


def _lie_from(sentence: str) -> str:
    for pat, repl in _ALTER:
        if re.search(pat, sentence):
            return re.sub(pat, repl, sentence, count=1)
    return f"{sentence.rstrip('.')}, according to scholars in {random.choice(_FALLBACK)}."


def _write(prompt: str) -> str:
    intro = _intro(prompt)
    pool = [s for s in sentences(_flat(intro)) if 20 <= len(s) <= 300]
    while len(pool) < 3:
        pool.append(f"The subject of this article is described in its introduction ({len(pool) + 1}).")
    claims = pool[:3]
    lie = random.randrange(3)
    truth = claims[lie]
    claims[lie] = _lie_from(truth)
    rows = [f"CLAIM {n}: {c}" for n, c in enumerate(claims, 1)]
    return "\n".join([*rows, f"LIE: {lie + 1}", f"WHY: The introduction says: {truth[:140]}"])


def _judge(prompt: str) -> str:
    intro = _flat(_intro(prompt))
    claims = {int(m.group(1)): m.group(2) for m in re.finditer(r"^CLAIM ([123]): (.*)$", prompt, re.M)}
    lie = next((n for n, c in claims.items() if _flat(c) not in intro), random.randint(1, 3))
    roll = random.random()
    if roll < 0.7:
        return f"REASON: the introduction says otherwise about claim {lie}.\nLIE: {lie}"
    if roll < 0.92:
        other = random.choice([n for n in (1, 2, 3) if n != lie])
        return f"REASON: claim {other} sounds too neat to be true.\nLIE: {other}"
    return "REASON: they all look plausible to me.\nLIE: none of them"


def text(model, system, prompt):
    if system == T.WRITER_SYSTEM:
        return _write(prompt)
    if system == T.JUDGE_SYSTEM:
        return _judge(prompt)
    return None


def jev(qid, q, state):
    if qid != "verdict" or not isinstance(state, dict) or set(state) != {"article", "claim"}:
        return None
    by = {d.split(":", 1)[0]: o for o, d in q["criteria"].items()}
    true = _flat(state["claim"]) in _flat(state["article"])
    roll = random.random()
    if true:
        best, p = ("supported", random.uniform(0.82, 0.98)) if roll < 0.93 else ("not_in_article", random.uniform(0.45, 0.6))
    elif roll < 0.84:
        best, p = "contradicted", random.uniform(0.7, 0.96)
    elif roll < 0.95:
        best, p = "not_in_article", random.uniform(0.5, 0.7)
    else:
        best, p = "supported", random.uniform(0.5, 0.65)
    return choice(spread(by[best], list(q["criteria"]), p))
