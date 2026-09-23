"""/api/*: who can race, subjects, and races (docs/design.md, "HTTP API").

  GET    /api/health                  {"ok": true, "version": ...}
  GET    /api/models                  every provider and model, each saying whether it can race
  GET    /api/resolve?q=              a typed subject as the article a race would use
  GET    /api/random?pool=&count=     random subjects: classic | trending | wild
  GET    /api/races                   history, newest first (a live race reads live)
  POST   /api/races                   start a race; returns its snapshot at once
  GET    /api/races/{id}              one race, whole: live, else as stored
  GET    /api/races/{id}/events       SSE: a snapshot, then every change, then `end`
  POST   /api/races/{id}/stop         stop a running race
  DELETE /api/races/{id}              drop a finished race from the history

**A racer is named `provider:model_id`**, split at the first colon, so Ollama's
`qwen3.5:9b` is `ollama:qwen3.5:9b`. A text provider races any model id it is
given (an OpenRouter model not in OPENROUTER_MODELS included); TypeSafe races
only the ones TYPESAFE_MODELS lists. Keys are read on the server, from the
settings; the page never sees one.

No authentication: the server binds to localhost unless told otherwise.
"""
from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncGenerator
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from . import __version__, store
from .config import THINKING_LEVELS, ProviderConfig, Settings
from .providers.base import ModelInfo, ProviderError
from .providers.ollama import tagged
from .race import engine
from .race.racers import JevRacer, TextRacer
from .race.rules import list_price
from .race.wiki import PageMissing, Wiki, WikiError, normalize_title

router = APIRouter(prefix="/api")

POOLS = ("classic", "trending", "wild")
#: How long the models list waits for an Ollama to say what it has.
_DISCOVER_TIMEOUT_S = 5.0
#: How long what the providers said is reused as it is (see `discovered`).
_DISCOVER_FRESH_S = 30.0


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _wiki(request: Request) -> Wiki:
    return request.app.state.wiki


def _providers(request: Request) -> dict[str, Any]:
    return request.app.state.providers


def _wiki_http(exc: Exception) -> HTTPException:
    if isinstance(exc, PageMissing):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=502, detail=f"Wikipedia: {exc}")


@router.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__}


# ── Who can race ──────────────────────────────────────────────────────────────


async def _discover(cfg: ProviderConfig, provider: Any) -> tuple[list[ModelInfo] | None, str | None]:
    """What a provider says it has (None: it is not asked), and why not when
    it cannot say."""
    discover = getattr(provider, "discover", None)
    if discover is None:
        return None, None
    try:
        return await asyncio.wait_for(discover(), _DISCOVER_TIMEOUT_S), None
    except ProviderError as exc:
        return None, str(exc)
    except TimeoutError:
        return None, f"{cfg.label} did not answer within {_DISCOVER_TIMEOUT_S:.0f} s"


Found = dict[str, tuple[list[ModelInfo] | None, str | None]]


def _asking(app: Any) -> tuple[tuple[Any, ...], list[ProviderConfig]]:
    """The providers to ask, and a key for their answer: a new provider or
    new settings (the tests swap both) is a new question."""
    settings, providers = app.state.settings, app.state.providers
    asked = [c for c in settings.providers.values() if c.configured and c.id in providers]
    return (id(settings), *((c.id, id(providers[c.id])) for c in asked)), asked


def ask_providers(app: Any) -> asyncio.Task[Found]:
    """Ask every configured provider what it has, or join the ask already
    under way. The answer is kept on the app for `discovered`."""
    key, asked = _asking(app)
    flight = getattr(app.state, "discovering", None)
    if flight is not None and flight[0] == key and not flight[1].done():
        return flight[1]
    providers = app.state.providers

    async def ask() -> Found:
        answers = await asyncio.gather(*(_discover(c, providers[c.id]) for c in asked))
        found = dict(zip([c.id for c in asked], answers, strict=True))
        app.state.discovered = (key, time.monotonic(), found)
        return found

    task = asyncio.create_task(ask())
    # Asked in the background, its failure is the next page's to report.
    task.add_done_callback(lambda t: t.cancelled() or t.exception())
    app.state.discovering = (key, task)
    return task


