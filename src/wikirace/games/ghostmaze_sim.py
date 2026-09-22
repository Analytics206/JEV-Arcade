"""Ghost Maze's world: a grid maze, its pellets, three ghosts and a player, one
tick at a time. Pure and deterministic: the same layout, seed and steering give
the same game, move for move. No I/O and no clock here; the game
(ghostmaze.py) decides when a tick happens.

**The rules.** Each tick the player moves one tile in its heading, or stands
against the wall that stops it. A decision sets the way it *wants* to go; it
turns that way the first tick the way is open (at once, when it is open now),
and keeps going until a wall. A pellet is worth 10, a power pellet 50 and
frightens every ghost for `FRIGHT_TICKS`: a frightened ghost is slower, turns
at random, and can be eaten (200, then 400, then 800 in one fright) and goes
back to its start for a while. A ghost that is not frightened catches the
player when they meet on a tile: a life lost
(of `LIVES`), then everyone back to their starts and a short pause. The maze
cleared is a bonus and the end of that player's game.

**The ghosts** move three ticks in four (half speed when frightened), never
turn back unless the way ahead ends, and pick at every junction the way that
brings them nearest, as the crow flies, to their target:

  Blinky  chases: its target is the player's tile
  Pinky   ambushes: its target is four tiles ahead of the player
  Clyde   wanders: it turns at random (from the seed)

They leave their starts one by one, and for the first `SCATTER_TICKS` of every
`SCATTER_EVERY` ticks of a life the two hunters scatter to their own corners
instead: the breathing space the arcade game gives, which is what lets a slow
thinker last a while.

**In words.** `describe` and `meanings` put the world into sentences, the only
form a player ever sees it in: where the player is, each ghost as a distance
along the corridors and the way to go to reach it, the pellets each way. No
coordinates: Jev is weak with them, and the maths is code's job.
"""
from __future__ import annotations

import json
import random
from collections import deque
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

#: The four ways, in the ghosts' tie-break order.
DIRS: dict[str, tuple[int, int]] = {"up": (0, -1), "left": (-1, 0), "down": (0, 1), "right": (1, 0)}
ORDER = tuple(DIRS)
OPPOSITE = {"up": "down", "down": "up", "left": "right", "right": "left"}
GHOSTS = ("Blinky", "Pinky", "Clyde")
HOME_MARK = {"B": "Blinky", "N": "Pinky", "C": "Clyde"}
#: How each ghost hunts, as the page and the prompts say it.
GHOST_RULES = {
    "Blinky": "chases: heads for the player's tile",
    "Pinky": "ambushes: heads for four tiles ahead of the player",
    "Clyde": "wanders: turns at random",
}

LIVES = 3
PELLET = 10
POWER = 50
GHOST = 200
CLEAR = 500
#: A power pellet frightens the ghosts this many ticks; the last few, they flash.
FRIGHT_TICKS = 60
FRIGHT_ENDING = 20
#: After a catch, nothing moves for this many ticks.
PAUSE_TICKS = 12
#: An eaten ghost waits at its start this long.
HOME_TICKS = 25
#: When each ghost starts moving, in ticks from the start (or a respawn).
RELEASE = {"Blinky": 6, "Pinky": 24, "Clyde": 45}
#: A ghost that is not frightened stands still one tick in this many; a
#: frightened one moves every other tick.
GHOST_REST = 4
#: Every SCATTER_EVERY ticks of a life, the first SCATTER_TICKS of them, the
#: chasers give up the hunt and head for their own corners of the maze.
SCATTER_EVERY = 160
SCATTER_TICKS = 60
#: Where each ghost heads when it scatters: just off a corner of the grid, as (col, row) from its edges.
CORNER = {"Blinky": ("right", "top"), "Pinky": ("left", "top"), "Clyde": ("left", "bottom")}
PINKY_AHEAD = 4
#: A ghost this near along the corridors is a danger worth a decision.
NEAR = 4
#: Ghosts and pellets further than this are left out of a direction's meaning.
HORIZON = 8

_DATA = Path(__file__).parent / "data" / "ghostmaze.json"


