"""The rules of chess for Legal Moves Only, in plain Python: no I/O, no dependencies.

A position comes from FEN; `legal_moves` is every legal move in it (castling,
en passant, promotion, pins and check all counted, proven by perft in the
tests); `san` writes a move in standard algebraic notation, disambiguated and
marked `+` or `#`; `play` returns the position after a move. Positions are
immutable, so a move never changes the position it was made in.

What a text model writes is read by `parse_move`, which accepts SAN (with or
without `+`/`#`, with or without `x`), long algebraic (`Re1-e8`) and UCI
(`e1e8`, `e7e8q`), and says in words why a move that is not legal is not:
"no white queen can reach f7", "that move leaves your king in check".

Squares are 0 … 63, a1 = 0, b1 = 1, … h8 = 63. A piece is one letter, upper
case for white (`K Q R B N P`), lower case for black.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import cached_property

FILES = "abcdefgh"
KINDS = "KQRBNP"
NAMES = {"K": "king", "Q": "queen", "R": "rook", "B": "bishop", "N": "knight", "P": "pawn"}
PLURALS = {"K": "kings", "Q": "queens", "R": "rooks", "B": "bishops", "N": "knights", "P": "pawns"}
COLORS = {"w": "white", "b": "black"}
PROMOTIONS = "QRBN"
START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


class FenError(ValueError):
    """A FEN that does not describe a position."""


def square(name: str) -> int:
    """`e4` → 28."""
    if len(name) != 2 or name[0] not in FILES or name[1] not in "12345678":
        raise ValueError(f"not a square: {name!r}")
    return FILES.index(name[0]) + 8 * (int(name[1]) - 1)


def sq_name(s: int) -> str:
    """28 → `e4`."""
    return f"{FILES[s & 7]}{(s >> 3) + 1}"


def color_of(piece: str) -> str:
    return "w" if piece.isupper() else "b"


def other(color: str) -> str:
    return "b" if color == "w" else "w"


# ── Geometry, computed once ───────────────────────────────────────────────────


def _walk(s: int, df: int, dr: int) -> tuple[int, ...]:
    f, r = s & 7, s >> 3
    out = []
    while True:
        f, r = f + df, r + dr
        if not (0 <= f < 8 and 0 <= r < 8):
            return tuple(out)
        out.append(f + 8 * r)


def _jumps(s: int, steps: tuple[tuple[int, int], ...]) -> tuple[int, ...]:
    f, r = s & 7, s >> 3
    return tuple((f + df) + 8 * (r + dr) for df, dr in steps if 0 <= f + df < 8 and 0 <= r + dr < 8)


_ORTHO = ((1, 0), (-1, 0), (0, 1), (0, -1))
_DIAG = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_KNIGHT_STEPS = ((1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2))
ROOK_RAYS = tuple(tuple(r for r in (_walk(s, *d) for d in _ORTHO) if r) for s in range(64))
BISHOP_RAYS = tuple(tuple(r for r in (_walk(s, *d) for d in _DIAG) if r) for s in range(64))
KNIGHT = tuple(_jumps(s, _KNIGHT_STEPS) for s in range(64))
KING = tuple(_jumps(s, _ORTHO + _DIAG) for s in range(64))


def between(a: int, b: int) -> tuple[int, ...] | None:
    """The squares strictly between *a* and *b* on a rank, file or diagonal,
    nearest *a* first; None when the two are not on one line."""
    fa, ra, fb, rb = a & 7, a >> 3, b & 7, b >> 3
    df, dr = fb - fa, rb - ra
    if a == b or not (df == 0 or dr == 0 or abs(df) == abs(dr)):
        return None
    sf, sr = (df > 0) - (df < 0), (dr > 0) - (dr < 0)
    n = max(abs(df), abs(dr))
    return tuple((fa + sf * i) + 8 * (ra + sr * i) for i in range(1, n))


# ── Moves and positions ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class Move:
    frm: int
    to: int
    #: What moves, upper case whatever its colour: P N B R Q K.
    piece: str
    #: What it takes, upper case; for en passant, the pawn beside it.
    captured: str | None = None
    #: What a pawn becomes on the last rank: Q R B N.
    promo: str | None = None
    #: "K" or "Q" for castling on that side (the king's move, e1g1 / e1c1).
    castle: str | None = None
    ep: bool = False

    @property
    def uci(self) -> str:
        return f"{sq_name(self.frm)}{sq_name(self.to)}{(self.promo or '').lower()}"


@dataclass(frozen=True)
class Position:
    board: tuple[str | None, ...]
    turn: str = "w"
    #: A subset of "KQkq".
    castling: str = ""
    #: The square a pawn passed over with its double step, or None.
    ep: int | None = None
    halfmove: int = 0
    fullmove: int = 1

    # ── FEN ──

    @classmethod
    def from_fen(cls, fen: str) -> Position:
        parts = (fen or "").split()
        if len(parts) < 4 or len(parts) > 6:
            raise FenError("a FEN has 4 to 6 fields: placement, turn, castling, en passant")
        rows = parts[0].split("/")
        if len(rows) != 8:
            raise FenError("the placement needs 8 ranks")
        board: list[str | None] = [None] * 64
        for i, row in enumerate(rows):
            r, f = 7 - i, 0
            for ch in row:
                if ch.isdigit():
                    f += int(ch)
                elif ch.upper() in KINDS:
                    if f > 7:
                        raise FenError(f"rank {r + 1} has more than 8 squares")
                    if ch.upper() == "P" and r in (0, 7):
                        raise FenError("a pawn cannot stand on the first or last rank")
                    board[f + 8 * r] = ch
                    f += 1
                else:
                    raise FenError(f"{ch!r} is not a piece")
            if f != 8:
                raise FenError(f"rank {r + 1} has {f} squares, not 8")
        if board.count("K") != 1 or board.count("k") != 1:
            raise FenError("each side needs exactly one king")
        turn = parts[1]
        if turn not in ("w", "b"):
            raise FenError("the side to move is w or b")
        castling = "" if parts[2] == "-" else parts[2]
        if any(c not in "KQkq" for c in castling) or len(set(castling)) != len(castling):
            raise FenError("castling rights are some of KQkq, or -")
        ep = None
        if parts[3] != "-":
            try:
                ep = square(parts[3])
            except ValueError as exc:
                raise FenError(f"{parts[3]!r} is not an en passant square") from exc
            if (ep >> 3) != (5 if turn == "w" else 2):
                raise FenError("the en passant square is on the third or sixth rank")
        try:
            half = int(parts[4]) if len(parts) > 4 else 0
            full = int(parts[5]) if len(parts) > 5 else 1
        except ValueError as exc:
            raise FenError("the move counters are numbers") from exc
        # Rights a position cannot have (the king or rook is not home) are dropped.
        homes = {"K": (4, 7, "K", "R"), "Q": (4, 0, "K", "R"), "k": (60, 63, "k", "r"), "q": (60, 56, "k", "r")}
        castling = "".join(
            c for c in "KQkq" if c in castling and board[homes[c][0]] == homes[c][2] and board[homes[c][1]] == homes[c][3]
        )
        return cls(tuple(board), turn, castling, ep, half, full)

    def fen(self) -> str:
        rows = []
        for r in range(7, -1, -1):
            row, gap = "", 0
            for f in range(8):
                p = self.board[f + 8 * r]
                if p is None:
                    gap += 1
                else:
                    row += (str(gap) if gap else "") + p
                    gap = 0
            rows.append(row + (str(gap) if gap else ""))
        ep = sq_name(self.ep) if self.ep is not None else "-"
        return f"{'/'.join(rows)} {self.turn} {self.castling or '-'} {ep} {self.halfmove} {self.fullmove}"

    # ── Reading the board ──

    def piece_at(self, s: int) -> str | None:
        return self.board[s]

    def king(self, color: str) -> int:
        return self.board.index("K" if color == "w" else "k")

    def attacked(self, s: int, by: str) -> bool:
        """Whether a piece of *by* attacks square *s*."""
        b = self.board
        f, r = s & 7, s >> 3
        if by == "w":
            if r > 0 and ((f > 0 and b[s - 9] == "P") or (f < 7 and b[s - 7] == "P")):
                return True
            n, k, straight, diagonal = "N", "K", "RQ", "BQ"
        else:
            if r < 7 and ((f > 0 and b[s + 7] == "p") or (f < 7 and b[s + 9] == "p")):
                return True
            n, k, straight, diagonal = "n", "k", "rq", "bq"
        if any(b[t] == n for t in KNIGHT[s]) or any(b[t] == k for t in KING[s]):
            return True
        for rays, hit in ((ROOK_RAYS[s], straight), (BISHOP_RAYS[s], diagonal)):
            for ray in rays:
                for t in ray:
                    p = b[t]
                    if p is not None:
                        if p in hit:
                            return True
                        break
        return False

    def attackers(self, s: int, by: str) -> list[int]:
        """The squares of *by*'s pieces that attack *s*."""
        out = []
        for t, p in enumerate(self.board):
            if p is not None and color_of(p) == by and self._reaches(t, s):
                out.append(t)
        return out

    def _reaches(self, frm: int, to: int) -> bool:
        """Whether the piece on *frm* attacks *to* (pins and checks aside)."""
        p = self.board[frm]
        if p is None or frm == to:
            return False
        kind = p.upper()
        df, dr = (to & 7) - (frm & 7), (to >> 3) - (frm >> 3)
        if kind == "P":
            return abs(df) == 1 and dr == (1 if p == "P" else -1)
        if kind == "N":
            return to in KNIGHT[frm]
        if kind == "K":
            return to in KING[frm]
        path = between(frm, to)
        if path is None:
            return False
        straight = df == 0 or dr == 0
        if (kind == "R" and not straight) or (kind == "B" and straight):
            return False
        return all(self.board[t] is None for t in path)

    def in_check(self, color: str | None = None) -> bool:
        color = color or self.turn
        return self.attacked(self.king(color), other(color))

    # ── Moves ──

    def pseudo_moves(self) -> list[Move]:
        """Every move the pieces make, before asking whether it leaves the king in check."""
        b, us = self.board, self.turn
        out: list[Move] = []
        for s, p in enumerate(b):
            if p is None or color_of(p) != us:
                continue
            kind = p.upper()
            if kind == "P":
                self._pawn_moves(s, out)
                continue
            if kind == "N" or kind == "K":
                targets: list[int] = list((KNIGHT if kind == "N" else KING)[s])
            else:
                rays = (ROOK_RAYS[s] if kind == "R" else BISHOP_RAYS[s] if kind == "B"
                        else ROOK_RAYS[s] + BISHOP_RAYS[s])
                targets = []
                for ray in rays:
                    for t in ray:
                        targets.append(t)
                        if b[t] is not None:
                            break
            for t in targets:
                q = b[t]
                if q is None:
                    out.append(Move(s, t, kind))
                elif color_of(q) != us:
                    out.append(Move(s, t, kind, captured=q.upper()))
            if kind == "K":
                self._castles(s, out)
        return out

    def _pawn_moves(self, s: int, out: list[Move]) -> None:
        b, us = self.board, self.turn
        fwd, start, last = (8, 1, 7) if us == "w" else (-8, 6, 0)
        f, r = s & 7, s >> 3

        def add(t: int, captured: str | None = None, ep: bool = False) -> None:
            if t >> 3 == last:
                out.extend(Move(s, t, "P", captured, promo) for promo in PROMOTIONS)
            else:
                out.append(Move(s, t, "P", captured, ep=ep))

        t = s + fwd
        if 0 <= t < 64 and b[t] is None:
            add(t)
            if r == start and b[t + fwd] is None:
                out.append(Move(s, t + fwd, "P"))
        for df in (-1, 1):
            if not 0 <= f + df < 8:
                continue
            t = s + fwd + df
            if not 0 <= t < 64:
                continue
            q = b[t]
            if q is not None and color_of(q) != us:
                add(t, q.upper())
            elif q is None and t == self.ep and b[t - fwd] == ("p" if us == "w" else "P"):
                add(t, "P", ep=True)

    def _castles(self, s: int, out: list[Move]) -> None:
        us, them = self.turn, other(self.turn)
        home = 4 if us == "w" else 60
        rook = "R" if us == "w" else "r"
        if s != home or self.attacked(s, them):
            return
        b = self.board
        king_side, queen_side = ("K", "Q") if us == "w" else ("k", "q")
        if (king_side in self.castling and b[home + 3] == rook and b[home + 1] is None and b[home + 2] is None
                and not self.attacked(home + 1, them) and not self.attacked(home + 2, them)):
            out.append(Move(home, home + 2, "K", castle="K"))
        if (queen_side in self.castling and b[home - 4] == rook and b[home - 1] is None and b[home - 2] is None
                and b[home - 3] is None and not self.attacked(home - 1, them) and not self.attacked(home - 2, them)):
            out.append(Move(home, home - 2, "K", castle="Q"))

    def leaves_king_safe(self, m: Move) -> bool:
        after = self.play(m)
        ks = m.to if m.piece == "K" else self.king(self.turn)
        return not after.attacked(ks, other(self.turn))

    @cached_property
    def _legal(self) -> tuple[Move, ...]:
        return tuple(m for m in self.pseudo_moves() if self.leaves_king_safe(m))

    def legal_moves(self) -> list[Move]:
        return list(self._legal)

    def is_checkmate(self) -> bool:
        return self.in_check() and not self._legal

    def is_stalemate(self) -> bool:
        return not self.in_check() and not self._legal

    def play(self, m: Move) -> Position:
        """The position after *m* (which is trusted to be a move of this position)."""
        b = list(self.board)
        us = self.turn
        p = b[m.frm]
        if p is None:
            raise ValueError(f"no piece on {sq_name(m.frm)}")
        b[m.frm] = None
        if m.ep:
            b[m.to - (8 if us == "w" else -8)] = None
        if m.promo:
            p = m.promo if us == "w" else m.promo.lower()
        b[m.to] = p
        home = 4 if us == "w" else 60
        if m.castle == "K":
            b[home + 1], b[home + 3] = b[home + 3], None
        elif m.castle == "Q":
            b[home - 1], b[home - 4] = b[home - 4], None
        rights = self.castling
        if m.piece == "K":
            rights = rights.replace("K" if us == "w" else "k", "").replace("Q" if us == "w" else "q", "")
        for corner, right in ((0, "Q"), (7, "K"), (56, "q"), (63, "k")):
            if corner in (m.frm, m.to):
                rights = rights.replace(right, "")
        ep = (m.frm + m.to) // 2 if m.piece == "P" and abs(m.to - m.frm) == 16 else None
        half = 0 if m.piece == "P" or m.captured else self.halfmove + 1
        full = self.fullmove + (1 if us == "b" else 0)
        return Position(tuple(b), other(us), rights, ep, half, full)

    # ── Notation ──

    def san(self, m: Move) -> str:
        """*m* in standard algebraic notation: `Nbd2`, `exd6`, `e8=Q+`, `O-O`, `Re8#`."""
        base = self._san_base(m)
        after = self.play(m)
        if after.in_check():
            return base + ("#" if not after._legal else "+")
        return base

    def _san_base(self, m: Move) -> str:
        if m.castle:
            return "O-O" if m.castle == "K" else "O-O-O"
        to = sq_name(m.to)
        if m.piece == "P":
            s = f"{FILES[m.frm & 7]}x{to}" if m.captured else to
            return s + (f"={m.promo}" if m.promo else "")
        rivals = [o.frm for o in self._legal if o.piece == m.piece and o.to == m.to and o.frm != m.frm]
        dis = ""
        if rivals:
            if all((r & 7) != (m.frm & 7) for r in rivals):
                dis = FILES[m.frm & 7]
            elif all((r >> 3) != (m.frm >> 3) for r in rivals):
                dis = str((m.frm >> 3) + 1)
            else:
                dis = sq_name(m.frm)
        return f"{m.piece}{dis}{'x' if m.captured else ''}{to}"

    def describe(self, m: Move, check: bool | None = None) -> str:
        """*m* in plain words: `rook e1 to e8, check`, `pawn e5 takes pawn d5 en passant, landing on d6`."""
        if check is None:
            check = self.play(m).in_check()
        if m.castle:
            home = 4 if self.turn == "w" else 60
            rook_from, rook_to = (home + 3, home + 1) if m.castle == "K" else (home - 4, home - 1)
            side = "kingside" if m.castle == "K" else "queenside"
            text = (f"castle {side}: king {sq_name(m.frm)} to {sq_name(m.to)}, "
                    f"rook {sq_name(rook_from)} to {sq_name(rook_to)}")
        elif m.ep:
            beside = m.to - (8 if self.turn == "w" else -8)
            text = f"pawn {sq_name(m.frm)} takes pawn {sq_name(beside)} en passant, landing on {sq_name(m.to)}"
        elif m.captured:
            text = f"{NAMES[m.piece]} {sq_name(m.frm)} takes {NAMES[m.captured]} {sq_name(m.to)}"
        else:
            text = f"{NAMES[m.piece]} {sq_name(m.frm)} to {sq_name(m.to)}"
        if m.promo:
            text += f", promotes to a {NAMES[m.promo]}"
        return text + (", check" if check else "")

    def pieces_words(self, color: str) -> str:
        """Every piece of *color* with its square: `king g1, rooks a1, e1, pawns f2, g2, h2`."""
        parts = []
        for kind in KINDS:
            letter = kind if color == "w" else kind.lower()
            where = sorted(sq_name(s) for s, p in enumerate(self.board) if p == letter)
            if where:
                parts.append(f"{(NAMES if len(where) == 1 else PLURALS)[kind]} {', '.join(where)}")
        return ", ".join(parts)

    def find(self, uci: str) -> Move | None:
        return next((m for m in self._legal if m.uci == uci), None)


