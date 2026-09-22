"""Judges' Panel: one request per contestant, five Score questions, weights in code."""
from __future__ import annotations

from wikirace.games import judges as J
from wikirace.race.wiki import WikiError

from .conftest import score_answer

DOGS = J.topic_of("dogs")
TITLES = [c["title"] for c in DOGS["contestants"]]
LEVEL_OF = {"Greyhound": 4, "Border Collie": 0}  # the "exercise" judge's level, else 2


def wiki_intros(calls: list[dict] | None = None):
    """A Wikipedia that has every dog, with one title normalised and one redirected."""
    def answer(params):
        if calls is not None:
            calls.append(params)
        assert params["prop"] == "extracts" and params["exintro"] == "1"
        asked = params["titles"].split("|")
        pages = []
        for t in asked:
            shown = "Poodle (dog)" if t == "Poodle" else t
            pages.append({"title": shown, "extract": f"The {t} is a breed of dog.\n\nIt is ( ) friendly."})
        return {"query": {"redirects": [{"from": "Poodle", "to": "Poodle (dog)"}], "pages": pages[::-1]}}
    return answer


def jev_panel(qid, q, state):
    """Level 2 everywhere, except where LEVEL_OF says, with a little spread."""
    lv = LEVEL_OF.get(state["name"], 2) if qid == "exercise" else 2
    probs = [0.0] * 5
    probs[lv] = 0.8
    probs[max(0, lv - 1)] += 0.1
    probs[min(4, lv + 1)] += 0.1
    return score_answer(probs)


def test_every_topic_has_contestants_five_judges_and_presets():
    assert 3 <= len(J.topics()) <= 4
    for t in J.topics():
        assert 6 <= len(t["contestants"]) <= 8, t["id"]
        assert len({c["title"] for c in t["contestants"]}) == len(t["contestants"])
        assert len(t["judges"]) == 5
        ids = {j["id"] for j in t["judges"]}
        for j in t["judges"]:
            assert len(j["levels"]) == J.LEVELS and "`name`" in j["question"]
        assert 2 <= len(t["presets"]) <= 3
        for p in t["presets"]:
            assert set(p["weights"]) == ids and all(0 <= w <= 5 for w in p["weights"].values())
            assert sum(p["weights"].values()) > 0


def test_questions_name_their_state_fields_and_use_the_rubric():
    qs = J.questions(DOGS)
    assert list(qs) == [j["id"] for j in DOGS["judges"]]
    for j in DOGS["judges"]:
        q = qs[j["id"]]
        assert q["type"] == "score" and q["criteria"] == j["levels"]
        assert "`name`" in q["instructions"]["question"]
        assert any("`article`" in r for r in q["instructions"]["rules"])
    system = J.text_system(DOGS)
    assert "JUDGE 5: <0-4>" in system and "famously gentle" in system and "`" not in system


def test_reading_a_judges_line():
    reply = "JUDGE 1: 4\n**JUDGE 2**: 3 (suits most apartments)\nJUDGE 3: 7\nJUDGE 4 (Easy to train): 2\nJUDGE 5: none"
    assert J.read_judge(reply, 1) == 4
    assert J.read_judge(reply, 2) == 3
    assert J.read_judge(reply, 3) is None  # out of range
    assert J.read_judge(reply, 4) == 2  # a label before the colon is forgiven
    assert J.read_judge(reply, 5) is None  # not a number
    assert J.read_judge("JUDGE 10: 3", 1) is None
    assert J.read_judge("", 1) is None


def test_introductions_are_fetched_in_one_request_and_trimmed():
    assert J.trim_article("Yosemite ( yoh-SEM-ih-tee) is ( ) big.\n\n\nIt has cliffs.") == \
        "Yosemite ( yoh-SEM-ih-tee) is big.\nIt has cliffs."
    long = "A sentence here. " * 200
    cut = J.trim_article(long)
    assert len(cut) <= J.ARTICLE_CHARS and cut.endswith(".")


