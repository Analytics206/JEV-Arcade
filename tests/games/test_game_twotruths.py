"""Two Truths and a Lie: a writer's three claims, Jev's three checks, the judges' picks."""
from __future__ import annotations

import json

from wikirace.games import runs
from wikirace.games import twotruths as T

from .conftest import choice_answer

INTRO = (
    "The axolotl (Ambystoma mexicanum) is a species of mole salamander. It is neotenic, reaching sexual "
    "maturity without undergoing metamorphosis, and the adults remain fully aquatic with obvious external gills.\n"
    "Axolotls originally inhabited a system of interconnected wetlands and lakes in the highlands of Mexico. "
    "They were known to inhabit the smaller lakes of Xochimilco and Chalco."
)
TRUE_1 = "Axolotls keep their external gills as adults."
TRUE_2 = "The axolotl is a kind of mole salamander."
LIE = "Wild axolotls first lived in the rivers of the Amazon basin."
WRITTEN = f"CLAIM 1: {TRUE_1}\nCLAIM 2: {LIE}\nCLAIM 3: {TRUE_2}\nLIE: 2\nWHY: The article puts them in lakes near Mexico City."


def emitted(run_id: str) -> list[dict]:
    """Every event the run emitted, in order."""
    return [json.loads(e[6:]) for e in runs.get_live(run_id).events]


def wiki(intro: str = INTRO):
    def answer(params):
        assert params["action"] == "query" and params["exintro"] == 1 and params["explaintext"] == 1
        if params["titles"] == "Nowhere at all":
            return {"query": {"pages": [{"title": "Nowhere at all", "missing": True}]}}
        return {"query": {"pages": [{"pageid": 1, "title": params["titles"], "extract": intro,
                                     "fullurl": "https://en.wikipedia.org/wiki/Axolotl"}]}}
    return answer


def jev_checks(state_log: list | None = None):
    """Jev: contradicted for the lie, supported for the rest."""
    def answer(qid, q, state):
        if state_log is not None:
            state_log.append(state)
        want = "contradicted" if state["claim"] == LIE else "supported"
        right = next(o for o, d in q["criteria"].items() if d.startswith(f"{want}:"))
        return choice_answer({o: (0.9 if o == right else 0.05) for o in q["criteria"]}, 0.85)
    return answer


def judges(writer_reply: str | list[str] = WRITTEN):
    replies = [writer_reply] if isinstance(writer_reply, str) else list(writer_reply)

    def reply(model, system, prompt):
        if system == T.WRITER_SYSTEM:
            return replies.pop(0) if len(replies) > 1 else replies[0]
        assert system == T.JUDGE_SYSTEM and "INTRODUCTION:" in prompt
        claims = {int(r[6]): r[9:] for r in prompt.splitlines() if r.startswith("CLAIM ")}
        lie_n = next(n for n, c in claims.items() if c == LIE)
        if model == "test/a":
            return f"REASON: the article puts them in Mexico.\nLIE: {lie_n}"
        if model == "test/b":
            return f"REASON: a hunch.\nLIE: {lie_n % 3 + 1}"
        return "REASON: none of them.\nLIE: all of them"
    return reply


def test_the_writers_reply_is_read_strictly():
    claims, lie, why = T.parse_claims(WRITTEN)
    assert claims == [TRUE_1, LIE, TRUE_2] and lie == 1 and why.startswith("The article")
    assert T.parse_claims(WRITTEN.replace("LIE: 2", "**LIE:** Claim 2"))[1] == 1
    for broken, why_ in [
        (WRITTEN.replace("CLAIM 3", "CLAIM THREE"), "no CLAIM 3"),
        (WRITTEN.replace("LIE: 2", "LIE: 4"), "LIE must be"),
        (WRITTEN.replace("LIE: 2\n", ""), "no LIE"),
        (WRITTEN.replace(TRUE_2, TRUE_1), "the same"),
        (WRITTEN.replace(TRUE_1, "Yes."), "characters"),
    ]:
        try:
            T.parse_claims(broken)
        except T.ClaimsError as exc:
            assert why_ in str(exc), (why_, exc)
        else:
            raise AssertionError(f"accepted: {why_}")
    assert [T.read_lie(v) for v in ("2", "Claim 3", "#1", "2.", "claim 4", "two", "", None)] == [1, 2, 0, 1, None, None, None, None]


