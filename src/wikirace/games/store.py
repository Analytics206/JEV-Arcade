"""Arcade history: one row per game run, in the same SQLite file as the races.

A run is written when it starts and when it ends, whole, as JSON: a replay
needs all of it, and nothing queries inside one. The list reads `summary`,
the run with every list left out, so twenty rows do not mean parsing twenty
runs of ten thousand items each.
"""
from __future__ import annotations

import json
from typing import Any

from ..store import _now, connect

_DDL = """
CREATE TABLE IF NOT EXISTS game_runs (
    id          TEXT PRIMARY KEY,
    game        TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    finished_at TEXT,
    summary     TEXT NOT NULL,
    snapshot    TEXT NOT NULL
)
"""
#: A run that was `running` when the process stopped can never finish.
INTERRUPTED = "interrupted"


def init(db_path: str) -> None:
    with connect(db_path) as conn:
        conn.execute(_DDL)
        conn.execute("CREATE INDEX IF NOT EXISTS game_runs_created ON game_runs (game, created_at)")
        conn.execute(
            "UPDATE game_runs SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE status = 'running'",
            (INTERRUPTED, _now()),
        )


def summary(run: dict[str, Any]) -> dict[str, Any]:
    """The run without its lists: top-level lists dropped, and each lane's."""
    out = {k: v for k, v in run.items() if not isinstance(v, list) or k == "lanes"}
    out["lanes"] = [{k: v for k, v in ln.items() if not isinstance(v, list)} for ln in run.get("lanes", [])]
    return out


def serialize(run: dict[str, Any]) -> tuple[Any, ...]:
    return (
        run["id"], run["game"], run["status"], run["created_at"], run.get("finished_at"),
        json.dumps(summary(run)), json.dumps(run),
    )


def write(db_path: str, row: tuple[Any, ...]) -> None:
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO game_runs (id, game, status, created_at, finished_at, summary, snapshot) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, "
            "finished_at = excluded.finished_at, summary = excluded.summary, snapshot = excluded.snapshot",
            row,
        )


def get(db_path: str, run_id: str) -> dict[str, Any] | None:
    with connect(db_path) as conn:
        row = conn.execute("SELECT snapshot, status FROM game_runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        return None
    run = json.loads(row[0])
    run["status"] = row[1]  # an interrupted run's snapshot still says running
    return run


def list_runs(db_path: str, game: str | None, limit: int) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        if game:
            rows = conn.execute(
                "SELECT summary, status FROM game_runs WHERE game = ? ORDER BY created_at DESC LIMIT ?",
                (game, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT summary, status FROM game_runs ORDER BY created_at DESC LIMIT ?", (limit,),
            ).fetchall()
    out = []
    for summary_json, status in rows:
        s = json.loads(summary_json)
        s["status"] = status
        out.append(s)
    return out


def delete(db_path: str, run_id: str) -> bool:
    with connect(db_path) as conn:
        cur = conn.execute("DELETE FROM game_runs WHERE id = ?", (run_id,))
    return cur.rowcount > 0
