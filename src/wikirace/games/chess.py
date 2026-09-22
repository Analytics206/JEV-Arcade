"""Legal Moves Only: chess puzzles where every move Jev makes is a real move.

TypeSafe's typed actions, on a chessboard. WikiRace's lesson again: a player
that picks from the real options cannot make an impossible move, and a player
that writes its move in words sometimes does.

A run plays `count` mate-in-one puzzles (data/chess.json, drawn by a seeded
shuffle); every lane plays the same ones, in order, each at its own pace.

**Jev** gets ONE choice per puzzle over every legal move (no position has more
than 218, a choice holds 255), under opaque ids, each meaning the move's SAN and
a plain description (`Re8+: rook e1 to e8, check`; never `#`, which would give
the answer away). The state is the position in words, written by code: the side
to move, each side's pieces with their squares, which moves give check and
which capture what. No FEN: Jev reads words, not encodings. Its top move is
played; its top five, with probabilities, are the page's arrows.

**A text model** gets the rules and the answer format (`MOVE: <SAN>`, optional
`REASON:`) and the position as FEN and piece lists, but not the legal moves
(unless `show_moves`). Its move is read as SAN, long algebraic or UCI and
matched against the legal moves. Not legal, or not a move at all, is a foul: it
is told why and tries again, up to `strikes` fouls on a puzzle, which then is
failed. A legal move that does not mate is a miss.

A puzzle is solved (it counts), missed or failed; a lane's score is how many it
solved. The answer key is revealed in the run at the end.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .chess_rules import COLORS, NAMES, Move, Parsed, Position, neutral, parse_move, sq_name
from .core import AnswerError, choice, opaque, read_choice, read_field
from .players import Asked, Player, ask_jev, ask_text
from .runs import GameRun

QUESTION = (
    "Which move checkmates the opponent right now? "
    "If no move mates, choose the move that wins the most material."
)


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "chess.json", encoding="utf-8") as f:
        return json.load(f)


def puzzles() -> list[dict[str, Any]]:
    return data()["puzzles"]


# ── One position, every way it is shown ───────────────────────────────────────


@dataclass(frozen=True)
class Line:
    """One legal move: what it is, and how each player and the page see it."""

    move: Move
    uci: str
    #: The true SAN, `#` and all: for the page and the answer key.
    san: str
    #: The SAN a player is shown: `+` for check, never `#`.
    shown: str
    #: In words, for Jev: `rook e1 to e8, check`.
    words: str
    check: bool
    mate: bool

    @property
    def meaning(self) -> str:
        return f"{self.shown}: {self.words}"

    def squares(self) -> dict[str, str]:
        return {"from": sq_name(self.move.frm), "to": sq_name(self.move.to)}


@dataclass(frozen=True)
class Study:
    pos: Position
    lines: tuple[Line, ...]

    @property
    def by_uci(self) -> dict[str, Line]:
        return {ln.uci: ln for ln in self.lines}

    @property
    def mates(self) -> list[Line]:
        return [ln for ln in self.lines if ln.mate]

    @property
    def side(self) -> str:
        return COLORS[self.pos.turn]


@cache
def study(fen: str) -> Study:
    pos = Position.from_fen(fen)
    lines = []
    for m in pos.legal_moves():
        san = pos.san(m)
        check = san.endswith(("+", "#"))
        lines.append(Line(m, m.uci, san, neutral(san), pos.describe(m, check), check, san.endswith("#")))
    return Study(pos, tuple(lines))


def jev_state(st: Study) -> dict[str, str]:
    """The position in words, as Jev reads it: only what the question needs."""
    pos = st.pos
    checks = [f"{ln.shown} ({ln.words.removesuffix(', check')})" for ln in st.lines if ln.check]
    captures = []
    for ln in st.lines:
        m = ln.move
        if m.captured:
            where = m.to - (8 if pos.turn == "w" else -8) if m.ep else m.to
            captures.append(f"{ln.shown} takes the {NAMES[m.captured]} on {sq_name(where)}"
                            + (" (en passant)" if m.ep else ""))
    state = {
        "side_to_move": st.side,
        "white_pieces": pos.pieces_words("w"),
        "black_pieces": pos.pieces_words("b"),
    }
    if pos.in_check():
        by = pos.attackers(pos.king(pos.turn), "b" if pos.turn == "w" else "w")
        state["your_king"] = "in check from " + ", ".join(
            f"the {NAMES[(pos.board[s] or 'P').upper()]} on {sq_name(s)}" for s in by)
    state["your_checks"] = "; ".join(checks) or "none"
    state["your_captures"] = "; ".join(captures) or "none"
    return state


def instructions(st: Study) -> dict[str, Any]:
    rules = [
        "You move for the side named in `side_to_move`. Every option is one of its legal moves, "
        "and the move you choose is played.",
        "`white_pieces` and `black_pieces` list every piece on the board and the square it stands on.",
        "Checkmate: after the move the opponent's king is attacked, and the opponent cannot end the attack: "
        "its king has no safe square, the attacking piece cannot be taken, and nothing can be put in between.",
        "A checkmating move always gives check. `your_checks` lists every move that gives check.",
        "`your_captures` lists every move that takes a piece, and the piece it takes.",
    ]
    if st.pos.in_check():
        rules.insert(2, "`your_king` names the piece giving check to your king; your move must end that check.")
    return {"question": QUESTION, "rules": rules}


def not_mate(st: Study, ln: Line) -> str:
    """Why a legal move is not the mate, in a few words that follow "legal, but …"."""
    after = st.pos.play(ln.move)
    them = COLORS[after.turn]
    replies = after.legal_moves()
    if not after.in_check():
        if not replies:
            return f"stalemate: {them} has no move, but its king is not in check"
        return "no check, so no mate"

    def rank(m: Move) -> int:
        return 0 if m.to == ln.move.to else 1 if m.piece == "K" else 2

    reply = min(replies, key=rank)
    return f"not mate: {them} answers {after.san(reply)}"


# ── A text model ──────────────────────────────────────────────────────────────


def text_system(strikes: int) -> str:
    return (
        "You are solving chess puzzles. Each puzzle is one position, and you play one move for the side "
        "to move.\n\n"
        "The goal: checkmate the opponent with this one move. If you see no checkmate, play the move that "
        "wins the most material.\n\n"
        "The rules:\n"
        "- Your move must be legal in the position shown. A move that is not legal, or not a move at all, "
        f"is a foul: you are told why and may try again, but {strikes} "
        f"foul{'s' if strikes != 1 else ''} on one puzzle and it is lost.\n"
        "- Write the move in standard algebraic notation (SAN), as in Re8, Nxf7, exd6, O-O or e8=Q. "
        "UCI (e1e8, e7e8q) is accepted too.\n"
        "- A legal move that does not checkmate ends the puzzle unsolved.\n\n"
        "Reply with exactly two lines and nothing else:\n"
        "REASON: <one short sentence on why the move works>\n"
        "MOVE: <your move>"
    )


def text_prompt(k: int, total: int, st: Study, fouls: list[tuple[str, str]], strikes: int,
                show_moves: bool) -> str:
    pos = st.pos
    lines = [
        f"PUZZLE {k + 1} of {total}. {st.side.capitalize()} to move.",
        f"FEN: {pos.fen()}",
        f"White: {pos.pieces_words('w')}",
        f"Black: {pos.pieces_words('b')}",
    ]
    if pos.in_check():
        lines.append("Your king is in check.")
    if show_moves:
        lines += ["", f"LEGAL MOVES ({len(st.lines)}): " + ", ".join(ln.shown for ln in st.lines)]
    if fouls:
        lines.append("")
        lines += [f"FOUL: “{said}”: {why}." for said, why in fouls]
        lines.append(f"Fouls on this puzzle: {len(fouls)} of {strikes}. At {strikes} the puzzle is lost.")
    return "\n".join(lines)


def read_move(reply: str | None) -> str | None:
    """The move a reply names: its MOVE field, else its last line."""
    claimed = read_field(reply, "MOVE")
    if claimed is None:
        rows = [r.strip() for r in (reply or "").splitlines() if r.strip()]
        claimed = rows[-1] if rows else None
    return claimed


def judge_text(st: Study, claimed: str | None) -> Parsed:
    if not claimed:
        return Parsed(None, "the reply named no move: end it with the line MOVE: <your move>")
    return parse_move(st.pos, claimed)


# ── The game ──────────────────────────────────────────────────────────────────


class Params(BaseModel):
    count: int = Field(default=8, ge=1, le=len(puzzles()), description="puzzles in the round")
    strikes: int = Field(default=3, ge=1, le=5, description="fouls a text model may make on one puzzle")
    show_moves: bool = Field(default=False, description="show text models the list of legal moves")
    seed: int | None = Field(default=None, description="the same seed draws the same puzzles")


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    pool = list(puzzles())
    random.Random(p.seed).shuffle(pool)
    picked = pool[: p.count]
    ctx.private["picked"] = picked
    public = []
    for k, pz in enumerate(picked):
        st = study(pz["fen"])
        public.append({
            "i": k, "id": pz["id"], "fen": st.pos.fen(), "side": st.side, "theme": pz["theme"],
            "difficulty": pz["difficulty"], "legal": len(st.lines), "state": jev_state(st),
        })
    return {
        "puzzles": public, "total": len(picked), "strikes": p.strikes, "show_moves": p.show_moves,
        "question": QUESTION, "key": None,
    }


def answer_key(picked: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for k, pz in enumerate(picked):
        st = study(pz["fen"])
        out.append({
            "puzzle": k, "idea": pz.get("idea"),
            "mates": [{"san": ln.san, "uci": ln.uci, **ln.squares()} for ln in st.mates],
        })
    return out


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    picked: list[dict[str, Any]] = ctx.private["picked"]
    studies = [study(pz["fen"]) for pz in picked]
    total = len(studies)
    system = text_system(p.strikes)
    for i in range(len(ctx.players)):
        run.lane(i, at=0, solved=0, missed=0, failed=0, score=0, current=None)

    def finish(pl: Player, result: dict[str, Any], call: Asked | None = None) -> None:
        i = pl.index
        ln = run.state["lanes"][i]
        v = result["verdict"]
        solved = ln["solved"] + (v == "solved")
        tally = {
            "solved": solved, "missed": ln["missed"] + (v == "missed"), "failed": ln["failed"] + (v == "failed"),
            "score": solved, "at": result["puzzle"] + 1, "current": None,
        }
        run.lane_push(i, "puzzles", result)
        if call is not None:
            run.account(i, call, **tally)
        else:
            run.lane(i, **tally)

    async def jev_puzzle(pl: Player, k: int, st: Study) -> None:
        run.lane(pl.index, at=k)
        if len(st.lines) < 2:  # a forced move is no question (no puzzle here has one)
            ln = st.lines[0]
            finish(pl, {"puzzle": k, "move": ln.san, "uci": ln.uci, **ln.squares(), "fouls": 0, "ms": 0,
                        "verdict": "solved" if ln.mate else "missed", "top": [], "options": 1,
                        "note": "the only legal move"})
            return
        ids = opaque([ln.uci for ln in st.lines], f"chess|{run.id}|{k}", prefix="m")
        by_uci = st.by_uci
        question = choice(instructions(st), {oid: by_uci[u].meaning for oid, u in ids.items()})
        asked = await ask_jev(pl, jev_state(st), {"move": question}, on_wait=run.waiting(pl.index))
        try:
            pick = read_choice(asked.answers["move"], ids)
        except AnswerError:
            run.account(pl.index, asked)  # the call was made and billed, even if its answer is unusable
            raise
        ln = by_uci[pick.option]
        top = [{"san": by_uci[t["option"]].shown, "uci": t["option"], **by_uci[t["option"]].squares(), "p": t["p"]}
               for t in pick.top(5)]
        finish(pl, {
            "puzzle": k, "move": ln.san, "uci": ln.uci, **ln.squares(), "fouls": 0, "ms": asked.latency_ms,
            "verdict": "solved" if ln.mate else "missed", "p": round(pick.p, 4),
            "confidence": round(pick.confidence, 4), "options": len(st.lines), "requests": asked.requests,
            "top": top, "note": None if ln.mate else not_mate(st, ln),
        }, asked)

    async def text_puzzle(pl: Player, k: int, st: Study) -> None:
        i = pl.index
        attempts: list[dict[str, Any]] = []
        fouls: list[tuple[str, str]] = []
        spent = 0
        run.lane(i, at=k, current={"puzzle": k, "attempts": []})
        while True:
            prompt = text_prompt(k, total, st, fouls, p.strikes, p.show_moves)
            said = await ask_text(pl, system, prompt, on_wait=run.waiting(i))
            spent += said.latency_ms
            claimed = read_move(said.text)
            reason = (read_field(said.text, "REASON") or "")[:240] or None
            parsed = judge_text(st, claimed)
            shown = " ".join((claimed or "").split())[:60]
            att: dict[str, Any] = {
                "said": shown, "reason": reason, "ms": said.latency_ms,
                "from": sq_name(parsed.frm) if parsed.frm is not None else None,
                "to": sq_name(parsed.to) if parsed.to is not None else None,
            }
            if parsed.move is None:
                assert parsed.foul is not None
                att["foul"] = parsed.foul
                attempts.append(att)
                fouls.append((shown or "(nothing)", parsed.foul))
                run.account(i, said, fouls=run.state["lanes"][i]["fouls"] + 1,
                            current={"puzzle": k, "attempts": list(attempts)})
                if len(fouls) >= p.strikes:
                    finish(pl, {"puzzle": k, "move": None, "uci": None, "from": None, "to": None,
                                "verdict": "failed", "fouls": len(fouls), "ms": spent, "attempts": attempts,
                                "reason": reason, "note": f"{len(fouls)} of {p.strikes} fouls: the puzzle is lost"})
                    return
                continue
            ln = st.by_uci[parsed.move.uci]
            att.update(san=ln.san, uci=ln.uci, **ln.squares())
            attempts.append(att)
            run.account(i, said, current={"puzzle": k, "attempts": list(attempts)})
            finish(pl, {"puzzle": k, "move": ln.san, "uci": ln.uci, **ln.squares(),
                        "verdict": "solved" if ln.mate else "missed", "fouls": len(fouls), "ms": spent,
                        "attempts": attempts, "reason": reason, "note": None if ln.mate else not_mate(st, ln)})
            return

    async def lane(pl: Player) -> None:
        for k, st in enumerate(studies):
            await (jev_puzzle if pl.is_jev else text_puzzle)(pl, k, st)

    try:
        await run.each_lane(lane)
    finally:
        run.patch(key=answer_key(picked))


GAME = Game(
    id="chess", title="Legal Moves Only",
    tagline="Chess puzzles where every move Jev makes is a real move",
    use_case="typed actions", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
