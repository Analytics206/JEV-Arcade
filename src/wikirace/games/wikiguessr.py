"""WikiGuessr: where on Earth is this article? Say only as much as you're sure of.

TypeSafe's hierarchical classification with confidence rollup (its cookbooks:
hierarchical classification by beam search, K=3, and reporting at the deepest
level the confidence supports). Each round is a Wikipedia article about a
place, its introduction with every place name blacked out: the article's own
name, every country and continent (and what their people are called), the
regions of its country, and the places it links that Wikipedia puts on a map.
Every lane claims as deep as it is sure of, continent → country → region.

**Jev** answers three choices, one level at a time: the seven continents; the
countries of its three likeliest continents (the beam); the regions of its
three likeliest countries. A path's score is the geometric mean of its levels'
probabilities, and the claim is the best path. Code stops at the first level
whose confidence is under `threshold` and claims the levels before it.

**A text model** is told the scoring and answers `CONTINENT:` / `COUNTRY:` /
`REGION:` lines (`unsure`, or a line left out, is no claim there) and a
`REASON:`. A name that is not on the lists for its level is a foul.

Per round: right continent +1, country +3, region +6; the first wrong claim
−6, and nothing after it counts. The answer stays private until every lane has
claimed; then the round is revealed and the next begins.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from ..race.wiki import WikiError, article_url
from .base import Context, Game, GameInputError, GameSourceError
from .core import Picked, choice, fold, match_option, opaque, read_choice, read_field
from .players import Player, ask_jev, ask_text
from .runs import GameRun

LEVELS = ("continent", "country", "region")
#: Points for a right claim at each level, and for the first wrong one.
GAIN = (1, 3, 6)
BUST = -6
POINTS = {"continent": GAIN[0], "country": GAIN[1], "region": GAIN[2], "wrong": BUST}
#: Paths kept at each level (the cookbook's K).
BEAM = 3
ANTARCTICA = "Antarctica"
#: Level 2's extra option when Antarctica is in the beam.
NO_COUNTRY = "no country"
BLOCK = "█"
#: An introduction longer than this is cut at a sentence.
INTRO_MAX = 1400
#: Words a text model writes for "no claim here".
UNSURE = frozenset({
    "unsure", "not sure", "none", "unknown", "n/a", "na", "-", "?", "skip", "no claim",
    "no country", "no region", "not applicable",
})
#: How many pages of an article's links to read, and how many linked names to look up.
_LINK_PAGES = 3
_MAX_CANDIDATES = 50
#: Probabilities under this are left off the page's country map.
_MAP_FLOOR = 0.002

HIDDEN = (
    "Every place name in `article` is hidden behind █ blocks: the place's own name, countries, "
    "regions and cities. Judge from what the text still says: languages, landscape, climate, "
    "history, people and culture."
)
INSTRUCTIONS: dict[str, dict[str, Any]] = {
    "continent": {
        "question": "On which continent is the place that the Wikipedia article in `article` is about?",
        "rules": [HIDDEN, "Choose the continent the place is on, as each option describes it."],
    },
    "country": {
        "question": "In which country is the place that the Wikipedia article in `article` is about?",
        "rules": [HIDDEN, "Choose the country the place is in today."],
    },
    "region": {
        "question": (
            "In which first-level region of its country (a state, province, region, county, prefecture "
            "or the like) is the place that the Wikipedia article in `article` is about?"
        ),
        "rules": [HIDDEN, "Choose the region the place is in today."],
    },
}
NO_COUNTRY_RULE = f"Choose {NO_COUNTRY} only for a place in Antarctica, which no country governs."


# ── The data ──────────────────────────────────────────────────────────────────


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "wikiguessr.json", encoding="utf-8") as f:
        return json.load(f)


@cache
def continents() -> tuple[str, ...]:
    return tuple(c["name"] for c in data()["continents"])


@cache
def country_info() -> dict[str, dict[str, Any]]:
    return {c["name"]: c for c in data()["countries"]}


@cache
def countries_of(continent: str) -> tuple[str, ...]:
    return tuple(c["name"] for c in data()["countries"] if c["continent"] == continent)


@cache
def region_entries(country: str) -> tuple[tuple[str, ...], ...]:
    """A country's regions, each as (name, other names…)."""
    return tuple(tuple(x.strip() for x in r.split("|")) for r in data()["regions"].get(country, ()))


