"""The server: the /api router and the page, over one set of settings.

`create_app()` reads the settings itself; the command line (`wikirace`)
reads them first so it can print what it found, and passes them in. Tests
pass a fake Wikipedia and fake providers the same way:

    uvicorn wikirace.app:create_app --factory
"""
from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__, api, store
from .config import Settings, load_settings
from .providers import aclose_all, build
from .race import engine
from .race.wiki import Wiki

STATIC_DIR = Path(__file__).parent / "static"
#: How long shutdown waits for running races to record that they stopped.
_STOP_WAIT_S = 5.0


async def _stop_races() -> None:
    """Stop what is still running and wait briefly for it to be written, so a
    race cut short by a shutdown reads `stopped`, not `interrupted`."""
    running = [r for r in engine.live_races() if not r.done]
    for race in running:
        race.stop()
    tasks = [r.task for r in running if r.task is not None]
    if not tasks:
        return
    with contextlib.suppress(Exception):
        await asyncio.wait_for(asyncio.gather(*tasks, return_exceptions=True), _STOP_WAIT_S)
    for race in running:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(race.flushed(), _STOP_WAIT_S)


def begin_closing(app: FastAPI) -> None:
    """The server is going down: end every event stream now.

    A stream stays open for as long as its race runs, and a server waits for
    open connections before it shuts down, so without this a watched race
    held Ctrl+C (and `docker stop`) until its time limit. Called on the event
    loop, by the command line's server as the stop signal arrives."""
    app.state.closing = True
    for race in engine.live_races():
        race._wake()


def create_app(
    settings: Settings | None = None, *, wiki: Wiki | None = None, providers: dict[str, Any] | None = None,
) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store.init(settings.db_path)
        app.state.loop = asyncio.get_running_loop()
        yield
        await _stop_races()
        await aclose_all(app.state.providers)
        await app.state.wiki.aclose()

    app = FastAPI(
        title="WikiRace", version=__version__, lifespan=lifespan,
        docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.wiki = wiki or Wiki(user_agent=settings.user_agent)
    app.state.providers = providers if providers is not None else build(settings)
    # No login, so the Host header is checked: a page on another site that
    # points a name of its own at 127.0.0.1 (DNS rebinding) is refused before
    # it can start a race on your keys. WIKIRACE_ALLOWED_HOSTS adds names.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    app.include_router(api.router)
    # Last, so /api/* is matched first; `html=True` serves index.html at "/".
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="page")
    return app
