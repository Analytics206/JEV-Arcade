"""/api/games/*: the Arcade's games and their runs.

  GET    /api/games                          every game: title, use case, who may play, its params schema
  POST   /api/games/{game}/runs              start a run: {"lanes": [{key, thinking}], "params": {...}}
  GET    /api/games/runs?game=&limit=        recent runs, newest first (a live one reads live)
  GET    /api/games/runs/{id}                one run, whole
  GET    /api/games/runs/{id}/events         SSE: a snapshot, then every change, then `end`
  POST   /api/games/runs/{id}/stop           stop a running run
  DELETE /api/games/runs/{id}                drop a finished run

Players are named as racers are, `provider:model_id`, and checked the same way
(games/players.py). A game's own `params` are validated by its model: a bad
one is a 422 naming the field.
"""
from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError

from ..api import LaneIn
from ..race.wiki import WikiError
from . import runs, store
from .players import BadPlayers, resolve_players
from .registry import GAMES, Context, GameInputError, GameSourceError, get_game

router = APIRouter(prefix="/api/games")


class RunIn(BaseModel):
    lanes: list[LaneIn] = Field(default_factory=list, max_length=4)
    params: dict[str, Any] = Field(default_factory=dict)


def _db(request: Request) -> str:
    return request.app.state.settings.db_path


@router.get("")
async def list_games() -> dict[str, Any]:
    return {"games": [g.public() for g in GAMES.values()]}


@router.post("/{game_id}/runs", status_code=201)
async def start_run(game_id: str, body: RunIn, request: Request) -> dict[str, Any]:
    game = get_game(game_id)
    if game is None:
        raise HTTPException(status_code=404, detail=f"no game {game_id!r}")
    if not game.ready:
        raise HTTPException(status_code=409, detail=f"{game.title} is not built yet")
    lo, hi = game.lanes
    if not lo <= len(body.lanes) <= hi:
        want = f"{lo}" if lo == hi else f"{lo} to {hi}"
        raise HTTPException(status_code=400, detail=f"{game.title} takes {want} players, not {len(body.lanes)}")
    try:
        params = game.params(**body.params)
    except ValidationError as exc:
        # Without the context: a validator's own ValueError rides in it, and is not JSON.
        raise HTTPException(
            status_code=422, detail=exc.errors(include_url=False, include_context=False, include_input=False),
        ) from exc
    settings = request.app.state.settings
    try:
        players = resolve_players(body.lanes, settings, request.app.state.providers, kinds=game.kinds)
    except BadPlayers as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if game.needs_jev and not any(p.is_jev for p in players):
        raise HTTPException(status_code=400, detail=f"{game.title} needs Jev in at least one lane")
    ctx = Context(
        settings=settings, providers=request.app.state.providers, wiki=request.app.state.wiki,
        players=players, params=params,
    )
    extra: dict[str, Any] = {}
    if game.prepare is not None:
        try:
            extra = await game.prepare(ctx)
        except GameInputError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except (GameSourceError, WikiError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
    try:
        run = runs.start_run(
            game=game.id, players=players, params=params.model_dump(), db_path=settings.db_path,
            play=lambda r: game.play(r, ctx), extra=extra,
        )
    except runs.TooManyRuns as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return run.state


@router.get("/runs")
async def list_runs(
    request: Request, game: str | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, Any]:
    stored = store.list_runs(_db(request), game, limit)
    live = {r.id: r for r in runs.live_runs() if game is None or r.state["game"] == game}
    ids = {r["id"] for r in stored}
    out = [store.summary(live[r["id"]].state) if r["id"] in live else r for r in stored]
    out += [store.summary(r.state) for rid, r in live.items() if rid not in ids]
    out.sort(key=lambda r: r["created_at"], reverse=True)
    return {"runs": out[:limit], "running": [rid for rid, r in live.items() if not r.done]}


@router.get("/runs/{run_id}")
async def get_run(run_id: str, request: Request) -> dict[str, Any]:
    live = runs.get_live(run_id)
    if live is not None:
        return live.state
    run = store.get(_db(request), run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"no run {run_id}")
    return run


async def _stream(run_id: str, request: Request) -> AsyncGenerator[str, None]:
    live = runs.get_live(run_id)
    if live is None:
        run = store.get(_db(request), run_id)
        if run is not None:
            yield f"data: {json.dumps({'type': 'snapshot', 'run': run})}\n\n"
        yield 'data: {"type": "end"}\n\n'
        return
    seen, frame = live.snapshot()
    yield frame
    while True:
        if live.done and seen >= len(live.events):
            yield 'data: {"type": "end"}\n\n'
            return
        fresh = await live.wait(seen, runs.KEEPALIVE_S)
        while seen < len(live.events):
            yield live.events[seen]
            seen += 1
        if getattr(request.app.state, "closing", False) and not live.done:
            return
        if not fresh and not live.done:
            if await request.is_disconnected():
                return
            yield ": ping\n\n"


@router.get("/runs/{run_id}/events")
async def run_events(run_id: str, request: Request) -> StreamingResponse:
    if runs.get_live(run_id) is None and store.get(_db(request), run_id) is None:
        raise HTTPException(status_code=404, detail=f"no run {run_id}")
    return StreamingResponse(
        _stream(run_id, request), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/runs/{run_id}/stop", status_code=202)
async def stop_run(run_id: str) -> dict[str, Any]:
    live = runs.get_live(run_id)
    if live is None or live.done:
        raise HTTPException(status_code=409, detail=f"run {run_id} is not running")
    live.stop()
    return {"id": run_id, "stopping": True}


@router.delete("/runs/{run_id}")
async def delete_run(run_id: str, request: Request) -> dict[str, Any]:
    live = runs.get_live(run_id)
    if live is not None and not live.done:
        raise HTTPException(status_code=409, detail="stop the game before deleting it")
    if live is not None:
        await live.flushed()
    runs.forget(run_id)
    if not store.delete(_db(request), run_id):
        raise HTTPException(status_code=404, detail=f"no run {run_id}")
    return {"deleted": run_id}