def regions_of(country: str | None) -> tuple[str, ...]:
    return tuple(r[0] for r in region_entries(country)) if country else ()


def round_by_title(title: str) -> dict[str, Any] | None:
    key = fold(title)
    return next((r for r in data()["rounds"] if fold(r["title"]) == key), None)


def truth_path(r: Mapping[str, Any]) -> list[str | None]:
    return [r["continent"], r.get("country"), r.get("region")]


# ── Names, forgivingly ────────────────────────────────────────────────────────

_TRANSLIT = str.maketrans({
    "Đ": "D", "đ": "d", "Ł": "L", "ł": "l", "Ø": "O", "ø": "o", "ı": "i", "Ħ": "H", "ħ": "h",
    "’": "'", "‘": "'", "ʼ": "'", "ʽ": "'", "ʻ": "'", "`": "'", " ": " ",
    **{c: "-" for c in "‐‑‒–—―−"},
})


def _base_char(c: str) -> str:
    t = c.translate(_TRANSLIT)
    kept = [x for x in unicodedata.normalize("NFKD", t) if not unicodedata.combining(x)]
    return kept[0] if kept else c


def base(text: str) -> str:
    """*text* with accents, dashes and apostrophes folded, one character for
    one: `Yucatán` reads `Yucatan`, and a match in it is a match in the text."""
    return "".join(_base_char(c) for c in text)


_OF_PREFIX = frozenset({"state", "province", "region", "department", "city", "county", "republic", "special"})
_GENERIC = frozenset({
    "voivodeship", "prefecture", "province", "region", "regional", "state", "county", "governorate",
    "department", "district", "oblast", "canton", "division", "territory", "municipality", "parish",
})


def place_key(name: str) -> str:
    """A key that forgives how a place is written: case, accents, dashes,
    apostrophes and the generic word (`Quang Ninh province` for `Quảng Ninh`,
    `Lesser Poland` for `Lesser Poland Voivodeship`, `Maan` for `Ma'an`)."""
    t = base(fold(name)).casefold()
    t = re.sub(r"[^\w\s-]", "", t).replace("-", " ").replace("_", " ")
    words = t.split()
    if len(words) > 2 and words[1] == "of" and words[0] in _OF_PREFIX:
        words = words[2:]
    if len(words) > 3 and words[0] == "special" and words[2] == "of":
        words = words[3:]
    if words and words[0] == "the" and len(words) > 1:
        words = words[1:]
    while len(words) > 1 and words[-1] in _GENERIC:
        words.pop()
    return " ".join(words)


def _clean_claim(claimed: str) -> list[str]:
    """What a model typed, and the forms of it worth trying: without a
    parenthesis, without what follows a comma."""
    out = [claimed]
    bare = re.sub(r"\s*\([^)]*\)\s*", " ", claimed).strip()
    if bare and bare != claimed:
        out.append(bare)
    for c in list(out):
        head = c.split(",", 1)[0].strip()
        if head and head not in out:
            out.append(head)
    return out


def match_place(claimed: str | None, entries: Sequence[Sequence[str]]) -> str | None:
    """The entry (by its first name) that *claimed* names: exactly (as
    `match_option` forgives), then by `place_key`. None: not one of them."""
    if not claimed:
        return None
    by_name = {alias: e[0] for e in entries for alias in e}
    forms = _clean_claim(claimed)
    for form in forms:
        hit = match_option(form, list(by_name))
        if hit is not None:
            return by_name[hit]
    keys: dict[str, str] = {}
    for e in entries:
        for alias in e:
            keys.setdefault(place_key(alias), e[0])
    for form in forms:
        k = place_key(form)
        if k and k in keys:
            return keys[k]
    return None


@cache
def continent_entries() -> tuple[tuple[str, ...], ...]:
    return tuple((c,) for c in continents())


@cache
def country_entries() -> tuple[tuple[str, ...], ...]:
    return tuple((c["name"], *c.get("aka", ())) for c in data()["countries"])


# ── Redaction ─────────────────────────────────────────────────────────────────