def neutral(san: str) -> str:
    """A SAN that says check but never mate: what a player may be shown."""
    return san.replace("#", "+")


def perft(pos: Position, depth: int) -> int:
    """The number of move sequences *depth* plies long: the standard proof of a move generator."""
    if depth == 0:
        return 1
    moves = pos.legal_moves()
    if depth == 1:
        return len(moves)
    return sum(perft(pos.play(m), depth - 1) for m in moves)


def mates_in_one(pos: Position) -> list[Move]:
    """Every legal move that checkmates at once."""
    return [m for m in pos.legal_moves() if pos.play(m).is_checkmate()]


# ── Reading a move a player typed ─────────────────────────────────────────────


@dataclass(frozen=True)
class Parsed:
    """What a typed move came to: the legal move it names, or why it names none."""

    move: Move | None
    #: Why it is not a legal move, in words, when `move` is None.
    foul: str | None = None
    #: The squares the text named, when it named them (for drawing a foul).
    frm: int | None = None
    to: int | None = None


_DASHES = str.maketrans({c: "-" for c in "‐‑‒–—―−"})
_STRIP = str.maketrans({c: None for c in "*_`\"'“”‘’()[]{}<>"})
_CASTLE = re.compile(r"^[O0o]-?[O0o](-?[O0o])?$")
_LONG = re.compile(r"^([KQRBNP])?([a-h][1-8])[-x:]?([a-h][1-8])=?([QRBNqrbn])?$")
_SAN = re.compile(r"^([KQRBNP])?([a-h])?([1-8])?[x:]?([a-h][1-8])=?([QRBNqrbn])?$")


