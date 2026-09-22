# WikiRace: one small image. The page has no build step, so this is Python only.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app
# Dependencies first, from the lock file, so a code change rebuilds one layer.
COPY pyproject.toml uv.lock README.md LICENSE ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev \
    && useradd --system --uid 10001 --home-dir /app wikirace \
    && mkdir -p /data && chown wikirace /data

# Inside the container the server listens on every interface, port 8000, and
# keeps its history on the /data volume. WIKIRACE_IN_DOCKER tells the settings
# that `localhost` in OLLAMA_BASE_URL means the Docker host.
ENV PATH="/app/.venv/bin:$PATH" \
    WIKIRACE_IN_DOCKER=1 \
    WIKIRACE_HOST=0.0.0.0 \
    WIKIRACE_PORT=8000 \
    WIKIRACE_DB=/data/wikirace.db

USER wikirace
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]
CMD ["wikirace"]
