"""The admin side: who may in, what the sign-in log keeps, the Contact
page's endpoint and its fences, and what an admin can do to an enquiry."""
from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from wikirace import __main__ as cli
from wikirace import logins
from wikirace.app import create_app
from wikirace.config import load_settings
from wikirace.logins import hash_password

PASSWORD = "a long test password"
HASH = hash_password(PASSWORD, n=2**10)
EMAIL = "admin@example.com"


def _settings(tmp_path, **extra):
    env = {"WIKIRACE_DB": str(tmp_path / "w.db"), "WIKIRACE_ADMIN_EMAIL": EMAIL,
           "WIKIRACE_ADMIN_PASSWORD_HASH": HASH, **extra}
    return load_settings({k: v for k, v in env.items() if v is not None}, read_file=False)


@pytest.fixture
def env(tmp_path):
    settings = _settings(tmp_path)
    app = create_app(settings, providers={})
    with TestClient(app, base_url="http://localhost") as c:
        yield c, app, settings


def signin(c, password=PASSWORD, email=EMAIL, **headers):
    return c.post("/api/admin/login", json={"email": email, "password": password}, headers=headers)


def db_rows(settings, sql, *args):
    with sqlite3.connect(settings.db_path) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(sql, args)]


def admin_routes(app):
    """Every admin endpoint, as (method, a URL for it): all but signing in and
    out. Read from the app's own description, so a new one cannot be missed."""
    out = []
    for path, ops in app.openapi()["paths"].items():
        if path.startswith("/api/admin/") and path not in ("/api/admin/login", "/api/admin/logout"):
            out += [(m.upper(), re.sub(r"\{[^}]+\}", "1", path)) for m in ops]
    return out


# ── Who may in ───────────────────────────────────────────────────────────────


def test_every_admin_endpoint_refuses_anyone_not_signed_in(env):
    c, app, settings = env
    routes = admin_routes(app)
    assert len(routes) >= 9
    for method, url in routes:
        assert c.request(method, url, json={"handled": True}).status_code == 401, (method, url)
        c.cookies.set(logins.COOKIE, "made-up", path=logins.COOKIE_PATH)
        assert c.request(method, url, json={"handled": True}).status_code == 401, (method, url)
        c.cookies.clear()


def test_signed_in_the_same_endpoints_answer(env):
    c, app, settings = env
    assert signin(c).status_code == 200
    for method, url in admin_routes(app):
        if method == "GET":
            assert c.get(url).status_code == 200, url
            assert c.get(url).headers["cache-control"] == "no-store", url


def test_with_no_admin_set_nobody_gets_in(tmp_path):
    settings = _settings(tmp_path, WIKIRACE_ADMIN_EMAIL=None, WIKIRACE_ADMIN_PASSWORD_HASH=None)
    assert settings.admin_email is None
    with TestClient(create_app(settings, providers={}), base_url="http://localhost") as c:
        r = signin(c)
        assert r.status_code == 503 and "WIKIRACE_ADMIN_PASSWORD_HASH" in r.json()["detail"]
        assert c.get("/api/admin/me").status_code == 401


def test_a_bad_hash_or_a_half_set_admin_is_switched_off_with_a_warning(tmp_path):
    s = _settings(tmp_path, WIKIRACE_ADMIN_PASSWORD_HASH="hunter2")
    assert s.admin_email is None and any("hash-password" in w for w in s.warnings)
    s = _settings(tmp_path, WIKIRACE_ADMIN_PASSWORD_HASH=None)
    assert s.admin_email is None and any("WIKIRACE_ADMIN_PASSWORD_HASH is not set" in w for w in s.warnings)


def test_the_password_is_checked_and_the_cookie_is_locked_down(env):
    c, app, settings = env
    assert signin(c, "wrong").status_code == 401
    assert signin(c, email="someone@example.com").status_code == 401
    r = signin(c, email="  Admin@Example.com ", **{"x-forwarded-proto": "https"})
    assert r.status_code == 200 and r.json()["email"] == EMAIL
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Path=/api/admin" in cookie and "Secure" in cookie
    assert "Secure" not in signin(c).headers["set-cookie"]  # plain http on localhost


def test_a_session_ends_with_sign_out_expiry_or_a_new_password(tmp_path):
    settings = _settings(tmp_path)
    with TestClient(create_app(settings, providers={}), base_url="http://localhost") as c:
        signin(c)
        assert c.get("/api/admin/me").status_code == 200
        token = c.cookies.get(logins.COOKIE)
        assert c.post("/api/admin/logout").status_code == 200
        c.cookies.clear()
        c.cookies.set(logins.COOKIE, token, path=logins.COOKIE_PATH)
        assert c.get("/api/admin/me").status_code == 401

        c.cookies.clear()
        signin(c)
        token = c.cookies.get(logins.COOKIE)
    # Expired.
    assert logins.session(settings.db_path, token, EMAIL, HASH) is not None
    later = datetime.now(UTC) + timedelta(hours=logins.SESSION_HOURS, minutes=1)
    assert logins.session(settings.db_path, token, EMAIL, HASH, now=later) is None
    # A new password, or a new admin, ends it.
    assert logins.session(settings.db_path, token, EMAIL, hash_password("another password", n=2**10)) is None
    assert logins.session(settings.db_path, token, "other@example.com", HASH) is None


