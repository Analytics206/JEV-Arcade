"""Needle Hunt: find the line that answers the question, or say it isn't there.

TypeSafe's line-by-line semantic search (the semantic-find cookbook). The
document is the United States Constitution (the Preamble, Articles I–VII and
the Bill of Rights, 115 lines) or a Wikipedia article, split into numbered
sentence-lines (needle_doc.py). A round is one question; a run asks
`questions` of them, some of which the document does not answer.

**Jev** gets ONE request with two questions over one state,
`{"question", "lines": {"L001": …}}`: a Choice over every line (each option
is the line itself, under an opaque id) and a Noul, "does any line of
`lines` state the answer?". Code reads the Noul in the cookbook's bands:
answered ≥ 0.7, partly 0.35–0.7, not in the document < 0.35, and under 0.35
Jev's pick is NONE whatever the top line. A document longer than a Choice
holds (255 lines: a long article) is two requests, as the cookbook does it:
a Choice over windows of 40 lines, each option the window's passage, then the
two questions over the chosen window's lines.

**A text model** is shown the numbered document and the question and answers
`LINE: Lnnn` or `LINE: NONE`, with a REASON. A line id the document does not
have is a foul.

**The visitor** hunts on the page, timed, question by question; the page
scores them the same way.

Per question: the answer line (or NONE when there is none) +2, the line just
before or after it +1, wrong −1, a foul −1. Each question's answer is
revealed once every lane has answered it; a typed question has no key and is
not scored.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .base import Context, Game, GameInputError, GameSourceError
from .core import choice, noul, opaque, read_choice, read_field, read_noul
from .needle_doc import NONE, Doc, constitution, read_line_id, split_extract
from .players import BadPlayers, Player, PlayError, ask_jev, ask_text, resolve_players
from .runs import GameRun

#: The cookbook's bands on the existence Noul.
ANSWERED = 0.7
PARTLY = 0.35
BANDS = {"answered": ANSWERED, "partly": PARTLY}
POINTS = {"right": 2, "near": 1, "wrong": -1, "missed": -1, "foul": -1, "unscored": 0}
#: Line probabilities under this are not streamed: the minimap draws them cold.
_HEAT_FLOOR = 0.0005

LINE_INSTRUCTIONS: dict[str, Any] = {
    "question": "Which line of the document states the answer to the question in `question`?",
    "rules": [
        "Each option is one line of the document, in its own words, after its id and its section.",
        "Choose the line whose words give the answer to `question`, not a line that only mentions its subject.",
        "If no line gives the answer, choose the line that comes closest.",
    ],
}
EXISTS_INSTRUCTIONS: dict[str, Any] = {
    "question": "Does one of the lines in `lines` state the answer to the question in `question`?",
    "rules": [
        "Answer yes when a line in `lines` gives the answer to `question` in its own words.",
        "Answer no when the lines only mention the subject of `question`, or say nothing about it.",
    ],
}
EXISTS_YES = "a line in `lines` states the answer to `question`"
EXISTS_NO = "no line in `lines` states the answer to `question`"
WINDOW_INSTRUCTIONS: dict[str, Any] = {
    "question": "Which passage holds the line that states the answer to the question in `question`?",
    "rules": [
        "Each option is a passage of consecutive lines from one document.",
        "Choose the passage with a line whose words give the answer to `question`.",
        "If no passage gives the answer, choose the passage that comes closest.",
    ],
}

TEXT_SYSTEM = """\
You are searching a document for the one line that answers a question. The \
document is below as numbered lines, one per row, `Lnnn: text`, under its \
section headings in square brackets.

Rules:
- Answer with the id of the line that states the answer, copied exactly as \
written (for example L007).
- If no line states the answer, answer NONE. A line that only mentions the \
subject is not an answer.
- An id that is not in the document is a foul.

Reply with exactly two lines and nothing else:
REASON: <one short sentence>
LINE: <a line id, or NONE>

