"""The API, end to end: whole races over a fake Wikipedia and scripted models.

No network: Wikipedia is a dozen-article graph answered in-process, and every
provider is a stand-in with the provider interface. What is under test is the
game and the server around it: who can race, what a race does with every kind
of reply (moves, each foul, errors, rate limits), and what is kept afterwards.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest
from fastapi.testclient import TestClient

from wikirace import store
from wikirace.app import begin_closing, create_app
from wikirace.config import load_settings
from wikirace.providers.base import (
    Completion,
    ModelInfo,
    ProviderError,
    TextProvider,
    fix_hint,
    status_error,
)
from wikirace.race import engine
from wikirace.race import wiki as W
from wikirace.race.racers import RacerError
from wikirace.race.wiki import Wiki

GRAPH = {
    "Start Page": ["Alpha", "Beta", "Gamma"],
    "Alpha": ["Beta", "Target Article"],
    "Beta": ["Alpha"],
    "Gamma": ["Delta"],
    "Delta": ["Target Article", "Gamma"],
    "Target Article": ["Start Page"],
    "Island": [],
    # Links the target only by another name.
    "Hub": ["Beta", "Twin Name"],
    # Two different articles that differ only in case.
    "Space Page": ["Red Dwarf"],
    "Red Dwarf": ["Red dwarf"],
    "Red dwarf": [],
    # A long page, for the link cap.
    "Long Page": ["Filler 1", "Filler 2", "Target Article"],
    # Two pages that only link each other: a dead end for a racer that never goes back.
    "Loop A": ["Loop B"],
    "Loop B": ["Loop A"],
}
REDIRECTS = {"Alias Of Target": "Target Article", "The Start": "Start Page", "Twin Name": "Target Article"}
#: What `prop=redirects` answers: every other name of an article.
ALIASES = {"Target Article": ["Alias Of Target", "Twin Name"]}


async def fake_wikipedia(url: str, params: dict) -> dict:
    if params.get("action") == "parse":
        title = REDIRECTS.get(params["page"], params["page"])
        if title not in GRAPH:
            return {"error": {"code": "missingtitle", "info": "The page you specified doesn't exist."}}
        anchors = "".join(f'<a href="/wiki/{t.replace(" ", "_")}">{t}</a> ' for t in GRAPH[title])
        return {"parse": {
            "title": title,
            "text": f"<p>{title} is an article in a very small encyclopedia. {anchors}</p>",
            "links": [{"ns": 0, "title": t, "exists": True} for t in GRAPH[title]],
            "properties": {"wikibase-shortdesc": f"about {title}"},
        }}
    if params.get("generator") == "search":
        return {"query": {"pages": []}}
    if params.get("prop") == "redirects":
        title = params["titles"]
        return {"query": {"pages": [{"title": title, "redirects": [
            {"ns": 0, "title": a} for a in ALIASES.get(title, [])]}]}}
    if params.get("action") == "query" and "titles" in params:
        redirects, pages = [], []
        for t in params["titles"].split("|"):
            name = REDIRECTS.get(t, t)
            if name != t:
                redirects.append({"from": t, "to": name})
            pages.append({"ns": 0, "title": name, "description": f"about {name}"} if name in GRAPH
                         else {"ns": 0, "title": name, "missing": True})
        return {"query": {"redirects": redirects, "pages": pages}}
    raise AssertionError(f"unexpected Wikipedia request {params}")


SCRIPTS: dict[str, object] = {
    # A clean two-hop race.
    "test/good": {"Start Page": "Alpha", "Alpha": "Target Article"},
    # Three fouls: the target itself, an invented article, and an alias that
    # redirects to the target. Strikes default to 3, so this is a DQ.
    "test/cheat": ["Target Article", "Nonexistent Page", "Alias Of Target"],
    # Never gets anywhere.
    "test/wanderer": {"Start Page": "Beta", "Beta": "Alpha", "Alpha": "Beta"},
    # Names the target on a page that links it only as "Twin Name".
    "test/alias": {"Hub": "Target Article"},
    # Follows the sitcom first; only the second hop reaches the star.
    "test/caseful": {"Space Page": "Red Dwarf", "Red Dwarf": "Red dwarf"},
    # Names the target, which is on the page but past a cap of 2.
    "test/peeker": {"Long Page": "Target Article"},
}


def _page_of(prompt: str) -> str:
    line = next(ln for ln in prompt.splitlines() if ln.startswith("YOU ARE ON: "))
    return line[len("YOU ARE ON: "):].split(" — ")[0]


class ScriptedModels(TextProvider):
    """Plays SCRIPTS by model id, and fails on cue for the models named after
    a failure."""

    def __init__(self, config, seen: list[dict]) -> None:
        super().__init__(config)
        self.calls: dict[str, int] = {}
        self.seen = seen

    async def complete(self, model, system, prompt, *, thinking, max_tokens, timeout):
        self.seen.append({"model": model, "thinking": thinking, "max_tokens": max_tokens})
        n = self.calls[model] = self.calls.get(model, 0) + 1
        if model == "test/broken":
            raise status_error("OpenRouter", 400, "model not found")
        if model == "test/unauthorized":
            # OpenAI's shape: the refusal quotes the key it was sent.
            raise status_error("OpenRouter", 401, "Incorrect API key provided: sk-or-test",
                               hint=fix_hint(self.config, 401, model))
        # Rate-limited twice, then plays like test/good; rate-limited for good;
        # rate-limited with an hour's Retry-After; and an outage that stays out.
        if (model == "test/limited" and n <= 2) or model in ("test/refused", "test/closed", "test/outage"):
            status = 503 if model == "test/outage" else 429
            headers = {"retry-after": "3600"} if model == "test/closed" else {}
            raise status_error("OpenRouter", status, "slow down", headers)
        if model == "test/slow":
            await asyncio.sleep(30)
        script = SCRIPTS["test/good" if model == "test/limited" else model]
        pick = script[n - 1] if isinstance(script, list) else script[_page_of(prompt)]
        return Completion(text=f"REASON: scripted.\nLINK: {pick}", model=model, tokens_in=100, tokens_out=10,
                          cost=0.001, stop_reason="stop")


class FakeOllama(ScriptedModels):
    async def discover(self):
        return [ModelInfo("qwen3.5:4b", thinks=True, context=262144, note="4.7B · Q4_K_M"),
                ModelInfo("tiny:1b", thinks=False, context=8192),
                ModelInfo("llama3.2:latest", thinks=False, context=131072)]


class DownOllama(ScriptedModels):
    async def discover(self):
        raise ProviderError("no Ollama answered at http://ollama.test:11434: connection refused")


class FakeJev:
    """Prefers the target, then Gamma: a three-hop route, one longer than test/good's."""

    def __init__(self) -> None:
        self.asks = 0

    async def aclose(self) -> None:
        return None

    async def ask(self, model, state, questions, *, timeout=60.0):
        self.asks += 1
        answers = {}
        for qid, q in questions.items():
            ids = q["criteria"]
            fav = next((o for o, t in ids.items() if t == "Target Article"), None) or \
                next((o for o, t in ids.items() if t == "Gamma"), None) or sorted(ids)[0]
            answers[qid] = {"probabilities": {o: (0.9 if o == fav else 0.01) for o in ids}, "confidence": 0.7}
        return {"model": model, "answers": answers, "usage": {"input_tokens": 50, "output_tokens": 0}}