def test_failures_are_rate_limited_per_address_and_in_all(env):
    c, app, settings = env
    me, other = {"cf-connecting-ip": "203.0.113.9"}, {"cf-connecting-ip": "198.51.100.7"}
    for _ in range(5):
        assert signin(c, "wrong", **me).status_code == 401
    r = signin(c, **me)  # the right password, too late
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0
    assert signin(c, **other).status_code == 200
    # In all: 30 failures from 30 addresses close the door for everyone.
    for i in range(30):
        signin(c, "wrong", **{"cf-connecting-ip": f"192.0.2.{i}"})
    assert signin(c, **{"cf-connecting-ip": "192.0.2.200"}).status_code == 429


def test_a_post_from_another_site_is_refused(env):
    c, app, settings = env
    signin(c)
    evil = {"origin": "https://evil.example"}
    assert c.post("/api/admin/enquiries/1/handled", json={"handled": True}, headers=evil).status_code == 403
    assert c.post("/api/admin/login", json={"email": EMAIL, "password": PASSWORD}, headers=evil).status_code == 403


# ── The sign-in log ──────────────────────────────────────────────────────────


def test_the_sign_in_log_keeps_verified_and_typed_apart_and_never_a_secret(env):
    c, app, settings = env
    ua = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
          "cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "US", "cf-ipcity": "Oakland"}
    signin(c, "not-the-password-xyz", email="victim@example.org", **ua)
    signin(c, **ua)
    token = c.cookies.get(logins.COOKIE)
    c.post("/api/admin/logout", headers=ua)
    log = db_rows(settings, "SELECT * FROM signins ORDER BY id")
    assert [(r["event"], r["verified"], r["email"]) for r in log] == [
        ("sign_in_failed", 0, "victim@example.org"), ("signed_in", 1, EMAIL), ("signed_out", 1, EMAIL)]
    assert all(r["ip"] == "203.0.113.9" and r["country"] == "US" and r["city"] == "Oakland" for r in log)
    assert log[1]["browser"] == "Chrome" and log[1]["expires_at"] and log[1]["session"] == log[2]["session"]
    raw = b"".join(p.read_bytes() for p in Path(settings.db_path).parent.glob("w.db*"))
    for secret in (PASSWORD, "not-the-password-xyz", token):
        assert secret.encode() not in raw
    # The page reads them back, counted.
    signin(c)
    got = c.get("/api/admin/signins?verified=no").json()
    assert got["counts"]["unverified"] == 1 and [r["email"] for r in got["rows"]] == ["victim@example.org"]
    assert c.get("/api/admin/signins?verified=maybe").status_code == 400


def test_a_log_that_cannot_be_written_never_stops_a_sign_in(env):
    c, app, settings = env
    with sqlite3.connect(settings.db_path) as conn:
        conn.execute("DROP TABLE signins")
    assert signin(c).status_code == 200
    assert c.get("/api/admin/me").status_code == 200


def test_old_sign_in_rows_are_swept_out(tmp_path):
    db = str(tmp_path / "w.db")
    logins.init(db)
    logins.record(db, "signed_in", verified=True, email=EMAIL, who={"ip": "203.0.113.9"})
    later = datetime.now(UTC) + timedelta(days=366)
    assert logins.prune(db, 365, now=later) == 1


def test_hash_password_prints_a_line_for_env(monkeypatch, capsys):
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": "correct horse battery staple")
    with pytest.raises(SystemExit) as done:
        cli.main(["--hash-password"])
    assert done.value.code == 0
    line = capsys.readouterr().out.strip()
    assert line.startswith("WIKIRACE_ADMIN_PASSWORD_HASH=scrypt:") and "$" not in line
    assert logins.verify_password("correct horse battery staple", line.split("=", 1)[1])
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": "short")
    with pytest.raises(SystemExit) as done:
        cli.main(["--hash-password"])
    assert done.value.code == 1


# ── The Contact page's endpoint ──────────────────────────────────────────────

MSG = {"name": "Ada", "email": "ada@example.com", "message": "Hello! A cabinet idea."}


def test_a_message_is_kept_in_the_main_database(env):
    c, app, settings = env
    r = c.post("/api/contact", json=MSG, headers={"cf-connecting-ip": "203.0.113.9", "cf-ipcountry": "GB"})
    assert r.status_code == 202 and r.json() == {"ok": True}
    [e] = db_rows(settings, "SELECT * FROM enquiries")
    assert (e["name"], e["email"], e["message"], e["ip"], e["country"], e["status"]) == (
        "Ada", "ada@example.com", "Hello! A cabinet idea.", "203.0.113.9", "GB", "waiting")
    with sqlite3.connect(settings.traffic_db) as conn:
        assert not conn.execute("SELECT name FROM sqlite_master WHERE name = 'enquiries'").fetchone()


