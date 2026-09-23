"""The provider layer, with no network: every provider gets an
`httpx.MockTransport` (the Anthropic SDK's httpx2 client through the bridge),
and every test reads the requests it made."""
from __future__ import annotations

import asyncio
import gzip
import json
from typing import Any

import httpx
import pytest

from wikirace.config import load_settings
from wikirace.providers import (
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    ProviderError,
    TypeSafe,
    aclose_all,
    build,
)
from wikirace.providers import anthropic as anthropic_mod
from wikirace.providers import ollama as ollama_mod
from wikirace.providers import openai as openai_mod
from wikirace.providers.base import error_detail, transport_error, visible_text
from wikirace.providers.ladder import NOTHING, Ladder, Rung, nearest

# ── fixtures ─────────────────────────────────────────────────────────────────

ENV = {
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "OPENAI_API_KEY": "sk-openai-test",
    "OPENROUTER_API_KEY": "sk-or-test",
    "TYPESAFE_API_KEY": "ts-test",
    "OLLAMA_BASE_URL": "http://ollama.test:11434",
    "OLLAMA_NUM_CTX": "8192",
}


def settings(**overrides: str | None):
    env = {k: v for k, v in {**ENV, **overrides}.items() if v is not None}
    return load_settings(env, read_file=False)


class Fake:
    """A scripted server. Each answer is an `httpx.Response`, a function of
    the request, or an exception to raise; they are used in order and the
    last one repeats. Every request is kept."""

    def __init__(self, *answers: Any) -> None:
        self.answers = list(answers)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.answers[0] if len(self.answers) == 1 else self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer(request) if callable(answer) else answer

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    @property
    def bodies(self) -> list[Any]:
        """Each request's JSON body; None for one without a body (a GET)."""
        return [json.loads(r.content) if r.content else None for r in self.requests]


def provider(pid: str, fake: Fake, **env: str | None):
    return build(settings(**env), transport=fake.transport)[pid]


def run(coro):
    return asyncio.run(coro)


def complete(p, model: str, thinking: str | None = None, *, max_tokens: int = 16000, timeout: float = 30.0):
    return run(p.complete(model, "the rules", "the turn", thinking=thinking, max_tokens=max_tokens, timeout=timeout))


def failure(coro) -> ProviderError:
    with pytest.raises(ProviderError) as info:
        run(coro)
    return info.value


def claude_body(text: str | None = "REASON: close\nLINK: Paris", *, stop: str = "end_turn",
                model: str = "claude-opus-5-20260801", usage: dict | None = None) -> dict[str, Any]:
    content: list[dict] = [{"type": "thinking", "thinking": "LINK: Not this one", "signature": "sig"}]
    if text is not None:
        content.append({"type": "text", "text": text})
    return {
        "id": "msg_1", "type": "message", "role": "assistant", "model": model, "content": content,
        "stop_reason": stop, "stop_sequence": None,
        "usage": usage or {"input_tokens": 1200, "output_tokens": 80},
    }


def claude_reply(text: str | None = "REASON: close\nLINK: Paris", **kwargs: Any) -> httpx.Response:
    return httpx.Response(200, json=claude_body(text, **kwargs))


def claude_error(status: int, message: str, kind: str = "invalid_request_error", **headers: str) -> httpx.Response:
    return httpx.Response(status, headers=headers,
                          json={"type": "error", "error": {"type": kind, "message": message}})


def chat_reply(text: Any = "REASON: close\nLINK: Paris", *, model: str = "served-model", finish: str = "stop",
               usage: dict | None = None, **extra: Any) -> httpx.Response:
    body = {
        "id": "chatcmpl-1", "object": "chat.completion", "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
        "usage": usage or {"prompt_tokens": 900, "completion_tokens": 40, "total_tokens": 940},
    }
    body.update(extra)
    return httpx.Response(200, json=body)


def api_error(status: int, message: str, **fields: Any) -> httpx.Response:
    headers = fields.pop("headers", {})
    return httpx.Response(status, headers=headers, json={"error": {"message": message, **fields}})


def ollama_reply(content: str = "LINK: Paris", *, thinking: str | None = "hmm", done_reason: str = "stop") -> httpx.Response:
    message = {"role": "assistant", "content": content}
    if thinking is not None:
        message["thinking"] = thinking
    return httpx.Response(200, json={
        "model": "qwen3.5:4b", "created_at": "2026-09-22T07:29:19Z", "message": message, "done": True,
        "done_reason": done_reason, "prompt_eval_count": 28, "eval_count": 137,
    })


def ollama_error(status: int, message: str) -> httpx.Response:
    return httpx.Response(status, json={"error": message})


