"""The racers: a text model through any provider, and Jev.

* **A text racer asks with room to think.** A model that thinks spends its
  thinking against max_tokens; a small ceiling can run out before the two-line
  answer is written.
* **A window that must be named is fitted, not overflowed.** Ollama cuts an
  overlong prompt from the front, rules first, without an error, so a page too
  big for the window is shown as the links that fit, and the move says so.
* **Jev chooses among the page's own links, and only those.** Its answer is a
  probability per option, under opaque ids; an answer about options it was not
  given is refused rather than sorted on zeros.
"""
from __future__ import annotations

import asyncio

import pytest

from wikirace.config import load_settings
from wikirace.providers.base import Completion, ProviderError, TextProvider, status_error
from wikirace.race import rules
from wikirace.race.racers import DeadEnd, JevRacer, RacerError, TextRacer
from wikirace.race.rules import Turn
from wikirace.race.wiki import Page

SETTINGS = load_settings({"ANTHROPIC_API_KEY": "k", "OPENAI_API_KEY": "k", "OPENROUTER_API_KEY": "k"},
                         read_file=False)


def _turn(links, path=("Start",), **kw) -> Turn:
    page = Page(title=path[-1], description="", lead="", links=tuple(links))
    return Turn(target="Amazon rainforest", target_description="Rainforest", page=page,
                hop=len(path), max_hops=12, path=tuple(path), **kw)


def _run(coro):
    return asyncio.run(coro)


class FakeProvider(TextProvider):
    """Answers with a scripted Completion, or raises a scripted error."""

    def __init__(self, provider: str = "anthropic", reply: Completion | Exception | None = None,
                 context: int | None = None) -> None:
        super().__init__(SETTINGS.providers[provider])
        self.reply = reply or Completion(text="REASON: south.\nLINK: Brazil", model="m",
                                         tokens_in=1000, tokens_out=20, stop_reason="end_turn")
        self.context = context
        self.calls: list[dict] = []

    async def complete(self, model, system, prompt, *, thinking, max_tokens, timeout):
        self.calls.append({"model": model, "system": system, "prompt": prompt, "thinking": thinking,
                           "max_tokens": max_tokens, "timeout": timeout})
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply

    def context_limit(self, model):
        return self.context


# ── Text racers ───────────────────────────────────────────────────────────────


def test_a_text_racer_asks_with_room_to_think_and_reads_the_reply():
    fake = FakeProvider()
    choice = _run(TextRacer(provider=fake, model_id="claude-opus-5", thinking="low").choose(_turn(["Brazil", "Peru"])))
    assert choice.claimed == "Brazil" and choice.reason == "south."
    call = fake.calls[0]
    assert call["system"] == rules.SYSTEM_PROMPT and call["model"] == "claude-opus-5"
    assert call["max_tokens"] == 16_000 and call["thinking"] == "low"
    assert "LINKS ON THIS ARTICLE (2):" in call["prompt"]
    # Anthropic reports no cost: estimated at list price, and marked so.
    assert choice.cost == pytest.approx((1000 * 5 + 20 * 25) / 1_000_000)
    assert choice.cost_estimated is True
    assert choice.detail == {}


def test_a_billed_cost_is_kept_and_an_odd_stop_is_recorded():
    fake = FakeProvider("openrouter", Completion(text="LINK: Peru", model="x/y", tokens_in=10, tokens_out=5,
                                                 cost=0.0042, stop_reason="length"))
    choice = _run(TextRacer(provider=fake, model_id="x/y", thinking=None).choose(_turn(["Peru"])))
    assert choice.cost == 0.0042 and choice.cost_estimated is False
    assert choice.detail == {"stop_reason": "length"}


def test_what_was_sent_for_thinking_rides_on_the_move():
    fake = FakeProvider("openai", Completion(text="LINK: Peru", model="gpt-5", tokens_in=10, tokens_out=5,
                                             stop_reason="stop", thinking_sent="reasoning_effort=minimal"))
    choice = _run(TextRacer(provider=fake, model_id="gpt-5", thinking="none").choose(_turn(["Peru"])))
    assert choice.detail == {"thinking_sent": "reasoning_effort=minimal"}


