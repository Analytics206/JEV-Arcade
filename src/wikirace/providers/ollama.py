"""Ollama: its native `/api/chat` and `/api/tags`.

Not Ollama's OpenAI-compatible endpoint, which cannot set the context window.
Ollama's default window is small enough to cut a big article's link list, and
the rules with it, without a word; so every request sets `options.num_ctx`
(OLLAMA_NUM_CTX), and `context_limit` tells the game how much fits.

A chat is one `POST /api/chat` with `stream: false`, the output capped by
`options.num_predict` (thinking counts against it), and a `keep_alive` long
enough that a race does not reload the model between turns. The answer is
`message.content`; `message.thinking` is the working and is left out, as is
any `<think>` block a model writes inline. Tokens are `prompt_eval_count` and
`eval_count`, the stop reason is `done_reason`, and the cost is nothing.

**Thinking** is the `think` field (checked against Ollama 0.32.4):

* `none` is `think: false`. gpt-oss ignores booleans and takes only
  low/medium/high, so it gets `low`, the least it takes.
* A level is the level string (`low`, `medium`, `high`, `max`; `xhigh` folds
  to `high`, and `max` does too on gpt-oss). An Ollama that predates level
  strings answers 400 "invalid think value", and `true` goes instead.
* A model that cannot think answers any `think` but false with 400 "does not
  support thinking"; then nothing is sent. Once `discover()` has said which
  models think, a model that cannot is sent nothing from the start.

`discover()` lists `GET /api/tags`: the models whose capabilities include
"completion" (all of them, from an Ollama too old to say), with whether each
thinks, its longest context and a note like "9.7B · Q4_K_M".
"""
from __future__ import annotations

from typing import Any

import httpx

from ..config import THINKING_LEVELS, ProviderConfig
from .base import (
    Completion,
    LoopClient,
    ModelInfo,
    ProviderError,
    TextProvider,
    error_detail,
    require_configured,
    status_error,
    transport_error,
    visible_text,
)
from .ladder import NOTHING, Ladder, Rung

#: How long Ollama keeps a model loaded after a turn: longer than the slowest
#: racer's turn, so a race never waits on a reload.
KEEP_ALIVE = "15m"
#: `/api/tags` is a quick question; an Ollama that has not answered in this
#: long is not going to race.
DISCOVER_TIMEOUT = 10.0

_LEVELS = {"low": "low", "medium": "medium", "high": "high", "xhigh": "high", "max": "max"}


def _think(value: bool | str) -> Rung:
    shown = str(value).lower() if isinstance(value, bool) else value
    return Rung(f"think={shown}", {"think": value}, ("think",))


def rungs(model: str, level: str | None, thinks: bool | None = None) -> list[Rung]:
    """The ways of sending *level* to *model*; *thinks* is what discovery said
    about it (None: not asked)."""
    if level is None or thinks is False:
        return [NOTHING]
    gpt_oss = "gpt-oss" in model.lower()
    if level == "none":
        return [_think("low" if gpt_oss else False), NOTHING]
    value = "high" if gpt_oss and level in {"xhigh", "max"} else _LEVELS[level]
    if gpt_oss:  # booleans are ignored there: a level or nothing
        return [_think(value), NOTHING]
    return [_think(value), _think(True), NOTHING]


def _refused(exc: ProviderError, rung: Rung, rest: list[Rung]) -> list[Rung] | None:
    if exc.status != 400 or not rung.params:
        return None
    text = str(exc).lower()
    if "does not support thinking" in text:
        return [NOTHING]  # no spelling of `think` will do
    return rest if "think" in text else None


def _note(details: dict[str, Any]) -> str:
    return " · ".join(str(details[k]) for k in ("parameter_size", "quantization_level") if details.get(k))


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def tagged(model: str) -> str:
    """Ollama's own name for *model*: `llama3.2` is `llama3.2:latest`, which is
    how /api/tags lists it."""
    return model if ":" in model.rsplit("/", 1)[-1] else f"{model}:latest"


#: Characters per token when sizing a reply to fit the window: low on purpose,
#: as in the game's own estimate (race/rules.py).
_CHARS_PER_TOKEN = 3.0
#: The least a reply is given, however full the window: two lines.
_MIN_PREDICT = 256


