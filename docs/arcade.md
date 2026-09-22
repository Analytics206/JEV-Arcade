# The Arcade

WikiRace's page has a third tab, **Arcade**: games beside the horse race, each
showing one thing TypeSafe's Jev does well. WikiRace itself is unchanged and
keeps the bare address; the Arcade lives at `?tab=arcade`, one game at
`?game=<id>`, one run of it at `?game=<id>&run=<run id>`.

Every game is two files and a test, run by shared machinery:

| | Server (`src/wikirace/games/`) | Page (`src/wikirace/static/games/`) |
|---|---|---|
| a game | `<id>.py` (+ `data/<id>.json`, + helpers `<id>_*.py`) | `<id>.js`, `<id>.css` (+ pure helpers `<id>.logic.js`) |
| shared | `base.py` (what a game is), `core.py` (questions, answers, parsing, cost), `players.py` (Jev and text models), `runs.py` (a streamed run), `store.py`, `api.py`, `registry.py` | `kit.js` (hooks and components), `runstate.js` (the pure reducer), `route.js`, `shell.js` (header, hub), `registry.js` (hub cards), `games.css` |

Tests: `tests/games/test_game_<id>.py` over the `arcade` fixture
(`tests/games/conftest.py`: a whole server over a fake Jev, fake text models
and a fake Wikipedia), and `tests/js/game-<id>.test.js` for a game's pure
page logic. `tests/games/demo_server.py` runs the real page over stand-in
players (each game's `tests/games/demo/<id>.py` says what they answer), for
working on a page without API keys:

```bash
uv run python tests/games/demo_server.py          # http://127.0.0.1:8002/?tab=arcade
```

**Switchboard is the reference game**: `games/switchboard.py`,
`static/games/switchboard.js`, `tests/games/test_game_switchboard.py`,
`tests/games/demo/switchboard.py`. Read them before writing a new one.

## The server half

A game module ends with one `GAME`:

```python
class Params(BaseModel):            # what the setup may choose; a bad value is a 422
    rounds: int = Field(default=10, ge=1, le=30)

async def prepare(ctx: Context) -> dict:   # optional; runs inside the POST that starts the game
    ...                                     # fetch the round; raise GameInputError (400) / GameSourceError (502)
    ctx.private["answer"] = ...             # what the page must not see yet; never streamed
    return {"items": [], "total": n}        # the run's own top-level fields, streamed

async def play(run: GameRun, ctx: Context) -> None:
    async def lane(p: Player) -> None: ...  # one player's whole game
    await run.each_lane(lane)               # every lane at once; one that raises ends alone, as `error`
    run.patch(answer=ctx.private["answer"]) # reveal at the end

GAME = Game(id="mygame", title="…", tagline="…", use_case="…", params=Params,
            prepare=prepare, play=play, lanes=(1, 4), kinds=frozenset({"judgment", "text"}), needs_jev=False)
```

`ctx` has `settings`, `providers`, `wiki` (the Wikipedia client: `page`,
`lookup`, `describe`, `search`, `random_subjects`, and `query(params)` for
any other Action API read — extracts, coordinates, random pages), `players`,
`params` (the validated `Params`), `private`, and `ctx.jev` / `ctx.text`.
Import `Context`, `Game`, `GameInputError`, `GameSourceError` from `.base`,
never from `.registry` (it imports the games).

**A run** is plain JSON streamed to the page. Change it only through its
mutators, each one an event:

| call | does |
|---|---|
| `run.patch(**f)` | top-level fields |
| `run.lane(i, **f)` | lane *i*'s fields |
| `run.push(key, item)` / `run.put(key, n, item)` | append to / replace item *n* of the list at `key` |
| `run.lane_push(i, key, item)` | append to lane *i*'s list at `key` |
| `run.account(i, call, **f)` | add a call's tokens, cost, time, count to lane *i* (plus any fields), in one event |
| `run.foul(i, **f)` | one more foul on lane *i* |
| `run.waiting(i)` | an `on_wait` callback that shows rate-limit waits on lane *i* |

Every lane has `index key label provider model_id kind thinking status note
tokens_in tokens_out cost cost_estimated cost_unknown think_ms calls fouls
score`; a lane's status is one of `waiting playing rate_limited done error
stopped` (a game adds its own fields for anything else). `score` is the
lane's headline number, whatever the game counts. Keep events proportionate:
a few per decision, not hundreds.

**Asking players** (`players.py`): `await ask_jev(p, state, questions)` →
`Asked(answers, tokens_in, cost, latency_ms, …)`, split across parallel
requests past 24 questions; `await ask_text(p, system, prompt)` →
`Said(text, tokens_in, tokens_out, cost, …)`, inline thinking removed. Both
wait out rate limits and retry an outage once, then raise `PlayError` (which
ends the lane in the provider's words). Pass `on_wait=run.waiting(i)`.
`await together(calls)` runs many at once and, when one fails, calls off the
rest rather than leave them billing.

**Questions and answers** (`core.py`): `choice(instructions, {id: meaning})`
(2 to 255 options), `score(instructions, [level 0, level 1, …])` (2 to 10),
`noul(instructions, yes=…, no=…)`; `opaque(options, seed)` gives options
shuffled, meaningless ids (always use it: a position or an id must not carry
the answer); `read_choice(answer, ids)` → `Picked(option, p, confidence,
ranked, top(n))`; `read_score(answer, levels)` → `Scored(score, confidence,
probabilities, level, spread, fraction)`; `read_noul(answer)` → p(yes).
Instructions follow `race/rules.py`'s lesson: Jev reads the words literally,
so name the state's fields (`` `caller_said` ``) and write the winning
condition out exactly.

**Text models** answer in fields, one per line (`LINE: …`, `ANSWER: …`,
`REASON: …`). `read_field(text, "LINE")` reads the last one;
`match_option(claimed, options)` forgives case, quotes, dashes, underscores
and a trailing full stop, never substance. What does not match is a **foul**,
counted on the lane and shown on the page, as in WikiRace.

**What Jev is not good at** (TypeSafe's jev-1.13 notes), which every game's
questions respect: counting, arithmetic, dates, raw coordinates or other
numeric encodings, multi-hop reasoning, double negatives, text meant to trick
it, and irrelevant state (it distracts). Describe state in words and only
what the question needs; let code do the maths.

**Data** a game ships is written for WikiRace (or public domain), never
copied from a dataset or site with its own license; a file's `about` says
where it came from. Nothing is downloaded at run time except from Wikipedia
(politely: few, batched requests).

## The page half

`static/games/<id>.js` default-exports a component mounted with
`{ game, runId }`: `game` is the server's listing (title, tagline, use_case,
lanes {min, max}, kinds, needs_jev, params schema); `runId` the run in the
address, or null for the setup. With no run it shows a setup and starts one
(`useStarter(game.id).start(lanes, params)`, which opens it); with a run it
follows it (`useRun(runId)`) and draws it.

From `kit.js`: `GameFrame` (every page's top), `Box` (a panel; `lane=` puts a
lane's colour on it), `Label`, `Chip`, `Stat`, `LaneNum`, `LaneHead`,
`LaneStats`, `LaneCard`, `Bars` (probability bars), `Meter` (a value against
threshold marks), `Levels` (a score's distribution), `PlayerPicker`,
`StartButton`, `RunBar` (status, clock, stop, play again), `RecentRuns`,
`RunLoading`, `useModels`, `useNow`, `againOf`, and formatters. From
`runstate.js`: `defaultPlayers`, `playersProblem`, `isRunLive`, `fmtPct`,
`fmtProb`, `fmtMs`, `laneCostText`. The page is Preact with htm (no build
step); the markup is `html\`…\``.

Two htm pitfalls: a line break beside an inline element drops the space
(`the⏎<b>x</b>` renders "thex": keep inline runs on one line), and nothing
checks the templates but a reader. `tests/js/syntax.test.js` parses every
module (as `.mjs`: `node --check` on a `.js` module passes syntax errors
under Node 24).

Style: WikiRace's own (styles.css tokens: `--cy`, `--ok`, `--warn`, `--err`,
`--lane-1…4`, `--mono`, `--panel`, `--edge`, `--rule`); a game's rules live in
`<id>.css`, every class prefixed with the game's own short prefix. Lane
identity is the `--lane-N` colour and the lane number, never colour alone;
state wears the semantic colours with a glyph. No emoji in a game's page.
Real `<button>`, `<label>`, `<select>`; SVG drawings get a `role="img"` and
an `aria-label` saying what they show.