def test_an_openai_racer_is_priced_at_list_price_thinking_included():
    # OpenAI's shape: no cost, and o3's hidden reasoning counted in the output.
    fake = FakeProvider("openai", Completion(text="REASON: south.\nLINK: Brazil", model="o3",
                                             tokens_in=30_000, tokens_out=2_000, stop_reason="stop"))
    choice = _run(TextRacer(provider=fake, model_id="o3", thinking="high").choose(_turn(["Brazil"])))
    assert choice.cost == pytest.approx((30_000 * 2.00 + 2_000 * 8.00) / 1_000_000)
    assert choice.cost_estimated is True


def test_a_local_model_costs_nothing_and_says_so_exactly():
    fake = FakeProvider("ollama", Completion(text="LINK: Peru", model="qwen3.5:4b", tokens_in=900,
                                             tokens_out=40, cost=0.0, stop_reason="stop"))
    choice = _run(TextRacer(provider=fake, model_id="qwen3.5:4b", thinking=None).choose(_turn(["Peru"])))
    assert choice.cost == 0.0 and choice.cost_estimated is False


def test_an_empty_reply_with_nothing_generated_is_the_providers_failure_not_a_foul():
    # OpenRouter's shape for an upstream failure: a 200 with no choices.
    fake = FakeProvider("openrouter", Completion(text="", model="x/y"))
    with pytest.raises(RacerError) as exc:
        _run(TextRacer(provider=fake, model_id="x/y", thinking=None).choose(_turn(["A"])))
    assert exc.value.retryable and "empty reply" in str(exc.value)


def test_a_model_that_thought_and_named_nothing_is_a_no_pick():
    fake = FakeProvider(reply=Completion(text="", model="claude-opus-5", tokens_in=900, tokens_out=16000,
                                         stop_reason="max_tokens"))
    choice = _run(TextRacer(provider=fake, model_id="claude-opus-5", thinking="max").choose(_turn(["A"])))
    assert choice.claimed is None and choice.detail == {"stop_reason": "max_tokens"}


@pytest.mark.parametrize(("status", "retryable"), [(429, True), (503, True), (400, False), (401, False)])
def test_provider_errors_become_racer_errors(status, retryable):
    fake = FakeProvider("openai", status_error("OpenAI", status, "context too long"))
    with pytest.raises(RacerError) as exc:
        _run(TextRacer(provider=fake, model_id="o3", thinking=None).choose(_turn(["A"])))
    assert exc.value.retryable is retryable
    # Only a 429 is a rate limit to wait out; a 503 gets an outage's one quick retry.
    assert exc.value.rate_limited is (status == 429)
    assert f"HTTP {status}" in str(exc.value)
    # The provider's own words ride along, except for a refused key: those can quote it.
    assert ("context too long" in str(exc.value)) is (status != 401)


@pytest.mark.parametrize(("headers", "wait"), [
    ({"retry-after": "20"}, 20.0),
    ({"retry-after-ms": "1500", "retry-after": "2"}, 1.5),
    ({}, None),
    ({"retry-after": "Wed, 23 Sep 2026 07:28:00 GMT"}, None),
])
def test_a_rate_limit_carries_the_wait_the_provider_asked_for(headers, wait):
    fake = FakeProvider("openai", status_error("OpenAI", 429, "slow down", headers))
    with pytest.raises(RacerError) as exc:
        _run(TextRacer(provider=fake, model_id="m", thinking=None).choose(_turn(["A"])))
    assert exc.value.rate_limited and exc.value.retry_after == wait


# ── A window that has to be named ─────────────────────────────────────────────


def test_a_page_too_big_for_the_window_shows_the_links_that_fit_and_says_so():
    links = [f"A rather long link title number {i}" for i in range(3000)]
    fake = FakeProvider("ollama", Completion(text="LINK: A rather long link title number 7", model="q",
                                             tokens_in=1, tokens_out=1, cost=0.0), context=8192)
    choice = _run(TextRacer(provider=fake, model_id="q", thinking="none").choose(_turn(links)))
    shown = choice.detail["links_shown"]
    assert 50 < shown < 3000
    prompt = fake.calls[0]["prompt"]
    assert f"the first {shown:,} of 3,000, in reading order" in prompt
    # The whole prompt, rules included, fits what is left after the reply's room.
    assert rules.estimate_tokens(rules.SYSTEM_PROMPT + prompt) <= 8192 - 1024
    assert "A rather long link title number 2999" not in prompt


