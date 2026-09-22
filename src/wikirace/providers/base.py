"""What every provider hands the game, and what it raises.

A text provider turns one prompt into one `Completion`; the TypeSafe client
turns one request of typed questions into Jev's answers. Both raise
`ProviderError` when they could not answer at all, carrying what the race
engine needs to decide what happens next:

* `rate_limited`: the provider said "slow down" (HTTP 429). The engine waits
  it out, in plain sight, for up to about two minutes.
* `retryable`: an outage (a 5xx, a timeout, a dropped connection, an empty
  reply). The engine retries once, quickly.
* neither: final. A bad key, an unknown model, a request the provider refused.
  The racer stops, with the provider's own words.

A reply that names a link off the page is not an error: that is a foul, and
judging it is the game's job, not the provider's.
"""
from __future__ import annotations

import asyncio
import json
import re
from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import ProviderConfig, display_url


class ProviderError(RuntimeError):
    def __init__(
        self, message: str, *, retryable: bool = False, rate_limited: bool = False,
        retry_after: float | None = None, status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable or rate_limited
        self.rate_limited = rate_limited
        #: Seconds the provider asked to wait (Retry-After), when it said.
        self.retry_after = retry_after
        #: The HTTP status the provider answered with; None when there was no
        #: HTTP answer at all (a timeout, a refused connection) or none applies.
        self.status = status


@dataclass
class Completion:
    """One reply, and what it cost."""

    text: str
    #: The model that answered, as the provider names it; else the one asked for.
    model: str
    tokens_in: int = 0
    #: Output tokens, reasoning included wherever the provider bills it as output.
    tokens_out: int = 0
    #: USD the provider billed for this call, when it says (OpenRouter), else None
    #: and the game estimates from list prices.
    cost: float | None = None
    #: The provider's own stop reason: "end_turn", "stop", "length",
    #: "max_tokens", "refusal", ...
    stop_reason: str | None = None
    #: How the thinking level was actually sent, in the provider's own terms
    #: (`reasoning_effort=minimal`, `think=false`, `output_config.effort=high`),
    #: or None when nothing was sent. Shown on the move, because a level a model
    #: does not take is folded to one it does, and the person should see that.
    thinking_sent: str | None = None


@dataclass(frozen=True)
class ModelInfo:
    """A model a provider says it has (Ollama's /api/tags)."""

    model_id: str
    #: Whether it can think, when the provider says; None when unknown.
    thinks: bool | None = None
    #: Its longest context in tokens, when the provider says.
    context: int | None = None
    #: Anything else worth a tooltip ("9.7B · Q4_K_M").
    note: str = ""
    extra: Mapping[str, Any] = field(default_factory=dict)


def retry_after(headers: Mapping[str, str] | None) -> float | None:
    """Seconds a provider asked to wait: `retry-after-ms`, then `retry-after`.
    None when it did not say, or said it as an HTTP date."""
    for name, per_second in (("retry-after-ms", 1000.0), ("retry-after", 1.0)):
        try:
            seconds = float((headers or {}).get(name)) / per_second  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if seconds >= 0:
            return seconds
    return None


def status_error(
    provider: str, status: int, body: str, headers: Mapping[str, str] | None = None, *,
    hint: str | None = None,
) -> ProviderError:
    """The error for an HTTP failure, classified by status: 429 is a rate
    limit, 5xx (and TypeSafe's 529) an outage, anything else final. *hint* is
    the fix, in words a person can act on; it goes after the provider's own
    words, so a long body never cuts it off.

    A refused key (401) is told without the provider's words: OpenAI quotes
    the key it was sent, masked but in part, and this message is shown on the
    page and kept with the race. Anything else keyed-looking is masked too."""
    if status == 401:
        message = f"{provider} answered HTTP {status}: the key was refused"
    else:
        message = f"{provider} answered HTTP {status}: {scrub(' '.join(body.split()))[:300]}"
    return ProviderError(
        f"{message} — {hint}" if hint else message,
        retryable=status == 429 or status >= 500,
        rate_limited=status == 429,
        retry_after=retry_after(headers) if status == 429 else None,
        status=status,
    )


def fix_hint(config: ProviderConfig, status: int, model: str) -> str | None:
    """What to fix after a 401, 403 or 404, which no retry can: the key, or
    the model id (and the base URL, when it is not the provider's own)."""
    spec = config.spec
    if status == 401:
        return f"check {spec.key_env}"
    if status == 403:
        return f"the key in {spec.key_env} is not allowed to use {model}"
    if status == 404:
        hint = f"check the model id “{model}”"
        if config.base_url != spec.default_url:
            hint += f" and {spec.url_env} ({display_url(config.base_url)})"
        return hint
    return None


def error_detail(body: str) -> str:
    """The words in an error body, from the shapes these providers use:
    `{"error": {"message"}}` (OpenAI, OpenRouter, Anthropic), `{"error": "…"}`
    (Ollama) and `{"detail": …}` (TypeSafe, FastAPI's validation list). The
    body itself when it is none of them."""
    try:
        data = json.loads(body)
    except ValueError:
        return body.strip()
    if not isinstance(data, dict):
        return body.strip()
    err = data.get("error")
    if isinstance(err, str) and err.strip():
        return err.strip()
    if isinstance(err, dict):
        words = str(err.get("message") or err.get("type") or err.get("code") or "").strip()
        meta = err.get("metadata")
        if isinstance(meta, dict) and meta.get("raw"):
            # OpenRouter passes the upstream provider's own error along here.
            raw = meta["raw"] if isinstance(meta["raw"], str) else json.dumps(meta["raw"])
            who = meta.get("provider_name")
            words += f" [{who}: {raw}]" if who else f" [{raw}]"
        if words:
            return words
    detail = data.get("detail")
    if isinstance(detail, str) and detail.strip():
        return detail.strip()
    if isinstance(detail, list) and detail:
        parts = []
        for item in detail:
            if isinstance(item, dict):
                where = ".".join(str(p) for p in item.get("loc") or () if p != "body")
                parts.append(f"{where}: {item.get('msg')}" if where else str(item.get("msg")))
            else:
                parts.append(str(item))
        return "; ".join(parts)
    return body.strip()


def transport_error(provider: str, exc: BaseException, *, url: str | None = None,
                    timeout: float | None = None) -> ProviderError:
    """The error for a request that got no HTTP answer at all.

    A timeout or a dropped connection is an outage, worth the engine's one
    quick retry; a URL that is not a URL is final. Classified by the
    exception's name, so httpx's and the Anthropic SDK's httpx2 read alike.
    """
    name = type(exc).__name__
    shown = display_url(url) if url else ""
    where = f" at {shown}" if shown else ""
    text = scrub(str(exc).strip())
    if name in {"UnsupportedProtocol", "InvalidURL"}:
        return ProviderError(f"{provider}: {shown or 'the URL'} is not a usable URL ({text or name})")
    if name == "ConnectTimeout":
        return ProviderError(f"no {provider} answered{where}: timed out connecting", retryable=True)
    if "Timeout" in name:
        within = f" within {timeout:.0f}s" if timeout else ""
        return ProviderError(f"{provider} did not answer{where}{within}", retryable=True)
    if name == "ConnectError":
        low = text.lower()
        if "refused" in low or "all connection attempts failed" in low:
            why = "connection refused"
        elif "getaddrinfo" in low or "name or service not known" in low or "nodename nor servname" in low:
            why = "the host name did not resolve"
        else:
            why = text or name
        return ProviderError(f"no {provider} answered{where}: {why}", retryable=True)
    return ProviderError(f"{provider} connection failed{where} ({name}{': ' + text if text else ''})", retryable=True)


_USERINFO = re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^/@\s]+@", re.I)


