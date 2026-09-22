"""Ghost Maze's world, without a server: walls, eating, ghosts, power pellets,
catches, the words a player reads, and the same game from the same seed."""
from __future__ import annotations

import random
import re
from collections import deque

import pytest

from wikirace.games import ghostmaze_sim as S

ARCADE = S.layouts()["arcade"]


def at(c: int, r: int, L: S.Layout = ARCADE) -> int:
    return r * L.cols + c


def world(**kw) -> S.World:
    """The arcade maze with the ghosts held at their starts (they never move)."""
    w = S.World(ARCADE, kw.pop("seed", 1))
    for g in w.ghosts:
        g.out_at = 10**9
    for k, v in kw.items():
        setattr(w, k, v)
    return w


def ghost(w: S.World, name: str) -> S.Ghost:
    return next(g for g in w.ghosts if g.name == name)


def put(w: S.World, name: str, cell: int, *, moving: bool = False) -> S.Ghost:
    g = ghost(w, name)
    g.cell = cell
    g.out_at = 0 if moving else 10**9
    return g


def away(w: S.World, *names: str) -> None:
    """Take these ghosts out of the way: eaten, waiting at their starts."""
    for n in names:
        g = ghost(w, n)
        g.eyes = True


# ── The layouts ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("lid", list(S.layouts()))
def test_every_layout_is_a_sound_maze(lid):
    L = S.layouts()[lid]
    open_ = [n for n in range(L.cols * L.rows) if n not in L.walls]
    # Two ways out of every open tile: no dead ends.
    assert all(len(L.exits(n)) >= 2 for n in open_)
    # Every tile reaches every other, and distances are symmetric.
    assert all(L.dist[open_[0]][n] >= 0 for n in open_)
    assert all(L.dist[a][b] == L.dist[b][a] for a in open_[::7] for b in open_[::5])
    # Every wall block is a rectangle (the page draws each as one).
    walls = set(L.walls)
    while walls:
        first = walls.pop()
        block, q = {first}, deque([first])
        while q:
            x = q.popleft()
            for d in S.DIRS:
                c, r = L.xy(x)
                dc, dr = S.DIRS[d]
                y = (r + dr) * L.cols + (c + dc)
                if 0 <= c + dc < L.cols and 0 <= r + dr < L.rows and y in walls:
                    walls.discard(y)
                    block.add(y)
                    q.append(y)
        cs = [L.xy(b)[0] for b in block]
        rs = [L.xy(b)[1] for b in block]
        assert len(block) == (max(cs) - min(cs) + 1) * (max(rs) - min(rs) + 1), f"{lid}: a wall block is not a rectangle"
    assert len(L.power) == 4 and len(L.pellets) > 50
    assert set(L.homes) == set(S.GHOSTS) and L.start in L.exits(L.player)
    assert L.public()["grid"] == list(L.grid)


def test_a_bad_layout_is_refused():
    with pytest.raises(ValueError, match="player start"):
        S.parse_layout("x", {"grid": ["....", ".##.", "...."]})
    with pytest.raises(ValueError, match="unknown mark"):
        S.parse_layout("x", {"grid": ["P.BNC", ".#?#.", "....."]})


# ── Moving ────────────────────────────────────────────────────────────────────


def test_the_player_runs_until_a_wall_eating_as_it_goes():
    w = world()
    assert w.player == at(6, 6) and w.heading == "left"
    for _ in range(6):
        w.step()
    assert w.player == at(0, 6) and w.score == 6 * S.PELLET and len(w.eaten) == 6
    w.step()  # the wall: it stands
    assert w.player == at(0, 6) and w.tick == 7 and w.score == 60
    assert S.you_line(w) == "stopped against a wall, facing left"


def test_a_decision_turns_the_player_as_soon_as_that_way_is_open():
    w = world()
    assert w.steer("up") is False  # a wall above the start: it keeps going left for now
    w.step()
    assert w.player == at(5, 6) and w.heading == "left"
    w.step()
    assert w.player == at(4, 6)
    w.step()  # up is open here: it turns
    assert w.player == at(4, 5) and w.heading == "up"
    with pytest.raises(ValueError):
        w.steer("north")


