"""The traffic log: every request the site serves, one row each, in a SQLite
file of its own (docs/traffic.md).

One process serves everything here, the page and its files as well as /api,
so the log is a middleware (`TrafficLog`) around the whole app: whatever the
server answers, a redirect or a refused host included, is written down. What
Cloudflare answers from its own cache never reaches the server and is not.

The rows go to `traffic.db`, beside the history but never in it: the log is
large and disposable, the history small and worth a backup, and a burst of
log writes must not hold the history's lock. The middleware only queues a
row; a writer thread inserts them in batches, so a request never waits on the
log, and a log that cannot be written never fails a request.

What is kept, and what is not:

- The client's address as the edge saw it: Cloudflare's `CF-Connecting-IP`
  (which Cloudflare overwrites), else the rightmost `X-Forwarded-For` entry
  (the leftmost is whatever the client wrote), else the socket's peer.
- Cloudflare's own fields when it sends them: country, data centre, ray ID,
  and city, region, postcode, coordinates and time zone when its "visitor
  location headers" transform is on.
- Browser, OS, device and bot-or-not, read from the user agent as the row is
  written, with the user agent itself beside them.
- Never `Authorization` or `Cookie`, and no secret in a query string or a
  referrer: a parameter whose name says it is a credential (`token`, `key`,
  `code`, `password`…) keeps its name and loses its value.
- Not the container's own healthcheck, which would be thousands of fake visits a day.

The page's beacon (`POST /api/beacon`) adds what only the browser knows to its
own row: screen and window size, time zone, load time. A beacon row describes
a page view already counted, so every total leaves beacon rows out.

Rows older than WIKIRACE_LOG_RETENTION_DAYS (365 by default) are deleted, at
start-up and every few hours after: the log holds IP addresses.
"""
from __future__ import annotations

import contextlib
import ipaddress
import queue
import re
import threading
import time
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote_plus, urlsplit, urlunsplit

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .store import connect

#: The scope key an endpoint writes extra fields under (the beacon's).
EXTRA = "wikirace.traffic"
#: Rows waiting to be written. Past this the newest are dropped, and counted.
_QUEUE_MAX = 10_000
#: Rows per insert, and how long the writer waits for more before writing.
_BATCH = 500
_BATCH_WAIT_S = 1.0
_PRUNE_EVERY_S = 6 * 3600
REDACTED = "REDACTED"