MODELS = ("test/good", "test/cheat", "test/wanderer", "test/broken", "test/slow", "test/alias", "test/caseful",
          "test/peeker", "test/limited", "test/refused", "test/closed", "test/outage", "test/unauthorized")


def _settings(tmp_path, **extra):
    env = {
        "OPENROUTER_API_KEY": "sk-or-test",
        "OPENROUTER_MODELS": ", ".join(MODELS),
        "OPENROUTER_THINKING": "medium",
        "OLLAMA_BASE_URL": "http://ollama.test:11434",
        "OLLAMA_MODELS": "qwen3.5:4b@none, not-pulled:7b, llama3.2",
        "TYPESAFE_API_KEY": "ts-test",
        "WIKIRACE_DB": str(tmp_path / "races.db"),
        **extra,
    }
    return load_settings(env, read_file=False)


@pytest.fixture
def race_env(monkeypatch, tmp_path):
    """Fake Wikipedia, scripted models on OpenRouter and Ollama, and Jev."""
    monkeypatch.setattr(W, "CLASSIC", ("Alpha", "Beta", "Gamma"))
    engine._LIVE.clear()
    settings = _settings(tmp_path)
    seen: list[dict] = []
    providers = {
        "anthropic": ScriptedModels(settings.providers["anthropic"], seen),
        "openai": ScriptedModels(settings.providers["openai"], seen),
        "openrouter": ScriptedModels(settings.providers["openrouter"], seen),
        "ollama": FakeOllama(settings.providers["ollama"], seen),
        "typesafe": FakeJev(),
    }
    app = create_app(settings, wiki=Wiki(get=fake_wikipedia), providers=providers)
    with TestClient(app, base_url="http://localhost") as client:
        yield {"client": client, "seen": seen, "settings": settings, "providers": providers, "app": app}
        # Through the API: a race lives on the app's event loop, and stopping it
        # from this thread is exactly the bug the async handlers exist to avoid.
        for race in engine.live_races():
            if not race.done:
                client.post(f"/api/races/{race.id}/stop")
    engine._LIVE.clear()


