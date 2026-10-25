"""The Arcade's shared machinery: questions and answers, players, runs, the API.

A throwaway `echo` game is registered for these tests: each lane answers one
question (Jev a choice, a text model an ANSWER line) and the run keeps a list.
"""
from __future__ import annotations

import asyncio
import threading

import pytest
from pydantic import BaseModel, Field, field_validator

from wikirace.api import start_limit as api_start_limit
from wikirace.config import load_settings
from wikirace.games import core, runs
from wikirace.games import registry as R
from wikirace.games.players import BadPlayers, PlayError, ask_jev, ask_text, resolve_players
from wikirace.providers.base import ProviderError, status_error

from .conftest import choice_answer, key

# ── core ──────────────────────────────────────────────────────────────────────


def test_question_builders_check_their_limits():
    assert core.choice("Which?", {"a": "A", "b": "B"}) == {
        "type": "choice", "instructions": "Which?", "criteria": {"a": "A", "b": "B"}}
    with pytest.raises(ValueError):
        core.choice("Which?", {"a": "A"})
    with pytest.raises(ValueError):
        core.choice("Which?", {f"o{i}": str(i) for i in range(256)})
    assert core.score("How much?", ["none", "some", "lots"])["criteria"] == ["none", "some", "lots"]
    with pytest.raises(ValueError):
        core.score("How much?", ["only"])
    assert "criteria" not in core.noul("Is it?")
    assert core.noul("Is it?", yes="it is", no="it is not")["criteria"] == {"true": "it is", "false": "it is not"}


def test_opaque_ids_are_shuffled_but_stable():
    opts = [f"option {i}" for i in range(20)]
    a, b = core.opaque(opts, "seed"), core.opaque(opts, "seed")
    assert a == b and sorted(a.values()) == sorted(opts)
    assert list(a.values()) != opts  # shuffled
    assert core.opaque(opts, "other") != a


def test_read_choice_speaks_the_options_own_words():
    ids = {"o0": "north", "o1": "south"}
    picked = core.read_choice({"probabilities": {"o0": 0.2, "o1": 0.8}, "confidence": 0.6}, ids)
    assert (picked.option, picked.p, picked.confidence) == ("south", 0.8, 0.6)
    assert picked.top(1) == [{"option": "south", "p": 0.8}]
    with pytest.raises(core.AnswerError):
        core.read_choice({"probabilities": {"o0": 1.0}}, ids)  # an option missing
    with pytest.raises(core.AnswerError):
        core.read_choice(None, ids)


def test_read_score_and_noul():
    s = core.read_score({"probabilities": {"0": 0.1, "1": 0.3, "2": 0.6}, "score": 1.5, "confidence": 0.4}, 3)
    assert s.level == 2 and s.score == 1.5 and s.fraction == 0.75 and s.spread > 0
    # No score given: the weighted mean of the levels.
    s2 = core.read_score({"probabilities": {"0": 0.5, "1": 0.5}}, 2)
    assert s2.score == 0.5
    with pytest.raises(core.AnswerError):
        core.read_score({"probabilities": {}}, 3)
    assert core.read_noul({"noul": 0.93}) == 0.93
    with pytest.raises(core.AnswerError):
        core.read_noul({"noul": "yes"})


def test_reading_a_text_answer():
    reply = "Thinking… ANSWER: maybe\n\nREASON: because.\n**Answer:** *Lost card*."
    assert core.read_field(reply, "ANSWER") == "Lost card*."
    assert core.read_field(reply, "REASON") == "because."
    assert core.read_field("no fields here", "ANSWER") is None
    opts = ["report_lost_card", "Card declined", "“Quoted”", "Lost card"]
    assert core.match_option(core.read_field(reply, "ANSWER"), opts) == "Lost card"
    assert core.match_option("Report lost card.", opts) == "report_lost_card"
    assert core.match_option("**card DECLINED**", opts) == "Card declined"
    assert core.match_option('"Quoted"', opts) == "“Quoted”"
    assert core.match_option("lost", opts) is None
    assert core.text_cost("claude-haiku-4-5", 1_000_000, 0, None) == (1.0, True)
    assert core.text_cost("unknown/model", 10, 10, None) == (None, False)
    assert core.text_cost("unknown/model", 10, 10, 0.5) == (0.5, False)


