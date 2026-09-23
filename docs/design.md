# JEV-Arcade: design

JEV-Arcade is WikiRace and the Arcade beside it: fifteen games on one arcade floor, where
language models play each other live. This document is mostly about WikiRace, the first game; the
Arcade's games are in [arcade.md](arcade.md). The Python package and command are still `wikirace`,
and the settings keep their `WIKIRACE_` names.

Up to four language models race from one Wikipedia article to another using only the links on
the page they are on. The race is watched live: hops, time, tokens and cost for every racer, with
every attempt to cheat caught, rejected and logged. Five providers can race: Anthropic, OpenAI,
OpenRouter, a local Ollama, and TypeSafe (Jev, a judgment model that scores links rather than
writing text).

The stack is deliberately small: a Python server (FastAPI, httpx, the Anthropic SDK), SQLite for
race history, and a browser page with no build step (Preact and htm, vendored). It runs from a
Python environment or from Docker, both configured by the same `.env` file.

## Layout

```
src/wikirace/
  __init__.py      version
  __main__.py      `wikirace` / `python -m wikirace`: settings, then uvicorn
  config.py        every setting: .env + environment, the five providers, thinking levels
  app.py           FastAPI factory: lifespan (DB, providers), /api router, static page
  api.py           /api/*: models, resolve, random, races, the race's event stream
  store.py         race history in SQLite: one row per race, stored whole as JSON
  providers/
    base.py        TextProvider, Completion, ProviderError, LoopClient, retry_after
    anthropic.py   Messages API through the official SDK
    openai.py      Chat Completions for OpenAI and OpenRouter (one module, two configs)
    ollama.py      Ollama's native /api/chat and /api/tags
    typesafe.py    TypeSafe's /systemone: typed questions in, Jev's answers out
    __init__.py    build(settings) -> {provider id: provider}
  race/
    wiki.py        the board: en.wikipedia.org, links in reading order, page cache
    subjects.py    the Classic pool
    rules.py       pure: the prompt, reading a reply, judging a pick, ranking, prices, Jev's question
    racers.py      TextRacer (any text provider) and JevRacer (TypeSafe)
    engine.py      a race as a background task; every change is an event
  games/           the Arcade (docs/arcade.md): games beside the race, each showing one use of Jev
    base.py        what a game is: Game, Context, the errors a round's setup raises
    core.py        pure: Jev's questions (choice, score, noul) and answers, reading a text reply, cost
    players.py     a racer key as a player; one call to Jev or a text model, with retries
    runs.py        a game run as a background task; every change is an event
    store.py       run history in SQLite, beside the races
    api.py         /api/games/*: the games, starting a run, its event stream
    registry.py    the games, in the hub's order; <game>.py and data/<game>.json for each
  static/          the page: index.html, main.js (the Arcade's floor, a game, or WikiRace),
                   app.js (WikiRace), brand.js (pixel font, header), fx.js (effects), sfx.js
                   (sounds), profile.js (plays in this browser), games/ (the Arcade: shell,
                   kit, the attract-mode screens, one module per game), styles.css, vendor/
tests/             pytest; tests/games/ for the Arcade; tests/js/ holds `node --test` tests for the
                   page's pure state
```

The Arcade shares the providers, the settings and the history file, and nothing else: a race and
a game run are separate kinds of background task with the same shape (plain JSON state, changed
only through mutators that each emit an event, one pure reducer on the page). See
[arcade.md](arcade.md).

## How a race works

A race is a background task owned by the server process. It keeps running when the page that
started it closes, and a page opened later attaches to it. The race state is plain JSON: the
snapshot a page attaches with is the stored replay is what the page renders. It changes only
through three mutators, each of which emits the matching event:

```
{"type": "snapshot", "race": {...}}          first, on every connection
{"type": "lane", "lane": i, "patch": {...}}  fields of lane i changed
{"type": "step", "lane": i, "step": {...}}   lane i took a turn (a move or a foul)
{"type": "race", "patch": {...}}             race-level fields changed
{"type": "end"}                              the race is over; the stream closes
```

The page applies them with one pure reducer (`static/state.js`, `applyEvent`), so the server and
the page cannot disagree about what a change means. Every stream starts with a snapshot and ends
with an `end` frame the stream writes itself; a silent stream gets a `: ping` comment every 15 s.

**A text racer's turn** is one stateless call: the rules (system prompt), the target, the current
article, the path so far, fouls on this article, and every link on it (or the first N in reading
order under a link cap). It replies `REASON:` / `LINK:`.

**Fouls**, checked against the links the racer was shown, never against the model's idea of them:

- `off_page`: the title is not a link on this article. The engine looks it up afterwards, so the
  log says whether it named a real article or invented one.