def test_ghosts_follow_their_rules():
    w = world(tick=100)  # between scatters: the hunters hunt
    assert not w.scattering()
    blinky, pinky = ghost(w, "Blinky"), ghost(w, "Pinky")
    assert w._target(blinky) == ARCADE.xy(w.player)
    w.heading = "left"
    c, r = ARCADE.xy(w.player)
    assert w._target(pinky) == (c - S.PINKY_AHEAD, r)
    # At a junction Blinky takes the way nearest its target, and never turns back.
    blinky.cell, blinky.heading = at(6, 2), "right"
    assert ARCADE.exits(blinky.cell) == ["left", "down", "right"]
    assert w._ghost_way(blinky) == "down"
    # Scattering, the hunters head for their corners instead.
    w.tick = w.life_at
    assert w.scattering() and w._target(blinky) == (ARCADE.cols, -1) and w._target(pinky) == (-1, -1)


def test_a_ghost_rests_one_tick_in_four_and_a_frightened_one_every_other():
    w = world(tick=100)
    away(w, "Pinky", "Clyde")
    b = put(w, "Blinky", at(0, 0), moving=True)
    w.player = at(12, 8)
    moves = 0
    for _ in range(8):
        before = b.cell
        w.step()
        moves += b.cell != before
    assert moves == 8 - 8 // S.GHOST_REST
    w.fright, b.scared = 100, True
    moves = 0
    for _ in range(8):
        before = b.cell
        w.step()
        moves += b.cell != before
    assert moves == 4


# ── Catching and eating ───────────────────────────────────────────────────────


def test_a_ghost_catches_the_player_and_everyone_starts_again():
    w = world()
    put(w, "Blinky", at(5, 6))  # right in the player's way
    w.step()
    assert w.lives == S.LIVES - 1 and w.caught_at == 1 and w.caught_by == "Blinky"
    assert w.pause == S.PAUSE_TICKS and w.player == ARCADE.player and w.heading == ARCADE.start
    assert all(g.cell == g.home and g.gen == 1 for g in w.ghosts) and w.pgen == 1
    assert "caught by Blinky" in w.news
    for _ in range(S.PAUSE_TICKS):  # the pause: nothing moves
        w.step()
        assert w.player == ARCADE.player
    w.step()
    assert w.player == at(5, 6)


def test_a_ghost_stepping_onto_a_standing_player_catches_it():
    w = world(tick=100, heading="left")
    away(w, "Pinky", "Clyde")
    w.player = at(0, 6)  # against the wall, facing it
    b = put(w, "Blinky", at(0, 4), moving=True)
    b.heading = "down"
    for _ in range(4):
        w.step()
    assert w.lives == S.LIVES - 1


def test_three_catches_end_the_game():
    w = world()
    for _ in range(S.LIVES):
        put(w, "Blinky", at(5, 6))
        while w.pause:
            w.step()
        w.step()
    assert w.lives == 0 and w.over == "caught"
    tick = w.tick
    w.step()
    assert w.tick == tick  # over is over


def test_a_power_pellet_frightens_the_ghosts_and_they_can_be_eaten():
    w = world(heading="left")
    w.player = at(1, 0)
    b = put(w, "Blinky", at(0, 1))
    p = put(w, "Pinky", at(0, 2))
    b.heading = "right"
    w.step()  # onto the power pellet
    assert w.score == S.POWER and w.fright == S.FRIGHT_TICKS - 1 and "power" in w.news
    assert all(g.scared for g in w.ghosts) and b.heading == "left"  # frightened ghosts turn back
    assert "frightened" in S.power_line(w)
    w.steer("down")
    w.step()  # into Blinky (on a pellet): eaten
    assert w.score == S.POWER + S.PELLET + S.GHOST and b.eyes and b.cell == b.home and not b.scared
    w.step()  # into Pinky: worth double
    assert w.score == S.POWER + 2 * S.PELLET + 3 * S.GHOST and w.ghosts_eaten == 2 and p.eyes
    assert S.ghost_line(w, b) == "Blinky: eaten, waiting at its start; harmless for now"
    # The fright wears off (with no other power pellet to eat on the way).
    w.power = set()
    for _ in range(S.FRIGHT_TICKS):
        w.step()
    assert w.fright == 0 and not any(g.scared for g in w.ghosts) and w.chain == 0


