"""Legal Moves Only: Jev picks from the legal moves; text models write theirs and can foul."""
from __future__ import annotations

import asyncio
import json
import re
import time

from wikirace.games import chess as C
from wikirace.games import runs
from wikirace.games.chess_rules import Position, mates_in_one, other
from wikirace.providers.base import Completion

from .conftest import choice_answer

FAST = {"count": 4, "seed": 11}


def by_state() -> dict[tuple[str, str, str], C.Study]:
    out = {}
    for pz in C.puzzles():
        st = C.study(pz["fen"])
        s = C.jev_state(st)
        out[(s["side_to_move"], s["white_pieces"], s["black_pieces"])] = st
    return out


STUDIES = by_state()


def jev_picks(which: str = "mate", p: float = 0.7):
    """Jev, putting *p* on a mating move (or on a check that does not mate)."""
    def answer(qid, q, state):
        st = STUDIES[(state["side_to_move"], state["white_pieces"], state["black_pieces"])]
        if which == "mate":
            want = {ln.shown for ln in st.mates}
        else:  # a check that is not mate, or, where there is none, any move that is not mate
            want = {ln.shown for ln in st.lines if ln.check and not ln.mate} or {
                ln.shown for ln in st.lines if not ln.mate}
        ids = q["criteria"]
        best = next((o for o, d in ids.items() if d.split(":", 1)[0] in want), next(iter(ids)))
        rest = (1 - p) / (len(ids) - 1)
        return choice_answer({o: p if o == best else rest for o in ids}, 0.6)
    return answer


def fen_of(prompt: str) -> Position:
    return Position.from_fen(re.search(r"^FEN: (.+)$", prompt, re.M).group(1))


def mate_san(prompt: str) -> str:
    pos = fen_of(prompt)
    return pos.san(mates_in_one(pos)[0])


# ── The puzzles ──


def test_every_puzzle_is_a_real_mate_in_one_and_its_key_is_the_engines():
    d = C.data()
    assert "WikiRace" in d["about"]
    ps = C.puzzles()
    assert len(ps) >= 16
    assert len({p["id"] for p in ps}) == len(ps)
    for p in ps:
        pos = Position.from_fen(p["fen"])
        # It is the side to move's turn: the other side is not left in check.
        assert not pos.in_check(other(pos.turn)), p["id"]
        assert not pos.in_check(), p["id"]
        mates = {pos.san(m) for m in mates_in_one(pos)}
        assert set(p["solutions"]) == mates, p["id"]
        assert 2 <= len(pos.legal_moves()) <= 218
        assert p["theme"] and p["idea"] and p["difficulty"] in (1, 2, 3)
    assert {"back-rank mate", "smothered mate", "promotion mate", "castling mate", "en passant mate"} <= {
        p["theme"] for p in ps}
    assert any(Position.from_fen(p["fen"]).turn == "b" for p in ps)


def test_jev_reads_the_position_in_words_and_never_sees_mate_marked():
    st = C.study(next(p["fen"] for p in C.puzzles() if p["id"] == "back-rank"))
    s = C.jev_state(st)
    assert s == {
        "side_to_move": "white",
        "white_pieces": "king g1, queen d3, rook e1, knight f3, pawns f2, g2, h2",
        "black_pieces": "king g8, queen c7, bishop b7, knight a6, pawns f7, g7, h7",
        "your_checks": "Re8+ (rook e1 to e8); Qd8+ (queen d3 to d8); Qxh7+ (queen d3 takes pawn h7)",
        "your_captures": "Qxh7+ takes the pawn on h7; Qxa6 takes the knight on a6",
    }
    assert "Re8+: rook e1 to e8, check" in {ln.meaning for ln in st.lines}
    assert all("#" not in ln.meaning for ln in st.lines)
    ep = C.jev_state(C.study(next(p["fen"] for p in C.puzzles() if p["id"] == "en-passant")))
    assert "exd6+ takes the pawn on d5 (en passant)" in ep["your_captures"]


def test_a_move_that_is_not_mate_says_why():
    st = C.study(next(p["fen"] for p in C.puzzles() if p["id"] == "back-rank"))
    ln = {x.shown: x for x in st.lines}
    assert C.not_mate(st, ln["Qxh7+"]) == "not mate: black answers Kxh7"
    assert C.not_mate(st, ln["h3"]) == "no check, so no mate"


def test_params_are_checked():
    assert C.Params().count == 8 and C.Params().strikes == 3 and C.Params().show_moves is False
    assert C.Params(count=len(C.puzzles())).count == len(C.puzzles())


def test_bad_params_are_a_422(arcade):
    assert arcade.start("chess", ["jev"], {"count": 0}).status_code == 422
    assert arcade.start("chess", ["jev"], {"strikes": 9}).status_code == 422


# ── Jev ──


