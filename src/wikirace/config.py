"""Settings: one set of variables for both ways of running WikiRace.

Every setting is an environment variable. `wikirace` (or `python -m wikirace`)
also reads a `.env` file, the working directory's or the one named by
WIKIRACE_ENV_FILE, and `docker compose up` hands that same file to the
container. One file configures both. A variable set in the real environment
wins over the file; an empty one does not, so a blank `KEY=` exported by a
shell never hides the key written in `.env`.

Per provider there are four variables: the key, the models, the thinking level
and the base URL. The models are a comma-separated list, and `model@level` pins
one model's thinking level:

    OPENAI_API_KEY=sk-...
    OPENAI_MODELS=gpt-4.1-mini, o4-mini@high
    OPENAI_THINKING=low

A racer's thinking level is, first to last: what the race setup asked for, the
model's `@level`, `<PROVIDER>_THINKING`, `WIKIRACE_THINKING`. None of them set
means none is sent, and the model thinks as it does by default.

Nothing here raises over a bad value. A typo is reported in `warnings`, which
the models endpoint shows on the page, and the value falls back to its default,
because a misspelt thinking level should not stop a race from starting.
"""
from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from . import __version__

#: Thinking levels, least to most. `none` asks for no thinking at all; a level
#: left unset sends nothing and the model does what it does by default.
THINKING_LEVELS: tuple[str, ...] = ("none", "low", "medium", "high", "xhigh", "max")

DEFAULT_PORT = 8000
DEFAULT_DB = "data/wikirace.db"
DEFAULT_MAX_RACES = 2
#: Tokens of context a local Ollama model is given per request. Ollama's own
#: default is small enough to cut a big article's link list, and the rules with
#: it, without saying so; see providers/ollama.py.
DEFAULT_OLLAMA_NUM_CTX = 16384
#: Wikimedia asks every client to name itself and a way to reach its operator.
DEFAULT_USER_AGENT = f"wikirace/{__version__} (https://github.com/Analytics206/JEV-Arcade)"

_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})


@dataclass(frozen=True)
class ProviderSpec:
    """What WikiRace knows about a provider before any variable is read."""

    id: str
    label: str
    #: `text` models answer in words and can foul; `judgment` models (TypeSafe)
    #: score the page's own links and cannot.
    kind: str
    key_env: str
    url_env: str
    default_url: str
    #: The roster when `<PROVIDER>_MODELS` is unset. Empty for Ollama, which is
    #: asked what it has.
    default_models: tuple[str, ...]
    #: False when a base URL alone is enough (Ollama); the key is then optional.
    needs_key: bool = True

    @property
    def prefix(self) -> str:
        return self.id.upper()


PROVIDERS: tuple[ProviderSpec, ...] = (
    ProviderSpec(
        "anthropic", "Anthropic", "text", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
        "https://api.anthropic.com", ("claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"),
    ),
    ProviderSpec(
        "openai", "OpenAI", "text", "OPENAI_API_KEY", "OPENAI_BASE_URL",
        "https://api.openai.com/v1", ("gpt-4.1-mini", "o4-mini"),
    ),
    ProviderSpec(
        "openrouter", "OpenRouter", "text", "OPENROUTER_API_KEY", "OPENROUTER_BASE_URL",
        "https://openrouter.ai/api/v1", ("deepseek/deepseek-v4-flash", "minimax/minimax-m3"),
    ),
    ProviderSpec(
        "ollama", "Ollama", "text", "OLLAMA_API_KEY", "OLLAMA_BASE_URL",
        "http://localhost:11434", (), needs_key=False,
    ),
    ProviderSpec(
        "typesafe", "TypeSafe", "judgment", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL",
        "https://api.typesafe.ai/v1", ("jev-1.13.0",),
    ),
)
PROVIDER_IDS: tuple[str, ...] = tuple(p.id for p in PROVIDERS)


@dataclass(frozen=True)
class ModelEntry:
    model_id: str
    #: The level pinned with `model@level`, or None.
    thinking: str | None = None


