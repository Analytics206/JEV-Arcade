"""WikiGuessr: a redacted article, three levels to claim, and knowing where to stop."""
from __future__ import annotations

import asyncio
import json
import re
import time
from itertools import combinations

from wikirace.games import runs
from wikirace.games import wikiguessr as W
from wikirace.providers.base import Completion
from wikirace.race.wiki import WikiError

from .conftest import choice_answer

ROQ = "Roquefort-sur-Soulzon"
ROQ_INTRO = (
    "Roquefort-sur-Soulzon (French pronunciation: [ʁɔkfɔʁ]; Occitan: Ròcafòrt de Solson) is a commune in the "
    "department of Aveyron, and the region of Occitania, southern France. It is known for Roquefort cheese, a "
    "sheep's-milk cheese that takes its name from the commune.\n\nThe village lies below the Causse du Larzac, "
    "a short drive from Millau, and its caves keep a steady cool draught."
)
LINKS = {ROQ: ["Aveyron", "Occitania (administrative region)", "France", "Roquefort cheese", "Millau",
               "Causse du Larzac", "Sheep"]}
INFO = {
    "Aveyron": {"coordinates": [{"lat": 44.25, "lon": 2.7}], "description": "Department in Occitania, France"},
    "Millau": {"coordinates": [{"lat": 44.1, "lon": 3.08}], "description": "Commune in Aveyron, France"},
    "Causse du Larzac": {"coordinates": [{"lat": 43.9, "lon": 3.2}], "description": "Limestone plateau in France"},
    "Roquefort cheese": {"description": "French blue cheese"},
    "Sheep": {"description": "Domesticated ruminant mammal"},
}
ROUNDS = W.data()["rounds"]


def intro_of(title: str) -> str:
    """Any round's introduction: Roquefort's own, or one naming its place (and
    its number in the list, so a fake Jev can find the answer)."""
    if title == ROQ:
        return ROQ_INTRO
    k = next(i for i, r in enumerate(ROUNDS) if r["title"] == title)
    r = ROUNDS[k]
    where = ", ".join(x for x in (r["region"], r["country"], r["continent"]) if x)
    return f"{title} is place number {k} of the list. It lies in {where}, and people come to see it."


def fake_wiki(requests: list | None = None, fail: bool = False):
    def answer(params):
        if requests is not None:
            requests.append(params)
        if fail:
            raise WikiError("Wikipedia answered HTTP 503")
        titles = params["titles"].split("|")
        if params["prop"] == "extracts":
            assert params["exintro"] and params["explaintext"] and len(titles) <= 20
            return {"query": {"pages": [{"ns": 0, "title": t, "extract": intro_of(t)} for t in titles]}}
        if params["prop"] == "links":
            (t,) = titles
            return {"query": {"pages": [{"title": t, "links": [{"ns": 0, "title": x} for x in LINKS.get(t, [])]}]}}
        if params["prop"] == "coordinates|description":
            assert len(titles) <= 50
            return {"query": {"pages": [{"title": t, **INFO.get(t, {})} for t in titles]}}
        raise AssertionError(params)
    return answer


def truth_of(article: str) -> dict:
    m = re.search(r"place number (\d+) of the list", article)
    return ROUNDS[int(m.group(1))] if m else W.round_by_title(ROQ)


def jev_knows(conf=(0.9, 0.9, 0.9), p=0.8, region=None):
    """Jev, putting *p* on the right option at every level (or on *region*
    at the third), with these confidences."""
    def answer(qid, q, state):
        truth = truth_of(state["article"])
        crit = q["criteria"]
        if qid == "continent":
            right = next(o for o, d in crit.items() if d.startswith(truth["continent"] + ":"))
            c = conf[0]
        elif qid == "country":
            right = next(o for o, d in crit.items() if d.startswith(f"{truth['country']} ("))
            c = conf[1]
        else:
            want = f"{region or truth['region']} (a region of {truth['country']})"
            right = next(o for o, d in crit.items() if d == want)
            c = conf[2]
        rest = (1 - p) / (len(crit) - 1)
        return choice_answer({o: p if o == right else rest for o in crit}, c)
    return answer


ONE = {"rounds": 1, "title": ROQ, "pause_ms": 0}


# ── The data and the pure parts ───────────────────────────────────────────────


