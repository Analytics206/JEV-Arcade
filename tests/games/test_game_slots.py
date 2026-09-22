"""Slot Machine: one post, many pulls, and whether the verdict holds still."""
from __future__ import annotations

import itertools
import json

from wikirace.games import runs
from wikirace.games import slots as S

from .conftest import choice_answer

FAST = {"post": 0, "pulls": 9}


def jev_leaning(top: str, p: float, second: str = "allow"):
    """Jev putting *p* on *top* (and most of the rest on *second*), every pull."""
    def answer(qid, q, state):
        label_of = {oid: meaning.split(":", 1)[0] for oid, meaning in q["criteria"].items()}
        probs = {}
        for oid, label in label_of.items():
            probs[oid] = p if label == top else (1 - p) * (0.8 if label == second else 0.2)
        return choice_answer(probs, confidence=0.7)
    return answer


def test_the_posts_are_borderline_and_written_for_wikirace():
    d = S.data()
    assert "WikiRace" in d["about"] and tuple(d["labels"]) == S.LABELS
    assert 10 <= len(d["posts"]) <= 16
    assert len({x["id"] for x in d["posts"]}) == len(d["posts"])
    for x in d["posts"]:
        assert x["text"] and x["where"] and x["note"]
        a, b = x["between"]
        assert a != b and {a, b} <= set(S.LABELS)


def test_summing_up_the_pulls():
    def pull(outcome, top=None, p=None):
        return {"outcome": outcome, "top": top if top is not None else (outcome if outcome in S.LABELS else None), "p": p}
    s = S.summarize([pull("warn"), pull("warn"), pull("allow"), pull(S.FOUL)])
    assert s["tally"] == {"allow": 1, "warn": 2, "remove": 0, "uncertain": 0, "foul": 1}
    assert s["plurality"] == s["consensus"] == "warn"
    assert s["raw_agreement"] == s["agreement"] == 0.5 and s["decided"] == 3 and s["score"] == 50.0
    assert s["spread"] is None
    # Jev: uncertain counts as a decision; raw agreement reads its top pick.
    ps = [{"allow": 0.4, "warn": 0.5, "remove": 0.1}, {"allow": 0.38, "warn": 0.55, "remove": 0.07}]
    s = S.summarize([pull("uncertain", "warn", ps[0]), pull("uncertain", "warn", ps[1]), pull("warn", "warn", ps[1])])
    assert s["consensus"] == "uncertain" and s["plurality"] == "warn"
    assert s["raw_agreement"] == 1.0 and s["agreement"] == 0.6667 and s["decided"] == 1 and s["score"] == 66.7
    assert s["spread"] == {"allow": [0.38, 0.4], "warn": [0.5, 0.55], "remove": [0.07, 0.1]}
    assert S.summarize([])["score"] is None
    assert S.jev_outcome("warn", 0.6, 0.6) == "warn" and S.jev_outcome("warn", 0.59, 0.6) == S.UNCERTAIN
    assert S.read_verdict("REASON: hm\nVERDICT: **Warn**.")[0] == "warn"
    assert S.read_verdict("VERDICT: warn or allow")[0] is None


def test_a_steady_jev_agrees_with_itself(arcade):
    arcade.jev.responder = jev_leaning("warn", 0.72)
    r = arcade.start("slots", ["jev"], FAST)
    assert r.status_code == 201
    started = r.json()
    assert started["post"]["text"] == S.data()["posts"][0]["text"] and started["borderline"] is None
    run = arcade.wait(started["id"])
    assert run["status"] == "finished"
    lane = run["lanes"][0]
    assert lane["calls"] == 9 and len(lane["pulls"]) == 9 and lane["lever"] == 3
    assert lane["tally"]["warn"] == 9 and lane["agreement"] == 1.0 and lane["score"] == 100.0
    assert lane["decided"] == 9 and lane["spinning"] == [None, None, None]
    assert sorted(x["n"] for x in lane["pulls"]) == list(range(9))
    assert {x["reel"] for x in lane["pulls"]} == {0, 1, 2}
    # Every pull a separate request: the same question, the same opaque ids, the same state.
    assert len(arcade.jev.requests) == 9
    first = arcade.jev.requests[0]
    assert set(first["state"]) == {"post", "posted_in"}
    q = first["questions"]["verdict"]
    assert q["type"] == "choice" and len(q["criteria"]) == 3 and all(k.startswith("v") for k in q["criteria"])
    assert all(r_["questions"] == first["questions"] and r_["state"] == first["state"] for r_ in arcade.jev.requests)
    assert run["borderline"]["note"] == S.data()["posts"][0]["note"]
    events = [json.loads(e[6:]) for e in runs.get_live(run["id"]).events]
    reveal = next(n for n, e in enumerate(events) if e["type"] == "patch" and "borderline" in e["patch"])
    assert all(e["type"] != "lane_push" for e in events[reveal:])