async def discovered(app: Any, *, fresh: bool = False) -> Found:
    """What each configured provider says it has, by id.

    Asking can take seconds (an Ollama that does not answer is waited for),
    so the answer is kept. Within _DISCOVER_FRESH_S it is reused as it is;
    after that the page is still answered from it at once while the
    providers are asked again behind it, for the next page. Only the first
    ask waits, and `fresh`: the reload button, after starting an Ollama.
    The server asks as it starts (app.py), so the first page need not wait."""
    key, _ = _asking(app)
    kept = getattr(app.state, "discovered", None)
    if kept is not None and kept[0] != key:
        kept = None
    if kept is not None and not fresh and time.monotonic() - kept[1] < _DISCOVER_FRESH_S:
        return kept[2]
    task = ask_providers(app)
    if kept is not None and not fresh:
        return kept[2]
    return await asyncio.shield(task)


def _model(
    settings: Settings, cfg: ProviderConfig, model_id: str, *, available: bool, reason: str | None,
    info: ModelInfo | None = None,
) -> dict[str, Any]:
    price = list_price(cfg.id, model_id)
    return {
        "key": f"{cfg.id}:{model_id}", "provider": cfg.id, "model_id": model_id, "label": model_id,
        "kind": cfg.kind,
        "thinking": settings.thinking_for(cfg.id, model_id) if cfg.kind == "text" else None,
        "available": available, "reason": reason,
        "price": {"input": price[0], "output": price[1]} if price else None,
        "thinks": info.thinks if info else None,
        "context": info.context if info else None,
        "note": info.note if info else "",
    }


@router.get("/models")
async def models(request: Request, fresh: bool = False) -> dict[str, Any]:
    """Every provider and model a lane can hold, each saying whether it can
    race right now. `fresh` asks the providers again and waits for them.

    An unavailable one is still listed, with the reason (a missing key, an
    Ollama that did not answer), because a model that silently vanished from
    the picker reads as "not supported" when the truth is something to fix.
    """
    settings = _settings(request)
    configs = list(settings.providers.values())
    found = await discovered(request.app, fresh=fresh)

    out_providers: list[dict[str, Any]] = []
    out_models: list[dict[str, Any]] = []
    for cfg in configs:
        infos, problem = found.get(cfg.id, (None, cfg.problem))
        available = cfg.configured and problem is None
        out_providers.append({
            "id": cfg.id, "label": cfg.label, "kind": cfg.kind,
            "configured": cfg.configured, "available": available, "reason": problem,
            "thinking": cfg.thinking if cfg.kind == "text" else None,
            "custom_models": cfg.kind == "text",
            "url": cfg.shown_url if cfg.id == "ollama" else None,
            "key_source": cfg.key_source,
        })
        # Only Ollama is asked what it has, and it lists `llama3.2` as
        # `llama3.2:latest`: both spellings are the same model.
        by_id = {tagged(i.model_id): i for i in infos or []}
        if infos is not None and not cfg.models_configured:
            # Discovered, and nothing configured narrows it: everything it has.
            for info in infos:
                out_models.append(_model(settings, cfg, info.model_id, available=True, reason=None, info=info))
            continue
        for entry in cfg.models:
            info = by_id.get(tagged(entry.model_id))
            reason = problem
            if available and infos is not None and info is None:
                reason = f"not on this {cfg.label}; pull it first (ollama pull {entry.model_id})"
            out_models.append(_model(
                settings, cfg, entry.model_id, available=reason is None, reason=reason, info=info,
            ))
    return {
        "providers": out_providers,
        "models": out_models,
        "thinking_levels": list(THINKING_LEVELS),
        "thinking": settings.thinking,
        "warnings": list(settings.warnings),
    }


# ── Subjects ──────────────────────────────────────────────────────────────────


@router.get("/resolve")
async def resolve(request: Request, q: Annotated[str, Query(max_length=250)]) -> dict[str, Any]:
    try:
        return await _wiki(request).resolve(q)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except WikiError as exc:
        raise _wiki_http(exc) from exc


@router.get("/random")
async def random_subjects(
    request: Request,
    pool: str = "classic",
    count: Annotated[int, Query(ge=1, le=2)] = 2,
    exclude: Annotated[list[str] | None, Query()] = None,
) -> dict[str, Any]:
    if pool not in POOLS:
        raise HTTPException(status_code=400, detail=f"pool must be one of {', '.join(POOLS)}")
    try:
        picked = await _wiki(request).random_subjects(pool, count, exclude or [])
    except WikiError as exc:
        raise _wiki_http(exc) from exc
    return {"pool": pool, "subjects": [{"title": s.title, "description": s.description} for s in picked]}


# ── Races ─────────────────────────────────────────────────────────────────────


