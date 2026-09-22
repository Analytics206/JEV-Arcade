"""Needle Hunt: one line among many, or none at all."""
from __future__ import annotations

import json

from wikirace.games import needle as N
from wikirace.games import runs
from wikirace.games.needle_doc import (
    MAX_CHOICE,
    NONE,
    constitution,
    read_line_id,
    sentences,
    split_extract,
)

from .conftest import choice_answer, noul_answer

DOC = constitution()
KEY = {q["q"]: q["lines"] for q in N.bank()["questions"]}


def emitted(run_id: str) -> list[dict]:
    return [json.loads(e[6:]) for e in runs.get_live(run_id).events]


def jev_finds(sure: float = 0.92):
    """Jev: all but certain of the answer line, and of whether there is one."""
    def answer(qid, q, state):
        key = KEY.get(state["question"], [])
        if q["type"] == "noul":
            return noul_answer(0.95 if key else 0.1)
        ids = q["criteria"]
        if qid == "window":  # a passage: the one holding the first line of the key, or the first
            right = next(iter(ids))
            return choice_answer({o: (0.9 if o == right else 0.1 / max(1, len(ids) - 1)) for o in ids})
        target = key[0] if key else "L001"
        right = next(o for o, d in ids.items() if d.startswith(f"{target} ("))
        rest = (1 - sure) / (len(ids) - 1)
        return choice_answer({o: sure if o == right else rest for o in ids}, 0.9)
    return answer


def asked_question(prompt: str) -> str:
    return prompt.split("QUESTION: ", 1)[1].strip()


def test_every_answer_key_points_at_a_line_that_answers_it():
    qs = N.bank()["questions"]
    have = [q for q in qs if q["lines"]]
    assert len(have) >= 30 and len(qs) - len(have) >= 8
    assert len({q["q"] for q in qs}) == len(qs)
    for q in have:
        assert all(DOC.has(lid) for lid in q["lines"]), q
        assert any(q["quote"] in DOC.line(lid).text for lid in q["lines"]), (q["q"], q["lines"], q["quote"])


def test_the_constitution_is_numbered_line_by_line():
    assert len(DOC.lines) == 115 and not DOC.windowed and len(DOC.windows()) == 1
    assert DOC.lines[0].id == "L001" and DOC.lines[0].text.startswith("We the People")
    assert DOC.line("L013").text.startswith("No Person shall be a Senator")
    assert DOC.where("L013") == "Article I, Section 3 · The Senate"
    assert DOC.where("L115").startswith("Amendment X")
    assert DOC.jev_text("L045") == "L045 (Article I, Section 8 · The powers of Congress): " + DOC.line("L045").text
    numbered = DOC.numbered()
    assert numbered.startswith("[Preamble") and "\nL047: To provide and maintain a Navy;" in numbered
    # Near means the line beside an answer line, in the same section.
    assert DOC.near("L012", ["L013"]) and DOC.near("L014", ["L013"])
    assert not DOC.near("L015", ["L013"]) and not DOC.near("L010", ["L009"])


def test_a_text_models_line_is_read_forgivingly_but_never_invented():
    cases = {"L047": "L047", "l47": "L047", "Line 47": "L047", "**L047**": "L047", "NONE": NONE,
             "none.": NONE, "L999": None, "L116": None, "Article I": None, "": None, None: None}
    for said, want in cases.items():
        assert read_line_id(said, DOC) == want, said
    assert N.read_text_line("REASON: it says so.\nLINE: L013") == "L013"
    assert N.read_text_line("I think it is\nL013") == "L013"


def test_bands_picks_and_verdicts():
    assert [N.band(p) for p in (0.95, 0.7, 0.69, 0.35, 0.34, 0.0)] == [
        "answered", "answered", "partly", "partly", "absent", "absent"]
    assert N.jev_pick("L013", 0.8) == "L013" and N.jev_pick("L013", 0.5) == "L013"
    assert N.jev_pick("L013", 0.2) == NONE
    assert N.judge("L013", ["L013"], DOC) == "right"
    assert N.judge("L012", ["L013"], DOC) == "near"
    assert N.judge("L090", ["L013"], DOC) == "wrong"
    assert N.judge(NONE, ["L013"], DOC) == "missed"
    assert N.judge(NONE, [], DOC) == "right"
    assert N.judge("L013", [], DOC) == "wrong"
    assert N.judge(None, ["L013"], DOC) == "foul"
    assert N.judge("L013", None, DOC) == "unscored"
    assert sum(N.POINTS[v] for v in ("right", "near", "wrong")) == 2


def test_a_draw_mixes_in_questions_the_document_cannot_answer():
    five = N.draw(5, seed=3)
    assert len(five) == 5 and sum(1 for q in five if not q["lines"]) == 1
    assert [q["q"] for q in N.draw(5, seed=3)] == [q["q"] for q in five]
    assert sum(1 for q in N.draw(12, seed=1) if not q["lines"]) == 3
    assert all(q["lines"] for q in N.draw(2, seed=1))