def test_jev_is_asked_one_choice_over_every_legal_move_and_mates(arcade):
    arcade.jev.responder = jev_picks("mate", 0.7)
    run = arcade.play("chess", ["jev"], FAST)
    assert run["status"] == "finished"
    lane = run["lanes"][0]
    assert lane["solved"] == 4 and lane["score"] == 4 and lane["missed"] == 0 and lane["fouls"] == 0
    assert lane["calls"] == 4 and lane["cost"] > 0 and lane["at"] == 4
    assert len(arcade.jev.requests) == 4
    for k, req in enumerate(arcade.jev.requests):
        pz = run["puzzles"][k]
        (qid, q), = req["questions"].items()
        assert qid == "move" and q["type"] == "choice"
        assert len(q["criteria"]) == pz["legal"] == len(Position.from_fen(pz["fen"]).legal_moves())
        assert all(re.fullmatch(r"m\d+", o) for o in q["criteria"])
        assert all("#" not in d for d in q["criteria"].values())
        assert q["instructions"]["question"] == C.QUESTION
        assert "`your_checks`" in " ".join(q["instructions"]["rules"])
        # Words, not a FEN.
        assert req["state"] == pz["state"] and not any("/" in v for v in req["state"].values())
    res = lane["puzzles"]
    assert [r["puzzle"] for r in res] == [0, 1, 2, 3]
    for r in res:
        assert r["verdict"] == "solved" and r["move"].endswith("#") and r["p"] == 0.7
        assert len(r["top"]) == 5 and r["top"][0]["uci"] == r["uci"]
        assert {"san", "uci", "from", "to", "p"} <= set(r["top"][0])
        assert all("#" not in t["san"] for t in r["top"])
    # The key, revealed at the end, is the engine's.
    for k, entry in enumerate(run["key"]):
        pos = Position.from_fen(run["puzzles"][k]["fen"])
        assert {m["uci"] for m in entry["mates"]} == {m.uci for m in mates_in_one(pos)}


def test_jev_that_plays_a_check_that_is_not_mate_misses(arcade):
    arcade.jev.responder = jev_picks("check", 0.6)
    run = arcade.play("chess", ["jev"], {"count": 3, "seed": 5})
    lane = run["lanes"][0]
    assert lane["solved"] == 0 and lane["missed"] == 3 and lane["score"] == 0
    assert all(r["verdict"] == "missed" and r["note"] for r in lane["puzzles"])


def test_every_lane_plays_the_same_puzzles_in_the_same_order(arcade):
    arcade.jev.responder = jev_picks("mate")
    arcade.text.responder = lambda m, s, p: f"REASON: it mates.\nMOVE: {mate_san(p)}"
    run = arcade.play("chess", ["jev", "test/a"], {"count": 5, "seed": 3})
    again = arcade.play("chess", ["jev"], {"count": 5, "seed": 3})
    assert [p["id"] for p in run["puzzles"]] == [p["id"] for p in again["puzzles"]]
    jev, text = run["lanes"]
    assert [r["puzzle"] for r in jev["puzzles"]] == [r["puzzle"] for r in text["puzzles"]] == list(range(5))
    fens = [fen_of(p["prompt"]).fen() for p in arcade.text.prompts]
    assert fens == [p["fen"] for p in run["puzzles"]]


def test_an_answer_about_other_options_ends_the_lane_and_is_still_counted(arcade):
    arcade.jev.responder = lambda qid, q, state: choice_answer({"zz": 0.9, "yy": 0.1})
    run = arcade.play("chess", ["jev"], {"count": 2, "seed": 1})
    lane = run["lanes"][0]
    assert lane["status"] == "error" and "options it was not given" in lane["note"]
    assert lane["calls"] == 1 and lane["cost"] > 0
    assert run["status"] == "finished" and run["key"]


# ── Text models ──


def test_a_text_model_that_writes_the_mate_solves_in_san_or_uci(arcade):
    def reply(model, system, prompt):
        pos = fen_of(prompt)
        m = mates_in_one(pos)[0]
        said = m.uci if model == "test/b" else pos.san(m).rstrip("#")
        return f"REASON: the king has no square.\nMOVE: {said}"
    arcade.text.responder = reply
    run = arcade.play("chess", ["test/a", "test/b"], FAST)
    for lane in run["lanes"]:
        assert lane["solved"] == 4 and lane["fouls"] == 0 and lane["calls"] == 4 and lane["current"] is None
        assert all(r["reason"] == "the king has no square." for r in lane["puzzles"])
    system, prompt = arcade.text.prompts[0]["system"], arcade.text.prompts[0]["prompt"]
    assert "MOVE: <your move>" in system and "REASON:" in system and "3 fouls" in system
    assert prompt.startswith("PUZZLE 1 of 4.") and "FEN: " in prompt and "White: king" in prompt
    assert "LEGAL MOVES" not in prompt


