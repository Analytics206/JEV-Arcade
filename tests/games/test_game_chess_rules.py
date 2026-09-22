"""Legal Moves Only's rules engine: move generation proven by perft, SAN, and
reading what a text model typed (with the reason when it is not a legal move)."""
from __future__ import annotations

import pytest

from wikirace.games.chess_rules import (
    START_FEN,
    FenError,
    Position,
    mates_in_one,
    neutral,
    parse_move,
    perft,
    square,
)

KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"


@pytest.mark.parametrize(("fen", "counts"), [
    (START_FEN, [20, 400, 8902]),
    (KIWIPETE, [48, 2039]),
    # en passant that would expose the king along the rank, and pins
    ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", [14, 191, 2812]),
    # promotions with capture, castling rights lost to a capture
    ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", [6, 264]),
    ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", [44, 1486]),
])
def test_perft_counts_every_legal_move(fen, counts):
    pos = Position.from_fen(fen)
    assert [perft(pos, d) for d in range(1, len(counts) + 1)] == counts


def test_fen_round_trips_and_rejects_nonsense():
    for fen in (START_FEN, KIWIPETE, "3rkr2/ppp2ppp/8/2NpP3/8/8/5PPP/4R1K1 w - d6 0 1"):
        assert Position.from_fen(fen).fen() == fen
    for bad in ("", "8/8/8/8/8/8/8/8 w - - 0 1", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1",
                "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", START_FEN.replace(" w ", " x "),
                "P3k3/8/8/8/8/8/8/4K3 w - - 0 1"):
        with pytest.raises(FenError):
            Position.from_fen(bad)
    # A right the pieces cannot have is dropped.
    assert Position.from_fen("4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1").castling == ""


def sans(fen: str) -> set[str]:
    pos = Position.from_fen(fen)
    return {pos.san(m) for m in pos.legal_moves()}


