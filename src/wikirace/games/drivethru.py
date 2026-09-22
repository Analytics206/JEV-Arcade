"""Drive-Thru: orders in plain words, out as typed function calls.

TypeSafe's function-calling cookbook, at a drive-thru window. Cars pull up to
the speaker on a clock, one every `interval_ms`; each lane is one window
working its own queue, a car at a time, and a car that has waited longer than
`patience_ms` drives off.

**Jev** takes an order with ONE request carrying every argument of the till's
`add_item` call as a closed question (fan-out): for each menu item, how many
(a choice of 0 to 4); for each item with sizes, which size (none, small,
medium, large; none rings up the default); for each item's modifiers, a noul
("does the customer ask us to leave the pickles off their burger?"); for each
sandwich, a noul "only some of them changed?"; and a noul "asks for something
not on the menu". Code assembles the order from the answers (items with a
quantity of one or more), and the order is only as sure as its least sure
argument actually used (the cookbook's rule): every quantity, and the size,
modifiers and split of each item ordered. Under `readback` the window reads
that part back ("That's a medium Coke?"), on the ticket; no second round trip.

The per-unit simplification: when Jev says only some of an item were changed,
code puts every modifier it heard on ONE unit and the rest come as they are
("two cheeseburgers, one with no pickles"). An order where different units get
different modifiers cannot be told this way; the orders here avoid it. One
size per item per order, likewise.

**A text model** rings the order up itself, one line per item:
`ITEM: <item> | QTY: <n> | SIZE: <size or -> | MODS: <comma list or ->`, then
`DONE`, with `CLARIFY: <what>` for something not on the menu. An item or
modifier not on the menu, or a size the item does not have, is a foul (the
line is dropped).

Per order against its gold ticket: the exact order +3; each gold line right +1;
each item wrong or missing −1; the off-menu request asked about +1, missed or
imagined −1; each foul −1; a car that drove off −2. Field accuracy (quantity,
size and modifiers per item, and the off-menu flag) is kept beside the points.
"""
from __future__ import annotations

import asyncio
import json
import random
import re
import time
from collections import Counter
from collections.abc import Mapping, Sequence
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .core import choice, fold, match_option, noul, opaque, read_choice, read_field, read_noul
from .players import Player, ask_jev, ask_text
from .runs import GameRun

POINTS = {"exact": 3, "line": 1, "wrong": -1, "off_menu": 1, "foul": -1, "dropped": -2}
QTY_MAX = 4
WORDS = ("no", "one", "two", "three", "four")
#: How often each lane's queue length is sampled, for the page.
_SAMPLE_S = 0.5
_BLANK = {"", "-", "none", "n/a", "na", "no", "nothing", "no size", "no mods", "default", "regular size"}


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "drivethru.json", encoding="utf-8") as f:
        return json.load(f)


def menu() -> dict[str, dict[str, Any]]:
    return data()["menu"]


def mods() -> dict[str, dict[str, str]]:
    return data()["mods"]


def default_size() -> str:
    return str(data()["default_size"])


def listing() -> str:
    """The menu in a line, as Jev reads it."""
    return ", ".join(f"{it['name']} ({it['desc']})" for it in menu().values())


# ── Jev's questions ──────────────────────────────────────────────────────────


def _qty_meaning(n: int, it: Mapping[str, Any]) -> str:
    if n == 0:
        return f"0: none; the customer orders no {it['plural']}"
    return f"{n}: {WORDS[n]} {it['one'] if n == 1 else it['plural']}"


def _size_meaning(z: str, it: Mapping[str, Any]) -> str:
    if z == "none":
        return f"none: the customer says no size for the {it['name']}, or orders no {it['name']}"
    return f"{z}: a {z} {it['name']}"


