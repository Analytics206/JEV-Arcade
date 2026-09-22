"""Shared fixtures for every Arcade game's tests: no network, ever.

`arcade` is a whole server over fakes:

* `arcade.jev` answers every question by `jev.responder(qid, question, state)`,
  which a test replaces; by default a choice puts 0.9 on its first option, a
  score all of it on level 0, and a noul says 0.5. Every request is kept in
  `jev.requests`.
* `arcade.text` is every text provider (OpenRouter's `test/…` models). Its
  replies come from `text.responder(model, system, prompt)`, default
  `"ANSWER: ?"`; every prompt is kept in `text.prompts`.
* `arcade.wiki` answers Wikipedia from `arcade.wiki_answer(params)`, which a
  test replaces (it raises by default: a game that reads Wikipedia must say
  what it expects to read).

`arcade.play(game, lanes, params)` starts a run and returns it when it is
over; `arcade.start(...)` returns the HTTP response instead. Lanes are model
names: `"jev"` is TypeSafe's, anything else an OpenRouter model id.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import pytest
from fastapi.testclient import TestClient

from wikirace.app import create_app
from wikirace.config import load_settings
from wikirace.games import runs
from wikirace.providers.base import Completion, TextProvider
from wikirace.race.wiki import Wiki


def default_jev_answer(qid: str, q: dict[str, Any], state: Any) -> dict[str, Any]:
    kind = q.get("type")
    if kind == "choice":
        ids = list(q["criteria"])
        rest = 0.1 / max(1, len(ids) - 1)
        probs = {o: (0.9 if i == 0 else rest) for i, o in enumerate(ids)}
        return {"type": "choice", "choice": ids[0], "probabilities": probs, "confidence": 0.8}
    if kind == "score":
        n = len(q["criteria"])
        return {"type": "score", "score": 0.0, "confidence": 1.0,
                "probabilities": {str(i): (1.0 if i == 0 else 0.0) for i in range(n)},
                "legend": {str(i): str(c) for i, c in enumerate(q["criteria"])}}
    if kind == "noul":
        return {"type": "noul", "noul": 0.5}
    raise AssertionError(f"unknown question type {kind!r}")


def choice_answer(probs: dict[str, float], confidence: float = 0.8) -> dict[str, Any]:
    """A choice answer with these probabilities (by option id)."""
    top = max(probs, key=probs.get)
    return {"type": "choice", "choice": top, "probabilities": dict(probs), "confidence": confidence}


def score_answer(probs: list[float], confidence: float = 0.8) -> dict[str, Any]:
    total = sum(probs) or 1.0
    ps = [p / total for p in probs]
    return {"type": "score", "score": sum(i * p for i, p in enumerate(ps)), "confidence": confidence,
            "probabilities": {str(i): p for i, p in enumerate(ps)}, "legend": {}}


def noul_answer(p: float) -> dict[str, Any]:
    return {"type": "noul", "noul": p}


class FakeJev:
    def __init__(self) -> None:
        self.responder = default_jev_answer
        self.requests: list[dict[str, Any]] = []
        #: Raised instead of answering, when set.
        self.fail: Exception | None = None

    async def aclose(self) -> None:
        return None

    async def discover(self) -> None:
        return None

    async def ask(self, model, state, questions, *, timeout=60.0):
        self.requests.append({"model": model, "state": state, "questions": questions})
        if self.fail is not None:
            raise self.fail
        answers = {qid: self.responder(qid, q, state) for qid, q in questions.items()}
        return {"model": model, "answers": answers, "usage": {"input_tokens": 100, "output_tokens": 0}}


class FakeText(TextProvider):
    def __init__(self, config, shared: dict[str, Any]) -> None:
        super().__init__(config)
        self.shared = shared

    async def complete(self, model, system, prompt, *, thinking, max_tokens, timeout):
        self.shared["prompts"].append({"model": model, "system": system, "prompt": prompt, "thinking": thinking})
        text = self.shared["responder"](model, system, prompt)
        return Completion(text=text, model=model, tokens_in=200, tokens_out=20, cost=0.002, stop_reason="stop")


@dataclass
class TextModels:
    shared: dict[str, Any] = field(default_factory=lambda: {"prompts": [], "responder": lambda m, s, p: "ANSWER: ?"})

    @property
    def prompts(self) -> list[dict[str, Any]]:
        return self.shared["prompts"]

    @property
    def responder(self):
        return self.shared["responder"]

    @responder.setter
    def responder(self, fn) -> None:
        self.shared["responder"] = fn


def key(name: str) -> str:
    return "typesafe:jev-1.13.0" if name == "jev" else f"openrouter:{name}"


class Arcade:
    def __init__(self, client: TestClient, jev: FakeJev, text: TextModels, settings, app) -> None:
        self.client = client
        self.jev = jev
        self.text = text
        self.settings = settings
        self.app = app
        self.wiki_answer = self._no_wiki

    @staticmethod
    def _no_wiki(params: dict[str, Any]) -> Any:
        raise AssertionError(f"unexpected Wikipedia request {params}")

    def start(self, game: str, lanes: list[str | dict], params: dict[str, Any] | None = None):
        body = {"lanes": [{"key": key(ln)} if isinstance(ln, str) else ln for ln in lanes], "params": params or {}}
        return self.client.post(f"/api/games/{game}/runs", json=body)

    def wait(self, run_id: str, timeout: float = 15.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            run = self.client.get(f"/api/games/runs/{run_id}").json()
            if run["status"] != "running":
                return run
            time.sleep(0.02)
        raise AssertionError(f"run {run_id} did not finish in {timeout} s")

    def play(self, game: str, lanes: list[str | dict], params: dict[str, Any] | None = None,
             timeout: float = 15.0) -> dict[str, Any]:
        r = self.start(game, lanes, params)
        assert r.status_code == 201, r.text
        return self.wait(r.json()["id"], timeout)

    def events(self, run_id: str) -> list[dict[str, Any]]:
        with self.client.stream("GET", f"/api/games/runs/{run_id}/events") as r:
            assert r.status_code == 200
            return [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]


MODELS = ("test/a", "test/b", "test/c", "test/d")


@pytest.fixture
def arcade(tmp_path):
    runs._LIVE.clear()
    settings = load_settings({
        "OPENROUTER_API_KEY": "sk-or-test",
        "OPENROUTER_MODELS": ", ".join(MODELS),
        "TYPESAFE_API_KEY": "ts-test",
        "WIKIRACE_DB": str(tmp_path / "arcade.db"),
    }, read_file=False)
    text = TextModels()
    jev = FakeJev()
    providers = {pid: FakeText(settings.providers[pid], text.shared)
                 for pid in ("anthropic", "openai", "openrouter", "ollama")}
    providers["typesafe"] = jev
    holder: dict[str, Arcade] = {}

    async def wiki_get(url: str, params: dict[str, Any]) -> Any:
        return holder["a"].wiki_answer(params)

    app = create_app(settings, wiki=Wiki(get=wiki_get), providers=providers)
    with TestClient(app, base_url="http://localhost") as client:
        a = Arcade(client, jev, text, settings, app)
        holder["a"] = a
        yield a
        for run in runs.live_runs():
            if not run.done:
                client.post(f"/api/games/runs/{run.id}/stop")
    runs._LIVE.clear()