def test_sentences_split_on_ends_not_on_abbreviations():
    s = sentences("Dr. Smith went to Washington, D.C. in 1990. He met J. R. R. Tolkien there! Was it real? Yes, e.g. mostly.")
    assert s == ["Dr. Smith went to Washington, D.C. in 1990.", "He met J. R. R. Tolkien there!", "Was it real?",
                 "Yes, e.g. mostly."]


def test_a_wikipedia_extract_becomes_lines_under_its_headings():
    extract = (
        "Mars is the fourth planet. It is red.\n\n\n== Name ==\nIt is named after a god.\n"
        "=== In other languages ===\nThe Greeks called it Ares.\n\n== Moons ==\n\n== See also ==\nVenus\n\n"
        "== References ==\nA book. Another book."
    )
    doc = split_extract("Mars", extract)
    assert [ln.text for ln in doc.lines] == ["Mars is the fourth planet.", "It is red.", "It is named after a god.",
                                            "The Greeks called it Ares."]
    assert list(doc.sections) == ["Mars · introduction", "Name", "Name · In other languages"]
    assert doc.where("L004") == "Name · In other languages" and not doc.windowed
    cut = split_extract("Long", " ".join(f"Sentence {i} is here." for i in range(50)), max_lines=20)
    assert len(cut.lines) == 20 and cut.cut


def test_jev_and_text_models_hunt_the_constitution(arcade):
    def reply(model, system, prompt):
        assert "THE DOCUMENT: The United States Constitution" in system and "L115:" in system
        key = KEY[asked_question(prompt)]
        if model == "test/a":
            return f"REASON: it says so.\nLINE: {key[0] if key else 'NONE'}"
        if model == "test/b":
            return "REASON: I think so.\nLINE: NONE"
        return "LINE: Article 99"
    arcade.jev.responder = jev_finds()
    arcade.text.responder = reply
    run = arcade.play("needle", ["jev", "test/a", "test/b", "test/c"], {"questions": 8, "seed": 4})
    assert run["status"] == "finished"
    qs = run["questions"]
    assert len(qs) == 8 and all(q["revealed"] and q["scored"] for q in qs)
    absent = sum(1 for q in qs if not q["answer"])
    assert absent == 2
    jev, good, none, foul = run["lanes"]
    assert jev["score"] == 16 and jev["right"] == 8 and jev["answered"] == 8
    assert [a["pick"] for a in jev["answers"]] == [q["answer"][0] if q["answer"] else NONE for q in qs]
    a0 = jev["answers"][0]
    assert a0["band"] in ("answered", "absent") and a0["ranked"][0]["option"] == a0["top"] and a0["heat"]
    assert good["score"] == 16 and good["fouls"] == 0
    assert none["score"] == absent * 2 - (8 - absent) and none["right"] == absent
    assert foul["fouls"] == 8 and foul["score"] == -8 and all(a["foul"] for a in foul["answers"])
    assert [m["verdict"] for m in foul["marks"]] == ["foul"] * 8
    # One request a question: a Choice over all 115 lines and the Noul, over one state.
    assert len(arcade.jev.requests) == 8
    req = arcade.jev.requests[0]
    assert set(req["state"]) == {"question", "lines"} and len(req["state"]["lines"]) == 115
    line_q, exists_q = req["questions"]["line"], req["questions"]["exists"]
    assert line_q["type"] == "choice" and len(line_q["criteria"]) == 115
    assert all(k.startswith("l") for k in line_q["criteria"])
    assert exists_q["type"] == "noul" and "`lines`" in exists_q["instructions"]["question"]
    # Text models read the document once, in the system prompt; only the question changes.
    assert len({p["system"] for p in arcade.text.prompts}) == 1


def test_an_answer_is_revealed_once_every_lane_has_given_its_own(arcade):
    arcade.jev.responder = jev_finds()
    arcade.text.responder = lambda m, s, p: "LINE: L013"
    run = arcade.play("needle", ["jev", "test/a"], {"questions": 3, "seed": 9})
    events = emitted(run["id"])
    for k in range(3):
        put = next(i for i, e in enumerate(events) if e["type"] == "put" and e["index"] == k)
        answers = [i for i, e in enumerate(events) if e["type"] == "lane_push" and e["key"] == "answers"
                   and e["item"]["q"] == k]
        assert len(answers) == 2 and max(answers) < put
        # Nothing streamed with an answer says whether it was right.
        assert all("verdict" not in events[i]["item"] for i in answers)
    assert all(e["item"]["answer"] is not None for e in events if e["type"] == "put")