@dataclass(frozen=True)
class ProviderConfig:
    """One provider as configured: the spec plus what the variables said."""

    spec: ProviderSpec
    api_key: str
    #: Trailing slash removed. For Ollama inside a container, `localhost` has
    #: already been turned into the host (see `_container_url`).
    base_url: str
    #: The roster, in order. Empty for Ollama unless OLLAMA_MODELS names some.
    models: tuple[ModelEntry, ...]
    #: `<PROVIDER>_THINKING`, validated; None when unset.
    thinking: str | None
    #: Where the key came from: "environment", ".env", or None when unset.
    key_source: str | None
    #: True when `<PROVIDER>_MODELS` was set, so the roster is the user's list.
    models_configured: bool = False
    #: Ollama's context window per request.
    num_ctx: int = DEFAULT_OLLAMA_NUM_CTX

    @property
    def id(self) -> str:
        return self.spec.id

    @property
    def label(self) -> str:
        return self.spec.label

    @property
    def kind(self) -> str:
        return self.spec.kind

    @property
    def configured(self) -> bool:
        return bool(self.api_key) if self.spec.needs_key else bool(self.base_url)

    @property
    def problem(self) -> str | None:
        """Why this provider cannot race, as the fix, or None."""
        if self.configured:
            return None
        if self.spec.needs_key:
            return f"set {self.spec.key_env} in .env"
        return f"off: set {self.spec.url_env} in .env to your Ollama (for example http://localhost:11434)"

    @property
    def shown_url(self) -> str:
        """The base URL as it may be shown (no credentials)."""
        return display_url(self.base_url) if self.base_url else ""

    def thinking_for(self, model_id: str) -> str | None:
        """The configured level for *model_id*: its `@level`, else the provider's."""
        for m in self.models:
            if m.model_id == model_id and m.thinking:
                return m.thinking
        return self.thinking


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    db_path: str = DEFAULT_DB
    #: WIKIRACE_THINKING: the level every racer gets when nothing nearer says.
    thinking: str | None = None
    max_races: int = DEFAULT_MAX_RACES
    user_agent: str = DEFAULT_USER_AGENT
    in_docker: bool = False
    #: Host names the server answers to. The API has no login, so a web page
    #: elsewhere must not be able to reach it by pointing a name of its own at
    #: 127.0.0.1 (DNS rebinding). "*" answers to any.
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1")
    #: WIKIRACE_CANONICAL_HOST: the one public address (`jev-arcade.com`). Its
    #: twin (`www.` added or taken away) and plain http redirect to it.
    canonical_host: str | None = None
    #: The .env file that was read, or None.
    env_file: str | None = None
    providers: Mapping[str, ProviderConfig] = field(default_factory=dict)
    #: Values that were ignored, in words a person can act on.
    warnings: tuple[str, ...] = ()

    def provider(self, provider_id: str) -> ProviderConfig | None:
        return self.providers.get(provider_id)

    def thinking_for(self, provider_id: str, model_id: str) -> str | None:
        """A model's configured level: `@level`, then the provider's, then the global one."""
        cfg = self.providers.get(provider_id)
        return (cfg.thinking_for(model_id) if cfg else None) or self.thinking


# ── .env ─────────────────────────────────────────────────────────────────────