# ── players ───────────────────────────────────────────────────────────────────


class _Lane(BaseModel):
    key: str
    thinking: str | None = None


def test_resolve_players(arcade):
    s, prov = arcade.settings, arcade.app.state.providers
    ps = resolve_players([_Lane(key=key("jev")), _Lane(key=key("test/a")), _Lane(key=key("test/a"))], s, prov)
    assert [p.kind for p in ps] == ["judgment", "text", "text"]
    assert len({p.label for p in ps}) == 3  # the same model twice reads differently
    with pytest.raises(BadPlayers, match="provider:model"):
        resolve_players([_Lane(key="nonsense")], s, prov)
    with pytest.raises(BadPlayers, match="TYPESAFE_MODELS"):
        resolve_players([_Lane(key="typesafe:jev-0")], s, prov)
    with pytest.raises(BadPlayers, match="no seat for Jev"):
        resolve_players([_Lane(key=key("jev"))], s, prov, kinds=frozenset({"text"}))
    with pytest.raises(BadPlayers, match="cannot play"):
        resolve_players([_Lane(key="anthropic:claude-haiku-4-5")], s, prov)  # no key set


def test_ask_retries_an_outage_and_waits_out_a_rate_limit(arcade, monkeypatch):
    from wikirace.games import players as P
    monkeypatch.setattr(P, "_OUTAGE_RETRY_S", 0.0)
    monkeypatch.setattr(P, "_RATE_LIMIT_WAITS_S", (0.0, 0.0))
    s, prov = arcade.settings, arcade.app.state.providers
    jev, text = resolve_players([_Lane(key=key("jev")), _Lane(key=key("test/a"))], s, prov)
    fails = [status_error("TypeSafe", 503, "down"), status_error("TypeSafe", 429, "slow")]
    calls = {"n": 0}
    real = arcade.jev.ask

    async def flaky(model, state, questions, *, timeout=60.0):
        calls["n"] += 1
        if fails:
            raise fails.pop(0)
        return await real(model, state, questions, timeout=timeout)

    monkeypatch.setattr(arcade.jev, "ask", flaky)
    waits: list = []
    asked = asyncio.run(ask_jev(jev, {"x": 1}, {"q": core.noul("?")}, on_wait=waits.append))
    assert calls["n"] == 3 and asked.answers["q"]["noul"] == 0.5 and asked.tokens_in == 100
    assert waits[0].startswith("rate-limited") and waits[-1] is None
    # A final error comes back as PlayError, in the provider's words.
    arcade.jev.fail = ProviderError("TypeSafe refused the key (HTTP 401)")
    monkeypatch.setattr(arcade.jev, "ask", real)
    with pytest.raises(PlayError, match="refused the key"):
        asyncio.run(ask_jev(jev, {}, {"q": core.noul("?")}))
    arcade.text.responder = lambda m, sys, p: "<think>hmm</think>ANSWER: yes"
    said = asyncio.run(ask_text(text, "sys", "prompt"))
    assert said.text == "ANSWER: yes" and said.cost == 0.002 and not said.cost_estimated


def test_ask_jev_splits_many_questions_across_requests(arcade):
    s, prov = arcade.settings, arcade.app.state.providers
    (jev,) = resolve_players([_Lane(key=key("jev"))], s, prov)
    qs = {f"q{i}": core.noul(f"#{i}?") for i in range(50)}
    asked = asyncio.run(ask_jev(jev, {}, qs, per_request=20))
    assert asked.requests == 3 and len(asked.answers) == 50 and asked.tokens_in == 300
    assert [len(r["questions"]) for r in arcade.jev.requests] == [20, 20, 10]


# ── runs, through the API ─────────────────────────────────────────────────────


