"""The Big Sort: random articles in batches of twenty, one small push per answer."""
from __future__ import annotations

import asyncio
import itertools
import json

from wikirace.games import bigsort as B
from wikirace.games import runs
from wikirace.providers.base import Completion
from wikirace.race.wiki import WikiError

from .conftest import choice_answer

#: An opening per topic, by topic index, and a word that gives it away.
TEXTS = [
    ("science", "{t} is a programming language designed for numerical computing."),
    ("people", "{t} (born 1970) is an English footballer who played as a defender."),
    ("places", "{t} is a village in the administrative district of Gmina Wola, Poland."),
    ("arts", "{t} is the third studio album by the rock band The Lemons, released in 1999."),
    ("history", "The Battle of {t} was fought in 1644 during the English Civil War."),
    ("sport", "The 1987 {t} Cup was the fourth edition of the tournament, a football competition."),
    ("nature", "{t} is a species of moth of the family Tortricidae."),
    ("other", "{t} Ltd is a company based in Leeds that makes kitchen scales."),
]
KEYS = [t["key"] for t in B.topics()]


def random_wiki(requests: list | None = None):
    """Wikipedia's random generator: twenty pages a request, now and then a
    disambiguation page, an empty extract, or a title seen before."""
    counter = itertools.count()

    def answer(params):
        if requests is not None:
            requests.append(params)
        assert params["generator"] == "random" and params["grnnamespace"] == 0
        assert params["grnlimit"] == 20 and params["exlimit"] == 20 and params["exsentences"] == 2
        pages = []
        for _ in range(20):
            k = next(counter)
            if k % 10 == 3:
                pages.append({"title": f"Thing {k} (disambiguation)", "pageprops": {"disambiguation": ""},
                              "extract": f"Thing {k} may refer to:"})
            elif k % 10 == 7:
                pages.append({"title": f"Stub {k}", "extract": ""})
            elif k % 10 == 9:
                pages.append({"title": "Article 0", "extract": "A repeat."})
            else:
                pages.append({"title": f"Article {k}", "extract": TEXTS[k % 8][1].format(t=f"Article {k}")})
        return {"batchcomplete": True, "query": {"pages": pages}}
    return answer


def topic_of(text: str) -> str:
    return next(key for key, tmpl in TEXTS if tmpl.split("{t}")[-1][:25] in text)


def jev_sorts(p: float = 0.9):
    def answer(qid, q, state):
        want = topic_of(state["intro"])
        name = next(t["name"] for t in B.topics() if t["key"] == want)
        right = next(o for o, c in q["criteria"].items() if c["what"].startswith(name + ":"))
        rest = (1 - p) / (len(q["criteria"]) - 1)
        return choice_answer({o: p if o == right else rest for o in q["criteria"]}, 0.8)
    return answer


def said_topic(prompt: str) -> str:
    return next(t["name"] for t in B.topics() if t["key"] == topic_of(prompt))


# ── The pure parts ────────────────────────────────────────────────────────────


def test_eight_topics_and_how_a_reply_names_one():
    assert KEYS == ["science", "people", "places", "arts", "nature", "history", "sport", "other"]
    assert all(set(B.criterion(t)) == {"what", "not_for"} for t in B.topics())
    assert B.read_topic("TOPIC: science & tech") == (0, "science & tech")
    assert B.read_topic("**TOPIC:** Science and Tech") == (0, "Science and Tech")
    assert B.read_topic("thinking…\nnature & living things.")[0] == 4
    assert B.read_topic("TOPIC: sport")[0] == 6
    assert B.read_topic("TOPIC: Miscellaneous") == (None, "Miscellaneous")
    assert B.read_topic("") == (None, None)
    for part in ("TOPIC:", "science & tech", "not for:", "nature & living things"):
        assert part in B.text_system()


