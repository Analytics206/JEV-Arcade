"""The server: the /api router and the page, over one set of settings.

`create_app()` reads the settings itself; the command line (`wikirace`)
reads them first so it can print what it found, and passes them in. Tests
pass a fake Wikipedia and fake providers the same way:

    uvicorn wikirace.app:create_app --factory
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__, api, site, store
from .config import Settings, load_settings, twin_host
from .games import api as games_api
from .games import runs as game_runs
from .games import store as games_store
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
    game_runs.wake_all()


class Page(StaticFiles):
    """The page's files at their plain addresses (/styles.css), for anything
    that still asks for them there: checked on every load (a 304 when
    unchanged). The page itself loads them from `Versioned`."""

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def fingerprint(root: Path) -> str:
    """Changes whenever a file of the page does: each file's name, size and
    modification time. A walk of the page's files takes milliseconds, so it is
    taken on every page load, and an edit is seen without a restart."""
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            st = p.stat()
            h.update(f"{p.relative_to(root).as_posix()}\0{st.st_size}\0{st.st_mtime_ns}\n".encode())
    return h.hexdigest()[:12]


def _route_path(scope: Scope) -> str:
    path, root = scope["path"], scope.get("root_path", "")
    return path[len(root):] if root and path.startswith(root) else path


class Versioned(Page):
    """The page's files under /v/<fingerprint>/. The address changes whenever
    a file does, so nothing between here and the reader (the browser's cache,
    Cloudflare's) can hand out an old copy, whatever it is set to keep, and a
    copy may be kept for good. Every relative import stays inside the one
    version. Any fingerprint serves today's files, so a page left open across
    a rebuild still loads its games; only today's is marked immutable."""

    def __init__(self, **kw: Any) -> None:
        super().__init__(**kw)
        self.current = ""

    @staticmethod
    def _split(scope: Scope) -> tuple[str, str]:
        version, _, rest = _route_path(scope).lstrip("/").partition("/")
        return version, rest

    def get_path(self, scope: Scope) -> str:
        return os.path.normpath(os.path.join(*self._split(scope)[1].split("/")))

    def file_response(self, *args: Any, **kwargs: Any) -> Response:
        response = super().file_response(*args, **kwargs)
        scope = kwargs.get("scope", args[2] if len(args) > 2 else {})
        if self.current and self._split(scope)[0] == self.current:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


class CanonicalHost:
    """WIKIRACE_CANONICAL_HOST: the public site has one address. A visit to
    its twin (`www.jev-arcade.com` for `jev-arcade.com`, or the other way) is
    sent there with its path and query, and so is a visit over plain http,
    which the proxy in front (a Cloudflare Tunnel) reports in
    X-Forwarded-Proto. localhost, and any other name, is left alone."""

    def __init__(self, app: ASGIApp, host: str) -> None:
        self.app, self.host, self.twin = app, host, twin_host(host)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            name = headers.get("host", "").split(":")[0].lower()
            plain = headers.get("x-forwarded-proto", "").split(",")[0].strip().lower() == "http"
            if name == self.twin or (name == self.host and plain):
                path = scope.get("raw_path") or scope["path"].encode()
                query = scope.get("query_string") or b""
                url = f"https://{self.host}{path.decode('latin-1')}" + (f"?{query.decode('latin-1')}" if query else "")
                # 308 keeps a POST a POST; a page load gets the 301 every browser caches.
                status = 301 if scope["method"] in ("GET", "HEAD") else 308
                await RedirectResponse(url, status_code=status)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(
    settings: Settings | None = None, *, wiki: Wiki | None = None, providers: dict[str, Any] | None = None,
) -> FastAPI:
    settings = settings or load_settings()

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        store.init(settings.db_path)
        games_store.init(settings.db_path)
        app.state.loop = asyncio.get_running_loop()
        # Ask the providers what they have now, so the first page need not wait.
        api.ask_providers(app)
        yield
        flight = getattr(app.state, "discovering", None)
        if flight is not None:
            flight[1].cancel()
        await _stop_races()
        await game_runs.stop_all(_STOP_WAIT_S)
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
    if settings.canonical_host:
        # Added last, so it runs first.
        app.add_middleware(CanonicalHost, host=settings.canonical_host)
    app.include_router(api.router)
    app.include_router(games_api.router)

    # The page, pointed at today's version of its files: never kept, so a
    # rebuild is picked up on the next load, from the server itself.
    versioned = Versioned(directory=STATIC_DIR)

    def site_base(request: Request) -> str:
        """The site's own address, for canonical links and the sitemap."""
        if settings.canonical_host:
            return f"https://{settings.canonical_host}"
        base = str(request.base_url).rstrip("/")
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
        return f"{proto}://{base.split('://', 1)[1]}" if proto in ("http", "https") else base

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    @app.api_route("/index.html", methods=["GET", "HEAD"], include_in_schema=False)
    def page(request: Request) -> HTMLResponse:
        versioned.current = fingerprint(STATIC_DIR)
        text = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
        text = site.render(text.replace('"./', f'"./v/{versioned.current}/'), request.query_params, site_base(request))
        return HTMLResponse(text, headers={"Cache-Control": "no-cache"})

    @app.api_route("/sitemap.xml", methods=["GET", "HEAD"], include_in_schema=False)
    def sitemap(request: Request) -> Response:
        built = max(p.stat().st_mtime for p in STATIC_DIR.rglob("*") if p.is_file())
        lastmod = datetime.fromtimestamp(built, tz=UTC).date()
        return Response(site.sitemap(site_base(request), lastmod), media_type="application/xml",
                        headers={"Cache-Control": "public, max-age=3600"})

    @app.api_route("/robots.txt", methods=["GET", "HEAD"], include_in_schema=False)
    def robots(request: Request) -> Response:
        return Response(site.robots(site_base(request)), media_type="text/plain",
                        headers={"Cache-Control": "public, max-age=3600"})

    app.mount("/v", versioned, name="versioned")
    files = Page(directory=STATIC_DIR, html=True)
    if settings.site_root and Path(settings.site_root).is_dir():
        # This deployment's own files at the site's root (Google's
        # verification file, say), looked for after the page's own, so none
        # of them can stand in for one of the page's.
        files.all_directories = [*files.all_directories, settings.site_root]
    # Last, so /api/* is matched first.
    app.mount("/", files, name="page")
    return app