#: Title words too common to hide on their own (the whole title still is).
_TITLE_STOP = frozenset({
    "the", "of", "and", "de", "del", "la", "le", "les", "du", "des", "da", "do", "dos", "das", "di",
    "der", "den", "die", "ob", "am", "an", "im", "in", "sur", "en", "von", "van", "al", "el", "on", "at",
    "mount", "mountain", "lake", "loch", "river", "bay", "island", "islands", "national", "park", "city",
    "town", "village", "castle", "shrine", "temple", "cathedral", "church", "falls", "valley", "volcano",
    "desert", "forest", "great", "old", "new", "north", "south", "east", "west", "upper", "lower",
    "saint", "san", "santa", "st", "crater",
})
#: What a stripped region name must not be reduced to.
_TOO_PLAIN = frozenset({
    "central", "eastern", "western", "northern", "southern", "north", "south", "east", "west",
    "capital", "federal", "free", "north western", "north central", "national capital",
})
#: A linked place whose description starts like this is a feature of the land,
#: not a name of the hierarchy: left as a clue.
_NATURAL = re.compile(
    r"\b(river|stream|mountain|mountains|mount|peak|volcano|lake|sea|ocean|bay|gulf|strait|channel|"
    r"glacier|desert|forest|plateau|valley|canyon|gorge|cave|waterfall|range|massif|island|islands|"
    r"archipelago|peninsula|cape|reef|lagoon|swamp|marsh|wetland|delta|plain|hill|hills|ridge|pan|"
    r"caldera|crater|salt flat|basin)\b",
    re.I,
)


def _pattern(name: str, prefix: bool = False) -> str:
    return r"(?<!\w)" + re.escape(base(name)) + (r"\w*" if prefix else "") + r"(?!\w)"


def redact(text: str, names: Iterable[str], prefixes: Iterable[str] = ()) -> tuple[str, int]:
    """*text* with every one of *names* (and every word starting with one of
    *prefixes*) blacked out, a block per character, so the page can show
    where and how long. Accents, dashes and apostrophes forgiven; case not
    (a name is a proper noun: `Turkey` hides, `turkey` stays). Returns the
    text and how many names it hid."""
    items = {(n, False) for n in names if n and len(n.strip()) > 1}
    items |= {(p, True) for p in prefixes if p and len(p) > 2}
    if not items or not text:
        return text, 0
    ordered = sorted(items, key=lambda x: (-len(x[0]), x[0]))
    rx = re.compile("|".join(_pattern(n, pre) for n, pre in ordered))
    out = list(text)
    count = 0
    for m in rx.finditer(base(text)):
        s, e = m.span()
        if e <= s:
            continue
        count += 1
        for k in range(s, e):
            out[k] = BLOCK
    return "".join(out), count


def core_name(title: str) -> str:
    """A title without its disambiguator: `Toledo, Spain` → `Toledo`,
    `Bolívar (state)` → `Bolívar`."""
    t = re.sub(r"\s*\([^)]*\)\s*$", "", title).strip()
    return t.split(",", 1)[0].strip()


def title_names(title: str) -> tuple[list[str], list[str]]:
    """What to hide of an article's own title: (names, word prefixes)."""
    full = re.sub(r"\s*\([^)]*\)\s*", " ", title).strip()
    names = [title, full, core_name(title)]
    words = [w for w in re.split(r"[\s,/()]+", full) if w]
    core = core_name(title).split()
    while core and core[0].casefold() in _TITLE_STOP:
        core = core[1:]
    while core and core[-1].casefold() in _TITLE_STOP:
        core = core[:-1]
    if core:
        names.append(" ".join(core))
    prefixes = []
    for w in words:
        for part in {w, *w.split("-")}:
            if len(part) < 3 or part.casefold() in _TITLE_STOP:
                continue
            (prefixes if len(part) >= 5 else names).append(part)
    return list(dict.fromkeys(names)), list(dict.fromkeys(prefixes))


def _stripped(name: str) -> str | None:
    """A region's name without its generic word (`Hiroshima Prefecture` →
    `Hiroshima`), when that still names it."""
    words = name.split()
    if len(words) > 2 and words[1] == "of" and words[0].casefold() in _OF_PREFIX:
        words = words[2:]
    while len(words) > 1 and words[-1].casefold() in _GENERIC:
        words = words[:-1]
    t = " ".join(words)
    if t == name or len(t) < 3 or t.casefold() in _TOO_PLAIN:
        return None
    return t