def _key(name: str) -> str:
    return "typesafe:jev-1.13.0" if name == "jev" else f"openrouter:{name}"


def _start(client, lanes, start="Start Page", target="Target Article", headers=None, **extra):
    body = {"start": start, "target": target,
            "lanes": [{"key": _key(k)} if isinstance(k, str) else k for k in lanes], **extra}
    return client.post("/api/races", json=body, headers=headers)


def _wait_saved(db: str, race_id: str, timeout: float = 10.0) -> dict:
    """Until the race's final state is in the database (the writer is async)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = store.get(db, race_id)
        if row is not None and row["status"] != "running":
            return row
        time.sleep(0.05)
    raise AssertionError("race was never saved as over")


def _events(client, race_id: str) -> list[dict]:
    with client.stream("GET", f"/api/races/{race_id}/events") as r:
        assert r.status_code == 200
        return [json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")]


def _wait_done(client, race_id: str, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        race = client.get(f"/api/races/{race_id}").json()
        if race["status"] != "running":
            return race
        time.sleep(0.05)
    raise AssertionError("race did not finish")


# ── The server ────────────────────────────────────────────────────────────────


def test_health_and_the_page(race_env):
    client = race_env["client"]
    assert client.get("/api/health").json()["ok"] is True
    page = client.get("/")
    assert page.status_code == 200 and "JEV-Arcade" in page.text


def test_a_host_name_it_was_not_given_is_refused(race_env):
    # A page elsewhere that points a name of its own at 127.0.0.1 (DNS
    # rebinding) arrives with that name: it must not be able to start a race.
    client = race_env["client"]
    assert client.get("/api/health", headers={"host": "attacker.example"}).status_code == 400
    assert _start(client, ["test/good"], headers=None).status_code == 201  # localhost still races
    assert client.post("/api/races", headers={"host": "attacker.example"},
                       json={"start": "Start Page", "target": "Alpha", "lanes": [{"key": "openrouter:test/good"}]}
                       ).status_code == 400


def test_keys_never_reach_the_page_or_the_race(race_env):
    client = race_env["client"]
    assert "sk-or-test" not in client.get("/api/models").text
    rid = _start(client, ["test/unauthorized"]).json()["id"]
    race = _wait_done(client, rid)
    lane = race["lanes"][0]
    assert lane["status"] == "error" and "HTTP 401" in lane["note"] and "OPENROUTER_API_KEY" in lane["note"]
    assert "sk-or-test" not in json.dumps(race)
    assert "sk-or-test" not in json.dumps(_events(client, rid))


# ── Who can race ──────────────────────────────────────────────────────────────


def test_models_lists_every_provider_and_says_why_one_cannot_race(race_env):
    body = race_env["client"].get("/api/models").json()
    providers = {p["id"]: p for p in body["providers"]}
    assert list(providers) == ["anthropic", "openai", "openrouter", "ollama", "typesafe"]
    assert providers["openrouter"]["available"] and providers["openrouter"]["key_source"] == "environment"
    assert providers["openai"]["available"] is False and "OPENAI_API_KEY" in providers["openai"]["reason"]
    assert providers["ollama"]["url"] == "http://ollama.test:11434"
    assert providers["typesafe"]["kind"] == "judgment" and providers["typesafe"]["custom_models"] is False

    by_key = {m["key"]: m for m in body["models"]}
    good = by_key["openrouter:test/good"]
    assert good["available"] and good["kind"] == "text" and good["thinking"] == "medium"
    o4 = by_key["openai:o4-mini"]
    assert o4["available"] is False and "OPENAI_API_KEY" in o4["reason"]
    assert o4["price"] == {"input": 1.10, "output": 4.40}
    jev = by_key["typesafe:jev-1.13.0"]
    assert jev["kind"] == "judgment" and jev["available"] and jev["thinking"] is None
    assert jev["price"]["output"] == 0
    assert body["thinking_levels"][0] == "none" and "max" in body["thinking_levels"]


def test_an_ollama_is_asked_what_it_has_and_a_model_it_lacks_says_so(race_env):
    body = race_env["client"].get("/api/models").json()
    by_key = {m["key"]: m for m in body["models"]}
    qwen = by_key["ollama:qwen3.5:4b"]
    assert qwen["available"] and qwen["thinks"] is True and qwen["context"] == 262144
    assert qwen["thinking"] == "none"  # its @level
    assert qwen["price"] == {"input": 0.0, "output": 0.0}
    missing = by_key["ollama:not-pulled:7b"]
    assert missing["available"] is False and "ollama pull not-pulled:7b" in missing["reason"]
    # OLLAMA_MODELS narrows the list: a model it has but was not named is not offered.
    assert "ollama:tiny:1b" not in by_key
    # Named without a tag, it is the one Ollama lists as `:latest`.
    assert by_key["ollama:llama3.2"]["available"] and by_key["ollama:llama3.2"]["context"] == 131072


def test_with_no_models_named_an_ollama_offers_everything_it_has(race_env, tmp_path):
    race_env["app"].state.settings = _settings(tmp_path, OLLAMA_MODELS="")
    body = race_env["client"].get("/api/models").json()
    keys = [m["key"] for m in body["models"] if m["provider"] == "ollama"]
    assert keys == ["ollama:qwen3.5:4b", "ollama:tiny:1b", "ollama:llama3.2:latest"]


def test_an_ollama_that_does_not_answer_is_listed_with_why(race_env):
    race_env["providers"]["ollama"] = DownOllama(race_env["settings"].providers["ollama"], [])
    body = race_env["client"].get("/api/models").json()
    ollama = next(p for p in body["providers"] if p["id"] == "ollama")
    assert ollama["configured"] and not ollama["available"] and "connection refused" in ollama["reason"]
    assert all(not m["available"] for m in body["models"] if m["provider"] == "ollama")


def test_settings_that_were_ignored_are_shown(race_env, tmp_path):
    race_env["app"].state.settings = _settings(tmp_path, WIKIRACE_THINKING="ludicrous")
    body = race_env["client"].get("/api/models").json()
    assert body["thinking"] is None and any("ludicrous" in w for w in body["warnings"])


# ── Subjects ──────────────────────────────────────────────────────────────────


def test_resolve_and_random(race_env):
    client = race_env["client"]
    r = client.get("/api/resolve", params={"q": "Alias Of Target"}).json()
    assert r["title"] == "Target Article" and "leads to" in r["note"]
    assert client.get("/api/resolve", params={"q": "No Such Thing"}).status_code == 404
    pair = client.get("/api/random", params={"pool": "classic", "count": 2}).json()
    titles = [s["title"] for s in pair["subjects"]]
    assert len(set(titles)) == 2 and set(titles) <= {"Alpha", "Beta", "Gamma"}
    one = client.get("/api/random", params=[("count", "1"), ("exclude", "Alpha"), ("exclude", "Beta")]).json()
    assert [s["title"] for s in one["subjects"]] == ["Gamma"]
    assert client.get("/api/random", params={"pool": "spicy"}).status_code == 400


# ── A whole race ──────────────────────────────────────────────────────────────


def test_a_race_runs_to_the_finish_and_catches_every_foul(race_env):
    client = race_env["client"]
    r = _start(client, ["test/good", "test/cheat", "jev"])
    assert r.status_code == 201, r.text
    started = r.json()
    assert started["status"] == "running" and len(started["lanes"]) == 3
    assert started["start"]["title"] == "Start Page" and started["start"]["links"] == 3

    events = _events(client, started["id"])
    assert events[0]["type"] == "snapshot" and events[-1]["type"] == "end"
    race = _wait_done(client, started["id"])
    good, cheat, jev_lane = race["lanes"]

    assert good["status"] == "finished" and good["hops"] == 2 and good["strikes"] == 0
    assert [s["to"] for s in good["steps"]] == ["Alpha", "Target Article"]
    assert good["tokens_in"] == 200 and good["cost"] == pytest.approx(0.002)

    assert cheat["status"] == "dq" and cheat["hops"] == 0 and cheat["strikes"] == 3
    verdicts = [s["verdict"] for s in cheat["steps"]]
    assert verdicts == ["teleport", "off_page", "teleport"]
    assert "not a Wikipedia article" in cheat["steps"][1]["note"]
    assert cheat["fouls"] == {"off_page": 1, "teleport": 2, "no_pick": 0}
    assert "disqualified" in cheat["note"]

    assert jev_lane["kind"] == "judgment" and jev_lane["status"] == "finished"
    assert jev_lane["provider"] == "typesafe" and jev_lane["thinking"] is None
    assert [s["to"] for s in jev_lane["steps"]] == ["Gamma", "Delta", "Target Article"]
    assert jev_lane["tokens_out"] == 0 and jev_lane["cost_estimated"] is True
    assert jev_lane["steps"][0]["detail"]["top"][0]["title"] == "Gamma"

    assert race["status"] == "finished" and race["winner"] == 0 and race["ranking"] == [0, 2]
    assert good["rank"] == 1 and jev_lane["rank"] == 2 and cheat["rank"] is None
    # Snapshot + stream = the whole race: no step falls between the two, and
    # none is sent twice.
    in_snapshot = sum(len(ln["steps"]) for ln in events[0]["race"]["lanes"])
    streamed = sum(1 for e in events if e["type"] == "step")
    assert in_snapshot + streamed == sum(len(ln["steps"]) for ln in race["lanes"])


def test_the_configured_thinking_rides_along_unless_the_lane_overrides_it(race_env):
    client = race_env["client"]
    r = _start(client, [{"key": "openrouter:test/good"}, {"key": "openrouter:test/good", "thinking": "none"}])
    assert r.status_code == 201
    lanes = r.json()["lanes"]
    assert [ln["thinking"] for ln in lanes] == ["medium", "none"]
    assert [ln["thinking_request"] for ln in lanes] == [None, "none"]
    # Same model twice: the lanes must not read the same.
    assert lanes[0]["label"] != lanes[1]["label"]
    _wait_done(client, r.json()["id"])
    assert {s["thinking"] for s in race_env["seen"]} == {"medium", "none"}
    assert {s["max_tokens"] for s in race_env["seen"]} == {16_000}


def test_any_model_id_of_a_text_provider_can_race_but_only_listed_judges(race_env):
    client = race_env["client"]
    # Not in OPENROUTER_MODELS, and still a racer: it answers like test/good.
    r = _start(client, [{"key": "openrouter:test/good"}, {"key": "ollama:qwen3.5:4b"}])
    assert r.status_code == 201, r.text
    assert r.json()["lanes"][1]["thinking"] == "none"  # OLLAMA_MODELS pinned it
    unlisted = _start(client, [{"key": "typesafe:jev-9.9.9"}])
    assert unlisted.status_code == 400 and "TYPESAFE_MODELS" in unlisted.json()["detail"]


def test_hops_run_out(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["test/wanderer"], rules={"max_hops": 2}).json()["id"])
    lane = race["lanes"][0]
    assert lane["status"] == "dnf" and lane["hops"] == 2 and "out of hops" in lane["note"]
    assert race["winner"] is None and race["ranking"] == []


def test_going_back_is_allowed_and_counted(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["test/wanderer"], rules={"max_hops": 3}).json()["id"])
    lane = race["lanes"][0]
    assert [s["to"] for s in lane["steps"]] == ["Beta", "Alpha", "Beta"]
    assert lane["revisits"] == 1 and lane["steps"][2]["revisit"] is True


def test_a_broken_provider_ends_only_its_own_lane(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["test/broken", "test/good"]).json()["id"])
    broken, good = race["lanes"]
    assert broken["status"] == "error" and "HTTP 400" in broken["note"] and "model not found" in broken["note"]
    assert good["status"] == "finished"


def test_jev_at_a_dead_end_is_out_of_the_race_without_a_foul(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["jev"], start="Loop A").json()["id"])
    lane = race["lanes"][0]
    assert [s["to"] for s in lane["steps"]] == ["Loop B"]
    assert lane["status"] == "dnf" and lane["strikes"] == 0 and "no way forward" in lane["note"]


def test_strikes_can_be_one(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["test/cheat"], rules={"strikes": 1}).json()["id"])
    assert race["lanes"][0]["status"] == "dq" and len(race["lanes"][0]["steps"]) == 1


# ── Starting a race: what is refused ──────────────────────────────────────────


def test_start_refusals(race_env):
    client = race_env["client"]
    assert _start(client, [{"key": "nonsense"}]).status_code == 400
    assert _start(client, [{"key": "martian:model"}]).status_code == 400
    assert _start(client, [{"key": "openrouter:"}]).status_code == 400
    assert _start(client, [{"key": "openrouter:two words"}]).status_code == 400
    o4 = _start(client, [{"key": "openai:o4-mini"}])
    assert o4.status_code == 400 and "OPENAI_API_KEY" in o4.json()["detail"]
    lane = [{"key": "openrouter:test/good"}]
    same = client.post("/api/races", json={"start": "The Start", "target": "Start Page", "lanes": lane})
    assert same.status_code == 400 and "both" in same.json()["detail"]
    nowhere = client.post("/api/races", json={"start": "Start Page", "target": "Atlantis", "lanes": lane})
    assert nowhere.status_code == 400
    missing = client.post("/api/races", json={"start": "Atlantis", "target": "Alpha", "lanes": lane})
    assert missing.status_code == 400
    island = client.post("/api/races", json={"start": "Island", "target": "Alpha", "lanes": lane})
    assert island.status_code == 400 and "no links" in island.json()["detail"]
    assert _start(client, ["test/good"] * 5).status_code == 422
    assert _start(client, [{"key": "openrouter:test/good", "thinking": "ludicrous"}]).status_code == 422
    assert _start(client, ["test/good"], rules={"max_hops": 0}).status_code == 422


# ── Living with a race ────────────────────────────────────────────────────────


def test_a_race_can_be_stopped(race_env):
    client = race_env["client"]
    rid = _start(client, ["test/slow", "test/slow"]).json()["id"]
    assert client.get("/api/races").json()["running"] == [rid]
    assert client.post(f"/api/races/{rid}/stop").status_code == 202
    race = _wait_done(client, rid)
    assert race["status"] == "stopped"
    assert {ln["status"] for ln in race["lanes"]} == {"stopped"}
    assert client.post(f"/api/races/{rid}/stop").status_code == 409


def test_too_many_races_at_once_is_a_409(race_env, tmp_path):
    client = race_env["client"]
    race_env["app"].state.settings = _settings(tmp_path, WIKIRACE_MAX_RACES="1")
    rid = _start(client, ["test/slow"]).json()["id"]
    second = _start(client, ["test/good"])
    assert second.status_code == 409 and "already running" in second.json()["detail"]
    client.post(f"/api/races/{rid}/stop")


def test_history_lists_replays_and_deletes(race_env):
    client, db = race_env["client"], race_env["settings"].db_path
    rid = _start(client, ["test/good"]).json()["id"]
    _wait_done(client, rid)
    _wait_saved(db, rid)
    listed = client.get("/api/races").json()
    row = next(r for r in listed["races"] if r["id"] == rid)
    assert row["status"] == "finished" and "steps" not in row["lanes"][0]
    assert listed["running"] == []
    # Once it has left memory, the replay comes from the database, whole.
    engine._LIVE.clear()
    stored = client.get(f"/api/races/{rid}").json()
    assert len(stored["lanes"][0]["steps"]) == 2
    assert [e["type"] for e in _events(client, rid)] == ["snapshot", "end"]
    assert client.delete(f"/api/races/{rid}").status_code == 200
    assert client.delete(f"/api/races/{rid}").status_code == 404
    assert client.get(f"/api/races/{rid}").status_code == 404
    assert client.get(f"/api/races/{rid}/events").status_code == 404


def test_a_page_that_attaches_after_the_finish_still_hears_the_end(race_env):
    # A race lingers in memory after it ends, and a page attaching then got a
    # snapshot that already covered the logged `end`: so the stream closed
    # without one and the page said the race was cut off.
    client = race_env["client"]
    rid = _start(client, ["test/good"]).json()["id"]
    _wait_done(client, rid)
    assert engine.get_live(rid) is not None  # still lingering
    events = _events(client, rid)
    assert [e["type"] for e in events] == ["snapshot", "end"]
    assert events[0]["race"]["status"] == "finished"


def test_a_finished_race_leaves_memory_and_replays_from_the_database(race_env, monkeypatch):
    client = race_env["client"]
    monkeypatch.setattr(engine, "_LINGER_S", 0.05)
    rid = _start(client, ["test/good"]).json()["id"]
    _wait_done(client, rid)
    deadline = time.monotonic() + 5
    while engine.get_live(rid) is not None and time.monotonic() < deadline:
        time.sleep(0.05)
    assert engine.get_live(rid) is None
    assert client.get(f"/api/races/{rid}").json()["lanes"][0]["status"] == "finished"


def test_a_server_going_down_ends_its_streams_so_nothing_waits_on_them(race_env):
    # A stream lasts as long as its race; without this, Ctrl+C (or docker
    # stop) waited on every page watching one.
    client, app = race_env["client"], race_env["app"]
    rid = _start(client, ["test/slow"]).json()["id"]
    timer = threading.Timer(0.3, lambda: client.portal.call(begin_closing, app))
    timer.start()
    started = time.monotonic()
    events = _events(client, rid)
    timer.join()
    assert time.monotonic() - started < 5
    assert [e["type"] for e in events] == ["snapshot"]  # no `end`: the page reconnects later
    app.state.closing = False
    client.post(f"/api/races/{rid}/stop")


def test_a_running_race_cannot_be_deleted(race_env):
    client = race_env["client"]
    rid = _start(client, ["test/slow"]).json()["id"]
    assert client.delete(f"/api/races/{rid}").status_code == 409
    client.post(f"/api/races/{rid}/stop")


def test_a_race_cut_short_by_a_restart_says_so(tmp_path):
    db = str(tmp_path / "b.db")
    store.init(db)
    store.save(db, {
        "id": "abc", "status": "running", "created_at": "2026-09-21T00:00:00+00:00",
        "start": {"title": "A"}, "target": {"title": "B"}, "winner": None, "ranking": [],
        "lanes": [
            {"index": 0, "label": "m", "status": "thinking", "note": None, "elapsed_ms": None,
             "hops": 1, "think_ms": 900, "steps": [{"at_ms": 4200}]},
            # One racer had already finished when the process went down.
            {"index": 1, "label": "n", "status": "finished", "note": None, "elapsed_ms": 3000,
             "hops": 2, "think_ms": 800, "finish_order": 1, "rank": None, "steps": [{"at_ms": 3000}]},
        ],
    })
    store.init(db)  # the next startup
    race = store.get(db, "abc")
    assert race["status"] == "interrupted" and race["finished_at"]
    assert race["lanes"][0]["status"] == "stopped" and "restarted" in race["lanes"][0]["note"]
    assert race["lanes"][0]["elapsed_ms"] == 4200
    assert race["ranking"] == [1] and race["winner"] == 1 and race["lanes"][1]["rank"] == 1
    assert store.list_races(db)[0]["status"] == "interrupted"


def test_an_unreadable_race_row_does_not_stop_the_server_starting(tmp_path):
    db = str(tmp_path / "b.db")
    store.init(db)
    with store.connect(db) as conn:
        conn.execute(
            "INSERT INTO races (id, status, start_title, target_title, created_at, summary, snapshot)"
            " VALUES ('bad', 'finished', 'A', 'B', '2026-09-21T00:00:00+00:00', 'not json', '{}')"
        )
    store.init(db)


def test_a_race_is_listed_before_its_first_write_lands(race_env, monkeypatch):
    client = race_env["client"]
    monkeypatch.setattr(store, "write", lambda *a, **k: (_ for _ in ()).throw(OSError("locked")))
    monkeypatch.setattr(engine, "_WRITE_BACKOFF_S", (5.0, 5.0))
    rid = _start(client, ["test/slow"]).json()["id"]
    listed = client.get("/api/races").json()
    assert rid in listed["running"] and rid in [r["id"] for r in listed["races"]]
    client.post(f"/api/races/{rid}/stop")


# ── Rate limits ───────────────────────────────────────────────────────────────


def _lane_patches(race_id: str) -> list[dict]:
    """Every lane change the race streamed, in order: the page's view of it."""
    frames = engine.get_live(race_id).events
    return [e["patch"] for e in (json.loads(f[6:]) for f in frames) if e["type"] == "lane"]