_DDL = """
CREATE TABLE IF NOT EXISTS requests (
    id            INTEGER PRIMARY KEY,
    ts            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    method        TEXT NOT NULL,
    host          TEXT NOT NULL,
    path          TEXT NOT NULL,
    query         TEXT NOT NULL,
    protocol      TEXT NOT NULL,
    status        INTEGER NOT NULL,
    bytes         INTEGER NOT NULL,
    duration_ms   REAL NOT NULL,
    ip            TEXT NOT NULL,
    peer          TEXT NOT NULL,
    forwarded_for TEXT NOT NULL,
    country       TEXT NOT NULL,
    colo          TEXT NOT NULL,
    ray           TEXT NOT NULL,
    city          TEXT NOT NULL,
    region        TEXT NOT NULL,
    region_code   TEXT NOT NULL,
    postal_code   TEXT NOT NULL,
    latitude      REAL,
    longitude     REAL,
    geo_timezone  TEXT NOT NULL,
    continent     TEXT NOT NULL,
    referrer      TEXT NOT NULL,
    ref_host      TEXT NOT NULL,
    user_agent    TEXT NOT NULL,
    browser       TEXT NOT NULL,
    browser_version TEXT NOT NULL,
    os            TEXT NOT NULL,
    device        TEXT NOT NULL,
    is_bot        INTEGER NOT NULL,
    bot_name      TEXT NOT NULL,
    language      TEXT NOT NULL,
    ch_ua         TEXT NOT NULL,
    ch_mobile     TEXT NOT NULL,
    ch_platform   TEXT NOT NULL,
    fetch_site    TEXT NOT NULL,
    fetch_mode    TEXT NOT NULL,
    fetch_dest    TEXT NOT NULL,
    screen        TEXT NOT NULL DEFAULT '',
    viewport      TEXT NOT NULL DEFAULT '',
    pixel_ratio   REAL,
    timezone      TEXT NOT NULL DEFAULT '',
    load_ms       INTEGER,
    view          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS requests_ip ON requests (ip, ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""

COLUMNS: tuple[str, ...] = (
    "ts", "kind", "method", "host", "path", "query", "protocol", "status", "bytes", "duration_ms",
    "ip", "peer", "forwarded_for", "country", "colo", "ray", "city", "region", "region_code",
    "postal_code", "latitude", "longitude", "geo_timezone", "continent", "referrer", "ref_host",
    "user_agent", "browser", "browser_version", "os", "device", "is_bot", "bot_name", "language",
    "ch_ua", "ch_mobile", "ch_platform", "fetch_site", "fetch_mode", "fetch_dest",
    "screen", "viewport", "pixel_ratio", "timezone", "load_ms", "view",
)


def iso(dt: datetime) -> str:
    """One spelling of a time for every row, so times compare as text."""
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return iso(datetime.now(UTC))


def _clip(value: str | None, n: int) -> str:
    return (value or "")[:n]


# ── Secrets out ──────────────────────────────────────────────────────────────

#: A query parameter is a credential when its name is one of these…
_SECRET_NAMES = frozenset({
    "key", "code", "oobcode", "sig", "pwd", "pass", "sid", "state", "nonce", "ticket", "hash", "otp",
})
#: …or has one of these in it (`access_token`, `apiKey`, `x-amz-signature`).
_SECRET_PARTS = ("token", "secret", "passw", "apikey", "api_key", "auth", "session", "signature", "jwt",
                 "credential", "private")


def secret_name(name: str) -> bool:
    n = unquote_plus(name).strip().lower()
    return n in _SECRET_NAMES or any(p in n for p in _SECRET_PARTS)


def redact_query(query: str) -> str:
    """*query* with every credential's value replaced, the rest exactly as sent."""
    if not query:
        return ""
    out = []
    for pair in query.split("&"):
        name, eq, _ = pair.partition("=")
        out.append(f"{name}={REDACTED}" if eq and secret_name(name) else pair)
    return "&".join(out)


def redact_url(url: str) -> str:
    """A referrer as it may be kept: no user:password@, no credential in its
    query, no fragment."""
    if not url:
        return ""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "(an unreadable URL)"
    netloc = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, netloc, parts.path, redact_query(parts.query), ""))


def _host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


# ── Who is asking ────────────────────────────────────────────────────────────


def _ip(value: str) -> str:
    """*value* as an address, or "" when it is not one."""
    try:
        return str(ipaddress.ip_address(value.strip().strip("[]")))
    except ValueError:
        return ""


def client_ip(headers: Mapping[str, str], peer: str) -> str:
    """The visitor's address. Cloudflare overwrites CF-Connecting-IP, so it is
    believed first; then the rightmost X-Forwarded-For entry, the one the
    nearest proxy added (the leftmost is whatever the client wrote); then the
    socket's peer, which behind a tunnel is the tunnel."""
    cf = _ip(headers.get("cf-connecting-ip", ""))
    if cf:
        return cf
    hops = [h for h in headers.get("x-forwarded-for", "").split(",") if h.strip()]
    if hops:
        last = _ip(hops[-1])
        if last:
            return last
    return peer


@dataclass(frozen=True)
class Agent:
    browser: str
    browser_version: str
    os: str
    device: str
    is_bot: bool
    bot_name: str