class LaneIn(BaseModel):
    key: str = Field(min_length=3, max_length=300)
    #: None races on the configured level; a level overrides it.
    thinking: str | None = None

    @field_validator("thinking")
    @classmethod
    def _known(cls, v: str | None) -> str | None:
        if not (v or "").strip():
            return None
        low = v.strip().lower()  # type: ignore[union-attr]
        if low not in THINKING_LEVELS:
            raise ValueError(f"thinking must be one of {', '.join(THINKING_LEVELS)}")
        return low


class RulesIn(BaseModel):
    max_hops: int = Field(default=12, ge=1, le=40)
    #: Fouls allowed before disqualification: the third strike is out.
    strikes: int = Field(default=3, ge=1, le=10)
    time_limit_s: int = Field(default=60, ge=30, le=3600)
    #: 0 shows every link; otherwise the first N in reading order.
    max_links: int = Field(default=0, ge=0, le=10_000)


class RaceIn(BaseModel):
    start: str = Field(min_length=1, max_length=250)
    target: str = Field(min_length=1, max_length=250)
    lanes: list[LaneIn] = Field(min_length=1, max_length=4)
    rules: RulesIn = RulesIn()


def _lane_specs(lanes: list[LaneIn], settings: Settings, providers: dict[str, Any]) -> list[engine.LaneSpec]:
    specs: list[engine.LaneSpec] = []
    for ln in lanes:
        pid, sep, model_id = ln.key.partition(":")
        model_id = model_id.strip()
        cfg = settings.provider(pid)
        if not sep or cfg is None or not model_id:
            raise HTTPException(status_code=400, detail=f"unknown racer {ln.key!r}: name it provider:model")
        if cfg.problem:
            raise HTTPException(status_code=400, detail=f"{cfg.label} cannot race: {cfg.problem}")
        if cfg.kind == "judgment":
            listed = [m.model_id for m in cfg.models]
            if model_id not in listed:
                raise HTTPException(
                    status_code=400,
                    detail=f"{cfg.label} races the models {cfg.spec.prefix}_MODELS lists: {', '.join(listed)}",
                )
            specs.append(engine.LaneSpec(
                key=ln.key, label=model_id, provider=cfg.id, model_id=model_id, kind="judgment",
                thinking=None, racer=JevRacer(client=providers[cfg.id], model_id=model_id),
            ))
            continue
        if len(model_id) > 200 or any(c.isspace() for c in model_id):
            raise HTTPException(status_code=400, detail=f"“{model_id}” is not a model id")
        thinking = ln.thinking if ln.thinking is not None else settings.thinking_for(cfg.id, model_id)
        specs.append(engine.LaneSpec(
            key=ln.key, label=model_id, provider=cfg.id, model_id=model_id, kind="text",
            thinking=thinking, thinking_request=ln.thinking,
            racer=TextRacer(provider=providers[cfg.id], model_id=model_id, thinking=thinking),
        ))

    # The same model twice is a legitimate race (low thinking against high),
    # but the two lanes must not read the same.
    labels = [s.label for s in specs]
    seen: dict[str, int] = {}
    for spec, label in zip(specs, labels, strict=True):
        base = label if labels.count(label) == 1 else f"{label} · {spec.thinking or 'default'}"
        seen[base] = seen.get(base, 0) + 1
        spec.label = base if seen[base] == 1 else f"{base} #{seen[base]}"
    return specs


# Every handler that touches a race is `async`: a race lives on the event loop,
# and a plain `def` runs in a worker thread, where cancelling its tasks (stop)
# is not allowed and reading its state races the loop that writes it.


