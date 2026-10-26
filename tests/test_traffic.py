"""The traffic log: what a request leaves behind, what it never does, and
the report's arithmetic over rows whose answers are known."""
from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from wikirace import traffic
from wikirace.admin import csv_cell
from wikirace.app import create_app
from wikirace.config import load_settings
from wikirace.logins import hash_password
from wikirace.store import connect

CHROME = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/141.0.0.0 Safari/537.36")
IPHONE = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
          "Version/18.5 Mobile/15E148 Safari/604.1")
PASSWORD = "a long test password"
HASH = hash_password(PASSWORD, n=2**10)


@pytest.fixture
def app_env(tmp_path):
    settings = load_settings({
        "WIKIRACE_DB": str(tmp_path / "w.db"), "WIKIRACE_ADMIN_EMAIL": "admin@example.com",
        "WIKIRACE_ADMIN_PASSWORD_HASH": HASH, "WIKIRACE_ALLOWED_HOSTS": "jev-arcade.com",
    }, read_file=False)
    app = create_app(settings, providers={})
    with TestClient(app, base_url="http://localhost") as c:
        yield c, app, settings


def rows(app, settings) -> list[dict]:
    app.state.traffic.flush()
    with connect(settings.traffic_db) as conn:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute("SELECT * FROM requests ORDER BY id")]


# ── The pieces ───────────────────────────────────────────────────────────────


def test_the_client_address_is_the_edges_never_the_clients_own_claim():
    assert traffic.client_ip({"cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1"}, "10.0.0.2") == "203.0.113.9"
    # The leftmost entry is whatever the client wrote; the rightmost, the proxy's.
    assert traffic.client_ip({"x-forwarded-for": "6.6.6.6, 198.51.100.7"}, "10.0.0.2") == "198.51.100.7"
    assert traffic.client_ip({"x-forwarded-for": "2001:db8::1"}, "10.0.0.2") == "2001:db8::1"
    # Junk in a header is not an address.
    assert traffic.client_ip({"cf-connecting-ip": "<script>", "x-forwarded-for": "evil"}, "10.0.0.2") == "10.0.0.2"


def test_credentials_lose_their_values_and_nothing_else_changes():
    q = "tab=race&token=abc&apiKey=k1&oobCode=reset1&mode=resetPassword&password=hunter2&access_token=t&api%5Fkey=x&a=1&flag"
    out = traffic.redact_query(q)
    assert out == ("tab=race&token=REDACTED&apiKey=REDACTED&oobCode=REDACTED&mode=resetPassword&password=REDACTED"
                   "&access_token=REDACTED&api%5Fkey=REDACTED&a=1&flag")
    for secret in ("abc", "k1", "reset1", "hunter2"):
        assert secret not in out
    url = traffic.redact_url("https://user:pw@mail.example/reset?oobCode=123&lang=en#frag")
    assert url == "https://mail.example/reset?oobCode=REDACTED&lang=en"


@pytest.mark.parametrize(("ua", "browser", "os_", "device", "bot"), [
    (CHROME, "Chrome", "Windows", "desktop", False),
    (IPHONE, "Safari", "iOS", "mobile", False),
    ("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1",
     "Safari", "iPadOS", "tablet", False),
    ("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
     "Chrome", "Android", "mobile", False),
    ("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
     "Chrome", "Android", "tablet", False),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0",
     "Edge", "Windows", "desktop", False),
    ("Mozilla/5.0 (Macintosh; Intel Mac OS X 15.5; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox", "macOS", "desktop", False),
    ("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "", "", "bot", True),
    ("curl/8.9.1", "", "", "bot", True),
    ("", "", "", "bot", True),
])
def test_the_user_agent_is_read_into_browser_system_device_and_bot(ua, browser, os_, device, bot):
    a = traffic.parse_agent(ua)
    assert (a.browser, a.os, a.device, a.is_bot) == (browser, os_, device, bot)