def test_a_rate_limited_racer_waits_it_out_in_plain_sight_and_races_on(race_env, monkeypatch):
    client = race_env["client"]
    monkeypatch.setattr(engine, "_RATE_LIMIT_WAITS_S", (0.2, 0.2, 0.2, 0.2))
    rid = _start(client, ["test/limited"]).json()["id"]
    lane = _wait_done(client, rid)["lanes"][0]
    assert lane["status"] == "finished" and lane["hops"] == 2 and lane["note"] is None
    waits = [p for p in _lane_patches(rid) if p.get("status") == "rate_limited"]
    assert [w["note"].split(" — ")[0] for w in waits] == ["openrouter rate limit"] * 2
    assert "(try 2 of 5)" in waits[0]["note"] and "(try 3 of 5)" in waits[1]["note"]
    # The wait is not thinking: the turn clock stops while it lasts, and the
    # 0.4 s spent waiting is nowhere in the racer's thinking time.
    assert all(w["turn_started_ms"] is None for w in waits)
    assert lane["think_ms"] < 200


def test_a_racer_still_rate_limited_after_every_wait_stops_and_says_so(race_env, monkeypatch):
    client = race_env["client"]
    monkeypatch.setattr(engine, "_RATE_LIMIT_WAITS_S", (0.01, 0.01))
    race = _wait_done(client, _start(client, ["test/refused", "test/good"]).json()["id"])
    refused, good = race["lanes"]
    assert refused["status"] == "error" and "HTTP 429" in refused["note"]
    assert "still rate-limited after 3 tries" in refused["note"]
    assert good["status"] == "finished"  # one racer's limit holds up nobody else


