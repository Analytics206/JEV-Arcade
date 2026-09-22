"""Blind Tasting: Jev measures every note, a ridge regression in code does the maths."""
from __future__ import annotations

import json
import random

import pytest

from wikirace.games import runs
from wikirace.games import tasting as T

from .conftest import noul_answer, score_answer

SCORE_OF = {n["note"]: n["score"] for n in T.notes()}


def level_answer(level: float, spread: float = 0.4):
    ps = [max(1e-6, 2.718 ** (-((i - level) ** 2) / (2 * spread ** 2))) for i in range(5)]
    return score_answer(ps)


def jev_tastes(qid, q, state):
    """Features that track the critic's score, with a little noise per note."""
    s = SCORE_OF[state["note"]]
    rng = random.Random(f"{qid}|{state['note']}")
    if q["type"] == "score":
        base = 1.0 if qid == "oak" else (s - 80) / 5
        return level_answer(max(0.0, min(4.0, base + rng.uniform(-0.3, 0.3))))
    p = {"ages": 0.9 if s >= 90 else 0.1, "flaw": 0.9 if s <= 83 else 0.05, "now": 0.8 if s < 88 else 0.2}[qid]
    return noul_answer(p)


def test_forty_notes_on_one_scale_and_ten_questions():
    ns = T.notes()
    assert len(ns) == 40 and len({n["id"] for n in ns}) == 40
    assert all(T.LOW <= n["score"] <= T.HIGH and n["note"] and n["style"] for n in ns)
    assert min(n["score"] for n in ns) <= 82 and max(n["score"] for n in ns) >= 97
    qs = T.questions()
    assert [q["type"] for q in qs.values()] == ["score"] * 7 + ["noul"] * 3
    assert all(len(q["criteria"]) == 5 for q in qs.values() if q["type"] == "score")
    assert all("`note`" in q["instructions"]["question"] for q in qs.values())
    assert len(T.feature_names()) == 17
    assert "WikiRace" in T.data()["about"]


def test_gaussian_elimination_and_ridge_regression():
    assert T.solve([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]) == pytest.approx([2, 3, -1])
    assert T.solve([[0, 1], [1, 0]], [4, 5]) == pytest.approx([5, 4])  # needs a pivot
    with pytest.raises(ValueError):
        T.solve([[1, 2], [2, 4]], [1, 2])
    rng = random.Random(1)
    xs = [[rng.uniform(0, 4), rng.uniform(0, 1), 3.0] for _ in range(30)]  # the last never varies
    ys = [85 + 2 * x[0] - 4 * x[1] for x in xs]
    m = T.fit(xs, ys, lam=1e-9)
    assert m.predict([2.0, 0.5, 3.0]) == pytest.approx(87.0, abs=1e-6)
    assert m.weights[2] == 0
    shrunk = T.fit(xs, ys, lam=50.0)
    assert abs(shrunk.predict([4.0, 0.0, 3.0]) - 85) < abs(m.predict([4.0, 0.0, 3.0]) - 85)


def test_the_model_never_sees_the_target_score():
    rng = random.Random(2)
    vecs = [[rng.uniform(0, 4) for _ in range(4)] for _ in range(12)]
    ys = [80 + 4 * v[0] + v[1] for v in vecs]
    one = T.model_for(vecs, ys, target=5)
    ys[5] = 100 if ys[5] < 90 else 80
    two = T.model_for(vecs, ys, target=5)
    assert one["prediction"] == two["prediction"] and one["rmse"] == two["rmse"] and one["top"] == two["top"]
    assert all(p["n"] != 6 for p in one["loo"]) and one["trained_on"] == 11


def test_reading_a_guess_and_who_wins():
    assert T.read_guess("REASON: firm and long.\nSCORE: 92") == 92
    assert T.read_guess("SCORE: **91.5** points") == 91.5
    assert T.read_guess("SCORE: 105") is None
    assert T.read_guess("SCORE: seventy") is None
    assert T.read_guess("I would say 90.") is None
    assert T.winners({"you": 89, "jev": 92, "text": 95}, 93) == ["jev"]
    assert T.winners({"a": 90, "b": 90, "c": None}, 91) == ["a", "b"]
    assert T.winners({"a": 94, "b": 96}, 93) == []
    assert T.winners({"a": 93}, 93) == ["a"]  # exactly right is not over
    assert T.guess_of(91.5) == 92 and T.guess_of(77.2) == 80 and T.guess_of(104) == 100


def test_jev_measures_every_note_and_the_model_predicts_the_poured_one(arcade):
    arcade.jev.responder = jev_tastes
    r = arcade.start("tasting", ["jev"], {"note": 5})
    assert r.status_code == 201
    started = r.json()
    assert started["critic"] is None and started["wine"]["n"] == 5 and "score" not in started["wine"]
    run = arcade.wait(started["id"])
    assert run["status"] == "finished", run.get("note")
    reqs = arcade.jev.requests
    assert len(reqs) == 40 and all(set(q["state"]) == {"note"} and len(q["questions"]) == 10 for q in reqs)
    lane = run["lanes"][0]
    assert lane["calls"] == 40 and lane["measured"] == 40
    model = lane["model"]
    critic = T.notes()[4]["score"]
    assert run["critic"] == critic
    assert abs(model["prediction"] - critic) < 2.0 and model["rmse"] < 2.5
    assert lane["guess"] == model["guess"] == lane["score"]
    assert model["trained_on"] == 39 and len(model["loo"]) == 39 and all(p["n"] != 5 for p in model["loo"])
    assert len(model["top"]) == 5 and all(set(t) == {"id", "label", "w"} for t in model["top"])
    feats = lane["features"]
    assert [s["id"] for s in feats["scores"]][:2] == ["fruit", "oak"] and len(feats["nouls"]) == 3
    assert run["winners"] == ([0] if lane["guess"] <= critic else [])
    # The critic's score was private until the end.
    events = [json.loads(e[6:]) for e in runs.get_live(started["id"]).events]
    reveal = next(k for k, e in enumerate(events) if e["type"] == "patch" and "critic" in e["patch"])
    assert reveal == len(events) - 2  # the reveal, then the run's own finish
    assert all("critic" not in e.get("patch", {}) for e in events[:reveal])


def test_text_models_guess_in_words_and_going_over_loses(arcade):
    critic = T.notes()[0]["score"]  # 93

    def reply(model, system, prompt):
        return {"test/a": f"REASON: structured.\nSCORE: {critic - 2}", "test/b": f"SCORE: {critic + 1}",
                "test/c": "SCORE: 120"}[model]

    arcade.text.responder = reply
    run = arcade.play("tasting", ["test/a", "test/b", "test/c"], {"note": 1})
    a, b, c = run["lanes"]
    assert a["guess"] == critic - 2 and a["said"] == "structured." and a["won"] and not a["over"]
    assert b["over"] and not b["won"]
    assert c["guess"] is None and c["fouls"] == 1 and not c["won"]
    assert run["winners"] == [0]
    first = arcade.text.prompts[0]
    assert "SCORE: <80-100>" in first["system"] and first["prompt"].startswith("TASTING NOTE (red blend)")


def test_a_note_out_of_the_set_is_refused(arcade):
    assert arcade.start("tasting", ["jev"], {"note": 0}).status_code == 422
    assert arcade.start("tasting", ["jev"], {"note": 41}).status_code == 422
    r1, r2 = arcade.start("tasting", ["test/a"], {"seed": 9}), arcade.start("tasting", ["test/a"], {"seed": 9})
    assert r1.json()["wine"]["n"] == r2.json()["wine"]["n"]
