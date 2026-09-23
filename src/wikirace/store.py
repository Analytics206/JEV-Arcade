"""Race history: one row per race, in SQLite.

A race is written when it starts, after every move, and when it ends, so the
History tab can replay one that was interrupted halfway as well as one that
finished. It is stored whole, as JSON, because it is only ever read whole: a
replay needs every lane's every step, and nothing queries across races by step.
The list reads `summary` (the race minus the steps) so fifty rows do not mean
parsing fifty full replays.
"""
from __future__ import annotations

import datetime as _dt
import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .race.rules import rank

_DDL = """
CREATE TABLE IF NOT EXISTS races (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    start_title  TEXT NOT NULL,
    target_title TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    finished_at  TEXT,
    winner       TEXT,
    summary      TEXT NOT NULL,
    snapshot     TEXT NOT NULL
)
"""

#: A race that was `running` when the process stopped can never finish: its
#: lanes lived in that process. Stamped at startup so the History tab says so.
INTERRUPTED = "interrupted"
_LIVE_LANE = frozenset({"waiting", "thinking", "rate_limited", "moving"})


def _now() -> str:
    return _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")


@contextmanager
def connect(db_path: str) -> Iterator[sqlite3.Connection]:
    """A connection that commits on success, rolls back on an error, and is
    closed either way (an open handle keeps the file locked on Windows)."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=5.0)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        with conn:
            yield conn
    finally:
        conn.close()


def init(db_path: str) -> None:
    """Create the table, and stamp every race a restart cut short."""
    with connect(db_path) as conn:
        conn.execute(_DDL)
        conn.execute("CREATE INDEX IF NOT EXISTS races_created ON races (created_at)")
        conn.execute(
            "UPDATE races SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
            (INTERRUPTED, _now()),
        )


def summary(race: dict[str, Any]) -> dict[str, Any]:
    return {**race, "lanes": [{k: v for k, v in ln.items() if k != "steps"} for ln in race["lanes"]]}


def _winner_label(race: dict[str, Any]) -> str | None:
    w = race.get("winner")
    if w is None:
        return None
    for ln in race["lanes"]:
        if ln["index"] == w:
            return ln.get("label")
    return None


def serialize(race: dict[str, Any]) -> tuple[Any, ...]:
    """The row for *race*, as the values `write` takes. Pure and quick: the
    engine calls it on the event loop, so the copy it writes is consistent,
    and hands the tuple to a thread for the write itself."""
    return (
        race["id"], race["status"], race["start"]["title"], race["target"]["title"],
        race["created_at"], race.get("finished_at"), _winner_label(race),
        json.dumps(summary(race)), json.dumps(race),
    )


def write(db_path: str, row: tuple[Any, ...]) -> None:
    """Upsert one serialized race. Raises on a write failure: the caller
    decides whether a race goes on without its record (the engine does, and
    retries)."""
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO races"
            " (id, status, start_title, target_title, created_at, finished_at, winner, summary, snapshot)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET status = excluded.status,"
            " finished_at = excluded.finished_at, winner = excluded.winner,"
            " summary = excluded.summary, snapshot = excluded.snapshot",
            row,
        )


def save(db_path: str, race: dict[str, Any]) -> None:
    """Upsert the whole race in one call."""
    write(db_path, serialize(race))


def _settle(race: dict[str, Any], status: str, finished_at: str | None) -> dict[str, Any]:
    """The row's status is the truth. A race stamped interrupted still carries
    the `running` snapshot it was last saved with, lanes mid-thought included,
    so its unfinished racers are called stopped, each gets the clock of its
    last move, and the racers that DID finish are ranked, which the race never
    lived to do.

    Every race that is over is ranked as it is read, by today's rule: a race
    saved when the fewest hops won still names the racer that got there first.
    The stored row is not rewritten."""
    race["status"] = status
    race["finished_at"] = race.get("finished_at") or finished_at
    if status == INTERRUPTED:
        for ln in race["lanes"]:
            if ln.get("status") in _LIVE_LANE:
                ln["status"] = "stopped"
                ln["note"] = "interrupted: the server restarted mid-race"
            if ln.get("elapsed_ms") is None and "steps" in ln:  # a summary has no steps
                steps = ln["steps"] or []
                ln["elapsed_ms"] = steps[-1]["at_ms"] if steps else 0
    if status != "running":
        order = rank(race["lanes"])
        places = {idx: pos for pos, idx in enumerate(order, start=1)}
        for ln in race["lanes"]:
            ln["rank"] = places.get(ln["index"])
        race["ranking"] = order
        race["winner"] = order[0] if order else None
    return race


def get(db_path: str, race_id: str) -> dict[str, Any] | None:
    try:
        with connect(db_path) as conn:
            row = conn.execute(
                "SELECT status, finished_at, snapshot FROM races WHERE id = ?", (race_id,)
            ).fetchone()
    except sqlite3.Error:
        return None
    if row is None:
        return None
    return _settle(json.loads(row[2]), row[0], row[1])


def list_races(db_path: str, limit: int = 50) -> list[dict[str, Any]]:
    """Newest first, without steps. `[]` when the table cannot be read."""
    try:
        with connect(db_path) as conn:
            rows = conn.execute(
                "SELECT status, finished_at, summary FROM races ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
    except sqlite3.Error:
        return []
    return [_settle(json.loads(s), status, fin) for status, fin, s in rows]


def delete(db_path: str, race_id: str) -> bool:
    with connect(db_path) as conn:
        cur = conn.execute("DELETE FROM races WHERE id = ?", (race_id,))
    return cur.rowcount > 0
