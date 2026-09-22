"""Switchboard: callers on a clock, operators on queues, a confidence gate."""
from __future__ import annotations

import asyncio

from wikirace.games import switchboard as S
from wikirace.providers.base import Completion

from .conftest import choice_answer

FAST = {"calls": 12, "interval_ms": 100, "patience_ms": 30_000, "seed": 7}
GOLD = {c["text"]: c["intent"] for c in S.data()["calls"]}


def jev_knows(confidence: float = 0.9):
    """Jev, putting 0.9 on the right line of every call."""
    def answer(qid, q, state):
        gold = GOLD[state["caller_said"]] or S.OOS
        ids = q["criteria"]
        right = next(o for o, desc in ids.items() if desc.startswith(f"{gold} (") or desc.startswith(f"{gold}:"))
        rest = 0.1 / (len(ids) - 1)
        return choice_answer({o: 0.9 if o == right else rest for o in ids}, confidence)
    return answer


def caller(prompt: str) -> str:
    return prompt.split('"', 1)[1].rsplit('"', 1)[0]


def test_the_board_has_151_lines_and_every_caller_has_one():
    names = [n for n, _ in S.lines()]
    assert len(names) == 151 and len(set(names)) == 151 and names[-1] == S.OOS
    assert all(c["intent"] is None or c["intent"] in names for c in S.data()["calls"])
    assert S.describe("apr", "credit cards") == "apr (credit cards): the interest rate on a credit card"


def test_routing_and_scoring_rules():
    assert S.jev_route("apr", 0.49, 0.5) == "operator"
    assert S.jev_route(S.OOS, 0.9, 0.5) == "oos"
    assert S.jev_route("apr", 0.9, 0.5) == "connect"
    assert S.judge("connect", "apr", "apr") == "right"
    assert S.judge("connect", "apr", "balance") == "wrong"
    assert S.judge("oos", None, None) == "right"
    assert S.judge("oos", None, "apr") == "wrong"
    assert S.judge("operator", None, "apr") == "operator"
    assert S.read_line("thinking…\nLINE: **apr**") == "apr"
    assert S.read_line("apr") == "apr"
    # A row copied whole from the listing names its line; another bracket does not.
    names = [n for n, _ in S.lines()]
    assert S.match_line("translate (travel)", names) == "translate"
    assert S.match_line("uber (auto)", names) == "uber"
    assert S.match_line("uber (banking)", names) is None
    assert S.match_line("customer_service (billing)", names) is None


def test_jev_connects_every_caller_when_it_is_sure(arcade):
    arcade.jev.responder = jev_knows(0.9)
    run = arcade.play("switchboard", ["jev"], FAST)
    assert run["status"] == "finished"
    lane = run["lanes"][0]
    assert lane["answered"] == 12 and lane["right"] == 12 and lane["score"] == 24
    assert len(lane["answers"]) == 12 and len(run["calls"]) == 12
    # One question of 151 options per call, under opaque ids.
    q = arcade.jev.requests[0]["questions"]["line"]
    assert len(q["criteria"]) == 151 and all(k.startswith("l") for k in q["criteria"])
    assert run["gold"] == [GOLD[c["text"]] for c in run["calls"]]


def test_an_unsure_jev_hands_callers_to_the_operator(arcade):
    arcade.jev.responder = jev_knows(0.3)
    run = arcade.play("switchboard", ["jev"], {**FAST, "threshold": 0.5})
    lane = run["lanes"][0]
    assert lane["operator"] == 12 and lane["score"] == 0
    assert all(a["route"] == "operator" and a["guess"] for a in lane["answers"])


def test_a_text_operator_can_be_right_unsure_or_foul(arcade):
    def reply(model, system, prompt):
        text = caller(prompt)
        gold = GOLD[text]
        if model == "test/a":
            return f"LINE: {gold or S.OOS}"
        if model == "test/b":
            return "LINE: operator"
        return "LINE: customer_service"  # not a line
    arcade.text.responder = reply
    run = arcade.play("switchboard", ["test/a", "test/b", "test/c"], FAST)
    good, unsure, foul = run["lanes"]
    assert good["right"] == 12 and good["fouls"] == 0
    assert unsure["operator"] == 12
    assert foul["fouls"] == 12 and foul["score"] == -12
    assert "LINE:" in arcade.text.prompts[0]["system"] and "replacement_card_duration" in arcade.text.prompts[0]["system"]


def test_a_slow_operator_drops_callers(arcade):
    class Slow:
        config = arcade.app.state.providers["openrouter"].config

        async def complete(self, model, system, prompt, **kw):
            await asyncio.sleep(0.4)
            return Completion(text=f"LINE: {GOLD[caller(prompt)] or S.OOS}", model=model, tokens_in=10, tokens_out=2)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    arcade.jev.responder = jev_knows(0.9)
    run = arcade.play("switchboard", ["jev", "test/a"],
                      {"calls": 10, "interval_ms": 100, "patience_ms": 1000, "seed": 3}, timeout=20)
    jev, slow = run["lanes"]
    assert jev["dropped"] == 0 and jev["right"] == 10
    assert slow["dropped"] > 0 and slow["right"] + slow["dropped"] == 10
    assert slow["backlog"] and max(slow["backlog"]) > 1