@cache
def world_names() -> tuple[str, ...]:
    """Every name of the hierarchy hidden in every article: continents,
    countries, their other names and their peoples."""
    out: list[str] = []
    for c in [*data()["continents"], *data()["countries"]]:
        adj = list(c.get("adj", ()))
        out += [c["name"], *c.get("aka", ()), *adj, *(a + "s" for a in adj if not a.endswith(("s", "sh", "ese", "ch")))]
    return tuple(dict.fromkeys(out))


@cache
def country_names(country: str | None) -> tuple[str, ...]:
    """The names of a country's regions (and what their people are called)."""
    if not country:
        return ()
    adj = data().get("region_adj", {})
    out: list[str] = []
    for entry in region_entries(country):
        for alias in entry:
            out.append(alias)
            s = _stripped(alias)
            if s:
                out.append(s)
        out += adj.get(entry[0], [])
    return tuple(dict.fromkeys(out))


@cache
def known_names() -> frozenset[str]:
    """Names already hidden by the lists, whatever the round: no need to ask
    Wikipedia about them."""
    out = {fold(n) for n in world_names()}
    for country in data()["regions"]:
        out |= {fold(n) for n in country_names(country)}
    return frozenset(out)


def trim_intro(text: str, limit: int = INTRO_MAX) -> str:
    """An introduction as the round shows it: paragraphs kept, blank lines and
    runs of spaces gone, cut at a sentence past *limit*."""
    text = unicodedata.normalize("NFC", text or "")
    paras = [" ".join(p.split()) for p in text.splitlines()]
    out = "\n".join(p for p in paras if p)
    if len(out) <= limit:
        return out
    cut = out[:limit]
    end = max(cut.rfind(". "), cut.rfind(".\n"), cut.rfind("? "), cut.rfind("! "))
    return cut[: end + 1] if end >= limit // 3 else cut.rstrip() + "…"


def is_place(info: Mapping[str, Any] | None) -> bool:
    """Whether a linked page is a place to hide: on a map, and not a feature of
    the land (a river, a mountain, a lake), which stays as a clue."""
    if not info or not info.get("coordinates"):
        return False
    desc = str(info.get("description") or "")
    head = re.split(r"\s(?:in|of|on|near|at|between)\s|,", desc, maxsplit=1)[0]
    return not _NATURAL.search(head)


def build_round(entry: Mapping[str, Any], intro: str, places: Sequence[str] = ()) -> dict[str, Any]:
    """A round: the article's introduction with its places hidden, and the
    answer (private until the reveal)."""
    names, prefixes = title_names(entry["title"])
    hidden = [*world_names(), *country_names(entry.get("country")), *names, *places]
    article, blocks = redact(trim_intro(intro), hidden, prefixes)
    return {
        "title": entry["title"], "article": article, "blocks": blocks,
        "truth": {
            "title": entry["title"], "url": article_url(entry["title"]),
            "continent": entry["continent"], "country": entry.get("country"), "region": entry.get("region"),
        },
    }


# ── Reading Wikipedia ─────────────────────────────────────────────────────────


async def _query(ctx: Context, params: dict[str, Any]) -> dict[str, Any]:
    try:
        body = await ctx.wiki.query(params)
    except WikiError as exc:
        raise GameSourceError(f"Wikipedia did not answer: {exc}") from exc
    if not isinstance(body, dict):
        raise GameSourceError("Wikipedia answered with something unexpected")
    err = body.get("error")
    if isinstance(err, dict):
        raise GameSourceError(f"Wikipedia: {err.get('info') or err.get('code') or 'an API error'}")
    return body


def _resolver(q: Mapping[str, Any]) -> dict[str, str]:
    """{title asked: title answered}, through normalisation and redirects."""
    hop = {n["from"]: n["to"] for n in q.get("normalized") or []}
    hop |= {r["from"]: r["to"] for r in q.get("redirects") or []}

    def follow(t: str) -> str:
        seen = set()
        while t in hop and t not in seen:
            seen.add(t)
            t = hop[t]
        return t
    return {t: follow(t) for t in hop}


