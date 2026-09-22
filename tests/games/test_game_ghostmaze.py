"""Ghost Maze over the fake players: the questions Jev is asked, the words a
text model reads, fouls, the clock in both modes, accounting, a clean stop,
and how many events a tick costs. Time runs fast (ghostmaze.TIME_SCALE)."""
from __future__ import annotations

import asyncio
import importlib.util
import re
import time
from pathlib import Path

import pytest

from wikirace.games import ghostmaze as G
from wikirace.games import ghostmaze_sim as S
from wikirace.games.registry import GAMES
from wikirace.providers.base import Completion

from .conftest import choice_answer

WAYS = ("up", "left", "down", "right")


def _load_demo():
    path = Path(__file__).parent / "demo" / "ghostmaze.py"
    spec = importlib.util.spec_from_file_location("ghostmaze_demo", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DEMO = _load_demo()


@pytest.fixture
def fast(monkeypatch):
    """A tick of 100 ms takes 2 ms."""
    monkeypatch.setattr(G, "TIME_SCALE", 0.02)


@pytest.fixture
def instant(monkeypatch):
    """No waiting at all: for turn-based rounds, which wait for answers anyway."""
    monkeypatch.setattr(G, "TIME_SCALE", 0.0)


def jev_plays_well(qid, q, state):
    """A Jev that reads the meanings as the demo's stand-in does: safe, then pellets."""
    ids = q["criteria"]
    best = max(ids, key=lambda o: (DEMO.rate(ids[o]), ids[o]))  # ties by meaning: ids are shuffled
    rest = 0.1 / max(1, len(ids) - 1)
    return choice_answer({o: 0.9 if o == best else rest for o in ids}, 0.8)


def offered(prompt: str) -> list[str]:
    return re.findall(r"^- (up|down|left|right): ", prompt, re.M)


def test_the_game_is_listed_and_ready():
    g = GAMES["ghostmaze"]
    assert g.ready and g.title == "Ghost Maze" and g.use_case == "real-time decisions"
    schema = g.public()["params"]["properties"]
    assert schema["layout"]["enum"] == list(S.layouts()) and set(schema["layout"]["x-layouts"]) == set(S.layouts())
    assert schema["mode"]["enum"] == ["realtime", "turns"]


def test_bad_params_are_refused(arcade):
    assert arcade.start("ghostmaze", ["jev"], {"layout": "nowhere"}).status_code == 422
    assert arcade.start("ghostmaze", ["jev"], {"tick_ms": 10}).status_code == 422
    assert arcade.start("ghostmaze", ["jev"], {"mode": "slow"}).status_code == 422


def test_jev_steers_in_real_time_one_choice_over_the_open_ways(arcade, fast):
    arcade.jev.responder = jev_plays_well
    run = arcade.play("ghostmaze", ["jev"], {"seconds": 10, "seed": 3})
    assert run["status"] == "finished" and run["mode"] == "realtime" and run["seed"] == 3
    assert run["total_ticks"] == 100 and run["layout"]["id"] == "arcade"
    lane = run["lanes"][0]
    assert lane["status"] == "done" and lane["ended"] in ("time", "caught", "cleared")
    assert lane["score"] > 0 and lane["score"] == lane["score"] // 10 * 10
    assert lane["tick"] <= 100 and 0 < lane["answered"] <= lane["tick"] + 1
    # Every call accounted: a request each, 100 tokens each at Jev's rate.
    reqs = arcade.jev.requests
    assert lane["calls"] == len(reqs) and lane["tokens_in"] == 100 * len(reqs)
    assert lane["cost"] == pytest.approx(len(reqs) * 100 * 0.042 / 1e6)
    # One choice over the open ways only, under opaque ids, meaning what lies that way.
    for r in reqs:
        assert set(r["state"]) == {"you", "ghosts", "pellets", "power", "exits"}
        q = r["questions"]["move"]
        assert q["type"] == "choice" and "`you`" in q["instructions"]["question"]
        assert 2 <= len(q["criteria"]) <= 4 and all(re.fullmatch(r"w\d", k) for k in q["criteria"])
        ways = [m.split(":", 1)[0] for m in q["criteria"].values()]
        assert set(ways) <= set(WAYS) and len(set(ways)) == len(ways)
        assert all(w in r["state"]["exits"].split(";")[0] for w in ways)
    last = lane["last"]
    assert set(last["p"]) == set(last["offered"]) and last["dir"] in last["offered"] and last["foul"] is None
    assert lane["words"]["state"]["you"] and set(lane["words"]["options"]) <= set(WAYS)
    assert len(lane["eaten"]) * 10 <= lane["score"]


def test_text_models_answer_in_a_move_line_and_foul_into_walls(arcade, instant):
    def reply(model, system, prompt):
        ways = offered(prompt)
        if model == "test/a":
            return f"Thinking...\nMOVE: **{ways[0]}**"
        if model == "test/b":
            return f"MOVE: {next(w for w in WAYS if w not in ways)}"  # a wall
        return "left, I think"  # no MOVE line
    arcade.text.responder = reply
    run = arcade.play("ghostmaze", ["test/a", "test/b", "test/c"], {"mode": "turns", "seconds": 10, "seed": 5})
    good, wall, silent = run["lanes"]
    assert good["fouls"] == 0 and good["answered"] == good["calls"] > 0
    assert wall["fouls"] == wall["calls"] > 0 and wall["answered"] == 0 and wall["last"]["foul"] == "into a wall"
    assert silent["fouls"] == silent["calls"] > 0 and silent["last"]["foul"] == "no MOVE line"
    assert silent["last"]["said"] == "left, I think"
    first = arcade.text.prompts[0]
    assert "MOVE: up|down|left|right" in first["system"] and "waits for your answer" in first["system"]
    assert first["prompt"].startswith("YOU: ") and "OPEN DIRECTIONS:" in first["prompt"]
    assert "Blinky" in first["prompt"] and "`you`" not in first["prompt"]
    assert all(ln["cost"] == pytest.approx(0.002 * ln["calls"]) for ln in run["lanes"])


def test_read_move():
    assert G.read_move("MOVE: Left.", ["left", "up"]) == ("left", None, "Left.")
    assert G.read_move("MOVE: down", ["left", "up"]) == (None, "into a wall", "down")
    assert G.read_move("MOVE: north", ["left", "up"]) == (None, "not a direction", "north")
    assert G.read_move("", ["left", "up"])[1] == "no MOVE line"


def test_the_same_seed_is_the_same_maze_for_every_lane(arcade, instant):
    arcade.jev.responder = jev_plays_well
    run = arcade.play("ghostmaze", ["jev", "jev"], {"mode": "turns", "seconds": 20, "seed": 11})
    a, b = run["lanes"]
    # Two players who judge alike play the same game, move for move.
    assert a["score"] == b["score"] > 0 and a["eaten"] == b["eaten"] and a["tick"] == b["tick"]
    assert a["player"] == b["player"] and a["ghosts"] == b["ghosts"]
    # Turn-based: every answer applied on the tick it was asked about.
    assert a["lag"] == 0 and a["late"] == 0 and a["last"]["tick"] == a["last"]["at"]


def test_turn_based_asks_only_where_there_is_a_choice(arcade, instant):
    arcade.jev.responder = jev_plays_well
    run = arcade.play("ghostmaze", ["jev"], {"mode": "turns", "seconds": 15, "layout": "halls", "seed": 2})
    lane = run["lanes"][0]
    assert 0 < lane["calls"] < lane["tick"]  # quiet corridors run on without a question
    assert "waits" in G.text_system("turns", 100) and "real time" in G.text_system("realtime", 100)


class Slow:
    """A text provider that takes a while: the world runs on without it."""

    def __init__(self, config, delay: float):
        self.config = config
        self.delay = delay

    async def complete(self, model, system, prompt, **kw):
        await asyncio.sleep(self.delay)
        return Completion(text=f"MOVE: {offered(prompt)[0]}", model=model, tokens_in=300, tokens_out=3)

    def context_limit(self, model):
        return None

    async def aclose(self):
        return None


def test_a_slow_thinker_answers_few_ticks_and_late(arcade, fast):
    arcade.app.state.providers["openrouter"] = Slow(arcade.app.state.providers["openrouter"].config, 0.06)
    arcade.jev.responder = jev_plays_well
    run = arcade.play("ghostmaze", ["jev", "test/a"], {"seconds": 20, "seed": 4})
    jev, slow = run["lanes"]
    assert slow["calls"] >= 1 and slow["answered"] + slow["late"] + slow["fouls"] <= slow["calls"]
    share = lambda ln: ln["answered"] / max(1, ln["tick"])  # noqa: E731
    assert share(jev) > 3 * share(slow)
    assert slow["answered"] == 0 or slow["lag"] / slow["answered"] >= 3  # its answers land ticks late
    assert slow["last"]["at"] >= slow["last"]["tick"]


def test_one_event_a_tick_per_lane(arcade, fast):
    arcade.jev.responder = jev_plays_well
    arcade.text.responder = lambda m, s, p: f"MOVE: {offered(p)[0]}"
    r = arcade.start("ghostmaze", ["jev", "test/a"], {"seconds": 10, "seed": 9})
    run = arcade.wait(r.json()["id"])
    events = arcade.events(run["id"])
    for ln in run["lanes"]:
        mine = [e for e in events if e.get("lane") == ln["index"]]
        # A tick's event carries the world and any call that landed; a few more at the start and end.
        assert len(mine) <= ln["tick"] * 1.25 + 8, (ln["label"], len(mine), ln["tick"])
    # Pellets ride in the tick's event, the whole list only when it changed.
    eaten = [e for e in events if e["type"] == "lane" and "eaten" in e["patch"]]
    assert all(len(e["patch"]["eaten"]) >= 1 for e in eaten[2:])


def test_stop_ends_the_clock_and_every_lane(arcade, monkeypatch):
    monkeypatch.setattr(G, "TIME_SCALE", 0.2)
    arcade.jev.responder = jev_plays_well
    r = arcade.start("ghostmaze", ["jev", "jev"], {"seconds": 180, "seed": 1})
    rid = r.json()["id"]
    time.sleep(0.3)
    assert arcade.client.post(f"/api/games/runs/{rid}/stop").status_code in (200, 202, 204)
    run = arcade.wait(rid, timeout=5)
    assert run["status"] == "stopped"
    assert all(ln["status"] == "stopped" for ln in run["lanes"])
    ticks = [ln["tick"] for ln in run["lanes"]]
    assert all(0 < t < 900 for t in ticks)
    time.sleep(0.1)
    assert [ln["tick"] for ln in arcade.client.get(f"/api/games/runs/{rid}").json()["lanes"]] == ticks


def test_a_lane_that_fails_ends_alone(arcade, fast):
    arcade.jev.responder = jev_plays_well
    arcade.text.responder = lambda m, s, p: "MOVE: left"

    class Broken(Slow):
        async def complete(self, model, system, prompt, **kw):
            from wikirace.providers.base import ProviderError
            raise ProviderError("the model is gone", retryable=False)

    arcade.app.state.providers["openrouter"] = Broken(arcade.app.state.providers["openrouter"].config, 0)
    run = arcade.play("ghostmaze", ["jev", "test/a"], {"seconds": 10, "seed": 6})
    jev, broken = run["lanes"]
    assert broken["status"] == "error" and "gone" in broken["note"]
    assert jev["status"] == "done" and jev["tick"] > broken["tick"]


def test_the_demo_players_answer_this_games_questions():
    w = S.World(S.layouts()["arcade"], 1)
    means = S.meanings(w)
    ids = {f"w{i}": m for i, m in enumerate(means.values())}
    a = DEMO.jev("move", {"type": "choice", "criteria": ids}, S.describe(w))
    assert set(a["probabilities"]) == set(ids) and a["choice"] in ids
    assert DEMO.jev("move", {"type": "choice", "criteria": ids}, {"caller_said": "hi"}) is None
    said = DEMO.text("demo/fast", G.text_system("realtime", 100), G.text_prompt(S.describe(w), means))
    assert said.startswith("MOVE:") or "left" in said
    assert DEMO.text("demo/fast", "You are the operator of a telephone switchboard", "x") is None