def test_jev_picks_the_likeliest_contradiction_and_breaks_ties_on_absence():
    v = [{"supported": 0.9, "contradicted": 0.05, "not_in_article": 0.05},
         {"supported": 0.1, "contradicted": 0.6, "not_in_article": 0.3},
         {"supported": 0.2, "contradicted": 0.6, "not_in_article": 0.2}]
    assert T.jev_lie(v) == 1
    v[2]["not_in_article"] = 0.35
    assert T.jev_lie(v) == 2


def test_an_introduction_is_cleaned_and_cut_on_a_sentence():
    raw = "The axolotl ( ; from Nahuatl) is a salamander.  It  has gills.\n\nIt lives in Mexico."
    assert T.clean_intro(raw) == "The axolotl (from Nahuatl) is a salamander. It has gills.\n\nIt lives in Mexico."
    real = "The axolotl ( ; from Classical Nahuatl: āxōlōtl [aːˈʃoːloːtɬ] ; Ambystoma mexicanum) is a salamander."
    assert T.clean_intro(real) == "The axolotl (from Classical Nahuatl: āxōlōtl; Ambystoma mexicanum) is a salamander."
    assert T.clean_intro("It has [citation] notes, and (see below ; ) more.") == "It has [citation] notes, and (see below) more."
    long = " ".join(f"Sentence number {i} is about the axolotl." for i in range(80))
    cut = T.clean_intro(long)
    assert len(cut) <= T.INTRO_CHARS and cut.endswith(".")
    assert len(T.articles()) >= 40 and len(set(T.articles())) == len(T.articles())


def test_jev_and_the_judges_hunt_the_lie(arcade):
    states: list = []
    arcade.wiki_answer = wiki()
    arcade.jev.responder = jev_checks(states)
    arcade.text.responder = judges()
    r = arcade.start("twotruths", ["jev", "test/a", "test/b", "test/c"],
                     {"writer": "openrouter:test/d", "title": "Axolotl", "seed": 5})
    assert r.status_code == 201, r.text
    started = r.json()
    # The page gets the article and the shuffled claims, never which is the lie.
    assert started["lie"] is None and started["article"]["title"] == "Axolotl"
    assert sorted(c["text"] for c in started["claims"]) == sorted([TRUE_1, TRUE_2, LIE])
    run = arcade.wait(started["id"])
    assert run["status"] == "finished"
    lie = next(k for k, c in enumerate(run["claims"]) if c["text"] == LIE)
    assert run["lie"] == lie and run["why"].startswith("The article")
    jev, good, wrong, foul = run["lanes"]
    assert jev["pick"] == lie and jev["found"] is True and jev["score"] == 1
    assert [v["top"] for v in jev["verdicts"]] == ["contradicted" if k == lie else "supported" for k in range(3)]
    assert jev["verdicts"][lie]["contradicted"] == 0.9 and jev["requests"] == 3 and jev["calls"] == 1
    assert good["pick"] == lie and good["score"] == 1 and good["reason"].startswith("the article")
    assert wrong["pick"] != lie and wrong["score"] == 0 and wrong["found"] is False
    assert foul["pick"] is None and foul["fouls"] == 1 and foul["score"] == 0 and foul["said"] == "all of them"
    # Three Jev requests side by side, each over its own claim, under opaque ids.
    assert len(arcade.jev.requests) == 3
    assert sorted(s["claim"] for s in states) == sorted([TRUE_1, TRUE_2, LIE])
    assert all(set(s) == {"article", "claim"} and s["article"] == T.clean_intro(INTRO) for s in states)
    q = arcade.jev.requests[0]["questions"]["verdict"]
    assert q["type"] == "choice" and all(k.startswith("v") for k in q["criteria"])
    assert {d.split(":")[0] for d in q["criteria"].values()} == set(T.VERDICTS)
    # The writer is not a lane, but what it cost is on the run.
    assert run["writer"]["model_id"] == "test/d" and run["writer"]["attempts"] == 1
    assert run["writer"]["cost"] == 0.002 and run["writer"]["tokens_in"] == 200
    assert arcade.text.prompts[0]["system"] == T.WRITER_SYSTEM and "Axolotl" in arcade.text.prompts[0]["prompt"]


