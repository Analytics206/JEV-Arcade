"""Ghost Maze: same maze, same seed, one clock. The ghosts don't wait.

TypeSafe's real-time decisions, after its own Doom demo (Jev steering a game
about ten times a second). Every lane plays its own copy of one maze from one
seed (ghostmaze_sim.py: pellets, power pellets, three ghosts, three lives),
and the game is in how the clock treats them:

  realtime  the default: every world ticks every `tick_ms` whatever its player
            is doing. A lane reads its world, asks its model, and turns the
            player the moment the answer lands, however far the world has run
            on meanwhile. Between answers the player keeps going the way it
            last chose, to the next wall. At most one question a tick.
  turns     each world waits for its player wherever there is a choice (a
            junction, a wall, a ghost near), and never runs faster than the
            clock: judgment without the clock's pressure.

A lane's game ends when its player is out of lives, clears the maze, or the
round's ticks (`seconds` of them at `tick_ms`) run out; the others play on.

**Jev** answers one choice per decision over the open ways only, so it can
never walk into a wall, each under an opaque id and meaning what lies that way
in words ("left: 4 pellets in a straight line that way; toward Blinky,
dangerous, close, 3 tiles"). The state is words too: `you`, `ghosts`,
`pellets`, `power`, `exits`. Its probabilities are kept for the page's stick.

**A text model** gets the same words and answers `MOVE: <direction>`. A
direction into a wall, or no MOVE line, is a foul: the heading stays.

The score is the game's: pellets 10, power pellets 50, ghosts 200 then 400
then 800 in one fright, the maze cleared 500.

Streaming stays at one event per lane per tick: the world's view (the player,
the ghosts, score, lives, what has been eaten when that changed) and whatever
calls landed since the last tick, accounted in the same event.
"""
from __future__ import annotations

import asyncio
import contextlib
import random
import time
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from ..race.rules import JEV_INPUT_PER_MTOK
from .base import Context, Game
from .core import choice, match_option, opaque, read_choice, read_field
from .ghostmaze_sim import (
    CLEAR,
    FRIGHT_ENDING,
    FRIGHT_TICKS,
    GHOST,
    GHOST_RULES,
    GHOSTS,
    LIVES,
    ORDER,
    PAUSE_TICKS,
    PELLET,
    POWER,
    World,
    default_layout,
    describe,
    layouts,
    meanings,
)
from .players import Asked, Player, Said, ask_jev, ask_text
from .runs import GameRun

#: Every wait in the game is multiplied by this (tests shrink it: fast fake time).
TIME_SCALE = 1.0
#: When the round ends with a call in flight, it has this long (s) to land and be paid for.
END_GRACE_S = 10.0
#: A turn-based round is stopped after this long (s), however few ticks it has played.
TURNS_CAP_S = 900.0
#: In turn-based play, a lane shows it is thinking once a call has taken this long (s).
THINKING_AFTER_S = 0.3
#: Jev's words for the page are sent at most once in this many ticks (its stick, every answer).
WORDS_EVERY = 5

QUESTION = (
    "Which way should the player in `you` move next to stay away from ghosts that are not "
    "frightened and eat the most pellets?"
)
INSTRUCTIONS: dict[str, Any] = {
    "question": QUESTION,
    "rules": [
        "Each option is one way the player can move from where it is now, with what lies that way.",
        "A ghost in `ghosts` that is dangerous catches the player when they meet: choose a way that is "
        "not toward a dangerous ghost that is right next to you, very close or close.",
        "A frightened ghost can be eaten for points: a way toward it is good.",
        "Otherwise choose the way with the most pellets in a straight line, or the way toward the "
        "nearest pellet when no way has any.",
        "A power pellet frightens every ghost: when a dangerous ghost is close, a way toward a power "
        "pellet is good.",
    ],
}
POINTS = {"pellet": PELLET, "power": POWER, "ghost": GHOST, "clear": CLEAR}


def ticks_for(seconds: int, tick_ms: int) -> int:
    """How many ticks a round of *seconds* lasts."""
    return max(1, round(seconds * 1000 / tick_ms))