#: Known crawlers, previewers, scripts and scanners, by a piece of their user
#: agent. Their names, not their makers': a desktop app a person browses in
#: names its maker (`Claude/2.3`, `Slack/4.4`) and is no bot.
_BOT = re.compile(
    r"bot\b|bot/|crawl|spider|slurp|archiver|scrape|fetcher|scanner|monitor|uptime|pingdom|statuscake|"
    r"headless|phantomjs|lighthouse|preview|facebookexternalhit|meta-externalagent|embedly|whatsapp/|"
    r"vkshare|curl/|wget/|python|httpx|aiohttp|go-http|java/|okhttp|libwww|"
    r"axios|node-fetch|undici|postman|insomnia|zgrab|masscan|nmap|nikto|sqlmap|nuclei|ahrefs|semrush|"
    r"mj12|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claude-user|claude-searchbot|"
    r"claude-web|anthropic-ai|perplexity-user|ccbot|amazonbot|applebot|yandex|baidu|duckduck|google-|"
    r"googleother|feedfetcher|cloudflare-|censys|expanse|internetmeasurement|leakix",
    re.I,
)
#: A bot's name: the product token that says bot/crawler/spider, else the first one.
_BOT_NAME = re.compile(r"([A-Za-z][\w.\-]*?(?:bot|crawler|spider|agent|fetcher)[\w.\-]*)", re.I)
_PRODUCT = re.compile(r"^([A-Za-z][\w.\-]*)")
_BROWSERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Edge", re.compile(r"Edg(?:e|A|iOS)?/(\d+)")),
    ("Opera", re.compile(r"(?:OPR|Opera)/(\d+)")),
    ("Samsung Internet", re.compile(r"SamsungBrowser/(\d+)")),
    ("Firefox", re.compile(r"(?:Firefox|FxiOS)/(\d+)")),
    ("Chrome", re.compile(r"(?:CriOS|Chrome|Chromium)/(\d+)")),
    ("Safari", re.compile(r"Version/(\d+)[\d.]* (?:Mobile/\S+ )?Safari/")),
)


def parse_agent(ua: str, mobile_hint: str = "") -> Agent:
    """Browser, OS and device from a user agent, and whether it is a bot. A
    reading for a report, not a fingerprint: the raw string is kept beside it."""
    if not ua.strip():
        return Agent("", "", "", "bot", True, "(no user agent)")
    if _BOT.search(ua) or not ua.startswith("Mozilla/"):
        m = _BOT_NAME.search(ua) or _PRODUCT.search(ua)
        name = m.group(1) if m else ua[:40]
        return Agent("", "", "", "bot", True, name[:60])
    browser, version = "Other", ""
    for label, pat in _BROWSERS:
        m = pat.search(ua)
        if m:
            browser, version = label, m.group(1)
            break
    if "Windows NT" in ua:
        os_ = "Windows"
    elif "iPhone" in ua or "iPod" in ua:
        os_ = "iOS"
    elif "iPad" in ua:
        os_ = "iPadOS"
    elif "Android" in ua:
        os_ = "Android"
    elif "CrOS" in ua:
        os_ = "ChromeOS"
    elif "Macintosh" in ua or "Mac OS X" in ua:
        os_ = "macOS"
    elif "Linux" in ua:
        os_ = "Linux"
    else:
        os_ = "Other"
    if "iPad" in ua or "Tablet" in ua or (os_ == "Android" and "Mobile" not in ua):
        device = "tablet"
    elif mobile_hint == "?1" or "Mobi" in ua or os_ in ("iOS", "Android"):
        device = "mobile"
    else:
        device = "desktop"
    return Agent(browser, version, os_, device, False, "")


def _float(value: str) -> float | None:
    try:
        f = float(value)
    except ValueError:
        return None
    return f if -1000 < f < 1000 else None