def test_a_foul_is_explained_and_the_model_tries_again(arcade):
    def reply(model, system, prompt):
        if "FOUL" not in prompt:
            return "REASON: sacrifice.\nMOVE: Qxz9"  # not a square
        if prompt.count("FOUL:") == 1:
            return "MOVE: Kxe9"
        return f"MOVE: {mate_san(prompt)}"
    arcade.text.responder = reply
    run = arcade.play("chess", ["test/a"], {"count": 2, "seed": 1})
    lane = run["lanes"][0]
    assert lane["solved"] == 2 and lane["fouls"] == 4 and lane["calls"] == 6
    r = lane["puzzles"][0]
    assert r["verdict"] == "solved" and r["fouls"] == 2 and len(r["attempts"]) == 3
    assert "not a move in algebraic notation" in r["attempts"][0]["foul"]
    assert r["attempts"][0]["reason"] == "sacrifice."
    assert "san" in r["attempts"][2] and "foul" not in r["attempts"][2]
    retry = [p["prompt"] for p in arcade.text.prompts][1]
    assert "FOUL: “Qxz9”:" in retry and "Fouls on this puzzle: 1 of 3." in retry


def test_an_illegal_move_is_a_foul_with_the_reason_and_strikes_fail_the_puzzle(arcade):
    def reply(model, system, prompt):
        pos = fen_of(prompt)
        side = "white" if pos.turn == "w" else "black"
        return f"REASON: {side} wins.\nMOVE: Ka1" if pos.turn == "w" else "MOVE: Ka8"
    arcade.text.responder = reply
    run = arcade.play("chess", ["test/a"], {"count": 3, "seed": 2, "strikes": 2})
    lane = run["lanes"][0]
    assert lane["failed"] == 3 and lane["solved"] == 0 and lane["score"] == 0
    assert lane["fouls"] == 6 and lane["calls"] == 6
    for r in lane["puzzles"]:
        assert r["verdict"] == "failed" and r["fouls"] == 2 and r["move"] is None
        assert all(a["foul"] for a in r["attempts"])
    assert "2 fouls on one puzzle" in arcade.text.prompts[0]["system"]


def test_a_legal_move_that_does_not_mate_is_a_miss(arcade):
    def reply(model, system, prompt):
        pos = fen_of(prompt)
        mates = {m.uci for m in mates_in_one(pos)}
        quiet = next(m for m in pos.legal_moves() if m.uci not in mates)
        return f"MOVE: {pos.san(quiet)}"
    arcade.text.responder = reply
    run = arcade.play("chess", ["test/a"], {"count": 3, "seed": 4})
    lane = run["lanes"][0]
    assert lane["missed"] == 3 and lane["fouls"] == 0
    assert all(r["verdict"] == "missed" and "mate" in r["note"] for r in lane["puzzles"])


def test_show_moves_gives_text_models_the_legal_moves_without_mate_marks(arcade):
    arcade.text.responder = lambda m, s, p: f"MOVE: {mate_san(p)}"
    arcade.play("chess", ["test/a"], {"count": 2, "seed": 9, "show_moves": True})
    prompt = arcade.text.prompts[0]["prompt"]
    listed = re.search(r"LEGAL MOVES \((\d+)\): (.+)", prompt)
    assert listed and len(listed.group(2).split(", ")) == int(listed.group(1))
    assert "#" not in prompt


def test_the_answer_key_is_private_until_the_end(arcade):
    arcade.jev.responder = jev_picks("mate")
    r = arcade.start("chess", ["jev"], FAST)
    assert r.status_code == 201 and r.json()["key"] is None
    rid = r.json()["id"]
    run = arcade.wait(rid)
    events = [json.loads(e[6:]) for e in runs.get_live(rid).events]
    with_key = [i for i, e in enumerate(events) if e["type"] == "patch" and e["patch"].get("key")]
    assert with_key and with_key[0] > max(i for i, e in enumerate(events) if e["type"] == "lane_push")
    assert run["key"] and len(run["key"]) == 4 and run["key"][0]["idea"]


def test_a_stopped_run_stops_cleanly_and_still_reveals_the_key(arcade):
    class Slow:
        config = arcade.app.state.providers["openrouter"].config

        async def complete(self, model, system, prompt, **kw):
            await asyncio.sleep(0.3)
            return Completion(text=f"MOVE: {mate_san(prompt)}", model=model, tokens_in=10, tokens_out=2)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    arcade.jev.responder = jev_picks("mate")
    r = arcade.start("chess", ["jev", "test/a"], {"count": 8, "seed": 1})
    rid = r.json()["id"]
    for _ in range(250):  # until the slow lane has solved one
        if arcade.client.get(f"/api/games/runs/{rid}").json()["lanes"][1].get("solved"):
            break
        time.sleep(0.02)
    arcade.client.post(f"/api/games/runs/{rid}/stop")
    run = arcade.wait(rid)
    assert run["status"] == "stopped"
    jev, text = run["lanes"]
    assert jev["status"] == "done" and jev["solved"] == 8
    assert text["status"] == "stopped" and text["solved"] < 8
    assert run["key"] and len(run["key"]) == 8