def clean_move_text(text: str | None) -> str:
    """The one token a reply's move line means: `**23... Re8#!**` → `Re8`."""
    t = unicodedata.normalize("NFKC", text or "").translate(_DASHES).translate(_STRIP).strip()
    t = t.replace("×", "x")
    t = re.sub(r"^\d+\s*\.+\s*", "", t)
    words = t.split()
    t = words[0] if words else ""
    t = t.rstrip("+#!?.,;:")
    t = re.sub(r"(?<=[1-8QRBNqrbn])e\.?p\.?$", "", t)
    return t.rstrip("+#!?.,;:")


def parse_move(pos: Position, text: str | None) -> Parsed:
    """The legal move *text* names in *pos*, or a foul saying why there is none."""
    raw = " ".join((text or "").split())
    t = clean_move_text(text)
    if not t:
        return Parsed(None, "no move was named")
    if _CASTLE.match(t):
        return _castle(pos, "Q" if t.count("-") == 2 or len(t.replace("-", "")) == 3 else "K")
    tries = [t]
    if t[0] in "kqrbn" and len(t) > 2:
        tries.append(t[0].upper() + t[1:])  # `qh7` for Qh7; `bxc3` stays a pawn first
    first: Parsed | None = None
    for cand in tries:
        got = _parse_long(pos, cand) if _LONG.match(cand) else _parse_san(pos, cand) if _SAN.match(cand) else None
        if got is None:
            continue
        if got.move is not None:
            return got
        first = first or got
    if first is not None:
        return first
    shown = raw if len(raw) <= 40 else raw[:39] + "…"
    return Parsed(None, f"“{shown}” is not a move in algebraic notation (write it like Re8, exd5, O-O or e7e8q)")


