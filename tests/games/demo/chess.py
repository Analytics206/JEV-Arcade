"""Legal Moves Only's stand-in players: Jev puts 0.6 to 0.8 on a mating move
most of the time (and, now and then, its weight on a check that is not mate);
the text models usually write the mate, sometimes a legal move that is not
mate, and sometimes a move that is not legal at all, so the page's fouls show."""
from __future__ import annotations

import random
import re

from wikirace.games import chess as C
from wikirace.games.chess_rules import FILES, Position, mates_in_one, parse_move

from . import choice, spread


def _by_state() -> dict[tuple[str, str, str], C.Study]:
    out = {}
    for pz in C.puzzles():
        st = C.study(pz["fen"])
        s = C.jev_state(st)
        out[(s["side_to_move"], s["white_pieces"], s["black_pieces"])] = st
    return out


STUDIES = _by_state()
REASONS = [
    "The king has no square left and nothing can block.",
    "The back rank is sealed by its own pawns.",
    "The checking piece is protected, so the king cannot take it.",
    "It is a double check: only the king could move, and it cannot.",
    "Every flight square is covered.",
    "Nothing can capture the checking piece or step in between.",
]


def jev(qid, q, state):
    if not isinstance(state, dict) or "white_pieces" not in state or "side_to_move" not in state:
        return None
    st = STUDIES.get((state["side_to_move"], state["white_pieces"], state.get("black_pieces", "")))
    ids = q.get("criteria") or {}
    if st is None or q.get("type") != "choice" or not ids:
        return None
    mates = {ln.shown for ln in st.mates}
    checks = {ln.shown for ln in st.lines if ln.check and not ln.mate}
    mate_ids = [o for o, d in ids.items() if d.split(":", 1)[0] in mates]
    check_ids = [o for o, d in ids.items() if d.split(":", 1)[0] in checks]
    if mate_ids and random.random() < 0.86:
        best, p = random.choice(mate_ids), random.uniform(0.6, 0.8)
    else:
        best, p = random.choice(check_ids or list(ids)), random.uniform(0.3, 0.5)
    return choice(spread(best, list(ids), p))


def _illegal(pos: Position) -> str:
    """A move that reads like chess and is not legal here."""
    for _ in range(200):
        kind = random.choice("QRBNK")
        to = random.choice(FILES) + random.choice("12345678")
        said = f"{kind}{'x' if random.random() < 0.4 else ''}{to}{'#' if random.random() < 0.5 else ''}"
        if parse_move(pos, said).move is None:
            return said
    return "Qz9"


def text(model, system, prompt):
    if "solving chess puzzles" not in system:
        return None
    m = re.search(r"^FEN: (.+)$", prompt, re.M)
    if not m:
        return None
    pos = Position.from_fen(m.group(1))
    mates = mates_in_one(pos)
    retry = "FOUL:" in prompt
    roll = random.random()
    if mates and (roll < 0.64 or (retry and roll < 0.85)):
        mv = random.choice(mates)
        said = mv.uci if random.random() < 0.1 else pos.san(mv)
        reason = random.choice(REASONS)
    elif roll < 0.84:
        quiet = [x for x in pos.legal_moves() if x not in mates]
        checks = [x for x in quiet if pos.san(x).endswith("+")]
        said = pos.san(random.choice(checks or quiet))
        reason = "It checks the king and wins material."
    else:
        said = _illegal(pos)
        reason = random.choice(REASONS)
    return f"REASON: {reason}\nMOVE: {said}"