def visitor(headers: Mapping[str, str], peer: str) -> dict[str, Any]:
    """Who sent a request, as the sign-in log and the enquiries keep it."""
    ua = _clip(headers.get("user-agent"), 1000)
    agent = parse_agent(ua, headers.get("sec-ch-ua-mobile", ""))
    return {
        "ip": client_ip(headers, peer),
        "country": _clip(headers.get("cf-ipcountry"), 8),
        "city": _clip(headers.get("cf-ipcity"), 100),
        "user_agent": ua,
        "browser": agent.browser,
        "os": agent.os,
        "device": agent.device,
    }


def _kind(method: str, path: str) -> str:
    if path == "/api/beacon":
        return "beacon"
    if path == "/admin" or path.startswith("/api/admin/"):
        return "admin"
    if path.startswith("/api/"):
        return "api"
    if method in ("GET", "HEAD") and path in ("/", "/index.html"):
        return "page"
    if path.startswith("/v/") or re.search(r"\.(?:js|css|map|png|svg|ico|jpe?g|webp|gif|woff2?|txt|json)$", path):
        return "asset"
    return "other"


def build_row(scope: Scope, status: int, size: int, duration_ms: float, extra: Mapping[str, Any],
              started: datetime) -> dict[str, Any]:
    """The row for one request, every field bounded, no secret in it."""
    headers = Headers(scope=scope)
    peer = (scope.get("client") or ("", 0))[0] or ""
    ua = _clip(headers.get("user-agent"), 1000)
    agent = parse_agent(ua, headers.get("sec-ch-ua-mobile", ""))
    method, path = scope.get("method", ""), _clip(scope.get("path"), 2000)
    referrer = _clip(redact_url(headers.get("referer", "")), 2000)
    ray = _clip(headers.get("cf-ray"), 40)
    row: dict[str, Any] = {
        "ts": iso(started),
        "kind": _kind(method, path),
        "method": _clip(method, 16),
        "host": _clip(headers.get("host"), 255),
        "path": path,
        "query": _clip(redact_query((scope.get("query_string") or b"").decode("latin-1")), 2000),
        "protocol": f"HTTP/{scope.get('http_version', '1.1')}",
        "status": status,
        "bytes": size,
        "duration_ms": round(duration_ms, 1),
        "ip": client_ip(headers, peer),
        "peer": peer,
        "forwarded_for": _clip(headers.get("x-forwarded-for"), 300),
        "country": _clip(headers.get("cf-ipcountry"), 8),
        # A ray ID ends in the data centre that answered: 8c1f2d3e4a5b6c7d-SJC.
        "colo": ray.rpartition("-")[2] if "-" in ray else "",
        "ray": ray,
        "city": _clip(headers.get("cf-ipcity"), 100),
        "region": _clip(headers.get("cf-region"), 100),
        "region_code": _clip(headers.get("cf-region-code"), 16),
        "postal_code": _clip(headers.get("cf-postal-code"), 16),
        "latitude": _float(headers.get("cf-iplatitude", "")),
        "longitude": _float(headers.get("cf-iplongitude", "")),
        "geo_timezone": _clip(headers.get("cf-timezone"), 64),
        "continent": _clip(headers.get("cf-ipcontinent"), 8),
        "referrer": referrer,
        "ref_host": _host_of(referrer),
        "user_agent": ua,
        "browser": agent.browser,
        "browser_version": agent.browser_version,
        "os": agent.os,
        "device": agent.device,
        "is_bot": int(agent.is_bot),
        "bot_name": agent.bot_name,
        "language": _clip(headers.get("accept-language"), 200),
        "ch_ua": _clip(headers.get("sec-ch-ua"), 300),
        "ch_mobile": _clip(headers.get("sec-ch-ua-mobile"), 8),
        "ch_platform": _clip(headers.get("sec-ch-ua-platform"), 40),
        "fetch_site": _clip(headers.get("sec-fetch-site"), 20),
        "fetch_mode": _clip(headers.get("sec-fetch-mode"), 20),
        "fetch_dest": _clip(headers.get("sec-fetch-dest"), 20),
        "screen": "", "viewport": "", "pixel_ratio": None, "timezone": "", "load_ms": None, "view": "",
    }
    for k in ("screen", "viewport", "pixel_ratio", "timezone", "load_ms", "view"):
        if k in extra:
            row[k] = extra[k]
    return row