class EchoParams(BaseModel):
    word: str = Field(default="hello", max_length=20)
    rounds: int = Field(default=1, ge=1, le=5)

    @field_validator("word")
    @classmethod
    def _no_digits(cls, v: str) -> str:
        if any(c.isdigit() for c in v):
            raise ValueError("no digits")
        return v


async def _echo_prepare(ctx: R.Context) -> dict:
    if ctx.params.word == "boom":
        raise R.GameInputError("no booms")
    ctx.private["secret"] = ctx.params.word.upper()
    return {"word": ctx.params.word, "answers": []}


async def _echo_play(run: runs.GameRun, ctx: R.Context) -> None:
    async def lane(p) -> None:
        for n in range(ctx.params.rounds):
            if p.is_jev:
                ids = core.opaque(["yes", "no"], f"{n}")
                asked = await ask_jev(p, {"word": run.state["word"]}, {"q": core.choice("?", ids)})
                pick = core.read_choice(asked.answers["q"], ids)
                run.account(p.index, asked)
                run.lane_push(p.index, "picks", pick.option)
            else:
                said = await ask_text(p, "Say it.", run.state["word"])
                claimed = core.read_field(said.text, "ANSWER")
                run.account(p.index, said)
                if core.match_option(claimed, ["yes", "no"]) is None:
                    run.foul(p.index)
                run.lane_push(p.index, "picks", claimed)
            run.push("answers", {"lane": p.index, "round": n})
    await run.each_lane(lane)
    run.patch(revealed=ctx.private["secret"])


@pytest.fixture
def echo(monkeypatch):
    game = R.Game(id="echo", title="Echo", tagline="t", use_case="u", play=_echo_play,
                  params=EchoParams, prepare=_echo_prepare, lanes=(1, 3))
    monkeypatch.setitem(R.GAMES, "echo", game)
    return game


def test_every_game_is_listed_with_its_rules(arcade):
    games = arcade.client.get("/api/games").json()["games"]
    assert [g["id"] for g in games][:3] == ["chess", "switchboard", "customs"]
    assert len(games) == 14
    g = games[0]
    assert {"title", "tagline", "use_case", "lanes", "kinds", "ready", "params"} <= set(g)


def test_a_run_plays_every_lane_and_streams_it(arcade, echo):
    arcade.text.responder = lambda m, s, p: "ANSWER: nope" if m == "test/b" else "ANSWER: Yes."
    run = arcade.play("echo", ["jev", "test/a", "test/b"], {"word": "hi", "rounds": 2})
    assert run["status"] == "finished" and run["word"] == "hi" and run["revealed"] == "HI"
    jev, good, bad = run["lanes"]
    assert jev["picks"] == ["yes", "yes"] or set(jev["picks"]) <= {"yes", "no"}
    assert jev["calls"] == 2 and jev["tokens_in"] == 200 and jev["cost_estimated"] and jev["status"] == "done"
    assert good["fouls"] == 0 and bad["fouls"] == 2 and good["cost"] == 0.004
    assert len(run["answers"]) == 6
    # The stream replays to the same run: snapshot, changes, end.
    events = arcade.events(run["id"])
    assert events[0]["type"] == "snapshot" and events[-1]["type"] == "end"
    assert events[0]["run"]["id"] == run["id"]
    # And it is kept.
    listed = arcade.client.get("/api/games/runs?game=echo").json()["runs"]
    assert [r["id"] for r in listed] == [run["id"]]
    assert "answers" not in listed[0] and "picks" not in listed[0]["lanes"][0]


def test_a_lane_that_fails_ends_alone(arcade, echo):
    arcade.jev.fail = ProviderError("TypeSafe refused the key (HTTP 401)")
    arcade.text.responder = lambda m, s, p: "ANSWER: yes"
    run = arcade.play("echo", ["jev", "test/a"])
    assert run["status"] == "finished"
    assert run["lanes"][0]["status"] == "error" and "refused the key" in run["lanes"][0]["note"]
    assert run["lanes"][1]["status"] == "done"