def _who(pos: Position) -> str:
    return COLORS[pos.turn]


def _pick(pos: Position, legal: list[Move], promo: str | None, frm: int | None, to: int) -> Parsed:
    """One legal move out of the candidates, minding promotion; or why not."""
    promo = promo.upper() if promo else None
    promoting = [m for m in legal if m.promo]
    if promoting:
        if not promo:
            return Parsed(None, f"a pawn reaching {sq_name(to)} must promote: write {sq_name(to)}=Q, "
                                f"{sq_name(to)}=R, {sq_name(to)}=B or {sq_name(to)}=N", frm, to)
        legal = [m for m in promoting if m.promo == promo]
    elif promo:
        return Parsed(None, "only a pawn reaching the last rank can promote", frm, to)
    if len(legal) == 1:
        return Parsed(legal[0], None, legal[0].frm, to)
    names = " or ".join(dict.fromkeys(neutral(pos.san(m)).rstrip("+") for m in legal))
    kind = NAMES[legal[0].piece]
    return Parsed(None, f"ambiguous: that could be {names}; say which {kind}", frm, to)


def _unsafe(pos: Position, moves: list[Move]) -> str:
    """Why moves that the pieces can make are still not legal: the king."""
    m = moves[0]
    if pos.in_check():
        return "your king is in check, and that move does not get it out of check"
    if m.piece == "K":
        return f"your king cannot move to {sq_name(m.to)}: that square is attacked"
    return f"that move leaves your king in check: the {NAMES[m.piece]} on {sq_name(m.frm)} is pinned"