def test_a_limit_that_will_not_lift_during_the_race_stops_the_racer_at_once(race_env):
    client = race_env["client"]
    lane = _wait_done(client, _start(client, ["test/closed"]).json()["id"])["lanes"][0]
    assert lane["status"] == "error" and "asks for 1h" in lane["note"]
    assert [s["model"] for s in race_env["seen"]].count("test/closed") == 1


def test_an_outage_is_still_retried_once_quickly_then_final(race_env, monkeypatch):
    client = race_env["client"]
    monkeypatch.setattr(engine, "_RETRY_DELAY_S", 0.01)
    lane = _wait_done(client, _start(client, ["test/outage"]).json()["id"])["lanes"][0]
    assert lane["status"] == "error" and "HTTP 503" in lane["note"]
    assert [s["model"] for s in race_env["seen"]].count("test/outage") == 2


def test_the_wait_is_the_schedule_or_what_the_provider_asks_whichever_is_longer():
    now = time.monotonic()

    def limited(after=None):
        return RacerError("HTTP 429", rate_limited=True, retry_after=after)

    assert engine._rate_limit_gap(limited(42.0), 5.0, 1, now, now + 600) == 42.0
    assert 5.0 <= engine._rate_limit_gap(limited(1.0), 5.0, 1, now, now + 600) <= 6.25  # jittered, never less
    with pytest.raises(RacerError, match="time limit"):
        engine._rate_limit_gap(limited(), 5.0, 1, now, now + 3)


