"""TypeSafe: typed questions in, Jev's answers out.

Jev is a judgment model: it answers typed questions (`noul`, `choice`,
`score`) about a state with calibrated numbers, and writes no text. One
request is `POST {base_url}/systemone` with `{"state", "model", "questions"}`
and a bearer key; the reply is `{"model", "answers", "usage"}`, one answer per
question id. Input is $0.042 per million tokens and output is free.

Jev answers in about a tenth of a second, so the connection is kept alive
(`LoopClient`): a fresh TLS handshake per question would double a turn.

Nothing here retries; the race engine does. What an error means:

* 401: the key is wrong. Final.
* 422: the request is wrong (the API says which field). Final: sending it
  again cannot help.
* 429: a rate limit, with Retry-After when TypeSafe gives one.
* 529 (overloaded), any other 5xx, a timeout, a dropped connection: an
  outage, worth one quick retry.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

from ..config import ProviderConfig
from .base import (
    LoopClient,
    ProviderError,
    error_detail,
    require_configured,
    retry_after,
    status_error,
    transport_error,
)

#: Seconds for one request: Jev's own answer is sub-second; the rest is the way there.
TIMEOUT = 60.0


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


class TypeSafe:
    """The TypeSafe client. Not a TextProvider: Jev is asked questions, not
    prompted, and `ask` is its only call."""

    def __init__(self, config: ProviderConfig, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.config = config
        headers = {"Authorization": f"Bearer {config.api_key}"} if config.api_key else {}
        self._http = LoopClient(timeout=TIMEOUT, headers=headers, transport=transport)

    @property
    def id(self) -> str:
        return self.config.id

    @property
    def label(self) -> str:
        return self.config.label

    @property
    def kind(self) -> str:
        return self.config.kind  # "judgment"

    async def ask(
        self, model: str, state: Any, questions: Mapping[str, Any], *, timeout: float = TIMEOUT,
    ) -> dict[str, Any]:
        """One request: `{"model", "answers", "usage": {"input_tokens",
        "output_tokens"}}`, `answers` keyed by the question ids asked. Raises
        ProviderError."""
        require_configured(self.config)
        url = f"{self.config.base_url}/systemone"
        try:
            resp = await self._http.get().post(
                url, json={"state": state, "model": model, "questions": dict(questions)}, timeout=timeout,
            )
        except (httpx.HTTPError, httpx.InvalidURL) as exc:
            raise transport_error("TypeSafe", exc, url=self.config.base_url, timeout=timeout) from exc
        status = resp.status_code
        if status == 401:
            raise ProviderError(
                f"TypeSafe refused the key (HTTP 401): check {self.config.spec.key_env}", status=status,
            )
        if status == 422:
            raise ProviderError(
                f"TypeSafe refused the request (HTTP 422): {error_detail(resp.text)[:500]}", status=status,
            )
        if status == 429:
            raise ProviderError(
                f"TypeSafe is rate limiting (HTTP 429): {error_detail(resp.text)[:200]}",
                rate_limited=True, retry_after=retry_after(resp.headers), status=status,
            )
        if status == 529:
            raise ProviderError("TypeSafe is overloaded (HTTP 529)", retryable=True, status=status)
        if status != 200:
            raise status_error("TypeSafe", status, error_detail(resp.text), resp.headers)
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderError(
                f"TypeSafe answered with something that is not JSON: {resp.text[:200]!r}", retryable=True,
            ) from exc
        answers = body.get("answers") if isinstance(body, dict) else None
        if not isinstance(answers, dict):
            raise ProviderError("TypeSafe answered without an `answers` map", retryable=True)
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        return {
            "model": body["model"] if isinstance(body.get("model"), str) and body["model"] else model,
            "answers": answers,
            "usage": {"input_tokens": _int(usage.get("input_tokens")),
                      "output_tokens": _int(usage.get("output_tokens"))},
        }

    async def discover(self) -> None:
        """TypeSafe's roster is the configured one (`TYPESAFE_MODELS`)."""
        return None

    async def aclose(self) -> None:
        await self._http.aclose()
