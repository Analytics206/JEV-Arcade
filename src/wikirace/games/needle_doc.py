"""Needle Hunt's documents, as numbered lines: pure, so every function is a test.

A document is a list of lines, each one sentence (or, in the Constitution's
list of Congress's powers, one clause), numbered L001, L002, … in reading
order, each under a section (`Article I, Section 3 · The Senate`, or a
Wikipedia article's own headings). Two sources:

* **The United States Constitution** (public domain), bundled as
  `data/needle_constitution.txt`: the Preamble, Articles I–VII and the Bill of
  Rights, one line per sentence under `# Where | what it is about` headings
  (the headings are WikiRace's own, not the Constitution's).
* **A Wikipedia article**: its plain-text extract (`prop=extracts`,
  `explaintext`), split into sentences, the reference sections dropped.

A document longer than one Choice can hold (255 options) is searched in two
steps, as TypeSafe's semantic-find cookbook does: a first Choice over
windows of consecutive lines, then a second over the chosen window's lines.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path

from ..race.rules import chunked

#: A Choice's ceiling: a document up to this long is one question.
MAX_CHOICE = 255
#: Lines per window when a document is longer than one Choice.
WINDOW = 40
#: A Wikipedia article is cut here: about 25k tokens, well inside a request.
MAX_LINES = 900
#: One line's text is cut here (a table flattened into prose runs on).
MAX_LINE_CHARS = 600
NONE = "NONE"

#: Sections of a Wikipedia article that are lists of sources, not prose.
_SKIP_SECTIONS = frozenset({
    "see also", "references", "external links", "notes", "further reading", "bibliography",
    "sources", "citations", "footnotes", "notes and references", "works cited", "explanatory notes",
    "general and cited sources", "general sources", "cited sources", "gallery",
})
#: Words a full stop does not end a sentence after.
_ABBR = frozenset({
    "mr", "mrs", "ms", "dr", "st", "jr", "sr", "vs", "etc", "e.g", "i.e", "no", "nos", "vol", "c", "ca",
    "approx", "fig", "gen", "col", "lt", "sgt", "capt", "gov", "sen", "rep", "rev", "prof", "inc",
    "ltd", "co", "corp", "mt", "ft", "u.s", "u.k", "a.d", "b.c", "op", "cf", "al", "jan", "feb", "mar",
    "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "pp", "p", "ed", "eds", "est",
})
_HEADING = re.compile(r"^(=+)\s*(.*?)\s*\1$")
_END = re.compile(r"[.!?][\"”’')\]]*\s+")


@dataclass(frozen=True)
class Line:
    id: str
    text: str
    #: Index into the document's sections.
    section: int


@dataclass(frozen=True)
class Doc:
    name: str
    source: str
    lines: tuple[Line, ...]
    #: Each section's heading, as the page shows it.
    sections: tuple[str, ...]
    title: str | None = None
    url: str | None = None
    #: True when the article went on past MAX_LINES.
    cut: bool = False
    _index: dict[str, int] = field(default_factory=dict, compare=False, repr=False)

    def __post_init__(self) -> None:
        self._index.update({ln.id: i for i, ln in enumerate(self.lines)})

    @property
    def ids(self) -> list[str]:
        return [ln.id for ln in self.lines]

    def has(self, line_id: str) -> bool:
        return line_id in self._index

    def line(self, line_id: str) -> Line:
        return self.lines[self._index[line_id]]

    def where(self, line_id: str) -> str:
        return self.sections[self.line(line_id).section]

    @property
    def windowed(self) -> bool:
        """Too long for one Choice: searched window first, then line."""
        return len(self.lines) > MAX_CHOICE

    def windows(self) -> list[list[str]]:
        """Consecutive line ids, WINDOW or so to a window (never a runt)."""
        return chunked(self.ids, WINDOW) if self.windowed else [self.ids]

    def near(self, pick: str, key: list[str]) -> bool:
        """*pick* is the line just before or after an answer line, in the same section."""
        if pick not in self._index:
            return False
        i = self._index[pick]
        for k in key:
            j = self._index.get(k)
            if j is not None and abs(i - j) == 1 and self.lines[i].section == self.lines[j].section:
                return True
        return False

    def jev_text(self, line_id: str) -> str:
        """A line as Jev reads it: its id, where it stands, and its words."""
        ln = self.line(line_id)
        return f"{ln.id} ({self.sections[ln.section]}): {ln.text}"

    def numbered(self) -> str:
        """The whole document as a text model reads it, one `Lnnn: text` per row
        under its section headings."""
        out: list[str] = []
        last = -1
        for ln in self.lines:
            if ln.section != last:
                out.append(f"\n[{self.sections[ln.section]}]")
                last = ln.section
            out.append(f"{ln.id}: {ln.text}")
        return "\n".join(out).strip()

    def public(self) -> dict:
        """What the page is told about the document: its name, its section
        headings, and for a long one where each window starts and ends (line
        indexes). The lines themselves are `public_lines`, a list of their own,
        so a run's summary (which drops lists) stays small."""
        spans = []
        at = 0
        for w in self.windows():
            spans.append([at, at + len(w) - 1])
            at += len(w)
        return {
            "name": self.name, "source": self.source, "title": self.title, "url": self.url, "cut": self.cut,
            "sections": list(self.sections), "windowed": self.windowed, "windows": spans if self.windowed else None,
            "size": len(self.lines),
        }

    def public_lines(self) -> list[dict]:
        """Every line as the page draws it: id, words, section index."""
        return [{"id": ln.id, "text": ln.text, "s": ln.section} for ln in self.lines]