def test_an_app_that_names_its_maker_is_a_person_but_its_crawler_is_a_bot():
    person = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/2.31226.1 "
              "Chrome/152.0.7977.130 Safari/537.36")
    assert not traffic.parse_agent(person).is_bot and traffic.parse_agent(person).browser == "Chrome"
    for crawler in ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
                    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0)",
                    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
                    "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
                    "TelegramBot (like TwitterBot)"):
        assert traffic.parse_agent(crawler).is_bot, crawler


def test_a_bot_is_named():
    assert traffic.parse_agent("Mozilla/5.0 (compatible; Googlebot/2.1)").bot_name == "Googlebot"
    assert traffic.parse_agent("curl/8.9.1").bot_name == "curl"
    assert traffic.parse_agent("").bot_name == "(no user agent)"


def test_a_spreadsheet_cell_never_starts_a_formula():
    assert csv_cell("=HYPERLINK(\"x\")") == "'=HYPERLINK(\"x\")"
    assert [csv_cell(v) for v in ("+1", "-1", "@SUM(A1)", "\tx")] == ["'+1", "'-1", "'@SUM(A1)", "'\tx"]
    assert csv_cell("/plain") == "/plain" and csv_cell(-3) == -3 and csv_cell(None) == ""


# ── What a request leaves behind ─────────────────────────────────────────────


def test_a_page_load_is_logged_with_everything_the_edge_and_browser_said(app_env):
    c, app, settings = app_env
    c.get("/?tab=race&token=s3cret", headers={
        "user-agent": CHROME, "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6, 203.0.113.9",
        "cf-ipcountry": "US", "cf-ray": "8c1f2d3e4a5b6c7d-SJC", "cf-ipcity": "Oakland", "cf-region": "California",
        "cf-region-code": "CA", "cf-postal-code": "94612", "cf-iplatitude": "37.80", "cf-iplongitude": "-122.27",
        "cf-timezone": "America/Los_Angeles", "cf-ipcontinent": "NA", "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="141"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
        "referer": "https://news.example/item?id=1&session=abc",
        "authorization": "Bearer never-store-me", "cookie": "theme=dark; sid=never-store-me-either",
    })
    [r] = [r for r in rows(app, settings) if r["kind"] == "page"]
    assert (r["method"], r["path"], r["query"], r["status"]) == ("GET", "/", "tab=race&token=REDACTED", 200)
    assert r["ip"] == "203.0.113.9" and r["peer"] == "testclient" and r["host"] == "localhost"
    assert (r["country"], r["colo"], r["city"], r["region_code"], r["postal_code"]) == ("US", "SJC", "Oakland", "CA", "94612")
    assert (r["latitude"], r["longitude"], r["geo_timezone"], r["continent"]) == (37.8, -122.27, "America/Los_Angeles", "NA")
    assert (r["browser"], r["os"], r["device"], r["is_bot"]) == ("Chrome", "Windows", "desktop", 0)
    assert r["referrer"] == "https://news.example/item?id=1&session=REDACTED" and r["ref_host"] == "news.example"
    assert r["language"].startswith("en-US") and r["ch_platform"] == '"Windows"' and r["fetch_dest"] == "document"
    assert r["bytes"] > 1000 and r["duration_ms"] >= 0 and r["protocol"] == "HTTP/1.1"
    assert r["ts"].endswith("Z")
    # No secret reaches the file, in any column.
    raw = open(settings.traffic_db, "rb").read() + (open(settings.traffic_db + "-wal", "rb").read()
                                                     if __import__("os").path.exists(settings.traffic_db + "-wal") else b"")
    for secret in (b"never-store-me", b"s3cret", b"sid=", b"Bearer"):
        assert secret not in raw


def test_every_answer_is_logged_redirects_refusals_and_errors_too(tmp_path):
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "w.db"), "WIKIRACE_CANONICAL_HOST": "jev-arcade.com"},
                             read_file=False)
    app = create_app(settings, providers={})
    with TestClient(app, base_url="http://localhost") as c:
        assert c.get("/x", headers={"host": "www.jev-arcade.com"}, follow_redirects=False).status_code == 301
        assert c.get("/", headers={"host": "evil.example"}).status_code == 400
        assert c.get("/wp-login.php").status_code == 404
        got = {(r["host"], r["path"], r["status"], r["kind"]) for r in rows(app, settings)}
    assert ("www.jev-arcade.com", "/x", 301, "other") in got
    assert ("evil.example", "/", 400, "page") in got
    assert ("localhost", "/wp-login.php", 404, "other") in got