def _blocked(pos: Position, frm: int, to: int) -> str | None:
    """`the pawn on e4 is in the way`, when a line piece's path is what stops it."""
    p = pos.board[frm]
    if p is not None and p == ("P" if pos.turn == "w" else "p"):
        fwd = 8 if p == "P" else -8
        if (frm & 7) != (to & 7) or (to - frm) not in (fwd, 2 * fwd):
            return None
        for s in (frm + fwd, to) if to - frm == 2 * fwd else (to,):
            if (q := pos.board[s]) is not None:
                return f"the {NAMES[q.upper()]} on {sq_name(s)} is in the way"
        return None
    if p is None or p.upper() not in "QRB":
        return None
    path = between(frm, to)
    if path is None:
        return None
    straight = (frm & 7) == (to & 7) or (frm >> 3) == (to >> 3)
    if (p.upper() == "R" and not straight) or (p.upper() == "B" and straight):
        return None
    for s in path:
        q = pos.board[s]
        if q is not None:
            return f"the {NAMES[q.upper()]} on {sq_name(s)} is in the way"
    return None


def _cannot(pos: Position, frm: int, to: int) -> str:
    p = pos.board[frm]
    assert p is not None
    what = f"the {NAMES[p.upper()]} on {sq_name(frm)}"
    why = _blocked(pos, frm, to)
    return f"{what} cannot reach {sq_name(to)}" + (f": {why}" if why else "")


