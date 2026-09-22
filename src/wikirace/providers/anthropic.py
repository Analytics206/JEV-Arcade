"""Anthropic: the Messages API through the official SDK.

One non-streaming `messages.create` per turn, the rules as the system prompt
and the turn as the one user message. The answer is the text blocks alone:
thinking blocks are the model's working, not its reply. `stop_reason` passes
through as the API says it (`refusal` and `max_tokens` included), so the game
can say why a reply is empty.

The client is `anthropic.AsyncAnthropic`, one per event loop, with
`max_retries=0`: the race engine owns retries and waits out rate limits in
plain sight, and an SDK retrying underneath it would hide both. The SDK is
built on httpx2, not httpx; `transport` still takes an `httpx.MockTransport`
(bridged below), so the tests stub every provider the same way.

**Thinking**, per model, from Anthropic's per-model table (thinking
troubleshooting and effort pages, checked 2026-09-22):

======================================  ==========  =====================  ==========
Model                                   effort      thinking               `none`
======================================  ==========  =====================  ==========
Fable 5.x, Mythos 5.x                   low…max     adaptive, always on    effort=low
Opus 5, Sonnet 5 (and later)            low…max     adaptive, on           disabled
Opus 4.7, 4.8                           low…max     adaptive, off          disabled
Opus 4.6, Sonnet 4.6                    no xhigh    adaptive, off          disabled
Opus 4.5                                low…high    budget_tokens only     disabled
Haiku 4.5, Sonnet 4.5, older            none        budget_tokens only     disabled
======================================  ==========  =====================  ==========

A level is `output_config.effort` where the model takes it, plus
`thinking: {type: adaptive}` where thinking is off unless asked for (effort
alone does not turn it on there). A level a model lacks folds down: `xhigh`
on Opus 4.6 is `high`. The budget-only models get `thinking.budget_tokens`,
with `max_tokens` raised above the budget as the API requires. `none` is
`thinking: {type: disabled}` where accepted; the always-on models, which
refuse it, get the least thinking they take (`effort: low`). A model not in
the table is treated as its generation suggests and probed down the ladder.
"""
from __future__ import annotations

import asyncio
import contextlib
import re
from dataclasses import dataclass
from typing import Any

import anthropic
import httpx
import httpx2

from ..config import THINKING_LEVELS, ProviderConfig
from .base import (
    Completion,
    ProviderError,
    TextProvider,
    fix_hint,
    require_configured,
    status_error,
    transport_error,
)
from .ladder import NOTHING, Ladder, Rung, nearest

#: Thinking budgets for the models that take only `budget_tokens`. 1024 is
#: the API's minimum; the top one leaves room for the answer inside the 32k
#: output ceiling of the smallest of those models (Opus 4 and 4.1).
BUDGETS: dict[str, int] = {"low": 1024, "medium": 4096, "high": 8192, "xhigh": 16384, "max": 24576}
#: Tokens kept for the answer on top of a thinking budget (it must be below
#: max_tokens): the reply is two short lines.
ANSWER_ROOM = 4096

_FULL = ("low", "medium", "high", "xhigh", "max")
_NO_XHIGH = ("low", "medium", "high", "max")
_BASIC = ("low", "medium", "high")

#: claude-<tier>-<major>[-<minor>][-<date>]; a date is not a minor version.
_CLAUDE_ID = re.compile(r"^claude-(?P<tier>[a-z]+)-(?P<major>\d+)(?:-(?P<minor>\d{1,2})(?!\d))?")


@dataclass(frozen=True)
class Profile:
    """What a Claude model takes, as far as thinking goes."""

    #: `output_config.effort` values it takes, least first; () when none.
    efforts: tuple[str, ...] = ()
    #: It takes `thinking: {type: adaptive}`.
    adaptive: bool = False
    #: Omitting `thinking` runs adaptive thinking anyway.
    thinks_by_default: bool = False
    #: It takes `thinking: {type: disabled}`.
    can_disable: bool = True
    #: It takes `thinking: {type: enabled, budget_tokens: N}`.
    budget: bool = False


