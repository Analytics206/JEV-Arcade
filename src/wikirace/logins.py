"""Admin sign-in: one admin, a password, a session, and a log of every
sign-in, sign-out and failed attempt (docs/traffic.md, "Admin").

The arcade itself has no accounts. The admin pages (/admin) do: one person,
WIKIRACE_ADMIN_EMAIL, with a password kept only as a scrypt hash
(WIKIRACE_ADMIN_PASSWORD_HASH, which `wikirace --hash-password` writes). A
sign-in that checks out is given a random session token in an HttpOnly,
SameSite=Strict cookie scoped to /api/admin; the server keeps only the
token's SHA-256, so a copy of the database signs nobody in. Every admin
request looks its session up again, and changing the email or the password
ends every session made under the old one.

The server sees the whole sign-in, so it logs it itself; the page reports
nothing. A row is `verified` when the server checked it (a sign-in, a
sign-out); a failed attempt is not, and its email is only what was typed: a
sign someone is trying an address, not a fact about whoever owns it. No
password, typed or stored, and no session token is ever written to the log.

Failed attempts are rate limited per address and in all (`LOGIN_LIMITS`);
past the limit the password is not even checked. A log that cannot be
written never stops a sign-in.
"""
from __future__ import annotations

import collections
import contextlib
import hashlib
import hmac
import secrets
import threading
import time
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any

from .store import connect
from .traffic import iso, now_iso

#: scrypt's cost: 32 MiB and roughly a tenth of a second per check.
_N, _R, _P = 2**15, 8, 1
_MAXMEM = 64 * 1024 * 1024
#: How long a sign-in lasts.
SESSION_HOURS = 12
COOKIE = "wikirace_admin"
COOKIE_PATH = "/api/admin"

_DDL = """
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    -- Which password made it: a new password ends the old sessions.
    key_id     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signins (
    id         INTEGER PRIMARY KEY,
    ts         TEXT NOT NULL,
    event      TEXT NOT NULL,
    verified   INTEGER NOT NULL,
    email      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    session    TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip         TEXT NOT NULL,
    country    TEXT NOT NULL,
    city       TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    browser    TEXT NOT NULL,
    os         TEXT NOT NULL,
    device     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signins_ts ON signins (ts);
CREATE TABLE IF NOT EXISTS admin_audit (
    id      INTEGER PRIMARY KEY,
    ts      TEXT NOT NULL,
    email   TEXT NOT NULL,
    action  TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail  TEXT NOT NULL
);
"""


def init(db_path: str) -> None:
    with connect(db_path) as conn:
        conn.executescript(_DDL)


# ── The password ─────────────────────────────────────────────────────────────


def hash_password(password: str, *, n: int = _N) -> str:
    """`scrypt:N:r:p:salt:hash`, in hex: no `$`, which Docker Compose would
    read as a variable in .env."""
    salt = secrets.token_bytes(16)
    key = hashlib.scrypt(password.encode(), salt=salt, n=n, r=_R, p=_P, maxmem=_MAXMEM, dklen=32)
    return f"scrypt:{n}:{_R}:{_P}:{salt.hex()}:{key.hex()}"


def parse_hash(encoded: str) -> tuple[int, int, int, bytes, bytes] | None:
    parts = encoded.strip().split(":")
    if len(parts) != 6 or parts[0] != "scrypt":
        return None
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, key = bytes.fromhex(parts[4]), bytes.fromhex(parts[5])
    except ValueError:
        return None
    if n < 2**10 or n > 2**20 or n & (n - 1) or not 1 <= r <= 32 or not 1 <= p <= 16 or len(salt) < 8 or len(key) < 16:
        return None
    return n, r, p, salt, key


def verify_password(password: str, encoded: str) -> bool:
    parsed = parse_hash(encoded)
    if parsed is None:
        return False
    n, r, p, salt, key = parsed
    got = hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=_MAXMEM, dklen=len(key))
    return hmac.compare_digest(got, key)


def key_id(encoded: str) -> str:
    """A short name for one password hash, so its sessions can be told apart."""
    return hashlib.sha256(encoded.encode()).hexdigest()[:16]


def check(email: str, password: str, admin_email: str | None, admin_hash: str | None) -> bool:
    """Whether *email* and *password* are the admin's. The password is checked
    even for a wrong email, so the answer takes as long either way."""
    if not admin_email or not admin_hash:
        return False
    ok = verify_password(password, admin_hash)
    return ok and hmac.compare_digest(email.strip().lower().encode(), admin_email.encode())


# ── Sessions ─────────────────────────────────────────────────────────────────


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_ref(token: str) -> str:
    """The few characters of a session the log shows, to pair a sign-in with
    its sign-out: from the hash, so the log cannot be used to sign in."""
    return _token_hash(token)[:10]


def open_session(db_path: str, email: str, admin_hash: str, *, now: datetime | None = None) -> tuple[str, str]:
    """A new session for *email*: its token (for the cookie only) and when it ends."""
    now = now or datetime.now(UTC)
    token = secrets.token_urlsafe(32)
    expires = iso(now + timedelta(hours=SESSION_HOURS))
    with connect(db_path) as conn:
        conn.execute("DELETE FROM admin_sessions WHERE expires_at < ?", (iso(now),))
        conn.execute(
            "INSERT INTO admin_sessions (token_hash, email, key_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (_token_hash(token), email, key_id(admin_hash), iso(now), expires),
        )
    return token, expires