def _own_there(pos: Position, to: int) -> str | None:
    q = pos.board[to]
    if q is not None and color_of(q) == pos.turn:
        return f"{sq_name(to)} holds your own {NAMES[q.upper()]}"
    return None


def _parse_long(pos: Position, t: str) -> Parsed:
    m = _LONG.match(t)
    assert m is not None
    letter, frm_s, to_s, promo = m.groups()
    frm, to = square(frm_s), square(to_s)
    p = pos.board[frm]
    if p is None:
        return Parsed(None, f"there is no piece on {frm_s}", frm, to)
    if color_of(p) != pos.turn:
        return Parsed(None, f"the piece on {frm_s} is {COLORS[color_of(p)]}’s {NAMES[p.upper()]}; "
                            f"it is {_who(pos)} to move", frm, to)
    if letter and letter != p.upper():
        return Parsed(None, f"the piece on {frm_s} is a {NAMES[p.upper()]}, not a {NAMES[letter]}", frm, to)
    legal = [x for x in pos.legal_moves() if x.frm == frm and x.to == to]
    if legal:
        return _pick(pos, legal, promo, frm, to)
    pseudo = [x for x in pos.pseudo_moves() if x.frm == frm and x.to == to]
    if pseudo:
        return Parsed(None, _unsafe(pos, pseudo), frm, to)
    if p.upper() == "K" and abs(to - frm) == 2 and (frm >> 3) == (to >> 3):
        got = _castle(pos, "K" if to > frm else "Q")
        return Parsed(got.move, got.foul, frm, to)
    return Parsed(None, _own_there(pos, to) or _cannot(pos, frm, to), frm, to)


