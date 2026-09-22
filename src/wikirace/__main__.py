"""`wikirace` / `python -m wikirace`: read the settings, say what was found, serve."""
from __future__ import annotations

import argparse
import sys

from . import __version__
from .config import Settings, load_settings

#: Seconds shutdown waits for open connections. A page watching a race holds
#: its event stream open until the race ends, so without a bound Ctrl+C (or
#: `docker compose down`) would wait for the race; after this the streams are
#: closed and the races are stopped and recorded as stopped.
GRACEFUL_SHUTDOWN_S = 3


def summary(settings: Settings, host: str, port: int) -> str:
    """What a person starting the server wants to know: where to open it, which
    settings were read, and which providers can race. Never a key or a URL's
    password."""
    if settings.in_docker:
        lines = [f"WikiRace {__version__}  listening on port {port} in this container "
                 "(open the port compose publishes, WIKIRACE_PORT)"]
        lines.append("  settings: the container's environment (compose hands it .env)")
    else:
        shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
        lines = [f"WikiRace {__version__}  http://{shown}:{port}"]
        lines.append(f"  settings: {settings.env_file or 'environment only (no .env found)'}")
    for cfg in settings.providers.values():
        if cfg.id == "ollama" and cfg.configured:
            models = ", ".join(m.model_id for m in cfg.models) if cfg.models else "every model it has"
            state, what = "set", f"{cfg.shown_url}  {models} (asked when the page opens)"
        elif cfg.configured:
            state, what = "ready", ", ".join(m.model_id for m in cfg.models)
        else:
            state, what = "off", cfg.problem or ""
        lines.append(f"  {cfg.label:<11}{state:<7}{what}")
    if settings.thinking:
        lines.append(f"  thinking: {settings.thinking} unless a provider or model says otherwise")
    if host not in ("127.0.0.1", "localhost") and not settings.in_docker and "*" not in settings.allowed_hosts:
        lines.append(f"  answering to: {', '.join(settings.allowed_hosts)} (add names in WIKIRACE_ALLOWED_HOSTS)")
    lines += [f"  ! {w}" for w in settings.warnings]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="wikirace", description="Language models race across Wikipedia, link by link.",
    )
    parser.add_argument("--host", help="address to bind (WIKIRACE_HOST, default 127.0.0.1)")
    parser.add_argument("--port", type=int, help="port (WIKIRACE_PORT, default 8000)")
    parser.add_argument("--env-file", help="settings file to read (WIKIRACE_ENV_FILE, default ./.env)")
    parser.add_argument("--version", action="version", version=f"wikirace {__version__}")
    args = parser.parse_args(argv)

    settings = load_settings(env_file=args.env_file)
    host, port = args.host or settings.host, args.port or settings.port
    print(summary(settings, host, port), file=sys.stderr, flush=True)

    import uvicorn  # noqa: PLC0415 - not needed for --help or --version

    from .app import begin_closing, create_app  # noqa: PLC0415

    app = create_app(settings)

    class Server(uvicorn.Server):
        """On Ctrl+C or SIGTERM, the event streams are ended first, so the
        server is not left waiting on pages that watch a race (see
        `begin_closing`). The graceful timeout stays as a backstop."""

        def handle_exit(self, sig, frame):  # type: ignore[no-untyped-def]
            loop = getattr(app.state, "loop", None)
            if loop is not None and not loop.is_closed():
                loop.call_soon_threadsafe(begin_closing, app)
            super().handle_exit(sig, frame)

    Server(uvicorn.Config(
        app, host=host, port=port, log_level="info", timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S,
    )).run()


if __name__ == "__main__":
    main()