def _layouts_public() -> dict[str, Any]:
    return {k: {**L.public(), "start": L.start} for k, L in layouts().items()}


#: One of the mazes in data/ghostmaze.json. (A Literal, so a wrong one is a plain 422.)
LayoutId = Literal[tuple(layouts())]  # type: ignore[valid-type]


class Params(BaseModel):
    mode: Literal["realtime", "turns"] = Field(
        default="realtime", description="realtime: the world ticks on; turns: it waits for each answer",
    )
    seconds: int = Field(default=45, ge=10, le=180, description="the round's length (turn-based: as many ticks)")
    tick_ms: int = Field(default=100, ge=80, le=1000, description="one tick of the world")
    layout: LayoutId = Field(  # type: ignore[valid-type]
        default=default_layout(), description="the maze", json_schema_extra={"x-layouts": _layouts_public()},
    )
    seed: int | None = Field(default=None, ge=0, le=2**31 - 1, description="the same seed, the same ghosts")


# ── What a text model reads ───────────────────────────────────────────────────


def text_system(mode: str, tick_ms: int) -> str:
    if mode == "realtime":
        clock = (
            f"The game runs in real time, {1000 / tick_ms:g} ticks a second, and does not wait for you: "
            "while you think, the player keeps running the way it was going. Answer fast."
        )
    else:
        clock = (
            "The game waits for your answer at every junction, at every wall and whenever a ghost is near; "
            "in between, the player keeps running the way it was going."
        )
    return (
        "You steer the player in a maze game like Pac-Man.\n\n"
        "Rules:\n"
        "- Each tick the player moves one tile in its heading and stops when a wall is ahead. Your answer "
        "sets the way it goes next: it turns that way as soon as that way is open.\n"
        f"- A pellet is worth {PELLET} points and a power pellet {POWER}. A power pellet frightens every "
        f"ghost for a few seconds; a frightened ghost can be eaten for {GHOST} points or more.\n"
        "- Three ghosts hunt the player: Blinky chases it, Pinky heads for where it is going, Clyde wanders. "
        f"A ghost that is not frightened catches the player when they meet, and the player loses one of its "
        f"{LIVES} lives.\n"
        f"- {clock}\n"
        "- You are told, in words, where the player is, where each ghost is, and what lies each way that is open.\n"
        "- Answer one of the open directions. A direction into a wall, or no MOVE line, is a foul, and the "
        "player keeps going the way it was.\n\n"
        "Reply with exactly one line and nothing else:\n"
        "MOVE: up|down|left|right"
    )


def text_prompt(words: dict[str, Any], means: dict[str, str]) -> str:
    return "\n".join([
        f"YOU: {words['you']}",
        "GHOSTS:",
        *(f"- {g}" for g in words["ghosts"]),
        f"PELLETS: {words['pellets']}",
        f"POWER PELLETS: {words['power']}",
        f"EXITS: {words['exits']}",
        "OPEN DIRECTIONS:",
        *(f"- {m}" for m in means.values()),
        "",
        QUESTION.replace("the player in `you`", "the player"),
        "Reply with one line: MOVE: <direction>",
    ])


def read_move(reply: str, offered: list[str]) -> tuple[str | None, str | None, str]:
    """(the way, the foul, what it said) from a text model's reply: the way is
    one of *offered*, else the foul says why not."""
    claimed = read_field(reply, "MOVE")
    if claimed is None:
        first = next((r.strip() for r in (reply or "").splitlines() if r.strip()), "")
        return None, "no MOVE line", first[:60]
    move = match_option(claimed, offered)
    if move is not None:
        return move, None, claimed[:60]
    if match_option(claimed, ORDER) is not None:
        return None, "into a wall", claimed[:60]
    return None, "not a direction", claimed[:60]


# ── A lane ────────────────────────────────────────────────────────────────────