# ── Layouts ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True, eq=False)
class Layout:
    """A maze: its grid, where things start, and every distance along it."""

    id: str
    name: str
    blurb: str
    grid: tuple[str, ...]
    cols: int
    rows: int
    walls: frozenset[int]
    pellets: frozenset[int]
    power: frozenset[int]
    player: int
    #: The way the player sets off, at the start and after every catch.
    start: str | None
    homes: dict[str, int]
    #: dist[a][b]: tiles from a to b along the corridors; -1 for a wall.
    dist: tuple[tuple[int, ...], ...]

    def xy(self, cell: int) -> tuple[int, int]:
        return cell % self.cols, cell // self.cols

    def step(self, cell: int, d: str) -> int | None:
        """The tile one step *d* from *cell*, or None when that is a wall."""
        c, r = self.xy(cell)
        dc, dr = DIRS[d]
        c, r = c + dc, r + dr
        if not (0 <= c < self.cols and 0 <= r < self.rows):
            return None
        n = r * self.cols + c
        return None if n in self.walls else n

    def exits(self, cell: int) -> list[str]:
        """The ways open from *cell*, in ORDER."""
        return [d for d in ORDER if self.step(cell, d) is not None]

    def toward(self, cell: int, target: int) -> list[str]:
        """The ways from *cell* that start a shortest path to *target*."""
        here = self.dist[cell][target]
        if here <= 0:
            return []
        return [d for d in self.exits(cell) if self.dist[self.step(cell, d)][target] == here - 1]  # type: ignore[index]

    def public(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "blurb": self.blurb, "cols": self.cols, "rows": self.rows,
                "grid": list(self.grid)}


def parse_layout(id: str, spec: dict[str, Any]) -> Layout:
    grid = tuple(spec["grid"])
    rows, cols = len(grid), len(grid[0])
    if any(len(line) != cols for line in grid):
        raise ValueError(f"layout {id}: rows of different lengths")
    walls, pellets, power, homes, player = set(), set(), set(), {}, None
    for r, line in enumerate(grid):
        for c, ch in enumerate(line):
            n = r * cols + c
            if ch == "#":
                walls.add(n)
            elif ch == ".":
                pellets.add(n)
            elif ch == "o":
                power.add(n)
            elif ch == "P":
                player = n
            elif ch in HOME_MARK:
                homes[HOME_MARK[ch]] = n
            elif ch != " ":
                raise ValueError(f"layout {id}: unknown mark {ch!r}")
    if player is None or set(homes) != set(GHOSTS):
        raise ValueError(f"layout {id}: needs a player start and three ghost starts")
    size = rows * cols
    dist = []
    for a in range(size):
        row = [-1] * size
        if a not in walls:
            row[a] = 0
            q = deque([a])
            while q:
                x = q.popleft()
                for y in _neighbours(x, cols, rows, walls):
                    if row[y] < 0:
                        row[y] = row[x] + 1
                        q.append(y)
        dist.append(tuple(row))
    return Layout(
        id=id, name=spec.get("name", id), blurb=spec.get("blurb", ""), grid=grid, cols=cols, rows=rows,
        walls=frozenset(walls), pellets=frozenset(pellets), power=frozenset(power), player=player,
        start=spec.get("start"), homes=homes, dist=tuple(dist),
    )


def _neighbours(x: int, cols: int, rows: int, walls: set[int]) -> list[int]:
    c, r = x % cols, x // cols
    out = []
    for dc, dr in DIRS.values():
        cc, rr = c + dc, r + dr
        if 0 <= cc < cols and 0 <= rr < rows and rr * cols + cc not in walls:
            out.append(rr * cols + cc)
    return out


@cache
def data() -> dict[str, Any]:
    with open(_DATA, encoding="utf-8") as f:
        return json.load(f)


@cache
def layouts() -> dict[str, Layout]:
    return {k: parse_layout(k, v) for k, v in data()["layouts"].items()}


def default_layout() -> str:
    return str(data()["default"])


# ── The world ─────────────────────────────────────────────────────────────────


@dataclass
class Ghost:
    name: str
    home: int
    cell: int
    heading: str | None = None
    scared: bool = False
    #: Eaten: waiting at its start, harmless, until `out_at`.
    eyes: bool = False
    #: The first tick it may move.
    out_at: int = 0
    #: One more each time it is put back at its start, so the page does not slide it there.
    gen: int = 0

    @property
    def dangerous(self) -> bool:
        return not self.scared and not self.eyes

    def mode(self) -> str:
        return "e" if self.eyes else "f" if self.scared else "n"