THE DOCUMENT: {name}

{document}"""

ASKER_SYSTEM = """\
You write one question for a search game. The player must find the one \
sentence of a Wikipedia article that answers it.

Rules:
- The question is answered by one sentence of the article, but does not copy \
its words: ask it the way a curious reader would.
- One question, under 20 words, ending with a question mark.

Reply with exactly one line and nothing else:
QUESTION: <the question>"""


@cache
def bank() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "needle.json", encoding="utf-8") as f:
        return json.load(f)


def band(p_exists: float) -> str:
    """The existence dial's band: answered | partly | absent."""
    if p_exists >= ANSWERED:
        return "answered"
    return "partly" if p_exists >= PARTLY else "absent"


def jev_pick(top_line: str, p_exists: float) -> str:
    """Jev's answer: its top line, or NONE when the dial says the document
    does not answer the question."""
    return NONE if band(p_exists) == "absent" else top_line


def judge(pick: str | None, key: list[str] | None, doc: Doc) -> str:
    """How one answer went: right | near | wrong | missed | foul | unscored.
    *key* is the answer lines ([] for none in the document), None for a
    question without a key."""
    if key is None:
        return "unscored" if pick is not None else "foul"
    if pick is None:
        return "foul"
    if pick == NONE:
        return "right" if not key else "missed"
    if not key:
        return "wrong"
    if pick in key:
        return "right"
    return "near" if doc.near(pick, key) else "wrong"


def draw(n: int, seed: int | None) -> list[dict[str, Any]]:
    """*n* questions from the bank: about a quarter of them with no answer in
    the document (at least one from three questions up), in a shuffled order."""
    rng = random.Random(seed)
    pool = bank()["questions"]
    have = [q for q in pool if q["lines"]]
    absent = [q for q in pool if not q["lines"]]
    k_absent = 0 if n < 3 else max(1, round(n / 4))
    k_absent = min(k_absent, len(absent))
    picked = rng.sample(have, min(n - k_absent, len(have))) + rng.sample(absent, k_absent)
    rng.shuffle(picked)
    return picked


def read_text_line(reply: str) -> str | None:
    """A text model's LINE field, else its last row."""
    claimed = read_field(reply, "LINE")
    if claimed is None:
        rows = [r.strip() for r in (reply or "").splitlines() if r.strip()]
        claimed = rows[-1] if rows else None
    return claimed


@dataclass
class _Seat:
    key: str
    thinking: str | None = None


class Params(BaseModel):
    source: Literal["constitution", "wikipedia"] = Field(default="constitution", description="the document to search")
    title: str | None = Field(default=None, max_length=250, description="the Wikipedia article, when the source is wikipedia")
    question: str | None = Field(default=None, max_length=300, description="your own question (no answer key; not scored)")
    asker: str | None = Field(default=None, max_length=300, description="a text model that writes the question for a Wikipedia article")
    questions: int = Field(default=5, ge=1, le=12, description="questions in the run (Constitution)")
    seed: int | None = Field(default=None, description="the same seed draws the same questions")


async def _article(ctx: Context, title: str) -> Doc:
    data = await ctx.wiki.query({
        "action": "query", "prop": "extracts|pageprops|info", "ppprop": "disambiguation", "inprop": "url",
        "explaintext": 1, "exsectionformat": "wiki", "redirects": 1, "titles": title,
    })
    pages = (data.get("query") or {}).get("pages") or []
    page = pages[0] if pages else {}
    if not page or page.get("missing") or page.get("invalid"):
        raise GameInputError(f"No Wikipedia article is titled “{title}”")
    if "disambiguation" in (page.get("pageprops") or {}):
        raise GameInputError(f"“{page.get('title', title)}” is a disambiguation page: name one article")
    extract = str(page.get("extract") or "")
    if not extract.strip():
        raise GameSourceError(f"Wikipedia gave no text for “{page.get('title', title)}”")
    doc = split_extract(str(page.get("title") or title), extract, url=page.get("fullurl"))
    if len(doc.lines) < 8:
        raise GameInputError(f"“{doc.title}” is too short to hunt in: {len(doc.lines)} lines")
    return doc