- `teleport`: the title is the target, and no link on this page leads to it. A title that merely
  redirects to the target is a teleport too. Naming the target when the page links it under
  another name (one of its redirects) is the winning move through that link, not a foul.
- `no_pick`: the reply named no link.

Spelling slips are forgiven (case, dashes, quotes, trailing punctuation, emphasis, `[[…]]`, URLs);
substance is not. A foul costs a strike and the racer stays put, told why; `strikes` fouls (default
3) disqualify. Revisits are legal and counted. The finish is an exact canonical-title match after
the first letter ("Red Dwarf" is not "Red dwarf").

**Ranking**: whoever reached the target first, in the order they crossed the line; fewer hops only
settles a dead heat. A race saved under the older rule (fewest hops first) is ranked by this one
when it is read. Unfinished racers are unranked. At most `WIKIRACE_MAX_RACES` (2) races run at once.

**Rate limits are waited out** in plain sight: an HTTP 429 puts the lane in `rate_limited` with a
note saying when it tries next, after 5, 15, 30 and 60 s (jittered) or the provider's Retry-After
when longer, and the wait is not thinking time. An outage (5xx, timeout, empty reply) gets one quick
retry. Anything else stops that racer only, in the provider's own words.

**Persistence**: one row per race, `summary` (no steps) for the list and `snapshot` (whole) for
replay, written by one writer per race off the event loop. A race left `running` by a restart is
stamped `interrupted` at startup.

**Stopping the server** (Ctrl+C, `docker stop`) ends every event stream first, since a stream
stays open for as long as its race runs and the server would otherwise wait on it; a page watching
reconnects when the server is back. Running races are then stopped and recorded as `stopped`.

## Jev, the judgment racer

TypeSafe's Jev writes no text, so it cannot be asked for a title. Each turn it answers one
`choice` question over the page's own links (opaque, shuffled ids) and takes the top one. It
cannot foul: its moves are always links on the page. What the race measures is whether its
judgment finds a path.

- One question holds 255 options, the API's ceiling, and TypeSafe's advice is to give a choice the
  whole list. A bigger page is split into pieces of at most 255, asked together (eight questions to
  a request, requests in parallel), and as many of each piece's best as one question holds go on to
  a final question over them all: at most two rounds.
- The state is `current_article`, `target_article` and `target_description`, nothing more. State
  unrelated to the question costs a judgment model accuracy.
- The question names the target itself as the answer when it is offered, then asks for the link
  that reaches it in the fewest clicks, narrowing from broad to specific. Jev reads instructions
  literally: asked only for the title "most closely related to the target", it passed over the
  target while the page linked it.
- It never doubles back: visited articles, links it already followed and dead links are left out
  of its options, because a ranker with no memory would otherwise shuttle between two pages. On a
  page where every link leads back, it is out of the race (`dnf`, "no way forward"), not fouled.
- Its step carries the evidence: the top five options with their probabilities, the confidence,
  how many options, rounds and requests it took. The page shows them as bars.
- Cost is TypeSafe's input rate, $0.042 per million tokens; output is free.

## Providers

`providers.build(settings)` returns one provider per configured provider id. Text providers
implement `TextProvider.complete(model, system, prompt, *, thinking, max_tokens, timeout)`;
TypeSafe implements `ask(model, state, questions, *, timeout)`. Each holds one keep-alive HTTP
client per event loop (`LoopClient`); the engine owns retries, so no provider retries on its own.

**Thinking levels** are `none | low | medium | high | xhigh | max`, or unset (send nothing). Each
provider maps a level to what its API takes, and folds a level a model refuses to the nearest one
it accepts, remembering the answer per model so only the first turn pays for the probe. The move
records what was actually sent (`thinking_sent`).

| Provider | Thinking is sent as | Cost |
|---|---|---|
| Anthropic | `output_config.effort` on models that take it: the 5 family, plus `thinking: {type: "adaptive"}` on Opus 4.6–4.8 and Sonnet 4.6, where thinking is otherwise off; `thinking.budget_tokens` on the older ones (Haiku 4.5, Sonnet 4.5), with effort too on Opus 4.5; `none` is `thinking: {type: "disabled"}` where accepted, else the lowest effort (Fable) | list price, marked ≈ |
| OpenAI | `reasoning_effort` on reasoning models (o-series, gpt-5 and later, gpt-oss), each family's own values; nothing on the others | list price, marked ≈ |
| OpenRouter | `reasoning: {effort}` | billed, from `usage.cost` |
| Ollama | `think` (a level for models that take one, else true/false) | free (local) |
| TypeSafe | nothing: Jev does not think in text | $0.042/Mtok input |