@dataclass
class World:
    layout: Layout
    seed: int | str
    tick: int = 0
    score: int = 0
    lives: int = LIVES
    heading: str | None = None
    want: str | None = None
    fright: int = 0
    chain: int = 0
    pause: int = 0
    caught_at: int | None = None
    caught_by: str | None = None
    ghosts_eaten: int = 0
    #: The tick the current life began (the scatter clock counts from it).
    life_at: int = 0
    #: Why this player's game ended: caught | cleared | time | None while it plays.
    over: str | None = None
    #: Tiles eaten, in order (pellets and power pellets).
    eaten: list[int] = field(default_factory=list)
    #: What happened on the latest tick: "pellet", "power", "ate Blinky", "caught by Pinky", "cleared".
    news: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        L = self.layout
        self.rng = random.Random(f"ghostmaze|{self.seed}")
        self.pellets = set(L.pellets)
        self.power = set(L.power)
        self.player = L.player
        self.heading = L.start
        self.pgen = 0
        self.ghosts = [Ghost(n, L.homes[n], L.homes[n], out_at=RELEASE[n]) for n in GHOSTS]
        self._before = self.ghost_dist()

    # ── reading ──

    @property
    def left(self) -> int:
        return len(self.pellets) + len(self.power)

    def exits(self) -> list[str]:
        return self.layout.exits(self.player)

    def ghost_dist(self) -> dict[str, int]:
        d = self.layout.dist[self.player]
        return {g.name: d[g.cell] for g in self.ghosts}

    def threat(self) -> str | None:
        """The nearest dangerous ghost within NEAR tiles, by name."""
        d = self.layout.dist[self.player]
        near = [(d[g.cell], k) for k, g in enumerate(self.ghosts) if g.dangerous and 0 <= d[g.cell] <= NEAR]
        return self.ghosts[min(near)[1]].name if near else None

    def needs_decision(self) -> bool:
        """Whether there is a choice worth waiting for: at a junction, against a
        wall, standing still, or with a dangerous ghost near."""
        if self.over or self.pause:
            return False
        exits = self.exits()
        if self.heading is None or self.heading not in exits or len(exits) >= 3:
            return True
        return self.threat() is not None

    def view(self) -> dict[str, Any]:
        """The world as the page draws it: tiles, headings, counts. Compact."""
        return {
            "tick": self.tick,
            "player": [self.player, self.heading, self.pgen],
            "ghosts": [[g.cell, g.mode(), g.gen, g.heading] for g in self.ghosts],
            "score": self.score, "lives": self.lives, "left": self.left,
            "fright": self.fright, "pause": self.pause, "caught_at": self.caught_at,
            "threat": self.threat(), "ended": self.over,
        }

    # ── steering ──

    def steer(self, d: str) -> bool:
        """Want to go *d*: taken the first tick it is open. True when it is open now."""
        if d not in DIRS:
            raise ValueError(f"not a direction: {d!r}")
        self.want = d
        return d in self.exits()

    # ── a tick ──

    def step(self) -> None:
        if self.over:
            return
        self.tick += 1
        self.news = []
        self._before = self.ghost_dist()
        if self.pause:
            self.pause -= 1
            return
        self._move_player()
        self._eat()
        if self._collide():
            return
        self._move_ghosts()
        if self._collide():
            return
        if self.fright:
            self.fright -= 1
            if not self.fright:
                self.chain = 0
                for g in self.ghosts:
                    g.scared = False
        if not self.pellets and not self.power:
            self.over = "cleared"
            self.score += CLEAR
            self.news.append("cleared")

    def _move_player(self) -> None:
        L = self.layout
        if self.want is not None and L.step(self.player, self.want) is not None:
            self.heading = self.want
        if self.heading is not None:
            nxt = L.step(self.player, self.heading)
            if nxt is not None:
                self.player = nxt

    def _eat(self) -> None:
        c = self.player
        if c in self.pellets:
            self.pellets.discard(c)
            self.score += PELLET
            self.eaten.append(c)
            self.news.append("pellet")
        elif c in self.power:
            self.power.discard(c)
            self.score += POWER
            self.eaten.append(c)
            self.news.append("power")
            self.fright = FRIGHT_TICKS
            self.chain = 0
            for g in self.ghosts:
                if not g.eyes:
                    g.scared = True
                    if g.heading is not None:
                        g.heading = OPPOSITE[g.heading]

    def _collide(self) -> bool:
        """Ghosts on the player's tile: eaten, or a catch. True when the player
        was caught. (The player moves first, so two that swap tiles meet on one.)"""
        for g in self.ghosts:
            if g.eyes or g.cell != self.player:
                continue
            if g.scared:
                self.score += GHOST * 2 ** self.chain
                self.chain += 1
                self.ghosts_eaten += 1
                g.scared, g.eyes, g.heading = False, True, None
                g.cell = g.home
                g.out_at = self.tick + HOME_TICKS
                g.gen += 1
                self.news.append(f"ate {g.name}")
                continue
            self._caught(g)
            return True
        return False

    def _caught(self, by: Ghost) -> None:
        L = self.layout
        self.lives -= 1
        self.caught_at = self.tick
        self.caught_by = by.name
        self.news.append(f"caught by {by.name}")
        if self.lives <= 0:
            self.over = "caught"
            return
        self.pause = PAUSE_TICKS
        self.life_at = self.tick
        self.player = L.player
        self.heading, self.want = L.start, None
        self.pgen += 1
        self.fright = self.chain = 0
        for g in self.ghosts:
            g.cell = g.home
            g.heading = None
            g.scared = g.eyes = False
            g.out_at = self.tick + PAUSE_TICKS + RELEASE[g.name]
            g.gen += 1

    def _move_ghosts(self) -> None:
        L = self.layout
        for g in self.ghosts:
            if self.tick < g.out_at:
                continue
            g.eyes = False
            if (g.scared and self.tick % 2) or (not g.scared and self.tick % GHOST_REST == 0):
                continue
            d = self._ghost_way(g)
            if d is not None:
                g.heading = d
                g.cell = L.step(g.cell, d)  # type: ignore[assignment]

    def _ghost_way(self, g: Ghost) -> str | None:
        exits = self.layout.exits(g.cell)
        if not exits:
            return None
        back = OPPOSITE[g.heading] if g.heading else None
        ways = [d for d in exits if d != back] or exits
        if len(ways) == 1:
            return ways[0]
        if g.scared or g.name == "Clyde":
            return self.rng.choice(ways)
        tc, tr = self._target(g)
        L = self.layout

        def far(d: str) -> tuple[int, int]:
            c, r = L.xy(L.step(g.cell, d))  # type: ignore[arg-type]
            return (c - tc) ** 2 + (r - tr) ** 2, ORDER.index(d)

        return min(ways, key=far)

    def scattering(self) -> bool:
        return (self.tick - self.life_at) % SCATTER_EVERY < SCATTER_TICKS

    def _target(self, g: Ghost) -> tuple[int, int]:
        L = self.layout
        if self.scattering():
            side, end = CORNER[g.name]
            return (L.cols if side == "right" else -1), (-1 if end == "top" else L.rows)
        c, r = L.xy(self.player)
        if g.name == "Pinky" and self.heading is not None:
            dc, dr = DIRS[self.heading]
            return c + dc * PINKY_AHEAD, r + dr * PINKY_AHEAD
        return c, r


