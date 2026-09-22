"""One adapter per kind of racer. Each turns a `Turn` into a `Choice`.

* **TextRacer**: any model of a text provider (Anthropic, OpenAI, OpenRouter,
  Ollama). It reads the rules and the page's links and replies `REASON:` /
  `LINK:` in free text, which is exactly what lets it foul: it can name a link
  that is not there.
* **JevRacer**: TypeSafe Jev, a judgment model. It writes no text, so it cannot
  be asked for a title; it is asked which of the page's links to click to reach
  the target (the target itself when the page links it), as a probability over
  the links themselves. It can never name an off-page link: its moves are
  always legal, and what the race measures is whether its judgment finds a
  path. It also never doubles back: visited articles, links it already
  followed and dead links are left out of its options, because a ranker with
  no memory of its own would otherwise shuttle between two pages (or retry a
  dead link) until the hop limit.

A racer raises `RacerError` when it could not produce a move at all (a missing
key, a provider that refused the request) as distinct from a move that is a
foul, which is a `Choice` like any other.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field, replace
from typing import Any

from ..providers.base import ProviderError, TextProvider
from . import rules
from .rules import Turn
from .wiki import fold


class RacerError(RuntimeError):
    def __init__(
        self, message: str, *, retryable: bool = False, rate_limited: bool = False,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.retryable = retryable or rate_limited
        #: The provider said "slow down" (HTTP 429) rather than "broken": worth
        #: waiting out for longer than an outage's one quick retry.
        self.rate_limited = rate_limited
        #: Seconds the provider asked to wait (Retry-After), when it said.
        self.retry_after = retry_after

    @classmethod
    def of(cls, exc: ProviderError, prefix: str = "") -> RacerError:
        return cls(
            f"{prefix}{exc}", retryable=exc.retryable, rate_limited=exc.rate_limited,
            retry_after=exc.retry_after,
        )


class DeadEnd(RacerError):
    """No move is left that is not a way back: the racer is out of the race
    (did not finish), not in error, and it did not foul."""


@dataclass
class Choice:
    """One turn's answer, and what it cost."""

    claimed: str | None
    reason: str = ""
    variants: tuple[str, ...] = ()
    raw: str = ""
    tokens_in: int = 0
    tokens_out: int = 0
    cost: float | None = None
    cost_estimated: bool = False
    latency_ms: int = 0
    detail: dict[str, Any] = field(default_factory=dict)


# ── Text models ──────────────────────────────────────────────────────────────

#: Output headroom. The answer is two lines, but a model that thinks spends its
#: thinking against this ceiling too, and a small one (the usual 4,096) can run
#: out before the answer is written.
TEXT_MAX_TOKENS = 16_000
#: A thinking model on a 4,000-link page is a long read.
TEXT_TIMEOUT = 300.0
#: Normal ends of a reply; anything else (a length cut, a refusal) is noted on
#: the move, because the reply is then not what it seems.
_NORMAL_STOPS = frozenset({"end_turn", "stop", "stop_sequence"})


