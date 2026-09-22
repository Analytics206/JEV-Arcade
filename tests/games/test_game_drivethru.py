"""Drive-Thru: cars on a clock, windows on queues, orders as typed function calls."""
from __future__ import annotations

import asyncio

from wikirace.games import drivethru as D
from wikirace.providers.base import Completion

from .conftest import choice_answer, noul_answer

FAST = {"count": 12, "interval_ms": 100, "patience_ms": 30_000, "seed": 7}
ORDERS = D.data()["orders"]
GOLD = {o["said"]: o for o in ORDERS}


def item_and_mod(rest: str) -> tuple[str, str]:
    item = next(i for i in D.menu() if rest.startswith(f"{i}_"))
    return item, rest[len(item) + 1:]


def jev_knows(size_conf: float = 0.9):
    """Jev, sure of every argument of every order (its sizes only *size_conf* sure)."""
    def answer(qid, q, state):
        o = GOLD[state["customer_said"]]
        lines = o["lines"]

        def pick(want: str, confidence: float):
            ids = q["criteria"]
            best = next(oid for oid, d in ids.items() if d.startswith(f"{want}:"))
            rest = 0.1 / (len(ids) - 1)
            return choice_answer({oid: 0.9 if oid == best else rest for oid in ids}, confidence)

        if qid.startswith("qty_"):
            item = qid[4:]
            return pick(str(sum(ln["qty"] for ln in lines if ln["item"] == item)), 0.95)
        if qid.startswith("size_"):
            item = qid[5:]
            sizes = {ln["size"] for ln in lines if ln["item"] == item}
            return pick(sizes.pop() if sizes else "none", size_conf)
        if qid.startswith("mod_"):
            item, mod = item_and_mod(qid[4:])
            return noul_answer(0.95 if any(mod in ln["mods"] for ln in lines if ln["item"] == item) else 0.03)
        if qid.startswith("split_"):
            return noul_answer(0.95 if sum(ln["item"] == qid[6:] for ln in lines) > 1 else 0.04)
        assert qid == "off_menu"
        return noul_answer(0.96 if o["off_menu"] else 0.02)
    return answer


def till(o: dict) -> str:
    """The order rung up as the format asks, right."""
    rows = [f"ITEM: {ln['item']} | QTY: {ln['qty']} | SIZE: {ln['size'] or '-'} | MODS: {', '.join(ln['mods']) or '-'}"
            for ln in o["lines"]]
    if o["off_menu"]:
        rows.append(f"CLARIFY: {o['off_menu']}")
    return "\n".join([*rows, "DONE"])


def customer(prompt: str) -> str:
    return prompt.split('"', 1)[1].rsplit('"', 1)[0]


def best_points(o: dict) -> int:
    return 3 + len(D._keyed(o["lines"])) + (1 if o["off_menu"] else 0)


def test_every_gold_ticket_is_on_the_menu_and_exact_against_itself():
    assert len(ORDERS) >= 30 and len(GOLD) == len(ORDERS)
    assert 6 <= len(D.menu()) <= 8
    assert sum(bool(o["off_menu"]) for o in ORDERS) >= 2 and sum(bool(o["change"]) for o in ORDERS) >= 5
    for o in ORDERS:
        assert not o["change"] or o["change"] in o["said"]
        for ln in o["lines"]:
            it = D.menu()[ln["item"]]
            assert (ln["size"] in it["sizes"]) if it["sizes"] else ln["size"] is None
            assert set(ln["mods"]) <= set(it["mods"]) and 1 <= ln["qty"] <= D.QTY_MAX
        v = D.judge(o["lines"], bool(o["off_menu"]), o["lines"], bool(o["off_menu"]))
        assert v["exact"] and v["points"] == best_points(o) and v["fields_right"] == v["fields_total"]
        # …and a text model that rings it up as asked reads back to the same order.
        lines, fouls, clarify = D.read_order(till(o))
        assert not fouls and D._keyed(lines) == D._keyed(o["lines"]) and (clarify is not None) == bool(o["off_menu"])


def test_one_request_asks_every_argument_as_a_closed_question():
    qs, ids = D.jev_questions("seed")
    assert len(qs) <= 24  # one TypeSafe request
    assert {q["type"] for q in qs.values()} == {"choice", "noul"}
    assert len([k for k in qs if k.startswith("qty_")]) == len(D.menu())
    assert set(ids["qty_burger"].values()) == {"0", "1", "2", "3", "4"}
    assert set(ids["size_cola"].values()) == {"none", "small", "medium", "large"}
    assert all(k.startswith("n") for k in ids["qty_burger"]) and all(k.startswith("z") for k in ids["size_fries"])
    assert "customer_said" in qs["off_menu"]["instructions"] and "customer_said" in qs["qty_fries"]["instructions"]["question"]
    assert "split_cheeseburger" in qs and "split_fries" not in qs