# ── Found in review ───────────────────────────────────────────────────────────


def test_naming_the_target_on_a_page_that_links_it_by_another_name_finishes(race_env):
    client = race_env["client"]
    race = _wait_done(client, _start(client, ["test/alias"], start="Hub").json()["id"])
    lane = race["lanes"][0]
    assert lane["status"] == "finished" and lane["strikes"] == 0
    assert lane["steps"][0]["verdict"] == "ok" and lane["steps"][0]["link"] == "Twin Name"
    assert lane["steps"][0]["to"] == "Target Article"


def test_a_title_that_differs_from_the_target_only_in_case_is_not_the_finish(race_env):
    client = race_env["client"]
    r = _start(client, ["test/caseful"], start="Space Page", target="Red dwarf")
    assert r.status_code == 201, r.text  # and not "start and target are the same"
    lane = _wait_done(client, r.json()["id"])["lanes"][0]
    assert [s["to"] for s in lane["steps"]] == ["Red Dwarf", "Red dwarf"]
    assert lane["status"] == "finished" and lane["hops"] == 2


def test_a_link_past_the_cap_is_a_foul_that_says_so(race_env):
    client = race_env["client"]
    r = _start(client, ["test/peeker"], start="Long Page", rules={"max_links": 2, "strikes": 1})
    lane = _wait_done(client, r.json()["id"])["lanes"][0]
    step = lane["steps"][0]
    assert lane["status"] == "dq" and step["verdict"] == "off_page"
    assert "not among the 2 links you were shown" in step["note"]


def test_deleting_a_lingering_race_stops_it_being_served(race_env):
    client = race_env["client"]
    rid = _start(client, ["test/good"]).json()["id"]
    _wait_done(client, rid)
    assert engine.get_live(rid) is not None
    assert client.delete(f"/api/races/{rid}").status_code == 200
    assert client.get(f"/api/races/{rid}").status_code == 404
    assert client.get(f"/api/races/{rid}/events").status_code == 404


def test_a_busy_database_does_not_lose_the_final_result(race_env, monkeypatch):
    client, db = race_env["client"], race_env["settings"].db_path
    real_write = store.write
    failures = {"left": 3}

    def flaky(db_path, row):
        if row[1] != "running" and failures["left"]:
            failures["left"] -= 1
            raise OSError("database is locked")
        real_write(db_path, row)

    monkeypatch.setattr(store, "write", flaky)
    monkeypatch.setattr(engine, "_WRITE_BACKOFF_S", (0.01, 0.05))
    rid = _start(client, ["test/good"]).json()["id"]
    _wait_done(client, rid)
    assert _wait_saved(db, rid)["status"] == "finished"
    assert failures["left"] == 0
    # It left memory only after the write landed; until then it stayed live.
    assert engine.get_live(rid) is not None