def test_starting_checks_players_params_and_the_round(arcade, echo):
    assert arcade.start("echo", []).status_code == 400  # too few
    assert arcade.start("echo", ["jev"] * 4).status_code == 400  # too many
    assert arcade.start("echo", ["jev"], {"rounds": 9}).status_code == 422
    # A validator's own error is a 422 in words, not a server error.
    r = arcade.start("echo", ["jev"], {"word": "abc1"})
    assert r.status_code == 422 and "no digits" in r.text
    r = arcade.start("echo", ["jev"], {"word": "boom"})
    assert r.status_code == 400 and r.json()["detail"] == "no booms"
    assert arcade.start("nope", ["jev"]).status_code == 404
    r = arcade.start("chess", ["jev"])
    assert r.status_code == 409 or r.status_code == 201  # a placeholder until chess is built


def test_needs_jev(arcade, echo, monkeypatch):
    monkeypatch.setitem(R.GAMES, "echo", R.Game(**{**echo.__dict__, "needs_jev": True}))
    r = arcade.start("echo", ["test/a"])
    assert r.status_code == 400 and "needs Jev" in r.json()["detail"]


def test_a_run_can_be_stopped_and_deleted(arcade, monkeypatch):
    async def forever(run, ctx):
        await asyncio.sleep(60)

    monkeypatch.setitem(R.GAMES, "echo", R.Game(id="echo", title="E", tagline="t", use_case="u", play=forever))
    rid = arcade.start("echo", ["jev"]).json()["id"]
    assert arcade.client.delete(f"/api/games/runs/{rid}").status_code == 409
    assert arcade.client.post(f"/api/games/runs/{rid}/stop").status_code == 202
    run = arcade.wait(rid)
    assert run["status"] == "stopped" and run["lanes"][0]["status"] == "stopped"
    assert arcade.client.post(f"/api/games/runs/{rid}/stop").status_code == 409
    assert arcade.client.delete(f"/api/games/runs/{rid}").json() == {"deleted": rid}
    assert arcade.client.get(f"/api/games/runs/{rid}").status_code == 404


def test_only_so_many_runs_at_once(arcade, monkeypatch):
    async def forever(run, ctx):
        await asyncio.sleep(60)

    monkeypatch.setitem(R.GAMES, "echo", R.Game(id="echo", title="E", tagline="t", use_case="u", play=forever))
    for _ in range(runs.MAX_LIVE):
        assert arcade.start("echo", ["jev"]).status_code == 201
    r = arcade.start("echo", ["jev"])
    assert r.status_code == 409 and "already running" in r.json()["detail"]


def _counted_prepare(monkeypatch, wait_s: float = 0.0) -> list[int]:
    """An echo game whose `prepare` (where a real game may bill a model) is
    counted and takes *wait_s*, and whose play runs until stopped."""
    prepared: list[int] = []

    async def prepare(ctx):
        prepared.append(1)
        await asyncio.sleep(wait_s)
        return {}

    async def forever(run, ctx):
        await asyncio.sleep(60)

    monkeypatch.setitem(R.GAMES, "echo", R.Game(id="echo", title="E", tagline="t", use_case="u",
                                                 play=forever, prepare=prepare))
    return prepared


def test_a_full_house_is_refused_before_prepare_spends_anything(arcade, monkeypatch):
    prepared = _counted_prepare(monkeypatch)
    for _ in range(runs.MAX_LIVE):
        assert arcade.start("echo", ["jev"]).status_code == 201
    assert len(prepared) == runs.MAX_LIVE
    r = arcade.start("echo", ["jev"])
    assert r.status_code == 409 and len(prepared) == runs.MAX_LIVE


def test_starts_at_once_hold_their_places_while_they_prepare(arcade, monkeypatch):
    monkeypatch.setattr(runs, "MAX_LIVE", 1)
    prepared = _counted_prepare(monkeypatch, wait_s=0.3)
    codes: list[int] = []
    starts = [threading.Thread(target=lambda: codes.append(arcade.start("echo", ["jev"]).status_code))
              for _ in range(3)]
    for t in starts:
        t.start()
    for t in starts:
        t.join()
    # One prepared and ran; the others were refused without preparing.
    assert sorted(codes) == [201, 409, 409] and len(prepared) == 1
    assert runs._held == 0