def test_the_containers_healthcheck_is_left_out_but_a_visitors_is_not(tmp_path):
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "w.db")}, read_file=False)
    app = create_app(settings, providers={})
    # The Dockerfile's HEALTHCHECK asks 127.0.0.1 from inside the container.
    with TestClient(app, base_url="http://localhost", client=("127.0.0.1", 50000)) as c:
        c.get("/api/health")
        c.get("/api/health", headers={"x-forwarded-for": "198.51.100.7"})
        logged = rows(app, settings)
    assert [(r["path"], r["ip"]) for r in logged] == [("/api/health", "198.51.100.7")]


def test_the_beacon_adds_to_its_own_row_and_is_bounded(app_env):
    c, app, settings = app_env
    beacon = {"sw": 1920, "sh": 1080, "vw": 1280, "vh": 720, "dpr": 1.25, "tz": "Europe/Berlin", "load_ms": 812,
              "view": "?tab=race&token=x"}
    # sendBeacon posts a string: text/plain, not JSON.
    assert c.post("/api/beacon", content=json.dumps(beacon), headers={"content-type": "text/plain"}).status_code == 204
    assert c.post("/api/beacon", json={**beacon, "tz": "<b>x</b>"}).status_code == 204
    assert c.post("/api/beacon", json={"sw": 10**9}).status_code == 422
    assert c.post("/api/beacon", content="x" * 5000).status_code == 413
    b = [r for r in rows(app, settings) if r["kind"] == "beacon"]
    assert (b[0]["screen"], b[0]["viewport"], b[0]["pixel_ratio"], b[0]["timezone"], b[0]["load_ms"]) == (
        "1920x1080", "1280x720", 1.25, "Europe/Berlin", 812)
    assert b[0]["view"] == "tab=race&token=REDACTED"
    assert b[1]["timezone"] == ""


def test_a_request_keeps_its_scheme_size_answer_type_id_and_privacy_signals(app_env):
    c, app, settings = app_env
    c.get("/", headers={"user-agent": CHROME, "x-forwarded-proto": "HTTPS, http", "dnt": "1", "sec-gpc": "1"})
    c.get("/api/health", headers={"user-agent": CHROME})
    body = json.dumps({"email": "not an address", "message": "hi"}).encode()
    assert c.post("/api/contact", content=body, headers={"content-type": "application/json"}).status_code == 422
    c.get("/api/health", headers={"content-length": "-5", "dnt": "x" * 50})
    page, health, contact, odd = rows(app, settings)
    assert (page["scheme"], page["dnt"], page["gpc"], page["request_bytes"]) == ("https", "1", "1", 0)
    assert page["content_type"] == "text/html; charset=utf-8"
    # Without the edge's header, the connection's own scheme.
    assert (health["scheme"], health["dnt"], health["gpc"], health["content_type"]) == ("http", "", "", "application/json")
    assert (contact["request_bytes"], contact["status"], contact["content_type"]) == (len(body), 422, "application/json")
    # A Content-Length that is no number is 0; a header is bounded.
    assert odd["request_bytes"] == 0 and odd["dnt"] == "xxxx"
    ids = [r["request_id"] for r in (page, health, contact, odd)]
    assert all(re.fullmatch(r"[0-9a-f]{32}", i) for i in ids) and len(set(ids)) == 4
    # What only a beacon says is empty on every other row.
    assert all((r["color_scheme"], r["connection"], r["touch"]) == ("", "", "") for r in (page, health, contact, odd))