def test_an_unsure_jev_hands_every_pull_to_a_human(arcade):
    arcade.jev.responder = jev_leaning("warn", 0.5)
    run = arcade.play("slots", ["jev"], {**FAST, "threshold": 0.6})
    lane = run["lanes"][0]
    assert lane["tally"]["uncertain"] == 9 and lane["decided"] == 0
    assert lane["raw_agreement"] == 1.0 and lane["agreement"] == 1.0 and lane["consensus"] == "uncertain"
    assert lane["spread"]["warn"] == [0.5, 0.5]


def test_a_jev_on_the_threshold_flips_between_a_label_and_uncertain(arcade):
    ps = itertools.cycle([0.62, 0.58, 0.61])
    arcade.jev.responder = lambda qid, q, state: jev_leaning("warn", next(ps))(qid, q, state)
    run = arcade.play("slots", ["jev"], {**FAST, "threshold": 0.6})
    lane = run["lanes"][0]
    assert lane["tally"]["warn"] + lane["tally"]["uncertain"] == 9 and lane["tally"]["uncertain"] >= 1
    assert lane["raw_agreement"] == 1.0 and lane["agreement"] < 1.0
    assert lane["spread"]["warn"] == [0.58, 0.62]


def test_text_models_wobble_and_foul(arcade):
    wobble = itertools.cycle(["allow", "warn", "warn"])

    def reply(model, system, prompt):
        if model == "test/a":
            return "REASON: it is a figure of speech.\nVERDICT: warn"
        if model == "test/b":
            return f"REASON: hard to say.\nVERDICT: {next(wobble)}"
        return "REASON: it depends.\nVERDICT: flag for review"
    arcade.text.responder = reply
    run = arcade.play("slots", ["test/a", "test/b", "test/c"], FAST)
    steady, wobbly, foul = run["lanes"]
    assert steady["score"] == 100.0 and steady["decided"] == 9 and steady["fouls"] == 0
    assert wobbly["tally"]["allow"] == 3 and wobbly["tally"]["warn"] == 6
    assert wobbly["agreement"] == wobbly["raw_agreement"] == round(6 / 9, 4) and wobbly["score"] == 66.7
    assert foul["fouls"] == 9 and foul["tally"]["foul"] == 9 and foul["score"] == 0.0 and foul["decided"] == 0
    assert all(x["said"] == "flag for review" for x in foul["pulls"])
    assert len(arcade.text.prompts) == 27
    p0 = arcade.text.prompts[0]
    assert "VERDICT:" in p0["system"] and S.data()["posts"][0]["text"] in p0["prompt"]


def test_the_post_is_drawn_or_chosen_and_bad_params_refused(arcade):
    arcade.jev.responder = jev_leaning("allow", 0.8)
    run = arcade.play("slots", ["jev"], {"pulls": 3, "seed": 5})
    assert 0 <= run["post"]["index"] < len(S.data()["posts"]) and run["total"] == 3
    assert arcade.start("slots", ["jev"], {"pulls": 31}).status_code == 422
    assert arcade.start("slots", ["jev"], {"post": len(S.data()["posts"])}).status_code == 422
    assert arcade.start("slots", ["jev"], {"threshold": 0.2}).status_code == 422
