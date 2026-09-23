"""What search engines read: each view's own <head>, the sitemap, robots.txt.

* **Every view names itself.** The page is one HTML file; the server writes the
  title, description, canonical address and structured data of the view the
  query string names, because that is the <head> Google reads.
* **One address per view.** The floor answers to `?tab=arcade` too, a single
  race or run is a replay: those point at the view they belong to, and the
  replays are kept out of the index.
* **The sitemap is every view worth a search result**, at the public address.
"""
from __future__ import annotations

import html
import json
import re
import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from wikirace import site
from wikirace.app import create_app
from wikirace.config import load_settings
from wikirace.games.registry import GAMES

BASE = "https://jev-arcade.com"


@pytest.fixture
def client(tmp_path):
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "t.db"), "WIKIRACE_CANONICAL_HOST": "jev-arcade.com"},
                             read_file=False)
    with TestClient(create_app(settings, providers={}), base_url="http://localhost") as c:
        yield c


def _head(client, query: str = "", **headers) -> dict:
    text = client.get(f"/{query}", headers=headers).text
    head = text.split("</head>")[0]

    def meta(attr: str, name: str) -> str | None:
        m = re.search(rf'<meta {attr}="{re.escape(name)}" content="([^"]*)"', head)
        return html.unescape(m.group(1)) if m else None

    ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', head, re.S)
    return {
        "text": text,
        "title": html.unescape(re.search(r"<title>(.*?)</title>", head).group(1)),
        "description": meta("name", "description"),
        "keywords": meta("name", "keywords"),
        "robots": meta("name", "robots"),
        "canonical": html.unescape(re.search(r'<link rel="canonical" href="([^"]*)"', head).group(1)),
        "og_url": meta("property", "og:url"),
        "og_title": meta("property", "og:title"),
        "ld": json.loads(ld.group(1)) if ld else None,
    }


def test_each_view_names_itself(client):
    floor = _head(client)
    assert floor["title"] == site.HUB_TITLE and floor["canonical"] == f"{BASE}/"
    assert floor["robots"].startswith("index") and "WikiRace" in floor["keywords"]
    assert floor["og_url"] == floor["canonical"] and floor["og_title"] == floor["title"]
    assert {n["@type"] for n in floor["ld"]["@graph"]} == {"WebSite", "WebApplication"}
    # Exactly one title and description: the file's own were replaced, not added to.
    assert floor["text"].count("<title>") == 1 and floor["text"].count('name="description"') == 1
    # The page still loads its versioned files.
    assert re.search(r'src="\./v/[0-9a-f]{12}/main\.js"', floor["text"])

    race = _head(client, "?tab=race")
    assert race["title"] == site.WIKIRACE_TITLE and race["canonical"] == f"{BASE}/?tab=race"
    assert _head(client, "?tab=history")["canonical"] == f"{BASE}/?tab=history"

    customs = _head(client, "?game=customs")
    assert customs["title"] == "Customs · LLM guardrails · JEV-Arcade"
    assert customs["canonical"] == f"{BASE}/?game=customs" and "LLM guardrails" in customs["keywords"]
    assert customs["description"].startswith("Every message through the scanner")
    game = next(n for n in customs["ld"]["@graph"] if n["@type"] == "VideoGame")
    assert game["name"] == "Customs" and game["url"] == f"{BASE}/?game=customs"


def test_a_replay_points_at_its_view_and_stays_out_of_the_index(client):
    race = _head(client, "?race=abc123")
    assert race["robots"].startswith("noindex") and race["canonical"] == f"{BASE}/?tab=race"
    run = _head(client, "?game=chess&run=abc123")
    assert run["robots"].startswith("noindex") and run["canonical"] == f"{BASE}/?game=chess"
    nothing = _head(client, "?game=nosuch")
    assert nothing["robots"].startswith("noindex") and nothing["canonical"] == f"{BASE}/"
    # The floor's other name, and a tracking tag, are the floor.
    for q in ("?tab=arcade", "?utm_source=news"):
        again = _head(client, q)
        assert again["canonical"] == f"{BASE}/" and again["robots"].startswith("index")


