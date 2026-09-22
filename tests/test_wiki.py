"""WikiRace's Wikipedia reader — no network; the transport is a fake.

The board has to be right before anything played on it means anything:

* **Which links count comes from the API; their order from the page.** A link
  the parser lists but the HTML never shows still counts (last); a red link,
  a File: link or a Help: link never does.
* **A typed subject lands on an article, never a disambiguation page.**
  "World Trade Center" is one, and a race whose target is a list of towers is
  not the race anybody asked for.
* **Four racers on one page cost one request.**
"""
from __future__ import annotations

import asyncio

import pytest

from wikirace.race import wiki as W
from wikirace.race.wiki import PageMissing, Wiki, WikiError, parse_page


def _parse(title: str, html: str, links: list[tuple[int, str, bool]], desc: str = "") -> dict:
    return {"parse": {
        "title": title, "text": html,
        "links": [{"ns": ns, "title": t, "exists": ex} for ns, t, ex in links],
        "properties": {"wikibase-shortdesc": desc} if desc else {},
    }}


HTML = """
<div class="mw-parser-output">
<table class="infobox"><tr><td><p>Infobox prose that is long enough to be mistaken for a lead.</p>
<a href="/wiki/Chase_Field">Chase Field</a></td></tr></table>
<p class="mw-empty-elt">
</p>
<p>The <b>2001 World Series</b> was the championship<sup class="reference"><a href="#cite_note-1">[1]</a></sup>
series of <a href="/wiki/Major_League_Baseball" title="Major League Baseball">MLB</a>, played by the
<a href="/wiki/Arizona_Diamondbacks#History">Diamondbacks</a><style>.x{color:red}</style> and the
<a href="/wiki/New_York_Yankees">Yankees</a>.</p>
<a href="/w/index.php?title=Some_Redlink&amp;action=edit&amp;redlink=1">red</a>
<a href="/wiki/File:Logo.svg">logo</a> <a href="/wiki/Help:IPA">IPA</a>
<a href="/wiki/S%C3%A3o_Paulo">São Paulo</a> <a href="/wiki/Major_League_Baseball">again</a>
</div>
"""

LINKS = [
    (0, "Major League Baseball", True), (0, "Arizona Diamondbacks", True),
    (0, "New York Yankees", True), (0, "Chase Field", True), (0, "São Paulo", True),
    (0, "Some Redlink", False), (6, "File:Logo.svg", True), (12, "Help:IPA", True),
    (0, "Zebra", True), (0, "Aardvark", True),  # linked, but never in the HTML
]


# ── Parsing a page ────────────────────────────────────────────────────────────


def test_links_are_the_apis_set_in_the_pages_order():
    page = parse_page(_parse("2001 World Series", HTML, LINKS, "97th edition"))
    assert page.links == (
        "Chase Field", "Major League Baseball", "Arizona Diamondbacks", "New York Yankees",
        "São Paulo", "Aardvark", "Zebra",
    )


def test_red_links_and_other_namespaces_never_count():
    page = parse_page(_parse("X", HTML, LINKS))
    assert "Some Redlink" not in page.links
    assert not any(":" in link for link in page.links)


def test_the_lead_is_the_first_real_paragraph_outside_tables():
    page = parse_page(_parse("2001 World Series", HTML, LINKS, "97th edition"))
    assert page.lead.startswith("The 2001 World Series was the championship series of MLB")
    assert "[1]" not in page.lead and "color:red" not in page.lead
    assert page.description == "97th edition"


def test_a_missing_title_is_page_missing_and_other_errors_are_not():
    with pytest.raises(PageMissing):
        parse_page({"error": {"code": "missingtitle", "info": "The page you specified doesn't exist."}})
    with pytest.raises(WikiError) as exc:
        parse_page({"error": {"code": "ratelimited", "info": "slow down"}})
    assert not isinstance(exc.value, PageMissing)


def test_trim_lead_ends_on_a_sentence():
    text = "First sentence is here and it runs on for a while. " * 12
    out = W.trim_lead(text, 200)
    assert len(out) <= 200 and out.endswith(".")


# ── A fake Wikipedia ──────────────────────────────────────────────────────────