async def fetch_intros(ctx: Context, titles: Sequence[str]) -> dict[str, str]:
    """{title: plain-text introduction}, in one request (at most 20 titles)."""
    body = await _query(ctx, {
        "action": "query", "prop": "extracts", "exintro": 1, "explaintext": 1, "exlimit": 20,
        "redirects": 1, "titles": "|".join(titles),
    })
    q = body.get("query") or {}
    to = _resolver(q)
    pages = {p.get("title"): p for p in q.get("pages") or [] if isinstance(p, dict)}
    out = {}
    for t in titles:
        page = pages.get(to.get(t, t))
        text = (page or {}).get("extract")
        if isinstance(text, str) and text.strip():
            out[t] = text
    return out


async def _links(ctx: Context, title: str) -> list[str]:
    params: dict[str, Any] = {
        "action": "query", "prop": "links", "titles": title, "plnamespace": 0, "pllimit": "max",
    }
    out: list[str] = []
    for _ in range(_LINK_PAGES):
        body = await _query(ctx, params)
        for page in (body.get("query") or {}).get("pages") or []:
            out += [ln["title"] for ln in page.get("links") or [] if isinstance(ln.get("title"), str)]
        cont = body.get("continue")
        if not isinstance(cont, dict) or "plcontinue" not in cont:
            break
        params = {**params, **cont}
    return out


async def linked_places(ctx: Context, rounds: Sequence[tuple[Mapping[str, Any], str]]) -> list[list[str]]:
    """For each (entry, intro): the names of the places it links that appear in
    its introduction (settlements, districts, landmarks: anything Wikipedia
    maps that is not a feature of the land)."""
    link_lists = await asyncio.gather(*(_links(ctx, entry["title"]) for entry, _ in rounds))
    known = known_names()
    per_round: list[list[str]] = []
    for (_, intro), links in zip(rounds, link_lists, strict=True):
        b = base(trim_intro(intro))
        found = []
        for t in dict.fromkeys(links):
            core = core_name(t)
            if len(core) < 3 or fold(core) in known:
                continue
            if re.search(_pattern(core), b):
                found.append(t)
        per_round.append(found[:_MAX_CANDIDATES])
    asked = list(dict.fromkeys(t for found in per_round for t in found))
    info: dict[str, dict[str, Any]] = {}
    for i in range(0, len(asked), 50):
        batch = asked[i:i + 50]
        body = await _query(ctx, {
            "action": "query", "prop": "coordinates|description", "colimit": "max", "redirects": 1,
            "titles": "|".join(batch),
        })
        q = body.get("query") or {}
        to = _resolver(q)
        pages = {p.get("title"): p for p in q.get("pages") or [] if isinstance(p, dict)}
        for t in batch:
            page = pages.get(to.get(t, t))
            if page and not page.get("missing"):
                info[t] = page
    return [[core_name(t) for t in found if is_place(info.get(t))] for found in per_round]


# ── Jev ───────────────────────────────────────────────────────────────────────


def continent_desc(name: str) -> str:
    gloss = next((c["gloss"] for c in data()["continents"] if c["name"] == name), "")
    return f"{name}: {gloss}" if gloss else name


def country_desc(key: str, continent: str) -> str:
    if key == NO_COUNTRY:
        return f"{NO_COUNTRY}: the place is in Antarctica, which no country governs"
    return f"{key} ({continent})"


def rank_paths(products: Mapping[tuple[Any, ...], float]) -> list[tuple[tuple[Any, ...], float]]:
    """Paths by score, best first: the geometric mean of the probabilities
    along each (the product's root), as the cookbook ranks a beam."""
    scored = [
        (path, (max(0.0, prod) ** (1 / len(path))) if path else 0.0)
        for path, prod in products.items()
    ]
    scored.sort(key=lambda kv: -kv[1])
    return scored


def _paths_public(paths: Sequence[tuple[tuple[Any, ...], float]]) -> list[dict[str, Any]]:
    return [{"path": [x for x in path if x is not None], "score": round(score, 4)} for path, score in paths]


def _level(level: int, pick: Picked, options: int, paths: Sequence[tuple[tuple[Any, ...], float]],
           top: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "level": level, "confidence": round(pick.confidence, 4), "options": options, "top": top,
        "paths": _paths_public(paths), **extra,
    }