def test_the_lie_is_revealed_only_after_every_judge_has_answered(arcade):
    arcade.wiki_answer = wiki()
    arcade.jev.responder = jev_checks()
    arcade.text.responder = judges()
    run = arcade.play("twotruths", ["jev", "test/a"], {"writer": "openrouter:test/d", "title": "Axolotl"})
    events = emitted(run["id"])
    when = next(i for i, e in enumerate(events) if e["type"] == "patch" and e["patch"].get("lie") is not None)
    picks = [i for i, e in enumerate(events) if e["type"] == "lane" and "verdicts" in e["patch"] or
             e["type"] == "lane" and "reason" in e["patch"]]
    assert len(picks) == 2 and max(picks) < when
    assert not any("LIE:" in str(e) for e in events)


def test_a_malformed_writer_gets_one_retry(arcade):
    arcade.wiki_answer = wiki()
    arcade.jev.responder = jev_checks()
    arcade.text.responder = judges(["Here are some claims about axolotls!", WRITTEN])
    run = arcade.play("twotruths", ["jev"], {"writer": "openrouter:test/d", "title": "Axolotl"})
    assert run["status"] == "finished" and run["writer"]["attempts"] == 2 and run["writer"]["cost"] == 0.004
    assert "could not be read: there is no CLAIM 1 line" in arcade.text.prompts[1]["prompt"]


def test_a_writer_that_never_keeps_the_format_is_a_502_with_its_reason(arcade):
    arcade.wiki_answer = wiki()
    arcade.text.responder = judges(WRITTEN.replace("LIE: 2", "LIE: the second"))
    r = arcade.start("twotruths", ["jev"], {"writer": "openrouter:test/d", "title": "Axolotl"})
    assert r.status_code == 502 and "LIE must be 1, 2 or 3" in r.json()["detail"]
    assert len(arcade.text.prompts) == 2


def test_the_setup_is_checked(arcade):
    arcade.wiki_answer = wiki()
    arcade.text.responder = judges()
    r = arcade.start("twotruths", ["jev"], {"title": "Axolotl"})
    assert r.status_code == 400 and "text model to write" in r.json()["detail"]
    r = arcade.start("twotruths", ["jev"], {"writer": "typesafe:jev-1.13.0", "title": "Axolotl"})
    assert r.status_code == 400 and "must be a text model" in r.json()["detail"]
    r = arcade.start("twotruths", ["jev"], {"writer": "openrouter:test/d", "title": "Nowhere at all"})
    assert r.status_code == 400 and "No Wikipedia article" in r.json()["detail"]
    arcade.wiki_answer = wiki(intro="A stub.")
    r = arcade.start("twotruths", ["jev"], {"writer": "openrouter:test/d", "title": "Axolotl"})
    assert r.status_code == 400 and "too short" in r.json()["detail"]


def test_with_no_writer_named_the_first_text_judge_writes_and_a_seed_draws_the_article(arcade):
    asked: list = []

    def answer(params):
        asked.append(params["titles"])
        return wiki()(params)
    arcade.wiki_answer = answer
    arcade.jev.responder = jev_checks()
    arcade.text.responder = judges()
    run = arcade.play("twotruths", ["jev", "test/a"], {"seed": 11})
    again = arcade.play("twotruths", ["jev", "test/a"], {"seed": 11})
    assert run["writer"]["model_id"] == "test/a"
    assert asked[0] == asked[1] and asked[0] in T.articles()
    assert [c["text"] for c in run["claims"]] == [c["text"] for c in again["claims"]]
