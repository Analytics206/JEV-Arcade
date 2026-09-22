"""Who plays an Arcade game, and one call to each kind of player.

A player is named the way a WikiRace racer is, `provider:model_id`: TypeSafe's
Jev (`typesafe:jev-1.13.0`) asks typed questions and gets numbers; any text
model answers in words. `resolve_players` checks the names against the
settings exactly as a race does, and gives two lanes of one model distinct
labels.

`ask_jev` sends one set of questions over one state (split across parallel
requests when there are many) and `ask_text` sends one prompt. Both wait out a
rate limit for a while and retry an outage once, then raise `PlayError` in the
provider's own words, which a game shows on the lane.
"""
from __future__ import annotations

import asyncio
import random
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..config import THINKING_LEVELS, Settings
from ..providers.base import ProviderError, visible_text
from .core import jev_cost, text_cost

#: Questions per Jev request when a game asks many at once. A request answers
#: all of its questions in parallel; more requests run side by side.
JEV_PER_REQUEST = 24
JEV_TIMEOUT_S = 60.0
#: A text model that thinks needs room: its thinking spends the same budget.
TEXT_MAX_TOKENS = 8_000
TEXT_TIMEOUT_S = 180.0
#: How long a rate-limited call waits before each new try (the provider's
#: Retry-After when longer, up to the cap); then it gives up.
_RATE_LIMIT_WAITS_S = (4.0, 10.0, 20.0)
_RATE_LIMIT_MAX_WAIT_S = 60.0
_OUTAGE_RETRY_S = 2.0


class PlayError(RuntimeError):
    """A player could not answer at all: a missing key, a refused request, a
    rate limit that did not lift. Final for that call."""


class BadPlayers(ValueError):
    """The players asked for cannot play this game; the message says why."""


@dataclass
class Player:
    index: int
    key: str
    label: str
    provider: str
    model_id: str
    #: `judgment` (Jev) or `text`.
    kind: str
    thinking: str | None
    client: Any

    @property
    def is_jev(self) -> bool:
        return self.kind == "judgment"


@dataclass
class Asked:
    """What one set of Jev questions came back with, and what it cost."""

    answers: dict[str, Any]
    tokens_in: int
    cost: float
    latency_ms: int
    model: str
    requests: int = 1


@dataclass
class Said:
    """What a text model replied, and what it cost."""

    text: str
    tokens_in: int
    tokens_out: int
    #: None when the provider did not bill and no list price is known.
    cost: float | None
    cost_estimated: bool
    latency_ms: int
    stop_reason: str | None = None
    thinking_sent: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def lane_key(key: str) -> tuple[str, str]:
    pid, _, model_id = key.partition(":")
    return pid, model_id.strip()


def resolve_players(
    lanes: Sequence[Any], settings: Settings, providers: Mapping[str, Any], *,
    kinds: frozenset[str] = frozenset({"judgment", "text"}),
) -> list[Player]:
    """Players for *lanes* (anything with `.key` and `.thinking`, as the API
    reads them). Raises BadPlayers naming the first one that cannot play."""
    out: list[Player] = []
    for i, ln in enumerate(lanes):
        pid, model_id = lane_key(ln.key)
        cfg = settings.provider(pid)
        if cfg is None or not model_id or ":" not in ln.key:
            raise BadPlayers(f"unknown player {ln.key!r}: name it provider:model")
        if cfg.problem:
            raise BadPlayers(f"{cfg.label} cannot play: {cfg.problem}")
        if cfg.kind not in kinds:
            who = "Jev" if cfg.kind == "judgment" else "text models"
            raise BadPlayers(f"this game has no seat for {who}")
        if cfg.kind == "judgment":
            listed = [m.model_id for m in cfg.models]
            if model_id not in listed:
                raise BadPlayers(
                    f"{cfg.label} plays the models {cfg.spec.prefix}_MODELS lists: {', '.join(listed)}"
                )
            thinking = None
        else:
            if len(model_id) > 200 or any(c.isspace() for c in model_id):
                raise BadPlayers(f"“{model_id}” is not a model id")
            asked = getattr(ln, "thinking", None)
            if asked is not None and asked not in THINKING_LEVELS:
                raise BadPlayers(f"thinking must be one of {', '.join(THINKING_LEVELS)}")
            thinking = asked if asked is not None else settings.thinking_for(cfg.id, model_id)
        out.append(Player(
            index=i, key=ln.key, label=model_id, provider=cfg.id, model_id=model_id,
            kind=cfg.kind, thinking=thinking, client=providers[cfg.id],
        ))
    # The same model twice is fair (low thinking against high), but the two
    # lanes must not read the same.
    labels = [p.label for p in out]
    seen: dict[str, int] = {}
    for p, label in zip(out, labels, strict=True):
        base = label if labels.count(label) == 1 else f"{label} · {p.thinking or 'default'}"
        seen[base] = seen.get(base, 0) + 1
        p.label = base if seen[base] == 1 else f"{base} #{seen[base]}"
    return out


