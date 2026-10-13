"""Contact enquiries: a copy of every message sent from the Contact page.

The Contact page opens the visitor's own email app with the message written
in; that email is what reaches us, and the server sends no mail. Before it
does, the page posts a copy here, so a message is not lost to a mail app that
never opened or an email never sent. The visitor is not told: "we have your
message" would invite them not to send it.

Enquiries live in the history's database (the one worth a backup), not the
traffic log's, and are never deleted except by an admin.

`POST /api/contact` is open to anyone, so it is fenced: a rate limit, a
repeat of the same message within a few minutes is not stored twice, and a
field no person sees (`cabinet_code`, named after nothing a browser fills
in) catches scripts that fill in every field. All three answer as a success.
"""
from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

from .logins import RateLimit
from .store import connect
from .traffic import iso, now_iso

#: The same email and message again within this long is a repeat.
REPEAT_WINDOW = timedelta(minutes=10)
#: 5 per address per 10 minutes, 60 in all.
CONTACT_LIMITS = (5, 10 * 60, 60)
STATUSES = ("waiting", "handled", "all")

_DDL = """
CREATE TABLE IF NOT EXISTS enquiries (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL,
    message    TEXT NOT NULL,
    digest     TEXT NOT NULL,
    ip         TEXT NOT NULL,
    country    TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'waiting',
    handled_at TEXT,
    handled_by TEXT
);
CREATE INDEX IF NOT EXISTS enquiries_created ON enquiries (created_at);
"""


def init(db_path: str) -> None:
    with connect(db_path) as conn:
        conn.executescript(_DDL)


def limiter() -> RateLimit:
    limit, window, overall = CONTACT_LIMITS
    return RateLimit(limit, window, overall)


def _digest(email: str, message: str) -> str:
    return hashlib.sha256(f"{email.strip().lower()}\0{' '.join(message.split())}".encode()).hexdigest()


def add(db_path: str, *, name: str, email: str, message: str, who: dict[str, Any],
        now: datetime | None = None) -> int | None:
    """Store one enquiry; its id, or None when it repeats one just sent."""
    now = now or datetime.now(UTC)
    digest = _digest(email, message)
    with connect(db_path) as conn:
        if conn.execute(
            "SELECT 1 FROM enquiries WHERE digest = ? AND created_at >= ?", (digest, iso(now - REPEAT_WINDOW)),
        ).fetchone():
            return None
        cur = conn.execute(
            "INSERT INTO enquiries (created_at, name, email, message, digest, ip, country, user_agent) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (iso(now), name.strip(), email.strip(), message.strip(), digest, who.get("ip", ""),
             who.get("country", ""), who.get("user_agent", "")),
        )
        return cur.lastrowid


def listing(db_path: str, *, status: str = "waiting", page: int = 1, per: int = 25) -> dict[str, Any]:
    """Newest first, and how many are waiting, handled, and in all."""
    where = "1=1" if status == "all" else "status = ?"
    args: tuple[Any, ...] = () if status == "all" else (status,)
    with connect(db_path) as conn:
        counts = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(status = 'waiting'), 0), COALESCE(SUM(status = 'handled'), 0) "
            "FROM enquiries",
        ).fetchone()
        total = conn.execute(f"SELECT COUNT(*) FROM enquiries WHERE {where}", args).fetchone()[0]
        cur = conn.execute(
            "SELECT id, created_at, name, email, message, ip, country, user_agent, status, handled_at, handled_by "
            f"FROM enquiries WHERE {where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            (*args, per, (page - 1) * per),
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
    return {"total": total, "page": page, "per": per, "rows": rows,
            "counts": {"all": counts[0], "waiting": counts[1], "handled": counts[2]}}


def set_handled(db_path: str, enquiry_id: int, handled: bool, by: str) -> bool:
    with connect(db_path) as conn:
        cur = conn.execute(
            "UPDATE enquiries SET status = ?, handled_at = ?, handled_by = ? WHERE id = ?",
            ("handled", now_iso(), by, enquiry_id) if handled else ("waiting", None, None, enquiry_id),
        )
        return cur.rowcount > 0


def get(db_path: str, enquiry_id: int) -> dict[str, Any] | None:
    with connect(db_path) as conn:
        cur = conn.execute("SELECT id, email, created_at FROM enquiries WHERE id = ?", (enquiry_id,))
        row = cur.fetchone()
    return {"id": row[0], "email": row[1], "created_at": row[2]} if row else None


def delete(db_path: str, enquiry_id: int) -> bool:
    with connect(db_path) as conn:
        return conn.execute("DELETE FROM enquiries WHERE id = ?", (enquiry_id,)).rowcount > 0


def forget(db_path: str, email: str) -> int:
    """Delete every enquiry from one email address (docs/traffic.md)."""
    with connect(db_path) as conn:
        return conn.execute("DELETE FROM enquiries WHERE lower(email) = lower(?)", (email.strip(),)).rowcount