def test_the_beacon_keeps_colour_scheme_connection_and_touch(app_env):
    c, app, settings = app_env
    good = {"sw": 390, "sh": 844, "tz": "Europe/Berlin", "cs": "dark", "net": "4g", "touch": "1"}
    assert c.post("/api/beacon", content=json.dumps(good), headers={"content-type": "text/plain"}).status_code == 204
    assert c.post("/api/beacon", json={"cs": " Light ", "net": "slow-2g", "touch": "0"}).status_code == 204
    # Anything else is kept as nothing; too long is refused.
    assert c.post("/api/beacon", json={"cs": "<b>", "net": "4G; DROP", "touch": "yes"}).status_code == 204
    assert c.post("/api/beacon", json={"cs": "x" * 17}).status_code == 422
    b = [r for r in rows(app, settings) if r["kind"] == "beacon"]
    assert [(r["color_scheme"], r["connection"], r["touch"]) for r in b] == [
        ("dark", "4g", "1"), ("light", "slow-2g", "0"), ("", "", ""), ("", "", "")]
    assert b[0]["request_bytes"] == len(json.dumps(good)) and b[0]["screen"] == "390x844"


# ── An older log ─────────────────────────────────────────────────────────────


def _old_log(db: str, n: int = 3) -> list[tuple]:
    """A traffic.db as the first version left it, with *n* rows; those rows."""
    added = {name for name, _ in traffic._ADDED}
    old = [c for c in traffic.COLUMNS if c not in added]
    with connect(db) as conn:
        conn.executescript(traffic._DDL)
        assert not added & {r[1] for r in conn.execute("PRAGMA table_info(requests)")}
        conn.executemany(
            f"INSERT INTO requests ({', '.join(old)}) VALUES ({', '.join('?' * len(old))})",
            [tuple(_row(path=f"/old/{i}", ip=f"203.0.113.{i}", screen="1x1")[c] for c in old) for i in range(n)],
        )
        return conn.execute(f"SELECT id, {', '.join(old)} FROM requests ORDER BY id").fetchall()


def test_an_older_log_gains_the_new_columns_once_and_keeps_every_row(tmp_path):
    db = str(tmp_path / "t.db")
    before = _old_log(db)
    assert traffic.init(db) == [name for name, _ in traffic._ADDED]
    with connect(db) as conn:
        info = {r[1]: r for r in conn.execute("PRAGMA table_info(requests)")}
        old = [c for c in traffic.COLUMNS if c not in {n for n, _ in traffic._ADDED}]
        after = conn.execute(f"SELECT id, {', '.join(old)} FROM requests ORDER BY id").fetchall()
        new = conn.execute("SELECT scheme, request_id, request_bytes, content_type, dnt, gpc, color_scheme, "
                           "connection, touch FROM requests").fetchall()
    assert after == before
    assert new == [("", "", 0, "", "", "", "", "", "")] * 3
    # Every column the standard schema declares, as it declares it.
    for name, decl in traffic._ADDED:
        _, _, typ, notnull, default, _ = info[name]
        assert (typ, notnull) == (decl.split()[0], 1) and default in ("''", "0"), name
    assert list(info) == ["id", *traffic.COLUMNS]
    # A second start changes nothing; a new file is made whole at once.
    assert traffic.init(db) == []
    assert traffic.init(str(tmp_path / "new.db")) == []
    with connect(str(tmp_path / "new.db")) as conn:
        assert [r[1] for r in conn.execute("PRAGMA table_info(requests)")] == ["id", *traffic.COLUMNS]