# ── the ladder ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("level, supported, expected", [
    ("high", ("low", "medium", "high"), "high"),
    ("max", ("low", "medium", "high"), "high"),
    ("xhigh", ("low", "medium", "high", "max"), "high"),  # a tie folds down
    ("none", ("minimal", "low", "medium", "high"), "minimal"),
    ("none", ("none", "low", "medium", "high"), "none"),
    ("none", ("low", "medium", "high", "xhigh", "max"), "low"),
    ("low", ("high",), "high"),
])
def test_nearest_folds_to_a_level_the_model_takes(level, supported, expected):
    assert nearest(level, supported) == expected


def test_ladder_moves_on_after_a_refusal_and_remembers():
    a = Rung("a", {"x": 1}, ("x",))
    b = Rung("b", {"x": 2}, ("x",))
    ladder, tried = Ladder(), []

    async def call(rung: Rung) -> str:
        tried.append(rung.sent)
        if rung is a:
            raise ProviderError("HTTP 400: x is not supported", status=400)
        return f"ok {rung.sent}"

    assert run(ladder.climb("k", [a, b, NOTHING], call)) == "ok b"
    assert run(ladder.climb("k", [a, b, NOTHING], call)) == "ok b"
    assert tried == ["a", "b", "b"]
    assert ladder.remembered("k") == b


def test_ladder_raises_errors_that_are_not_refusals():
    rung = Rung("a", {"x": 1}, ("x",))
    calls = []

    async def call(r: Rung) -> str:
        calls.append(r)
        raise ProviderError("HTTP 400: prompt is too long", status=400)

    err = failure(Ladder().climb("k", [rung, NOTHING], call))
    assert "too long" in str(err) and calls == [rung]


def test_visible_text_drops_inline_thinking():
    assert visible_text("<think>LINK: Wrong</think>\nLINK: Paris") == "LINK: Paris"
    assert visible_text("the template opened it</think>\n\nLINK: Paris") == "LINK: Paris"
    assert visible_text("LINK: Paris\n<think>cut off mid-thou") == "LINK: Paris"
    assert visible_text("REASON: x\nLINK: Paris") == "REASON: x\nLINK: Paris"


def test_error_detail_reads_every_shape():
    assert error_detail('{"error": {"message": "bad key", "type": "x"}}') == "bad key"
    assert error_detail('{"error": "model \'x\' not found"}') == "model 'x' not found"
    assert error_detail('{"detail": [{"loc": ["body", "questions"], "msg": "field required"}]}') == \
        "questions: field required"
    assert error_detail('{"error": {"code": 400, "message": "Provider returned error", '
                        '"metadata": {"provider_name": "DeepInfra", "raw": "context too long"}}}') == \
        "Provider returned error [DeepInfra: context too long]"
    assert error_detail("<html>Bad Gateway</html>") == "<html>Bad Gateway</html>"


def test_transport_error_wording():
    refused = transport_error("Ollama", httpx.ConnectError("All connection attempts failed"), url="http://h:11434")
    assert str(refused) == "no Ollama answered at http://h:11434: connection refused" and refused.retryable
    slow = transport_error("OpenAI", httpx.ReadTimeout("timed out"), timeout=30)
    assert str(slow) == "OpenAI did not answer within 30s" and slow.retryable
    bad = transport_error("Ollama", httpx.UnsupportedProtocol("missing protocol"), url="localhost:11434")
    assert not bad.retryable and "not a usable URL" in str(bad)


# ── build ────────────────────────────────────────────────────────────────────


def test_build_makes_every_provider_even_unconfigured_ones():
    fake = Fake(chat_reply())
    providers = build(settings(ANTHROPIC_API_KEY=None, OPENAI_API_KEY=None, TYPESAFE_API_KEY=None),
                      transport=fake.transport)
    assert {pid: type(p) for pid, p in providers.items()} == {
        "anthropic": AnthropicProvider, "openai": OpenAIProvider, "openrouter": OpenAIProvider,
        "ollama": OllamaProvider, "typesafe": TypeSafe,
    }
    assert {pid: (p.id, p.kind, p.label) for pid, p in providers.items()} == {
        "anthropic": ("anthropic", "text", "Anthropic"), "openai": ("openai", "text", "OpenAI"),
        "openrouter": ("openrouter", "text", "OpenRouter"), "ollama": ("ollama", "text", "Ollama"),
        "typesafe": ("typesafe", "judgment", "TypeSafe"),
    }
    err = failure(providers["anthropic"].complete("claude-opus-5", "s", "p", thinking=None, max_tokens=10, timeout=5))
    assert "ANTHROPIC_API_KEY" in str(err) and not err.retryable
    err = failure(providers["openai"].complete("o3", "s", "p", thinking=None, max_tokens=10, timeout=5))
    assert "OPENAI_API_KEY" in str(err) and not err.retryable
    err = failure(providers["typesafe"].ask("jev-1.13.0", "state", {}))
    assert "TYPESAFE_API_KEY" in str(err) and not err.retryable
    assert fake.requests == []
    run(aclose_all(providers))


def test_aclose_all_closes_clients_that_were_used():
    fake = Fake(chat_reply())
    providers = build(settings(), transport=fake.transport)

    async def race_then_close():
        await providers["openrouter"].complete("x/y", "s", "p", thinking=None, max_tokens=10, timeout=5)
        await aclose_all(providers)

    run(race_then_close())
    assert len(fake.requests) == 1