async def _asked(ctx: Context, key: str, doc: Doc) -> tuple[str, dict[str, Any]]:
    """A question a text model wrote for *doc*, and what writing it cost."""
    try:
        (asker,) = resolve_players([_Seat(key)], ctx.settings, ctx.providers, kinds=frozenset({"text"}))
    except BadPlayers as exc:
        raise GameInputError(f"the asker: {exc}") from exc
    lead = "\n".join(f"{ln.text}" for ln in doc.lines[:120])
    try:
        said = await ask_text(asker, ASKER_SYSTEM, f"ARTICLE: {doc.title}\n\n{lead}")
    except PlayError as exc:
        raise GameSourceError(f"the asker could not write a question: {exc}") from exc
    q = read_field(said.text, "QUESTION")
    if not q or len(q) > 300:
        raise GameSourceError(f"{asker.label} wrote no question it could be asked")
    return q, {
        "key": asker.key, "label": asker.label, "tokens_in": said.tokens_in, "tokens_out": said.tokens_out,
        "cost": said.cost, "cost_estimated": said.cost_estimated, "ms": said.latency_ms,
    }


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    asker_block = None
    typed = (p.question or "").strip()
    if p.source == "wikipedia":
        if not (p.title or "").strip():
            raise GameInputError("name the Wikipedia article to search")
        doc = await _article(ctx, p.title.strip())
        if not typed:
            if not p.asker:
                raise GameInputError("type a question, or pick a model to write one")
            typed, asker_block = await _asked(ctx, p.asker, doc)
    else:
        doc = constitution()
    if typed:
        drawn = [{"q": typed, "lines": None}]
    else:
        drawn = draw(p.questions, p.seed)
    ctx.private["doc"] = doc
    ctx.private["keys"] = [q["lines"] for q in drawn]
    return {
        "doc": doc.public(), "lines": doc.public_lines(),
        "questions": [{"k": k, "text": q["q"], "scored": q["lines"] is not None, "answer": None, "revealed": False}
                      for k, q in enumerate(drawn)],
        "asker": asker_block, "bands": BANDS, "points": POINTS,
    }


def _heat(ranked: Any, scale: float = 1.0) -> dict[str, float]:
    return {lid: round(pr * scale, 4) for lid, pr in ranked if pr * scale >= _HEAT_FLOOR}