def test_a_thinking_model_is_left_more_room_to_think():
    links = [f"Link {i}" for i in range(3000)]
    quiet, thoughtful = FakeProvider("ollama", context=8192), FakeProvider("ollama", context=8192)
    a = _run(TextRacer(provider=quiet, model_id="q", thinking="none").choose(_turn(links)))
    b = _run(TextRacer(provider=thoughtful, model_id="q", thinking="high").choose(_turn(links)))
    assert b.detail["links_shown"] < a.detail["links_shown"]


def test_a_page_that_fits_is_shown_whole_and_nothing_is_said():
    fake = FakeProvider("ollama", context=16384)
    choice = _run(TextRacer(provider=fake, model_id="q", thinking=None).choose(_turn(["Brazil", "Peru"])))
    assert "links_shown" not in choice.detail
    assert "LINKS ON THIS ARTICLE (2):" in fake.calls[0]["prompt"]


# ── Jev ───────────────────────────────────────────────────────────────────────


class FakeJev:
    """Answers every choice question in favour of one title."""

    def __init__(self, favourite: str) -> None:
        self.favourite = favourite
        self.asks: list[dict] = []

    async def ask(self, model, state, questions, *, timeout=60.0):
        self.asks.append({"model": model, "state": state, "questions": questions})
        answers = {}
        for qid, q in questions.items():
            ids = q["criteria"]
            best = next((oid for oid, t in ids.items() if t == self.favourite), None)
            probs = {oid: (0.9 if oid == best else 0.1 / max(len(ids) - 1, 1)) for oid in ids}
            if best is None:
                first = sorted(ids)[0]
                probs = {oid: (0.5 if oid == first else 0.5 / max(len(ids) - 1, 1)) for oid in ids}
            answers[qid] = {"type": "choice", "probabilities": probs, "confidence": 0.8}
        return {"model": model, "answers": answers, "usage": {"input_tokens": 100, "output_tokens": 0}}


class Scripted:
    def __init__(self, fn) -> None:
        self.ask = fn


def test_jev_on_a_small_page_asks_once():
    fake = FakeJev("Brazil")
    choice = _run(JevRacer(client=fake, model_id="jev-1.13.0").choose(_turn(["Peru", "Brazil", "Chile"])))
    assert choice.claimed == "Brazil"
    assert len(fake.asks) == 1 and list(fake.asks[0]["questions"]) == ["final"]
    assert fake.asks[0]["model"] == "jev-1.13.0"
    # It reads where it is and where it is going, under the names its question uses.
    assert fake.asks[0]["state"] == {
        "current_article": "Start", "target_article": "Amazon rainforest", "target_description": "Rainforest",
    }
    assert choice.detail["top"][0]["title"] == "Brazil"
    assert choice.cost == pytest.approx(100 * rules.JEV_INPUT_PER_MTOK / 1_000_000)
    assert choice.tokens_out == 0


def test_one_question_holds_a_page_of_up_to_255_links():
    links = [f"Link {i}" for i in range(rules.JEV_MAX_OPTIONS)]
    fake = FakeJev("Link 187")
    choice = _run(JevRacer(client=fake, model_id="j").choose(_turn(links)))
    assert choice.claimed == "Link 187"
    assert len(fake.asks) == 1
    assert len(fake.asks[0]["questions"]["final"]["criteria"]) == rules.JEV_MAX_OPTIONS
    assert choice.detail["rounds"] == 1