def test_the_data_hangs_together():
    d = W.data()
    assert W.continents() == ("Africa", "Antarctica", "Asia", "Europe", "North America", "Oceania", "South America")
    names = [c["name"] for c in d["countries"]]
    assert len(names) == len(set(names)) == 197
    assert len({c["code"] for c in d["countries"]}) == 197
    for cont in d["continents"]:
        tiles = [tuple(c["tile"]) for c in d["countries"] if c["continent"] == cont["name"]]
        assert len(tiles) == len(set(tiles)), cont["name"]
        assert all(0 <= x < cont["grid"][0] and 0 <= y < cont["grid"][1] for x, y in tiles)
        assert bool(tiles) == (cont["name"] != "Antarctica")
    assert len(ROUNDS) >= 60 and {r["continent"] for r in ROUNDS} == set(W.continents())
    for r in ROUNDS:
        if r["continent"] == "Antarctica":
            assert r["country"] is None and r["region"] is None
            continue
        assert W.country_info()[r["country"]]["continent"] == r["continent"], r
        assert r["region"] in W.regions_of(r["country"]), r
    # Every level's question fits in one choice, whichever beam Jev keeps.
    sizes = sorted((len(W.countries_of(c)) for c in W.continents()), reverse=True)
    assert sum(sizes[:3]) + 1 <= 255
    regions = sorted((len(W.regions_of(c)) for c in d["regions"]), reverse=True)
    assert sum(regions[:3]) <= 255


def test_redaction_hides_every_name_char_for_char():
    r = W.build_round(W.round_by_title(ROQ), ROQ_INTRO, ["Aveyron", "Millau"])
    art = r["article"]
    assert len(art) == len(W.trim_intro(ROQ_INTRO)) and "\n\n" not in art
    for gone in ("Roquefort", "Soulzon", "France", "French", "Occitania", "Aveyron", "Millau"):
        assert gone not in art, gone
    for kept in ("cheese", "Occitan:", "Causse du Larzac", "commune", "sheep"):
        assert kept in art, kept
    assert r["blocks"] >= 7 and W.BLOCK * len("Aveyron") in art
    assert r["truth"] == {
        "title": ROQ, "url": "https://en.wikipedia.org/wiki/Roquefort-sur-Soulzon",
        "continent": "Europe", "country": "France", "region": "Occitania",
    }


def test_redaction_forgives_accents_but_not_case_or_word_edges():
    text, n = W.redact("From Yucatan to Nigeria, Niger and the Nigerians; a turkey in Turkey.",
                       ["Yucatán", "Niger", "Nigeria", "Nigerian", "Turkey"])
    assert "Yucatan" not in text and "Niger " not in text and "Nigeria," not in text
    assert "Nigerians" in text  # a plural is its own name
    assert "a turkey in" in text and "Turkey." not in text
    assert n == 4 and len(text) == len("From Yucatan to Nigeria, Niger and the Nigerians; a turkey in Turkey.")
    # The world's names hide the plural demonyms too.
    text, _ = W.redact("Europeans and Brazilians", W.world_names())
    assert "Europeans" not in text and "Brazilians" not in text
    # A title's long words hide as prefixes: Hallstatt's lake is Hallstätter See.
    names, prefixes = W.title_names("Hallstatt")
    text, _ = W.redact("Hallstatt lies on the Hallstätter See.", names, prefixes)
    assert text.count(W.BLOCK) == len("Hallstatt") + len("Hallstätter") and "See" in text


def test_linked_places_are_hidden_but_features_of_the_land_are_clues():
    assert W.is_place(INFO["Millau"]) and W.is_place(INFO["Aveyron"])
    assert not W.is_place(INFO["Causse du Larzac"])  # a plateau
    assert not W.is_place({"coordinates": [{}], "description": "Mountain in Austria"})
    assert not W.is_place(INFO["Roquefort cheese"])  # not on a map
    assert W.core_name("Bolívar (state)") == "Bolívar" and W.core_name("Toledo, Spain") == "Toledo"


def test_a_text_models_claim_is_read_level_by_level():
    rc = W.read_claim
    assert rc("CONTINENT: Europe\nCOUNTRY: france\nREGION: Occitanie\nREASON: the cheese")["claim"] == [
        "Europe", "France", "Occitania"]
    assert rc("CONTINENT: Europe\nCOUNTRY: France\nREGION: unsure")["claim"] == ["Europe", "France"]
    assert rc("CONTINENT: Europe\nREGION: Occitania")["claim"] == ["Europe"]  # no country: nothing deeper
    c = rc("CONTINENT: the Americas\nCOUNTRY: USA")
    assert c["claim"] == [] and c["fouls"] == ["continent"]
    c = rc("CONTINENT: Europe\nCOUNTRY: England\nREGION: Kent")
    assert c["claim"] == ["Europe"] and c["fouls"] == ["country"]
    c = rc("CONTINENT: Europe\nCOUNTRY: France\nREGION: Aveyron")  # a department, not a region
    assert c["claim"] == ["Europe", "France"] and c["fouls"] == ["region"]
    assert rc("CONTINENT: Asia\nCOUNTRY: Viet Nam\nREGION: Quang Ninh province")["claim"][2] == "Quảng Ninh"
    assert rc("CONTINENT: Europe\nCOUNTRY: Germany\nREGION: Bavaria, Germany")["claim"][2] == "Bavaria"
    assert rc("CONTINENT: North America\nCOUNTRY: USA\nREGION: Washington, D.C.")["claim"][2] == "District of Columbia"
    assert rc("**CONTINENT:** Antarctica\nCOUNTRY: none")["claim"] == ["Antarctica"]