def jev_questions(seed: str) -> tuple[dict[str, Any], dict[str, dict[str, str]]]:
    """Every argument of an order as a closed question, and the opaque ids of
    each choice's options ({question id: {option id: value}})."""
    qs: dict[str, Any] = {}
    ids: dict[str, dict[str, str]] = {}
    for item_id, it in menu().items():
        qid = f"qty_{item_id}"
        ids[qid] = opaque([str(n) for n in range(QTY_MAX + 1)], f"{seed}|{qid}", prefix="n")
        qs[qid] = choice(
            {
                "question": f"How many {it['plural']} does the customer in `customer_said` end up ordering?",
                "rules": [
                    f"Here a {it['one']} is {it['desc']}; nothing else counts as one.",
                    "'A' or 'an' means one.",
                    "When the customer changes their mind, what they say last counts.",
                    f"Choose 0 when they order no {it['plural']}.",
                ],
            },
            {oid: _qty_meaning(int(n), it) for oid, n in ids[qid].items()},
        )
        if it["sizes"]:
            qid = f"size_{item_id}"
            ids[qid] = opaque(["none", *it["sizes"]], f"{seed}|{qid}", prefix="z")
            qs[qid] = choice(
                {
                    "question": f"Which size of {it['name']} does the customer in `customer_said` end up ordering?",
                    "rules": [
                        "When the customer changes the size, the size they say last counts.",
                        f"Choose none when they say no size for the {it['name']}, or order no {it['name']}.",
                    ],
                },
                {oid: _size_meaning(z, it) for oid, z in ids[qid].items()},
            )
        for m in it["mods"]:
            md = mods()[m]
            qs[f"mod_{item_id}_{m}"] = noul(
                f"Does the customer in `customer_said` ask us to {md['ask']} their {it['name']} ({it['desc']})?",
                yes=f"they ask for {md['label']} on at least one {it['one']}",
                no=f"they do not ask for {md['label']}, or they order no {it['plural']}",
            )
        if it["mods"] and not it["sizes"]:
            qs[f"split_{item_id}"] = noul(
                f"Does the customer in `customer_said` want only some of their {it['plural']} changed, "
                f"as in \"two {it['plural']}, one of them with no pickles\"?",
                yes=f"some of their {it['plural']} are changed and the rest are not",
                no=f"all their {it['plural']} are alike, or they order at most one",
            )
    qs["off_menu"] = noul(
        f"Does the customer in `customer_said` ask for any food or drink that is not on this menu: {listing()}?",
        yes="at least one thing they ask for is not on the menu",
        no="everything they ask for is on the menu",
    )
    return qs, ids


def _sure(p: float) -> float:
    return max(p, 1.0 - p)


def assemble(answers: Mapping[str, Any], ids: Mapping[str, Mapping[str, str]], readback: float) -> dict[str, Any]:
    """The order code builds from Jev's answers: its lines (each field with how
    sure Jev was), the off-menu flag, and the least sure argument actually used,
    read back when it is under *readback*."""
    lines: list[dict[str, Any]] = []
    args: list[dict[str, Any]] = []
    for item_id, it in menu().items():
        q = read_choice(answers[f"qty_{item_id}"], ids[f"qty_{item_id}"])
        qty = int(q.option)
        args.append({"kind": "qty", "item": item_id, "value": qty, "conf": round(q.confidence, 4), "alts": q.top(3)})
        if qty == 0:
            continue
        conf: dict[str, Any] = {"qty": round(q.confidence, 4), "size": None, "mods": {}, "split": None}
        size = None
        if it["sizes"]:
            z = read_choice(answers[f"size_{item_id}"], ids[f"size_{item_id}"])
            size = default_size() if z.option == "none" else z.option
            conf["size"] = round(z.confidence, 4)
            args.append({"kind": "size", "item": item_id, "value": size, "said": z.option, "qty": qty,
                         "conf": round(z.confidence, 4), "alts": z.top(3)})
        chosen = []
        for m in it["mods"]:
            p = read_noul(answers[f"mod_{item_id}_{m}"])
            conf["mods"][m] = round(_sure(p), 4)
            if p > 0.5:
                chosen.append(m)
            args.append({"kind": "mod", "item": item_id, "mod": m, "value": p > 0.5, "p": round(p, 4),
                         "conf": round(_sure(p), 4)})
        split = False
        if qty >= 2 and chosen and f"split_{item_id}" in answers:
            p = read_noul(answers[f"split_{item_id}"])
            split = p > 0.5
            conf["split"] = round(_sure(p), 4)
            args.append({"kind": "split", "item": item_id, "value": split, "mods": chosen, "p": round(p, 4),
                         "conf": round(_sure(p), 4)})
        if split:
            lines.append({"item": item_id, "qty": 1, "size": size, "mods": sorted(chosen), "conf": conf})
            lines.append({"item": item_id, "qty": qty - 1, "size": size, "mods": [], "conf": conf})
        else:
            lines.append({"item": item_id, "qty": qty, "size": size, "mods": sorted(chosen), "conf": conf})
    p = read_noul(answers["off_menu"])
    args.append({"kind": "off_menu", "value": p > 0.5, "p": round(p, 4), "conf": round(_sure(p), 4)})
    least = min(args, key=lambda a: a["conf"])
    return {
        "lines": lines, "off_menu": p > 0.5, "confidence": least["conf"], "least": least,
        "readback": readback_of(least) if least["conf"] < readback else None,
    }