def _healthcheck(scope: Scope) -> bool:
    """The container asking itself whether it is up (the Dockerfile's HEALTHCHECK)."""
    if scope.get("path") != "/api/health":
        return False
    peer = (scope.get("client") or ("", 0))[0] or ""
    headers = Headers(scope=scope)
    return _ip(peer) in ("127.0.0.1", "::1") and not headers.get("x-forwarded-for") and not headers.get(
        "cf-connecting-ip")


# ── Writing ──────────────────────────────────────────────────────────────────


def init(db_path: str) -> None:
    with connect(db_path) as conn:
        # Before the first table: pages freed by the retention sweep can then be
        # handed back to the disk.
        conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
        conn.executescript(_DDL)


def insert(conn: Any, rows: list[dict[str, Any]]) -> None:
    cols = ", ".join(COLUMNS)
    marks = ", ".join(f":{c}" for c in COLUMNS)
    conn.executemany(f"INSERT INTO requests ({cols}) VALUES ({marks})", rows)


def prune(db_path: str, days: int, *, now: datetime | None = None) -> int:
    """Delete rows older than *days*; how many went."""
    cutoff = iso((now or datetime.now(UTC)) - timedelta(days=days))
    with connect(db_path) as conn:
        n = conn.execute("DELETE FROM requests WHERE ts < ?", (cutoff,)).rowcount
    if n:
        with connect(db_path) as conn:
            conn.execute("PRAGMA incremental_vacuum")
    return n


