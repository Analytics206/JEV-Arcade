"""What search engines read: each view's title, description, keywords and
canonical address, its sharing cards and structured data, and the sitemap
and robots.txt that list the views.

The page is one HTML file whose views are named by the query string
(static/games/route.js). Google renders its JavaScript, but reads the <head>
as the server sends it, so the server writes each view's own there. The
titles match what the page sets as it moves between views (shell.js, app.js).

A single race or a single game run is left out of the index (`noindex`,
pointing at the view it belongs to): thousands of replays would crowd out
the pages that say what the arcade is.
"""
from __future__ import annotations

import html
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date
from xml.sax.saxutils import escape as xml_escape

from .games.base import Game
from .games.registry import GAMES

SITE = "JEV-Arcade"
REPO_URL = "https://github.com/Analytics206/JEV-Arcade"

HUB_TITLE = "JEV-Arcade · AI games: Jev vs. text models, live"
HUB_DESCRIPTION = (
    "Fifteen live AI games pitting Jev, a judgment model, against conventional LLMs: WikiRace across "
    "Wikipedia, chess puzzles, guardrails, function calling and more. Free and open source."
)
WIKIRACE_TITLE = "WikiRace · AI models race across Wikipedia · JEV-Arcade"
WIKIRACE_DESCRIPTION = (
    "Watch AI models race across Wikipedia link by link, live. Jev scores every link while text models "
    "name one; every hop, cheat and cost is shown. First to the target wins."
)
HISTORY_TITLE = "WikiRace Hall of Fame · JEV-Arcade"
HISTORY_DESCRIPTION = (
    "Every WikiRace on JEV-Arcade: which AI model reached the target first, in how many hops, and what "
    "it cost. Replay any race move by move."
)
KEYWORDS = (
    "JEV-Arcade", "Jev", "TypeSafe", "judgment model", "AI games", "LLM games", "AI arcade", "WikiRace",
    "Wikipedia game", "AI model comparison", "LLM benchmark", "AI evaluation", "LLM guardrails",
    "function calling", "model routing", "structured output", "AI chess puzzles", "GPT", "Claude",
    "OpenRouter", "open source",
)

_GAME_ID = re.compile(r"[a-z][a-z0-9]{1,23}")
_SEO_BLOCK = re.compile(r"<!-- seo -->.*?<!-- /seo -->", re.S)
_NOSCRIPT = re.compile(r"<noscript>.*?</noscript>", re.S)


@dataclass(frozen=True)
class View:
    """One view, as a search engine should know it."""

    title: str
    description: str
    #: The canonical query string: "" (the floor), "?tab=race", "?game=chess".
    query: str
    index: bool = True
    game: Game | None = None


def game_title(game: Game) -> str:
    return f"{game.title} · {game.use_case} · {SITE}"


def game_description(game: Game) -> str:
    return (
        f"{game.tagline.rstrip('.')}. {game.title} is a free JEV-Arcade game: watch Jev, a judgment model, "
        f"and text models play it live, a hands-on demo of {game.use_case}."
    )


def _game_view(game: Game, *, index: bool = True) -> View:
    return View(game_title(game), game_description(game), f"?game={game.id}", index=index, game=game)


HUB = View(HUB_TITLE, HUB_DESCRIPTION, "")
WIKIRACE = View(WIKIRACE_TITLE, WIKIRACE_DESCRIPTION, "?tab=race")
HISTORY = View(HISTORY_TITLE, HISTORY_DESCRIPTION, "?tab=history")


def view_of(query: Mapping[str, str]) -> View:
    """The view a query string names, read the way route.js reads it."""
    gid = query.get("game") or ""
    if _GAME_ID.fullmatch(gid):
        game = GAMES.get(gid)
        if game is None or not game.ready:
            return View(HUB_TITLE, HUB_DESCRIPTION, "", index=False)
        return _game_view(game, index=not query.get("run"))
    if query.get("race"):
        return View(WIKIRACE_TITLE, WIKIRACE_DESCRIPTION, "?tab=race", index=False)
    tab = query.get("tab")
    if tab == "race":
        return WIKIRACE
    if tab == "history":
        return HISTORY
    # The floor, under whatever else it answers to (?tab=arcade, a tracking
    # tag): its canonical address says which one to show.
    return HUB


def indexed_views() -> list[View]:
    """Every view worth a search result, in the floor's order."""
    return [HUB, WIKIRACE, HISTORY, *(_game_view(g) for g in GAMES.values() if g.ready)]


