"""Blind Tasting: guess the critic's score: closest without going over.

TypeSafe's text-to-features for predictive ML (its autoresearch
feature-discovery cookbook). A round pours one tasting note from a set of
forty; the critic's score, 80 to 100, stays private until the end.

**Jev** does not guess the number: it measures qualities. One request per
note, for every note in the set, all at once, each with seven Score
questions (fruit, oak, structure, acidity, complexity, finish, balance, 0 to
4) and three yes/no ones (will it age? names a flaw? says drink now?). Each
Score yields two features, its mean level and its spread; each yes/no one
yields its probability: seventeen in all. Code fits a small ridge regression
(normal equations, Gaussian elimination, pure Python) on every other note's
features and scores, never this one's, and predicts this one. It also tells
how far off such a model is across the set (its leave-one-out RMSE, with
this note left out of every fit) and which features weigh most.

**A text model** reads the note and answers `REASON:` and `SCORE: <80-100>`.
A missing score, or one outside 80 to 100, is a foul: no guess.

**You** guess on the page and lock it in before the reveal.

The winner is the guess closest to the critic's score without going over it;
a lane's score is its guess.
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .base import Context, Game
from .core import noul, read_field, read_noul, read_score, score
from .players import Player, ask_jev, ask_text, together
from .runs import GameRun

LOW, HIGH = 80, 100
LEVELS = 5
#: The ridge penalty, on standardised features: small next to the ~40 notes.
RIDGE = 1.0
#: How many of the heaviest weights the page shows.
TOP_WEIGHTS = 5
JEV_PARALLEL = 16

RULES = ["`note` is a critic's tasting note about one wine.", "Answer only from what `note` says."]


@cache
def data() -> dict[str, Any]:
    with open(Path(__file__).parent / "data" / "tasting.json", encoding="utf-8") as f:
        return json.load(f)


def notes() -> list[dict[str, Any]]:
    return data()["notes"]


# ── What Jev measures ─────────────────────────────────────────────────────────


def questions() -> dict[str, dict[str, Any]]:
    """Every feature question, by id: the Scores, then the yes/no ones."""
    f = data()["features"]
    qs = {s["id"]: score({"question": s["question"], "rules": RULES}, s["levels"]) for s in f["scores"]}
    for n in f["nouls"]:
        qs[n["id"]] = noul({"question": n["question"], "rules": RULES}, yes=n["yes"], no=n["no"])
    return qs


@cache
def feature_names() -> tuple[tuple[str, str], ...]:
    """(key, label) of every feature, in the model's order: each Score's mean
    and spread, then each yes/no."""
    f = data()["features"]
    out: list[tuple[str, str]] = []
    for s in f["scores"]:
        out += [(s["id"], s["label"]), (f"{s['id']}_spread", f"{s['label']} (spread)")]
    out += [(n["id"], n["label"]) for n in f["nouls"]]
    return tuple(out)


def read_features(answers: Mapping[str, Any]) -> tuple[list[float], dict[str, Any]]:
    """Jev's answers about one note as the model's vector, and as the page shows them."""
    f = data()["features"]
    vec: list[float] = []
    shown: dict[str, Any] = {"scores": [], "nouls": []}
    for s in f["scores"]:
        sc = read_score(answers[s["id"]], LEVELS)
        vec += [sc.score, sc.spread]
        shown["scores"].append({"id": s["id"], **sc.public()})
    for n in f["nouls"]:
        p = read_noul(answers[n["id"]])
        vec.append(p)
        shown["nouls"].append({"id": n["id"], "p": round(p, 4)})
    return vec, shown


# ── The model: ridge regression in pure Python ────────────────────────────────


def solve(a: Sequence[Sequence[float]], b: Sequence[float]) -> list[float]:
    """x with a·x = b, by Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [[float(v) for v in row] + [float(b[i])] for i, row in enumerate(a)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[piv][col]) < 1e-12:
            raise ValueError("the system has no single solution")
        m[col], m[piv] = m[piv], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            if f:
                for c in range(col, n + 1):
                    m[r][c] -= f * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))) / m[r][r]
    return x