#: What an API key looks like, when a provider quotes one back (masked, but in
#: part): OpenAI's and OpenRouter's `sk-…`, Anthropic's `sk-ant-…`.
_KEYLIKE = re.compile(r"\b(?:sk|tsk)[-_][A-Za-z0-9_*.\-]{4,}")


def scrub(text: str) -> str:
    """*text* without the credentials of any URL in it (`http://user:pw@host`)
    and without anything shaped like an API key."""
    return _KEYLIKE.sub("[a key]", _USERINFO.sub(r"\1", text))


def require_configured(config: ProviderConfig) -> None:
    """Raise the final error for a provider with no key (Ollama: no URL),
    naming the variable to set."""
    if not config.configured:
        raise ProviderError(f"{config.label} is not configured: {config.problem}")


_THINK_BLOCK = re.compile(r"<think>.*?</think>\s*", re.S | re.I)


def visible_text(text: str) -> str:
    """A reply without its inline reasoning. Some models and servers write
    their thinking into the text itself, `<think>…</think>` first (or only the
    closing tag, when the template opened it), and a reply cut off mid-thought
    has an opening tag and no close. The game reads the answer, not the
    thinking, so all of it goes."""
    if "think>" not in text.lower():
        return text
    text = _THINK_BLOCK.sub("", text)
    low = text.lower()
    if "</think>" in low:
        text = text[low.rindex("</think>") + len("</think>"):]
        low = text.lower()
    if "<think>" in low:
        text = text[: low.index("<think>")]
    return text.strip()


class LoopClient:
    """One keep-alive `httpx.AsyncClient` per event loop.

    A connection kept open is most of TypeSafe's speed: Jev answers in about a
    tenth of a second, and a fresh TLS handshake per question would double
    that. A client made on one loop cannot be awaited on another (the tests run
    many), so a new loop gets a new client. `transport` replaces the network,
    which is how the tests run.
    """

    def __init__(self, *, timeout: float, headers: Mapping[str, str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._timeout = timeout
        self._headers = dict(headers or {})
        self._transport = transport
        self._client: httpx.AsyncClient | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def get(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        if self._client is None or self._loop is not loop:
            self._client = httpx.AsyncClient(
                timeout=self._timeout, headers=self._headers, transport=self._transport,
            )
            self._loop = loop
        return self._client

    async def aclose(self) -> None:
        client, self._client, self._loop = self._client, None, None
        if client is not None:
            try:
                await client.aclose()
            except RuntimeError:  # its loop is gone; nothing left to close
                pass


class TextProvider(ABC):
    """A provider of models that answer in words."""

    def __init__(self, config: ProviderConfig) -> None:
        self.config = config

    @property
    def id(self) -> str:
        return self.config.id

    @property
    def label(self) -> str:
        return self.config.label

    @property
    def kind(self) -> str:
        return self.config.kind

    @abstractmethod
    async def complete(
        self, model: str, system: str, prompt: str, *,
        thinking: str | None, max_tokens: int, timeout: float,
    ) -> Completion:
        """One stateless turn: *system* as the system prompt, *prompt* as the
        one user message. *thinking* is a level from `config.THINKING_LEVELS`
        or None (send nothing: the model's default). Raises ProviderError."""

    async def discover(self) -> list[ModelInfo] | None:
        """The models the provider says it has, or None when it is not asked
        (the configured list is the roster). Raises ProviderError when it
        cannot be reached, so the page can say why."""
        return None

    def context_limit(self, model: str) -> int | None:
        """Prompt tokens a request to *model* can carry, when this provider
        must be told (Ollama); None when the model's own window applies."""
        return None

    async def aclose(self) -> None:
        return None