def test_san_disambiguates_and_marks_check_and_mate():
    assert {"e4", "Nf3", "Na3"} <= sans(START_FEN)
    got = sans("4k3/8/8/R7/8/8/8/RN2KN2 w - - 0 1")
    assert {"Nbd2", "Nfd2", "R1a3", "R5a3", "Ra8+"} <= got
    # Three queens reaching b2: a file, a rank, and the full square.
    got = sans("4k3/8/8/8/8/Q7/8/Q1Q1K3 w - - 0 1")
    assert {"Qa1b2", "Qcb2", "Q3b2"} <= got
    assert {"O-O", "O-O-O"} <= sans("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    assert "exd6#" in sans("3rkr2/ppp2ppp/8/2NpP3/8/8/5PPP/4R1K1 w - d6 0 1")
    assert {"c8=N#", "c8=Q", "c8=R", "c8=B"} <= sans("8/k1P5/pp6/4B3/8/5B2/8/6K1 w - - 0 1")
    assert neutral("Re8#") == "Re8+"


def test_mates_and_stalemate():
    pos = Position.from_fen("6k1/1bq2ppp/n7/8/8/3Q1N2/5PPP/4R1K1 w - - 0 1")
    assert [pos.san(m) for m in mates_in_one(pos)] == ["Re8#"]
    after = pos.play(pos.find("e1e8"))
    assert after.is_checkmate() and after.turn == "b"
    stale = Position.from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")
    assert stale.is_stalemate() and not stale.is_checkmate()


def test_play_moves_the_rook_when_castling_and_takes_en_passant():
    pos = Position.from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    after = pos.play(next(m for m in pos.legal_moves() if m.castle == "Q"))
    assert after.fen().startswith("r3k2r/8/8/8/8/8/8/2KR3R b kq ")
    pos = Position.from_fen("3rkr2/ppp2ppp/8/2NpP3/8/8/5PPP/4R1K1 w - d6 0 1")
    after = pos.play(pos.find("e5d6"))
    assert after.piece_at(square("d5")) is None and after.piece_at(square("d6")) == "P"


BACK_RANK = "6k1/1bq2ppp/n7/8/8/3Q1N2/5PPP/4R1K1 w - - 0 1"


@pytest.mark.parametrize("typed", [
    "Re8#", "Re8", "Re8+", "**Re8#**", "`Re8`", "1. Re8#", "23... Re8", "e1e8", "Re1-e8", "Re1e8",
    "Rxe8", "re8", "Re8# (mate)", "Re8!",
])
def test_a_typed_move_is_read_however_it_is_written(typed):
    got = parse_move(Position.from_fen(BACK_RANK), typed)
    assert got.move is not None and got.move.uci == "e1e8", got.foul


@pytest.mark.parametrize(("fen", "typed", "why"), [
    (BACK_RANK, "Qxf7#", "the queen on d3 cannot reach f7"),
    (BACK_RANK, "Bb5", "white has no bishop"),
    (BACK_RANK, "e4", "no white pawn can reach e4"),
    (BACK_RANK, "f2f4", "the pawn on f2 cannot reach f4: the knight on f3 is in the way"),
    (BACK_RANK, "Qd3d8", None),
    (BACK_RANK, "Qh3e6", "there is no piece on h3"),
    (BACK_RANK, "g8h8", "the piece on g8 is black’s king; it is white to move"),
    (BACK_RANK, "Rf1e8", "there is no piece on f1"),
    (BACK_RANK, "Qe1e8", "the piece on e1 is a rook, not a queen"),
    (BACK_RANK, "Re1-e9", "is not a move in algebraic notation"),
    (BACK_RANK, "rook to e8", "is not a move in algebraic notation"),
    (BACK_RANK, "O-O", "white can no longer castle kingside"),
    (BACK_RANK, "Rf2", "f2 holds your own pawn"),
    ("4k3/8/8/8/4r3/8/4N3/4K3 w - - 0 1", "Nc3", "that move leaves your king in check: the knight on e2 is pinned"),
    ("4k3/8/8/8/4r3/8/8/4K3 w - - 0 1", "Ke2", "your king is in check, and that move does not get it out"),
    ("4k3/8/8/8/5r2/8/8/4K3 w - - 0 1", "Kf2", "your king cannot move to f2: that square is attacked"),
    ("4k3/8/8/R7/8/8/8/RN2KN2 w - - 0 1", "Nd2", "ambiguous: that could be Nbd2 or Nfd2; say which knight"),
    ("4k3/8/8/R7/8/8/8/RN2KN2 w - - 0 1", "Ra3", "ambiguous"),
    ("8/k1P5/pp6/4B3/8/5B2/8/6K1 w - - 0 1", "c8", "must promote: write c8=Q, c8=R, c8=B or c8=N"),
    ("8/k1P5/pp6/4B3/8/5B2/8/6K1 w - - 0 1", "Bd4=Q", "only a pawn reaching the last rank can promote"),
    ("r3k2r/8/8/8/8/8/8/RN2K2R w KQkq - 0 1", "O-O-O", "there are pieces between the king and the rook"),
    ("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "O-O", None),
    ("r3k2r/8/8/8/2b5/8/8/R3K2R w KQkq - 0 1", "O-O", "the king would cross or land on an attacked square"),
    (BACK_RANK, "", "no move was named"),
])
def test_an_impossible_move_is_a_foul_with_a_reason(fen, typed, why):
    got = parse_move(Position.from_fen(fen), typed)
    if why is None:
        assert got.move is not None, got.foul
        return
    assert got.move is None and why in (got.foul or ""), got.foul


def test_every_way_of_writing_castling_promotion_and_en_passant():
    castle = Position.from_fen("8/8/8/5N2/3pp3/1P1k4/1P6/R3K1N1 w Q - 0 1")
    for typed in ("O-O-O", "0-0-0#", "o-o-o", "e1c1"):
        assert parse_move(castle, typed).move.castle == "Q", typed
    promo = Position.from_fen("8/k1P5/pp6/4B3/8/5B2/8/6K1 w - - 0 1")
    for typed in ("c8=N", "c8N", "c8=n#", "c7c8n", "c8(N)"):
        assert parse_move(promo, typed).move.promo == "N", typed
    ep = Position.from_fen("3rkr2/ppp2ppp/8/2NpP3/8/8/5PPP/4R1K1 w - d6 0 1")
    for typed in ("exd6", "exd6 e.p.", "exd6ep", "e5d6", "exd6#"):
        assert parse_move(ep, typed).move.ep, typed
    # A lower-case piece letter is forgiven; a pawn file stays a pawn first.
    pos = Position.from_fen("4k3/8/8/8/8/2p5/1P1B4/4K3 w - - 0 1")
    assert parse_move(pos, "bxc3").move.piece == "P"
    assert parse_move(pos, "bc3").move.piece == "P"
    assert parse_move(pos, "Bxc3").move.piece == "B"
    assert parse_move(pos, "qd8").foul == "white has no queen"
