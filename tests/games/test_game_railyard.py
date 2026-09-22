"""Rail Yard: Jev routes every prompt to a station; every station answers every prompt."""
from __future__ import annotations

from wikirace.games import railyard as R
from wikirace.games.core import jev_cost
from wikirace.providers.base import ProviderError

from .conftest import choice_answer, noul_answer, score_answer

PROMPTS = {q["text"]: q for q in R.prompts()}
ALL = {"count": R.COUNT_MAX, "seed": 1, "tiers": ["small", "large", "local"]}
LANES = ["jev", "test/a", "test/b", "test/c"]


def prompt_of(prompt: str) -> dict:
    return PROMPTS[prompt.split("PROMPT:\n", 1)[1]]


def jev_routes(tier_for, confidence: float = 0.9):
    """Jev, putting 0.9 on the station `tier_for(prompt)` names, sure of the
    difficulty, and flagging private data where there is some."""
    def answer(qid, q, state):
        item = PROMPTS[state["prompt_to_route"]]
        if qid == "station":
            ids = q["criteria"]
            want = next(o for o, d in ids.items() if d.startswith(f"{tier_for(item)} station"))
            rest = 0.1 / (len(ids) - 1)
            return choice_answer({o: 0.9 if o == want else rest for o in ids}, confidence)
        if qid == "difficulty":
            return score_answer([1.0 if i == item["difficulty"] else 0.0 for i in range(4)])
        if qid == "private_data":
            return noul_answer(0.95 if item["private"] else 0.05)
        return noul_answer(0.2)
    return answer


def sensible(item) -> str:
    return "large" if item["difficulty"] >= 2 else "small"


def stations_answer(model, system, prompt):
    """test/a (small) is right up to difficulty 1; test/b (large) always; test/c
    (local) up to difficulty 1, and fouls on the hardest."""
    item = prompt_of(prompt)
    right = f"Working it out.\nANSWER: {item['answers'][0]}"
    if model == "test/b":
        return right
    if model == "test/c" and item["difficulty"] == 3:
        return "I think it is probably forty-two."
    return right if item["difficulty"] <= 1 else "ANSWER: 999999"


def test_the_prompts_are_checkable_and_tagged():
    ps = R.prompts()
    assert len(ps) >= 40 and len({p["id"] for p in ps}) == len(ps) and len({p["text"] for p in ps}) == len(ps)
    assert {p["kind"] for p in ps} == {"fact", "conversion", "arithmetic", "reasoning", "code", "private"}
    assert sum(p["private"] for p in ps) >= 5 and sum(p["code"] for p in ps) >= 6
    for p in ps:
        assert p["difficulty"] in (0, 1, 2, 3) and p["answers"]
        assert all(R.grade(a, p["answers"]) for a in p["answers"]), p["id"]
    assert {p["difficulty"] for p in ps} == {0, 1, 2, 3}


def test_grading_compares_numbers_as_numbers_and_text_normalised():
    assert R.grade("$3,360.00", ["3360"]) and R.grade("36 dollars", ["36"]) and R.grade("0.80", ["0.8"])
    assert R.grade("7 × 3 = 21", ["21"]) and R.grade("$0.05", ["5", "0.05"])
    assert R.grade("The femur.", ["femur"]) and R.grade("**Canberra**", ["Canberra"])
    assert R.grade("[0,1,4,9]", ["[0, 1, 4, 9]"]) and R.grade("'oh'", ["oh"])
    assert not R.grade("22", ["21"]) and not R.grade("Sydney", ["Canberra"]) and not R.grade(None, ["1"])
    assert not R.grade("ohh", ["oh"])


def test_the_routing_rule_and_default_tiers():
    tiers = ["small", "large", "local"]
    assert R.route(0, 0.9, 0.1, tiers, 0.5) == (0, "pick")
    assert R.route(0, 0.3, 0.1, tiers, 0.5) == (1, "unsure_up")
    assert R.route(1, 0.3, 0.1, tiers, 0.5) == (1, "unsure_top")
    assert R.route(2, 0.3, 0.1, tiers, 0.5) == (0, "unsure_up")  # local → small is one tier up
    assert R.route(1, 0.9, 0.8, tiers, 0.5) == (2, "private")  # private beats a sure pick
    assert R.route(1, 0.9, 0.8, ["medium", "large", "small"], 0.5) == (2, "private_no_local")
    assert R.default_tiers([("openrouter", "x"), ("openrouter", "y"), ("openrouter", "z")]) == ["small", "medium", "large"]
    assert R.default_tiers([("anthropic", "claude-opus-5"), ("anthropic", "claude-haiku-4-5"), ("ollama", "l")]) == [
        "large", "small", "local"]
    assert R.default_tiers([("openai", "gpt-5-nano"), ("ollama", "l")]) == ["large", "local"]


