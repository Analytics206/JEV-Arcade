"""What every Arcade game shares that is pure: Jev's three kinds of question,
reading its answers, reading a text model's answer, and what a call cost.

No I/O here, so every function is a test.

**Jev's questions** (TypeSafe's primitives), each asked in one request with
the others over the same `state`, answered in parallel:

  choice   pick one of up to 255 options: `{"choice", "probabilities", "confidence"}`
  score    place the state on 2 to 10 ordered levels: `{"score", "probabilities",
           "confidence", "legend"}`, the score being the probability-weighted level
  noul     a yes/no: `{"noul": p}`, p the probability of yes. No confidence.

Options go to Jev under opaque, shuffled ids (`opaque`), so neither a position
nor an id can carry the answer, and seeded, so the same round always asks the
same question. `read_choice` refuses an answer about options it was not given
rather than sort zeros into what looks like a ranking.

**A text model** answers in words, one field per line (`ANSWER: …`). What it
names is matched against the options it was shown (`match_option`), forgiving
case, quotes, dashes, underscores and a trailing full stop, never substance: a
name that is not an option is a foul, judged by the game.
"""
from __future__ import annotations

import math
import random
import re
import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ..race.rules import JEV_INPUT_PER_MTOK, estimate_cost

#: A choice's ceiling, per the TypeSafe API.
MAX_OPTIONS = 255
#: A score's ceiling (and it needs at least two).
MAX_LEVELS = 10


class AnswerError(ValueError):
    """Jev answered in a shape the question cannot have produced."""


# ── Asking ────────────────────────────────────────────────────────────────────


def choice(instructions: Any, criteria: Mapping[str, Any]) -> dict[str, Any]:
    """A choice question. *criteria* maps each option id to what it means: a
    string, or `{"what", "not_for", "examples"}` for options that sit close."""
    if len(criteria) < 2:
        raise ValueError("a choice needs at least two options")
    if len(criteria) > MAX_OPTIONS:
        raise ValueError(f"a choice holds at most {MAX_OPTIONS} options, not {len(criteria)}")
    return {"type": "choice", "instructions": instructions, "criteria": dict(criteria)}


def score(instructions: Any, levels: Sequence[Any]) -> dict[str, Any]:
    """A score question over *levels*, lowest first (level 0 is the first)."""
    if not 2 <= len(levels) <= MAX_LEVELS:
        raise ValueError(f"a score has 2 to {MAX_LEVELS} levels, not {len(levels)}")
    return {"type": "score", "instructions": instructions, "criteria": list(levels)}


def noul(instructions: Any, *, yes: str | None = None, no: str | None = None) -> dict[str, Any]:
    """A yes/no question. *yes* and *no* say what each answer means, when the
    words of the question alone leave room."""
    q: dict[str, Any] = {"type": "noul", "instructions": instructions}
    if yes or no:
        q["criteria"] = {"true": yes or "yes", "false": no or "no"}
    return q


def opaque(options: Sequence[str], seed: str, prefix: str = "o") -> dict[str, str]:
    """{id: option} under ids that say nothing, in an order shuffled by *seed*."""
    order = list(dict.fromkeys(options))
    random.Random(seed).shuffle(order)
    return {f"{prefix}{i}": opt for i, opt in enumerate(order)}


# ── Reading Jev ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Picked:
    """A choice answer, in the options' own words."""

    option: str
    p: float
    confidence: float
    #: Every option with its probability, likeliest first.
    ranked: tuple[tuple[str, float], ...]

    def top(self, n: int = 5) -> list[dict[str, Any]]:
        """The first *n*, as the page shows them."""
        return [{"option": o, "p": round(p, 4)} for o, p in self.ranked[:n]]


def read_choice(answer: Mapping[str, Any] | None, ids: Mapping[str, str] | None = None) -> Picked:
    """A choice answer. With *ids* ({id: option}, from `opaque`), the options
    come back in their own words and the answer must cover exactly those ids."""
    if not isinstance(answer, Mapping):
        raise AnswerError("Jev gave no answer to this question")
    probs = answer.get("probabilities")
    if not isinstance(probs, Mapping) or not probs:
        raise AnswerError("Jev's choice came without probabilities")
    if ids is not None and set(probs) != set(ids):
        raise AnswerError("Jev answered about options it was not given")
    try:
        pairs = [((ids[k] if ids is not None else str(k)), float(v)) for k, v in probs.items()]
    except (TypeError, ValueError) as exc:
        raise AnswerError("Jev's probabilities are not numbers") from exc
    pairs.sort(key=lambda kv: -kv[1])
    return Picked(pairs[0][0], pairs[0][1], _num(answer.get("confidence")), tuple(pairs))