class OllamaProvider(TextProvider):
    def __init__(self, config: ProviderConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(config)
        # Only an Ollama behind auth (a proxy, a hosted one) wants a key.
        headers = {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}
        self._http = LoopClient(timeout=300.0, headers=headers, transport=transport)
        self._ladder = Ladder()
        #: What discovery said, by Ollama's tagged name: it can think; its
        #: longest context.
        self._thinks: dict[str, bool] = {}
        self._context: dict[str, int] = {}

    def context_limit(self, model: str) -> int | None:
        """OLLAMA_NUM_CTX, or the model's own longest context when that is
        shorter: a window past what the model was built for is no window."""
        known = self._context.get(tagged(model))
        return min(self.config.num_ctx, known) if known else self.config.num_ctx

    async def _request(self, method: str, path: str, *, timeout: float, **kwargs: Any) -> httpx.Response:
        try:
            return await self._http.get().request(method, f"{self.config.base_url}{path}", timeout=timeout, **kwargs)
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise transport_error("Ollama", exc, url=self.config.base_url, timeout=timeout) from exc

    def _http_error(self, resp: httpx.Response, model: str | None) -> ProviderError:
        status = resp.status_code
        hint = None
        if status == 404 and model:
            hint = f"pull it first: ollama pull {model}"
        elif status in (401, 403):
            hint = f"check {self.config.spec.key_env}"
        return status_error("Ollama", status, error_detail(resp.text), resp.headers, hint=hint)

    async def complete(
        self, model: str, system: str, prompt: str, *,
        thinking: str | None, max_tokens: int, timeout: float,
    ) -> Completion:
        require_configured(self.config)
        if thinking is not None and thinking not in THINKING_LEVELS:
            raise ProviderError(f"unknown thinking level “{thinking}”")

        async def call(rung: Rung) -> Completion:
            return await self._chat(model, system, prompt, rung, max_tokens, timeout)

        def refused(exc: ProviderError, rung: Rung, rest: list[Rung]) -> list[Rung] | None:
            nxt = _refused(exc, rung, rest)
            if nxt == [NOTHING] and "does not support thinking" in str(exc).lower():
                self._thinks[tagged(model)] = False  # for every level, not just this one
            return nxt

        ladder = rungs(model, thinking, self._thinks.get(tagged(model)))
        return await self._ladder.climb((model, thinking), ladder, call, refused)

    async def _chat(
        self, model: str, system: str, prompt: str, rung: Rung, max_tokens: int, timeout: float,
    ) -> Completion:
        messages = [{"role": "system", "content": system}] if system else []
        messages.append({"role": "user", "content": prompt})
        # The window holds the prompt AND the reply. A reply allowed to run on
        # past it makes Ollama drop the front of the prompt to go on, and the
        # front is the rules; so the reply gets what the prompt leaves.
        ctx = self.context_limit(model) or self.config.num_ctx
        prompt_tokens = int((len(system) + len(prompt)) / _CHARS_PER_TOKEN) + 1
        predict = max(_MIN_PREDICT, min(max_tokens, ctx - prompt_tokens))
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": False,
            "options": {"num_ctx": ctx, "num_predict": predict},
            "keep_alive": KEEP_ALIVE,
            **rung.params,
        }
        resp = await self._request("POST", "/api/chat", timeout=timeout, json=payload)
        if resp.status_code != 200:
            raise self._http_error(resp, model)
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderError(f"Ollama answered with something that is not JSON: {resp.text[:200]!r}",
                                retryable=True) from exc
        if not isinstance(body, dict) or not isinstance(body.get("message"), dict):
            error = body.get("error") if isinstance(body, dict) else None
            raise ProviderError(f"Ollama returned no message{f': {error}' if error else ''}", retryable=True)
        content = body["message"].get("content")
        stop = body.get("done_reason")
        return Completion(
            text=visible_text(content if isinstance(content, str) else ""),
            model=body["model"] if isinstance(body.get("model"), str) and body["model"] else model,
            tokens_in=_int(body.get("prompt_eval_count")),
            tokens_out=_int(body.get("eval_count")),
            cost=0.0,
            stop_reason=stop if isinstance(stop, str) and stop else None,
            thinking_sent=rung.sent,
        )

    async def discover(self) -> list[ModelInfo]:
        """The models this Ollama can chat with. Raises ProviderError, naming
        the URL, when it cannot be reached."""
        require_configured(self.config)
        resp = await self._request("GET", "/api/tags", timeout=DISCOVER_TIMEOUT)
        if resp.status_code != 200:
            raise self._http_error(resp, None)
        try:
            listed = resp.json().get("models") or []
        except (ValueError, AttributeError) as exc:
            raise ProviderError(f"Ollama at {self.config.shown_url} answered /api/tags with no model list",
                                retryable=True) from exc
        out: list[ModelInfo] = []
        for entry in listed:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name") or entry.get("model")
            if not isinstance(name, str) or not name:
                continue
            caps = entry.get("capabilities")
            if isinstance(caps, list) and "completion" not in caps:
                continue  # an embedding model: it cannot chat
            details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
            thinks = "thinking" in caps if isinstance(caps, list) else None
            if thinks is not None:
                self._thinks[tagged(name)] = thinks
            context = details.get("context_length")
            if isinstance(context, int) and context > 0:
                self._context[tagged(name)] = context
            out.append(ModelInfo(
                model_id=name,
                thinks=thinks,
                context=context if isinstance(context, int) and context > 0 else None,
                note=_note(details),
                extra={"capabilities": list(caps) if isinstance(caps, list) else None,
                       "family": details.get("family")},
            ))
        return out

    async def aclose(self) -> None:
        await self._http.aclose()