@dataclass
class Lane:
    """One lane's world, and what stands between its answers and the stream."""

    i: int
    world: World
    over: asyncio.Event = field(default_factory=asyncio.Event)
    #: Calls answered since the last event, each with the fields it brings.
    pending: list[tuple[Asked | Said, dict[str, Any]]] = field(default_factory=list)
    #: The tick a call in flight was asked on.
    asking: int | None = None
    last_asked: int = -1
    #: Answers turned into a heading; late ones (asked before a catch) and fouls apart.
    answered: int = 0
    late: int = 0
    fouls: int = 0
    #: Ticks from question to answer, summed over `answered`.
    lag: int = 0
    words_tick: int = -(10 ** 9)
    sent_eaten: int = -1
    ended: str | None = None
    _tick: asyncio.Event = field(default_factory=asyncio.Event)

    def ticked(self) -> None:
        ev, self._tick = self._tick, asyncio.Event()
        ev.set()

    async def next_tick(self) -> None:
        await self._tick.wait()

    def finish(self, why: str) -> None:
        if self.ended is None:
            self.ended = why
            if self.world.over is None and why == "time":
                self.world.over = "time"
        self.over.set()
        self.ticked()


def emit(run: GameRun, ln: Lane) -> None:
    """Lane *ln*'s world as it is now, and every call that landed since the
    last time, in one event (one more per extra call, which is rare)."""
    w = ln.world
    f = w.view()
    f.update(asking=ln.asking, answered=ln.answered, late=ln.late, lag=ln.lag, fouls=ln.fouls)
    if len(w.eaten) != ln.sent_eaten:
        f["eaten"] = list(w.eaten)
        ln.sent_eaten = len(w.eaten)
    pend, ln.pending = ln.pending, []
    if not pend:
        run.lane(ln.i, **f)
        return
    brought: dict[str, Any] = {}
    for _, extra in pend:
        brought.update(extra)
    for call, _ in pend[:-1]:
        run.account(ln.i, call)
    run.account(ln.i, pend[-1][0], **f, **brought)