def test_scoring_and_the_beam():
    roq = W.round_by_title(ROQ)
    assert W.points([], roq) == (0, [])
    assert W.points(["Europe"], roq) == (1, ["right"])
    assert W.points(["Europe", "France"], roq) == (4, ["right", "right"])
    assert W.points(["Europe", "France", "Occitania"], roq) == (10, ["right", "right", "right"])
    assert W.points(["Europe", "France", "Nouvelle-Aquitaine"], roq) == (-2, ["right", "right", "wrong"])
    assert W.points(["Asia", "France", "Occitania"], roq) == (-6, ["wrong"])
    erebus = W.round_by_title("Mount Erebus")
    assert W.points(["Antarctica"], erebus) == (1, ["right"])
    assert W.points(["Antarctica", "Chile"], erebus) == (-5, ["right", "wrong"])
    ranked = W.rank_paths({("A", "x"): 0.9 * 0.5, ("B", "y"): 0.1 * 0.9, ("A", "z"): 0.9 * 0.01})
    assert [p for p, _ in ranked] == [("A", "x"), ("B", "y"), ("A", "z")]
    assert abs(ranked[0][1] - (0.45 ** 0.5)) < 1e-9


# ── Whole rounds ──────────────────────────────────────────────────────────────


def test_a_sure_jev_claims_all_three_levels(arcade):
    arcade.wiki_answer = fake_wiki(asked := [])
    arcade.jev.responder = jev_knows((0.9, 0.85, 0.8))
    run = arcade.play("wikiguessr", ["jev"], ONE)
    assert run["status"] == "finished", run["note"]
    lane = run["lanes"][0]
    (claim,) = lane["claims"]
    assert claim["claim"] == ["Europe", "France", "Occitania"] and claim["stopped_at"] is None
    assert [lv["level"] for lv in claim["levels"]] == [1, 2, 3]
    assert lane["score"] == 10 and lane["busts"] == 0 and lane["played"] == 1 and lane["calls"] == 3
    # Three questions, one a level, over the redacted article, under opaque ids.
    reqs = arcade.jev.requests
    assert [list(r["questions"]) for r in reqs] == [["continent"], ["country"], ["region"]]
    art = run["rounds"][0]["article"]
    assert all(r["state"] == {"article": art} for r in reqs) and "France" not in art and "Aveyron" not in art
    assert len(reqs[0]["questions"]["continent"]["criteria"]) == 7
    level2 = reqs[1]["questions"]["country"]["criteria"]
    top3 = [p["path"][0] for p in claim["levels"][0]["paths"]]
    assert len(top3) == 3 and len(level2) == sum(len(W.countries_of(c)) for c in top3) + ("Antarctica" in top3)
    assert all(re.fullmatch(r"n\d+", k) for k in level2)
    level3 = reqs[2]["questions"]["region"]["criteria"]
    assert "Occitania (a region of France)" in level3.values()
    assert claim["levels"][1]["map"]["France"] == 0.8
    assert [p["path"] for p in claim["levels"][2]["paths"]][0] == ["Europe", "France", "Occitania"]
    # The reveal: the answer, and each lane's points.
    rnd = run["rounds"][0]
    assert rnd["answer"]["title"] == ROQ and rnd["results"] == [
        {"lane": 0, "claim": ["Europe", "France", "Occitania"], "points": 10, "marks": ["right"] * 3}]
    assert len(run["map"]) == 197 and run["total"] == 1
    # Wikipedia: one read of the intros, one of the links, one of the linked places.
    assert [a["prop"] for a in asked] == ["extracts", "links", "coordinates|description"]


