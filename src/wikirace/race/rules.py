"""The rules of WikiRace, as pure functions — no I/O, so every call is a test.

What a racer is told (the prompt), how its reply is read, how a pick is judged,
and how finished racers are ranked. Plus what a model costs, how many links fit
a small context window, and the helpers Jev's racer needs to ask one question
over a page with a thousand links.

**The fouls.** A pick is checked against the page's own link list — the API's,
never the model's idea of it:

  off_page   the title is not a link on this article (a real article that is not
             linked from here, or no article at all — the engine looks it up and
             says which)
  teleport   the title is the TARGET, which is not linked from here: the jump
             straight to the finish the game exists to forbid. (Naming the
             target when the page links it under another name — a redirect —
             is the winning move, not a teleport.)
  no_pick    the reply named no link at all

A foul is rejected, the racer stays on the article and is told what went wrong,
and it costs a strike; `strikes` of them disqualify. `ok` moves the racer on.
"""
from __future__ import annotations

import random
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import unquote

from .wiki import Page, fold, normalize_title

VERDICTS = ("ok", "off_page", "teleport", "no_pick", "dead_link")
FOULS = frozenset({"off_page", "teleport", "no_pick"})

#: Terminal lane states. `finished` reached the target; `dnf` ran out of hops or
#: time; `dq` fouled out; `error` could not play (a provider refused, a key is
#: missing); `stopped` was stopped by a person or a restart.
ENDED = frozenset({"finished", "dnf", "dq", "error", "stopped"})


# ── What a racer is told ─────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are a contestant in WikiRace. Starting from one Wikipedia article, you reach \
a target article by following links: each turn you are on one article, you are \
shown every link on it, and you choose one to follow. Fewest hops wins; ties go \
to the faster racer.

The rules:
- Choose exactly one title from the list of links you are shown, copied exactly as written.
- A title that is not in that list is a foul. Naming the target when it is not in \
the list is a foul too: there are no shortcuts.
- A foul costs you a turn, and enough fouls disqualify you.