**Ollama's context window** is set per request (`options.num_ctx`, from `OLLAMA_NUM_CTX`, or the
model's own longest context when that is shorter), because Ollama's default is small enough to cut
a big article's link list, and the rules with it, without saying so. When a page still does not
fit, the racer is shown the first links that do, in reading order, and the move says how many; the
reply is capped (`num_predict`) at what the prompt leaves of the window, so it cannot push the
rules out either.

## Configuration

One `.env` file (copy `env.example`), read by `wikirace` and passed to the container by
`compose.yaml`. A variable in the real environment wins over the file.

| Variable | Default | Purpose |
|---|---|---|
| `WIKIRACE_HOST` | `127.0.0.1` | Bind address (the Docker image sets `0.0.0.0`) |
| `WIKIRACE_PORT` | `8000` | Port (in Docker: the host port published) |
| `WIKIRACE_DB` | `data/wikirace.db` | SQLite race history (Docker: `/data/wikirace.db` on a volume) |
| `WIKIRACE_THINKING` | unset | Thinking level for every racer, unless something nearer says |
| `WIKIRACE_MAX_RACES` | `2` | Races that may run at once |
| `WIKIRACE_ALLOWED_HOSTS` | `localhost`, `127.0.0.1` | Host names the server answers to (a DNS-rebinding guard), or `*` |
| `WIKIRACE_USER_AGENT` | `wikirace/<version> (repo URL)` | What Wikipedia is told; put your own contact here |
| `WIKIRACE_ENV_FILE` | `./.env` | Which env file `wikirace` reads |
| `ANTHROPIC_API_KEY` · `_MODELS` · `_THINKING` · `_BASE_URL` | models: `claude-haiku-4-5, claude-sonnet-5, claude-opus-5` | Anthropic |
| `OPENAI_API_KEY` · `_MODELS` · `_THINKING` · `_BASE_URL` | models: `gpt-4.1-mini, o4-mini` | OpenAI (any Chat Completions server works via the URL) |
| `OPENROUTER_API_KEY` · `_MODELS` · `_THINKING` · `_BASE_URL` | models: `deepseek/deepseek-v4-flash, minimax/minimax-m3` | OpenRouter |
| `OLLAMA_BASE_URL` · `_MODELS` · `_THINKING` · `OLLAMA_NUM_CTX` · `OLLAMA_API_KEY` | `http://localhost:11434`, every model it has, `16384` | Your own Ollama (not bundled; an empty URL switches it off); the key only for an Ollama behind auth |
| `TYPESAFE_API_KEY` · `_MODELS` · `_BASE_URL` | models: `jev-1.13.0` | TypeSafe |

`*_MODELS` is a comma-separated list; `model@level` pins that model's thinking level. A racer's
level is, first to last: the race setup's choice, the model's `@level`, `<PROVIDER>_THINKING`,
`WIKIRACE_THINKING`. In Docker, an Ollama URL naming `localhost` is rewritten to
`host.docker.internal`, so the same `.env` works both ways.

## HTTP API

Everything is under `/api`; errors are `{"detail": "..."}` with a 4xx or 5xx status. No
authentication: the server binds to localhost by default, in Docker it is published on
`127.0.0.1` only, and it answers only to the host names in `WIKIRACE_ALLOWED_HOSTS` (400
otherwise), so a page elsewhere cannot reach it through DNS rebinding. Keys never leave the
server: a refused key is reported without the provider's words, and URLs are shown without
credentials.

| Method | Path | |
|---|---|---|
| GET | `/api/health` | `{"ok": true, "version": "0.1.0"}` |
| GET | `/api/models` | who can race (below) |
| GET | `/api/resolve?q=` | a typed subject as the article a race would use: `{input, title, description, note, candidates: [{title, description}]}` |
| GET | `/api/random?pool=&count=&exclude=` | `pool` is `classic`, `trending` or `wild`; `count` 1 or 2; `exclude` repeatable: `{pool, subjects: [{title, description}]}` |
| GET | `/api/races?limit=` | history, newest first: `{races: [race without steps], running: [id]}` |
| POST | `/api/races` | start a race; 201 with its snapshot |
| GET | `/api/races/{id}` | one race, whole |
| GET | `/api/races/{id}/events` | SSE: snapshot, events, `end` |
| POST | `/api/races/{id}/stop` | 202 `{id, stopping: true}`; 409 when not running |
| DELETE | `/api/races/{id}` | `{deleted: id}`; 409 while running, 404 unknown |

### `GET /api/models`