def test_the_site_starts_on_an_older_log_and_the_admin_reads_it_whole(tmp_path):
    settings = load_settings({
        "WIKIRACE_DB": str(tmp_path / "w.db"), "WIKIRACE_ADMIN_EMAIL": "admin@example.com",
        "WIKIRACE_ADMIN_PASSWORD_HASH": HASH,
    }, read_file=False)
    _old_log(settings.traffic_db, n=2)
    app = create_app(settings, providers={})
    with TestClient(app, base_url="http://localhost") as c:
        c.get("/", headers={"user-agent": CHROME, "x-forwarded-proto": "https", "sec-gpc": "1",
                            "cf-connecting-ip": "198.51.100.7"})
        c.post("/api/beacon", json={"sw": 1, "sh": 1, "cs": "light", "touch": "0"})
        c.post("/api/admin/login", json={"email": "admin@example.com", "password": PASSWORD})
        listing = c.get("/api/admin/traffic/requests?period=all&who=all&per=200").json()
        table = list(csv.reader(io.StringIO(c.get("/api/admin/traffic/requests.csv?period=all&who=all").text)))
        report = c.get("/api/admin/traffic?period=all&who=all")
    assert report.status_code == 200
    assert app.state.traffic.problem is None
    by_path = {r["path"]: r for r in listing["rows"]}
    assert {"/old/0", "/old/1", "/", "/api/beacon"} <= set(by_path)
    assert by_path["/old/0"]["scheme"] == "" and by_path["/old/0"]["ip"] == "203.0.113.0"
    assert (by_path["/"]["scheme"], by_path["/"]["gpc"], by_path["/"]["ip"]) == ("https", "1", "198.51.100.7")
    assert (by_path["/api/beacon"]["color_scheme"], by_path["/api/beacon"]["touch"]) == ("light", "0")
    assert table[0] == ["id", *traffic.COLUMNS]
    assert table[0][-9:] == ["scheme", "request_id", "request_bytes", "content_type", "dnt", "gpc",
                             "color_scheme", "connection", "touch"]
    cols = {name: table[0].index(name) for name in ("path", "scheme", "request_id")}
    csv_rows = {row[cols["path"]]: row for row in table[1:]}
    assert csv_rows["/"][cols["scheme"]] == "https" and len(csv_rows["/"][cols["request_id"]]) == 32
    assert csv_rows["/old/1"][cols["scheme"]] == ""


def test_a_log_that_cannot_be_opened_never_stops_the_site(tmp_path):
    # A file where the log's folder should be: it can never be created.
    (tmp_path / "blocked").write_text("not a folder")
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "w.db"),
                              "WIKIRACE_TRAFFIC_DB": str(tmp_path / "blocked" / "traffic.db")}, read_file=False)
    app = create_app(settings, providers={})
    with TestClient(app, base_url="http://localhost") as c:
        assert c.get("/").status_code == 200 and c.get("/api/health").status_code == 200
        assert c.post("/api/beacon", json={"sw": 1}).status_code == 204
        assert not app.state.traffic.running and "traffic.db" in app.state.traffic.problem


def test_rows_survive_a_restart_once_each(tmp_path):
    db = str(tmp_path / "t.db")
    for run in range(2):
        log = traffic.Traffic(db, 365)
        log.start()
        for i in range(250):
            log.put(_row(path=f"/r{run}/{i}"))
        log.stop()
    with connect(db) as conn:
        paths = [r[0] for r in conn.execute("SELECT path FROM requests")]
    assert len(paths) == 500 and len(set(paths)) == 500


def test_a_full_queue_drops_rows_rather_than_holding_a_request(tmp_path, monkeypatch):
    monkeypatch.setattr(traffic, "_QUEUE_MAX", 3)
    log = traffic.Traffic(str(tmp_path / "t.db"), 365)
    log._thread = object()  # started, but writing nothing
    log._q.maxsize = 3
    for _ in range(5):
        log.put(_row())
    assert log.dropped == 2


def test_old_rows_are_swept_out(tmp_path):
    db = str(tmp_path / "t.db")
    traffic.init(db)
    now = datetime(2026, 10, 13, 12, tzinfo=UTC)
    with connect(db) as conn:
        traffic.insert(conn, [_row(ts=now - timedelta(days=d), path=f"/{d}") for d in (1, 364, 366, 400)])
    assert traffic.prune(db, 365, now=now) == 2
    with connect(db) as conn:
        assert sorted(r[0] for r in conn.execute("SELECT path FROM requests")) == ["/1", "/364"]


def test_one_address_can_be_forgotten(tmp_path):
    db = str(tmp_path / "t.db")
    traffic.init(db)
    with connect(db) as conn:
        traffic.insert(conn, [_row(ip="203.0.113.9"), _row(ip="203.0.113.9"), _row(ip="198.51.100.7")])
    assert traffic.forget(db, "203.0.113.9") == 2


# ── The report's arithmetic ──────────────────────────────────────────────────

NOW = datetime(2026, 10, 13, 12, 30, tzinfo=UTC)