Reply with exactly two lines and nothing else:
REASON: <one short sentence on why this link brings you closer to the target>
LINK: <the title, copied exactly from the list>"""


@dataclass(frozen=True)
class Turn:
    """Everything a racer sees for one turn."""

    target: str
    target_description: str
    page: Page
    #: The hop this turn would make, 1-based.
    hop: int
    max_hops: int
    #: Start … current article, in order.
    path: tuple[str, ...]
    #: What went wrong on THIS article so far, oldest first.
    fouls: tuple[str, ...] = ()
    strikes: int = 0
    max_strikes: int = 3
    #: 0 shows every link.
    max_links: int = 0
    #: Link titles a ranking racer must not be offered again: the dead links
    #: on this article, and every link it has already followed.
    excluded: tuple[str, ...] = ()


def shown_links(page: Page, max_links: int) -> tuple[str, ...]:
    if max_links and len(page.links) > max_links:
        return page.links[:max_links]
    return page.links


def turn_prompt(t: Turn) -> str:
    """The user message for one turn. The system prompt carries the rules."""
    lines = [f"TARGET: {t.target}" + (f" — {t.target_description}" if t.target_description else ""), ""]
    lines.append(f"YOU ARE ON: {t.page.title}" + (f" — {t.page.description}" if t.page.description else ""))
    lines.append(f"This turn makes hop {t.hop} of the {t.max_hops} allowed.")
    lines.append("Your path so far: " + " → ".join(t.path))
    earlier = list(dict.fromkeys(t.path[:-1]))
    if earlier:
        lines.append("Already visited (going back only wastes a hop): " + "; ".join(earlier))
    if t.fouls:
        lines.append("")
        lines.extend(f"FOUL on this article: {note}" for note in t.fouls)
        lines.append(f"Fouls: {t.strikes} of {t.max_strikes} — at {t.max_strikes} you are disqualified.")
    if t.page.lead:
        lines += ["", f"About this article: {t.page.lead}"]
    shown = shown_links(t.page, t.max_links)
    if len(shown) == len(t.page.links):
        head = f"LINKS ON THIS ARTICLE ({len(shown):,}):"
    else:
        head = f"LINKS ON THIS ARTICLE (the first {len(shown):,} of {len(t.page.links):,}, in reading order):"
    lines += ["", head, *shown]
    return "\n".join(lines)


# ── Reading a reply ──────────────────────────────────────────────────────────

# `LINK: …`, forgiving the decoration models add: a list bullet, bold on either
# side of the colon, a heading hash, a full-width colon. The value is the rest
# of the line, trimmed afterwards: a lazy match that trims itself backtracks
# quadratically on a long run of spaces, and a small local model can write one.
_FIELD = r"^[ \t>*_`#-]*{name}[ \t*_`]*[:：][ \t*_`]*(?P<v>[^\n]*)$"
#: More than any reply needs (a title is at most 255 characters); longer is
#: read from its end, where the LINK line is, and a named title is cut here.
_MAX_REPLY = 20_000
_MAX_TITLE = 300
_LINK_RE = re.compile(_FIELD.format(name="LINK"), re.I | re.M)
_REASON_RE = re.compile(_FIELD.format(name="REASON"), re.I | re.M)
_WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
_MDLINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_QUOTES = "\"'“”‘’«»`"


@dataclass(frozen=True)
class Reply:
    #: The title the reply named, tidied for display; None when it named none.
    claimed: str | None
    reason: str
    #: Spellings to try against the page, most literal first.
    variants: tuple[str, ...] = ()


def _title_from_url(s: str) -> str | None:
    if "/wiki/" not in s:
        return None
    return unquote(s.split("/wiki/", 1)[1].split("#", 1)[0].split("?", 1)[0]).replace("_", " ")


_WRAP = _QUOTES + "*_"
_TRAILING = ".,;:!?"
#: Plenty for any real reply; a bound because the peeling below branches.
_MAX_VARIANTS = 32


def _unwrap(s: str) -> str | None:
    """The title inside one whole piece of markup — `[[…]]`, a markdown link, a
    Wikipedia URL — or None when *s* is not one."""
    if m := _WIKILINK.fullmatch(s):
        return m.group(1)
    if m := _MDLINK.fullmatch(s):
        return _title_from_url(m.group(2)) or m.group(1)
    return _title_from_url(s)


def title_variants(raw: str) -> tuple[str, ...]:
    """The ways a typed title might have been meant, most literal first.

    One layer at a time is peeled off, in every order, until nothing changes:
    markup (`[[…]]`, a markdown link, a URL), ONE trailing punctuation mark,
    one pair of quotes or emphasis, a `#section`. `"Paris".`, `[[Paris]].` and
    `*Paris*` all reach `Paris`. Each layer is only a *candidate*, and the
    literal spelling is tried first: "Washington, D.C." ends in a full stop
    that is part of the title, "'Allo 'Allo!" starts with a quote that is too,
    and "Yahoo!." should find "Yahoo!" before "Yahoo".
    """
    base = raw.strip().replace("**", "").replace("__", "").strip()
    out: list[str] = []
    queue = [base]
    while queue and len(out) < _MAX_VARIANTS:
        s = queue.pop(0).strip()
        if not s or s in out:
            continue
        out.append(s)
        if (inner := _unwrap(s)) is not None:
            queue.append(inner)
        if s[-1] in _TRAILING:
            queue.append(s[:-1])
        if len(s) > 1 and s[0] in _WRAP and s[-1] in _WRAP:
            queue.append(s[1:-1])
        elif s[0] in _WRAP:
            queue.append(s[1:])
        elif s[-1] in _WRAP:
            queue.append(s[:-1])
        if "#" in s:
            queue.append(s.split("#", 1)[0])
    return tuple(dict.fromkeys(" ".join(v.split()) for v in out if v.strip()))


def display_title(raw: str) -> str:
    """What the racer said, for the log: markup unwrapped, nothing else touched."""
    base = raw.strip().replace("**", "").replace("__", "").strip()
    return " ".join((_unwrap(base) or base).replace("_", " ").split())


def parse_reply(text: str) -> Reply:
    """Pull the pick and the reason out of a reply. Never raises.

    The LAST `LINK:` line wins — a model that corrects itself mid-reply means
    the correction. A reply with no `LINK:` line but exactly one line is taken
    as the title itself; anything else names no link.
    """
    text = (text or "").strip()[-_MAX_REPLY:]
    reasons = list(_REASON_RE.finditer(text))
    reason = " ".join(reasons[-1].group("v").split())[:300] if reasons else ""
    for m in reversed(list(_LINK_RE.finditer(text))):
        value = m.group("v").strip()[:_MAX_TITLE]
        variants = title_variants(value)
        if variants:
            return Reply(display_title(value) or variants[0], reason, variants)
    lines = [ln.strip()[:_MAX_TITLE] for ln in text.splitlines() if ln.strip()]
    if len(lines) == 1 and not _REASON_RE.match(lines[0]):
        variants = title_variants(lines[0])
        if variants:
            return Reply(display_title(lines[0]) or variants[0], reason, variants)
    return Reply(None, reason, ())


# ── Judging a pick ───────────────────────────────────────────────────────────


class LinkIndex:
    """One article's links, for recognising which one a reply meant."""

    def __init__(self, links: Iterable[str]) -> None:
        self.exact: dict[str, str] = {}
        self.folded: dict[str, str] = {}
        for link in links:
            self.exact.setdefault(normalize_title(link), link)
            self.folded.setdefault(fold(link), link)

    def match(self, variants: Iterable[str]) -> str | None:
        """The link these spellings name: an exact title first, then a folded one."""
        variants = tuple(variants)
        for v in variants:
            if (hit := self.exact.get(normalize_title(v))) is not None:
                return hit
        for v in variants:
            if (hit := self.folded.get(fold(v))) is not None:
                return hit
        return None

    def find_any(self, keys: Iterable[str]) -> str | None:
        """The first link whose folded title is one of *keys*, in their order."""
        for key in keys:
            if (hit := self.folded.get(key)) is not None:
                return hit
        return None