def profile(model: str) -> Profile:
    m = model.lower()
    if m.startswith("claude-mythos-preview"):
        return Profile(_NO_XHIGH, adaptive=True, thinks_by_default=True, can_disable=False, budget=True)
    match = _CLAUDE_ID.match(m)
    if not match:  # claude-3-*, claude-2, a name from somewhere else: budget_tokens at most
        return Profile(budget=True)
    tier = match["tier"]
    version = (int(match["major"]), int(match["minor"] or 0))
    if tier in {"fable", "mythos"}:
        return Profile(_FULL, adaptive=True, thinks_by_default=True, can_disable=False)
    if version >= (5, 0):
        return Profile(_FULL, adaptive=True, thinks_by_default=True)
    if tier == "opus":
        if version >= (4, 7):
            return Profile(_FULL, adaptive=True)
        if version == (4, 6):
            return Profile(_NO_XHIGH, adaptive=True, budget=True)
        if version == (4, 5):
            return Profile(_BASIC, budget=True)
        return Profile(budget=True)
    if tier == "sonnet" and version >= (4, 6):
        return Profile(_NO_XHIGH, adaptive=True, budget=True)
    return Profile(budget=True)


_EFFORT_WORDS = ("effort", "output_config")
_THINKING_WORDS = ("thinking", "adaptive", "budget_tokens")


def _effort(level: str, *, adaptive: bool) -> Rung:
    params: dict[str, Any] = {"output_config": {"effort": level}}
    sent = f"output_config.effort={level}"
    if adaptive:
        params["thinking"] = {"type": "adaptive"}
        sent = f"thinking=adaptive, {sent}"
    return Rung(sent, params, _EFFORT_WORDS + (_THINKING_WORDS if adaptive else ()))


def _budget(level: str, effort: str | None = None) -> Rung:
    tokens = BUDGETS[level]
    params: dict[str, Any] = {"thinking": {"type": "enabled", "budget_tokens": tokens}}
    sent = f"thinking.budget_tokens={tokens}"
    about = (*_THINKING_WORDS, "max_tokens")
    if effort:
        params["output_config"] = {"effort": effort}
        sent += f", output_config.effort={effort}"
        about += _EFFORT_WORDS
    return Rung(sent, params, about)


DISABLED = Rung("thinking=disabled", {"thinking": {"type": "disabled"}}, _THINKING_WORDS)


def rungs(model: str, level: str | None) -> list[Rung]:
    """The ways of sending *level* to *model*, the preferred one first."""
    if level is None:
        return [NOTHING]
    p = profile(model)
    out: list[Rung] = []
    if level == "none":
        if p.can_disable:
            out.append(DISABLED)
        if p.efforts:
            out.append(_effort(nearest("low", p.efforts), adaptive=False))
        return [*out, NOTHING]
    if p.efforts and p.adaptive:
        first = nearest(level, p.efforts)
        top, high = p.efforts.index(first), p.efforts.index("high")
        # Above `high`, fold on down to it should the model refuse (`high` is
        # also what omitting effort means): max, xhigh, high.
        chain = [first, *reversed(p.efforts[high:top])]
        out += [_effort(e, adaptive=not p.thinks_by_default) for e in chain]
    if p.budget:
        effort = nearest(level, p.efforts) if p.efforts and not p.adaptive else None
        out.append(_budget(level, effort))
        if effort:
            out.append(_budget(level))
    return [*out, NOTHING]


class _Httpx2Transport(httpx2.AsyncBaseTransport):
    """An httpx transport (a test's MockTransport) behind the SDK's httpx2
    client: the request and the response are copied across, byte for byte,
    and a transport error becomes httpx2's own, which the SDK knows."""

    def __init__(self, inner: httpx.AsyncBaseTransport) -> None:
        self._inner = inner

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        body = await request.aread()
        req = httpx.Request(request.method, str(request.url), headers=request.headers.raw, content=body,
                            extensions=request.extensions)
        try:
            resp = await self._inner.handle_async_request(req)
        except httpx.TransportError as exc:
            twin = getattr(httpx2, type(exc).__name__, None)
            if isinstance(twin, type) and issubclass(twin, httpx2.TransportError):
                raise twin(str(exc), request=request) from exc
            raise
        headers = resp.headers.raw
        if resp.is_stream_consumed:
            # Built in memory (a mock's reply): httpx has read it already,
            # decoded, so the encoding and length headers no longer describe it.
            body = resp.content
            headers = [(k, v) for k, v in headers if k.lower() not in {b"content-encoding", b"content-length"}]
        else:
            body = b"".join([chunk async for chunk in resp.aiter_raw()])
        await resp.aclose()
        return httpx2.Response(resp.status_code, headers=headers, content=body, request=request)

    async def aclose(self) -> None:
        await self._inner.aclose()