def test_traps_and_repeats_look_like_success_and_are_not_kept(env):
    c, app, settings = env
    assert c.post("/api/contact", json={**MSG, "cabinet_code": "x"}).status_code == 202
    assert c.post("/api/contact", json=MSG).status_code == 202
    assert c.post("/api/contact", json={**MSG, "message": "  Hello!   A cabinet idea.  "}).status_code == 202
    assert len(db_rows(settings, "SELECT * FROM enquiries")) == 1


def test_what_the_contact_endpoint_refuses(env):
    c, app, settings = env
    assert c.post("/api/contact", json={**MSG, "email": "not an email"}).status_code == 422
    assert c.post("/api/contact", json={**MSG, "message": "   "}).status_code == 422
    assert c.post("/api/contact", json={**MSG, "message": "x" * 5001}).status_code == 422
    assert c.post("/api/contact", json={**MSG, "name": "x" * 201}).status_code == 422
    assert c.post("/api/contact", content=b"{" + b" " * 20_000 + b"}").status_code == 413
    assert c.post("/api/contact", content=b"not json").status_code == 422
    assert not db_rows(settings, "SELECT * FROM enquiries")


def test_the_contact_endpoint_is_rate_limited(env):
    c, app, settings = env
    ip = {"cf-connecting-ip": "203.0.113.9"}
    for i in range(5):
        assert c.post("/api/contact", json={**MSG, "message": f"message {i}"}, headers=ip).status_code == 202
    assert c.post("/api/contact", json={**MSG, "message": "one more"}, headers=ip).status_code == 429
    assert c.post("/api/contact", json=MSG, headers={"cf-connecting-ip": "198.51.100.7"}).status_code == 202


# ── Enquiries, as the admin sees them ────────────────────────────────────────


def test_enquiries_are_listed_newest_first_handled_and_deleted_with_an_audit(env):
    c, app, settings = env
    for i in range(3):
        c.post("/api/contact", json={**MSG, "message": f"message {i}"})
    signin(c)
    waiting = c.get("/api/admin/enquiries").json()
    assert [e["message"] for e in waiting["rows"]] == ["message 2", "message 1", "message 0"]
    assert waiting["counts"] == {"all": 3, "waiting": 3, "handled": 0}
    first = waiting["rows"][-1]["id"]

    assert c.post(f"/api/admin/enquiries/{first}/handled", json={"handled": True}).status_code == 200
    got = c.get("/api/admin/enquiries?status=handled").json()
    assert [e["id"] for e in got["rows"]] == [first] and got["rows"][0]["handled_by"] == EMAIL
    assert c.get("/api/admin/enquiries?status=waiting").json()["counts"] == {"all": 3, "waiting": 2, "handled": 1}
    assert c.post(f"/api/admin/enquiries/{first}/handled", json={"handled": False}).status_code == 200

    assert c.delete(f"/api/admin/enquiries/{first}").status_code == 200
    assert c.delete(f"/api/admin/enquiries/{first}").status_code == 404
    assert c.post("/api/admin/enquiries/999/handled", json={"handled": True}).status_code == 404
    assert c.get("/api/admin/enquiries?status=all").json()["total"] == 2
    assert c.get("/api/admin/enquiries?status=spam").status_code == 400

    audit = c.get("/api/admin/audit").json()["rows"]
    assert [a["action"] for a in audit] == ["enquiry_deleted", "enquiry_reopened", "enquiry_handled"]
    assert all(a["email"] == EMAIL and a["subject"] == f"enquiry {first}" for a in audit)
    # A deleted enquiry leaves no address behind in the audit.
    assert "ada@example.com" not in str(audit)


def test_the_report_refuses_what_it_does_not_know(env):
    c, app, settings = env
    signin(c)
    for q in ("period=1y", "who=aliens", "kind=nope", "status=abc", "per=1000"):
        assert c.get(f"/api/admin/traffic/requests?{q}").status_code in (400, 422), q
    assert c.get("/api/admin/traffic?period=24h&who=bots").status_code == 200


# ── The admin page ───────────────────────────────────────────────────────────


def test_the_admin_page_is_served_unindexed_and_linked_from_nowhere(env):
    c, app, settings = env
    r = c.get("/admin")
    assert r.status_code == 200 and "admin/admin.js" in r.text
    assert r.headers["x-robots-tag"] == "noindex, nofollow" and r.headers["cache-control"] == "no-store"
    assert re.search(r'src="\./v/[0-9a-f]{12}/admin/admin\.js"', r.text)
    for public in ("/", "/?tab=contact", "/sitemap.xml", "/robots.txt"):
        assert "admin" not in c.get(public).text.lower(), public