@dataclass(frozen=True)
class Verdict:
    kind: str
    #: The page's own spelling of the link followed, for `ok`.
    link: str | None = None


def judge(
    claimed: str | None, variants: Sequence[str], links: LinkIndex, target_keys: Sequence[str]
) -> Verdict:
    """Is this pick a move or a foul?

    *target_keys* are the `fold`ed names of the target, canonical title first:
    the title, what the person typed, and every redirect to it.

    On the page wins over everything — including when the pick IS the target,
    which is simply the winning move. Naming the target when the page links it
    under ANOTHER name (a redirect: "Twin Towers" for the 1973–2001 towers) is
    the winning move too, through that link: the racer said where it was going
    and the page goes there. Only when no link on the page leads to the target
    is naming it a teleport. Anything else is off_page — and the engine then
    asks Wikipedia whether that title redirects to the target, which makes it a
    teleport after all.
    """
    if not claimed:
        return Verdict("no_pick")
    variants = tuple(variants) or (claimed,)
    if (hit := links.match(variants)) is not None:
        return Verdict("ok", hit)
    keys = set(target_keys)
    if any(fold(v) in keys for v in variants):
        if (via := links.find_any(target_keys)) is not None:
            return Verdict("ok", via)
        return Verdict("teleport")
    return Verdict("off_page")