def test_scoring_an_order():
    gold = ORDERS[0]["lines"]  # two cheeseburgers (one no pickles), large fries, medium Coke
    ok = D.judge(gold, False, gold, False)
    assert ok["exact"] and ok["points"] == 3 + 4
    # Every modifier on both cheeseburgers and the wrong size of Coke: two items wrong, one line right.
    v = D.judge([{"item": "cheeseburger", "qty": 2, "size": None, "mods": ["no_pickles"]},
                 {"item": "fries", "qty": 1, "size": "large", "mods": []},
                 {"item": "cola", "qty": 1, "size": "large", "mods": []}], False, gold, False)
    assert (v["exact"], v["right"], v["errors"], v["points"]) == (False, 1, 3, 1 - 3)
    # An off-menu request asked about scores; missed, it costs; a foul costs and spoils the exact.
    fries = [{"item": "fries", "qty": 1, "size": "medium", "mods": []}]
    assert D.judge(fries, True, fries, True)["points"] == 3 + 1 + 1
    assert D.judge(fries, False, fries, True)["points"] == 1 - 1
    assert D.judge(fries, False, fries, False, fouls=1) == {**D.judge(fries, False, fries, False), "exact": False,
                                                            "points": 1 - 1}


def test_a_text_models_till_lines_and_its_fouls():
    lines, fouls, clarify = D.read_order(
        "Sure!\n**ITEM:** Cheeseburger | QTY: two | SIZE: - | MODS: no pickles\n"
        "ITEM: Coke | QTY: 1 | SIZE: Large | MODS: -\n"
        "ITEM: onion rings | QTY: 1 | SIZE: - | MODS: -\n"
        "ITEM: burger | QTY: 1 | SIZE: large | MODS: -\n"
        "ITEM: fries | QTY: 1 | SIZE: - | MODS: no ketchup\n"
        "ITEM: milkshake | QTY: 0 | SIZE: small | MODS: -\n"
        "CLARIFY: -\nDONE")
    assert lines == [{"item": "cheeseburger", "qty": 2, "size": None, "mods": ["no_pickles"]},
                     {"item": "cola", "qty": 1, "size": "large", "mods": []}]
    assert [f["why"] for f in fouls] == ["“onion rings” is not on the menu", "the burger has no size “large”",
                                         "“no ketchup” is not a modifier for the fries"]
    assert clarify is None
    lines, fouls, clarify = D.read_order("ITEM: fries | QTY: 1 | SIZE: - | MODS: -\nCLARIFY: onion rings\nDONE")
    assert lines == [{"item": "fries", "qty": 1, "size": "medium", "mods": []}] and clarify == "onion rings"
    # A model that copies the form's placeholder ("->") has said nothing, not fouled.
    lines, fouls, _ = D.read_order("ITEM: burger | QTY: 2 | SIZE: - | MODS: ->\nITEM: fries | QTY: 2 | SIZE: large | MODS: none\nDONE")
    assert fouls == [] and [ln["item"] for ln in lines] == ["burger", "fries"]


def test_assembling_jevs_answers_and_the_read_back():
    qs, ids = D.jev_questions("seed")
    said = ORDERS[0]["said"]
    answers = {qid: jev_knows(size_conf=0.6)(qid, q, {"customer_said": said}) for qid, q in qs.items()}
    t = D.assemble(answers, ids, readback=0.9)
    assert D._keyed(t["lines"]) == D._keyed(ORDERS[0]["lines"])
    assert t["confidence"] == 0.6 and t["least"]["kind"] == "size" and t["least"]["item"] == "fries"
    assert t["readback"] == "That's a large fries?"
    split = [ln for ln in t["lines"] if ln["item"] == "cheeseburger"]
    assert [ln["mods"] for ln in split] == [["no_pickles"], []] and split[0]["conf"]["split"] == 0.95
    assert D.assemble(answers, ids, readback=0.5)["readback"] is None
    assert D.readback_of({"kind": "size", "item": "cola", "value": "medium", "qty": 1}) == "That's a medium Coke?"
    assert D.readback_of({"kind": "size", "item": "fries", "value": "large", "qty": 2}) == "That's two large fries?"
    assert D.readback_of({"kind": "mod", "item": "burger", "mod": "no_pickles", "value": True}) == "No pickles on the burger?"
    assert D.readback_of({"kind": "qty", "item": "milkshake", "value": 0}) == "No milkshakes today?"


