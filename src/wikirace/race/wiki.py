"""Wikipedia, read-only — the board WikiRace is played on.

Everything a race needs from en.wikipedia.org and nothing else: an article's
links in the order a reader meets them, its one-line description and lead,
whether a title is a real article (and where its redirect lands), a free-text
subject resolved to an article, and random subjects.

**An article's links come from two fields of ONE parse call.** `prop=links` is
the authority on WHICH links count — namespace 0, existing, under the title the
page links by (a redirect stays a redirect) — but it lists them in parser order,
not reading order. `prop=text` is the rendered page, whose `<a href="/wiki/…">`
order IS reading order: the infobox, then the lead, then the body, then the
navboxes. So the set comes from the first and the order from the second, and a
link the HTML never shows still counts and goes last. Measured on "2001 World
Series" (2026-09-21): 1,110 links, all 1,110 found in the HTML.

Politeness, since four racers share one board: a descriptive User-Agent
(Wikimedia's policy throttles generic ones, and asks each client to name a way
to reach its operator: WIKIRACE_USER_AGENT), one page cache for the process,
and in-flight de-duplication: four racers landing on "United States" in the
same second cost one request.
"""
from __future__ import annotations

import asyncio
import random
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, unquote

import httpx

from .subjects import CLASSIC

API = "https://en.wikipedia.org/w/api.php"
PAGEVIEWS_TOP = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access"
ARTICLE_URL = "https://en.wikipedia.org/wiki/"

#: Used when the caller names none; the app passes WIKIRACE_USER_AGENT.
USER_AGENT = "wikirace (https://github.com/Analytics206/JEV-Arcade)"

_TIMEOUT = 20.0
_PAGE_TTL = 6 * 3600.0
#: A big article's link list is ~150 KB; 256 of them is a ceiling, not a norm.
_PAGE_CACHE_MAX = 256
_MISSING_TTL = 600.0
#: Redirects fetched per request (the API's cap for a normal client) and how
#: many requests to spend on one target — "United States" has thousands.
_REDIRECTS_PER_ASK = 500
_REDIRECT_ASKS = 6
_TRENDING_TTL = 6 * 3600.0
#: Trending titles kept to draw from — deep enough to vary, shallow enough that
#: they are all things people have heard of this week.
_TRENDING_TOP = 150
#: A "wild" subject must be at least this long (bytes of wikitext). Random
#: articles skew to one-paragraph stubs with a handful of inbound links, which
#: make unwinnable targets rather than hard ones.
_WILD_MIN_BYTES = 6000

#: Namespace prefixes a pageviews "top" list carries alongside articles.
_NAMESPACES = frozenset({
    "Special", "Wikipedia", "WP", "Project", "File", "Image", "Media", "Portal", "Help",
    "Category", "Template", "Talk", "User", "User talk", "Draft", "Module", "MediaWiki",
    "TimedText", "Book", "Topic", "Wikipedia talk", "Template talk", "Category talk",
})
#: Kept out of the Trending pool: a game board, not a mirror of every search.
_TRENDING_BLOCK = re.compile(r"(?i)\b(porn\w*|xxx|hentai|xvideos|xhamster|onlyfans|nude|nudity)\b")


class WikiError(RuntimeError):
    """Wikipedia could not answer (unreachable, throttled, an API error)."""


class PageMissing(WikiError):
    """No article by that title."""


# ── Titles ────────────────────────────────────────────────────────────────────

_DASHES = str.maketrans({c: "-" for c in "‐‑‒–—―−"})
_APOSTROPHES = str.maketrans({c: "'" for c in "‘’ʼ"} | {c: '"' for c in "“”"})


def normalize_title(title: str) -> str:
    """MediaWiki's own canonical form: spaces not underscores, single-spaced,
    first letter upper-case. Exact otherwise — `AIDS` and `Aids` are different."""
    t = " ".join(title.replace("_", " ").split())
    return t[:1].upper() + t[1:]


def fold(title: str) -> str:
    """A forgiving comparison key for a title a model TYPED.

    Case-insensitive throughout, and one spelling for each dash and quote, so a
    model that writes "Amazon Rainforest" or "1973-2001" for an en dash has named
    the link it meant. Never used to decide which links a page has — only to
    recognise which one a reply meant.
    """
    return normalize_title(title).translate(_DASHES).translate(_APOSTROPHES).casefold()