def _reply_room(context: int, thinking: str | None) -> int:
    """Tokens kept free for the reply when a window has to be fitted: two lines
    need little, but a model that thinks writes its thinking there first."""
    return 1024 if thinking == "none" else max(2048, context // 4)


class TextRacer:
    kind = "text"

    def __init__(
        self, *, provider: TextProvider, model_id: str, thinking: str | None,
        max_tokens: int = TEXT_MAX_TOKENS, timeout: float = TEXT_TIMEOUT,
    ) -> None:
        self.provider = provider
        self.model_id = model_id
        self.thinking = thinking
        self.max_tokens = max_tokens
        self.timeout = timeout

    async def choose(self, turn: Turn) -> Choice:
        detail: dict[str, Any] = {}
        context = self.provider.context_limit(self.model_id)
        if context:
            # A window the provider must be told (Ollama) silently drops what
            # does not fit, from the front: the rules first. So the racer is
            # shown the links that fit instead, in reading order, and says so.
            shown = len(rules.shown_links(turn.page, turn.max_links))
            fit = rules.links_that_fit(turn, context - _reply_room(context, self.thinking))
            if fit < shown:
                turn = replace(turn, max_links=fit)
                detail["links_shown"] = fit
        prompt = rules.turn_prompt(turn)
        started = time.monotonic()
        try:
            comp = await self.provider.complete(
                self.model_id, rules.SYSTEM_PROMPT, prompt,
                thinking=self.thinking, max_tokens=self.max_tokens, timeout=self.timeout,
            )
        except ProviderError as exc:
            raise RacerError.of(exc) from exc
        latency = int((time.monotonic() - started) * 1000)

        t_in, t_out = int(comp.tokens_in or 0), int(comp.tokens_out or 0)
        if not (comp.text or "").strip() and not t_out:
            # Nothing generated at all: OpenRouter answers an upstream failure
            # with a 200 and no choices. The provider failed, not the racer, and
            # a strike here would be a foul for someone else's outage.
            raise RacerError(f"{self.provider.config.label} returned an empty reply", retryable=True)
        reply = rules.parse_reply(comp.text)
        cost, estimated = comp.cost, False
        if cost is None:
            cost = rules.estimate_cost(self.model_id, t_in, t_out)
            estimated = cost is not None
        if comp.stop_reason and comp.stop_reason not in _NORMAL_STOPS:
            detail["stop_reason"] = comp.stop_reason
        if comp.thinking_sent:
            detail["thinking_sent"] = comp.thinking_sent
        return Choice(
            claimed=reply.claimed, reason=reply.reason, variants=reply.variants,
            raw=(comp.text or "")[-800:], tokens_in=t_in, tokens_out=t_out,
            cost=cost, cost_estimated=estimated, latency_ms=latency, detail=detail,
        )


# ── Jev ──────────────────────────────────────────────────────────────────────


class JevRacer:
    kind = "judgment"

    def __init__(self, *, client: Any, model_id: str) -> None:
        #: Anything with TypeSafe's `ask(model, state, questions)`.
        self.client = client
        self.model_id = model_id

    async def _question(self, state: dict[str, Any], questions: dict[str, Any]) -> dict[str, Any]:
        try:
            return await self.client.ask(self.model_id, state, questions)
        except ProviderError as exc:
            raise RacerError.of(exc, "Jev: ") from exc

    @staticmethod
    def _ranked(answer: dict[str, Any], ids: dict[str, str]) -> list[tuple[str, float]]:
        probs = answer.get("probabilities") or {}
        # Probabilities keyed by anything but our option ids would sort on
        # zeros and still look like a ranking. Refuse instead.
        if set(probs) != set(ids):
            raise RacerError("Jev answered about options it was not given")
        order = sorted(ids, key=lambda oid: -float(probs[oid]))
        return [(ids[oid], float(probs[oid])) for oid in order]

    async def choose(self, turn: Turn) -> Choice:
        # Never offered: an article already on the path, a link already followed
        # (the name it went by then: "USA" as well as "United States"), or a
        # link found dead on this article. A ranker asks the same question the
        # same way every time, so without this it would pick them again.
        seen = {fold(t) for t in (*turn.path, *turn.excluded)}
        options = [link for link in rules.shown_links(turn.page, turn.max_links) if fold(link) not in seen]
        if not options:
            # Not a foul: Jev never names anything off the page. It is simply
            # stuck, and a strike per turn would only disqualify it slowly.
            raise DeadEnd(f"no way forward: every link on “{turn.page.title}” leads back to "
                          "an article already visited")
        if len(options) == 1:
            return Choice(claimed=options[0], reason="the only link left that is not a way back",
                          variants=(options[0],), raw="")
        state = rules.jev_state(turn)
        started = time.monotonic()
        tokens = asks = rounds = 0
        pool = options
        if len(pool) > rules.JEV_MAX_OPTIONS:
            # Too many for one question: every piece is asked at once, and the
            # best of each go on to one final question over the whole field.
            rounds += 1
            chunks = rules.chunked(pool, rules.JEV_MAX_OPTIONS)
            keep = rules.jev_keep(len(chunks))
            questions: dict[str, Any] = {}
            idmaps: dict[str, dict[str, str]] = {}
            for n, chunk in enumerate(chunks):
                q, ids = rules.jev_question(chunk, f"{turn.page.title}|{turn.target}|{n}")
                questions[f"c{n}"], idmaps[f"c{n}"] = q, ids
            batches = rules.chunked(list(questions.items()), rules.JEV_PER_ASK)
            tasks = [asyncio.ensure_future(self._question(state, dict(b))) for b in batches]
            try:
                answers = await asyncio.gather(*tasks)
            except BaseException:
                # One request failed (a rate limit, say): the turn is over, so
                # the rest are called off rather than left to run, and bill,
                # while the engine waits to try the turn again.
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise
            asks += len(batches)
            pool = []
            for body in answers:
                tokens += int((body.get("usage") or {}).get("input_tokens") or 0)
                for qid, answer in body["answers"].items():
                    if qid in idmaps:
                        pool += [title for title, _ in self._ranked(answer, idmaps[qid])[:keep]]
            if not pool:
                raise RacerError("Jev answered none of the questions it was asked")
        rounds += 1
        q, ids = rules.jev_question(pool, f"{turn.page.title}|{turn.target}|final")
        body = await self._question(state, {"final": q})
        asks += 1
        tokens += int((body.get("usage") or {}).get("input_tokens") or 0)
        final = body["answers"].get("final") or {}
        ranked = self._ranked(final, ids)
        latency = int((time.monotonic() - started) * 1000)

        top, p_top = ranked[0]
        confidence = float(final.get("confidence") or 0.0)
        runners = ranked[1:3]
        reason = f"Top of {len(options):,} links (p {p_top:.2f}, confidence {confidence:.2f})"
        if runners:
            reason += "; next: " + ", ".join(f"{t} ({p:.2f})" for t, p in runners)
        return Choice(
            claimed=top, reason=reason, variants=(top,), raw=reason,
            tokens_in=tokens, tokens_out=0,
            cost=tokens * rules.JEV_INPUT_PER_MTOK / 1_000_000, cost_estimated=True,
            latency_ms=latency,
            detail={
                "confidence": confidence, "options": len(options), "rounds": rounds, "asks": asks,
                "model": body.get("model") or self.model_id,
                "top": [{"title": t, "p": round(p, 4)} for t, p in ranked[:5]],
            },
        )