@dataclass(frozen=True)
class Ridge:
    """A fitted model: features standardised by the training set's mean and
    spread, one weight each (score points per standard deviation), and the
    mean score as the intercept."""

    mean: tuple[float, ...]
    scale: tuple[float, ...]
    weights: tuple[float, ...]
    intercept: float

    def predict(self, x: Sequence[float]) -> float:
        return self.intercept + sum(
            w * (v - mu) / s for w, v, mu, s in zip(self.weights, x, self.mean, self.scale, strict=True)
        )


def fit(xs: Sequence[Sequence[float]], ys: Sequence[float], lam: float = RIDGE) -> Ridge:
    """Ridge regression by the normal equations: (ZᵀZ + λI) w = Zᵀ(y − ȳ),
    Z the standardised features. A feature that never varies gets no weight."""
    n, d = len(xs), len(xs[0])
    mean = [sum(x[j] for x in xs) / n for j in range(d)]
    scale = [math.sqrt(sum((x[j] - mean[j]) ** 2 for x in xs) / n) or 1.0 for j in range(d)]
    z = [[(x[j] - mean[j]) / scale[j] for j in range(d)] for x in xs]
    ybar = sum(ys) / n
    a = [[sum(r[i] * r[j] for r in z) + (lam if i == j else 0.0) for j in range(d)] for i in range(d)]
    b = [sum(r[i] * (y - ybar) for r, y in zip(z, ys, strict=True)) for i in range(d)]
    return Ridge(tuple(mean), tuple(scale), tuple(solve(a, b)), ybar)


def model_for(vecs: Sequence[Sequence[float]], ys: Sequence[float], target: int, lam: float = RIDGE) -> dict[str, Any]:
    """The target's prediction from a model that never saw its score, the
    set's leave-one-out error (the target left out of every fit too), and the
    heaviest weights. Nothing here depends on the target's own score."""
    others = [j for j in range(len(vecs)) if j != target]
    model = fit([vecs[j] for j in others], [ys[j] for j in others], lam)
    loo = []
    for j in others:
        rest = [i for i in others if i != j]
        m = fit([vecs[i] for i in rest], [ys[i] for i in rest], lam)
        loo.append({"n": j + 1, "pred": round(m.predict(vecs[j]), 2), "critic": ys[j]})
    rmse = math.sqrt(sum((p["pred"] - p["critic"]) ** 2 for p in loo) / len(loo))
    names = feature_names()
    if len(names) != len(model.weights):  # a model over other features (a test's)
        names = tuple((f"x{j}", f"feature {j + 1}") for j in range(len(model.weights)))
    top = sorted(range(len(names)), key=lambda i: -abs(model.weights[i]))[:TOP_WEIGHTS]
    prediction = model.predict(vecs[target])
    return {
        "prediction": round(prediction, 2), "guess": guess_of(prediction), "rmse": round(rmse, 2),
        "trained_on": len(others), "features": len(names), "lambda": lam,
        "top": [{"id": names[i][0], "label": names[i][1], "w": round(model.weights[i], 2)} for i in top],
        "loo": loo,
    }


def guess_of(prediction: float) -> int:
    """The model's prediction as a guess: the nearest whole score, on the scale."""
    return max(LOW, min(HIGH, int(math.floor(prediction + 0.5))))


# ── Text models ───────────────────────────────────────────────────────────────


def text_system() -> str:
    return (
        "You are a contestant in a blind tasting. You read one wine critic's tasting note and guess the score "
        f"the critic gave the wine, on the critic's {LOW} to {HIGH} scale.\n\n"
        "The critic scores consistently: richer structure, more complexity, a longer finish and more ageing "
        "potential score higher; flaws, thin wines and simple wines score lower. Around 80 is a flawed or "
        "dilute wine, 85 a simple, pleasant one, 90 an excellent one, 95 an outstanding one; 98 to 100 is rare.\n\n"
        "Rules:\n"
        "- The winner is the guess closest to the critic's score without going over it. A guess above the "
        "critic's score loses.\n"
        f"- Your score is one whole number from {LOW} to {HIGH}. A missing score, or one outside {LOW} to "
        f"{HIGH}, is a foul.\n\n"
        "Reply with exactly two lines and nothing else:\n"
        "REASON: <one short sentence>\n"
        f"SCORE: <{LOW}-{HIGH}>"
    )


def text_prompt(wine: Mapping[str, Any]) -> str:
    return f'TASTING NOTE ({wine["style"]}): "{wine["text"]}"'