def test_jev_splits_a_bigger_page_and_judges_the_best_of_every_piece_together():
    links = [f"Link {i}" for i in range(600)]
    fake = FakeJev("Link 487")
    choice = _run(JevRacer(client=fake, model_id="jev-1.13.0").choose(_turn(links)))
    assert choice.claimed == "Link 487"
    # Three pieces of 200 in ONE request; then one final over 85 from each.
    assert len(fake.asks) == 2
    first = fake.asks[0]["questions"]
    assert [len(q["criteria"]) for q in first.values()] == [200, 200, 200]
    assert len(fake.asks[1]["questions"]["final"]["criteria"]) == 255
    assert choice.detail["rounds"] == 2 and choice.detail["options"] == 600
    assert choice.tokens_in == 200


def test_a_page_of_thousands_takes_two_rounds_and_no_more():
    links = [f"Link {i}" for i in range(2300)]
    fake = FakeJev("Link 2222")
    choice = _run(JevRacer(client=fake, model_id="j").choose(_turn(links)))
    assert choice.claimed == "Link 2222"
    # Ten pieces, too many for one request: five and five, sent together; then the final.
    assert [len(a["questions"]) for a in fake.asks] == [5, 5, 1]
    assert len(fake.asks[2]["questions"]["final"]["criteria"]) == 250  # 25 from each
    assert choice.detail["rounds"] == 2 and choice.detail["asks"] == 3


def test_jev_never_doubles_back():
    fake = FakeJev("Start")
    choice = _run(JevRacer(client=fake, model_id="j").choose(_turn(["Start", "Peru", "Chile"], path=("Start", "Middle"))))
    offered = set(fake.asks[0]["questions"]["final"]["criteria"].values())
    assert offered == {"Peru", "Chile"} and choice.claimed in offered


def test_jev_skips_dead_links_and_links_it_already_followed():
    fake = FakeJev("x")
    turn = _turn(["USA", "Peru", "Chile", "Dead End"], path=("Start", "United States"),
                 excluded=("Dead End", "USA"))
    _run(JevRacer(client=fake, model_id="j").choose(turn))
    assert set(fake.asks[0]["questions"]["final"]["criteria"].values()) == {"Peru", "Chile"}


def test_jev_with_one_way_forward_takes_it_without_asking():
    fake = FakeJev("x")
    choice = _run(JevRacer(client=fake, model_id="j").choose(_turn(["Start", "Peru"], path=("Start", "Middle"))))
    assert choice.claimed == "Peru" and fake.asks == []


def test_an_answer_about_other_options_is_refused():
    async def ask(model, state, questions):
        return {"answers": {"final": {"probabilities": {"zz": 1.0}, "confidence": 1.0}}}

    with pytest.raises(RacerError, match="not given"):
        _run(JevRacer(client=Scripted(ask), model_id="j").choose(_turn(["Peru", "Chile"])))


def test_a_jev_error_is_a_racer_error_that_keeps_what_it_was():
    async def ask(model, state, questions):
        raise ProviderError("TypeSafe answered HTTP 429: slow down", rate_limited=True, retry_after=3.0)

    with pytest.raises(RacerError) as exc:
        _run(JevRacer(client=Scripted(ask), model_id="j").choose(_turn(["Peru", "Chile"])))
    assert exc.value.retryable and exc.value.rate_limited and exc.value.retry_after == 3.0
    assert str(exc.value).startswith("Jev: ") and "429" in str(exc.value)


def test_jev_with_nowhere_left_to_go_is_at_a_dead_end_not_a_foul():
    fake = FakeJev("x")
    with pytest.raises(DeadEnd, match="no way forward"):
        _run(JevRacer(client=fake, model_id="j").choose(_turn(["Start", "Middle"], path=("Start", "Middle"))))
    assert fake.asks == []


def test_one_failed_request_calls_off_the_others():
    started, cancelled = [], []

    async def ask(model, state, questions):
        n = len(started)
        started.append(n)
        if n == 0:
            raise ProviderError("TypeSafe answered HTTP 429: slow down", rate_limited=True)
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.append(n)
            raise
        return {}

    links = [f"Link {i}" for i in range(2300)]  # ten pieces, two requests
    with pytest.raises(RacerError) as exc:
        _run(JevRacer(client=Scripted(ask), model_id="j").choose(_turn(links)))
    assert exc.value.rate_limited
    assert len(started) == 2 and cancelled == [1]