def session(db_path: str, token: str, admin_email: str | None, admin_hash: str | None,
            *, now: datetime | None = None) -> dict[str, str] | None:
    """The live session *token* names, for today's admin and password, or None."""
    if not token or not admin_email or not admin_hash or len(token) > 200:
        return None
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT email, key_id, expires_at FROM admin_sessions WHERE token_hash = ?", (_token_hash(token),),
        ).fetchone()
    if row is None:
        return None
    email, kid, expires = row
    if expires <= iso(now or datetime.now(UTC)) or email != admin_email or kid != key_id(admin_hash):
        return None
    return {"email": email, "expires_at": expires}


def close_session(db_path: str, token: str) -> None:
    with connect(db_path) as conn:
        conn.execute("DELETE FROM admin_sessions WHERE token_hash = ?", (_token_hash(token),))


# ── The log ──────────────────────────────────────────────────────────────────


def record(db_path: str, event: str, *, verified: bool, email: str, who: Mapping[str, Any],
           reason: str = "", session: str = "", expires_at: str = "") -> None:
    """One sign-in event. Never raises: logging must not break a sign-in."""
    try:
        with connect(db_path) as conn:
            conn.execute(
                "INSERT INTO signins (ts, event, verified, email, reason, session, expires_at, ip, country, city, "
                "user_agent, browser, os, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (now_iso(), event, int(verified), email[:320], reason[:200], session, expires_at,
                 who.get("ip", ""), who.get("country", ""), who.get("city", ""), who.get("user_agent", ""),
                 who.get("browser", ""), who.get("os", ""), who.get("device", "")),
            )
    except Exception as exc:  # noqa: BLE001
        print(f"sign-in log: not written: {exc}", flush=True)


def audit(db_path: str, email: str, action: str, subject: str, detail: str = "") -> None:
    """What an admin did (an enquiry handled, deleted). Never raises."""
    try:
        with connect(db_path) as conn:
            conn.execute(
                "INSERT INTO admin_audit (ts, email, action, subject, detail) VALUES (?, ?, ?, ?, ?)",
                (now_iso(), email, action, subject[:200], detail[:500]),
            )
    except Exception as exc:  # noqa: BLE001
        print(f"audit log: not written: {exc}", flush=True)


def signins(db_path: str, *, verified: str = "all", page: int = 1, per: int = 50) -> dict[str, Any]:
    where = {"yes": "verified = 1", "no": "verified = 0"}.get(verified, "1=1")
    with connect(db_path) as conn:
        counts = conn.execute(
            "SELECT COUNT(*), COALESCE(SUM(verified), 0), COALESCE(SUM(event = 'signed_in'), 0) FROM signins",
        ).fetchone()
        total = conn.execute(f"SELECT COUNT(*) FROM signins WHERE {where}").fetchone()[0]
        cur = conn.execute(
            f"SELECT * FROM signins WHERE {where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
            (per, (page - 1) * per),
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
    for r in rows:
        r["verified"] = bool(r["verified"])
    return {
        "total": total, "page": page, "per": per, "rows": rows,
        "counts": {"all": counts[0], "verified": counts[1], "unverified": counts[0] - counts[1],
                   "sign_ins": counts[2]},
    }


def audit_log(db_path: str, *, limit: int = 100) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        cur = conn.execute("SELECT * FROM admin_audit ORDER BY ts DESC, id DESC LIMIT ?", (limit,))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]


def prune(db_path: str, days: int, *, now: datetime | None = None) -> int:
    """Sign-in rows older than *days* (they hold IP addresses), and dead sessions."""
    now = now or datetime.now(UTC)
    with connect(db_path) as conn:
        conn.execute("DELETE FROM admin_sessions WHERE expires_at < ?", (iso(now),))
        return conn.execute("DELETE FROM signins WHERE ts < ?", (iso(now - timedelta(days=days)),)).rowcount


def forget(db_path: str, *, ip: str = "", email: str = "") -> int:
    """Delete one person's sign-in rows, by address or by the email typed."""
    with connect(db_path) as conn:
        return conn.execute(
            "DELETE FROM signins WHERE (? != '' AND ip = ?) OR (? != '' AND lower(email) = lower(?))",
            (ip, ip, email, email),
        ).rowcount


# ── Rate limits ──────────────────────────────────────────────────────────────


class RateLimit:
    """At most *limit* events per *window_s* seconds, per key and (with
    `overall`) in all. In memory: one process serves the site."""

    def __init__(self, limit: int, window_s: float, overall: int | None = None) -> None:
        self.limit, self.window_s, self.overall = limit, window_s, overall
        self._hits: dict[str, collections.deque[float]] = {}
        self._all: collections.deque[float] = collections.deque()
        self._lock = threading.Lock()

    def _trim(self, d: collections.deque[float], now: float) -> None:
        while d and d[0] <= now - self.window_s:
            d.popleft()

    def blocked(self, key: str, *, now: float | None = None) -> float:
        """Seconds until *key* may try again; 0 when it may now."""
        now = time.monotonic() if now is None else now
        with self._lock:
            d = self._hits.get(key)
            waits = [0.0]
            if d is not None:
                self._trim(d, now)
                if len(d) >= self.limit:
                    waits.append(d[0] + self.window_s - now)
            if self.overall is not None:
                self._trim(self._all, now)
                if len(self._all) >= self.overall:
                    waits.append(self._all[0] + self.window_s - now)
            return max(waits)

    def hit(self, key: str, *, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            if len(self._hits) > 10_000:  # a sweep of old keys, so the table cannot grow without end
                for k in [k for k, d in self._hits.items() if not d or d[-1] <= now - self.window_s]:
                    del self._hits[k]
            self._hits.setdefault(key, collections.deque()).append(now)
            self._all.append(now)

    def clear(self, key: str) -> None:
        with self._lock, contextlib.suppress(KeyError):
            del self._hits[key]


#: Failed sign-ins: 5 per address and 30 in all, per 15 minutes.
LOGIN_LIMITS = (5, 15 * 60, 30)