def test_a_slot_is_given_back_when_a_start_fails(arcade, monkeypatch):
    monkeypatch.setattr(runs, "MAX_LIVE", 1)
    async def boom(ctx):
        raise R.GameInputError("no round today")

    monkeypatch.setitem(R.GAMES, "echo", R.Game(id="echo", title="E", tagline="t", use_case="u",
                                                 play=_echo_play, prepare=boom))
    for _ in range(3):
        assert arcade.start("echo", ["jev"]).status_code == 400
    assert runs._held == 0


def _public(arcade, **extra):
    settings = load_settings({
        "OPENROUTER_API_KEY": "sk-or-test", "OPENROUTER_MODELS": "test/a, test/b, test/c, test/d",
        "TYPESAFE_API_KEY": "ts-test", "WIKIRACE_DB": arcade.settings.db_path, "WIKIRACE_PUBLIC": "on", **extra,
    }, read_file=False)
    arcade.app.state.settings = settings
    arcade.app.state.start_limit = api_start_limit(settings)
    return settings


def test_a_public_site_seats_only_listed_models_writers_included(arcade, echo):
    _public(arcade)
    r = arcade.start("echo", ["jev", "test/unlisted"])
    assert r.status_code == 400 and "only the models this site lists" in r.json()["detail"]
    r = arcade.start("twotruths", ["jev"], {"writer": "openrouter:test/unlisted", "title": "Axolotl"})
    assert r.status_code == 400 and "only the models this site lists" in r.json()["detail"]
    assert arcade.text.prompts == []


def test_a_public_site_limits_the_games_one_address_starts_an_hour(arcade, echo):
    _public(arcade, WIKIRACE_STARTS_PER_HOUR="2")
    arcade.text.responder = lambda m, s, p: "ANSWER: yes"
    me = {"CF-Connecting-IP": "203.0.113.9"}
    body = {"lanes": [{"key": key("jev")}], "params": {}}
    for _ in range(2):
        assert arcade.client.post("/api/games/echo/runs", json=body, headers=me).status_code == 201
    r = arcade.client.post("/api/games/echo/runs", json=body, headers=me)
    assert r.status_code == 429
    # Refused before the round was prepared, and with its place given back.
    assert runs._held == 0


def test_on_a_public_site_only_the_starter_stops_or_deletes_a_run(arcade, monkeypatch):
    _counted_prepare(monkeypatch)
    _public(arcade)
    started = arcade.start("echo", ["jev"]).json()
    rid, mine = started["id"], {"X-Owner-Token": started["owner_token"]}
    assert started["owner_token"] not in arcade.client.get(f"/api/games/runs/{rid}").text
    assert arcade.client.post(f"/api/games/runs/{rid}/stop").status_code == 403
    assert arcade.client.post(f"/api/games/runs/{rid}/stop", headers=mine).status_code == 202
    arcade.wait(rid)
    assert arcade.client.delete(f"/api/games/runs/{rid}", headers={"X-Owner-Token": "nope"}).status_code == 403
    assert arcade.client.delete(f"/api/games/runs/{rid}", headers=mine).status_code == 200
    assert arcade.client.get(f"/api/games/runs/{rid}").status_code == 404
    arcade.app.state.settings = arcade.settings  # the fixture stops what is left, with no token


def test_a_play_that_raises_ends_the_run_in_its_words(arcade, monkeypatch):
    async def broken(run, ctx):
        raise PlayError("the board fell over")

    monkeypatch.setitem(R.GAMES, "echo", R.Game(id="echo", title="E", tagline="t", use_case="u", play=broken))
    run = arcade.play("echo", ["jev"])
    assert run["status"] == "error" and run["note"] == "the board fell over"


def test_run_fields_a_game_may_not_take():
    with pytest.raises(ValueError):
        runs.GameRun(game="x", players=[], params={}, db_path=":memory:", extra={"lanes": []})


def test_choice_answer_helper():
    a = choice_answer({"a": 0.2, "b": 0.8})
    assert a["choice"] == "b"