def test_a_reader_without_javascript_gets_the_words_and_every_view_linked(client):
    text = client.get("/?game=needle").text
    noscript = re.search(r"<noscript>(.*?)</noscript>", text, re.S).group(1)
    assert "<h1>Needle Hunt · line-by-line search · JEV-Arcade</h1>" in noscript
    for gid in GAMES:
        assert f'href="/?game={gid}"' in noscript
    assert 'href="/?tab=race"' in noscript


def test_the_sitemap_is_every_view_at_the_public_address(client):
    r = client.get("/sitemap.xml")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    urls = ET.fromstring(r.content).findall("s:url", ns)
    locs = [u.find("s:loc", ns).text for u in urls]
    assert locs == [f"{BASE}/", f"{BASE}/?tab=race", f"{BASE}/?tab=history",
                    *(f"{BASE}/?game={g.id}" for g in GAMES.values() if g.ready)]
    assert len(locs) == 17
    assert all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", u.find("s:lastmod", ns).text) for u in urls)


def test_robots_lets_the_page_be_crawled_and_points_at_the_sitemap(client):
    text = client.get("/robots.txt").text
    assert "Sitemap: https://jev-arcade.com/sitemap.xml" in text
    assert "Allow: /\n" in text and "Disallow: /\n" not in text


def test_without_a_public_address_the_request_says_where_it_is(tmp_path):
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "t.db")}, read_file=False)
    with TestClient(create_app(settings, providers={}), base_url="http://localhost") as c:
        assert _head(c)["canonical"] == "http://localhost/"
        assert _head(c, **{"x-forwarded-proto": "https"})["canonical"] == "https://localhost/"
        assert "Sitemap: http://localhost/sitemap.xml" in c.get("/robots.txt").text


def test_the_sites_own_files_are_served_at_its_root_after_the_pages(tmp_path):
    root = tmp_path / "site-root"
    (root / ".well-known").mkdir(parents=True)
    (root / "google0123abcd.html").write_text("google-site-verification: google0123abcd.html")
    (root / ".well-known" / "security.txt").write_text("Contact: mailto:x@example.com\n")
    (root / "styles.css").write_text("/* an impostor */")  # may not stand in for the page's own
    (tmp_path / "secret.txt").write_text("outside")
    settings = load_settings({"WIKIRACE_DB": str(tmp_path / "t.db"), "WIKIRACE_SITE_ROOT": str(root)},
                             read_file=False)
    with TestClient(create_app(settings, providers={}), base_url="http://localhost") as c:
        r = c.get("/google0123abcd.html")
        assert r.status_code == 200 and r.text == "google-site-verification: google0123abcd.html"
        assert c.get("/.well-known/security.txt").text.startswith("Contact:")
        assert "impostor" not in c.get("/styles.css").text
        assert c.get("/../secret.txt").status_code == 404 and c.get("/%2e%2e/secret.txt").status_code == 404
    # Unset, or a folder that is not there: nothing extra, and nothing breaks.
    for extra in ({}, {"WIKIRACE_SITE_ROOT": str(tmp_path / "nowhere")}):
        s = load_settings({"WIKIRACE_DB": str(tmp_path / "u.db"), **extra}, read_file=False)
        with TestClient(create_app(s, providers={}), base_url="http://localhost") as c:
            assert c.get("/google0123abcd.html").status_code == 404 and c.get("/").status_code == 200


def test_structured_data_cannot_end_its_script_early():
    # A game's description goes into its structured data as well as its tags.
    view = site.View("A </script> title", "Says </script> too", "?game=chess", game=GAMES["chess"])
    head = site.head(view, BASE)
    ld = re.search(r'<script type="application/ld\+json">(.*?)</script>', head, re.S).group(1)
    assert "</" not in ld and "Says <\\/script> too" in ld
    assert "&lt;/script&gt;" in head.split("<script")[0]
    assert json.loads(ld)["@graph"][-1]["description"] == "Says </script> too"
