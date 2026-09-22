"""OpenAI and OpenRouter: Chat Completions over httpx, one class, two configs.

`POST {base_url}/chat/completions`, the rules as a system message and the turn
as the user message. Tokens are `usage.prompt_tokens` and
`usage.completion_tokens` (reasoning included: both bill it as output). The
two differ in four places:

* **Output cap.** OpenAI takes `max_completion_tokens`; the old `max_tokens`
  is refused by its reasoning models. OpenRouter takes `max_tokens`.
* **Thinking.** OpenAI's reasoning models take `reasoning_effort`, and each
  family takes its own values (below); other models take nothing, and nothing
  is sent. OpenRouter takes `reasoning: {effort}` for every model and maps a
  level a model lacks to its nearest one itself, so the level goes as it is;
  `none` turns reasoning off, and a model whose reasoning cannot be turned off
  answers 400, after which `minimal` goes instead.
* **Cost.** OpenRouter says what it billed (`usage.cost`, USD); OpenAI does
  not, and the game estimates from list prices.
* **Failure in a 200.** OpenRouter reports a failure upstream as a 200 that
  carries an `error` object, or has no choices at all. That is the provider's
  outage, not the racer's move: a retryable error, never an empty reply the
  game would call a foul.

`reasoning_effort` per family, from OpenAI's model pages (2026-09-22). A level
folds to the nearest value the model takes, `none` to `none`, `minimal` or the
lowest there is:

=====================  ==========================================
o-series, gpt-oss      low, medium, high
gpt-5, -mini, -nano    minimal, low, medium, high
gpt-5.1                none, low, medium, high
gpt-5.2 … gpt-5.5      none, low, medium, high, xhigh
gpt-5.6-*              none, low, medium, high, xhigh, max
gpt-6-*                low, medium, high, xhigh, max
=====================  ==========================================

A reasoning model the table does not know gets the level as it is, and when
OpenAI refuses it, its error lists the values the model takes: the nearest of
those is sent, and remembered.
"""
from __future__ import annotations

import json
import re
from typing import Any

import httpx

from ..config import THINKING_LEVELS, ProviderConfig
from .base import (
    Completion,
    LoopClient,
    ProviderError,
    TextProvider,
    error_detail,
    fix_hint,
    require_configured,
    status_error,
    transport_error,
    visible_text,
)
from .ladder import NOTHING, ORDER, Ladder, Rung, nearest

#: OpenRouter's attribution headers: which app is calling, and where it lives.
OPENROUTER_HEADERS = {"HTTP-Referer": "https://github.com/Analytics206/wikirace", "X-Title": "WikiRace"}

#: Models that take `reasoning_effort` at all.
_REASONING = re.compile(r"^(?:o\d|gpt-(?:[5-9]|[1-9]\d)|gpt-oss)")
#: The values each family takes, least first; the first match wins.
EFFORTS: tuple[tuple[re.Pattern[str], tuple[str, ...]], ...] = (
    (re.compile(r"^gpt-5-pro"), ("high",)),
    (re.compile(r"^gpt-5-chat"), ()),
    (re.compile(r"^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$"), ("minimal", "low", "medium", "high")),
    (re.compile(r"^gpt-5\.1(?!\d)"), ("none", "low", "medium", "high")),
    (re.compile(r"^gpt-5\.[2-5](?!\d)"), ("none", "low", "medium", "high", "xhigh")),
    (re.compile(r"^gpt-5\.6(?!\d)"), ("none", "low", "medium", "high", "xhigh", "max")),
    (re.compile(r"^gpt-6"), ("low", "medium", "high", "xhigh", "max")),
    (re.compile(r"^gpt-oss"), ("low", "medium", "high")),
    (re.compile(r"^o\d"), ("low", "medium", "high")),
)

_SUPPORTED = re.compile(r"supported values (?:are|is)\s*:?\s*(.+)", re.I | re.S)


def efforts_for(model: str) -> tuple[str, ...]:
    """The `reasoning_effort` values *model* takes; () when it takes none.
    A vendor prefix (`openai/gpt-oss-120b` on another server) is ignored."""
    bare = model.rsplit("/", 1)[-1].lower()
    if not _REASONING.match(bare):
        return ()
    for pattern, values in EFFORTS:
        if pattern.match(bare):
            return values
    return ORDER


def supported_values(message: str) -> tuple[str, ...]:
    """The values an OpenAI refusal says the model takes ("Supported values
    are: 'low', 'medium', and 'high'."), or () when it names none."""
    m = _SUPPORTED.search(message)
    if not m:
        return ()
    sentence = m.group(1).split(".")[0].lower()
    return tuple(dict.fromkeys(w for w in re.findall(r"[a-z]+", sentence) if w in ORDER))


def _effort(value: str) -> Rung:
    return Rung(f"reasoning_effort={value}", {"reasoning_effort": value}, ("reasoning",))


def _router_effort(value: str) -> Rung:
    return Rung(f"reasoning.effort={value}", {"reasoning": {"effort": value}}, ("reasoning",))


def openai_rungs(model: str, level: str | None) -> list[Rung]:
    values = efforts_for(model)
    if level is None or not values:
        return [NOTHING]
    return [_effort(nearest(level, values)), NOTHING]


def openrouter_rungs(level: str | None) -> list[Rung]:
    if level is None:
        return [NOTHING]
    first = [_router_effort(level)]
    if level == "none":  # a model whose reasoning is mandatory: the least of it
        first.append(_router_effort("minimal"))
    return [*first, NOTHING]


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # content parts, from some compatible servers
        return "".join(
            str(part.get("text") or "") for part in content
            if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
        )
    return ""


