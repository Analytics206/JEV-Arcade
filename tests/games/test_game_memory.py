"""Memory Match: every A card against every B card, the nearest level decides."""
from __future__ import annotations

import asyncio
import json
import random
import re
import time

from wikirace.games import memory as M
from wikirace.games import runs
from wikirace.providers.base import Completion

from .conftest import noul_answer, score_answer

PAIRS = M.data()["pairs"]
GOLD = {(p["a"], p["b"]): p["gold"] for p in PAIRS}
FIELDS = {(p["a"], p["b"]): p["fields"] for p in PAIRS}


def jev_knows(confuse: str | None = None):
    """Jev, sure of the gold level of every combination (0 across pairs); the
    listing *confuse* (an A title) it scores between related and same."""
    def answer(qid, q, state):
        key = (state["shop_a"], state["shop_b"])
        level = GOLD.get(key, 0)
        if q["type"] == "score":
            if confuse and state["shop_a"] == confuse and level == 1:
                return score_answer([0.05, 0.3, 0.65])  # 1.6: nearest is "same"
            probs = [0.03, 0.03, 0.03]
            probs[level] = 0.94
            return score_answer(probs)
        fields = FIELDS.get(key, {"brand": False, "model": False, "variant": False})
        return noul_answer(0.9 if fields[qid] else 0.1)
    return answer


def cards_of(prompt: str) -> tuple[str, list[str]]:
    a = re.search(r'SHOP A LISTING: "(.*)"', prompt).group(1)
    bs = [ln.split(". ", 1)[1] for ln in prompt.split("SHOP B LISTINGS:\n", 1)[1].splitlines()]
    return a, bs


def test_the_listings_are_distinct_and_every_pair_says_what_matches():
    assert len(PAIRS) >= 24
    assert len({p["a"] for p in PAIRS}) == len(PAIRS) and len({p["b"] for p in PAIRS}) == len(PAIRS)
    assert {p["gold"] for p in PAIRS} == {0, 1, 2}
    for p in PAIRS:
        assert set(p["fields"]) == {"brand", "model", "variant"}
        if p["gold"] == 2:
            assert all(p["fields"].values())
        if p["gold"] == 1:
            assert p["fields"]["model"] and not p["fields"]["variant"] and p.get("differs")
        if p["gold"] == 0:
            assert not p["fields"]["model"]
    assert "WikiRace" in M.data()["about"]


def test_a_board_shuffles_each_side_on_its_own_and_mixes_the_levels():
    a, b, gold = M.board(M.deal(8, random.Random(3)), random.Random(4))
    assert len(a) == len(b) == len(gold) == 8
    assert sorted(g["level"] for g in gold) == [0, 0, 1, 1, 2, 2, 2, 2]
    assert sorted(g["a"] for g in gold) == list(range(8)) and sorted(g["b"] for g in gold) == list(range(8))
    for g in gold:
        assert GOLD[(a[g["a"]], b[g["b"]])] == g["level"]
    assert M.board(M.deal(8, random.Random(3)), random.Random(4))[0] == a  # seeded


def test_the_nearest_level_decides_and_code_pairs_the_board():
    assert [M.nearest(x) for x in (0.0, 0.49, 0.5, 1.49, 1.5, 2.0, 2.4)] == [0, 0, 1, 1, 2, 2, 2]
    grid = [
        {"a": 0, "b": 0, "score": 1.9, "level": 2}, {"a": 0, "b": 1, "score": 1.95, "level": 2},
        {"a": 1, "b": 1, "score": 1.2, "level": 1}, {"a": 1, "b": 0, "score": 1.1, "level": 1},
        {"a": 2, "b": 2, "score": 0.4, "level": 0},
    ]
    assert M.pair_up(grid) == [
        {"a": 0, "b": 1, "level": 2, "score": 1.95}, {"a": 1, "b": 0, "level": 1, "score": 1.1},
    ]


def test_reading_a_text_models_match():
    assert M.read_match("MATCH: 3\nLEVEL: same", 8) == {"kind": "claim", "b": 2, "level": 2}
    assert M.read_match("MATCH: **B4**\nLEVEL: Related.", 8) == {"kind": "claim", "b": 3, "level": 1}
    assert M.read_match("MATCH: #2 (the kettle)\nLEVEL: same product", 8)["b"] == 1
    assert M.read_match("MATCH: none", 8) == {"kind": "none"}
    assert M.read_match("MATCH: 9\nLEVEL: same", 8)["kind"] == "foul"
    assert M.read_match("MATCH: 0\nLEVEL: same", 8)["kind"] == "foul"
    assert M.read_match("MATCH: the black one\nLEVEL: same", 8)["kind"] == "foul"
    assert M.read_match("MATCH: 2\nLEVEL: probably", 8)["kind"] == "foul"
    assert M.read_match("I think card 2.", 8)["kind"] == "foul"


def test_scoring_every_kind_of_claim():
    gold = [{"a": 0, "b": 5, "level": 2}, {"a": 1, "b": 6, "level": 1}, {"a": 2, "b": 7, "level": 0},
            {"a": 3, "b": 4, "level": 2}]
    claims = [
        {"a": 0, "b": 5, "level": 2},  # same +2
        {"a": 1, "b": 6, "level": 2},  # eager 0
        {"a": 2, "b": 7, "level": 1},  # wrong −1: a look-alike
        {"a": 3, "b": 5, "level": 1},  # wrong −1: across pairs
    ]
    t = M.tally(claims, gold)
    assert [c["verdict"] for c in t["claims"]] == ["same", "eager", "wrong", "wrong"]
    assert t["points"] == 0 and t["missed"] == 1 and t["right"] == 1 and t["wrong"] == 2
    assert M.verdict(1, 2) == "cautious" and M.verdict(1, 1) == "related"