# ── Text models ───────────────────────────────────────────────────────────────


@cache
def text_system() -> str:
    glosses = "\n".join(f"- {c['name']}: {c['gloss']}" for c in data()["continents"])
    by = "\n".join(f"{c}: {', '.join(countries_of(c))}" for c in continents() if countries_of(c))
    return (
        "You are playing WikiGuessr. You are shown the introduction of a Wikipedia article about a place on "
        "Earth, with every place name in it blacked out as █ blocks: the place's own name, countries, regions "
        "and cities. Say where the place is, as deep as you are sure of: its continent, then its country, then "
        "its region (the country's first-level division: a state, province, region, county, prefecture or the "
        "like).\n\n"
        "Scoring, per article:\n"
        "- the right continent +1, the right country +3, the right region +6\n"
        "- the first wrong claim costs 6 points, and nothing after it counts\n"
        "- a line you leave out, or answer `unsure`, is no claim, and nothing after it counts\n"
        "A wrong region costs more than a right one earns: claim a level only when you are sure of it.\n\n"
        f"The continents (use exactly these names):\n{glosses}\n"
        "Antarctica has no countries: for a place there, stop at the continent.\n\n"
        f"The countries, by continent (use exactly these names):\n{by}\n\n"
        "A continent or country that is not on these lists, or a region that is not a first-level region of "
        "the country you named, is a foul: no claim there, and nothing after it counts.\n\n"
        "Reply with exactly these four lines and nothing else:\n"
        "CONTINENT: <a continent, or unsure>\n"
        "COUNTRY: <a country, or unsure>\n"
        "REGION: <a first-level region of that country, or unsure>\n"
        "REASON: <one short sentence: the clues you went by>"
    )


def read_claim(reply: str | None) -> dict[str, Any]:
    """A text model's reply as a claim: the names it gave, matched level by
    level, stopping at the first level it left out, was unsure of, or fouled."""
    said = {lvl: read_field(reply, lvl.upper()) for lvl in LEVELS}
    claim: list[str] = []
    fouls: list[str] = []
    for k, lvl in enumerate(LEVELS):
        v = said[lvl]
        if v is None or fold(v) in UNSURE:
            break
        if k == 0:
            hit = match_place(v, continent_entries())
        elif k == 1:
            hit = match_place(v, country_entries())
        else:
            entries = region_entries(claim[1])
            if not entries:
                break  # a country with no regions on the lists: never the answer, so nothing to judge
            hit = match_place(v, entries)
        if hit is None:
            fouls.append(lvl)
            break
        claim.append(hit)
    return {
        "said": {k: (v[:80] if v else None) for k, v in said.items()},
        "reason": (read_field(reply, "REASON") or "")[:240] or None,
        "claim": claim, "fouls": fouls,
    }


# ── Scoring ───────────────────────────────────────────────────────────────────


def points(claim: Sequence[str], truth: Mapping[str, Any]) -> tuple[int, list[str]]:
    """(points, a mark per claimed level): right levels earn, the first wrong
    one costs, and nothing after it counts."""
    gold = truth_path(truth)
    total, marks = 0, []
    for k, name in enumerate(claim[:3]):
        if name == gold[k]:
            total += GAIN[k]
            marks.append("right")
        else:
            total += BUST
            marks.append("wrong")
            break
    return total, marks


# ── The game ──────────────────────────────────────────────────────────────────