def _sdk_transport(transport: Any) -> httpx2.AsyncBaseTransport | None:
    if transport is None or isinstance(transport, httpx2.AsyncBaseTransport):
        return transport
    return _Httpx2Transport(transport)


def _detail(exc: anthropic.APIStatusError) -> str:
    body = exc.body
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        err = body["error"]
        words = str(err.get("message") or err.get("type") or "").strip()
        if words:
            return words
    return str(exc.message)


class AnthropicProvider(TextProvider):
    def __init__(self, config: ProviderConfig, *, transport: Any = None) -> None:
        super().__init__(config)
        self._transport = _sdk_transport(transport)
        self._client: anthropic.AsyncAnthropic | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._ladder = Ladder()

    def _sdk(self) -> anthropic.AsyncAnthropic:
        """This loop's client: one made on another loop cannot be awaited here."""
        loop = asyncio.get_running_loop()
        if self._client is None or self._loop is not loop:
            http_client = (
                anthropic.DefaultAsyncHttpxClient(transport=self._transport) if self._transport else None
            )
            self._client = anthropic.AsyncAnthropic(
                api_key=self.config.api_key, base_url=self.config.base_url, max_retries=0,
                http_client=http_client,
            )
            self._loop = loop
        return self._client

    async def complete(
        self, model: str, system: str, prompt: str, *,
        thinking: str | None, max_tokens: int, timeout: float,
    ) -> Completion:
        require_configured(self.config)
        if thinking is not None and thinking not in THINKING_LEVELS:
            raise ProviderError(f"unknown thinking level “{thinking}”")

        async def call(rung: Rung) -> Completion:
            return await self._create(model, system, prompt, rung, max_tokens, timeout)

        return await self._ladder.climb((model, thinking), rungs(model, thinking), call)

    async def _create(
        self, model: str, system: str, prompt: str, rung: Rung, max_tokens: int, timeout: float,
    ) -> Completion:
        params: dict[str, Any] = dict(rung.params)
        budget = (params.get("thinking") or {}).get("budget_tokens")
        if budget:
            max_tokens = max(max_tokens, budget + ANSWER_ROOM)
        if system:
            params["system"] = system
        try:
            msg = await self._sdk().messages.create(
                model=model, max_tokens=max_tokens, messages=[{"role": "user", "content": prompt}],
                timeout=timeout, **params,
            )
        except anthropic.APIStatusError as exc:
            status = exc.status_code
            raise status_error(
                "Anthropic", status, _detail(exc), exc.response.headers,
                hint=fix_hint(self.config, status, model),
            ) from exc
        except anthropic.APITimeoutError as exc:
            raise ProviderError(f"Anthropic did not answer within {timeout:.0f}s", retryable=True) from exc
        except anthropic.APIConnectionError as exc:
            raise transport_error("Anthropic", exc.__cause__ or exc, url=self.config.base_url) from exc
        except anthropic.APIError as exc:  # a reply the SDK could not read
            raise ProviderError(f"Anthropic: {exc.message}", retryable=True) from exc
        usage = msg.usage
        tokens_in = sum(
            int(getattr(usage, name, 0) or 0)
            for name in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
        )
        return Completion(
            text="".join(
                block.text for block in msg.content
                if getattr(block, "type", None) == "text" and isinstance(getattr(block, "text", None), str)
            ),
            model=msg.model if isinstance(msg.model, str) and msg.model else model,
            tokens_in=tokens_in,
            tokens_out=int(usage.output_tokens or 0),
            cost=None,
            stop_reason=msg.stop_reason if isinstance(msg.stop_reason, str) else None,
            thinking_sent=rung.sent,
        )

    async def aclose(self) -> None:
        client, self._client, self._loop = self._client, None, None
        if client is not None:
            with contextlib.suppress(RuntimeError):  # its loop is gone
                await client.close()
