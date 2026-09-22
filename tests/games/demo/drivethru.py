"""Drive-Thru's stand-in players.

Jev hears most orders right and sure; now and then it is unsure of a size
(so the window reads it back) and, rarely, it mishears a quantity or misses a
"one of them" split. The text models ring most orders up right, now and then
get a size wrong or forget to ask about an off-menu request, and sometimes
foul: an item or modifier the menu does not have. They are slower anyway (the
demo server's delays), so the queue at their window grows.
"""
from __future__ import annotations

import random

from wikirace.games import drivethru as D

from . import choice, noul, spread

GOLD = {o["said"]: o for o in D.data()["orders"]}


def _item_and_mod(rest: str) -> tuple[str, str] | None:
    item = next((i for i in D.menu() if rest.startswith(f"{i}_")), None)
    return (item, rest[len(item) + 1:]) if item else None


def jev(qid, q, state):
    if not isinstance(state, dict) or "customer_said" not in state:
        return None
    o = GOLD.get(state["customer_said"])
    if o is None:
        return None
    lines = o["lines"]

    def pick(want: str, p: float):
        ids = list(q["criteria"])
        best = next((oid for oid, d in q["criteria"].items() if d.startswith(f"{want}:")), random.choice(ids))
        return choice(spread(best, ids, p))

    if qid.startswith("qty_"):
        item = qid[4:]
        n = sum(ln["qty"] for ln in lines if ln["item"] == item)
        if random.random() < 0.04 and n:
            n = max(0, min(D.QTY_MAX, n + random.choice([-1, 1])))
        return pick(str(n), random.uniform(0.93, 0.99))
    if qid.startswith("size_"):
        item = qid[5:]
        sizes = {ln["size"] for ln in lines if ln["item"] == item}
        want = sizes.pop() if sizes else "none"
        unsure = random.random() < 0.18 and want != "none"
        return pick(want, random.uniform(0.5, 0.62) if unsure else random.uniform(0.92, 0.98))
    if qid.startswith("mod_"):
        found = _item_and_mod(qid[4:])
        if found is None:
            return None
        item, mod = found
        yes = any(mod in ln["mods"] for ln in lines if ln["item"] == item)
        return noul(random.uniform(0.93, 0.99) if yes else random.uniform(0.01, 0.06))
    if qid.startswith("split_"):
        split = sum(ln["item"] == qid[6:] for ln in lines) > 1
        if random.random() < 0.06:
            split = not split
        return noul(random.uniform(0.9, 0.98) if split else random.uniform(0.02, 0.08))
    if qid == "off_menu":
        return noul(random.uniform(0.92, 0.99) if o["off_menu"] else random.uniform(0.01, 0.05))
    return None


def _row(ln: dict) -> str:
    return f"ITEM: {ln['item']} | QTY: {ln['qty']} | SIZE: {ln['size'] or '-'} | MODS: {', '.join(ln['mods']) or '-'}"


def text(model, system, prompt):
    if "work the window at a drive-thru" not in system or '"' not in prompt:
        return None
    o = GOLD.get(prompt.split('"', 1)[1].rsplit('"', 1)[0])
    if o is None:
        return "DONE"
    lines = [dict(ln) for ln in o["lines"]]
    extra: list[str] = []
    roll = random.random()
    if roll < 0.10:
        sized = [ln for ln in lines if ln["size"]]
        if sized:
            ln = random.choice(sized)
            ln["size"] = random.choice([s for s in D.data()["sizes"] if s != ln["size"]])
    elif roll < 0.17:
        extra.append(random.choice([
            "ITEM: onion rings | QTY: 1 | SIZE: - | MODS: -",
            "ITEM: burger | QTY: 1 | SIZE: regular | MODS: -",
            "ITEM: cola | QTY: 1 | SIZE: medium | MODS: extra_lemon",
        ]))
    rows = [_row(ln) for ln in lines] + extra
    if o["off_menu"] and random.random() > 0.2:
        rows.append(f"CLARIFY: {o['off_menu']}")
    return "\n".join([*rows, "DONE"])