# ── Play ──────────────────────────────────────────────────────────────────────


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    L = layouts()[p.layout]
    seed = p.seed if p.seed is not None else random.SystemRandom().randrange(1, 1_000_000)
    return {
        "layout": {**L.public(), "start": L.start}, "seed": seed, "mode": p.mode, "tick_ms": p.tick_ms,
        "total_ticks": ticks_for(p.seconds, p.tick_ms),
        "ghost_rules": [{"name": n, "rule": GHOST_RULES[n]} for n in GHOSTS],
        "points": POINTS, "lives": LIVES, "fright_ticks": FRIGHT_TICKS, "fright_ending": FRIGHT_ENDING,
        "pause_ticks": PAUSE_TICKS, "jev_per_mtok": JEV_INPUT_PER_MTOK, "question": QUESTION,
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    L = layouts()[p.layout]
    total = int(run.state["total_ticks"])
    tick_s = p.tick_ms / 1000 * TIME_SCALE
    lanes = [Lane(pl.index, World(L, run.state["seed"])) for pl in ctx.players]
    system = text_system(p.mode, p.tick_ms)
    for ln in lanes:
        emit(run, ln)
        run.lane(ln.i, score=0, last=None, words=None)

    async def ask(pl: Player, ln: Lane) -> None:
        """One decision: the world in words, the model's answer, the heading."""
        w = ln.world
        tick = w.tick
        ln.last_asked = tick
        offered = w.exits()
        if len(offered) < 2:  # nothing to choose (the layouts have no dead ends)
            if offered:
                w.steer(offered[0])
            return
        words = describe(w)
        means = meanings(w)
        ln.asking = tick
        shown = None
        if p.mode == "turns":
            shown = asyncio.get_running_loop().call_later(
                THINKING_AFTER_S * TIME_SCALE, lambda: run.lane(ln.i, asking=tick),
            )
        try:
            if pl.is_jev:
                ids = opaque(offered, f"ghostmaze|{run.id}|{ln.i}|{tick}", prefix="w")
                question = choice(INSTRUCTIONS, {oid: means[d] for oid, d in ids.items()})
                asked = await ask_jev(pl, words, {"move": question}, on_wait=run.waiting(ln.i))
                pick = read_choice(asked.answers["move"], ids)
                call: Asked | Said = asked
                move, foul = pick.option, None
                said = {"p": {d: round(pr, 4) for d, pr in pick.ranked}, "confidence": round(pick.confidence, 4)}
            else:
                reply = await ask_text(pl, system, text_prompt(words, means), on_wait=run.waiting(ln.i))
                call = reply
                move, foul, text = read_move(reply.text, offered)
                said = {"said": text}
        finally:
            ln.asking = None
            if shown is not None:
                shown.cancel()
        last: dict[str, Any] = {
            "tick": tick, "at": w.tick, "ms": call.latency_ms, "offered": offered, "dir": move, "foul": foul, **said,
        }
        if foul:
            ln.fouls += 1
        elif w.over is None and w.caught_at is not None and tick < w.caught_at:
            ln.late += 1  # asked about a life that has ended since
            last["late"] = True
        elif w.over is None:
            w.steer(move)  # type: ignore[arg-type]
            ln.answered += 1
            ln.lag += w.tick - tick
        extra: dict[str, Any] = {"last": last}
        if not pl.is_jev or tick - ln.words_tick >= WORDS_EVERY:
            extra["words"] = {"tick": tick, "state": words, "options": means}
            ln.words_tick = tick
        if ln.over.is_set():  # the round is over: no more ticks to carry it
            run.account(ln.i, call, fouls=ln.fouls, answered=ln.answered, late=ln.late, lag=ln.lag, **extra)
        else:
            ln.pending.append((call, extra))

    # ── real time: one clock for every world ──

    failure: list[BaseException] = []

    async def ticker() -> None:
        started = time.monotonic()
        try:
            for t in range(1, total + 1):
                await asyncio.sleep(max(0.0, started + t * tick_s - time.monotonic()))
                live = [ln for ln in lanes if not ln.over.is_set()]
                if not live:
                    return
                for ln in live:
                    ln.world.step()
                    if ln.world.over:
                        ln.finish(ln.world.over)
                    elif t == total:
                        ln.finish("time")
                    emit(run, ln)
                    ln.ticked()
        except Exception as exc:  # noqa: BLE001 - a bug in the clock ends every lane, and the run
            failure.append(exc)
            for ln in lanes:
                ln.finish("error")

    async def realtime(pl: Player) -> None:
        ln = lanes[pl.index]
        w = ln.world

        async def decide() -> None:
            while not ln.over.is_set():
                # One question a tick, and one only while a catch's pause holds the world still.
                if w.tick <= ln.last_asked or (w.pause and ln.last_asked >= (w.caught_at or 0)):
                    await ln.next_tick()
                    continue
                await ask(pl, ln)

        task = asyncio.ensure_future(decide())
        ended = asyncio.ensure_future(ln.over.wait())
        try:
            await asyncio.wait({task, ended}, return_when=asyncio.FIRST_COMPLETED)
            if task.done() and ln.ended is None:
                ln.finish("error")
                emit(run, ln)  # what landed before it failed is still paid for
                task.result()
                return
            # The round is over. A call in flight may still land and be paid for.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(task), END_GRACE_S)
        finally:
            for t in (task, ended):
                t.cancel()
            await asyncio.gather(task, ended, return_exceptions=True)

    # ── turn-based: each world waits for its own player ──

    async def turns(pl: Player) -> None:
        ln = lanes[pl.index]
        w = ln.world
        cap = time.monotonic() + TURNS_CAP_S
        while True:
            started = time.monotonic()
            if w.needs_decision():
                await ask(pl, ln)
            await asyncio.sleep(max(0.0, started + tick_s - time.monotonic()))
            w.step()
            if w.over:
                ln.finish(w.over)
            elif w.tick >= total or time.monotonic() > cap:
                ln.finish("time")
            emit(run, ln)
            if ln.over.is_set():
                return

    clock = asyncio.ensure_future(ticker()) if p.mode == "realtime" else None
    try:
        await run.each_lane(realtime if p.mode == "realtime" else turns)
    finally:
        if clock is not None:
            clock.cancel()
            await asyncio.gather(clock, return_exceptions=True)
    if failure:
        raise failure[0]


GAME = Game(
    id="ghostmaze", title="Ghost Maze",
    tagline="Same maze, same seed, one clock. The ghosts don't wait",
    use_case="real-time decisions", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