def _attr(s: str) -> str:
    return html.escape(s, quote=True)


def _json_ld(view: View, base: str, url: str) -> str:
    graph: list[dict[str, object]] = [
        {
            "@type": "WebSite", "@id": f"{base}/#website", "url": f"{base}/", "name": SITE,
            "description": HUB_DESCRIPTION, "inLanguage": "en",
        },
        {
            "@type": "WebApplication", "@id": f"{base}/#app", "name": SITE, "url": f"{base}/",
            "description": HUB_DESCRIPTION, "applicationCategory": "GameApplication",
            "operatingSystem": "Any", "browserRequirements": "Requires JavaScript",
            "isAccessibleForFree": True, "offers": {"@type": "Offer", "price": "0", "priceCurrency": "USD"},
            "sameAs": [REPO_URL],
        },
    ]
    if view.game is not None:
        graph.append({
            "@type": "VideoGame", "@id": f"{url}#game", "name": view.game.title, "url": url,
            "description": view.description, "genre": ["AI demo", view.game.use_case],
            "gamePlatform": "Web browser", "applicationCategory": "GameApplication", "operatingSystem": "Any",
            "isAccessibleForFree": True, "isPartOf": {"@id": f"{base}/#website"},
        })
    # `</` would end the script element early.
    return json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False).replace("</", "<\\/")


def head(view: View, base: str) -> str:
    """The <head> tags for *view*, on a site whose address is *base*
    (`https://jev-arcade.com`, no trailing slash)."""
    url = f"{base}/{view.query}"
    keywords = [*KEYWORDS, *((view.game.title, view.game.use_case) if view.game else ())]
    a = _attr
    return "\n    ".join([
        f"<title>{html.escape(view.title)}</title>",
        f'<meta name="description" content="{a(view.description)}" />',
        f'<meta name="keywords" content="{a(", ".join(keywords))}" />',
        f'<meta name="robots" content="{"index, follow, max-image-preview:large" if view.index else "noindex, follow"}" />',
        f'<link rel="canonical" href="{a(url)}" />',
        f'<meta name="application-name" content="{SITE}" />',
        '<meta property="og:type" content="website" />',
        f'<meta property="og:site_name" content="{SITE}" />',
        f'<meta property="og:title" content="{a(view.title)}" />',
        f'<meta property="og:description" content="{a(view.description)}" />',
        f'<meta property="og:url" content="{a(url)}" />',
        '<meta property="og:locale" content="en_US" />',
        '<meta name="twitter:card" content="summary" />',
        f'<meta name="twitter:title" content="{a(view.title)}" />',
        f'<meta name="twitter:description" content="{a(view.description)}" />',
        f'<script type="application/ld+json">{_json_ld(view, base, url)}</script>',
    ])


def _noscript(view: View) -> str:
    """For a reader that runs no JavaScript: what this is, and every view, linked."""
    items = "".join(
        f'<li><a href="/{html.escape(v.query, quote=True)}">{html.escape(v.title.removesuffix(f" · {SITE}"))}</a>'
        f" — {html.escape(v.description)}</li>"
        for v in indexed_views()
    )
    return (
        '<noscript><main style="padding: 16px">'
        f"<h1>{html.escape(view.title)}</h1><p>{html.escape(view.description)}</p>"
        "<p>JEV-Arcade runs in the browser, so it needs JavaScript.</p>"
        f"<ul>{items}</ul></main></noscript>"
    )


def render(index_html: str, query: Mapping[str, str], base: str) -> str:
    """index.html for the view *query* names: its own head, and its own
    words for a reader without JavaScript."""
    view = view_of(query)
    out = _SEO_BLOCK.sub(lambda _: head(view, base), index_html, count=1)
    return _NOSCRIPT.sub(lambda _: _noscript(view), out, count=1)


def sitemap(base: str, lastmod: date) -> str:
    """Every indexed view, for Google Search Console and the rest."""
    urls = "".join(
        f"  <url><loc>{xml_escape(f'{base}/{v.query}')}</loc><lastmod>{lastmod.isoformat()}</lastmod></url>\n"
        for v in indexed_views()
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f"{urls}</urlset>\n"
    )


def robots(base: str) -> str:
    """Everything may be crawled, the API included: Google renders the page,
    and the page reads the API. Only its self-description is left out."""
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/docs\n"
        "Disallow: /api/openapi.json\n"
        f"\nSitemap: {base}/sitemap.xml\n"
    )