# ── In words ──────────────────────────────────────────────────────────────────

_TO = {"up": "up", "down": "down", "left": "to the left", "right": "to the right"}


def how_far(d: int) -> str:
    """A distance along the corridors, in words (and small numbers only)."""
    if d <= 1:
        return "right next to you"
    if d == 2:
        return "very close, 2 tiles"
    if d <= NEAR:
        return f"close, {d} tiles"
    if d <= HORIZON:
        return f"some way off, {d} tiles"
    return "far away"


def _ways(ways: list[str]) -> str:
    return " or ".join(ways)


def straight(world: World, d: str) -> tuple[int, bool]:
    """(pellets, a power pellet?) in a straight line from the player going *d*."""
    L = world.layout
    n, power, cell = 0, False, L.step(world.player, d)
    while cell is not None:
        n += cell in world.pellets
        power = power or cell in world.power
        cell = L.step(cell, d)
    return n, power


def _nearest(world: World, cells: set[int]) -> tuple[int, int] | None:
    """(tiles, cell) of the nearest of *cells*, or None."""
    d = world.layout.dist[world.player]
    found = [(d[c], c) for c in cells if d[c] >= 0]
    return min(found) if found else None


def you_line(world: World) -> str:
    exits = world.exits()
    h = world.heading
    if world.pause:
        return "back at the start after being caught, waiting for the ghosts to reset"
    if h is None:
        return "standing still at the start"
    if h not in exits:
        return f"stopped against a wall, facing {h}"
    if len(exits) >= 3:
        return f"at a junction, heading {h}"
    if OPPOSITE[h] not in exits:
        return f"at a corner, heading {h}"
    return f"in a corridor, heading {h}"


