"""Who may stop or delete a race or a game run.

There are no accounts, so whoever starts one is its owner: the answer to the
start carries `owner_token`, once, and nothing else ever shows it. The page
keeps it (api.js) and sends it back as `X-Owner-Token` to stop or delete. The
server keeps only its SHA-256, in the history's own database, so a copy of the
database stops nothing.

Only a public site (WIKIRACE_PUBLIC) asks for it: there the history is
everyone's to read but not everyone's to wipe, and a stranger's race is not
yours to stop. The admin stops and deletes anything (/api/admin/races/…,
/api/admin/games/runs/…). Off a public site anyone at the page may, as before.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets

from .store import _now, connect

HEADER = "x-owner-token"
#: What an owner token may name: a race, or a game run (their ids are apart).
KINDS = ("race", "run")

_DDL = """
CREATE TABLE IF NOT EXISTS owners (
    kind       TEXT NOT NULL,
    id         TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (kind, id)
)
"""


def init(db_path: str) -> None:
    with connect(db_path) as conn:
        conn.execute(_DDL)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def issue(db_path: str, kind: str, item_id: str) -> str:
    """A new owner token for *item_id*, for the start's answer only."""
    token = secrets.token_urlsafe(24)
    with connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO owners (kind, id, token_hash, created_at) VALUES (?, ?, ?, ?)",
            (kind, item_id, _hash(token), _now()),
        )
    return token


def owns(db_path: str, kind: str, item_id: str, token: str) -> bool:
    """Whether *token* is the one issued for *item_id*."""
    if not token or len(token) > 200:
        return False
    with connect(db_path) as conn:
        row = conn.execute("SELECT token_hash FROM owners WHERE kind = ? AND id = ?", (kind, item_id)).fetchone()
    return row is not None and hmac.compare_digest(row[0], _hash(token))


def forget(db_path: str, kind: str, item_id: str) -> None:
    with connect(db_path) as conn:
        conn.execute("DELETE FROM owners WHERE kind = ? AND id = ?", (kind, item_id))