def test_jev_stops_at_the_first_level_it_is_unsure_of(arcade):
    arcade.wiki_answer = fake_wiki()
    arcade.jev.responder = jev_knows((0.9, 0.8, 0.3))
    run = arcade.play("wikiguessr", ["jev"], ONE)
    (claim,) = run["lanes"][0]["claims"]
    assert claim["claim"] == ["Europe", "France"] and claim["stopped_at"] == 3
    assert run["lanes"][0]["score"] == 4


def test_an_unsure_continent_claims_nothing_and_asks_no_further(arcade):
    arcade.wiki_answer = fake_wiki()
    arcade.jev.responder = jev_knows((0.2, 0.9, 0.9))
    run = arcade.play("wikiguessr", ["jev"], {**ONE, "threshold": 0.5})
    (claim,) = run["lanes"][0]["claims"]
    assert claim["claim"] == [] and claim["stopped_at"] == 1 and len(arcade.jev.requests) == 1
    assert run["lanes"][0]["score"] == 0 and run["rounds"][0]["results"][0]["points"] == 0


def test_the_best_path_can_overrule_the_top_continent(arcade):
    """The rollup: Asia edges Europe at level 1, but France is so likely at
    level 2 that Europe › France is the best path, and it is claimed."""
    arcade.wiki_answer = fake_wiki()

    def answer(qid, q, state):
        crit = q["criteria"]
        if qid == "continent":
            probs = {o: 0.5 if d.startswith("Asia:") else 0.4 if d.startswith("Europe:") else 0.1 / 5
                     for o, d in crit.items()}
            return choice_answer(probs, 0.6)
        if qid == "country":
            probs = {o: 0.9 if d == "France (Europe)" else 0.1 / (len(crit) - 1) for o, d in crit.items()}
            return choice_answer(probs, 0.9)
        return choice_answer({o: 0.6 if d.startswith("Occitania") else 0.4 / (len(crit) - 1) for o, d in crit.items()}, 0.2)
    arcade.jev.responder = answer
    run = arcade.play("wikiguessr", ["jev"], ONE)
    (claim,) = run["lanes"][0]["claims"]
    assert claim["levels"][0]["top"][0]["option"] == "Asia"
    assert claim["claim"] == ["Europe", "France"] and claim["stopped_at"] == 3
    assert run["lanes"][0]["score"] == 4


def test_text_models_claim_over_claim_and_foul(arcade):
    arcade.wiki_answer = fake_wiki()

    def reply(model, system, prompt):
        return {
            "test/a": "CONTINENT: Europe\nCOUNTRY: France\nREGION: Occitania\nREASON: blue cheese in caves",
            "test/b": "CONTINENT: Europe\nCOUNTRY: France\nREGION: Nouvelle-Aquitaine\nREASON: southern France",
            "test/c": "CONTINENT: Americas\nCOUNTRY: France\nREASON: guessing",
            "test/d": "CONTINENT: Europe\nCOUNTRY: unsure\nREGION: unsure\nREASON: not sure",
        }[model]
    arcade.text.responder = reply
    run = arcade.play("wikiguessr", ["test/a", "test/b", "test/c", "test/d"], ONE)
    a, b, c, d = run["lanes"]
    assert (a["score"], b["score"], c["score"], d["score"]) == (10, -2, 0, 1)
    assert (a["fouls"], b["fouls"], c["fouls"], d["fouls"]) == (0, 0, 1, 0)
    assert b["busts"] == 1 and a["busts"] == 0
    assert c["claims"][0]["fouls"] == ["continent"] and c["claims"][0]["said"]["continent"] == "Americas"
    assert a["claims"][0]["reason"] == "blue cheese in caves" and a["calls"] == 1 and a["cost"] > 0
    sent = arcade.text.prompts[0]
    assert sent["prompt"].startswith("ARTICLE:\n") and "France" not in sent["prompt"]
    for part in ("CONTINENT:", "COUNTRY:", "REGION:", "REASON:", "right region +6", "costs 6 points",
                 "Europe: ", "Papua New Guinea"):
        assert part in sent["system"], part


def test_the_answer_stays_private_until_every_lane_has_claimed(arcade):
    arcade.wiki_answer = fake_wiki()
    arcade.jev.responder = jev_knows()
    arcade.text.responder = lambda m, s, p: "CONTINENT: Europe\nCOUNTRY: France\nREGION: Occitania\nREASON: x"
    r = arcade.start("wikiguessr", ["jev", "test/a"], {"rounds": 1, "seed": 11, "pause_ms": 0})
    assert r.status_code == 201
    run = arcade.wait(r.json()["id"])
    answer = run["rounds"][0]["answer"]
    assert answer["title"] not in r.text and '"answer": null' not in r.text
    events = [json.loads(e[6:]) for e in runs.get_live(run["id"]).events]
    reveal = next(i for i, e in enumerate(events) if e["type"] == "put" and e["key"] == "rounds")
    claims = [i for i, e in enumerate(events) if e["type"] == "lane_push" and e["key"] == "claims"]
    assert len(claims) == 2 and max(claims) < reveal
    assert all(answer["title"] not in json.dumps(e, ensure_ascii=False) for e in events[:reveal])
    assert events[reveal]["item"]["answer"] == answer