def foul_note(
    kind: str, claimed: str | None, page_title: str, *,
    exists: bool | None = None, hidden_of: int | None = None, cut_off: bool = False,
) -> str:
    """What the racer is told, and what the cheat log says.

    *hidden_of* is the number of links shown when the pick IS on the article
    but past the cap: legal on the page, not on the list the racer was given.
    *cut_off*: the reply hit the length limit (a model that thought until it
    ran out) before it named anything.
    """
    if kind == "no_pick" and cut_off:
        return "your reply ran out of room before it named a link — think less, answer sooner"
    if kind == "no_pick":
        return "your reply named no link — end it with a LINK: line"
    if kind == "teleport":
        return f"“{claimed}” is the target, but it is not linked from “{page_title}” — no shortcuts"
    if hidden_of is not None:
        return (
            f"“{claimed}” is on “{page_title}”, but not among the {hidden_of:,} links"
            " you were shown — pick from the list"
        )
    if exists is True:
        return f"“{claimed}” is a real article, but it is not a link on “{page_title}”"
    if exists is False:
        return f"“{claimed}” is not a Wikipedia article, and not a link on “{page_title}”"
    return f"“{claimed}” is not a link on “{page_title}”"


# ── Ranking ──────────────────────────────────────────────────────────────────


def rank(lanes: Sequence[dict[str, Any]]) -> list[int]:
    """Finished lanes, best first: fewest hops, then least thinking time, then
    whoever crossed the line first. Lanes that did not finish are unranked."""
    done = [ln for ln in lanes if ln.get("status") == "finished"]
    done.sort(key=lambda ln: (ln.get("hops", 0), ln.get("think_ms", 0), ln.get("finish_order") or 99))
    return [int(ln["index"]) for ln in done]


# ── Cost ─────────────────────────────────────────────────────────────────────

#: USD per million tokens, (input, output), for providers that report no cost:
#: Anthropic and OpenAI. OpenRouter reports what it billed, Ollama is local and
#: free, TypeSafe is priced below. An estimate at list price, which is why the
#: page marks these with "≈".
#:
#: Anthropic's from its model table (2026-06-24). OpenAI's are the standard tier
#: of its pricing page (2026-09-22, developers.openai.com/api/docs/pricing). An o-series or gpt-5 model's hidden
#: reasoning is billed as output and counted in `completion_tokens`, so the
#: output rate covers it. A prompt cache would bill a repeated prefix for less,
#: but a race's prompts part at the article title, a few hundred tokens in and
#: short of the 1,024 a cache hit needs, so caching is ignored.
LIST_PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-mythos-5-1": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "o3": (2.0, 8.0),
    "o4-mini": (1.10, 4.40),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-5": (1.25, 10.0),
    "gpt-5-mini": (0.25, 2.0),
    "gpt-5-nano": (0.05, 0.40),
}
#: TypeSafe bills input only: $0.042 per million tokens, and output is free
#: because Jev writes none.
JEV_INPUT_PER_MTOK = 0.042

#: A pinned snapshot is priced as its model: Anthropic's `-20251001`, OpenAI's
#: `-2025-04-16`. Nothing else borrows a price — `o3-pro` lists at ten times
#: `o3`, so a sibling stays unpriced rather than priced from a guess.
_SNAPSHOT = re.compile(r"-(?:\d{8}|\d{4}-\d{2}-\d{2})$")


def estimate_cost(model_id: str, tokens_in: int, tokens_out: int) -> float | None:
    price = LIST_PRICES.get(_SNAPSHOT.sub("", model_id))
    if price is None:
        return None
    pin, pout = price
    return (tokens_in * pin + tokens_out * pout) / 1_000_000


def list_price(provider: str, model_id: str) -> tuple[float, float] | None:
    """(input, output) USD per million tokens as the setup shows it, or None
    when unknown: OpenRouter's is whatever it bills, and a model the table
    does not list is not guessed from a sibling."""
    if provider == "ollama":
        return (0.0, 0.0)
    if provider == "typesafe":
        return (JEV_INPUT_PER_MTOK, 0.0)
    if provider in ("anthropic", "openai"):
        return LIST_PRICES.get(_SNAPSHOT.sub("", model_id))
    return None


# ── Fitting a context window ─────────────────────────────────────────────────

#: Characters per token, low on purpose: link titles are short words, names
#: and digits, which tokenise worse than prose. Overestimating tokens shows a
#: few links fewer than would fit; underestimating would overflow the window.
_CHARS_PER_TOKEN = 3.0


def estimate_tokens(text: str) -> int:
    return int(len(text) / _CHARS_PER_TOKEN) + 1


