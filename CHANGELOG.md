# Changelog

Notable changes to JEV-Arcade. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are the `version` in `pyproject.toml`, which `wikirace --version` and `/api/health` report.

## [Unreleased]

### Changed
- The Docker image runs on Python 3.14 (was 3.12) and uv 0.12.
- CI also tests Python 3.14, uses current actions (checkout v7, setup-uv v10, setup-node v7),
  cancels a run a newer push supersedes, and checks that the image serves the sitemap.
- Dependencies refreshed in `uv.lock`: anthropic 1.8.0, starlette 1.7.0.
- Dependabot watches GitHub Actions, the Python lock file and the image's base images
  (`.github/dependabot.yml`).

### Documentation
- `docs/deploy.md`: running it for other people (Docker, updates, backups, your own domain, cost
  control), with a Cloudflare Tunnel as the example.
- `CONTRIBUTING.md`, `SECURITY.md` and this changelog.
- `docs/design.md` now covers the Arcade's HTTP API, a run's shape and events, the routes outside
  `/api` (the versioned page files, the sitemap, robots.txt, the API's own docs), and the
  `WIKIRACE_CANONICAL_HOST`, `WIKIRACE_SITE_ROOT` and `WIKIRACE_IN_DOCKER` settings.
- README: the live site, the command's flags, the port `env.example` actually sets (8008), the
  `*_BASE_URL`, `OLLAMA_API_KEY` and `WIKIRACE_ENV_FILE` settings, and links to every document.
- `env.example` documents every provider's base URL and drops `CLAUDE_CODE_OAUTH_TOKEN`, which
  nothing reads.

## [0.1.0] - 2026-09-23

The first version, as `pyproject.toml` numbers it; not yet tagged in git.

### Added
- **WikiRace**: up to four models race from one Wikipedia article to another using only the links
  on the page they are on, watched live over server-sent events, with every foul (`off_page`,
  `teleport`, `no_pick`) caught against Wikipedia's own link list. Whoever reaches the target first
  wins; fewer hops only settles a dead heat. History in SQLite, with replays.
- **Five providers**: Anthropic (the official SDK), OpenAI and OpenRouter (Chat Completions), a
  local Ollama (its native API, the context window set per request and the page fitted to it), and
  TypeSafe's Jev, which scores every link with one typed `choice` question and so cannot foul.
  Thinking levels `none` to `max` are mapped to each provider's own parameter and folded to what a
  model accepts, and the move shows what was sent.
- **The Arcade**: fourteen games beside the race, each showing one thing a judgment model does
  well (Legal Moves Only, Switchboard, Customs, WikiGuessr, Rail Yard, Two Truths and a Lie,
  Judges' Panel, Ghost Maze, Needle Hunt, Slot Machine, Drive-Thru, Memory Match, The Big Sort,
  Blind Tasting), on shared machinery: typed questions and answers, players, a streamed run, its
  history, and `/api/games`. `docs/arcade.md` is the contract; Switchboard is the reference game.
- **The floor**: the bare address opens on an arcade floor with an attract-mode screen, an LED
  ticker of the latest plays, a cabinet per game, arrow-key navigation, synthesised arcade sounds
  (on by default, muted from the header), and a finale when a game ends in front of you.
- **One `.env` for both ways of running**: `uv run wikirace` reads it, `docker compose up` hands
  it to the container. Keys, model rosters (`model@level`) and thinking levels per provider.
- **Safe by default**: localhost only, a Host allowlist against DNS rebinding, keys never sent to
  the page or kept in records, URLs shown without credentials, and a clean stop that ends the
  event streams first.
- **Your own domain**: `WIKIRACE_CANONICAL_HOST` answers to a public name and its `www.` twin and
  redirects the twin and plain http to it; `WIKIRACE_SITE_ROOT` serves a deployment's own files.
- **Findable**: each view gets its own title, description, canonical link, sharing cards and
  JSON-LD from the server; `/sitemap.xml` and `/robots.txt`; the page's files load from
  `/v/<fingerprint>/`, so no cache serves an old copy after a rebuild.
- **Tests**: pytest without a network (a fake Wikipedia, mocked providers, every game over fake
  players), `node --test` for the page's pure state and the syntax of every page module, a mock API
  server and a demo server for working on the page without keys, and CI on Python 3.11 to 3.13
  with a Docker smoke test.