# ── Anthropic ────────────────────────────────────────────────────────────────


def test_anthropic_request_and_reply():
    fake = Fake(claude_reply(usage={"input_tokens": 1000, "output_tokens": 80,
                                    "cache_read_input_tokens": 150, "cache_creation_input_tokens": 50}))
    comp = complete(provider("anthropic", fake), "claude-opus-5", "high")
    req = fake.requests[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == "sk-ant-test"
    body = fake.bodies[0]
    assert body["model"] == "claude-opus-5" and body["max_tokens"] == 16000
    assert body["system"] == "the rules"
    assert body["messages"] == [{"role": "user", "content": "the turn"}]
    assert body["output_config"] == {"effort": "high"} and "thinking" not in body
    # The thinking block's words are the model's working, not its answer.
    assert comp.text == "REASON: close\nLINK: Paris"
    assert comp.model == "claude-opus-5-20260801"
    assert (comp.tokens_in, comp.tokens_out, comp.cost) == (1200, 80, None)
    assert comp.stop_reason == "end_turn"
    assert comp.thinking_sent == "output_config.effort=high"


@pytest.mark.parametrize("model, level, thinking, effort, max_tokens, sent", [
    ("claude-opus-5", None, None, None, 16000, None),
    ("claude-opus-5", "none", {"type": "disabled"}, None, 16000, "thinking=disabled"),
    ("claude-fable-5-1", "none", None, "low", 16000, "output_config.effort=low"),
    ("claude-fable-5-1", "max", None, "max", 16000, "output_config.effort=max"),
    ("claude-sonnet-5", "xhigh", None, "xhigh", 16000, "output_config.effort=xhigh"),
    ("claude-opus-4-8", "max", {"type": "adaptive"}, "max", 16000, "thinking=adaptive, output_config.effort=max"),
    ("claude-opus-4-7", "low", {"type": "adaptive"}, "low", 16000, "thinking=adaptive, output_config.effort=low"),
    ("claude-sonnet-4-6", "xhigh", {"type": "adaptive"}, "high", 16000,
     "thinking=adaptive, output_config.effort=high"),
    ("claude-opus-4-6", "max", {"type": "adaptive"}, "max", 16000, "thinking=adaptive, output_config.effort=max"),
    ("claude-opus-4-6", "none", {"type": "disabled"}, None, 16000, "thinking=disabled"),
    ("claude-haiku-4-5", "high", {"type": "enabled", "budget_tokens": 8192}, None, 16000,
     "thinking.budget_tokens=8192"),
    ("claude-haiku-4-5", "max", {"type": "enabled", "budget_tokens": 24576}, None, 24576 + 4096,
     "thinking.budget_tokens=24576"),
    ("claude-sonnet-4-5-20250929", "none", {"type": "disabled"}, None, 16000, "thinking=disabled"),
    ("claude-opus-4-5-20251101", "max", {"type": "enabled", "budget_tokens": 24576}, "high", 24576 + 4096,
     "thinking.budget_tokens=24576, output_config.effort=high"),
])
def test_anthropic_thinking_per_model(model, level, thinking, effort, max_tokens, sent):
    fake = Fake(claude_reply())
    comp = complete(provider("anthropic", fake), model, level)
    body = fake.bodies[0]
    assert body.get("thinking") == thinking
    assert body.get("output_config") == ({"effort": effort} if effort else None)
    assert body["max_tokens"] == max_tokens
    assert comp.thinking_sent == sent
    assert len(fake.requests) == 1  # a known model never probes


def test_anthropic_budget_stays_below_a_small_max_tokens():
    fake = Fake(claude_reply())
    complete(provider("anthropic", fake), "claude-haiku-4-5", "low", max_tokens=800)
    body = fake.bodies[0]
    assert body["thinking"]["budget_tokens"] == 1024 < body["max_tokens"]


def test_anthropic_xhigh_folds_down_when_refused_and_is_remembered():
    # A model the table has never seen, taken for the 5 family: xhigh first.
    def answer(request: httpx.Request) -> httpx.Response:
        if json.loads(request.content).get("output_config") == {"effort": "xhigh"}:
            return claude_error(400, "output_config.effort: 'xhigh' is not supported on this model")
        return claude_reply()

    fake = Fake(answer)
    p = provider("anthropic", fake)
    first = complete(p, "claude-opus-5-9", "xhigh")
    assert [b["output_config"] for b in fake.bodies] == [{"effort": "xhigh"}, {"effort": "high"}]
    assert first.thinking_sent == "output_config.effort=high"
    # A later turn (on a new event loop, so a new client) goes straight there.
    second = complete(p, "claude-opus-5-9", "xhigh")
    assert len(fake.requests) == 3 and fake.bodies[2]["output_config"] == {"effort": "high"}
    assert second.thinking_sent == "output_config.effort=high"


def test_anthropic_none_falls_back_when_thinking_cannot_be_disabled():
    refusal = claude_error(400, '"thinking.type.disabled" is not supported for this model. Use '
                                '"thinking.type.adaptive" and "output_config.effort" to control thinking behavior.')
    fake = Fake(refusal, claude_reply(), claude_reply())
    p = provider("anthropic", fake)
    comp = complete(p, "claude-sonnet-7", "none")
    assert fake.bodies[0]["thinking"] == {"type": "disabled"}
    assert "thinking" not in fake.bodies[1] and fake.bodies[1]["output_config"] == {"effort": "low"}
    assert comp.thinking_sent == "output_config.effort=low"
    complete(p, "claude-sonnet-7", "none")
    assert len(fake.requests) == 3 and "thinking" not in fake.bodies[2]


def test_anthropic_unrelated_400_is_final_and_not_probed():
    fake = Fake(claude_error(400, "prompt is too long: 1200000 tokens > 1000000 maximum"))
    err = failure(provider("anthropic", fake).complete("claude-opus-5", "s", "p", thinking="high",
                                                       max_tokens=100, timeout=5))
    assert not err.retryable and err.status == 400 and "prompt is too long" in str(err)
    assert len(fake.requests) == 1


@pytest.mark.parametrize("status, kind, message, retryable, words", [
    (401, "authentication_error", "invalid x-api-key", False, "check ANTHROPIC_API_KEY"),
    (403, "permission_error", "no access", False, "not allowed to use claude-opus-5"),
    (404, "not_found_error", "model: claude-opus-5", False, "check the model id “claude-opus-5”"),
    (500, "api_error", "Internal server error", True, "HTTP 500"),
    (529, "overloaded_error", "Overloaded", True, "HTTP 529"),
])
def test_anthropic_status_errors(status, kind, message, retryable, words):
    fake = Fake(claude_error(status, message, kind))
    err = failure(provider("anthropic", fake).complete("claude-opus-5", "s", "p", thinking=None,
                                                       max_tokens=100, timeout=5))
    assert err.status == status and err.retryable is retryable and not err.rate_limited
    assert words in str(err)
    # A refused key is told without the provider's words, which can quote the key.
    assert (message not in str(err) and "the key was refused" in str(err)) if status == 401 else message in str(err)
    assert len(fake.requests) == 1  # the SDK does not retry: the engine does


def test_anthropic_rate_limit_carries_retry_after():
    fake = Fake(claude_error(429, "Number of request tokens has exceeded your rate limit", "rate_limit_error",
                             **{"retry-after": "7"}))
    err = failure(provider("anthropic", fake).complete("claude-opus-5", "s", "p", thinking=None,
                                                       max_tokens=100, timeout=5))
    assert err.rate_limited and err.retryable and err.retry_after == 7.0
    assert len(fake.requests) == 1


def test_anthropic_connection_errors_are_retryable():
    err = failure(provider("anthropic", Fake(httpx.ConnectError("All connection attempts failed")))
                  .complete("claude-opus-5", "s", "p", thinking=None, max_tokens=100, timeout=5))
    assert err.retryable and str(err) == "no Anthropic answered at https://api.anthropic.com: connection refused"
    err = failure(provider("anthropic", Fake(httpx.ReadTimeout("timed out")))
                  .complete("claude-opus-5", "s", "p", thinking=None, max_tokens=100, timeout=5))
    assert err.retryable and "did not answer within 5s" in str(err)


def test_anthropic_refusal_passes_through():
    comp = complete(provider("anthropic", Fake(claude_reply(None, stop="refusal"))), "claude-opus-5")
    assert comp.text == "" and comp.stop_reason == "refusal"


def test_anthropic_bridge_passes_a_streamed_encoded_reply_through():
    # What a real transport hands back: an unread stream, still gzip-encoded.
    raw = gzip.compress(json.dumps(claude_body("LINK: Lyon")).encode())
    streamed = httpx.Response(200, headers={"content-type": "application/json", "content-encoding": "gzip"},
                              stream=httpx.ByteStream(raw))
    comp = complete(provider("anthropic", Fake(streamed)), "claude-opus-5")
    assert comp.text == "LINK: Lyon"


def test_an_unknown_level_is_refused_before_any_request():
    fake = Fake(claude_reply())
    err = failure(provider("anthropic", fake).complete("claude-opus-5", "s", "p", thinking="extreme",
                                                       max_tokens=10, timeout=5))
    assert "extreme" in str(err) and fake.requests == []


def test_anthropic_profiles_follow_the_model_table():
    assert anthropic_mod.profile("claude-opus-4-20250514") == anthropic_mod.Profile(budget=True)  # date, not 4.20
    assert anthropic_mod.profile("claude-3-7-sonnet-20250219").budget
    assert not anthropic_mod.profile("claude-fable-5").can_disable
    assert "xhigh" not in anthropic_mod.profile("claude-opus-4-6").efforts
    assert anthropic_mod.profile("claude-opus-4-5").efforts == ("low", "medium", "high")
    assert not anthropic_mod.profile("claude-opus-4-5").adaptive


# ── OpenAI ───────────────────────────────────────────────────────────────────


def test_openai_request_and_reply():
    fake = Fake(chat_reply(model="gpt-4.1-mini-2025-04-14"))
    comp = complete(provider("openai", fake), "gpt-4.1-mini", "high")
    req = fake.requests[0]
    assert str(req.url) == "https://api.openai.com/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-openai-test"
    assert fake.bodies[0] == {
        "model": "gpt-4.1-mini",
        "messages": [{"role": "system", "content": "the rules"}, {"role": "user", "content": "the turn"}],
        "max_completion_tokens": 16000,
    }  # not a reasoning model: no reasoning_effort
    assert comp.text == "REASON: close\nLINK: Paris" and comp.model == "gpt-4.1-mini-2025-04-14"
    assert (comp.tokens_in, comp.tokens_out, comp.cost, comp.stop_reason) == (900, 40, None, "stop")
    assert comp.thinking_sent is None


@pytest.mark.parametrize("model, level, sent", [
    ("o4-mini", "none", "low"),
    ("o3", "xhigh", "high"),
    ("gpt-5", "none", "minimal"),
    ("gpt-5-nano", "max", "high"),
    ("gpt-5.1", "none", "none"),
    ("gpt-5.2", "max", "xhigh"),
    ("gpt-5.5", "medium", "medium"),
    ("gpt-5.6-terra", "max", "max"),
    ("gpt-6-astra", "none", "low"),
])
def test_openai_reasoning_effort_per_family(model, level, sent):
    fake = Fake(chat_reply())
    comp = complete(provider("openai", fake), model, level)
    assert fake.bodies[0]["reasoning_effort"] == sent
    assert fake.bodies[0]["max_completion_tokens"] == 16000
    assert comp.thinking_sent == f"reasoning_effort={sent}"


def test_openai_unset_level_sends_no_effort():
    fake = Fake(chat_reply())
    complete(provider("openai", fake), "o3", None)
    assert "reasoning_effort" not in fake.bodies[0]


def test_openai_learns_the_values_a_model_takes_from_its_refusal():
    refusal = api_error(400, "Unsupported value: 'reasoning_effort' does not support 'none' with this model. "
                             "Supported values are: 'low', 'medium', and 'high'.",
                        type="invalid_request_error", param="reasoning_effort", code="unsupported_value")
    fake = Fake(refusal, chat_reply(), chat_reply())
    p = provider("openai", fake)
    comp = complete(p, "gpt-5.9", "none")  # not in the table: the level goes as it is
    assert [b["reasoning_effort"] for b in fake.bodies] == ["none", "low"]
    assert comp.thinking_sent == "reasoning_effort=low"
    complete(p, "gpt-5.9", "none")
    assert len(fake.requests) == 3 and fake.bodies[2]["reasoning_effort"] == "low"


def test_openai_drops_reasoning_effort_for_a_model_that_takes_none():
    refusal = api_error(400, "Unsupported parameter: 'reasoning_effort' is not supported with this model.",
                        param="reasoning_effort", code="unsupported_parameter")
    fake = Fake(refusal, chat_reply())
    comp = complete(provider("openai", fake), "gpt-7-chat", "high")
    assert fake.bodies[0]["reasoning_effort"] == "high" and "reasoning_effort" not in fake.bodies[1]
    assert comp.thinking_sent is None


@pytest.mark.parametrize("response, retryable, rate_limited, words", [
    (api_error(401, "Incorrect API key provided"), False, False, "check OPENAI_API_KEY"),
    (api_error(404, "The model `gpt-9` does not exist", code="model_not_found"), False, False,
     "check the model id “gpt-9”"),
    (api_error(429, "Rate limit reached", headers={"retry-after-ms": "1500"}), True, True, "Rate limit"),
    (api_error(429, "You exceeded your current quota", code="insufficient_quota"), False, False, "out of credit"),
    (api_error(503, "The server is overloaded"), True, False, "HTTP 503"),
])
def test_openai_status_errors(response, retryable, rate_limited, words):
    err = failure(provider("openai", Fake(response)).complete("gpt-9", "s", "p", thinking=None,
                                                              max_tokens=100, timeout=5))
    assert err.retryable is retryable and err.rate_limited is rate_limited and words in str(err)
    if rate_limited:
        assert err.retry_after == 1.5


def test_openai_connection_error_is_retryable():
    err = failure(provider("openai", Fake(httpx.ConnectError("[Errno 11001] getaddrinfo failed")))
                  .complete("gpt-5", "s", "p", thinking=None, max_tokens=100, timeout=5))
    assert err.retryable and "the host name did not resolve" in str(err)


# ── OpenRouter ───────────────────────────────────────────────────────────────


def test_openrouter_request_cost_and_headers():
    usage = {"prompt_tokens": 2100, "completion_tokens": 130, "total_tokens": 2230, "cost": 0.000421}
    fake = Fake(chat_reply("<think>LINK: Wrong</think>LINK: Paris", model="deepseek/deepseek-v4-flash",
                           usage=usage))
    comp = complete(provider("openrouter", fake), "deepseek/deepseek-v4-flash", "xhigh", max_tokens=9000)
    req = fake.requests[0]
    assert str(req.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-or-test"
    assert req.headers["http-referer"] == "https://github.com/Analytics206/JEV-Arcade"
    assert req.headers["x-title"] == "JEV-Arcade"
    body = fake.bodies[0]
    assert body["max_tokens"] == 9000 and "max_completion_tokens" not in body
    assert body["reasoning"] == {"effort": "xhigh"} and body["usage"] == {"include": True}
    assert comp.text == "LINK: Paris"
    assert (comp.tokens_in, comp.tokens_out, comp.cost) == (2100, 130, 0.000421)
    assert comp.thinking_sent == "reasoning.effort=xhigh"


@pytest.mark.parametrize("response, rate_limited", [
    (httpx.Response(200, json={"error": {"code": 502, "message": "Upstream error from Chutes"}}), False),
    (httpx.Response(200, json={"error": {"code": 429, "message": "Rate limited upstream"}}), True),
    (chat_reply("LINK: Par", finish="error", error={"code": 502, "message": "Provider disconnected"}), False),
    (httpx.Response(200, json={"id": "gen-1", "choices": [], "usage": {"prompt_tokens": 0}}), False),
])
def test_openrouter_200_without_a_reply_is_retryable(response, rate_limited):
    err = failure(provider("openrouter", Fake(response)).complete("x/y", "s", "p", thinking=None,
                                                                  max_tokens=100, timeout=5))
    assert err.retryable and err.rate_limited is rate_limited


def test_openrouter_none_falls_back_when_reasoning_is_mandatory():
    fake = Fake(httpx.Response(400, json={"error": {"code": 400, "message":
                                          "Reasoning is mandatory for this endpoint and cannot be disabled."}}),
                chat_reply())
    comp = complete(provider("openrouter", fake), "x/thinker", "none")
    assert [b["reasoning"] for b in fake.bodies] == [{"effort": "none"}, {"effort": "minimal"}]
    assert comp.thinking_sent == "reasoning.effort=minimal"


@pytest.mark.parametrize("status, retryable", [(402, False), (408, True), (502, True)])
def test_openrouter_status_errors(status, retryable):
    response = httpx.Response(status, json={"error": {"code": status, "message": "nope"}})
    err = failure(provider("openrouter", Fake(response)).complete("x/y", "s", "p", thinking=None,
                                                                  max_tokens=100, timeout=5))
    assert err.retryable is retryable and err.status == status


# ── Ollama ───────────────────────────────────────────────────────────────────


def test_ollama_request_and_reply():
    fake = Fake(ollama_reply("<think>LINK: Wrong</think>\nLINK: Paris"))
    p = provider("ollama", fake)
    comp = complete(p, "qwen3.5:4b", "high", max_tokens=4000)
    req = fake.requests[0]
    assert str(req.url) == "http://ollama.test:11434/api/chat"
    assert "authorization" not in req.headers
    assert fake.bodies[0] == {
        "model": "qwen3.5:4b",
        "messages": [{"role": "system", "content": "the rules"}, {"role": "user", "content": "the turn"}],
        "stream": False,
        "options": {"num_ctx": 8192, "num_predict": 4000},
        "keep_alive": "15m",
        "think": "high",
    }
    assert comp.text == "LINK: Paris"  # message.thinking and the inline block are the working
    assert (comp.tokens_in, comp.tokens_out, comp.cost) == (28, 137, 0.0)
    assert comp.stop_reason == "stop" and comp.model == "qwen3.5:4b"
    assert comp.thinking_sent == "think=high"
    assert p.context_limit("qwen3.5:4b") == 8192


@pytest.mark.parametrize("model, level, think", [
    ("qwen3.5:4b", "none", False),
    ("qwen3.5:4b", "low", "low"),
    ("qwen3.5:4b", "xhigh", "high"),
    ("qwen3.5:4b", "max", "max"),
    ("gpt-oss:20b", "none", "low"),
    ("gpt-oss:20b", "max", "high"),
])
def test_ollama_think_per_level(model, level, think):
    fake = Fake(ollama_reply())
    comp = complete(provider("ollama", fake), model, level)
    assert fake.bodies[0]["think"] == think
    assert comp.thinking_sent == f"think={str(think).lower() if isinstance(think, bool) else think}"


def test_ollama_unset_level_sends_no_think_and_a_key_when_set():
    fake = Fake(ollama_reply())
    complete(provider("ollama", fake, OLLAMA_API_KEY="ol-key"), "qwen3.5:4b", None)
    assert "think" not in fake.bodies[0]
    assert fake.requests[0].headers["authorization"] == "Bearer ol-key"


def test_ollama_model_that_cannot_think_gets_nothing_after_one_refusal():
    fake = Fake(ollama_error(400, '"llama3.1:latest" does not support thinking'), ollama_reply(thinking=None))
    p = provider("ollama", fake)
    comp = complete(p, "llama3.1:latest", "high")
    assert fake.bodies[0]["think"] == "high" and "think" not in fake.bodies[1]  # not `true` in between
    assert comp.thinking_sent is None
    complete(p, "llama3.1:latest", "high")
    complete(p, "llama3.1:latest", "low")  # another level: known already
    assert len(fake.requests) == 4 and all("think" not in b for b in fake.bodies[1:])


def test_ollama_without_level_strings_falls_back_to_true():
    refusal = ollama_error(400, 'invalid think value: "medium" (must be true or false)')
    fake = Fake(refusal, ollama_reply())
    comp = complete(provider("ollama", fake), "qwen3:8b", "medium")
    assert [b["think"] for b in fake.bodies] == ["medium", True]
    assert comp.thinking_sent == "think=true"


def test_ollama_errors():
    err = failure(provider("ollama", Fake(ollama_error(404, "model 'qwen9:1b' not found")))
                  .complete("qwen9:1b", "s", "p", thinking=None, max_tokens=10, timeout=5))
    assert not err.retryable and "ollama pull qwen9:1b" in str(err)
    err = failure(provider("ollama", Fake(httpx.ConnectError("All connection attempts failed")))
                  .complete("qwen3.5:4b", "s", "p", thinking=None, max_tokens=10, timeout=5))
    assert err.retryable and str(err) == "no Ollama answered at http://ollama.test:11434: connection refused"


TAGS = {"models": [
    {"name": "qwen3.5:9b", "model": "qwen3.5:9b", "details": {
        "family": "qwen35", "parameter_size": "9.7B", "quantization_level": "Q4_K_M", "context_length": 262144},
     "capabilities": ["vision", "completion", "tools", "thinking"]},
    {"name": "llama3.1:latest", "model": "llama3.1:latest", "details": {
        "parameter_size": "8.0B", "quantization_level": "Q4_K_M", "context_length": 131072},
     "capabilities": ["completion", "tools"]},
    {"name": "nomic-embed-text:v1.5", "model": "nomic-embed-text:v1.5", "details": {
        "parameter_size": "137M", "quantization_level": "F16", "context_length": 2048},
     "capabilities": ["embedding"]},
    {"name": "old-style:7b", "model": "old-style:7b", "details": {"parameter_size": "7B"}},
]}


def test_ollama_discovery():
    fake = Fake(httpx.Response(200, json=TAGS), ollama_reply(thinking=None))
    p = provider("ollama", fake)
    models = run(p.discover())
    assert str(fake.requests[0].url) == "http://ollama.test:11434/api/tags"
    assert [(m.model_id, m.thinks, m.context, m.note) for m in models] == [
        ("qwen3.5:9b", True, 262144, "9.7B · Q4_K_M"),
        ("llama3.1:latest", False, 131072, "8.0B · Q4_K_M"),
        ("old-style:7b", None, None, "7B"),  # an Ollama too old to say: kept, unknown
    ]
    # Discovery said llama3.1 cannot think: it is sent no `think` at all.
    comp = complete(p, "llama3.1:latest", "high")
    assert "think" not in fake.bodies[1] and comp.thinking_sent is None


def test_ollama_leaves_the_reply_only_the_room_the_prompt_leaves():
    # Past the window, Ollama drops the front of the prompt to go on: the rules.
    fake = Fake(ollama_reply())
    p = provider("ollama", fake)
    run(p.complete("qwen3.5:4b", "the rules", "x" * 21_000, thinking=None, max_tokens=16_000, timeout=5))
    options = fake.bodies[0]["options"]
    assert options["num_ctx"] == 8192
    assert 256 <= options["num_predict"] <= 8192 - 21_000 // 3


def test_ollama_sizes_the_window_to_the_model_and_knows_it_untagged():
    tags = {"models": [
        {"name": "tiny:latest", "model": "tiny:latest", "capabilities": ["completion"],
         "details": {"context_length": 2048}},
    ]}
    fake = Fake(httpx.Response(200, json=tags), ollama_reply(thinking=None))
    p = provider("ollama", fake)
    run(p.discover())
    # Named without its tag, as OLLAMA_MODELS may: the same model, the same facts.
    assert p.context_limit("tiny") == 2048 == p.context_limit("tiny:latest")
    comp = complete(p, "tiny", "high")  # discovery said it cannot think
    assert fake.bodies[1]["options"]["num_ctx"] == 2048
    assert "think" not in fake.bodies[1] and comp.thinking_sent is None


def test_ollama_discovery_names_the_url_it_could_not_reach():
    err = failure(provider("ollama", Fake(httpx.ConnectError("All connection attempts failed"))).discover())
    assert str(err) == "no Ollama answered at http://ollama.test:11434: connection refused"


# ── TypeSafe ─────────────────────────────────────────────────────────────────

ANSWER = {"type": "choice", "choice": "o2", "probabilities": {"o1": 0.1, "o2": 0.9}, "confidence": 0.8}
QUESTIONS = {"final": {"type": "choice", "instructions": "Which link?", "criteria": {"o1": "A", "o2": "B"}}}


def test_typesafe_request_and_answer():
    fake = Fake(httpx.Response(200, json={"model": "jev-1.13.0", "answers": {"final": ANSWER},
                                          "usage": {"input_tokens": 312, "output_tokens": 0}}))
    ts = provider("typesafe", fake)
    out = run(ts.ask("jev-1.13.0", {"current_article": "Paris"}, QUESTIONS))
    req = fake.requests[0]
    assert str(req.url) == "https://api.typesafe.ai/v1/systemone"
    assert req.headers["authorization"] == "Bearer ts-test"
    assert fake.bodies[0] == {"state": {"current_article": "Paris"}, "model": "jev-1.13.0", "questions": QUESTIONS}
    assert out == {"model": "jev-1.13.0", "answers": {"final": ANSWER},
                   "usage": {"input_tokens": 312, "output_tokens": 0}}


def test_typesafe_answer_is_validated():
    fake = Fake(httpx.Response(200, json={"answers": {"final": ANSWER}}))
    out = run(provider("typesafe", fake).ask("jev-1.13.0", "state", QUESTIONS))
    assert out["model"] == "jev-1.13.0" and out["usage"] == {"input_tokens": 0, "output_tokens": 0}
    for body in ({"model": "jev-1.13.0", "answers": ["o2"]}, {"model": "jev-1.13.0"}, ["not", "a", "dict"]):
        err = failure(provider("typesafe", Fake(httpx.Response(200, json=body))).ask("jev-1.13.0", "s", QUESTIONS))
        assert "answers" in str(err) or "not" in str(err)


@pytest.mark.parametrize("response, retryable, rate_limited, words", [
    (httpx.Response(401, json={"detail": "Invalid API key"}), False, False,
     "TypeSafe refused the key (HTTP 401): check TYPESAFE_API_KEY"),
    (httpx.Response(422, json={"detail": [{"loc": ["body", "questions", "final", "criteria"],
                                           "msg": "at most 255 options"}]}), False, False,
     "questions.final.criteria: at most 255 options"),
    (httpx.Response(429, headers={"retry-after": "3"}, json={"detail": "slow down"}), True, True, "HTTP 429"),
    (httpx.Response(529, json={"detail": "Overloaded"}), True, False, "overloaded"),
    (httpx.Response(502, text="Bad Gateway"), True, False, "HTTP 502"),
])
def test_typesafe_errors(response, retryable, rate_limited, words):
    err = failure(provider("typesafe", Fake(response)).ask("jev-1.13.0", "state", QUESTIONS))
    assert err.retryable is retryable and err.rate_limited is rate_limited and words in str(err)
    if rate_limited:
        assert err.retry_after == 3.0


@pytest.mark.parametrize("exc", [httpx.ConnectError("All connection attempts failed"), httpx.ReadTimeout("slow")])
def test_typesafe_transport_errors_are_retryable(exc):
    err = failure(provider("typesafe", Fake(exc)).ask("jev-1.13.0", "state", QUESTIONS, timeout=2))
    assert err.retryable and not err.rate_limited


def test_typesafe_keeps_one_client_per_loop():
    fake = Fake(httpx.Response(200, json={"model": "jev-1.13.0", "answers": {}}))
    ts = provider("typesafe", fake)

    async def twice():
        first = ts._http.get()
        await ts.ask("jev-1.13.0", "s", {})
        await ts.ask("jev-1.13.0", "s", {})
        return first is ts._http.get()

    assert run(twice())
    assert len(fake.requests) == 2


# ── the model tables ─────────────────────────────────────────────────────────


def test_openai_tables():
    assert openai_mod.efforts_for("gpt-4.1-mini") == ()
    assert openai_mod.efforts_for("gpt-5-chat-latest") == ()
    assert openai_mod.efforts_for("openai/gpt-oss-120b") == ("low", "medium", "high")
    assert openai_mod.efforts_for("gpt-5-2025-08-07") == ("minimal", "low", "medium", "high")
    assert openai_mod.supported_values("Supported values are: 'none', 'low', 'medium', and 'high'. Other.") == \
        ("none", "low", "medium", "high")
    assert openai_mod.supported_values("Unsupported parameter: 'reasoning_effort'") == ()


def test_ollama_rungs_respect_discovery():
    assert ollama_mod.rungs("llama3.1", "high", thinks=False) == [NOTHING]
    assert [r.sent for r in ollama_mod.rungs("qwen3.5:4b", "high", thinks=True)] == ["think=high", "think=true", None]
