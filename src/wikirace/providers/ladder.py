"""The thinking ladder: send a level the way a model takes it, learning once.

Each provider turns a thinking level into request fields, and not every model
takes every spelling: Claude Fable refuses `thinking: disabled`, gpt-5 has no
`none`, an old Ollama knows no level strings. So a level becomes a short list
of `Rung`s, the preferred one first, each a way of sending it that a model
might take, ending in `NOTHING` (send no thinking fields at all, which every
model takes). The provider's table of known models puts the right rung first,
so a known model never probes; the rest of the list is for the models the
table has never heard of.

`Ladder.climb` tries the rungs in order. A 400 whose words are about the
rung's own parameter moves on to the next; any other error is the call's
error. The rung that worked is remembered per (model, level) in process
memory, so only a model's first turn pays for a probe, and the move records
what was actually sent (`Completion.thinking_sent`, the rung's `sent`).
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, TypeVar

from .base import ProviderError

T = TypeVar("T")

#: Every reasoning level the providers speak, least to most. WikiRace's own
#: levels are a subset; `minimal` is OpenAI's rung between `none` and `low`.
ORDER: tuple[str, ...] = ("none", "minimal", "low", "medium", "high", "xhigh", "max")


def nearest(level: str, supported: Sequence[str]) -> str:
    """*level* if the model takes it, else the closest value it does take.
    A tie folds down: asked for `xhigh` where only `high` and `max` exist, a
    model gets `high`, because a request the person did not make is worse
    than a little less of the one they did."""
    known = [v for v in supported if v in ORDER]
    if not known:
        return level
    if level in known:
        return level
    at = ORDER.index(level)
    return min(known, key=lambda v: (abs(ORDER.index(v) - at), ORDER.index(v)))


@dataclass(frozen=True)
class Rung:
    """One way of sending a thinking level."""

    #: What the move shows (`output_config.effort=high`, `think=false`), or
    #: None when nothing is sent.
    sent: str | None
    #: Request fields this rung adds.
    params: Mapping[str, Any] = field(default_factory=dict)
    #: Words a 400 refusing this rung's parameter contains ("effort", "think").
    about: tuple[str, ...] = ()


#: Send no thinking fields: the model does what it does by default.
NOTHING = Rung(None)

#: Given the error, the rung it refused and the rungs still to try, the rungs
#: to try next; None when the error is not a refusal of that rung.
Refusal = Callable[[ProviderError, Rung, list[Rung]], Sequence[Rung] | None]


def refused_about(exc: ProviderError, rung: Rung, rest: list[Rung]) -> Sequence[Rung] | None:
    """The default reading of a refusal: a 400 (or a validating server's 422)
    that names this rung's parameter means the next rung."""
    if exc.status not in (400, 422) or not rung.about:
        return None
    text = str(exc).lower()
    return rest if any(word in text for word in rung.about) else None


class Ladder:
    """The rung that worked, per key (a model and a level), for one provider."""

    def __init__(self) -> None:
        self._worked: dict[Hashable, Rung] = {}

    def remembered(self, key: Hashable) -> Rung | None:
        return self._worked.get(key)

    def _start(self, key: Hashable, rungs: Sequence[Rung]) -> list[Rung]:
        known = self._worked.get(key)
        if known is None:
            return list(rungs)
        for i, rung in enumerate(rungs):
            if rung == known:
                return list(rungs[i:])
        # Learned from a refusal that named the values the model takes: not
        # on the list the table makes, so it goes in front of it.
        return [known, *rungs]

    async def climb(
        self, key: Hashable, rungs: Sequence[Rung], call: Callable[[Rung], Awaitable[T]],
        refused: Refusal | None = None,
    ) -> T:
        """`call(rung)` for the first rung the model takes; its error when none."""
        queue = self._start(key, rungs or (NOTHING,))
        tried: list[Rung] = []
        while True:
            rung = queue.pop(0)
            tried.append(rung)
            try:
                result = await call(rung)
            except ProviderError as exc:
                nxt = (refused or refused_about)(exc, rung, queue)
                queue = [r for r in (nxt or ()) if r not in tried]
                if not queue:
                    raise
                continue
            self._worked[key] = rung
            return result