def test_rounds_follow_one_another_and_the_scores_add_up(arcade):
    arcade.wiki_answer = fake_wiki()
    arcade.jev.responder = jev_knows((0.9, 0.9, 0.4))
    arcade.text.responder = lambda m, s, p: "CONTINENT: Asia\nCOUNTRY: unsure\nREASON: x"
    run = arcade.play("wikiguessr", ["jev", "test/a"], {"rounds": 3, "seed": 4, "pause_ms": 0})
    assert run["status"] == "finished" and run["total"] == 3 and run["round"] == 2
    assert len(run["rounds"]) == 3 and all(rd["answer"] for rd in run["rounds"])
    titles = [rd["answer"]["title"] for rd in run["rounds"]]
    assert len(set(titles)) == 3
    for ln in run["lanes"]:
        assert [c["round"] for c in ln["claims"]] == [0, 1, 2] and ln["played"] == 3
        assert ln["score"] == sum(res["points"] for rd in run["rounds"] for res in rd["results"] if res["lane"] == ln["index"])
    # Jev stopped at the country each time (unsure of the region); an Antarctic
    # round has no country, so it claims the continent only.
    jev = run["lanes"][0]
    assert all(res["points"] in (1, 4) for rd in run["rounds"] for res in rd["results"] if res["lane"] == 0)
    assert jev["busts"] == 0
    # The same seed draws the same articles.
    again = arcade.play("wikiguessr", ["jev"], {"rounds": 3, "seed": 4, "pause_ms": 0})
    assert [rd["answer"]["title"] for rd in again["rounds"]] == titles


def test_a_lane_that_fails_does_not_hold_up_the_others(arcade):
    arcade.wiki_answer = fake_wiki()
    arcade.jev.fail = RuntimeError("the judge is out")
    arcade.text.responder = lambda m, s, p: "CONTINENT: Europe\nCOUNTRY: France\nREASON: x"
    run = arcade.play("wikiguessr", ["jev", "test/a"], {**ONE, "rounds": 2})
    jev, text = run["lanes"]
    assert run["status"] == "finished" and jev["status"] == "error" and "judge is out" in jev["note"]
    assert text["status"] == "done" and len(text["claims"]) == 2 and len(run["rounds"]) == 2


def test_a_stopped_game_reveals_the_round_it_was_on(arcade):
    arcade.wiki_answer = fake_wiki()

    class Slow:
        config = arcade.app.state.providers["openrouter"].config

        async def complete(self, model, system, prompt, **kw):
            await asyncio.sleep(10)
            return Completion(text="CONTINENT: Europe", model=model, tokens_in=1, tokens_out=1)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    r = arcade.start("wikiguessr", ["test/a"], ONE)
    run_id = r.json()["id"]
    deadline = time.monotonic() + 5
    while not arcade.client.get(f"/api/games/runs/{run_id}").json()["rounds"]:
        assert time.monotonic() < deadline
        time.sleep(0.02)
    assert arcade.client.post(f"/api/games/runs/{run_id}/stop").status_code == 202
    run = arcade.wait(run_id)
    assert run["status"] == "stopped" and run["rounds"][0]["answer"]["title"] == ROQ
    assert run["rounds"][0]["results"] == []


def test_a_title_off_the_list_is_refused_and_a_silent_wikipedia_is_a_502(arcade):
    arcade.wiki_answer = fake_wiki()
    r = arcade.start("wikiguessr", ["jev"], {"title": "Atlantis"})
    assert r.status_code == 400 and "Atlantis" in r.json()["detail"]
    assert arcade.start("wikiguessr", ["jev"], {"rounds": 9}).status_code == 422
    arcade.wiki_answer = fake_wiki(fail=True)
    r = arcade.start("wikiguessr", ["jev"], ONE)
    assert r.status_code == 502 and "503" in r.json()["detail"]


def test_every_pair_of_level_questions_stays_under_the_choice_ceiling():
    conts = [c for c in W.continents() if W.countries_of(c)]
    worst = max(sum(len(W.countries_of(c)) for c in trio) for trio in combinations(conts, 3))
    assert worst + 1 <= 255
