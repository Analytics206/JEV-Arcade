# Contributing

JEV-Arcade is a small project with a definite shape, and the easiest way to help is to keep to it.
This page says how to set up, what the checks are, and what a change is expected to look like.
[docs/design.md](docs/design.md) explains how the pieces fit; [docs/arcade.md](docs/arcade.md) is
the contract for a game.

## Setting up

Python 3.11 or later and [uv](https://docs.astral.sh/uv/); Node 22 or later for the page's tests.

```bash
git clone https://github.com/Analytics206/JEV-Arcade.git
cd JEV-Arcade
uv sync                       # the project and its dev tools, into .venv
cp env.example .env           # then add a key, or point OLLAMA_BASE_URL at your Ollama
uv run wikirace               # http://localhost:8008
```

Without any keys, two stand-ins serve the page:

```bash
uv run python tests/games/demo_server.py   # the real app over fake players: http://127.0.0.1:8002
node tests/js/mock_server.mjs              # the page over a mocked WikiRace API: http://127.0.0.1:8001
```

## The checks

Every push and pull request runs these in CI (`.github/workflows/ci.yml`), on Python 3.11 to 3.14.
Run them before you open a pull request:

```bash
uv run ruff check .        # lint; `uv run ruff check --fix .` applies what it can fix itself
uv run pytest              # no network: a fake Wikipedia, mocked providers, every game over fake players
node --test tests/js       # the page's pure state, and that every page module parses
```

`uv run pytest tests/games/test_game_switchboard.py -k foul` runs one file, or one test. CI also
builds the Docker image and checks that it serves the page as a non-root user.

## What a change looks like

- **Tests come with it.** A server change has a pytest test; a change to the page's pure logic
  (`state.js`, `runstate.js`, `<game>.logic.js`) has a `node --test` test. Anything that talks to
  a provider or to Wikipedia is tested against the fakes, never the real thing.
- **Nothing is fetched at run time** but Wikipedia and the providers a key names. The page vendors
  its two libraries (`src/wikirace/static/vendor/README.md` says how to update them) and has no
  build step.
- **Keys stay on the server.** Nothing that reaches the page, a log, an error or a race record may
  carry a key or a URL's password (`config.display_url`).
- **A bad setting is a warning, not a crash** (`config.py`): the models endpoint shows it in the
  setup.
- **Docs move with the code.** A new setting goes in `env.example`, the README's table and
  `docs/design.md`; a new route in `docs/design.md`; a new game in the README's table and, through
  `registry.js`, on the floor. `CHANGELOG.md` gets a line under Unreleased.
- **Data a game ships** is written for this project or public domain, never copied from a
  dataset or site with its own license; a data file's `about` says where it came from.

## Style

- Python: ruff (`pyproject.toml`: 110 columns, the `E F I UP B` rules), type hints, and
  `from __future__ import annotations`. Every module starts with a docstring that says what it is
  for and, where it matters, why it is the way it is.
- JavaScript: ES modules, Preact with `htm`, no build step and no dependencies beyond the vendored
  two. Keep an inline run of markup on one line: a line break beside an inline element drops the
  space.
- CSS: the tokens in `styles.css`; a game's rules in its own file, every class under the game's
  short prefix.
- Prose (docs, comments, the page's words): plain sentences that say what a thing is and why, in
  the voice of the existing docs.
- Commit messages: a summary line, then a paragraph or a list saying what changed and why, as the
  history does (`git log`).

## Adding a game

[docs/arcade.md](docs/arcade.md), start to finish: a module under `src/wikirace/games/` with its
`GAME`, a page under `src/wikirace/static/games/`, a cabinet in `registry.js` and a scene in
`attract.js`, a pytest file over the `arcade` fixture, a `node --test` file for the pure logic, and
a demo handler under `tests/games/demo/`. Switchboard is the reference game.

## Reporting a bug

Open an issue with what you did, what happened and what you expected, and the server's own
summary (the lines `wikirace` prints as it starts) with any keys blanked. A race or run id, and the
provider and model, help. For a security problem, see [SECURITY.md](SECURITY.md) instead.