def test_agreement_counts_only_articles_both_sorted():
    a = {0: 1, 1: 2, 2: 3, 3: 0, 4: 5}
    b = {0: 1, 1: 2, 2: 4, 3: B.FOUL, 9: 1}
    r = B.agreement(a, b, 8)
    assert (r["both"], r["agree"], r["rate"]) == (3, 2, round(2 / 3, 4))
    assert r["confusion"][1][1] == 1 and r["confusion"][3][4] == 1 and sum(map(sum, r["confusion"])) == 3
    assert B.agreement({}, {}, 8)["rate"] is None
    assert B.pairs(["judgment", "text", "text"]) == [(0, 1), (0, 2)]
    assert B.pairs(["text", "judgment"]) == [(1, 0)]
    assert B.pairs(["text", "text"]) == [(0, 1)]


def test_usable_pages_and_trimmed_openings():
    assert not B.usable({"title": "X", "extract": "X may refer to: a"})
    assert not B.usable({"title": "X", "pageprops": {"disambiguation": ""}, "extract": "A long enough extract."})
    assert not B.usable({"title": "X", "extract": "  "})
    assert B.usable({"title": "X", "extract": "X is a village in Poland, near Y."})
    long = "word " * 200
    assert len(B.clean_text(long)) <= B.TEXT_MAX + 1 and B.clean_text(long).endswith("…")


# ── Whole games ───────────────────────────────────────────────────────────────


def test_the_round_is_drawn_twenty_at_a_time(arcade):
    arcade.wiki_answer = random_wiki(asked := [])
    arcade.jev.responder = jev_sorts()
    r = arcade.start("bigsort", ["jev"], {"count": 50})
    assert r.status_code == 201, r.text
    items = r.json()["items"]
    titles = [it["title"] for it in items]
    assert len(items) == 50 == r.json()["total"] and len(set(titles)) == 50
    assert not any("disambiguation" in t or t.startswith("Stub") for t in titles)
    # Seven usable pages in ten: 50 articles take four requests, not three.
    assert len(asked) <= 6 and len(asked) * 20 >= 50
    arcade.wait(r.json()["id"])


def test_jev_sorts_every_article_one_push_each(arcade):
    arcade.wiki_answer = random_wiki()
    arcade.jev.responder = jev_sorts()
    r = arcade.start("bigsort", ["jev"], {"count": 60, "concurrency": 8})
    run = arcade.wait(r.json()["id"])
    assert run["status"] == "finished", run["note"]
    lane = run["lanes"][0]
    assert lane["status"] == "done" and lane["sorted"] == 60 == lane["score"] and lane["calls"] == 60
    assert sorted(k for k, *_ in lane["labels"]) == list(range(60))
    for k, topic, p in lane["labels"]:
        assert KEYS[topic] == topic_of(run["items"][k]["text"]) and p == 0.9
    assert sum(lane["topics"]) == 60 and lane["fouls"] == 0
    assert lane["cost"] > 0 and abs(lane["projected_cost"] - lane["cost"]) < 1e-9
    assert lane["rate"] > 0 and lane["in_flight"] == 0 and lane["tokens_in"] == 60 * 100
    # One question of eight topics per article, under opaque ids, over the two fields it needs.
    reqs = arcade.jev.requests
    assert len(reqs) == 60 and all(list(q["questions"]) == ["topic"] for q in reqs)
    assert all(set(q["state"]) == {"title", "intro"} for q in reqs)
    crit = reqs[0]["questions"]["topic"]["criteria"]
    assert len(crit) == 8 and all(k.startswith("t") for k in crit)
    # The stream: a push per answer, and a handful of counter updates besides.
    events = [json.loads(e[6:]) for e in runs.get_live(run["id"]).events]
    pushes = [e for e in events if e["type"] == "lane_push"]
    assert len(pushes) == 60 and all(e["key"] == "labels" and len(e["item"]) == 3 for e in pushes)
    assert sum(1 for e in events if e["type"] == "lane") < 15