def readback_of(arg: Mapping[str, Any]) -> str:
    """What the window reads back to check the least sure part of an order."""
    kind = arg["kind"]
    if kind == "off_menu":
        return "Sorry, that isn't on our menu. Anything else?" if arg["value"] else "Is that everything?"
    it = menu()[arg["item"]]
    if kind == "qty":
        n = int(arg["value"])
        return f"No {it['plural']} today?" if n == 0 else f"That's {WORDS[n]} {it['one'] if n == 1 else it['plural']}?"
    if kind == "size":
        n = int(arg.get("qty") or 1)
        size = arg["value"]
        many = it.get("many", it["plural"])
        return f"That's a {size} {it['name']}?" if n == 1 else f"That's {WORDS[n]} {size} {many}?"
    if kind == "mod":
        label = mods()[arg["mod"]]["label"]
        return f"{label.capitalize()} on the {it['name']}?" if arg["value"] else f"The {it['name']} as it comes?"
    labels = " and ".join(mods()[m]["label"] for m in arg.get("mods") or [])
    if arg["value"]:
        return f"Just one of the {it['plural']} with {labels}?"
    return f"All the {it['plural']} with {labels}?"


# ── A text model's order ─────────────────────────────────────────────────────

_ITEM = re.compile(r"^[ \t>*_`#-]*ITEM[ \t*_`]*[:：](?P<rest>[^\n]*)$", re.I | re.M)
_PART = re.compile(r"^\s*[*_`]*\s*(QTY|SIZE|MODS?)[ \t*_`]*[:：]\s*(.*)$", re.I)
_NUMBERS = {w: i for i, w in enumerate(("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"))}


def text_system() -> str:
    rows = []
    for item_id, it in menu().items():
        sizes = ", ".join(it["sizes"]) if it["sizes"] else "no sizes"
        extras = ", ".join(it["mods"]) if it["mods"] else "no modifiers"
        rows.append(f"{item_id} ({it['desc']}): {sizes}; {extras}")
    return (
        "You work the window at a drive-thru. Each customer says their order into the speaker, and you ring it "
        "up on the till as function calls: one line per item, in exactly this form:\n"
        "ITEM: <item> | QTY: <number> | SIZE: <size or -> | MODS: <modifiers, comma-separated, or ->\n\n"
        "The menu, one item per row as `item (what it is): sizes; modifiers`:\n" + "\n".join(rows) + "\n\n"
        "Rules:\n"
        "- Write each item and modifier exactly as the menu writes it.\n"
        f"- SIZE is one of the item's sizes, or - for an item without sizes. If the customer names no size, "
        f"write - and the till rings up {default_size()}.\n"
        "- When the customer changes their mind, ring up only what they end with.\n"
        "- When only some of an item are changed (\"two cheeseburgers, one with no pickles\"), write two lines: "
        "one for those with the change, one for the rest.\n"
        "- When the customer asks for something that is not on the menu, do not ring it up: add a line "
        "CLARIFY: <what they asked for>.\n"
        "- An item, size or modifier that is not on the menu is a foul.\n\n"
        "Reply with the lines only, then a last line: DONE"
    )