def links_that_fit(t: Turn, max_tokens: int) -> int:
    """How many of the page's links (in reading order, after the race's own
    cap) fit a prompt of at most *max_tokens*, system prompt included.

    For a model whose window must be named per request (Ollama): a prompt
    longer than the window is cut from the front, rules and all, without an
    error, so the racer is shown fewer links rather than none of the rules.
    """
    shown = shown_links(t.page, t.max_links)
    head = turn_prompt(replace(t, max_links=1))  # everything but the list, near enough
    room = max_tokens - estimate_tokens(SYSTEM_PROMPT) - estimate_tokens(head)
    n = 0
    for title in shown:
        room -= estimate_tokens(title) + 1  # and its newline
        if room < 0:
            break
        n += 1
    return max(n, 1)


# ── Jev: one question over a page's links ────────────────────────────────────

#: Options per `choice` question: the API's ceiling, and TypeSafe's advice is to
#: give a Choice the whole list rather than a shortlist. A page up to this size
#: is one question in one request.
JEV_MAX_OPTIONS = 255
#: Questions per request when a bigger page is split. One request answers all
#: of them at once; eight of 238 titles (United States' 2,139 links) came to 36k
#: tokens, inside the 64k a request may carry.
JEV_PER_ASK = 8
#: The question. Jev answers the words written, not the intent: asked for the
#: title "most closely related to the target article", it read the target as
#: something other than related to itself and passed it over while the page
#: linked it (p 0.28 against a neighbour's 0.61 on "Digital library"). So the
#: winning move is written out as the exact condition it is, and the fields of
#: the state it reads are named (TypeSafe, "Jev 1.13 jaggedness": literal
#: reading). Measured on five pages that link their target, this puts p 0.95 to
#: 1.00 on the target where the old wording put 0.28 to 0.54.
JEV_INSTRUCTIONS: dict[str, Any] = {
    "question": (
        "Which link should a Wikipedia racer on `current_article` click next "
        "to reach `target_article` in the fewest clicks?"
    ),
    "rules": [
        "If `target_article` itself is one of the options, choose it: clicking it wins the race.",
        "Otherwise choose the article most closely tied to `target_article`: the same subject, "
        "place, person, era, field or category, narrowing from broad toward specific.",
    ],
}


def chunked(seq: Sequence[Any], size: int) -> list[list[Any]]:
    """*seq* in pieces of at most *size* that differ in length by one at most —
    never a runt of one, which as a `choice` question would be a question with
    a single answer (a fixed step leaves one: 9,901 → 99×100 + 1)."""
    if not seq:
        return []
    pieces = -(-len(seq) // size)
    q, r = divmod(len(seq), pieces)
    out: list[list[Any]] = []
    start = 0
    for k in range(pieces):
        n = q + (1 if k < r else 0)
        out.append(list(seq[start:start + n]))
        start += n
    return out


def jev_keep(n_chunks: int) -> int:
    """How many of each chunk's best go on to the final question: as many as it
    holds. A link is then judged against the whole field, rather than dropped
    in the first round for a neighbour that happened to share its chunk."""
    return max(1, JEV_MAX_OPTIONS // max(n_chunks, 1))


def jev_state(t: Turn) -> dict[str, str]:
    """What Jev reads: where it is and where it is going. Nothing more, because
    state unrelated to the question costs a System One model accuracy."""
    return {
        "current_article": t.page.title,
        "target_article": t.target,
        "target_description": t.target_description,
    }


def jev_question(options: Sequence[str], seed: str) -> tuple[dict[str, Any], dict[str, str]]:
    """A `choice` question over *options* under opaque, shuffled ids.

    Shuffled so neither a position nor an id can carry the answer (reading
    order would otherwise favour the infobox), and seeded so the same page and
    target always ask the same question.
    """
    order = list(options)
    random.Random(seed).shuffle(order)
    ids = {f"c{i}": title for i, title in enumerate(order)}
    return {"type": "choice", "instructions": JEV_INSTRUCTIONS, "criteria": dict(ids)}, ids