class Traffic:
    """The log's writer: a queue the middleware puts rows on, and a thread
    that writes them in batches and sweeps out old ones."""

    def __init__(self, db_path: str, retention_days: int) -> None:
        self.db_path = db_path
        self.retention_days = retention_days
        self.dropped = 0
        self._q: queue.Queue[dict[str, Any] | None] = queue.Queue(maxsize=_QUEUE_MAX)
        self._thread: threading.Thread | None = None
        #: Why the log could not start, or None.
        self.problem: str | None = None

    @property
    def running(self) -> bool:
        return self._thread is not None

    def start(self) -> None:
        """Open the file and start writing. A log that cannot be opened is
        switched off with a warning: it never stops the site from starting."""
        if self._thread is not None:
            return
        try:
            init(self.db_path)
        except Exception as exc:  # noqa: BLE001
            self.problem = f"{self.db_path}: {exc}"
            print(f"traffic log: off, cannot open {self.problem}", flush=True)
            return
        self._thread = threading.Thread(target=self._run, name="traffic-log", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Write what is queued, then end the thread."""
        if self._thread is None:
            return
        with contextlib.suppress(queue.Full):
            self._q.put(None, timeout=timeout)
        self._thread.join(timeout)
        self._thread = None

    def put(self, row: dict[str, Any]) -> None:
        if self._thread is None:
            return
        try:
            self._q.put_nowait(row)
        except queue.Full:
            self.dropped += 1

    def flush(self, timeout: float = 5.0) -> None:
        """Wait until every queued row is written (the tests read right after)."""
        deadline = time.monotonic() + timeout
        while self._q.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.01)

    def _batches(self) -> Iterator[list[dict[str, Any]] | None]:
        while True:
            try:
                first = self._q.get(timeout=_BATCH_WAIT_S)
            except queue.Empty:
                yield []
                continue
            batch, done = [], first is None
            if first is not None:
                batch.append(first)
            while not done and len(batch) < _BATCH:
                try:
                    nxt = self._q.get_nowait()
                except queue.Empty:
                    break
                if nxt is None:
                    done = True
                else:
                    batch.append(nxt)
            yield batch
            if done:
                yield None
                return

    def _run(self) -> None:
        next_prune = 0.0
        for batch in self._batches():
            if batch is None:
                self._q.task_done()
                return
            if batch:
                try:
                    with connect(self.db_path) as conn:
                        insert(conn, batch)
                except Exception as exc:  # noqa: BLE001 - the log never takes the site down
                    print(f"traffic log: {len(batch)} rows not written: {exc}", flush=True)
                for _ in batch:
                    self._q.task_done()
            if time.monotonic() >= next_prune:
                next_prune = time.monotonic() + _PRUNE_EVERY_S
                with contextlib.suppress(Exception):
                    prune(self.db_path, self.retention_days)


class TrafficLog:
    """The middleware: around the whole app, so every answer is seen, a
    redirect or a refused host as well as a page."""

    def __init__(self, app: ASGIApp, log: Traffic) -> None:
        self.app, self.log = app, log

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _healthcheck(scope):
            await self.app(scope, receive, send)
            return
        started, t0 = datetime.now(UTC), time.perf_counter()
        seen = {"status": 0, "bytes": 0}
        extra: dict[str, Any] = {}
        scope[EXTRA] = extra

        async def counted(message: Message) -> None:
            if message["type"] == "http.response.start":
                seen["status"] = message["status"]
            elif message["type"] == "http.response.body":
                seen["bytes"] += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, counted)
        except BaseException:
            seen["status"] = seen["status"] or 500
            raise
        finally:
            with contextlib.suppress(Exception):
                self.log.put(build_row(
                    scope, seen["status"], seen["bytes"], (time.perf_counter() - t0) * 1000, extra, started))


# ── Reading: the report ──────────────────────────────────────────────────────

PERIODS: dict[str, timedelta | None] = {
    "24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30),
    "90d": timedelta(days=90), "365d": timedelta(days=365), "all": None,
}
WHO = ("people", "bots", "all")
KINDS = ("page", "asset", "api", "admin", "beacon", "other")
_TOP = 15


@dataclass(frozen=True)
class Filter:
    """Which rows a report or the request log reads."""

    period: str = "7d"
    who: str = "people"
    kind: str = ""
    status: str = ""
    ip: str = ""
    path: str = ""
    country: str = ""
    q: str = ""

    def since(self, now: datetime) -> str | None:
        span = PERIODS[self.period]
        return iso(now - span) if span else None

    def where(self, now: datetime, *, beacons: bool = True) -> tuple[str, list[Any]]:
        """SQL for these rows. `beacons=False` leaves beacon rows out, as
        every total must."""
        sql, args = ["1=1"], []
        since = self.since(now)
        if since:
            sql.append("ts >= ?")
            args.append(since)
        if self.who == "people":
            sql.append("is_bot = 0")
        elif self.who == "bots":
            sql.append("is_bot = 1")
        if not beacons:
            sql.append("kind != 'beacon'")
        if self.kind:
            sql.append("kind = ?")
            args.append(self.kind)
        if re.fullmatch(r"[1-5]xx", self.status):
            lo = int(self.status[0]) * 100
            sql.append("status BETWEEN ? AND ?")
            args += [lo, lo + 99]
        elif re.fullmatch(r"\d{3}", self.status):
            sql.append("status = ?")
            args.append(int(self.status))
        if self.ip:
            sql.append("ip = ?")
            args.append(self.ip.strip())
        if self.path:
            sql.append("instr(path, ?) > 0")
            args.append(self.path)
        if self.country:
            sql.append("country = ?")
            args.append(self.country.strip().upper())
        if self.q:
            sql.append("(instr(path, ?) > 0 OR instr(query, ?) > 0 OR instr(user_agent, ?) > 0 "
                       "OR instr(referrer, ?) > 0 OR instr(ip, ?) > 0 OR instr(bot_name, ?) > 0)")
            args += [self.q] * 6
        return " AND ".join(sql), args


def _buckets(since: str | None, first: str | None, now: datetime, hourly: bool) -> list[str]:
    """Every bucket from the period's start (or the first row) to now, so a
    quiet hour is a zero, not a gap."""
    start_s = since or first
    if not start_s:
        return []
    start = datetime.fromisoformat(start_s.replace("Z", "+00:00"))
    step = timedelta(hours=1) if hourly else timedelta(days=1)
    start = start.replace(minute=0, second=0, microsecond=0)
    if not hourly:
        start = start.replace(hour=0)
    out, t = [], start
    while t <= now and len(out) < 4000:
        out.append(t.strftime("%Y-%m-%dT%H") if hourly else t.strftime("%Y-%m-%d"))
        t += step
    return out


def _top(conn: Any, column: str, where: str, args: list[Any], extra: str = "", limit: int = _TOP,
         ) -> list[dict[str, Any]]:
    rows = conn.execute(
        f"SELECT {column} AS label, COUNT(*) AS n, COUNT(DISTINCT ip) AS visitors FROM requests "
        f"WHERE {where} {extra} GROUP BY label ORDER BY n DESC, label LIMIT ?",
        [*args, limit],
    ).fetchall()
    return [{"label": r[0] or "", "n": r[1], "visitors": r[2]} for r in rows]


def report(db_path: str, f: Filter, *, now: datetime | None = None) -> dict[str, Any]:
    """The report page's numbers for one period and audience. Beacon rows are
    in none of the totals; they are read only for what the browser told us."""
    now = now or datetime.now(UTC)
    where, args = f.where(now, beacons=False)
    hourly = PERIODS[f.period] is not None and PERIODS[f.period] <= timedelta(days=2)
    page = "kind = 'page' AND status BETWEEN 200 AND 299"
    with connect(db_path) as conn:
        t = conn.execute(
            f"SELECT COUNT(*), COALESCE(SUM(kind = 'page' AND status BETWEEN 200 AND 299), 0), "
            f"COUNT(DISTINCT ip), COALESCE(SUM(status BETWEEN 400 AND 499), 0), "
            f"COALESCE(SUM(status >= 500), 0), COALESCE(SUM(bytes), 0), COALESCE(SUM(is_bot), 0), MIN(ts) "
            f"FROM requests WHERE {where}", args,
        ).fetchone()
        n = t[0]
        median = conn.execute(
            f"SELECT duration_ms FROM requests WHERE {where} ORDER BY duration_ms LIMIT 1 OFFSET ?",
            [*args, n // 2],
        ).fetchone() if n else None
        page_visitors = conn.execute(
            f"SELECT COUNT(DISTINCT ip) FROM requests WHERE {where} AND {page}", args,
        ).fetchone()[0]
        bucket = "substr(ts, 1, 13)" if hourly else "substr(ts, 1, 10)"
        by_bucket = {
            r[0]: r[1:] for r in conn.execute(
                f"SELECT {bucket} AS b, COUNT(*), COALESCE(SUM({page}), 0), "
                f"COUNT(DISTINCT CASE WHEN {page} THEN ip END), COUNT(DISTINCT ip) "
                f"FROM requests WHERE {where} GROUP BY b", args,
            )
        }
        series = []
        for b in _buckets(f.since(now), t[7], now, hourly):
            reqs, views, visitors, addresses = by_bucket.get(b, (0, 0, 0, 0))
            series.append({"t": b, "requests": reqs, "page_views": views, "visitors": visitors,
                           "addresses": addresses})
        pages = f"AND {page}"
        result = {
            "period": f.period, "who": f.who, "hourly": hourly, "now": iso(now),
            "totals": {
                "requests": n, "page_views": t[1], "visitors": page_visitors, "addresses": t[2],
                "client_errors": t[3], "server_errors": t[4], "bytes": t[5], "bot_requests": t[6],
                "median_ms": median[0] if median else None,
            },
            "series": series,
            "pages": _top(conn, "path || CASE WHEN query != '' THEN '?' || query ELSE '' END", where, args, pages),
            "referrers": _top(conn, "ref_host", where, args, f"AND ref_host != '' AND ref_host != host AND instr(host, ref_host || ':') != 1 {pages}"),
            "countries": _top(conn, "country", where, args, pages),
            "browsers": _top(conn, "browser", where, args, f"AND is_bot = 0 {pages}"),
            "systems": _top(conn, "os", where, args, f"AND is_bot = 0 {pages}"),
            "devices": _top(conn, "device", where, args, pages),
            "bots": _top(conn, "bot_name", where, args, "AND is_bot = 1"),
            "not_found": _top(conn, "path", where, args, "AND status = 404"),
            "addresses": [
                {"ip": r[0], "n": r[1], "page_views": r[2], "country": r[3] or "", "last": r[4], "bot": bool(r[5])}
                for r in conn.execute(
                    f"SELECT ip, COUNT(*) AS n, COALESCE(SUM({page}), 0), MAX(country), MAX(ts), MAX(is_bot) "
                    f"FROM requests WHERE {where} GROUP BY ip ORDER BY n DESC, ip LIMIT ?", [*args, _TOP],
                )
            ],
        }
        # What only the browser knows, from the beacons of the same period and audience.
        bwhere, bargs = Filter(period=f.period, who=f.who, kind="beacon").where(now)
        loads = [r[0] for r in conn.execute(
            f"SELECT load_ms FROM requests WHERE {bwhere} AND load_ms IS NOT NULL ORDER BY load_ms", bargs)]
        result["browser_side"] = {
            "beacons": conn.execute(f"SELECT COUNT(*) FROM requests WHERE {bwhere}", bargs).fetchone()[0],
            "median_load_ms": loads[len(loads) // 2] if loads else None,
            "screens": _top(conn, "screen", bwhere, bargs, "AND screen != ''", 8),
            "viewports": _top(conn, "viewport", bwhere, bargs, "AND viewport != ''", 8),
            "timezones": _top(conn, "timezone", bwhere, bargs, "AND timezone != ''", 8),
        }
    return result


def requests(db_path: str, f: Filter, *, page: int = 1, per: int = 50,
             now: datetime | None = None) -> dict[str, Any]:
    """One page of the request log, newest first, and how many rows match."""
    now = now or datetime.now(UTC)
    where, args = f.where(now)
    with connect(db_path) as conn:
        conn.row_factory = _dict_row
        total = conn.execute(f"SELECT COUNT(*) AS n FROM requests WHERE {where}", args).fetchone()["n"]
        rows = conn.execute(
            f"SELECT id, {', '.join(COLUMNS)} FROM requests WHERE {where} ORDER BY ts DESC, id DESC "
            "LIMIT ? OFFSET ?", [*args, per, (page - 1) * per],
        ).fetchall()
    return {"total": total, "page": page, "per": per, "rows": rows}


def export(db_path: str, f: Filter, *, limit: int = 100_000, now: datetime | None = None,
           ) -> Iterator[tuple[Any, ...]]:
    """Every matching row, newest first, for the CSV."""
    now = now or datetime.now(UTC)
    where, args = f.where(now)
    with connect(db_path) as conn:
        yield from conn.execute(
            f"SELECT id, {', '.join(COLUMNS)} FROM requests WHERE {where} ORDER BY ts DESC, id DESC LIMIT ?",
            [*args, limit],
        )


def _dict_row(cursor: Any, row: tuple[Any, ...]) -> dict[str, Any]:
    return {d[0]: v for d, v in zip(cursor.description, row, strict=True)}


def forget(db_path: str, ip: str) -> int:
    """Delete every row from one address (docs/traffic.md, "One person's data")."""
    with connect(db_path) as conn:
        return conn.execute("DELETE FROM requests WHERE ip = ?", (ip,)).rowcount