def _blank(s: str | None) -> bool:
    return s is None or fold(s) in _BLANK


def _match_item(name: str) -> str | None:
    for item_id, it in menu().items():
        if match_option(name, [item_id, it["name"], it["one"], it["plural"], *it["aliases"]]):
            return item_id
    return None


def _read_qty(s: str | None) -> int | None:
    if s is None:
        return None
    t = (fold(s).split(" ") or [""])[0]
    if t.isdigit():
        return int(t)
    return _NUMBERS.get(t)


def read_order(text: str | None) -> tuple[list[dict[str, Any]], list[dict[str, str]], str | None]:
    """(lines, fouls, clarify) from a text model's till lines."""
    lines: list[dict[str, Any]] = []
    fouls: list[dict[str, str]] = []
    for m in _ITEM.finditer(text or ""):
        raw = m.group(0).strip()[:140]
        parts = m.group("rest").split("|")
        name = parts[0].strip().strip("*_`").strip()
        fields: dict[str, str] = {}
        for part in parts[1:]:
            f = _PART.match(part)
            if f:
                key = f.group(1).upper()
                fields["MODS" if key.startswith("MOD") else key] = f.group(2).strip().strip("*_`").strip()
        item_id = _match_item(name)
        if item_id is None:
            fouls.append({"line": raw, "why": f"“{name}” is not on the menu"})
            continue
        it = menu()[item_id]
        qty = _read_qty(fields.get("QTY"))
        if qty is None or qty > 99:
            fouls.append({"line": raw, "why": "no quantity the till can ring up"})
            continue
        size_said = fields.get("SIZE")
        size = None
        if not _blank(size_said):
            size = match_option(size_said, it["sizes"])
            if size is None:
                fouls.append({"line": raw, "why": f"the {it['name']} has no size “{size_said}”"})
                continue
        elif it["sizes"]:
            size = default_size()
        chosen: list[str] = []
        bad = None
        for mod in (fields.get("MODS") or "").split(","):
            if _blank(mod):
                continue
            got = match_option(mod, it["mods"])
            if got is None:
                bad = mod.strip()
                break
            chosen.append(got)
        if bad is not None:
            fouls.append({"line": raw, "why": f"“{bad}” is not a modifier for the {it['name']}"})
            continue
        if qty:
            lines.append({"item": item_id, "qty": qty, "size": size, "mods": sorted(set(chosen))})
    clarify = read_field(text, "CLARIFY")
    if _blank(clarify):
        clarify = None
    return lines, fouls, clarify


# ── Scoring ──────────────────────────────────────────────────────────────────


def _keyed(lines: Sequence[Mapping[str, Any]]) -> Counter[tuple[str, str | None, tuple[str, ...]]]:
    """Lines as {(item, size, mods): qty}, alike lines merged."""
    out: Counter[tuple[str, str | None, tuple[str, ...]]] = Counter()
    for ln in lines:
        out[(ln["item"], ln.get("size"), tuple(sorted(ln.get("mods") or [])))] += int(ln["qty"])
    return out