class Params(BaseModel):
    rounds: int = Field(default=3, ge=1, le=5, description="articles, one a round")
    threshold: float = Field(default=0.5, ge=0.05, le=0.95,
                             description="Jev claims a level only when its confidence is at least this")
    title: str | None = Field(default=None, max_length=200,
                              description="play this article first (one of the game's list)")
    seed: int | None = Field(default=None, description="the same seed draws the same articles")
    pause_ms: int = Field(default=2500, ge=0, le=15_000,
                          description="the reveal stays up this long before the next round")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    pool = list(data()["rounds"])
    first = None
    if p.title:
        first = round_by_title(p.title)
        if first is None:
            raise GameInputError(f"“{p.title}” is not one of WikiGuessr's articles")
    rest = [r for r in pool if r is not first]
    random.Random(p.seed).shuffle(rest)
    # A few spares, drawn in the same request, for an article with no introduction.
    spares = min(len(rest), p.rounds + 3 - (1 if first else 0))
    candidates = ([first] if first else []) + rest[:spares]
    intros = await fetch_intros(ctx, [c["title"] for c in candidates])
    if first is not None and first["title"] not in intros:
        raise GameSourceError(f"Wikipedia gave no introduction for “{first['title']}”")
    chosen = [(c, intros[c["title"]]) for c in candidates if c["title"] in intros][: p.rounds]
    if len(chosen) < p.rounds:
        raise GameSourceError("Wikipedia gave too few introductions for this game")
    places = await linked_places(ctx, chosen)
    ctx.private["rounds"] = [build_round(c, text, found) for (c, text), found in zip(chosen, places, strict=True)]
    return {
        "rounds": [], "total": len(chosen), "round": None, "threshold": p.threshold, "points": POINTS,
        "beam": BEAM,
        "continents": [{"name": c["name"], "grid": c["grid"]} for c in data()["continents"]],
        "map": [[c["name"], c["code"], c["continent"], *c["tile"]] for c in data()["countries"]],
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    rounds: list[dict[str, Any]] = ctx.private["rounds"]
    n = len(rounds)
    opened = [asyncio.Event() for _ in range(n)]
    closed = [asyncio.Event() for _ in range(n)]
    arrived: list[set[int]] = [set() for _ in range(n)]
    revealed: set[int] = set()
    live = {pl.index for pl in ctx.players}
    claims: dict[tuple[int, int], list[str]] = {}
    system = text_system()
    for i in range(len(ctx.players)):
        run.lane(i, score=0, busts=0, played=0)

    def public(k: int) -> dict[str, Any]:
        r = rounds[k]
        return {"n": k, "article": r["article"], "blocks": r["blocks"], "answer": None, "results": None}

    def check(k: int) -> None:
        if opened[k].is_set() and not closed[k].is_set() and live <= arrived[k]:
            closed[k].set()

    def reveal(k: int) -> None:
        revealed.add(k)
        truth = rounds[k]["truth"]
        results = []
        for pl in ctx.players:
            claim = claims.get((pl.index, k))
            if claim is None:
                continue
            pts, marks = points(claim, truth)
            results.append({"lane": pl.index, "claim": claim, "points": pts, "marks": marks})
            ln = run.state["lanes"][pl.index]
            run.lane(pl.index, score=ln["score"] + pts, busts=ln["busts"] + ("wrong" in marks),
                     played=ln["played"] + 1)
        run.put("rounds", k, {**public(k), "answer": truth, "results": results})

    async def jev_round(pl: Player, k: int) -> list[str]:
        i, thr = pl.index, p.threshold
        state = {"article": rounds[k]["article"]}
        levels: list[dict[str, Any]] = []
        ms = 0
        stopped: int | None = None
        claim: list[str] = []

        async def ask(level: str, options: dict[str, str], prefix: str, rules: list[str] | None = None):
            nonlocal ms
            ids = opaque(list(options), f"wikiguessr|{run.id}|{k}|{level}", prefix=prefix)
            instr = INSTRUCTIONS[level] if rules is None else {**INSTRUCTIONS[level], "rules": rules}
            q = choice(instr, {oid: options[key] for oid, key in ids.items()})
            asked = await ask_jev(pl, state, {level: q}, on_wait=run.waiting(i))
            run.account(i, asked)
            ms += asked.latency_ms
            return read_choice(asked.answers[level], ids)

        # Level 1: the continents.
        pick1 = await ask("continent", {c: continent_desc(c) for c in continents()}, "c")
        p1 = dict(pick1.ranked)
        paths1 = rank_paths({(c,): p1[c] for c in continents()})
        levels.append(_level(1, pick1, len(p1), paths1[:BEAM], [{"option": o, "p": round(v, 4)} for o, v in pick1.ranked]))
        if pick1.confidence < thr:
            stopped = 1
        else:
            claim = [paths1[0][0][0]]
            # Level 2: the countries of the beam's continents.
            of: dict[str, str] = {}
            for (cont,), _ in paths1[:BEAM]:
                of.update({name: cont for name in countries_of(cont)})
                if cont == ANTARCTICA:
                    of[NO_COUNTRY] = ANTARCTICA
            if len(of) >= 2:
                rules = INSTRUCTIONS["country"]["rules"] + ([NO_COUNTRY_RULE] if NO_COUNTRY in of else [])
                pick2 = await ask("country", {key: country_desc(key, of[key]) for key in of}, "n", rules)
                p2 = dict(pick2.ranked)
                paths2 = rank_paths({(of[key], None if key == NO_COUNTRY else key): p1[of[key]] * p2[key] for key in of})
                levels.append(_level(
                    2, pick2, len(p2), paths2[:BEAM], pick2.top(8),
                    map={key: round(v, 4) for key, v in pick2.ranked if v >= _MAP_FLOOR and key != NO_COUNTRY},
                ))
                if pick2.confidence < thr:
                    stopped = 2
                elif paths2[0][0][1] is None:
                    claim = [paths2[0][0][0]]  # Antarctica: no country to claim
                else:
                    claim = list(paths2[0][0])
                    # Level 3: the regions of the beam's countries.
                    reg: dict[str, tuple[str, str, str]] = {}
                    for (cont, country), _ in paths2[:BEAM]:
                        for r in regions_of(country):
                            reg[f"{country}|{r}"] = (cont, country, r)
                    if len(reg) >= 2:
                        pick3 = await ask("region", {key: f"{v[2]} (a region of {v[1]})" for key, v in reg.items()}, "r")
                        p3 = dict(pick3.ranked)
                        paths3 = rank_paths({v: p1[v[0]] * p2[v[1]] * p3[key] for key, v in reg.items()})
                        top3 = [{"option": reg[key][2], "country": reg[key][1], "p": round(v, 4)}
                                for key, v in pick3.ranked[:8]]
                        levels.append(_level(3, pick3, len(p3), paths3[:BEAM], top3))
                        if pick3.confidence < thr:
                            stopped = 3
                        else:
                            claim = list(paths3[0][0])
        run.lane_push(i, "claims", {
            "round": k, "kind": "jev", "levels": levels, "claim": claim, "stopped_at": stopped, "ms": ms,
        })
        return claim

    async def text_round(pl: Player, k: int) -> list[str]:
        i = pl.index
        said = await ask_text(pl, system, f"ARTICLE:\n{rounds[k]['article']}", on_wait=run.waiting(i))
        c = read_claim(said.text)
        ln = run.state["lanes"][i]
        run.account(i, said, **({"fouls": ln["fouls"] + len(c["fouls"])} if c["fouls"] else {}))
        run.lane_push(i, "claims", {"round": k, "kind": "text", **c, "ms": said.latency_ms})
        return c["claim"]

    async def conductor() -> None:
        for k in range(n):
            if not live:
                return
            if k and p.pause_ms:
                await asyncio.sleep(p.pause_ms / 1000)
                if not live:
                    return
            run.push("rounds", public(k))
            run.patch(round=k)
            opened[k].set()
            check(k)
            await closed[k].wait()
            reveal(k)

    async def lane(pl: Player) -> None:
        try:
            for k in range(n):
                await opened[k].wait()
                claims[(pl.index, k)] = await (jev_round if pl.is_jev else text_round)(pl, k)
                arrived[k].add(pl.index)
                check(k)
        finally:
            live.discard(pl.index)
            for k in range(n):
                check(k)

    lead = asyncio.ensure_future(conductor())
    players = asyncio.ensure_future(run.each_lane(lane))
    try:
        # Both to the end; but a conductor that fails must not leave the lanes
        # waiting for a round that never opens.
        await asyncio.wait({lead, players}, return_when=asyncio.FIRST_EXCEPTION)
        if lead.done() and not lead.cancelled() and lead.exception() is not None:
            raise lead.exception()
        await players
        await lead
    finally:
        for t in (lead, players):
            if not t.done():
                t.cancel()
        await asyncio.gather(lead, players, return_exceptions=True)
        for k in range(n):
            if opened[k].is_set() and k not in revealed:
                reveal(k)


GAME = Game(
    id="wikiguessr", title="WikiGuessr",
    tagline="Where on Earth is this article? Say only as much as you're sure of",
    use_case="hierarchical classification", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