def _error_code(resp: httpx.Response) -> Any:
    try:
        err = resp.json().get("error")
    except (ValueError, AttributeError):
        return None
    return (err.get("code") or err.get("type")) if isinstance(err, dict) else None


class OpenAIProvider(TextProvider):
    """Chat Completions for OpenAI (and any server that speaks it, via the
    URL) and for OpenRouter, chosen by the config's provider id."""

    def __init__(self, config: ProviderConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        self.openrouter = config.id == "openrouter"
        headers = {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}
        if self.openrouter:
            headers.update(OPENROUTER_HEADERS)
        self._http = LoopClient(timeout=300.0, headers=headers, transport=transport)
        self._ladder = Ladder()

    async def complete(
        self, model: str, system: str, prompt: str, *,
        thinking: str | None, max_tokens: int, timeout: float,
    ) -> Completion:
        require_configured(self.config)
        if thinking is not None and thinking not in THINKING_LEVELS:
            raise ProviderError(f"unknown thinking level “{thinking}”")

        async def call(rung: Rung) -> Completion:
            return await self._call(model, system, prompt, rung, max_tokens, timeout)

        if self.openrouter:
            return await self._ladder.climb((model, thinking), openrouter_rungs(thinking), call)

        def refused(exc: ProviderError, rung: Rung, rest: list[Rung]) -> list[Rung] | None:
            # A 400 about reasoning_effort: the model takes other values (and
            # says which), or takes none at all (then nothing is sent).
            if exc.status not in (400, 422) or not rung.params or "reasoning" not in str(exc).lower():
                return None
            values = supported_values(str(exc))
            if values and thinking is not None:
                better = _effort(nearest(thinking, values))
                if better != rung:
                    return [better, NOTHING]
            return rest

        return await self._ladder.climb((model, thinking), openai_rungs(model, thinking), call, refused)

    async def _call(
        self, model: str, system: str, prompt: str, rung: Rung, max_tokens: int, timeout: float,
    ) -> Completion:
        messages = [{"role": "system", "content": system}] if system else []
        messages.append({"role": "user", "content": prompt})
        payload: dict[str, Any] = {"model": model, "messages": messages}
        if self.openrouter:
            # `usage.include` is a no-op now (usage and cost always come
            # back), kept for gateways that still read it.
            payload.update(max_tokens=max_tokens, usage={"include": True})
        else:
            payload["max_completion_tokens"] = max_tokens
        payload.update(rung.params)
        try:
            resp = await self._http.get().post(
                f"{self.config.base_url}/chat/completions", json=payload, timeout=timeout,
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise transport_error(self.label, exc, url=self.config.base_url, timeout=timeout) from exc
        if resp.status_code != 200:
            raise self._http_error(resp, model)
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderError(
                f"{self.label} answered with something that is not JSON: {resp.text[:200]!r}", retryable=True,
            ) from exc
        return self._completion(body, model, rung)

    def _http_error(self, resp: httpx.Response, model: str) -> ProviderError:
        status, detail = resp.status_code, error_detail(resp.text)
        if status == 429 and _error_code(resp) == "insufficient_quota":
            # A 429 that waiting cannot fix: the account has no credit left.
            return ProviderError(
                f"{self.label} answered HTTP 429: {detail} — the account is out of credit; check its billing",
                status=status,
            )
        if status == 408:  # OpenRouter: the request timed out upstream
            return ProviderError(f"{self.label} answered HTTP 408: {detail}", retryable=True, status=status)
        return status_error(self.label, status, detail, resp.headers, hint=fix_hint(self.config, status, model))

    def _no_reply(self, error: Any) -> ProviderError:
        if isinstance(error, dict):
            code = error.get("code")
            words = error_detail(json.dumps({"error": error}))
            return ProviderError(
                f"{self.label} returned an error instead of a reply: {words}"
                + (f" (code {code})" if code is not None else ""),
                retryable=True, rate_limited=str(code) == "429",
            )
        if isinstance(error, str) and error.strip():
            return ProviderError(f"{self.label} returned an error instead of a reply: {error.strip()}", retryable=True)
        return ProviderError(f"{self.label} returned an empty reply (no choices)", retryable=True)

    def _completion(self, body: Any, model: str, rung: Rung) -> Completion:
        if not isinstance(body, dict):
            raise ProviderError(f"{self.label} answered with {type(body).__name__}, not a completion", retryable=True)
        choices = body.get("choices")
        choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        error = body.get("error") or (choice or {}).get("error")
        if error or choice is None or choice.get("finish_reason") == "error":
            raise self._no_reply(error)
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        text = _content(message.get("content"))
        stop = choice.get("finish_reason")
        if not text.strip() and message.get("refusal"):
            stop = "refusal"
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        cost = usage.get("cost")
        billed = self.openrouter and isinstance(cost, (int, float)) and not isinstance(cost, bool)
        return Completion(
            text=visible_text(text),
            model=body["model"] if isinstance(body.get("model"), str) and body["model"] else model,
            tokens_in=_int(usage.get("prompt_tokens")),
            tokens_out=_int(usage.get("completion_tokens")),
            cost=float(cost) if billed else None,
            stop_reason=stop if isinstance(stop, str) else None,
            thinking_sent=rung.sent,
        )

    async def aclose(self) -> None:
        await self._http.aclose()