def _fields(pred: Sequence[Mapping[str, Any]], gold: Sequence[Mapping[str, Any]]) -> tuple[int, int]:
    """(right, total) over each item's quantity, size and modifiers."""
    right = total = 0
    for item in {ln["item"] for ln in pred} | {ln["item"] for ln in gold}:
        it = menu()[item]
        p = [ln for ln in pred if ln["item"] == item]
        g = [ln for ln in gold if ln["item"] == item]
        total += 1
        right += sum(ln["qty"] for ln in p) == sum(ln["qty"] for ln in g)
        if it["sizes"]:
            total += 1
            right += {ln.get("size") for ln in p} == {ln.get("size") for ln in g}
        if it["mods"]:
            def units(lines: Sequence[Mapping[str, Any]]) -> Counter[tuple[str, ...]]:
                c: Counter[tuple[str, ...]] = Counter()
                for ln in lines:
                    c[tuple(sorted(ln.get("mods") or []))] += int(ln["qty"])
                return c
            total += 1
            right += units(p) == units(g)
    return right, total


def judge(pred: Sequence[Mapping[str, Any]], pred_off: bool, gold: Sequence[Mapping[str, Any]],
          gold_off: bool, fouls: int = 0) -> dict[str, Any]:
    """How one order went against its gold ticket: points, whether it was
    exact, lines right, items wrong or missing, and field accuracy."""
    P, G = _keyed(pred), _keyed(gold)
    right = sum(1 for k, q in G.items() if P.get(k) == q)
    wrong: Counter[str] = Counter(k[0] for k, q in P.items() if G.get(k) != q)
    missing: Counter[str] = Counter(k[0] for k, q in G.items() if P.get(k) != q)
    errors = sum(max(wrong[i], missing[i]) for i in set(wrong) | set(missing))
    off_right = bool(pred_off) == bool(gold_off)
    exact = errors == 0 and off_right and fouls == 0
    points = (
        POINTS["exact"] * exact + POINTS["line"] * right + POINTS["wrong"] * errors
        + (POINTS["off_menu"] if gold_off and pred_off else 0) + (0 if off_right else -POINTS["off_menu"])
        + POINTS["foul"] * fouls
    )
    f_right, f_total = _fields(pred, gold)
    return {
        "points": points, "exact": exact, "right": right, "errors": errors, "off_right": off_right,
        "fields_right": f_right + off_right, "fields_total": f_total + 1,
    }


# ── The game ─────────────────────────────────────────────────────────────────


class Params(BaseModel):
    count: int = Field(default=12, ge=3, le=len(data()["orders"]), description="cars in the round")
    interval_ms: int = Field(default=1500, ge=100, le=10_000, description="a new car every …")
    patience_ms: int = Field(default=15_000, ge=2000, le=120_000, description="a car drives off after waiting …")
    readback: float = Field(default=0.9, ge=0.5, le=0.99, description="under this, the window reads the least sure part back")
    seed: int | None = Field(default=None, description="the same seed draws the same cars")