def test_a_text_model_sorts_slower_fouls_and_is_compared_with_jev(arcade):
    arcade.wiki_answer = random_wiki()
    arcade.jev.responder = jev_sorts()
    calls = itertools.count()

    def reply(model, system, prompt):
        if model == "test/a":
            return f"TOPIC: {said_topic(prompt)}"
        n = next(calls)
        if n % 4 == 0:
            return "TOPIC: miscellany"
        return "TOPIC: other" if n % 4 == 1 else f"TOPIC: {said_topic(prompt)}"
    arcade.text.responder = reply
    r = arcade.start("bigsort", ["jev", "test/a", "test/b"], {"count": 40, "text_concurrency": 3})
    run = arcade.wait(r.json()["id"])
    jev, good, sloppy = run["lanes"]
    assert jev["sorted"] == good["sorted"] == 40 and good["fouls"] == 0
    assert sloppy["fouls"] == 10 and sloppy["sorted"] == 30 and sloppy["score"] == 30 and sloppy["calls"] == 40
    fouled = [x for x in sloppy["labels"] if x[1] == B.FOUL]
    assert len(fouled) == 10 and all(x[3] == "miscellany" for x in fouled)
    assert good["cost"] == 40 * 0.002 and abs(good["projected_cost"] - good["cost"]) < 1e-9
    agree = {(a["a"], a["b"]): a for a in run["agreement"]}
    assert set(agree) == {(0, 1), (0, 2)}
    assert (agree[(0, 1)]["both"], agree[(0, 1)]["rate"]) == (40, 1.0)
    assert agree[(0, 2)]["both"] == 30 and agree[(0, 2)]["agree"] < 30
    assert sum(map(sum, agree[(0, 2)]["confusion"])) == 30
    sent = next(p for p in arcade.text.prompts if p["model"] == "test/a")
    assert sent["prompt"].startswith("TITLE: ") and "\nINTRO: " in sent["prompt"] and "TOPIC:" in sent["system"]


def test_the_time_limit_stops_a_slow_lane_where_it_is(arcade):
    arcade.wiki_answer = random_wiki()
    arcade.jev.responder = jev_sorts()

    class Slow:
        config = arcade.app.state.providers["openrouter"].config

        async def complete(self, model, system, prompt, **kw):
            await asyncio.sleep(0.25)
            return Completion(text=f"TOPIC: {said_topic(prompt)}", model=model, tokens_in=50, tokens_out=3,
                              cost=0.001)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    r = arcade.start("bigsort", ["jev", "test/a"], {"count": 40, "time_limit_s": 1, "text_concurrency": 2})
    run = arcade.wait(r.json()["id"])
    jev, slow = run["lanes"]
    assert run["status"] == "finished" and jev["sorted"] == 40 and not jev["timed_out"]
    assert slow["status"] == "done" and slow["timed_out"] and 2 <= slow["sorted"] < 40
    assert "time's up" in slow["note"] and slow["calls"] == slow["sorted"]
    assert slow["projected_cost"] == round(slow["cost"] / slow["sorted"] * 40, 6)


def test_jev_keeps_its_questions_in_flight_up_to_the_concurrency(arcade):
    arcade.wiki_answer = random_wiki()
    seen = {"now": 0, "max": 0}

    class SlowJev:
        async def aclose(self):
            return None

        async def discover(self):
            return None

        async def ask(self, model, state, questions, *, timeout=60.0):
            seen["now"] += 1
            seen["max"] = max(seen["max"], seen["now"])
            await asyncio.sleep(0.02)
            seen["now"] -= 1
            answers = {qid: jev_sorts()(qid, q, state) for qid, q in questions.items()}
            return {"model": model, "answers": answers, "usage": {"input_tokens": 90}}

    arcade.app.state.providers["typesafe"] = SlowJev()
    run = arcade.play("bigsort", ["jev"], {"count": 40, "concurrency": 5})
    assert run["lanes"][0]["sorted"] == 40 and seen["max"] == 5


def test_a_silent_wikipedia_is_a_502(arcade):
    def down(params):
        raise WikiError("could not reach Wikipedia (ConnectError)")
    arcade.wiki_answer = down
    r = arcade.start("bigsort", ["jev"], {"count": 20})
    assert r.status_code == 502 and "reach Wikipedia" in r.json()["detail"]
    assert arcade.start("bigsort", ["jev"], {"count": 5000}).status_code == 422