def test_jev_compares_every_card_with_every_card_and_finds_the_twins(arcade):
    arcade.jev.responder = jev_knows()
    r = arcade.start("memory", ["jev"], {"pairs": 6, "seed": 11})
    assert r.status_code == 201
    started = r.json()
    assert started["gold"] is None and len(started["cards_a"]) == 6 and len(started["cards_b"]) == 6
    run = arcade.wait(started["id"])
    assert run["status"] == "finished"
    reqs = arcade.jev.requests
    assert len(reqs) == 36
    assert all(set(q["state"]) == {"shop_a", "shop_b"} for q in reqs)
    qs = reqs[0]["questions"]
    assert qs["match"]["type"] == "score" and len(qs["match"]["criteria"]) == 3
    assert [qs[k]["type"] for k in ("brand", "model", "variant")] == ["noul"] * 3
    lane = run["lanes"][0]
    assert lane["calls"] == 36 and len(lane["grid"]) == 36 and lane["done_n"] == 36
    gold = run["gold"]
    want = {(g["a"], g["b"]): g["level"] for g in gold if g["level"] > 0}
    assert {(c["a"], c["b"]): c["level"] for c in lane["claims"]} == want
    assert lane["score"] == sum(want.values()) and lane["missed"] == 0 and lane["wrong"] == 0
    cell = next(c for c in lane["grid"] if (c["a"], c["b"]) in want)
    assert cell["brand"] == 0.9 and set(cell) >= {"score", "level", "p", "model", "variant"}
    # The answers were private until the end: no event carried them before the last patch.
    events = [json.loads(e[6:]) for e in runs.get_live(started["id"]).events]
    reveal = next(k for k, e in enumerate(events) if e["type"] == "patch" and e["patch"].get("gold"))
    assert all("gold" not in json.dumps(e) for e in events[:reveal])


def test_a_confused_jev_merges_a_cousin_too_eagerly(arcade):
    rng = random.Random(11)
    side_a, _, gold = M.board(M.deal(6, rng), rng)
    cousin = next(side_a[g["a"]] for g in gold if g["level"] == 1)
    arcade.jev.responder = jev_knows(confuse=cousin)
    run = arcade.play("memory", ["jev"], {"pairs": 6, "seed": 11})
    lane = run["lanes"][0]
    eager = [c for c in lane["claims"] if c["verdict"] == "eager"]
    assert len(eager) == 1 and side_a[eager[0]["a"]] == cousin
    assert lane["score"] == sum(g["level"] for g in run["gold"]) - 1


def test_text_models_match_one_card_at_a_time_and_foul_off_the_board(arcade):
    def reply(model, system, prompt):
        a, bs = cards_of(prompt)
        if model == "test/b":
            return "MATCH: 12\nLEVEL: same"  # there are six cards
        for k, b in enumerate(bs, 1):
            level = GOLD.get((a, b), 0)
            if level:
                return f"MATCH: {k}\nLEVEL: {'same' if level == 2 else 'related'}"
        return "MATCH: none"

    arcade.text.responder = reply
    run = arcade.play("memory", ["test/a", "test/b"], {"pairs": 6, "seed": 2})
    good, bad = run["lanes"]
    assert good["calls"] == 6 and good["fouls"] == 0
    assert good["score"] == sum(g["level"] for g in run["gold"])
    assert bad["fouls"] == 6 and bad["claims"] == [] and bad["score"] == 0
    assert all(s["kind"] == "foul" for s in bad["said"])
    first = arcade.text.prompts[0]
    assert "MATCH: <a shop B number, or none>" in first["system"] and "SHOP B LISTINGS:\n1. " in first["prompt"]


def test_a_board_holds_four_to_ten_pairs(arcade):
    assert arcade.start("memory", ["jev"], {"pairs": 3}).status_code == 422
    assert arcade.start("memory", ["jev"], {"pairs": 11}).status_code == 422


def test_stopping_a_round_calls_off_the_rest_and_still_shows_the_answers(arcade):
    class Slow:
        config = arcade.app.state.providers["openrouter"].config
        started = 0

        async def complete(self, model, system, prompt, **kw):
            Slow.started += 1
            await asyncio.sleep(5)
            return Completion(text="MATCH: none", model=model, tokens_in=10, tokens_out=2)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    r = arcade.start("memory", ["test/a"], {"pairs": 8, "seed": 1})
    run_id = r.json()["id"]
    deadline = time.monotonic() + 5
    while Slow.started < M.TEXT_PARALLEL and time.monotonic() < deadline:
        time.sleep(0.02)
    assert arcade.client.post(f"/api/games/runs/{run_id}/stop").status_code == 202
    run = arcade.wait(run_id, timeout=5)
    assert run["status"] == "stopped" and run["lanes"][0]["status"] == "stopped"
    assert Slow.started == M.TEXT_PARALLEL  # the other four were never asked
    assert len(run["gold"]) == 8 and run["lanes"][0]["score"] is None