def _row(**kw) -> dict:
    ts = kw.pop("ts", NOW - timedelta(minutes=5))
    base = {c: "" for c in traffic.COLUMNS}
    base.update({
        "ts": traffic.iso(ts), "kind": "page", "method": "GET", "host": "jev-arcade.com", "path": "/",
        "protocol": "HTTP/1.1", "status": 200, "bytes": 1000, "duration_ms": 10.0, "ip": "203.0.113.1",
        "is_bot": 0, "latitude": None, "longitude": None, "pixel_ratio": None, "load_ms": None,
        "browser": "Chrome", "os": "Windows", "device": "desktop", "country": "US", "request_bytes": 0,
    })
    base.update(kw)
    return base


@pytest.fixture
def seeded(tmp_path):
    db = str(tmp_path / "t.db")
    traffic.init(db)
    h = timedelta(hours=1)
    seed = [
        # Two people load pages: A twice (an hour apart), B once, from a referrer.
        _row(ip="203.0.113.1", ts=NOW - 3 * h, duration_ms=5),
        _row(ip="203.0.113.1", ts=NOW - 2 * h, query="tab=race", duration_ms=7),
        _row(ip="203.0.113.2", ts=NOW - 2 * h, referrer="https://news.example/a", ref_host="news.example",
             country="DE", browser="Firefox", device="mobile", duration_ms=9),
        # Their API calls and files: requests, not page views.
        _row(ip="203.0.113.1", kind="api", path="/api/models", duration_ms=50),
        _row(ip="203.0.113.2", kind="asset", path="/v/abc/main.js", bytes=5000, duration_ms=2),
        # A redirect to the page is not a page view; a link from the site itself is no referrer.
        _row(ip="203.0.113.2", status=301, ref_host="jev-arcade.com"),
        # A 404 and a 500.
        _row(ip="203.0.113.3", kind="other", path="/wp-login.php", status=404, duration_ms=1),
        _row(ip="203.0.113.3", kind="api", path="/api/races", status=500, duration_ms=100),
        # A bot loads the page and probes.
        _row(ip="66.249.66.1", is_bot=1, bot_name="Googlebot", browser="", os="", device="bot", duration_ms=3),
        _row(ip="66.249.66.1", is_bot=1, bot_name="Googlebot", kind="other", path="/.env", status=404, duration_ms=1),
        # A beacon: counted nowhere but the browser-side numbers.
        _row(ip="203.0.113.1", kind="beacon", method="POST", path="/api/beacon", status=204, screen="390x844",
             timezone="Europe/Berlin", load_ms=640, duration_ms=1),
        # Outside the 24 hours.
        _row(ip="198.51.100.9", ts=NOW - timedelta(days=3)),
    ]
    with connect(db) as conn:
        traffic.insert(conn, seed)
    return db


def test_the_totals_count_what_they_say(seeded):
    people = traffic.report(seeded, traffic.Filter(period="24h", who="people"), now=NOW)
    t = people["totals"]
    # 8 people's requests in the day, the beacon left out.
    assert t["requests"] == 8
    assert t["page_views"] == 3 and t["visitors"] == 2
    assert t["addresses"] == 3 and t["client_errors"] == 1 and t["server_errors"] == 1 and t["bot_requests"] == 0
    assert t["bytes"] == 1000 * 7 + 5000
    # Median of 1, 2, 5, 7, 9, 10, 50, 100: the upper middle.
    assert t["median_ms"] == 9

    everyone = traffic.report(seeded, traffic.Filter(period="24h", who="all"), now=NOW)["totals"]
    assert everyone["requests"] == 10 and everyone["page_views"] == 4 and everyone["bot_requests"] == 2
    bots = traffic.report(seeded, traffic.Filter(period="24h", who="bots"), now=NOW)["totals"]
    assert bots["requests"] == 2 and bots["page_views"] == 1 and bots["visitors"] == 1
    week = traffic.report(seeded, traffic.Filter(period="7d", who="people"), now=NOW)["totals"]
    assert week["page_views"] == 4 and week["visitors"] == 3