def ghost_line(world: World, g: Ghost) -> str:
    L = world.layout
    if g.eyes:
        return f"{g.name}: eaten, waiting at its start; harmless for now"
    d = L.dist[world.player][g.cell]
    kind = "frightened, can be eaten" if g.scared else "dangerous"
    parts = [f"{g.name}: {kind}", how_far(d)]
    if d <= HORIZON:
        ways = L.toward(world.player, g.cell)
        where = f"reached by going {_ways(ways)}"
        if world.heading and ways == [world.heading]:
            where += ", ahead of you"
        elif world.heading and ways == [OPPOSITE[world.heading]]:
            where += ", behind you"
        parts.append(where)
        before = world._before.get(g.name, d)
        if world.tick < g.out_at:
            parts.append("not moving yet")
        elif d < before:
            parts.append("coming closer")
        elif d > before:
            parts.append("moving away")
    return ", ".join(parts)


def pellets_line(world: World) -> str:
    counts = [(d, straight(world, d)[0]) for d in world.exits()]
    if any(n for _, n in counts):
        return ", ".join(
            (f"{n} pellet{'s' if n != 1 else ''} {_TO[d]}" if n else f"none {_TO[d]}") for d, n in counts
        )
    near = _nearest(world, world.pellets)
    if near is None:
        return "none left" if not world.power else "none left but the power pellets"
    ways = world.layout.toward(world.player, near[1])
    return f"none in a straight line any way; the nearest is {near[0]} tiles away, reached by going {_ways(ways)}"


def power_line(world: World) -> str:
    if world.fright:
        more = "for a little longer" if world.fright > FRIGHT_ENDING else "but not for much longer"
        return f"on: the ghosts are frightened, {more}"
    near = _nearest(world, world.power)
    if near is None:
        return "off; none left"
    ways = _ways(world.layout.toward(world.player, near[1]))
    if near[0] <= 1:
        return f"off; a power pellet is right next to you, going {ways}"
    far = f"{near[0]} tiles away" if near[0] <= HORIZON else "far away"
    return f"off; the nearest power pellet is {far}, reached by going {ways}"


def exits_line(world: World) -> str:
    exits = world.exits()
    walls = [d for d in ORDER if d not in exits]
    out = f"open: {', '.join(exits)}"
    if len(walls) == 1:
        out += f"; {walls[0]} is a wall"
    elif walls:
        out += f"; {' and '.join(walls)} are walls"
    return out


def describe(world: World) -> dict[str, Any]:
    """The state a player is shown, in words: the fields Jev's question names."""
    return {
        "you": you_line(world),
        "ghosts": [ghost_line(world, g) for g in world.ghosts],
        "pellets": pellets_line(world),
        "power": power_line(world),
        "exits": exits_line(world),
    }


def meaning(world: World, d: str) -> str:
    """What going *d* from here means, in words: one option of the choice."""
    L = world.layout
    n, power = straight(world, d)
    parts = [f"{d}: " + (f"{n} pellet{'s' if n != 1 else ''} in a straight line that way" if n
                         else "no pellets in a straight line that way")]
    if power:
        parts.append("a power pellet that way")
    else:
        near = _nearest(world, world.power)
        if near and near[0] <= HORIZON and d in L.toward(world.player, near[1]):
            parts.append(f"toward the nearest power pellet, {near[0]} tiles")
    if not n:
        near = _nearest(world, world.pellets)
        if near and d in L.toward(world.player, near[1]):
            parts.append(f"toward the nearest pellet, {near[0]} tiles")
    danger = False
    here = L.dist[world.player]
    for g in world.ghosts:
        if g.eyes or not 0 < here[g.cell] <= HORIZON or d not in L.toward(world.player, g.cell):
            continue
        if g.scared:
            parts.append(f"toward {g.name}, frightened: it can be eaten")
        else:
            danger = True
            parts.append(f"toward {g.name}, dangerous, {how_far(here[g.cell])}")
    if not danger:
        parts.append("no dangerous ghost close that way")
    return "; ".join(parts)


def meanings(world: World) -> dict[str, str]:
    return {d: meaning(world, d) for d in world.exits()}