def article_url(title: str) -> str:
    return ARTICLE_URL + quote(normalize_title(title).replace(" ", "_"), safe="()',:!-.")


# ── Parsed pages ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Page:
    title: str
    description: str
    lead: str
    #: Every link a racer may follow, in reading order.
    links: tuple[str, ...]


@dataclass(frozen=True)
class Lookup:
    """What a title turns out to be."""

    input: str
    exists: bool
    #: The canonical title after normalisation and redirects — or the input,
    #: normalised, when nothing exists there.
    title: str
    description: str = ""
    disambiguation: bool = False


_SKIP_IN_LEAD = frozenset({"sup", "style", "script", "math", "annotation"})
_CITE_MARKS = re.compile(r"\[(?:\d+|[a-z]|note \d+|citation needed|clarification needed)\]")


class _Scan(HTMLParser):
    """One pass over rendered article HTML: link order, and the lead paragraph.

    The lead is the first `<p>` outside any table (an infobox can hold one) with
    real prose in it — rendered pages open with an empty `<p class="mw-empty-elt">`
    more often than not. Footnote markers and inline styles are skipped.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []
        self.lead = ""
        self._tables = 0
        self._in_p = False
        self._skip: list[str] = []
        self._buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            for key, value in attrs:
                if key == "href" and value and value.startswith("/wiki/"):
                    self.hrefs.append(value[6:])
                    break
        elif tag == "table":
            self._tables += 1
        elif tag == "p" and not self.lead and not self._tables:
            self._in_p, self._buf, self._skip = True, [], []
        if self._in_p and tag in _SKIP_IN_LEAD:
            self._skip.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag == "table":
            self._tables = max(0, self._tables - 1)
        if not self._in_p:
            return
        if self._skip and tag == self._skip[-1]:
            self._skip.pop()
        elif tag == "p":
            self._in_p = False
            text = " ".join(_CITE_MARKS.sub("", "".join(self._buf)).split())
            if len(text) >= 40:
                self.lead = text

    def handle_data(self, data: str) -> None:
        if self._in_p and not self._skip:
            self._buf.append(data)


def _href_title(href: str) -> str:
    return unquote(href.split("#", 1)[0].split("?", 1)[0]).replace("_", " ")


def trim_lead(text: str, limit: int = 420) -> str:
    """A lead short enough for a prompt, ending on a sentence where one fits."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
    return cut[: end + 1] if end >= 120 else cut.rstrip() + "…"


def parse_page(data: dict[str, Any]) -> Page:
    """A `prop=text|links|properties` parse response, as a Page. Pure."""
    err = data.get("error")
    if isinstance(err, dict):
        info = str(err.get("info") or err.get("code") or "unknown error")
        if err.get("code") in {"missingtitle", "invalidtitle", "pagecannotexist"}:
            raise PageMissing(info)
        raise WikiError(info)
    p = data.get("parse") or {}
    title = str(p.get("title") or "")
    if not title:
        raise WikiError("Wikipedia returned a page with no title")

    # The authority on which links count, keyed exactly (MediaWiki's own case
    # rules). A list per key only because two titles CAN normalise alike when
    # the API hands back something odd; both then survive.
    valid: dict[str, list[str]] = {}
    for link in p.get("links") or []:
        name = link.get("title")
        if link.get("ns") == 0 and link.get("exists") and isinstance(name, str) and name:
            valid.setdefault(normalize_title(name), []).append(name)

    scan = _Scan()
    scan.feed(str(p.get("text") or ""))
    scan.close()

    ordered: list[str] = []
    placed: set[str] = set()
    for href in scan.hrefs:
        key = normalize_title(_href_title(href))
        if key in valid and key not in placed:
            placed.add(key)
            ordered.extend(valid[key])
    # Links the rendered page never showed — still links, so still legal. Last,
    # and alphabetised so the tail is stable between two fetches.
    for key in sorted(k for k in valid if k not in placed):
        ordered.extend(valid[key])

    props = p.get("properties") or {}
    if isinstance(props, list):  # formatversion=1's shape, should it ever come back
        props = {x.get("name"): x.get("*") for x in props if isinstance(x, dict)}
    return Page(
        title=title,
        description=str(props.get("wikibase-shortdesc") or ""),
        lead=trim_lead(scan.lead),
        links=tuple(dict.fromkeys(ordered)),
    )