def _parse_san(pos: Position, t: str) -> Parsed:
    m = _SAN.match(t)
    assert m is not None
    letter, file_s, rank_s, to_s, promo = m.groups()
    kind = letter or "P"
    to = square(to_s)
    mine = kind if pos.turn == "w" else kind.lower()
    own = [s for s, p in enumerate(pos.board) if p == mine]
    who = _who(pos)
    if not own:
        return Parsed(None, f"{who} has no {NAMES[kind]}" + ("s" if kind == "P" else ""), None, to)
    fits = [s for s in own if (not file_s or FILES[s & 7] == file_s) and (not rank_s or str((s >> 3) + 1) == rank_s)]
    if not fits:
        where = f"on {file_s}{rank_s}" if file_s and rank_s else f"on the {file_s}-file" if file_s else f"on rank {rank_s}"
        return Parsed(None, f"{who} has no {NAMES[kind]} {where}", None, to)
    frm = fits[0] if len(fits) == 1 else None
    legal = [x for x in pos.legal_moves() if x.piece == kind and x.to == to and x.frm in fits and not x.castle]
    if legal:
        return _pick(pos, legal, promo, frm, to)
    pseudo = [x for x in pos.pseudo_moves() if x.piece == kind and x.to == to and x.frm in fits and not x.castle]
    if pseudo:
        return Parsed(None, _unsafe(pos, pseudo), pseudo[0].frm, to)
    if own_there := _own_there(pos, to):
        return Parsed(None, own_there, frm, to)
    if frm is not None:
        return Parsed(None, _cannot(pos, frm, to), frm, to)
    return Parsed(None, f"no {who} {NAMES[kind]} can reach {to_s}", None, to)


def _castle(pos: Position, side: str) -> Parsed:
    name = "kingside" if side == "K" else "queenside"
    for m in pos.legal_moves():
        if m.castle == side:
            return Parsed(m, None, m.frm, m.to)
    us = pos.turn
    right = side if us == "w" else side.lower()
    home = 4 if us == "w" else 60
    if right not in pos.castling:
        return Parsed(None, f"{COLORS[us]} can no longer castle {name}: the king or that rook has moved")
    if pos.in_check():
        return Parsed(None, "you cannot castle while your king is in check", home)
    gap = (home + 1, home + 2) if side == "K" else (home - 1, home - 2, home - 3)
    if any(pos.board[s] is not None for s in gap):
        return Parsed(None, f"you cannot castle {name}: there are pieces between the king and the rook", home)
    return Parsed(None, f"you cannot castle {name}: the king would cross or land on an attacked square", home)