def test_jev_scores_every_contestant_in_one_request_each(arcade):
    calls: list[dict] = []
    arcade.wiki_answer = wiki_intros(calls)
    arcade.jev.responder = jev_panel
    run = arcade.play("judges", ["jev"], {"topic": "dogs"})
    assert run["status"] == "finished", run.get("note")
    assert len(calls) == 1 and set(calls[0]["titles"].split("|")) == set(TITLES)
    assert run["topic"]["id"] == "dogs" and len(run["contestants"]) == 8
    assert "friendly" in run["contestants"][0]["article"] and "( )" not in run["contestants"][0]["article"]
    # One request per contestant, five Score questions, the state only name and article.
    reqs = arcade.jev.requests
    assert len(reqs) == 8
    assert all(set(r["state"]) == {"name", "article"} and len(r["questions"]) == 5 for r in reqs)
    lane = run["lanes"][0]
    assert lane["calls"] == 8 and lane["score"] == 40 and lane["fouls"] == 0
    by_c = {s["c"]: s for s in lane["scored"]}
    assert set(by_c) == set(range(8))
    names = {c["i"]: c["name"] for c in run["contestants"]}
    ex = [j["id"] for j in DOGS["judges"]].index("exercise")
    for k, s in by_c.items():
        cell = s["judges"][ex]
        want = LEVEL_OF.get(names[k], 2)
        assert cell["level"] == want and len(cell["probabilities"]) == 5
        assert 0 < cell["spread"] < 1
    assert lane["cost"] > 0 and lane["cost_estimated"] is True


def test_a_text_panel_is_compared_and_its_bad_scores_are_fouls(arcade):
    arcade.wiki_answer = wiki_intros()
    arcade.jev.responder = jev_panel

    def reply(model, system, prompt):
        if model == "test/a":
            return "JUDGE 1: 4\nJUDGE 2: 3\nJUDGE 3: 2\nJUDGE 4: 3\nJUDGE 5: 1"
        return "JUDGE 1: 4\nJUDGE 2: 9\nJUDGE 3: 2\nJUDGE 5: 1"  # 9 is out of range, 4 is missing

    arcade.text.responder = reply
    run = arcade.play("judges", ["jev", "test/a", "test/b"], {"topic": "dogs"})
    jev, good, bad = run["lanes"]
    assert jev["score"] == 40
    assert good["score"] == 40 and good["fouls"] == 0 and good["calls"] == 8
    assert bad["score"] == 24 and bad["fouls"] == 16
    cells = bad["scored"][0]["judges"]
    assert cells[1] is None and cells[3] is None and cells[0]["score"] == 4 and cells[0]["spread"] == 0
    first = arcade.text.prompts[0]
    assert "JUDGE 1: <0-4>" in first["system"] and first["prompt"].startswith("CONTESTANT: ")


def test_a_seed_draws_a_topic_and_a_bad_topic_is_refused(arcade):
    arcade.wiki_answer = lambda params: {"query": {"pages": [
        {"title": t, "extract": f"{t} intro."} for t in params["titles"].split("|")]}}
    arcade.jev.responder = lambda qid, q, state: score_answer([0, 0, 1, 0, 0])
    r1 = arcade.start("judges", ["jev"], {"seed": 5})
    r2 = arcade.start("judges", ["jev"], {"seed": 5})
    assert r1.status_code == 201 and r1.json()["topic"]["id"] == r2.json()["topic"]["id"]
    assert arcade.start("judges", ["jev"], {"topic": "cats"}).status_code == 422
    assert arcade.start("judges", ["test/a"], {"topic": "dogs"}).status_code == 400  # needs Jev


def test_wikipedia_failing_is_a_502(arcade):
    def down(params):
        raise WikiError("Wikipedia answered HTTP 503")
    arcade.wiki_answer = down
    r = arcade.start("judges", ["jev"], {"topic": "parks"})
    assert r.status_code == 502 and "introductions" in r.json()["detail"]
    arcade.wiki_answer = lambda params: {"query": {"pages": [{"title": "Zion National Park", "extract": "Zion."}]}}
    r = arcade.start("judges", ["jev"], {"topic": "parks"})
    assert r.status_code == 502 and "no introduction" in r.json()["detail"]