class FakeWiki:
    """Answers the handful of API shapes the reader sends."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.pages = {
            "Abraham Lincoln": {"pageid": 1, "ns": 0, "title": "Abraham Lincoln", "description": "16th US president"},
            "World Trade Center": {"pageid": 2, "ns": 0, "title": "World Trade Center",
                                   "description": "Topics referred to by the same term",
                                   "pageprops": {"disambiguation": ""}},
            "Amazon rainforest": {"pageid": 3, "ns": 0, "title": "Amazon rainforest", "description": "Rainforest"},
        }
        self.redirects = {"President Lincoln": "Abraham Lincoln", "Amazon Forest": "Amazon rainforest"}
        self.search_hits = {
            "World Trade Center": [
                {"title": "World Trade Center", "index": 1, "pageprops": {"disambiguation": ""}},
                {"title": "World Trade Center (1973–2001)", "index": 2, "description": "Twin towers"},
                {"title": "One World Trade Center", "index": 3, "description": "Skyscraper"},
            ],
        }

    async def __call__(self, url: str, params: dict) -> dict:
        self.calls.append({"url": url, **params})
        await asyncio.sleep(0)
        if params.get("action") == "parse":
            return _parse(params["page"], "<p>" + "x" * 50 + "</p>", [(0, "Brazil", True)])
        if params.get("generator") == "search":
            return {"query": {"pages": self.search_hits.get(params["gsrsearch"], [])}}
        if params.get("action") == "query" and "titles" in params:
            titles = params["titles"].split("|")
            normalized = [{"from": t, "to": t[:1].upper() + t[1:]} for t in titles if t[:1].islower()]
            norm = {n["from"]: n["to"] for n in normalized}
            redirects, pages = [], []
            for t in titles:
                name = norm.get(t, t)
                if name in self.redirects:
                    redirects.append({"from": name, "to": self.redirects[name]})
                    name = self.redirects[name]
                pages.append(self.pages.get(name, {"ns": 0, "title": name, "missing": True}))
            return {"query": {"normalized": normalized, "redirects": redirects, "pages": pages}}
        raise AssertionError(f"unexpected request {params}")


def _run(coro):
    return asyncio.run(coro)


# ── Looking titles up, resolving subjects ─────────────────────────────────────


def test_describe_follows_normalisation_and_redirects():
    fake = FakeWiki()
    out = _run(Wiki(get=fake).describe(["president Lincoln", "Amazon Forest", "Nowhere Land"]))
    assert out["Amazon Forest"].title == "Amazon rainforest" and out["Amazon Forest"].exists
    assert out["Nowhere Land"].exists is False


def test_a_title_no_article_can_have_is_never_sent():
    fake = FakeWiki()
    out = _run(Wiki(get=fake).describe(["A|B", "[[Brazil]]"]))
    assert not out["A|B"].exists and not out["[[Brazil]]"].exists
    assert fake.calls == []


def test_resolve_an_exact_article():
    r = _run(Wiki(get=FakeWiki()).resolve("Abraham Lincoln"))
    assert r["title"] == "Abraham Lincoln" and r["note"] is None and r["candidates"] == []


def test_resolve_follows_a_redirect_and_says_so():
    r = _run(Wiki(get=FakeWiki()).resolve("  President   Lincoln "))
    assert r["title"] == "Abraham Lincoln"
    assert "leads to" in r["note"]


def test_resolve_never_lands_on_a_disambiguation_page():
    r = _run(Wiki(get=FakeWiki()).resolve("World Trade Center"))
    assert r["title"] == "World Trade Center (1973–2001)"
    assert "disambiguation" in r["note"]
    assert [c["title"] for c in r["candidates"]] == ["World Trade Center (1973–2001)", "One World Trade Center"]


def test_resolve_with_no_match_is_page_missing_and_blank_is_refused():
    with pytest.raises(PageMissing):
        _run(Wiki(get=FakeWiki()).resolve("qwzx nothing"))
    with pytest.raises(ValueError):
        _run(Wiki(get=FakeWiki()).resolve("   "))


# ── The page cache ────────────────────────────────────────────────────────────


def test_four_racers_on_one_page_cost_one_request():
    fake = FakeWiki()
    reader = Wiki(get=fake)

    async def four():
        return await asyncio.gather(*(reader.page("United States") for _ in range(4)))

    pages = _run(four())
    assert len({id(p) for p in pages}) == 1
    assert sum(1 for c in fake.calls if c.get("action") == "parse") == 1


def test_a_cached_page_is_not_fetched_again():
    fake = FakeWiki()
    reader = Wiki(get=fake)

    async def twice():
        await reader.page("united_States")
        return await reader.page("United States")

    _run(twice())
    assert sum(1 for c in fake.calls if c.get("action") == "parse") == 1


# ── Random subjects ───────────────────────────────────────────────────────────


def test_classic_draws_distinct_articles_and_honours_exclude(monkeypatch):
    monkeypatch.setattr(W, "CLASSIC", ("Abraham Lincoln", "Amazon rainforest", "World Trade Center"))
    picked = _run(Wiki(get=FakeWiki()).random_subjects("classic", 1, exclude=["Abraham Lincoln"]))
    # The disambiguation page is never drawn; Lincoln was excluded.
    assert [p.title for p in picked] == ["Amazon rainforest"]


def test_wild_skips_stubs_lists_and_disambiguation_pages():
    async def get(url, params):
        return {"query": {"pages": [
            {"title": "Tiny stub", "length": 900},
            {"title": "List of rivers", "length": 90_000},
            {"title": "Mercury", "length": 20_000, "pageprops": {"disambiguation": ""}},
            {"title": "Kara Kara National Park", "length": 8_000, "description": "Park"},
            {"title": "Henri Germain", "length": 9_000},
        ]}}

    picked = _run(Wiki(get=get).random_subjects("wild", 2))
    assert [p.title for p in picked] == ["Kara Kara National Park", "Henri Germain"]


def test_trending_drops_the_machinery_around_articles():
    async def get(url, params):
        assert url.startswith(W.PAGEVIEWS_TOP)
        return {"items": [{"articles": [
            {"article": "Main_Page"}, {"article": "Special:Search"}, {"article": "Wikipedia:Featured_pictures"},
            {"article": ".xyz"}, {"article": "Deaths_in_2026"}, {"article": "Pornhub"},
            {"article": "Star_Wars:_Episode_IV_–_A_New_Hope"}, {"article": "Lizzie_Borden"},
        ]}]}

    titles = _run(Wiki(get=get).trending())
    assert titles == ["Star Wars: Episode IV – A New Hope", "Lizzie Borden"]


def test_an_unknown_pool_is_refused():
    with pytest.raises(ValueError):
        _run(Wiki(get=FakeWiki()).random_subjects("spicy", 2))


# ── Found in review ───────────────────────────────────────────────────────────


def test_a_double_redirect_is_followed_and_a_loop_is_not():
    async def get(url, params):
        return {"query": {
            "redirects": [{"from": "Old", "to": "Middle"}, {"from": "Middle", "to": "New"},
                          {"from": "Loop A", "to": "Loop B"}, {"from": "Loop B", "to": "Loop A"}],
            "pages": [{"title": "New", "description": "the article"}, {"title": "Loop A", "missing": True}],
        }}

    out = _run(Wiki(get=get).describe(["Old", "Loop A"]))
    assert out["Old"].exists and out["Old"].title == "New"
    assert out["Loop A"].exists is False


def test_an_api_error_is_not_read_as_every_title_missing():
    async def get(url, params):
        return {"error": {"code": "maxlag", "info": "Waiting for a database server"}}

    with pytest.raises(WikiError, match="database server"):
        _run(Wiki(get=get).describe(["Abraham Lincoln"]))


def test_a_page_found_missing_is_not_fetched_again_for_a_while():
    calls = []

    async def get(url, params):
        calls.append(params["page"])
        return {"error": {"code": "missingtitle", "info": "gone"}}

    reader = Wiki(get=get)
    for _ in range(3):
        with pytest.raises(PageMissing):
            _run(reader.page("Deleted Article"))
    assert calls == ["Deleted Article"]


def test_the_targets_other_names_follow_continuation():
    asked = []

    async def get(url, params):
        asked.append(dict(params))
        if "rdcontinue" not in params:
            return {"continue": {"rdcontinue": "123|x", "continue": "||"},
                    "query": {"pages": [{"title": "T", "redirects": [{"ns": 0, "title": "A1"}]}]}}
        return {"query": {"pages": [{"title": "T", "redirects": [{"ns": 0, "title": "A2"}]}]}}

    assert _run(Wiki(get=get).redirects_to("T")) == ["A1", "A2"]
    assert asked[0]["prop"] == "redirects" and asked[1]["rdcontinue"] == "123|x"


class _Resp:
    def __init__(self, status, body=None, bad_json=False):
        self.status_code, self._body, self._bad = status, body, bad_json

    def json(self):
        if self._bad:
            raise ValueError("not json")
        return self._body


def test_a_non_json_200_is_a_wiki_error_and_no_sleep_follows_the_last_try(monkeypatch):
    responses = [_Resp(200, bad_json=True)] * 3
    slept = []

    class Client:
        async def get(self, url, params=None):
            return responses.pop(0)

    async def fake_sleep(s):
        slept.append(s)

    reader = Wiki()
    monkeypatch.setattr(reader, "_client", lambda: Client())
    monkeypatch.setattr(W.asyncio, "sleep", fake_sleep)
    with pytest.raises(WikiError, match="not JSON"):
        _run(reader._http_get(W.API, {}))
    assert len(slept) == 2  # between the three tries, not after the last