_NUMBER = re.compile(r"^[\s(\[~≈]*(\d+(?:\.\d+)?)")


def read_guess(reply: str | None) -> int | float | None:
    """The SCORE a text model named, or None (a foul): missing, not a
    number, or outside 80 … 100."""
    said = read_field(reply, "SCORE")
    m = _NUMBER.match(said) if said else None
    if m is None:
        return None
    x = float(m.group(1))
    if not LOW <= x <= HIGH:
        return None
    return int(x) if x == int(x) else round(x, 1)


# ── Who wins ──────────────────────────────────────────────────────────────────


def winners(guesses: Mapping[Any, float | None], critic: float) -> list[Any]:
    """Who guessed closest without going over: every one tied at the best,
    and nobody when every guess went over."""
    under = {k: g for k, g in guesses.items() if g is not None and g <= critic}
    if not under:
        return []
    best = max(under.values())
    return [k for k, g in under.items() if g == best]


# ── The game ──────────────────────────────────────────────────────────────────




class Params(BaseModel):
    note: int | None = Field(default=None, ge=1, le=len(notes()), description="which note is poured; none pours one at random")
    seed: int | None = Field(default=None, description="the same seed pours the same note")


def public_measures() -> dict[str, Any]:
    f = data()["features"]
    return {
        "scores": [{"id": s["id"], "label": s["label"], "levels": s["levels"]} for s in f["scores"]],
        "nouls": [{"id": n["id"], "label": n["label"]} for n in f["nouls"]],
    }


async def prepare(ctx: Context) -> dict[str, Any]:
    p: Params = ctx.params
    k = p.note - 1 if p.note else random.Random(p.seed).randrange(len(notes()))
    wine = notes()[k]
    ctx.private.update(target=k, critic=wine["score"])
    return {
        "wine": {"n": k + 1, "style": wine["style"], "text": wine["note"]},
        "range": [LOW, HIGH], "set_size": len(notes()), "measures": public_measures(),
        "critic": None, "winners": None,
    }


async def play(run: GameRun, ctx: Context) -> None:
    k: int = ctx.private["target"]
    critic: int = ctx.private["critic"]
    every = notes()
    asked_of = questions()
    for i, pl in enumerate(ctx.players):
        run.lane(i, guess=None, score=None, measured=0, todo=len(every) if pl.is_jev else 1)

    async def jev_lane(pl: Player) -> None:
        gate = asyncio.Semaphore(JEV_PARALLEL)
        vecs: list[list[float]] = [[] for _ in every]

        async def measure(j: int) -> None:
            async with gate:
                asked = await ask_jev(pl, {"note": every[j]["note"]}, asked_of, on_wait=run.waiting(pl.index))
            vecs[j], shown = read_features(asked.answers)
            also: dict[str, Any] = {"measured": run.state["lanes"][pl.index]["measured"] + 1}
            if j == k:
                also["features"] = shown
            run.account(pl.index, asked, **also)

        await together(measure(j) for j in range(len(every)))
        model = model_for(vecs, [n["score"] for n in every], k)
        run.lane(pl.index, model=model, guess=model["guess"], score=model["guess"])

    async def text_lane(pl: Player) -> None:
        said = await ask_text(pl, text_system(), text_prompt(run.state["wine"]), on_wait=run.waiting(pl.index))
        guess = read_guess(said.text)
        reason = read_field(said.text, "REASON")
        ln = run.state["lanes"][pl.index]
        also: dict[str, Any] = {"guess": guess, "score": guess, "said": (reason or said.text.strip())[:300]}
        if guess is None:
            also["fouls"] = ln["fouls"] + 1
        run.account(pl.index, said, **also)

    try:
        await run.each_lane(lambda pl: (jev_lane if pl.is_jev else text_lane)(pl))
    finally:
        won = winners({ln["index"]: ln.get("guess") for ln in run.state["lanes"]}, critic)
        for ln in run.state["lanes"]:
            g = ln.get("guess")
            run.lane(ln["index"], over=g is not None and g > critic, won=ln["index"] in won)
        run.patch(critic=critic, winners=won)


GAME = Game(
    id="tasting", title="Blind Tasting",
    tagline="Guess the critic's score: closest without going over",
    use_case="features for ML", params=Params, prepare=prepare, play=play, lanes=(1, 4),
)