def test_the_doc_and_questions_go_to_the_page_without_their_keys(arcade):
    arcade.jev.responder = jev_finds()
    r = arcade.start("needle", ["jev"], {"questions": 4, "seed": 2})
    assert r.status_code == 201
    body = r.json()
    assert len(body["lines"]) == 115 and body["lines"][12]["id"] == "L013" and body["doc"]["size"] == 115
    # A run's summary drops its lists: the document's lines stay out of the history listing.
    listed = arcade.client.get("/api/games/runs?game=needle").json()["runs"][0]
    assert "lines" not in listed and listed["doc"]["name"] == "The United States Constitution"
    assert all(q["answer"] is None and not q["revealed"] for q in body["questions"])
    assert body["bands"] == {"answered": 0.7, "partly": 0.35}
    arcade.wait(body["id"])


def long_article(n: int = 400):
    body = " ".join(f"Fact number {i} is about the long subject." for i in range(n))
    extract = f"The long subject is long. {body}\n\n== Moons ==\nThe long subject has two moons, Phobos and Deimos."
    return {"query": {"pages": [{"pageid": 9, "title": "Long subject", "extract": extract,
                                 "fullurl": "https://en.wikipedia.org/wiki/Long_subject"}]}}


def test_a_long_article_is_searched_window_first_then_line(arcade):
    arcade.wiki_answer = lambda params: long_article()
    seen: list = []

    def answer(qid, q, state):
        seen.append((qid, sorted(state)))
        if q["type"] == "noul":
            return noul_answer(0.8)
        ids = q["criteria"]
        if qid == "window":
            right = next(o for o, d in ids.items() if "Phobos" in d)
        else:
            right = next(o for o, d in ids.items() if "Phobos" in d)
        return choice_answer({o: (0.9 if o == right else 0.1 / (len(ids) - 1)) for o in ids})
    arcade.jev.responder = answer
    arcade.text.responder = lambda m, s, p: "LINE: L402"
    run = arcade.play("needle", ["jev", "test/a"],
                      {"source": "wikipedia", "title": "Long subject", "question": "How many moons does it have?"})
    assert run["status"] == "finished" and run["doc"]["windowed"] and len(run["lines"]) == 402
    jev, text = run["lanes"]
    a = jev["answers"][0]
    assert a["pick"] == "L402" and a["window"] is not None and a["window_p"]
    assert jev["calls"] == 2 and len(arcade.jev.requests) == 2
    first, second = arcade.jev.requests
    assert set(first["state"]) == {"question"} and list(first["questions"]) == ["window"]
    assert len(first["questions"]["window"]["criteria"]) == 11
    assert set(second["questions"]) == {"line", "exists"} and len(second["state"]["lines"]) <= 45
    assert len(second["questions"]["line"]["criteria"]) <= MAX_CHOICE
    # A typed question has no key: the answers are kept, not scored.
    assert run["questions"][0]["scored"] is False and run["questions"][0]["answer"] is None
    assert jev["score"] is None and text["score"] is None and text["answers"][0]["pick"] == "L402"
    assert jev["marks"][0]["verdict"] == "unscored"


def test_a_model_can_write_the_question_for_an_article(arcade):
    arcade.wiki_answer = lambda params: long_article(20)

    def reply(model, system, prompt):
        if system == N.ASKER_SYSTEM:
            assert "ARTICLE: Long subject" in prompt
            return "QUESTION: What are the long subject's moons called?"
        return "LINE: L022"
    arcade.text.responder = reply
    arcade.jev.responder = jev_finds()
    run = arcade.play("needle", ["test/a"], {"source": "wikipedia", "title": "Long subject", "asker": "openrouter:test/b"})
    assert run["questions"][0]["text"] == "What are the long subject's moons called?"
    assert run["asker"]["label"] == "test/b" and run["lanes"][0]["answers"][0]["pick"] == "L022"


def test_the_setup_is_checked(arcade):
    arcade.wiki_answer = lambda params: {"query": {"pages": [{"title": params["titles"], "missing": True}]}}
    r = arcade.start("needle", ["jev"], {"source": "wikipedia"})
    assert r.status_code == 400 and "name the Wikipedia article" in r.json()["detail"]
    r = arcade.start("needle", ["jev"], {"source": "wikipedia", "title": "Nowhere", "question": "Why?"})
    assert r.status_code == 400 and "No Wikipedia article" in r.json()["detail"]
    arcade.wiki_answer = lambda params: long_article(20)
    r = arcade.start("needle", ["jev"], {"source": "wikipedia", "title": "Long subject"})
    assert r.status_code == 400 and "type a question" in r.json()["detail"]
    r = arcade.start("needle", ["jev"], {"questions": 40})
    assert r.status_code == 422


def test_a_question_typed_over_the_constitution_is_played_unscored(arcade):
    arcade.jev.responder = jev_finds()
    run = arcade.play("needle", ["jev"], {"question": "How old must a senator be?"})
    assert len(run["questions"]) == 1 and run["questions"][0]["scored"] is False
    assert run["lanes"][0]["answers"][0]["pick"] == "L013" and run["lanes"][0]["score"] is None