def test_jev_takes_every_order_exactly(arcade):
    arcade.jev.responder = jev_knows()
    r = arcade.start("drivethru", ["jev"], FAST)
    assert r.status_code == 201, r.text
    assert r.json()["gold"] is None and r.json()["cars"] == []
    run = arcade.wait(r.json()["id"])
    assert run["status"] == "finished"
    lane = run["lanes"][0]
    orders = [GOLD[c["said"]] for c in run["cars"]]
    assert lane["served"] == 12 and lane["exact"] == 12 and lane["dropped"] == 0 and lane["fouls"] == 0
    assert lane["score"] == sum(best_points(o) for o in orders)
    assert lane["fields_right"] == lane["fields_total"] and lane["readbacks"] == 0
    # One request per car, every argument in it, under opaque ids.
    assert len(arcade.jev.requests) == 12 and lane["calls"] == 12
    req = arcade.jev.requests[0]
    assert set(req["state"]) == {"customer_said"} and len(req["questions"]) == 23
    t = lane["tickets"][0]
    assert t["questions"] == 23 and t["requests"] == 1 and t["readback"] is None
    assert all(t["confidence"] >= 0.9 for t in lane["tickets"])
    assert run["gold"] == [{"lines": o["lines"], "off_menu": o["off_menu"]} for o in orders]


def test_an_unsure_size_is_read_back(arcade):
    arcade.jev.responder = jev_knows(size_conf=0.6)
    run = arcade.play("drivethru", ["jev"], FAST)
    lane = run["lanes"][0]
    sized = [t for t in lane["tickets"] if any(D.menu()[ln["item"]]["sizes"] for ln in t["lines"])]
    assert sized and lane["readbacks"] == len(sized) and lane["exact"] == 12
    assert all(t["least"]["kind"] == "size" and t["readback"] for t in sized)


def test_text_windows_ring_up_right_foul_or_miss(arcade):
    def reply(model, system, prompt):
        o = GOLD[customer(prompt)]
        if model == "test/a":
            return till(o)
        if model == "test/b":
            return till(o).replace("DONE", "ITEM: onion rings | QTY: 1 | SIZE: - | MODS: -\nDONE")
        return "Coming right up!"
    arcade.text.responder = reply
    run = arcade.play("drivethru", ["test/a", "test/b", "test/c"], FAST)
    good, foul, blank = run["lanes"]
    orders = [GOLD[c["said"]] for c in run["cars"]]
    assert good["exact"] == 12 and good["score"] == sum(best_points(o) for o in orders) and good["fouls"] == 0
    assert foul["fouls"] == 12 and foul["exact"] == 0 and foul["score"] == good["score"] - 12 * (3 + 1)
    assert blank["score"] < 0 and blank["exact"] == 0 and blank["fields_right"] < blank["fields_total"]
    assert all("onion rings" in t["fouls"][0]["line"] for t in foul["tickets"])
    system = arcade.text.prompts[0]["system"]
    assert "ITEM: <item> | QTY:" in system and "CLARIFY:" in system and "no_pickles" in system


def test_a_slow_window_loses_cars(arcade):
    class Slow:
        config = arcade.app.state.providers["openrouter"].config

        async def complete(self, model, system, prompt, **kw):
            await asyncio.sleep(0.4)
            return Completion(text=till(GOLD[customer(prompt)]), model=model, tokens_in=10, tokens_out=2)

        def context_limit(self, model):
            return None

        async def aclose(self):
            return None

    arcade.app.state.providers["openrouter"] = Slow()
    arcade.jev.responder = jev_knows()
    run = arcade.play("drivethru", ["jev", "test/a"],
                      {"count": 10, "interval_ms": 100, "patience_ms": 2000, "seed": 3}, timeout=20)
    jev, slow = run["lanes"]
    assert jev["dropped"] == 0 and jev["served"] == 10
    assert slow["dropped"] > 0 and slow["served"] + slow["dropped"] == 10
    drove_off = [t for t in slow["tickets"] if t["status"] == "dropped"]
    assert all(t["points"] == -2 for t in drove_off) and slow["backlog"]