async def play(run: GameRun, ctx: Context) -> None:
    doc: Doc = ctx.private["doc"]
    keys: list[list[str] | None] = ctx.private["keys"]
    questions = run.state["questions"]
    n = len(questions)
    scored = any(k is not None for k in keys)
    windows = doc.windows()
    system = TEXT_SYSTEM.format(name=doc.name, document=doc.numbered())
    picks: list[dict[int, str | None]] = [{} for _ in ctx.players]
    finished: list[set[int]] = [set() for _ in range(n)]
    revealed = [False] * n
    for i in range(len(ctx.players)):
        run.lane(i, score=0 if scored else None, right=0, near=0, wrong=0, answered=0, at=0)

    def reveal(k: int) -> None:
        if revealed[k]:
            return
        revealed[k] = True
        key = keys[k]
        run.put("questions", k, {**questions[k], "answer": key, "revealed": True})
        for pl in ctx.players:
            i = pl.index
            if k not in picks[i]:
                continue
            verdict = judge(picks[i][k], key, doc)
            ln = run.state["lanes"][i]
            run.lane_push(i, "marks", {"q": k, "verdict": verdict, "points": POINTS[verdict]})
            if key is not None:
                run.lane(i, score=(ln["score"] or 0) + POINTS[verdict],
                         right=ln["right"] + (verdict == "right"), near=ln["near"] + (verdict == "near"),
                         wrong=ln["wrong"] + (verdict in ("wrong", "missed", "foul")))

    def done_with(i: int, k: int) -> None:
        finished[k].add(i)
        if len(finished[k]) >= len(ctx.players):
            reveal(k)

    async def jev_answer(pl: Player, k: int, q: str) -> None:
        i = pl.index
        wait = run.waiting(i)
        ms = 0
        window = None
        window_p: dict[str, float] | None = None
        lines = windows[0]
        if doc.windowed:
            wids = opaque([str(w) for w in range(len(windows))], f"needle|{run.id}|{k}|w", prefix="w")
            crit = {wid: " ".join(doc.line(lid).text for lid in windows[int(w)]) for wid, w in wids.items()}
            asked = await ask_jev(pl, {"question": q}, {"window": choice(WINDOW_INSTRUCTIONS, crit)}, on_wait=wait)
            wpick = read_choice(asked.answers["window"], wids)
            window = int(wpick.option)
            window_p = {w: round(pr, 4) for w, pr in wpick.ranked}
            lines = windows[window]
            ms += asked.latency_ms
            run.account(i, asked)
        ids = opaque(lines, f"needle|{run.id}|{k}|l", prefix="l")
        state = {"question": q, "lines": {lid: doc.line(lid).text for lid in lines}}
        asked = await ask_jev(pl, state, {
            "line": choice(LINE_INSTRUCTIONS, {oid: doc.jev_text(lid) for oid, lid in ids.items()}),
            "exists": noul(EXISTS_INSTRUCTIONS, yes=EXISTS_YES, no=EXISTS_NO),
        }, on_wait=wait)
        top = read_choice(asked.answers["line"], ids)
        p_exists = read_noul(asked.answers["exists"])
        pick = jev_pick(top.option, p_exists)
        ms += asked.latency_ms
        scale = (window_p or {}).get(str(window), 1.0) if window is not None else 1.0
        picks[i][k] = pick
        ln = run.state["lanes"][i]
        run.lane_push(i, "answers", {
            "q": k, "pick": pick, "top": top.option, "p": round(top.p, 4), "confidence": round(top.confidence, 4),
            "exists": round(p_exists, 4), "band": band(p_exists), "ranked": top.top(7),
            "heat": _heat(top.ranked, scale), "window": window, "window_p": window_p, "ms": ms,
        })
        run.account(i, asked, answered=ln["answered"] + 1, at=k + 1)

    async def text_answer(pl: Player, k: int, q: str) -> None:
        i = pl.index
        said = await ask_text(pl, system, f"QUESTION: {q}", on_wait=run.waiting(i))
        claimed = read_text_line(said.text)
        pick = read_line_id(claimed, doc)
        picks[i][k] = pick
        ln = run.state["lanes"][i]
        run.lane_push(i, "answers", {
            "q": k, "pick": pick, "said": (claimed or "")[:80], "reason": (read_field(said.text, "REASON") or "")[:300],
            "foul": pick is None, "ms": said.latency_ms,
        })
        tally: dict[str, Any] = {"answered": ln["answered"] + 1, "at": k + 1}
        if pick is None:
            tally["fouls"] = ln["fouls"] + 1
        run.account(i, said, **tally)

    async def lane(pl: Player) -> None:
        k = 0
        try:
            for k in range(n):
                await (jev_answer if pl.is_jev else text_answer)(pl, k, questions[k]["text"])
                done_with(pl.index, k)
            k = n
        finally:
            # A lane that ended early (an error, a stop) holds no question back.
            for rest in range(k, n):
                done_with(pl.index, rest)

    try:
        await run.each_lane(lane)
    finally:
        for k in range(n):
            reveal(k)


GAME = Game(
    id="needle", title="Needle Hunt",
    tagline="Find the line that answers the question, or say it isn't there",
    use_case="line-by-line search", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
