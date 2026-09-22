"""What the demo server's stand-in players say (tests/games/demo_server.py).

Each game may have a module here, `<game>.py`, with either or both of:

    def jev(qid: str, question: dict, state) -> dict | None:
        # A TypeSafe answer ({"type": "choice", "probabilities", "confidence"}, …)
        # for a question this game asked, or None when it is not this game's.

    def text(model: str, system: str, prompt: str) -> str | None:
        # A text model's whole reply to this game's prompt, or None.

A handler recognises its own game's questions and prompts (by a field of the
state, a phrase of the system prompt) and should play like the real thing:
right most of the time, unsure some of the time, and — for a text model —
now and then naming an option that is not there, so the page's fouls show.
The first handler that answers wins; nobody answering gets a random reply.
"""
from __future__ import annotations

import importlib
import pkgutil
import random
import re
from typing import Any


def spread(best: str, options: list[str], p: float, rng: random.Random | None = None) -> dict[str, float]:
    """Probabilities putting *p* on *best* and the rest spread unevenly."""
    rng = rng or random
    others = [o for o in options if o != best]
    weights = [rng.random() ** 3 for _ in others]
    total = sum(weights) or 1.0
    probs = {o: (1 - p) * w / total for o, w in zip(others, weights, strict=True)}
    probs[best] = p
    return probs


def choice(probs: dict[str, float]) -> dict[str, Any]:
    top = max(probs, key=probs.get)
    ranked = sorted(probs.values(), reverse=True)
    conf = max(0.0, min(1.0, ranked[0] - (ranked[1] if len(ranked) > 1 else 0) + 0.1))
    return {"type": "choice", "choice": top, "probabilities": probs, "confidence": round(conf, 3)}


def score(level: float, levels: int, spread_: float = 0.6) -> dict[str, Any]:
    ws = [2.718 ** (-((i - level) ** 2) / (2 * spread_ ** 2)) for i in range(levels)]
    t = sum(ws)
    ps = [w / t for w in ws]
    mean = sum(i * p for i, p in enumerate(ps))
    return {"type": "score", "score": mean, "confidence": round(max(ps), 3),
            "probabilities": {str(i): p for i, p in enumerate(ps)}, "legend": {}}


def noul(p: float) -> dict[str, Any]:
    return {"type": "noul", "noul": max(0.0, min(1.0, p))}


def jev_answer(qid: str, q: dict[str, Any], state: Any) -> dict[str, Any]:
    for h in HANDLERS:
        fn = getattr(h, "jev", None)
        if fn is not None and (a := fn(qid, q, state)) is not None:
            return a
    kind = q.get("type")
    if kind == "choice":
        opts = list(q["criteria"])
        return choice(spread(random.choice(opts), opts, random.uniform(0.4, 0.9)))
    if kind == "score":
        n = len(q["criteria"])
        return score(random.uniform(0, n - 1), n)
    return noul(random.random())


def text_reply(model: str, system: str, prompt: str) -> str:
    for h in HANDLERS:
        fn = getattr(h, "text", None)
        if fn is not None and (r := fn(model, system, prompt)) is not None:
            return r
    m = re.search(r"OPTIONS:\n((?:.+\n?)+)", prompt + "\n" + system)
    if m:
        opts = [ln.strip("-* ").strip() for ln in m.group(1).splitlines() if ln.strip()]
        return f"REASON: it seemed closest.\nANSWER: {random.choice(opts)}"
    return "ANSWER: ?"


# Last, so a handler can import the helpers above: `from . import choice, spread`.
HANDLERS = [
    importlib.import_module(f"{__name__}.{m.name}")
    for m in pkgutil.iter_modules(__path__)
    if not m.name.startswith("_")
]