def _playable_trending(article: str) -> bool:
    title = article.replace("_", " ").strip()
    if not title or title == "Main Page" or title.startswith((".", "List of", "Deaths in")):
        return False
    if ":" in title and title.split(":", 1)[0] in _NAMESPACES:
        return False
    return not _TRENDING_BLOCK.search(title)


# ── The client ────────────────────────────────────────────────────────────────

Getter = Callable[[str, dict[str, Any]], Awaitable[Any]]


class Wiki:
    """A Wikipedia reader with a page cache. The app makes one per process.

    *get* replaces the HTTP transport — `async (url, params) -> parsed JSON` —
    which is how the tests run a whole race without a network.
    """

    def __init__(self, get: Getter | None = None, *, user_agent: str = USER_AGENT) -> None:
        self._get: Getter = get or self._http_get
        self._user_agent = user_agent
        self._pages: OrderedDict[str, tuple[float, Page]] = OrderedDict()
        self._missing: dict[str, tuple[float, str]] = {}
        self._inflight: dict[str, asyncio.Future[Page]] = {}
        self._trending: tuple[float, list[str]] | None = None
        self._hc: httpx.AsyncClient | None = None
        self._hc_loop: asyncio.AbstractEventLoop | None = None

    # ── transport ──

    def _client(self) -> httpx.AsyncClient:
        # One keep-alive client per event loop: uvicorn runs one, but a client
        # created on another loop cannot be awaited on this one.
        loop = asyncio.get_running_loop()
        if self._hc is None or self._hc_loop is not loop:
            self._hc = httpx.AsyncClient(
                timeout=_TIMEOUT,
                headers={"User-Agent": self._user_agent, "Accept": "application/json"},
                follow_redirects=True,
            )
            self._hc_loop = loop
        return self._hc

    async def aclose(self) -> None:
        hc, self._hc, self._hc_loop = self._hc, None, None
        if hc is not None:
            try:
                await hc.aclose()
            except RuntimeError:  # its loop is gone; nothing left to close
                pass

    async def _http_get(self, url: str, params: dict[str, Any]) -> Any:
        last = ""
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(0.6 * attempt)
            try:
                resp = await self._client().get(url, params=params)
            except httpx.HTTPError as exc:
                last = f"could not reach Wikipedia ({type(exc).__name__})"
                continue
            if resp.status_code == 200:
                try:
                    return resp.json()
                except ValueError:
                    # A 200 carrying an HTML error page (a proxy, maintenance).
                    last = "Wikipedia answered with something that is not JSON"
                    continue
            last = f"Wikipedia answered HTTP {resp.status_code}"
            if resp.status_code != 429 and resp.status_code < 500:
                raise PageMissing(last) if resp.status_code == 404 else WikiError(last)
        raise WikiError(last)

    async def query(self, params: dict[str, Any]) -> Any:
        """Any other read of the Action API, for the Arcade's games (extracts,
        coordinates, categories, random pages): *params* as the API takes them,
        JSON in the modern format. Raises WikiError. Uncached: a game caches
        what it reads again."""
        return await self._get(API, {**params, "format": "json", "formatversion": "2"})

    # ── articles ──

    async def page(self, title: str) -> Page:
        """The article at *title*, redirects followed. Raises PageMissing."""
        key = normalize_title(title)
        hit = self._pages.get(key)
        if hit and hit[0] > time.monotonic():
            self._pages.move_to_end(key)
            return hit[1]
        # Remembered briefly: a racer told a link is dead may pick it again, and
        # each retry should not cost another round trip.
        missing = self._missing.get(key)
        if missing and missing[0] > time.monotonic():
            raise PageMissing(missing[1])
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.ensure_future(self._fetch_page(key))
            self._inflight[key] = fut
            fut.add_done_callback(lambda _f, k=key: self._inflight.pop(k, None))
        # Shielded: a racer stopped mid-fetch must not cancel the fetch the
        # other three are waiting on.
        return await asyncio.shield(fut)

    async def _fetch_page(self, title: str) -> Page:
        data = await self._get(API, {
            "action": "parse", "page": title, "prop": "text|links|properties",
            "redirects": "1", "disableeditsection": "1", "disabletoc": "1",
            "disablelimitreport": "1", "format": "json", "formatversion": "2",
        })
        try:
            # Off the event loop: a big article is a few hundred milliseconds of
            # HTML to scan, and every other lane's thinking clock (and every
            # stream) would stand still while it ran.
            page = await asyncio.to_thread(parse_page, data)
        except PageMissing as exc:
            self._missing[normalize_title(title)] = (time.monotonic() + _MISSING_TTL, str(exc))
            raise
        expires = time.monotonic() + _PAGE_TTL
        for k in {normalize_title(title), normalize_title(page.title)}:
            self._pages[k] = (expires, page)
            self._pages.move_to_end(k)
        while len(self._pages) > _PAGE_CACHE_MAX:
            self._pages.popitem(last=False)
        return page

    async def lookup(self, title: str) -> Lookup:
        """Whether *title* is an article, and which one after redirects."""
        return (await self.describe([title]))[title]

    async def describe(self, titles: Iterable[str]) -> dict[str, Lookup]:
        """Look up many titles, fifty to a request. Keyed by the input title."""
        wanted = list(dict.fromkeys(t for t in titles))
        out: dict[str, Lookup] = {}
        # A title with characters no article can have never reaches the API: a
        # "|" would split one title into two.
        askable = []
        for t in wanted:
            if not t.strip() or any(c in t for c in "|#<>[]{}"):
                out[t] = Lookup(t, False, t.strip())
            else:
                askable.append(t)
        for i in range(0, len(askable), 50):
            batch = askable[i:i + 50]
            data = await self._get(API, {
                "action": "query", "titles": "|".join(batch), "redirects": "1",
                "prop": "description|pageprops", "ppprop": "disambiguation",
                "format": "json", "formatversion": "2",
            })
            if isinstance(data.get("error"), dict):
                # maxlag, ratelimited, readonly: an answer about the API, not the
                # titles. Reading it as "all missing" would call a real article
                # a fake one.
                err = data["error"]
                raise WikiError(str(err.get("info") or err.get("code") or "API error"))
            q = data.get("query") or {}
            normalized = {n["from"]: n["to"] for n in q.get("normalized") or []}
            redirects = {r["from"]: r["to"] for r in q.get("redirects") or []}
            pages = {p.get("title"): p for p in q.get("pages") or []}
            for t in batch:
                name = normalized.get(t, t)
                # A double redirect is two hops; a loop is none.
                hops: set[str] = set()
                while name in redirects and name not in hops:
                    hops.add(name)
                    name = redirects[name]
                p = pages.get(name)
                if not p or p.get("missing") or p.get("invalid"):
                    out[t] = Lookup(t, False, name)
                else:
                    out[t] = Lookup(
                        t, True, str(p["title"]), str(p.get("description") or ""),
                        "disambiguation" in (p.get("pageprops") or {}),
                    )
        return out

    async def redirects_to(self, title: str) -> list[str]:
        """Every article-space title that redirects to *title* — the target's
        other names ("Twin Towers" for the 1973–2001 towers).

        A pick that names one of them while the page links another is the same
        move; without this list it read as a jump to the target. Bounded: a
        target with thousands of redirects keeps the first few thousand, which
        covers every name a racer is likely to type.
        """
        names: list[str] = []
        params: dict[str, Any] = {
            "action": "query", "titles": title, "prop": "redirects", "rdprop": "title",
            "rdnamespace": 0, "rdlimit": _REDIRECTS_PER_ASK, "format": "json", "formatversion": "2",
        }
        for _ in range(_REDIRECT_ASKS):
            data = await self._get(API, params)
            if isinstance(data.get("error"), dict):
                raise WikiError(str(data["error"].get("info") or "API error"))
            for p in (data.get("query") or {}).get("pages") or []:
                names += [r["title"] for r in p.get("redirects") or [] if isinstance(r.get("title"), str)]
            cont = data.get("continue")
            if not isinstance(cont, dict) or "rdcontinue" not in cont:
                break
            params = {**params, **cont}
        return names

    async def search(self, q: str, limit: int = 8) -> list[Lookup]:
        data = await self._get(API, {
            "action": "query", "generator": "search", "gsrsearch": q, "gsrlimit": limit,
            "gsrnamespace": 0, "prop": "description|pageprops", "ppprop": "disambiguation",
            "redirects": "1", "format": "json", "formatversion": "2",
        })
        pages = sorted((data.get("query") or {}).get("pages") or [], key=lambda p: p.get("index", 1e9))
        return [
            Lookup(q, True, str(p["title"]), str(p.get("description") or ""),
                   "disambiguation" in (p.get("pageprops") or {}))
            for p in pages if not p.get("missing")
        ]

    async def resolve(self, q: str) -> dict[str, Any]:
        """A typed subject as the article a race can use.

        The exact title (redirects followed) when it is an article; otherwise the
        best search hit that is one. A disambiguation page is never the answer —
        "World Trade Center" is one — but the other hits ride along so the page
        can offer them.
        """
        q = " ".join(q.split())
        if not q:
            raise ValueError("type a subject")
        if len(q) > 250:
            raise ValueError("a subject is at most 250 characters")
        exact = await self.lookup(q)
        if exact.exists and not exact.disambiguation:
            note = None
            if normalize_title(q) != exact.title:
                note = f"“{q}” leads to “{exact.title}”"
            return {"input": q, "title": exact.title, "description": exact.description,
                    "note": note, "candidates": []}
        hits = [h for h in await self.search(q, 8) if not h.disambiguation]
        if not hits:
            raise PageMissing(f"no Wikipedia article matches “{q}”")
        best = hits[0]
        if exact.exists:
            note = f"“{exact.title}” is a disambiguation page — took the top article match"
        else:
            note = f"No article is titled “{q}” — took the top search match"
        return {
            "input": q, "title": best.title, "description": best.description, "note": note,
            "candidates": [{"title": h.title, "description": h.description} for h in hits[:6]],
        }

    # ── random subjects ──

    async def trending(self) -> list[str]:
        """Yesterday's most-read articles, minus the machinery around them."""
        if self._trending and self._trending[0] > time.monotonic():
            return self._trending[1]
        day = datetime.now(UTC).date() - timedelta(days=1)
        for back in range(3):  # a day's list lands some hours after midnight UTC
            d = day - timedelta(days=back)
            try:
                data = await self._get(f"{PAGEVIEWS_TOP}/{d:%Y/%m/%d}", {})
            except WikiError:
                continue
            items = (data.get("items") or [{}])[0].get("articles") or []
            titles = [a["article"].replace("_", " ") for a in items
                      if isinstance(a.get("article"), str) and _playable_trending(a["article"])]
            if titles:
                self._trending = (time.monotonic() + _TRENDING_TTL, titles[:_TRENDING_TOP])
                return self._trending[1]
        raise WikiError("no Trending list is available from Wikimedia right now")

    async def wild(self, n: int) -> list[Lookup]:
        """Truly random articles, filtered to ones long enough to be reachable."""
        found: list[Lookup] = []
        for _ in range(5):
            data = await self._get(API, {
                "action": "query", "generator": "random", "grnnamespace": 0, "grnlimit": 20,
                "prop": "info|description|pageprops", "ppprop": "disambiguation",
                "format": "json", "formatversion": "2",
            })
            for p in (data.get("query") or {}).get("pages") or []:
                if "disambiguation" in (p.get("pageprops") or {}):
                    continue
                if int(p.get("length") or 0) < _WILD_MIN_BYTES or str(p.get("title", "")).startswith("List of"):
                    continue
                found.append(Lookup(str(p["title"]), True, str(p["title"]), str(p.get("description") or "")))
                if len(found) >= n:
                    return found
        return found

    async def random_subjects(self, pool: str, n: int, exclude: Iterable[str] = ()) -> list[Lookup]:
        """*n* distinct playable articles from *pool*: classic | trending | wild."""
        skip = {fold(t) for t in exclude if t}
        picked: list[Lookup] = []

        def take(candidates: Iterable[Lookup]) -> None:
            for c in candidates:
                key = fold(c.title)
                if c.exists and not c.disambiguation and key not in skip:
                    skip.add(key)
                    picked.append(c)
                if len(picked) >= n:
                    return

        if pool == "wild":
            take(await self.wild(n + 2))
        elif pool in ("classic", "trending"):
            source = CLASSIC if pool == "classic" else await self.trending()
            for _ in range(3):
                titles = [t for t in source if fold(t) not in skip]
                if not titles:
                    break
                draw = random.sample(titles, min(len(titles), n - len(picked) + 2))
                looked = await self.describe(draw)
                take(looked[t] for t in draw)
                if len(picked) >= n:
                    break
        else:
            raise ValueError(f"unknown pool {pool!r}: classic, trending or wild")
        if len(picked) < n:
            raise WikiError(f"could not draw {n} subjects from the {pool} pool")
        return picked[:n]