def test_jev_routes_every_train_and_beats_always_one_station(arcade):
    arcade.jev.responder = jev_routes(sensible)
    arcade.text.responder = stations_answer
    r = arcade.start("railyard", LANES, ALL)
    assert r.status_code == 201, r.text
    started = r.json()
    # Nothing that grades the round is on the page before the end.
    assert started["gold"] is None and set(started["prompts"][0]) == {"k", "text"}
    run = arcade.wait(started["id"])
    assert run["status"] == "finished"
    jev, small, large, local = run["lanes"]
    n = R.COUNT_MAX
    by_k = [PROMPTS[t["text"]] for t in run["prompts"]]
    private = sum(q["private"] for q in by_k)
    easy = sum(q["difficulty"] <= 1 and not q["private"] for q in by_k)
    hard = sum(q["difficulty"] == 3 for q in by_k)

    # Every station answered every prompt, so the baselines are real.
    assert all(len(ln["answers"]) == n and ln["calls"] == n for ln in (small, large, local))
    assert len(arcade.text.prompts) == 3 * n
    assert large["right"] == n - private  # right every time, but a private prompt off the yard is a leak
    assert sum(a["verdict"] == "leak" for a in large["answers"]) == private
    assert small["right"] == easy and local["fouls"] == hard
    assert "ANSWER:" in arcade.text.prompts[0]["system"]

    # One request of six questions per train, the stations under opaque ids.
    assert len(arcade.jev.requests) == n and jev["calls"] == n
    req = arcade.jev.requests[0]
    assert set(req["state"]) == {"prompt_to_route"}
    assert set(req["questions"]) == {"station", "difficulty", *R.FLAGS}
    assert all(k.startswith("s") for k in req["questions"]["station"]["criteria"])

    trains = run["trains"]
    assert len(trains) == n and all(t["verdict"] for t in trains)
    assert all(t["rule"] == "private" and run["stations"][t["to"]]["tier"] == "local"
               for t in trains if by_k[t["k"]]["private"])
    assert jev["right"] == n and jev["score"] == 100 and jev["delivered"] == n

    s = run["summary"]
    assert s["router"]["accuracy"] == 1.0
    assert [a["tier"] for a in s["always"]] == ["small", "large", "local"]
    assert s["always"][1]["accuracy"] == round((n - private) / n, 4)
    assert abs(s["router"]["cost"] - (n * 0.002 + n * jev_cost(100))) < 1e-9
    assert abs(s["always"][1]["cost"] - n * 0.002) < 1e-9 and not s["tier_priced"]
    assert run["gold"][0]["answers"] == by_k[0]["answers"]


def test_an_unsure_jev_sends_trains_one_tier_up(arcade):
    arcade.jev.responder = jev_routes(lambda item: "small", confidence=0.3)
    arcade.text.responder = stations_answer
    run = arcade.play("railyard", LANES, {**ALL, "count": 10, "seed": 3})
    for t in run["trains"]:
        if t["rule"] != "private":
            assert t["pick"] == 0 and t["to"] == 1 and t["rule"] == "unsure_up"


def test_the_yard_needs_one_jev_and_two_or_three_stations(arcade):
    assert arcade.start("railyard", ["jev", "test/a", "test/b"], {"tiers": ["small"]}).status_code == 400
    assert arcade.start("railyard", ["jev", "test/a"]).status_code == 400
    r = arcade.start("railyard", ["test/a", "test/b", "test/c"])
    assert r.status_code == 400 and "Jev" in r.json()["detail"]
    r = arcade.start("railyard", ["jev", "jev", "test/a", "test/b"])
    assert r.status_code == 400 and "exactly one Jev" in r.json()["detail"]
    assert arcade.start("railyard", LANES, {"tiers": ["small", "huge", "large"]}).status_code == 422


def test_a_broken_station_does_not_hold_the_router(arcade):
    inner = arcade.app.state.providers["openrouter"]

    class Broken:
        config = inner.config

        async def complete(self, model, system, prompt, **kw):
            if model == "test/c":
                raise ProviderError("the station burned down", status=400)
            return await inner.complete(model, system, prompt, **kw)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Broken()
    arcade.jev.responder = jev_routes(lambda item: "local")
    arcade.text.responder = stations_answer
    run = arcade.play("railyard", LANES, {**ALL, "count": 6})
    assert run["status"] == "finished"
    assert run["lanes"][3]["status"] == "error" and "burned down" in run["lanes"][3]["note"]
    assert len(run["trains"]) == 6 and all(t["verdict"] == "none" for t in run["trains"])
    assert run["lanes"][1]["answered"] == 6 and run["lanes"][2]["answered"] == 6