```json
{
  "providers": [
    {"id": "anthropic", "label": "Anthropic", "kind": "text",
     "configured": true, "available": true, "reason": null,
     "thinking": "low", "custom_models": true, "url": null, "key_source": ".env"}
  ],
  "models": [
    {"key": "anthropic:claude-haiku-4-5", "provider": "anthropic", "model_id": "claude-haiku-4-5",
     "label": "claude-haiku-4-5", "kind": "text", "thinking": "low",
     "available": true, "reason": null,
     "price": {"input": 1.0, "output": 5.0}, "thinks": null, "context": null, "note": ""}
  ],
  "thinking_levels": ["none", "low", "medium", "high", "xhigh", "max"],
  "thinking": null,
  "warnings": []
}
```

- A provider is `configured` when its key (Ollama: its URL) is set, `available` when it can race
  now (Ollama: it answered), and `reason` says what to fix when it cannot.
- A model's key is `provider:model_id`, split at the first colon (`ollama:qwen3.5:9b` is Ollama's
  `qwen3.5:9b`). A lane may name any model id of an available text provider (`custom_models`),
  so an OpenRouter model not in the list can race; TypeSafe takes only its listed models.
- `thinking` on a model is its configured level (`@level`, provider, global), or null.
- `price` is USD per million tokens (input, output) when known; `{"input": 0, "output": 0}` for
  Ollama. `thinks` and `context` come from Ollama when it says.
- `warnings` lists configuration values that were ignored.

### `POST /api/races`

```json
{"start": "Abraham Lincoln", "target": "Amazon rainforest",
 "lanes": [{"key": "anthropic:claude-haiku-4-5", "thinking": null},
           {"key": "typesafe:jev-1.13.0", "thinking": null}],
 "rules": {"max_hops": 12, "strikes": 3, "time_limit_s": 600, "max_links": 0}}
```

1 to 4 lanes. `thinking` is null (the configured level), or one of the levels. Rules: `max_hops`
1–40, `strikes` 1–10, `time_limit_s` 30–3600, `max_links` 0–10000 (0 shows every link).

### The race

```
{id, status: running|finished|stopped|interrupted, created_at, started_ms, finished_at,
 start: {title, description, input, links}, target: {title, description, input},
 rules: {max_hops, strikes, time_limit_s, max_links}, ranking: [lane index], winner: index|null,
 lanes: [lane]}

lane: {index, key, label, provider, model_id, kind: text|judgment,
       thinking (the level it runs on, null: none sent), thinking_request (what was asked, null: the configured one),
       status: waiting|thinking|rate_limited|moving|finished|dnf|dq|error|stopped, note, page,
       hops, strikes, revisits, fouls: {off_page, teleport, no_pick},
       tokens_in, tokens_out, cost (null: unknown), cost_estimated, think_ms,
       elapsed_ms, turn_started_ms (epoch ms while thinking), finish_order, rank, steps: [step]}

step: {turn, from, links, claimed, reason, verdict: ok|off_page|teleport|no_pick|dead_link,
       link, to, note, revisit, tokens_in, tokens_out, cost, latency_ms, at_ms, detail}
```

`detail` on a judgment step: `{confidence, options, rounds, asks, model, top: [{title, p}]}`. On a
text step, any of: `stop_reason` (when not a normal stop), `thinking_sent`, `links_shown` (the
links that fit Ollama's window, when fewer than the page's).

## The page

No build step. `static/index.html` loads `main.js` as an ES module, and an import map points
`preact`, `preact/hooks` and `htm` at `static/vendor/`. The address picks the view
(`games/route.js`): the bare address is the Arcade's floor, `?tab=race`, `?race=<id>` and
`?tab=history` are WikiRace, `?game=<id>` is one of the Arcade's games. Components are written with
`htm`'s tagged templates. The pure half (`state.js`: the reducer, formatters, the race-trace
geometry, the setup checks) has no DOM and is tested with `node --test tests/js`.

The look is a neon arcade at night, dark only. Fonts are the system's own; the pixel lettering
(the wordmark, marquees, the LED ticker, clocks) is a 5×7 font drawn as SVG by `brand.js`, and the
attract-mode screens are SVG with SMIL, paused while out of sight. Sounds are synthesised with Web
Audio, on unless the visitor mutes them (from the first click, as browsers require). Nothing is fetched from a CDN, and nothing but the
visitor's own sound setting and play counts is kept in the browser.

## Testing

`uv run pytest` runs everything without a network: Wikipedia is a fake board, providers get an
`httpx.MockTransport`, and races run end to end against both. `uv run ruff check .` lints.
`node --test tests/js` tests the page's pure state.

## Adding another game

WikiRace is the first game; the rest of the stack does not know it is the only one. The providers
(`providers/`) and the settings (`config.py`) know nothing about Wikipedia, and the race engine's
pattern (a background task, JSON state changed only through mutators that emit events, one pure
reducer on the page, one row per game in SQLite) fits any turn-based contest between models. A new
game is a package beside `race/` with its own router under `/api/<game>`, and a tab in the page's
header.
