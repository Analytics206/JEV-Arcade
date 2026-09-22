"""An Arcade game in progress: a background task whose every change is an event.

The same shape as a WikiRace race (race/engine.py), for any game. A run is
plain JSON, `state`, and it changes only through the mutators below, each of
which emits the matching event. The page applies them with one pure reducer
(static/games/runstate.js, `applyRunEvent`), so the two cannot disagree about
what a change means. Everything here runs on the event loop's thread.

Events, as SSE `data:` JSON:

  {"type": "snapshot", "run": {...}}                         first, on every connection
  {"type": "patch", "patch": {...}}                          top-level fields changed
  {"type": "lane", "lane": i, "patch": {...}}                fields of lane i changed
  {"type": "push", "key": k, "item": x}                      x appended to the list at k
  {"type": "put", "key": k, "index": n, "item": x}           the list at k, item n, is now x
  {"type": "lane_push", "lane": i, "key": k, "item": x}      x appended to lane i's list at k
  {"type": "end"}                                            the run is over; the stream closes

Every run has `id`, `game`, `status` (running | finished | stopped | error),
`created_at`, `finished_at`, `params`, `note` and `lanes`; a game adds its own
fields (`extra`) and lists. A lane's own fields are in `new_lane`.

A run is written to SQLite when it starts and when it ends (games/store.py),
and stays in memory a while after, so a page that attaches late still reads
it live. A game's `play(run, ctx)` does the work; it returns when the game is
over, and any exception it raises ends the run as `error`, in its own words.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime
from typing import Any

from . import store
from .players import Asked, Player, PlayError, Said

#: Runs that may be live at once across every game.
MAX_LIVE = 4
#: A silent stream gets a comment this often, so nothing decides it is dead.
KEEPALIVE_S = 15.0
#: A finished run stays attached this long, for pages that connect late.
_LINGER_S = 600.0
_LIVE: dict[str, GameRun] = {}

#: Lane states. A game may add its own fields, but not its own statuses.
LANE_STATUSES = ("waiting", "playing", "rate_limited", "done", "error", "stopped")
LANE_ENDED = frozenset({"done", "error", "stopped"})


class TooManyRuns(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def new_lane(p: Player) -> dict[str, Any]:
    return {
        "index": p.index, "key": p.key, "label": p.label, "provider": p.provider,
        "model_id": p.model_id, "kind": p.kind, "thinking": p.thinking,
        "status": "waiting", "note": None,
        "tokens_in": 0, "tokens_out": 0,
        #: Known cost so far; `cost_unknown` when a call had no price at all.
        "cost": 0.0, "cost_estimated": False, "cost_unknown": False,
        #: Time spent waiting on the model, summed over calls.
        "think_ms": 0, "calls": 0, "fouls": 0,
        #: The game's headline number for this lane, whatever it counts.
        "score": None,
    }


class GameRun:
    def __init__(
        self, *, game: str, players: Sequence[Player], params: dict[str, Any], db_path: str,
        extra: dict[str, Any] | None = None,
    ) -> None:
        self.players = list(players)
        self.db_path = db_path
        self.state: dict[str, Any] = {
            "id": uuid.uuid4().hex[:12], "game": game, "status": "running",
            "created_at": now_iso(), "finished_at": None, "elapsed_ms": 0,
            "params": params, "note": None,
            "lanes": [new_lane(p) for p in self.players],
        }
        for k, v in (extra or {}).items():
            if k in self.state:
                raise ValueError(f"a game cannot use the run field {k!r}")
            self.state[k] = v
        #: Every event so far, framed for SSE once however many pages watch.
        self.events: list[str] = []
        self.done = False
        self.task: asyncio.Task[None] | None = None
        self._tick = asyncio.Event()
        self._t0 = time.monotonic()
        self._stop_requested = False
        self._writes: set[asyncio.Task[None]] = set()
        # Writes land in the order they were made: the lock hands itself on
        # first come, first served, so the final state is always written last.
        self._write_lock = asyncio.Lock()

    @property
    def id(self) -> str:
        return str(self.state["id"])

    @property
    def stopping(self) -> bool:
        return self._stop_requested

    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    # ── events ──

    def _emit(self, event: dict[str, Any]) -> None:
        self.events.append(f"data: {json.dumps(event)}\n\n")
        self._wake()

    def _wake(self) -> None:
        tick, self._tick = self._tick, asyncio.Event()
        tick.set()

    def patch(self, **fields: Any) -> None:
        self.state.update(fields)
        self._emit({"type": "patch", "patch": fields})

    def lane(self, i: int, **fields: Any) -> None:
        self.state["lanes"][i].update(fields)
        self._emit({"type": "lane", "lane": i, "patch": fields})

    def push(self, key: str, item: Any) -> None:
        self.state.setdefault(key, []).append(item)
        self._emit({"type": "push", "key": key, "item": item})

    def put(self, key: str, index: int, item: Any) -> None:
        self.state[key][index] = item
        self._emit({"type": "put", "key": key, "index": index, "item": item})

    def lane_push(self, i: int, key: str, item: Any) -> None:
        self.state["lanes"][i].setdefault(key, []).append(item)
        self._emit({"type": "lane_push", "lane": i, "key": key, "item": item})

    def account(self, i: int, call: Asked | Said, **also: Any) -> None:
        """Add one call's tokens, cost and time to lane *i* (and any other
        fields in *also*), in one event."""
        ln = self.state["lanes"][i]
        fields: dict[str, Any] = {
            "tokens_in": ln["tokens_in"] + call.tokens_in,
            "tokens_out": ln["tokens_out"] + getattr(call, "tokens_out", 0),
            "think_ms": ln["think_ms"] + call.latency_ms,
            "calls": ln["calls"] + 1,
        }
        cost = call.cost
        if cost is None:
            fields["cost_unknown"] = True
        else:
            fields["cost"] = round(ln["cost"] + cost, 8)
            if isinstance(call, Asked) or getattr(call, "cost_estimated", False):
                fields["cost_estimated"] = True
        fields.update(also)
        self.lane(i, **fields)

    def foul(self, i: int, **also: Any) -> None:
        self.lane(i, fouls=self.state["lanes"][i]["fouls"] + 1, **also)

    def waiting(self, i: int) -> Callable[[str | None], None]:
        """A callback for `ask_jev`/`ask_text` that shows a rate-limit wait on lane *i*."""
        def on_wait(note: str | None) -> None:
            ln = self.state["lanes"][i]
            if note:
                self.lane(i, status="rate_limited", note=note)
            elif ln["status"] == "rate_limited":
                self.lane(i, status="playing", note=None)
        return on_wait

    def snapshot(self) -> tuple[int, str]:
        return len(self.events), f"data: {json.dumps({'type': 'snapshot', 'run': self.state})}\n\n"

    async def wait(self, seen: int, timeout: float) -> bool:
        if len(self.events) > seen or self.done:
            return True
        tick = self._tick
        try:
            await asyncio.wait_for(tick.wait(), timeout)
        except TimeoutError:
            return False
        return True

    # ── lanes ──

    async def each_lane(self, play_lane: Callable[[Player], Awaitable[None]]) -> None:
        """Run *play_lane* for every player at once. A lane that raises ends as
        `error` in its own words; the others play on. A lane that returns is
        `done` unless it set another ending itself."""
        async def one(p: Player) -> None:
            i = p.index
            if self.state["lanes"][i]["status"] == "waiting":
                self.lane(i, status="playing")
            try:
                await play_lane(p)
            except asyncio.CancelledError:
                if self.state["lanes"][i]["status"] not in LANE_ENDED:
                    self.lane(i, status="stopped", note="stopped")
                raise
            except PlayError as exc:
                self.lane(i, status="error", note=str(exc))
                return
            except Exception as exc:  # noqa: BLE001 - a bug ends this lane, never the run
                self.lane(i, status="error", note=f"{type(exc).__name__}: {exc}")
                return
            if self.state["lanes"][i]["status"] not in LANE_ENDED:
                self.lane(i, status="done")

        await asyncio.gather(*(one(p) for p in self.players))

    # ── lifecycle ──

    def start(self, play: Callable[[GameRun], Awaitable[None]]) -> None:
        _LIVE[self.id] = self
        self._write()
        self.task = asyncio.get_running_loop().create_task(self._run(play), name=f"arcade-{self.id}")

    def stop(self) -> None:
        self._stop_requested = True
        if self.task is not None and not self.task.done():
            self.task.cancel()

    async def _run(self, play: Callable[[GameRun], Awaitable[None]]) -> None:
        self._t0 = time.monotonic()
        status, note = "finished", None
        try:
            await play(self)
        except asyncio.CancelledError:
            status, note = "stopped", "stopped before it finished"
        except PlayError as exc:
            status, note = "error", str(exc)
        except Exception as exc:  # noqa: BLE001 - shown on the page, in its own words
            status, note = "error", f"{type(exc).__name__}: {exc}"
        self._finalize(status, note)

    def _finalize(self, status: str, note: str | None) -> None:
        for ln in self.state["lanes"]:
            if ln["status"] not in LANE_ENDED:
                self.lane(ln["index"], status="stopped" if status == "stopped" else "done")
        fields: dict[str, Any] = {"status": status, "finished_at": now_iso(), "elapsed_ms": self.elapsed_ms()}
        if note is not None and self.state.get("note") is None:
            fields["note"] = note
        self.patch(**fields)
        self.done = True
        self._wake()
        self._write()
        with contextlib.suppress(RuntimeError):
            asyncio.get_running_loop().call_later(_LINGER_S, _LIVE.pop, self.id, None)

    def _write(self) -> None:
        row = store.serialize(self.state)  # on the loop: a consistent copy

        async def write() -> None:
            async with self._write_lock:
                with contextlib.suppress(Exception):  # a busy database must not stop a game
                    await asyncio.to_thread(store.write, self.db_path, row)

        try:
            task = asyncio.get_running_loop().create_task(write())
        except RuntimeError:
            return
        self._writes.add(task)
        task.add_done_callback(self._writes.discard)

    async def flushed(self) -> None:
        """Until every write so far has landed. For tests and shutdown."""
        while self._writes:
            await asyncio.gather(*list(self._writes), return_exceptions=True)


def start_run(
    *, game: str, players: Sequence[Player], params: dict[str, Any], db_path: str,
    play: Callable[[GameRun], Awaitable[None]], extra: dict[str, Any] | None = None,
) -> GameRun:
    if sum(1 for r in _LIVE.values() if not r.done) >= MAX_LIVE:
        raise TooManyRuns(f"{MAX_LIVE} games are already running; stop one or wait for it to finish")
    run = GameRun(game=game, players=players, params=params, db_path=db_path, extra=extra)
    run.start(play)
    return run


def get_live(run_id: str) -> GameRun | None:
    return _LIVE.get(run_id)


def forget(run_id: str) -> None:
    _LIVE.pop(run_id, None)


def live_runs() -> list[GameRun]:
    return list(_LIVE.values())


async def stop_all(wait_s: float = 5.0) -> None:
    """Stop what is still running and wait briefly for it to be written."""
    running = [r for r in _LIVE.values() if not r.done]
    for run in running:
        run.stop()
    tasks = [r.task for r in running if r.task is not None]
    if tasks:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), wait_s)
    for run in running:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(run.flushed(), wait_s)


def wake_all() -> None:
    for run in _LIVE.values():
        run._wake()