@router.get("/races")
async def list_races(request: Request, limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict[str, Any]:
    races = store.list_races(_settings(request).db_path, limit)
    live = {r.id: r for r in engine.live_races()}
    # A live race's row lags its own state (the writer is off the loop), and a
    # race only just started may have no row yet: live state wins, and a live
    # race is listed whether or not it has been written.
    stored = {r["id"] for r in races}
    races = [store.summary(live[r["id"]].state) if r["id"] in live else r for r in races]
    races += [store.summary(r.state) for rid, r in live.items() if rid not in stored]
    races.sort(key=lambda r: r["created_at"], reverse=True)
    return {"races": races[:limit], "running": [rid for rid, r in live.items() if not r.done]}


@router.post("/races", status_code=201)
async def start_race(body: RaceIn, request: Request) -> dict[str, Any]:
    settings = _settings(request)
    specs = _lane_specs(body.lanes, settings, _providers(request))
    wiki = _wiki(request)
    try:
        start_page = await wiki.page(body.start)
        target = await wiki.lookup(body.target)
    except PageMissing as exc:
        raise HTTPException(status_code=400, detail=f"no article to start from: {exc}") from exc
    except WikiError as exc:
        raise _wiki_http(exc) from exc
    if not target.exists:
        raise HTTPException(status_code=400, detail=f"no Wikipedia article is titled “{body.target}”")
    # Canonical titles, compared exactly: "Red dwarf" and "Red Dwarf" are two
    # articles and a fine course.
    if normalize_title(start_page.title) == normalize_title(target.title):
        raise HTTPException(status_code=400, detail=f"start and target are both “{target.title}”")
    if not start_page.links:
        raise HTTPException(status_code=400, detail=f"“{start_page.title}” has no links to follow")
    try:
        # The target's other names, so naming it while the page links it under
        # one of them is judged the move it is. Best effort: without them a
        # race still runs, it just judges that case as a jump.
        aliases = await wiki.redirects_to(target.title)
    except WikiError:
        aliases = []
    try:
        race = engine.start_race(
            db_path=settings.db_path, wiki=wiki, start_page=start_page, start_input=body.start,
            target=target, target_input=body.target, rules=body.rules.model_dump(), lanes=specs,
            target_aliases=aliases, max_live=settings.max_races,
        )
    except engine.TooManyRaces as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return race.state


@router.get("/races/{race_id}")
async def get_race(race_id: str, request: Request) -> dict[str, Any]:
    live = engine.get_live(race_id)
    if live is not None:
        return live.state
    race = store.get(_settings(request).db_path, race_id)
    if race is None:
        raise HTTPException(status_code=404, detail=f"no race {race_id}")
    return race


async def _stream(race_id: str, request: Request) -> AsyncGenerator[str, None]:
    live = engine.get_live(race_id)
    if live is None:
        # Over (or never live in this process): the stored race, then the end.
        race = store.get(_settings(request).db_path, race_id)
        if race is not None:
            yield f"data: {json.dumps({'type': 'snapshot', 'race': race})}\n\n"
        yield 'data: {"type": "end"}\n\n'
        return
    seen, frame = live.snapshot()
    yield frame
    while True:
        # Every stream ends with `end`, including one that attached after the
        # finish, whose snapshot already holds the whole race.
        if live.done and seen >= len(live.events):
            yield 'data: {"type": "end"}\n\n'
            return
        fresh = await live.wait(seen, engine.KEEPALIVE_S)
        while seen < len(live.events):
            yield live.events[seen]
            seen += 1
        if getattr(request.app.state, "closing", False) and not live.done:
            # The server is going down (app.begin_closing). Ended without an
            # `end`, so the page reconnects, and finds the race as recorded,
            # once the server is back.
            return
        if not fresh and not live.done:
            if await request.is_disconnected():
                return
            yield ": ping\n\n"


@router.get("/races/{race_id}/events")
async def race_events(race_id: str, request: Request) -> StreamingResponse:
    # Resolved before the response starts, so an unknown id is a 404 and not a
    # 200 whose stream then carries an error.
    if engine.get_live(race_id) is None and store.get(_settings(request).db_path, race_id) is None:
        raise HTTPException(status_code=404, detail=f"no race {race_id}")
    return StreamingResponse(
        _stream(race_id, request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/races/{race_id}/stop", status_code=202)
async def stop_race(race_id: str) -> dict[str, Any]:
    live = engine.get_live(race_id)
    if live is None or live.done:
        raise HTTPException(status_code=409, detail=f"race {race_id} is not running")
    live.stop()
    return {"id": race_id, "stopping": True}


@router.delete("/races/{race_id}")
async def delete_race(race_id: str, request: Request) -> dict[str, Any]:
    live = engine.get_live(race_id)
    if live is not None and not live.done:
        raise HTTPException(status_code=409, detail="stop the race before deleting it")
    if live is not None:
        # Its final write may still be in flight; deleting under it would let
        # that write put the row straight back.
        await live.flushed()
    # Out of memory too: a race lingering after its finish would otherwise go
    # on being served for two minutes after the delete said it was gone.
    engine.forget(race_id)
    if not store.delete(_settings(request).db_path, race_id):
        raise HTTPException(status_code=404, detail=f"no race {race_id}")
    return {"deleted": race_id}