Waiting = Callable[[str | None], None]


async def _call(fn: Callable[[], Any], who: str, on_wait: Waiting | None) -> Any:
    """*fn*'s result, waiting out rate limits and retrying one outage."""
    waits = list(_RATE_LIMIT_WAITS_S)
    retried = False
    while True:
        try:
            result = await fn()
        except ProviderError as exc:
            if exc.rate_limited and waits:
                gap = waits.pop(0) * (1 + random.random() / 4)
                if exc.retry_after is not None:
                    if exc.retry_after > _RATE_LIMIT_MAX_WAIT_S:
                        raise PlayError(f"{who}: {exc} (it asks to wait {exc.retry_after:.0f} s)") from exc
                    gap = max(gap, exc.retry_after)
                if on_wait:
                    on_wait(f"rate-limited: trying again in {gap:.0f} s")
                await asyncio.sleep(gap)
                continue
            if exc.retryable and not exc.rate_limited and not retried:
                retried = True
                await asyncio.sleep(_OUTAGE_RETRY_S)
                continue
            raise PlayError(f"{who}: {exc}") from exc
        if on_wait and (len(waits) < len(_RATE_LIMIT_WAITS_S) or retried):
            on_wait(None)
        return result


async def together(aws: Iterable[Awaitable[Any]]) -> list[Any]:
    """Await every one at once, results in order. The first to fail calls off
    the rest, so nothing is left running (or billing), and its error is raised."""
    tasks = [asyncio.ensure_future(a) for a in aws]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def _chunks(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i:i + size] for i in range(0, len(items), size)] or [[]]


async def ask_jev(
    player: Player, state: Any, questions: Mapping[str, Any], *,
    per_request: int = JEV_PER_REQUEST, timeout: float = JEV_TIMEOUT_S, on_wait: Waiting | None = None,
) -> Asked:
    """Jev's answers to *questions* over *state*: one request, or several side
    by side when there are more than *per_request* questions. Raises PlayError."""
    if not player.is_jev:
        raise PlayError(f"{player.label} is not Jev")
    batches = _chunks(list(questions.items()), max(1, per_request))
    started = time.monotonic()

    async def one(batch: list[tuple[str, Any]]) -> dict[str, Any]:
        return await _call(
            lambda: player.client.ask(player.model_id, state, dict(batch), timeout=timeout), "Jev", on_wait,
        )

    tasks = [asyncio.ensure_future(one(b)) for b in batches]
    try:
        bodies = await asyncio.gather(*tasks)
    except BaseException:
        # One request failed: the rest are called off rather than left to bill.
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    answers: dict[str, Any] = {}
    tokens = 0
    model = player.model_id
    for body in bodies:
        answers.update(body.get("answers") or {})
        tokens += int((body.get("usage") or {}).get("input_tokens") or 0)
        model = body.get("model") or model
    missing = [q for q in questions if q not in answers]
    if missing:
        raise PlayError(f"Jev answered without {', '.join(missing[:3])}")
    return Asked(
        answers=answers, tokens_in=tokens, cost=jev_cost(tokens),
        latency_ms=int((time.monotonic() - started) * 1000), model=model, requests=len(batches),
    )


async def ask_text(
    player: Player, system: str, prompt: str, *,
    max_tokens: int = TEXT_MAX_TOKENS, timeout: float = TEXT_TIMEOUT_S, on_wait: Waiting | None = None,
) -> Said:
    """A text model's reply to one prompt, its inline thinking removed.
    Raises PlayError."""
    if player.is_jev:
        raise PlayError("Jev writes no text: ask it questions instead")
    started = time.monotonic()

    async def once() -> Any:
        comp = await player.client.complete(
            player.model_id, system, prompt, thinking=player.thinking, max_tokens=max_tokens, timeout=timeout,
        )
        if not (comp.text or "").strip() and not comp.tokens_out:
            # Nothing generated at all (OpenRouter answers an upstream failure
            # with a 200 and no choices): the provider failed, not the player.
            raise ProviderError(f"{player.client.config.label} returned an empty reply", retryable=True)
        return comp

    comp = await _call(once, player.label, on_wait)
    t_in, t_out = int(comp.tokens_in or 0), int(comp.tokens_out or 0)
    cost, estimated = text_cost(player.model_id, t_in, t_out, comp.cost)
    return Said(
        text=visible_text(comp.text or ""), tokens_in=t_in, tokens_out=t_out, cost=cost,
        cost_estimated=estimated, latency_ms=int((time.monotonic() - started) * 1000),
        stop_reason=comp.stop_reason, thinking_sent=comp.thinking_sent,
    )