def line_id(n: int) -> str:
    """The id of the *n*th line, 1-based: L001 … L999."""
    return f"L{n:03d}"


def read_line_id(claimed: str | None, doc: Doc) -> str | None:
    """What a text model's LINE names: a line id of *doc*, NONE, or None when
    it names neither (a foul). `L47`, `l047` and `Line 47` all name L047; an
    id past the end names nothing."""
    if not claimed:
        return None
    t = claimed.strip().strip("*_`\"'[]().").strip()
    if t.casefold() in ("none", "no line", "not in document", "not in the document"):
        return NONE
    m = re.fullmatch(r"(?i)(?:line\s*)?l?\s*0*(\d{1,4})", t)
    if not m:
        return None
    lid = line_id(int(m.group(1)))
    return lid if doc.has(lid) else None


# ── The Constitution ──────────────────────────────────────────────────────────


def parse_sectioned(text: str, name: str, source: str) -> Doc:
    """A `# Heading | about` … file as a Doc: every other non-blank row a line."""
    sections: list[str] = []
    lines: list[Line] = []
    for raw in text.splitlines():
        row = raw.strip()
        if not row:
            continue
        if row.startswith("#"):
            where, _, about = row.lstrip("#").strip().partition("|")
            sections.append(f"{where.strip()} · {about.strip()}" if about.strip() else where.strip())
            continue
        if not sections:
            sections.append(name)
        lines.append(Line(line_id(len(lines) + 1), row, len(sections) - 1))
    return Doc(name=name, source=source, lines=tuple(lines), sections=tuple(sections))


@cache
def constitution() -> Doc:
    path = Path(__file__).parent / "data" / "needle_constitution.txt"
    doc = parse_sectioned(path.read_text(encoding="utf-8"), "The United States Constitution", "constitution")
    return Doc(name=doc.name, source=doc.source, lines=doc.lines, sections=doc.sections,
               title="Constitution of the United States",
               url="https://en.wikipedia.org/wiki/Constitution_of_the_United_States")


# ── Wikipedia ─────────────────────────────────────────────────────────────────


def sentences(paragraph: str) -> list[str]:
    """*paragraph* split into sentences, not after an abbreviation or an initial."""
    out: list[str] = []
    start = 0
    for m in _END.finditer(paragraph):
        end = m.end()
        before = paragraph[start:m.start() + 1]
        word = before.rstrip(".!?").split()[-1] if before.rstrip(".!?").split() else ""
        key = word.strip("(\"“'").casefold()
        nxt = paragraph[end:end + 1]
        if paragraph[m.start()] == "." and (key in _ABBR or (len(key) == 1 and key.isalpha())):
            continue
        if nxt and not (nxt.isupper() or nxt.isdigit() or nxt in "\"“('["):
            continue
        out.append(paragraph[start:end].strip())
        start = end
    tail = paragraph[start:].strip()
    if tail:
        out.append(tail)
    return [s for s in out if len(s) >= 3]


def split_extract(title: str, extract: str, *, max_lines: int = MAX_LINES, url: str | None = None) -> Doc:
    """A Wikipedia plain-text extract as a Doc: its sentences, in order, under
    its headings; the reference sections dropped; cut at *max_lines*."""
    sections: list[str] = [f"{title} · introduction"]
    lines: list[Line] = []
    skipping = False
    cut = False
    top = ""
    for raw in extract.splitlines():
        row = raw.strip()
        if not row:
            continue
        h = _HEADING.match(row)
        if h:
            level, name = len(h.group(1)), h.group(2).strip()
            if level <= 2:
                top = name
                skipping = name.casefold() in _SKIP_SECTIONS
            elif skipping:
                continue
            if not skipping:
                sections.append(name if level <= 2 else f"{top} · {name}")
            continue
        if skipping:
            continue
        for s in sentences(row):
            if len(lines) >= max_lines:
                cut = True
                break
            text = s if len(s) <= MAX_LINE_CHARS else s[: MAX_LINE_CHARS - 1].rstrip() + "…"
            lines.append(Line(line_id(len(lines) + 1), text, len(sections) - 1))
        if cut:
            break
    # A heading with no prose under it is not a section the page should draw.
    used = sorted({ln.section for ln in lines})
    remap = {old: new for new, old in enumerate(used)}
    lines = [Line(ln.id, ln.text, remap[ln.section]) for ln in lines]
    return Doc(name=title, source="wikipedia", lines=tuple(lines),
               sections=tuple(sections[i] for i in used), title=title, url=url, cut=cut)