@dataclass(frozen=True)
class Scored:
    """A score answer."""

    #: The probability-weighted level, 0 … levels-1.
    score: float
    confidence: float
    #: One probability per level, lowest level first; they sum to 1.
    probabilities: tuple[float, ...]

    @property
    def level(self) -> int:
        """The likeliest level."""
        return max(range(len(self.probabilities)), key=lambda i: self.probabilities[i])

    @property
    def spread(self) -> float:
        """The standard deviation of the level, around `score`."""
        return math.sqrt(sum(p * (i - self.score) ** 2 for i, p in enumerate(self.probabilities)))

    @property
    def fraction(self) -> float:
        """`score` as a share of the top level: 0 … 1."""
        top = len(self.probabilities) - 1
        return self.score / top if top else 0.0

    def public(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 4), "confidence": round(self.confidence, 4),
            "spread": round(self.spread, 4), "level": self.level,
            "probabilities": [round(p, 4) for p in self.probabilities],
        }


def read_score(answer: Mapping[str, Any] | None, levels: int) -> Scored:
    """A score answer over *levels* levels."""
    if not isinstance(answer, Mapping):
        raise AnswerError("Jev gave no answer to this question")
    probs = answer.get("probabilities")
    if not isinstance(probs, Mapping):
        raise AnswerError("Jev's score came without probabilities")
    try:
        ps = [max(0.0, float(probs.get(str(i), probs.get(i, 0.0)) or 0.0)) for i in range(levels)]
    except (TypeError, ValueError) as exc:
        raise AnswerError("Jev's probabilities are not numbers") from exc
    total = sum(ps)
    if total <= 0:
        raise AnswerError("Jev's score put no probability on any level")
    ps = [p / total for p in ps]
    mean = answer.get("score")
    if not isinstance(mean, (int, float)) or isinstance(mean, bool) or not math.isfinite(mean):
        mean = sum(i * p for i, p in enumerate(ps))
    return Scored(float(mean), _num(answer.get("confidence")), tuple(ps))


def read_noul(answer: Mapping[str, Any] | None) -> float:
    """A noul answer: the probability of yes."""
    if not isinstance(answer, Mapping):
        raise AnswerError("Jev gave no answer to this question")
    v = answer.get("noul")
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        raise AnswerError("Jev's yes/no came without a probability")
    return min(1.0, max(0.0, float(v)))


def _num(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return f if math.isfinite(f) else 0.0


# ── Reading a text model ──────────────────────────────────────────────────────

# `NAME: value`, forgiving what models decorate a field with: a bullet, bold,
# a heading hash, a full-width colon. The same shape as the race's LINK line.
_FIELD = r"^[ \t>*_`#-]*{name}[ \t*_`]*[:：][ \t*_`]*(?P<v>[^\n]*)$"
#: A reply is read from its end, where the answer is, and never past this.
_MAX_REPLY = 20_000
_DASHES = str.maketrans({c: "-" for c in "‐‑‒–—―−"})
_QUOTES = str.maketrans({c: "'" for c in "‘’ʼ`"} | {c: '"' for c in "“”«»"})
_WRAP = "\"'*_`[]()<>"


def read_field(text: str | None, name: str) -> str | None:
    """The value of the last `NAME:` line in *text*, trimmed; None when there
    is none or it is empty. The last, because a model that thinks aloud may
    draft an answer before the one it settles on."""
    if not text:
        return None
    pattern = re.compile(_FIELD.format(name=re.escape(name)), re.I | re.M)
    found = None
    for m in pattern.finditer(text[-_MAX_REPLY:]):
        v = m.group("v").strip().strip("*_`").strip()
        if v:
            found = v
    return found


def fold(s: str) -> str:
    """A forgiving comparison key for a name a model typed: case, width,
    dashes, quotes, underscores and spacing folded; wrapping quotes, emphasis
    and one trailing full stop peeled off."""
    t = unicodedata.normalize("NFKC", s).translate(_DASHES).translate(_QUOTES)
    t = t.replace("_", " ").replace("**", "")
    t = " ".join(t.split())
    for _ in range(4):  # a few layers: `"*Paris*".` peels to Paris
        before = t
        t = t.strip("*_` ").rstrip(".;,!").strip()
        if len(t) > 1 and t[0] in _WRAP and t[-1] in _WRAP:
            t = t[1:-1].strip()
        if t == before:
            break
    return t.casefold()


def match_option(claimed: str | None, options: Sequence[str]) -> str | None:
    """The option *claimed* names, or None when it names none of them."""
    if not claimed:
        return None
    key = fold(claimed)
    if not key:
        return None
    for opt in options:
        if fold(opt) == key:
            return opt
    return None


# ── Cost ──────────────────────────────────────────────────────────────────────


def jev_cost(tokens_in: int) -> float:
    """What Jev costs: input only."""
    return tokens_in * JEV_INPUT_PER_MTOK / 1_000_000


def text_cost(model_id: str, tokens_in: int, tokens_out: int, billed: float | None) -> tuple[float | None, bool]:
    """(cost, estimated): what the provider billed when it said, else the list
    price, else None."""
    if billed is not None:
        return billed, False
    est = estimate_cost(model_id, tokens_in, tokens_out)
    return est, est is not None