def public_menu() -> list[dict[str, Any]]:
    return [
        {"id": item_id, "name": it["name"], "sizes": it["sizes"], "mods": it["mods"]}
        for item_id, it in menu().items()
    ]


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    rng = random.Random(p.seed)
    picked = rng.sample(list(data()["orders"]), min(p.count, len(data()["orders"])))
    ctx.private["orders"] = picked
    return {
        "cars": [], "total": len(picked), "menu": public_menu(),
        "mods": {m: md["label"] for m, md in mods().items()}, "default_size": default_size(),
        "readback": p.readback, "points": POINTS, "gold": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    p: Params = ctx.params
    orders: list[dict[str, Any]] = ctx.private["orders"]
    queues: list[asyncio.Queue[tuple[int, float] | None]] = [asyncio.Queue() for _ in ctx.players]
    questions, ids = jev_questions(f"drivethru|{run.id}")
    system = text_system()
    t0 = time.monotonic()
    for i in range(len(ctx.players)):
        run.lane(i, queue=0, busy=None, served=0, dropped=0, exact=0, readbacks=0, fields_right=0,
                 fields_total=0, score=0)

    async def arrivals() -> None:
        for k, order in enumerate(orders):
            delay = t0 + k * p.interval_ms / 1000 - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            run.push("cars", {"i": k, "said": order["said"], "change": order.get("change"), "at_ms": run.elapsed_ms()})
            now = time.monotonic()
            for i, q in enumerate(queues):
                q.put_nowait((k, now))
                run.lane(i, queue=q.qsize())
        for q in queues:
            q.put_nowait(None)

    async def sampler() -> None:
        while True:
            for i, q in enumerate(queues):
                run.lane_push(i, "backlog", q.qsize())
            await asyncio.sleep(_SAMPLE_S)

    def record(pl: Player, ticket: dict[str, Any], call: Any = None) -> None:
        i = pl.index
        ln = run.state["lanes"][i]
        served = ticket["status"] == "served"
        tally: dict[str, Any] = {
            "score": ln["score"] + ticket["points"],
            "served": ln["served"] + served,
            "dropped": ln["dropped"] + (not served),
            "exact": ln["exact"] + bool(ticket.get("exact")),
            "readbacks": ln["readbacks"] + bool(ticket.get("readback")),
            "fields_right": ln["fields_right"] + ticket.get("fields_right", 0),
            "fields_total": ln["fields_total"] + ticket.get("fields_total", 0),
            "busy": None,
        }
        if ticket.get("fouls"):
            tally["fouls"] = ln["fouls"] + len(ticket["fouls"])
        run.lane_push(i, "tickets", ticket)
        if call is not None:
            run.account(i, call, **tally)
        else:
            run.lane(i, **tally)

    async def serve_jev(pl: Player, k: int, base: dict[str, Any]) -> None:
        order = orders[k]
        asked = await ask_jev(pl, {"customer_said": order["said"]}, questions, on_wait=run.waiting(pl.index))
        t = assemble(asked.answers, ids, p.readback)
        verdict = judge(t["lines"], t["off_menu"], order["lines"], bool(order["off_menu"]))
        record(pl, {
            **base, "status": "served", **t, "clarify": None, "fouls": [], "ms": asked.latency_ms,
            "questions": len(questions), "requests": asked.requests, **verdict,
        }, asked)

    async def serve_text(pl: Player, k: int, base: dict[str, Any]) -> None:
        order = orders[k]
        said = await ask_text(pl, system, f'CUSTOMER: "{order["said"]}"', on_wait=run.waiting(pl.index))
        lines, fouls, clarify = read_order(said.text)
        verdict = judge(lines, clarify is not None, order["lines"], bool(order["off_menu"]), len(fouls))
        record(pl, {
            **base, "status": "served", "lines": lines, "off_menu": clarify is not None,
            "clarify": clarify[:80] if clarify else None, "fouls": fouls, "readback": None,
            "ms": said.latency_ms, **verdict,
        }, said)

    async def lane(pl: Player) -> None:
        q = queues[pl.index]
        while True:
            item = await q.get()
            if item is None:
                break
            k, arrived = item
            waited = int((time.monotonic() - arrived) * 1000)
            run.lane(pl.index, queue=q.qsize())
            base = {"car": k, "waited_ms": waited}
            if waited > p.patience_ms:
                record(pl, {**base, "status": "dropped", "points": POINTS["dropped"], "lines": [], "fouls": []})
                continue
            run.lane(pl.index, busy=k)
            await (serve_jev if pl.is_jev else serve_text)(pl, k, base)

    helpers = [asyncio.ensure_future(arrivals()), asyncio.ensure_future(sampler())]
    try:
        await run.each_lane(lane)
    finally:
        for t in helpers:
            t.cancel()
        await asyncio.gather(*helpers, return_exceptions=True)
        run.patch(gold=[{"lines": o["lines"], "off_menu": o["off_menu"]} for o in orders])


GAME = Game(
    id="drivethru", title="Drive-Thru", tagline="Orders in plain words, out as typed function calls",
    use_case="function calling", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
