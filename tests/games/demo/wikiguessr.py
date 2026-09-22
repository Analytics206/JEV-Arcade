"""WikiGuessr's stand-in players. They need the answer the page must not see:
the demo keeps it by wrapping the game's `build_round` (the answer of every
round it deals, by its redacted article). Test code only.

Jev is usually right and sure at the continent and the country, and right but
unsure at the region, so it mostly stops at the country. The text models are
usually right to the country, then over-claim a wrong region some of the time,
say `unsure` some of the time, and now and then name something that is not on
the lists."""
from __future__ import annotations

import random
from typing import Any

from wikirace.games import wikiguessr as W

from . import choice, spread

#: {redacted article: the round's answer}, filled as rounds are dealt.
KNOWN: dict[str, dict[str, Any]] = {}
_build = W.build_round


def _remember(*args: Any, **kw: Any) -> dict[str, Any]:
    r = _build(*args, **kw)
    KNOWN[r["article"]] = r["truth"]
    return r


W.build_round = _remember


def _find(crit: dict[str, Any], test) -> str | None:
    return next((o for o, d in crit.items() if test(str(d))), None)


def jev(qid, q, state):
    if not isinstance(state, dict) or set(state) != {"article"} or qid not in W.LEVELS:
        return None
    truth = KNOWN.get(state["article"])
    crit = q["criteria"]
    ids = list(crit)
    if truth is None:
        return choice(spread(random.choice(ids), ids, random.uniform(0.3, 0.6)))
    if qid == "continent":
        right = _find(crit, lambda d: d.startswith(truth["continent"] + ":"))
        best = right if random.random() < 0.92 else random.choice(ids)
        return choice(spread(best, ids, random.uniform(0.7, 0.96)))
    if qid == "country":
        name = truth["country"] or W.NO_COUNTRY
        right = _find(crit, lambda d: d.startswith(f"{name} (") or d.startswith(f"{name}:"))
        if right is None or random.random() < 0.12:
            same = [o for o, d in crit.items() if d.endswith(f"({truth['continent']})")]
            right = random.choice(same or ids)
        return choice(spread(right, ids, random.uniform(0.55, 0.9)))
    right = _find(crit, lambda d: d == f"{truth['region']} (a region of {truth['country']})")
    if right is None or random.random() < 0.35:
        right = random.choice(ids)
    return choice(spread(right, ids, random.uniform(0.2, 0.55)))


def text(model, system, prompt):
    if "WikiGuessr" not in system or "ARTICLE:\n" not in prompt:
        return None
    truth = KNOWN.get(prompt.split("ARTICLE:\n", 1)[1])
    if truth is None:
        return "CONTINENT: Europe\nCOUNTRY: unsure\nREGION: unsure\nREASON: Too little to go on."
    roll = random.random()
    if roll < 0.05:
        return "CONTINENT: the Americas\nCOUNTRY: unsure\nREGION: unsure\nREASON: It reads like the New World."
    continent = truth["continent"]
    country = truth["country"]
    if country is None:
        return f"CONTINENT: {continent}\nCOUNTRY: unsure\nREGION: unsure\nREASON: Ice, a research station and no people."
    if random.random() < 0.18:
        country = random.choice([c for c in W.countries_of(continent) if c != country] or [country])
    regions = W.regions_of(country)
    r = random.random()
    if regions and r < 0.45:
        region = truth["region"] if country == truth["country"] else random.choice(regions)
    elif regions and r < 0.75:
        region = random.choice([x for x in regions if x != truth["region"]] or regions)
    elif r < 0.95:
        region = "unsure"
    else:
        region = "Capital City"
    return (f"CONTINENT: {continent}\nCOUNTRY: {country}\nREGION: {region}\n"
            "REASON: The landscape, the history and the language of the names point there.")