def test_the_series_adds_up_to_the_totals_with_every_hour_present(seeded):
    rep = traffic.report(seeded, traffic.Filter(period="24h", who="people"), now=NOW)
    assert rep["hourly"] and len(rep["series"]) == 25
    assert sum(b["page_views"] for b in rep["series"]) == rep["totals"]["page_views"]
    assert sum(b["requests"] for b in rep["series"]) == rep["totals"]["requests"]
    by = {b["t"]: b for b in rep["series"]}
    assert by["2026-10-13T10"]["page_views"] == 2 and by["2026-10-13T10"]["visitors"] == 2
    assert by["2026-10-13T03"]["requests"] == 0
    daily = traffic.report(seeded, traffic.Filter(period="7d", who="people"), now=NOW)
    assert not daily["hourly"] and len(daily["series"]) == 8
    assert {b["t"]: b["page_views"] for b in daily["series"]}["2026-10-10"] == 1


def test_the_top_lists(seeded):
    rep = traffic.report(seeded, traffic.Filter(period="24h", who="people"), now=NOW)
    assert rep["pages"] == [{"label": "/", "n": 2, "visitors": 2}, {"label": "/?tab=race", "n": 1, "visitors": 1}]
    assert rep["referrers"] == [{"label": "news.example", "n": 1, "visitors": 1}]
    assert [c["label"] for c in rep["countries"]] == ["US", "DE"]
    assert [b["label"] for b in rep["browsers"]] == ["Chrome", "Firefox"]
    assert {d["label"]: d["n"] for d in rep["devices"]} == {"desktop": 2, "mobile": 1}
    assert rep["not_found"] == [{"label": "/wp-login.php", "n": 1, "visitors": 1}]
    assert rep["bots"] == []
    # Three requests each (the beacon is not one), tied, so by address.
    assert [(a["ip"], a["n"], a["page_views"]) for a in rep["addresses"]] == [
        ("203.0.113.1", 3, 2), ("203.0.113.2", 3, 1), ("203.0.113.3", 2, 0)]
    bs = rep["browser_side"]
    assert bs["beacons"] == 1 and bs["median_load_ms"] == 640 and bs["screens"][0]["label"] == "390x844"
    bots = traffic.report(seeded, traffic.Filter(period="24h", who="bots"), now=NOW)
    assert bots["bots"] == [{"label": "Googlebot", "n": 2, "visitors": 1}]
    assert bots["not_found"] == [{"label": "/.env", "n": 1, "visitors": 1}]


def test_the_request_log_filters_and_pages(seeded):
    f = traffic.Filter(period="24h", who="all")
    first = traffic.requests(seeded, f, page=1, per=4, now=NOW)
    assert first["total"] == 11 and len(first["rows"]) == 4
    rest = traffic.requests(seeded, f, page=3, per=4, now=NOW)
    assert len(rest["rows"]) == 3
    ids = [r["id"] for p in (1, 2, 3) for r in traffic.requests(seeded, f, page=p, per=4, now=NOW)["rows"]]
    assert len(set(ids)) == 11
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", status="4xx"), now=NOW)["total"] == 2
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", status="500"), now=NOW)["total"] == 1
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", ip="66.249.66.1"), now=NOW)["total"] == 2
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", q="wp-login"), now=NOW)["total"] == 1
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", kind="beacon"), now=NOW)["total"] == 1
    assert traffic.requests(seeded, traffic.Filter(period="24h", who="all", country="de"), now=NOW)["total"] == 1


def test_the_csv_is_every_matching_row_and_runs_no_formula(app_env):
    c, app, settings = app_env
    c.get("/", headers={"user-agent": "=HYPERLINK(\"http://evil.example\")"})
    c.post("/api/admin/login", json={"email": "admin@example.com", "password": PASSWORD})
    r = c.get("/api/admin/traffic/requests.csv?period=24h&who=all")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"] and r.headers["cache-control"] == "no-store"
    table = list(csv.reader(io.StringIO(r.text)))
    assert table[0][:3] == ["id", "ts", "kind"]
    ua = table[0].index("user_agent")
    assert any(row[ua] == "'=HYPERLINK(\"http://evil.example\")" for row in table[1:])