def test_the_last_pellet_clears_the_maze():
    w = world()
    w.pellets = {at(5, 6)}
    w.power = set()
    w.step()
    assert w.over == "cleared" and w.score == S.PELLET + S.CLEAR and w.left == 0


# ── The same game from the same seed ──────────────────────────────────────────


def replay(seed: int, steering: int = 5, ticks: int = 300) -> list[dict]:
    w = S.World(ARCADE, seed)
    rng = random.Random(steering)
    views = []
    for _ in range(ticks):
        if rng.random() < 0.3:
            w.steer(rng.choice(w.exits()))
        w.step()
        views.append({**w.view(), "eaten": len(w.eaten)})
    return views


def test_the_same_seed_and_steering_play_the_same_game():
    assert replay(7) == replay(7)
    assert replay(7) != replay(8)  # Clyde wanders differently


# ── In words ──────────────────────────────────────────────────────────────────


def corridor_world() -> S.World:
    """The player in the middle row heading left, Blinky three tiles behind it."""
    w = world(tick=100, heading="left")
    w.player = at(9, 4)
    away(w, "Pinky", "Clyde")
    put(w, "Blinky", at(10, 2), moving=True)
    w._before = {"Blinky": 4, "Pinky": 5, "Clyde": 5}
    return w


def test_the_world_in_words():
    w = corridor_world()
    words = S.describe(w)
    assert set(words) == {"you", "ghosts", "pellets", "power", "exits"}
    assert words["you"] == "in a corridor, heading left"
    assert words["ghosts"][0] == "Blinky: dangerous, close, 3 tiles, reached by going right, behind you, coming closer"
    assert words["ghosts"][1] == "Pinky: eaten, waiting at its start; harmless for now"
    assert words["pellets"] == "4 pellets to the left, 1 pellet to the right"
    assert words["power"] == "off; the nearest power pellet is 7 tiles away, reached by going right"
    assert words["exits"] == "open: left, right; up and down are walls"
    # Never a coordinate: no "(3, 4)", no rows or columns.
    text = " ".join([*words["ghosts"], *(v for k, v in words.items() if k != "ghosts")])
    assert not re.search(r"\d+\s*,\s*\d+|\brow\b|\bcolumn\b", text)


def test_each_way_means_what_lies_that_way():
    w = corridor_world()
    means = S.meanings(w)
    assert list(means) == ["left", "right"]
    assert means["left"] == "left: 4 pellets in a straight line that way; no dangerous ghost close that way"
    assert means["right"].startswith("right: 1 pellet in a straight line that way")
    assert "toward Blinky, dangerous, close, 3 tiles" in means["right"]
    assert "no dangerous ghost" not in means["right"]
    ghost(w, "Blinky").scared = True
    assert "toward Blinky, frightened: it can be eaten" in S.meaning(w, "right")


def test_distances_in_words():
    assert S.how_far(1) == "right next to you"
    assert S.how_far(2) == "very close, 2 tiles"
    assert S.how_far(4) == "close, 4 tiles"
    assert S.how_far(7) == "some way off, 7 tiles"
    assert S.how_far(20) == "far away"


def test_where_a_decision_is_worth_waiting_for():
    w = corridor_world()
    assert w.needs_decision() and w.threat() == "Blinky"  # a ghost close
    ghost(w, "Blinky").eyes = True
    assert not w.needs_decision() and w.threat() is None  # a quiet corridor: it runs on
    w.player = at(4, 4)  # a junction
    assert len(w.exits()) >= 3 and w.needs_decision()
    w.player, w.heading = at(0, 6), "left"  # against a wall
    assert w.needs_decision()
    w.pause = 3
    assert not w.needs_decision()


def test_the_view_the_page_draws():
    w = world()
    v = w.view()
    assert v["player"] == [ARCADE.player, "left", 0] and v["lives"] == S.LIVES
    assert [g[1] for g in v["ghosts"]] == ["n", "n", "n"] and v["ended"] is None
    assert v["left"] == len(ARCADE.pellets) + len(ARCADE.power)
