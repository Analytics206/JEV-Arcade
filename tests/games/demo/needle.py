"""Needle Hunt's stand-in players.

Jev points at an answer line most of the time (the question's key for the
Constitution, the line sharing the most words with a typed question), and
its existence dial is high when there is an answer and low when there is
none, with the odd hesitation in the partly band. The text models are right
more often than not, sometimes answer the line beside it or NONE, and now
and then name a line that does not exist."""
from __future__ import annotations

import random
import re

from wikirace.games import needle as N

from . import choice, noul, spread

KEY = {q["q"]: q["lines"] for q in N.bank()["questions"]}
_STOP = frozenset("the a an of to in on is are was were be by for and or what who how does do can any may must "
                  "which when where with from that this it its as at their there shall".split())


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", s.casefold()) if len(w) > 2 and w not in _STOP}


def _best(question: str, texts: dict[str, str]) -> tuple[str, int]:
    want = _words(question)
    best = max(texts, key=lambda k: len(want & _words(texts[k])))
    return best, len(want & _words(texts[best]))


def _mine(qid, q, state) -> bool:
    return (isinstance(state, dict) and "question" in state and set(state) <= {"question", "lines"}
            and qid in ("line", "exists", "window"))


def jev(qid, q, state):
    if not _mine(qid, q, state):
        return None
    question = state["question"]
    key = KEY.get(question)
    roll = random.random()
    if q["type"] == "noul":
        if key is None:
            _, hits = _best(question, state["lines"])
            return noul(min(0.95, 0.3 + 0.18 * hits) + random.uniform(-0.05, 0.05))
        if key:
            return noul(random.uniform(0.74, 0.98) if roll < 0.88 else random.uniform(0.4, 0.66))
        return noul(random.uniform(0.04, 0.3) if roll < 0.85 else random.uniform(0.38, 0.6))
    ids = q["criteria"]
    if qid == "window":
        best, _ = _best(question, ids)
        if key:
            best = next((o for o, d in ids.items() if any(k in d for k in key)), best)
        return choice(spread(best, list(ids), random.uniform(0.6, 0.95)))
    # Each option reads `Lnnn (where): text`.
    line_of = {o: d.split(" ", 1)[0] for o, d in ids.items()}
    by_line = {lid: o for o, lid in line_of.items()}
    if key:
        target = by_line.get(key[0])
        if target is None or roll > 0.9:
            target = random.choice(list(ids))
    else:
        target, _ = _best(question, {o: d.split(": ", 1)[-1] for o, d in ids.items()})
    return choice(spread(target, list(ids), random.uniform(0.55, 0.95) if key else random.uniform(0.2, 0.5)))


def text(model, system, prompt):
    if system == N.ASKER_SYSTEM:
        rows = [r for r in prompt.splitlines()[2:] if len(r) > 40]
        row = random.choice(rows) if rows else "the article"
        subject = " ".join(row.split()[:6]).rstrip(",.;")
        return f"QUESTION: What does the article say about {subject}?"
    if "searching a document for the one line" not in system:
        return None
    question = prompt.split("QUESTION: ", 1)[-1].strip()
    lines = dict(re.findall(r"^(L\d{3}): (.*)$", system, re.M))
    key = KEY.get(question)
    if key is None:
        best, hits = _best(question, lines)
        right = best if hits else "NONE"
    else:
        right = key[0] if key else "NONE"
    roll = random.random()
    if roll < 0.68:
        line = right
    elif roll < 0.8 and right != "NONE":
        n = int(right[1:]) + random.choice((-1, 1))
        line = f"L{n:03d}" if f"L{n:03d}" in lines else right
    elif roll < 0.9:
        line = "NONE"
    else:
        line = random.choice(["Article I", "L999", "Section 8", "the Preamble"])
    return f"REASON: that line covers what the question asks.\nLINE: {line}"