def read_env_file(path: str | os.PathLike[str]) -> dict[str, str]:
    """`KEY=value` lines, the way Docker Compose reads an env_file.

    Blank lines and `#` comments are skipped; an `export ` prefix is allowed;
    a value may be quoted, and an unquoted value ends at ` #`. A line that is
    not an assignment is skipped rather than fatal. No variable expansion:
    `$` is a character like any other.
    """
    out: dict[str, str] = {}
    text = Path(path).read_text(encoding="utf-8-sig")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, sep, value = line.partition("=")
        key = key.strip()
        if not sep or not _KEY.fullmatch(key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
            quote, value = value[0], value[1:-1]
            if quote == '"':
                value = value.replace("\\n", "\n").replace('\\"', '"')
        else:
            m = re.search(r"\s#", value)
            if m:
                value = value[: m.start()].rstrip()
        out[key] = value
    return out


def _find_env_file(explicit: str | None, environ: Mapping[str, str]) -> Path | None:
    named = explicit or environ.get("WIKIRACE_ENV_FILE") or ""
    path = Path(named) if named else Path.cwd() / ".env"
    return path if path.is_file() else None


# ── parsing ──────────────────────────────────────────────────────────────────


def _level(raw: str, where: str, warnings: list[str]) -> str | None:
    value = raw.strip().lower()
    if not value:
        return None
    if value in THINKING_LEVELS:
        return value
    warnings.append(f"{where}: “{raw.strip()}” is not a thinking level ({', '.join(THINKING_LEVELS)}), so it was ignored")
    return None


def parse_models(raw: str, where: str, warnings: list[str]) -> tuple[ModelEntry, ...]:
    """`a, b@high, c` as entries. An `@` whose tail is not a level stays part
    of the id, with a warning, so a model id that really has one still works."""
    out: list[ModelEntry] = []
    seen: set[str] = set()
    for item in re.split(r"[,\n]", raw):
        item = item.strip()
        if not item:
            continue
        model_id, thinking = item, None
        if "@" in item:
            head, _, tail = item.rpartition("@")
            if tail.strip().lower() in THINKING_LEVELS and head.strip():
                model_id, thinking = head.strip(), tail.strip().lower()
            else:
                warnings.append(
                    f"{where}: “{item}” — “@{tail}” is not a thinking level, so the whole of it was taken as the model id"
                )
        if model_id in seen:
            continue
        seen.add(model_id)
        out.append(ModelEntry(model_id, thinking))
    return tuple(out)


def _int(raw: str, default: int, where: str, warnings: list[str], lo: int, hi: int) -> int:
    if not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        warnings.append(f"{where}: “{raw}” is not a whole number, so {default} was used")
        return default
    if not lo <= value <= hi:
        warnings.append(f"{where}: {value} is outside {lo}–{hi}, so {default} was used")
        return default
    return value


def display_url(url: str) -> str:
    """*url* as it may be shown: on the page, in a log, in an error. A URL can
    carry a password (`http://user:secret@ollama.lan:11434` is how httpx is
    told to use basic auth) or a token in its query, and neither may be shown."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return "(an unreadable URL)"
    if not parts.hostname:
        return url.split("@")[-1].split("?")[0]
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return urlunsplit((parts.scheme, host + (f":{port}" if port else ""), parts.path, "", ""))


def _container_url(url: str) -> str:
    """Inside a container `localhost` is the container itself. An Ollama the
    person reaches at localhost from their own machine is the Docker host,
    which compose maps to `host.docker.internal`, so the same `.env` works
    for both ways of running. Credentials in the URL are kept."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return url  # left as written; the provider says it is unusable
    if (parts.hostname or "").lower() not in _LOCAL_HOSTS:
        return url
    userinfo = parts.netloc.rpartition("@")[0]
    netloc = (f"{userinfo}@" if userinfo else "") + "host.docker.internal" + (f":{port}" if port else "")
    return urlunsplit(parts._replace(netloc=netloc))


def _truthy(raw: str) -> bool:
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _hosts(raw: str, canonical: str | None = None) -> tuple[str, ...]:
    """WIKIRACE_ALLOWED_HOSTS: names beyond localhost the page is served under
    (`wikirace.lan, 192.168.1.20`), or `*` for any. The canonical host and its
    twin are answered to without being listed."""
    extra = [h.strip().lower() for h in raw.split(",") if h.strip()]
    if "*" in extra:
        return ("*",)
    public = [canonical, twin_host(canonical)] if canonical else []
    return tuple(dict.fromkeys(["localhost", "127.0.0.1", *extra, *public]))


def twin_host(host: str) -> str:
    """The other name people type for a site: `www.` added or taken away."""
    return host[4:] if host.startswith("www.") else f"www.{host}"


_HOSTNAME = re.compile(r"(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")


def _canonical(raw: str, warnings: list[str]) -> str | None:
    """WIKIRACE_CANONICAL_HOST as a bare name: `https://JEV-Arcade.com/` is
    `jev-arcade.com`."""
    name = re.sub(r"^[a-z][a-z0-9+.-]*://", "", raw.strip().lower()).split("/")[0]
    if not name:
        return None
    if not _HOSTNAME.fullmatch(name):
        warnings.append(f"WIKIRACE_CANONICAL_HOST={raw!r} is not a domain name (jev-arcade.com); ignored")
        return None
    return name


# ── loading ──────────────────────────────────────────────────────────────────


def load_settings(
    environ: Mapping[str, str] | None = None, env_file: str | None = None, *, read_file: bool = True,
) -> Settings:
    """Settings from *environ* (default: the process environment) over the
    `.env` file. `read_file=False` reads the environment alone (the tests do)."""
    env = dict(os.environ if environ is None else environ)
    path = _find_env_file(env_file, env) if read_file else None
    file_vals = read_env_file(path) if path else {}
    warnings: list[str] = []
    if env_file and path is None:
        warnings.append(f"no env file at {env_file}; reading the environment only")

    def get(name: str, default: str = "") -> tuple[str, str | None]:
        value = env.get(name, "")
        if value.strip():
            return value.strip(), "environment"
        value = file_vals.get(name, "")
        if value.strip():
            return value.strip(), ".env"
        return default, None

    def blanked(name: str) -> bool:
        """Set, to nothing, on purpose (`OLLAMA_BASE_URL=`)."""
        return name in env or name in file_vals

    # The image sets this; other containers (a devcontainer, a CI job) do not,
    # and there `localhost` means what it says.
    in_docker = _truthy(get("WIKIRACE_IN_DOCKER")[0])
    providers: dict[str, ProviderConfig] = {}
    for spec in PROVIDERS:
        key, key_source = get(spec.key_env)
        url, url_source = get(spec.url_env, spec.default_url)
        if url_source is None and not spec.needs_key and blanked(spec.url_env):
            url = ""  # an Ollama nobody runs is switched off by an empty URL
        url = url.rstrip("/")
        if spec.id == "ollama" and in_docker and url:
            url = _container_url(url)
        models_raw, models_source = get(f"{spec.prefix}_MODELS")
        models = parse_models(models_raw, f"{spec.prefix}_MODELS", warnings) if models_source else ()
        if not models_source:
            models = tuple(ModelEntry(m) for m in spec.default_models)
        providers[spec.id] = ProviderConfig(
            spec=spec,
            api_key=key,
            base_url=url,
            models=models,
            thinking=_level(get(f"{spec.prefix}_THINKING")[0], f"{spec.prefix}_THINKING", warnings),
            key_source=key_source,
            models_configured=models_source is not None,
            num_ctx=_int(get("OLLAMA_NUM_CTX")[0], DEFAULT_OLLAMA_NUM_CTX, "OLLAMA_NUM_CTX", warnings, 2048, 1_048_576)
            if spec.id == "ollama" else DEFAULT_OLLAMA_NUM_CTX,
        )

    canonical = _canonical(get("WIKIRACE_CANONICAL_HOST")[0], warnings)
    return Settings(
        host=get("WIKIRACE_HOST", "127.0.0.1")[0],
        port=_int(get("WIKIRACE_PORT")[0], DEFAULT_PORT, "WIKIRACE_PORT", warnings, 1, 65535),
        db_path=get("WIKIRACE_DB", DEFAULT_DB)[0],
        thinking=_level(get("WIKIRACE_THINKING")[0], "WIKIRACE_THINKING", warnings),
        max_races=_int(get("WIKIRACE_MAX_RACES")[0], DEFAULT_MAX_RACES, "WIKIRACE_MAX_RACES", warnings, 1, 16),
        user_agent=get("WIKIRACE_USER_AGENT", DEFAULT_USER_AGENT)[0],
        allowed_hosts=_hosts(get("WIKIRACE_ALLOWED_HOSTS")[0], canonical),
        canonical_host=canonical,
        in_docker=in_docker,
        env_file=str(path) if path else None,
        providers=providers,
        warnings=tuple(warnings),
    )
