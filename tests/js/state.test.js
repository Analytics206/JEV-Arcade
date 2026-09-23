// The page's pure half (src/wikirace/static/state.js). Run: node --test tests/js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_RULES,
  HORSE_HALF,
  STATUS_LABEL,
  ago,
  applyEvent,
  cheatCount,
  clampRule,
  costTitle,
  customKey,
  defaultLanes,
  detailOf,
  fmtCost,
  fmtDuration,
  fmtInt,
  fmtLaneCost,
  fmtTokens,
  foulsOf,
  groupModels,
  hopTicks,
  hopsAt,
  isCustomLane,
  isLive,
  judgmentSummary,
  laneElapsed,
  laneModel,
  laneSub,
  loadSaved,
  modelHint,
  optionLabel,
  ordinal,
  packHorses,
  paramsSearch,
  parseParams,
  pathOf,
  providerState,
  raceBody,
  raceElapsed,
  raceFinale,
  reconcileLanes,
  rematchLanes,
  sanitizeRules,
  saveSaved,
  setupProblem,
  splitKey,
  statusTone,
  stepNotes,
  thinkingOptions,
  timeAt,
  timeTicks,
  tipLeft,
  topOptions,
  traceLayout,
  traceOf,
  turnElapsed,
  wikiUrl,
  withValue,
} from '../../src/wikirace/static/state.js'

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

function lane(i, over = {}) {
  return {
    index: i, key: `anthropic:m${i}`, label: `model-${i}`, provider: 'anthropic', model_id: `m${i}`,
    kind: 'text', thinking: null, thinking_request: null, status: 'waiting', note: null, page: 'Start', hops: 0,
    strikes: 0, revisits: 0, fouls: { off_page: 0, teleport: 0, no_pick: 0 }, tokens_in: 0, tokens_out: 0,
    cost: null, cost_estimated: false, think_ms: 0, elapsed_ms: null, turn_started_ms: null,
    finish_order: null, rank: null, steps: [], ...over,
  }
}

function race(over = {}) {
  return {
    id: 'r1', status: 'running', start: { title: 'Start', description: '' },
    target: { title: 'Goal', description: '' }, rules: DEFAULT_RULES, created_at: '2026-09-21T00:00:00+00:00',
    started_ms: 1_000_000, finished_at: null, ranking: [], winner: null, lanes: [lane(0), lane(1)], ...over,
  }
}

function step(over = {}) {
  return {
    turn: 1, from: 'Start', links: 10, claimed: 'A', reason: 'r', verdict: 'ok', link: 'A', to: 'A',
    note: null, revisit: false, tokens_in: 100, tokens_out: 10, cost: null, latency_ms: 500, at_ms: 1000,
    detail: null, ...over,
  }
}

function model(over = {}) {
  return {
    key: 'anthropic:claude-opus-5', provider: 'anthropic', model_id: 'claude-opus-5', label: 'claude-opus-5',
    kind: 'text', thinking: null, available: true, reason: null, price: null, thinks: null, context: null, note: '',
    ...over,
  }
}

function provider(over = {}) {
  return {
    id: 'anthropic', label: 'Anthropic', kind: 'text', configured: true, available: true, reason: null,
    thinking: null, custom_models: true, url: null, key_source: '.env', ...over,
  }
}

/** A Storage, for the saved setup; Node has no localStorage of its own. */
function memoryStore() {
  const data = new Map()
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) }
}

// Shuffled on purpose: the picker must put them in its own order.
const PROVIDERS = [
  provider({ id: 'typesafe', label: 'TypeSafe', kind: 'judgment', custom_models: false }),
  provider({ id: 'ollama', label: 'Ollama', url: 'http://localhost:11434', key_source: null }),
  provider({ id: 'openai', label: 'OpenAI', configured: false, available: false, reason: 'set OPENAI_API_KEY in .env', key_source: null }),
  provider({ id: 'openrouter', label: 'OpenRouter' }),
  provider({ id: 'anthropic', label: 'Anthropic', thinking: 'low' }),
]

const MODELS = [
  model({ key: 'anthropic:claude-opus-5', thinking: 'low' }),
  model({ key: 'anthropic:claude-sonnet-5', model_id: 'claude-sonnet-5', label: 'claude-sonnet-5', thinking: 'low' }),
  model({ key: 'openrouter:deepseek/x', provider: 'openrouter', model_id: 'deepseek/x', label: 'deepseek/x' }),
  model({ key: 'openai:o3', provider: 'openai', model_id: 'o3', label: 'o3', available: false, reason: 'set OPENAI_API_KEY in .env' }),
  model({ key: 'typesafe:jev-1.13.0', provider: 'typesafe', kind: 'judgment', model_id: 'jev-1.13.0', label: 'jev-1.13.0' }),
]

const INFO = { providers: PROVIDERS, models: MODELS, thinking_levels: LEVELS, thinking: null, warnings: [] }

describe('applyEvent — the one place a streamed change becomes state', () => {
  it('takes a snapshot whole', () => {
    const r = race()
    assert.equal(applyEvent(null, { type: 'snapshot', race: r }), r)
  })

  it('patches one lane and leaves the rest alone', () => {
    const r = race()
    const next = applyEvent(r, { type: 'lane', lane: 1, patch: { status: 'thinking', hops: 2 } })
    assert.equal(next.lanes[1].status, 'thinking')
    assert.equal(next.lanes[1].hops, 2)
    assert.equal(next.lanes[0], r.lanes[0])
    assert.equal(r.lanes[1].status, 'waiting') // never mutates
  })

  it('appends a step to its lane', () => {
    const next = applyEvent(race(), { type: 'step', lane: 0, step: step() })
    assert.equal(next.lanes[0].steps.length, 1)
    assert.equal(next.lanes[1].steps.length, 0)
  })

  it('patches the race and ignores events before any snapshot', () => {
    const next = applyEvent(race(), { type: 'race', patch: { status: 'finished', winner: 1 } })
    assert.equal(next.status, 'finished')
    assert.equal(next.winner, 1)
    assert.equal(applyEvent(null, { type: 'lane', lane: 0, patch: { hops: 1 } }), null)
  })

  it('ignores a lane it does not have, and a frame it does not know', () => {
    const r = race()
    assert.equal(applyEvent(r, { type: 'lane', lane: 7, patch: { hops: 1 } }), r)
    assert.equal(applyEvent(r, { type: 'ping' }), r)
    assert.equal(applyEvent(r, null), r)
  })

  it('snapshot plus the steps after it is the whole lane', () => {
    let r = race({ lanes: [lane(0, { steps: [step({ turn: 1 })] })] })
    r = applyEvent(r, { type: 'step', lane: 0, step: step({ turn: 2, to: 'B', from: 'A', at_ms: 2000 }) })
    assert.deepEqual(pathOf(r.lanes[0], 'Start'), ['Start', 'A', 'B'])
  })
})

describe('reading a race', () => {
  it('lists every foul in the order it happened', () => {
    const r = race({
      lanes: [
        lane(0, { steps: [step({ verdict: 'teleport', to: null, at_ms: 3000, note: 'no shortcuts' })] }),
        lane(1, { steps: [step({ verdict: 'off_page', to: null, at_ms: 1500 }), step({ at_ms: 2000 })] }),
      ],
    })
    const fouls = foulsOf(r)
    assert.deepEqual(fouls.map((f) => [f.lane, f.kind]), [[1, 'off_page'], [0, 'teleport']])
    assert.equal(fouls[1].note, 'no shortcuts')
  })

  it('a path counts only moves, not fouls', () => {
    const ln = lane(0, { steps: [step({ verdict: 'off_page', to: null }), step({ to: 'B' })] })
    assert.deepEqual(pathOf(ln, 'Start'), ['Start', 'B'])
  })

  it('clocks freeze when a lane ends and run while it races', () => {
    const r = race()
    assert.equal(laneElapsed(lane(0, { elapsed_ms: 4200 }), r, 9_999_999), 4200)
    assert.equal(laneElapsed(lane(0), r, 1_005_000), 5000)
    assert.equal(turnElapsed(lane(0, { status: 'thinking', turn_started_ms: 1_000_000 }), 1_002_500), 2500)
    assert.equal(turnElapsed(lane(0, { status: 'moving', turn_started_ms: 1_000_000 }), 1_002_500), null)
  })

  it('tones say state, not identity', () => {
    assert.equal(statusTone('finished'), 'ok')
    assert.equal(statusTone('dq'), 'err')
    assert.equal(statusTone('thinking'), 'live')
    assert.equal(statusTone('dnf'), 'warn')
  })

  it('a rate-limited racer is still racing, but its wait is not thinking', () => {
    const waiting = lane(0, { status: 'rate_limited', turn_started_ms: null, note: 'anthropic rate limit — trying again in 15s (try 2 of 5)' })
    assert.equal(isLive(waiting), true)
    assert.equal(turnElapsed(waiting, 1_002_500), null)
    assert.equal(STATUS_LABEL.rate_limited, 'rate-limited')
    assert.equal(statusTone('rate_limited'), 'warn')
  })
})

describe('formatting', () => {
  it('durations', () => {
    assert.equal(fmtDuration(820), '0.8s')
    assert.equal(fmtDuration(42_000), '42s')
    assert.equal(fmtDuration(185_000), '3:05')
    assert.equal(fmtDuration(3_727_000), '1:02:07')
    assert.equal(fmtDuration(null), '—')
  })

  it('tokens', () => {
    assert.equal(fmtTokens(940), '940')
    assert.equal(fmtTokens(1_234), '1.2k')
    assert.equal(fmtTokens(52_534), '53k')
    assert.equal(fmtTokens(1_240_000), '1.24M')
  })

  it('cost marks an estimate', () => {
    assert.equal(fmtCost(0.0042), '$0.0042')
    assert.equal(fmtCost(0.0531, true), '≈$0.053')
    assert.equal(fmtCost(1.234), '$1.23')
    assert.equal(fmtCost(null), '—')
  })

  it('counts group the same way whatever the machine’s locale', () => {
    assert.equal(fmtInt(2139), '2,139')
    assert.equal(fmtInt(1_234_567), '1,234,567')
  })

  it('wiki links survive odd titles', () => {
    assert.equal(
      wikiUrl('World Trade Center (1973–2001)'),
      'https://en.wikipedia.org/wiki/World_Trade_Center_(1973%E2%80%932001)',
    )
  })
})

describe('the setup form', () => {
  const ok = { start: 'A', target: 'B', lanes: [{ key: 'anthropic:claude-opus-5', thinking: '' }], rules: DEFAULT_RULES }

  it('says what is missing', () => {
    assert.equal(setupProblem(ok, INFO), null)
    assert.match(setupProblem({ ...ok, start: ' ' }, INFO), /starting/)
    // MediaWiki's rule: the first letter is case-free, the rest is not.
    assert.match(setupProblem({ ...ok, target: 'a ', start: 'A' }, INFO), /same article/)
    assert.match(setupProblem({ ...ok, target: 'New_York', start: 'new  York' }, INFO), /same article/)
    assert.equal(setupProblem({ ...ok, target: 'Aids', start: 'AIDS' }, INFO), null)
    assert.match(setupProblem({ ...ok, lanes: [] }, INFO), /at least one/)
    assert.match(setupProblem({ ...ok, lanes: [{ key: '', thinking: '' }] }, INFO), /Racer 1 has no model/)
    // Before the models load, nothing can be checked, so nothing can start.
    assert.match(setupProblem(ok, null), /Racer 1 has no model/)
  })

  it('names why an unavailable model cannot race', () => {
    const s = { ...ok, lanes: [{ key: 'openai:o3', thinking: '' }] }
    assert.equal(setupProblem(s, INFO), 'o3 cannot race: set OPENAI_API_KEY in .env.')
  })

  it('a configured thinking level is sent as null', () => {
    const body = raceBody({
      ...ok,
      start: ' A ',
      lanes: [{ key: 'anthropic:claude-opus-5', thinking: '' }, { key: 'anthropic:claude-opus-5', thinking: 'low' }],
    })
    assert.equal(body.start, 'A')
    assert.deepEqual(body.lanes, [{ key: 'anthropic:claude-opus-5', thinking: null }, { key: 'anthropic:claude-opus-5', thinking: 'low' }])
    assert.deepEqual(body.rules, DEFAULT_RULES)
  })

  it('the default line-up spans providers and brings Jev', () => {
    assert.deepEqual(defaultLanes(MODELS).map((l) => l.key), ['anthropic:claude-opus-5', 'openrouter:deepseek/x', 'typesafe:jev-1.13.0'])
    assert.deepEqual(defaultLanes(MODELS)[0], { key: 'anthropic:claude-opus-5', thinking: '' })
  })

  it('groups the picker by provider — Anthropic, OpenAI, OpenRouter, Ollama, TypeSafe', () => {
    const shuffled = [MODELS[4], MODELS[2], MODELS[3], MODELS[0], MODELS[1]]
    const groups = groupModels(shuffled, PROVIDERS)
    assert.deepEqual(groups.map((g) => g.provider), ['anthropic', 'openai', 'openrouter', 'ollama', 'typesafe'])
    assert.deepEqual(groups.map((g) => g.label), ['Anthropic', 'OpenAI', 'OpenRouter', 'Ollama', 'TypeSafe'])
    // The unavailable model stays listed (the picker shows it disabled, with why).
    assert.deepEqual(groups[1].models.map((m) => m.key), ['openai:o3'])
    // A provider the page does not know goes last, under its own id.
    const odd = groupModels([...MODELS, model({ key: 'acme:x', provider: 'acme', model_id: 'x', label: 'x' })], PROVIDERS)
    assert.equal(odd.at(-1).label, 'acme')
  })

  it('remembers the line-up under wikirace.setup.v1, and survives a mangled store', () => {
    const store = memoryStore()
    const saved = { lanes: [{ key: 'openrouter:deepseek/x', thinking: 'low' }], rules: { ...DEFAULT_RULES, max_hops: 8 }, pool: 'wild' }
    saveSaved(saved, store)
    assert.ok(store.getItem('wikirace.setup.v1'))
    assert.deepEqual(loadSaved(store), saved)
    store.setItem('wikirace.setup.v1', '{not json')
    assert.equal(loadSaved(store), null)
    store.setItem('wikirace.setup.v1', JSON.stringify({ lanes: 'x' }))
    assert.equal(loadSaved(store), null)
    // Rules come back inside what the server takes; junk falls back to the default.
    store.setItem('wikirace.setup.v1', JSON.stringify({ lanes: [], rules: { max_hops: 99, strikes: 'x' }, pool: 'nope' }))
    assert.deepEqual(loadSaved(store), { lanes: [], rules: { ...DEFAULT_RULES, max_hops: 40 }, pool: 'classic' })
  })

  it('a storage that throws, or none at all, is a page that forgets — not one that breaks', () => {
    const blocked = {
      getItem() {
        throw new Error('SecurityError')
      },
      setItem() {
        throw new Error('QuotaExceededError')
      },
    }
    assert.equal(loadSaved(blocked), null)
    assert.doesNotThrow(() => saveSaved({ lanes: [], rules: DEFAULT_RULES, pool: 'classic' }, blocked))
    assert.equal(loadSaved(), null) // Node has no localStorage
    assert.doesNotThrow(() => saveSaved({ lanes: [], rules: DEFAULT_RULES, pool: 'classic' }))
  })

  it('rules stay inside what the server takes', () => {
    assert.equal(clampRule('max_hops', 99), 40)
    assert.equal(clampRule('max_hops', ''), 1)
    assert.equal(clampRule('strikes', '0'), 1)
    assert.equal(clampRule('time_limit_s', 5), 30)
    assert.equal(clampRule('max_links', 12.6), 13)
    assert.deepEqual(sanitizeRules({ max_hops: '8', strikes: 'x', time_limit_s: 99_999 }), { ...DEFAULT_RULES, max_hops: 8, time_limit_s: 3600 })
    assert.deepEqual(sanitizeRules(null), DEFAULT_RULES)
    // A rematch's own value joins the presets rather than showing as another one.
    assert.deepEqual(withValue([120, 300], 450), [120, 300, 450])
    assert.deepEqual(withValue([120, 300], 300), [120, 300])
  })
})

describe('custom model ids', () => {
  it('a key splits at its FIRST colon, as the server splits it', () => {
    assert.deepEqual(splitKey('ollama:qwen3.5:9b'), ['ollama', 'qwen3.5:9b'])
    assert.deepEqual(splitKey('openrouter:moonshotai/kimi-k2'), ['openrouter', 'moonshotai/kimi-k2'])
    assert.deepEqual(splitKey('openrouter:'), ['openrouter', ''])
    assert.deepEqual(splitKey(''), ['', ''])
    assert.equal(customKey('openrouter', '  qwen/qwen3-coder '), 'openrouter:qwen/qwen3-coder')
    assert.equal(customKey('ollama', 'qwen3.5:9b'), 'ollama:qwen3.5:9b')
  })

  it('a typed-in id races as a model made up from its provider', () => {
    const m = laneModel({ key: 'openrouter:qwen/qwen3-coder', thinking: '', custom: true }, INFO)
    assert.equal(m.custom, true)
    assert.equal(m.provider, 'openrouter')
    assert.equal(m.model_id, 'qwen/qwen3-coder')
    assert.equal(m.label, 'qwen/qwen3-coder')
    assert.equal(m.kind, 'text')
    assert.equal(m.available, true)
  })

  it('a listed id typed in races as the listed model', () => {
    assert.equal(laneModel({ key: 'openrouter:deepseek/x', thinking: '', custom: true }, INFO), MODELS[2])
  })

  it('TypeSafe takes only its listed models, and an unknown provider nothing', () => {
    assert.equal(laneModel({ key: 'typesafe:jev-9', thinking: '' }, INFO), null)
    assert.equal(laneModel({ key: 'acme:x', thinking: '' }, INFO), null)
  })

  it('the setup says what a custom racer is missing', () => {
    const base = { start: 'A', target: 'B', rules: DEFAULT_RULES }
    assert.equal(setupProblem({ ...base, lanes: [{ key: 'openrouter:', thinking: '', custom: true }] }, INFO), 'Racer 1: type the OpenRouter model id.')
    assert.equal(setupProblem({ ...base, lanes: [{ key: 'openai:gpt-5', thinking: '', custom: true }] }, INFO), 'gpt-5 cannot race: set OPENAI_API_KEY in .env.')
    assert.equal(setupProblem({ ...base, lanes: [{ key: 'ollama:qwen3.5:9b', thinking: '', custom: true }] }, INFO), null)
  })

  it('the picker offers "Custom model id…" only where one can race', () => {
    const groups = groupModels(MODELS, PROVIDERS)
    assert.deepEqual(
      groups.map((g) => [g.provider, g.custom]),
      [['anthropic', true], ['openai', false], ['openrouter', true], ['ollama', true], ['typesafe', false]],
    )
    // Ollama lists nothing here, and still gets its group for the typed-in id.
    assert.deepEqual(groups[3].models, [])
  })

  it('an id off the list, saved or rematched, shows as custom and survives the model check', () => {
    const typed = { key: 'openrouter:qwen/qwen3-coder', thinking: '' }
    assert.equal(isCustomLane(typed, INFO), true)
    assert.equal(isCustomLane({ key: 'openrouter:deepseek/x', thinking: '' }, INFO), false)
    assert.equal(isCustomLane({ key: 'openrouter:deepseek/x', thinking: '', custom: true }, INFO), true)
    const lanes = [
      typed,
      { key: 'openrouter:', thinking: '', custom: true }, // still being typed
      { key: 'typesafe:jev-0.1', thinking: '' }, // gone, and TypeSafe takes no others
      { key: 'acme:x', thinking: '' }, // a provider that is gone
      { key: '', thinking: '' }, // a racer not picked yet
    ]
    assert.deepEqual(reconcileLanes(lanes, INFO).map((l) => l.key), ['openrouter:qwen/qwen3-coder', 'openrouter:', ''])
    // Nothing left: a first line-up instead.
    assert.deepEqual(reconcileLanes([{ key: 'acme:x', thinking: '' }], INFO).map((l) => l.key), defaultLanes(MODELS).map((l) => l.key))
  })

  it('the body sends the typed id as the key, and nothing the server did not ask for', () => {
    const body = raceBody({ start: 'A', target: 'B', rules: DEFAULT_RULES, lanes: [{ key: 'ollama:qwen3.5:9b', thinking: 'low', custom: true }] })
    assert.deepEqual(body.lanes, [{ key: 'ollama:qwen3.5:9b', thinking: 'low' }])
  })
})

describe('thinking (was effort)', () => {
  it('the picker names the configured level, or says the model decides', () => {
    assert.deepEqual(thinkingOptions(LEVELS, 'low')[0], ['', 'thinking: low (configured)'])
    assert.deepEqual(thinkingOptions(LEVELS, null)[0], ['', 'thinking: model default'])
    assert.deepEqual(thinkingOptions(LEVELS, null).slice(1).map(([v]) => v), LEVELS)
    assert.deepEqual(thinkingOptions(LEVELS, null)[1], ['none', 'thinking: none'])
    assert.deepEqual(thinkingOptions(undefined, null), [['', 'thinking: model default']])
  })

  it('a typed-in model is configured as its provider is, then as the whole race is', () => {
    assert.equal(laneModel({ key: 'anthropic:claude-haiku-4-5-20251001', thinking: '' }, INFO).thinking, 'low')
    const global = { ...INFO, thinking: 'medium' }
    assert.equal(laneModel({ key: 'openrouter:qwen/qwen3-coder', thinking: '' }, global).thinking, 'medium')
    assert.equal(laneModel({ key: 'openrouter:qwen/qwen3-coder', thinking: '' }, INFO).thinking, null)
  })

  it('a lane body says thinking, never effort', () => {
    const body = raceBody({
      start: 'A', target: 'B', rules: DEFAULT_RULES,
      lanes: [{ key: 'anthropic:claude-opus-5', thinking: '' }, { key: 'openai:o3', thinking: 'high' }],
    })
    assert.deepEqual(body.lanes, [{ key: 'anthropic:claude-opus-5', thinking: null }, { key: 'openai:o3', thinking: 'high' }])
    assert.doesNotMatch(JSON.stringify(body), /effort/)
  })

  it('race again asks for what was asked, not what it resolved to', () => {
    const r = race({
      lanes: [
        lane(0, { thinking: 'low', thinking_request: null }), // the configured level: stays "configured"
        lane(1, { thinking: null, thinking_request: 'none' }), // a deliberate none
        lane(2, { thinking: 'high', thinking_request: 'high' }),
        lane(3, { thinking: 'low' }), // a race stored before the field existed
      ],
    })
    assert.deepEqual(rematchLanes(r).map((l) => l.thinking), ['', 'none', 'high', ''])
    assert.deepEqual(rematchLanes(r)[0], { key: 'anthropic:m0', thinking: '' })
  })

  it('a lane card says what it runs on', () => {
    assert.equal(laneSub(lane(0, { provider: 'anthropic', thinking: 'high' })), 'anthropic · thinking high')
    assert.equal(laneSub(lane(0, { provider: 'openai', thinking: null })), 'openai')
    assert.equal(laneSub(lane(0, { provider: 'typesafe', kind: 'judgment' })), 'typesafe · judgment')
  })

  it('an option line shows a configured level, and says why a model cannot race', () => {
    assert.equal(optionLabel(MODELS[0]), 'claude-opus-5 · thinking low')
    assert.equal(optionLabel(MODELS[4]), 'jev-1.13.0 — judgment')
    assert.equal(optionLabel(MODELS[3]), 'o3 — set OPENAI_API_KEY in .env')
    assert.equal(optionLabel(model({ label: 'Opus', model_id: 'claude-opus-5' })), 'Opus (claude-opus-5)')
  })

  it('the fixture speaks the new names', () => {
    for (const ln of fixture('race-jev.json').lanes) {
      assert.ok('thinking' in ln && 'thinking_request' in ln)
      assert.ok(!('effort' in ln) && !('effort_request' in ln))
      assert.equal(ln.key, `${ln.provider}:${ln.model_id}`)
    }
  })
})

describe("Jev's evidence, and a text step's notes", () => {
  const jev = fixture('race-jev.json').lanes.find((l) => l.kind === 'judgment')

  it('its top options are bars: title, probability, and the one it followed', () => {
    // Turn 2 followed "ISBN (identifier)", which redirects to "ISBN": the bar
    // marks the link's own title, the one Jev scored.
    const opts = topOptions(jev.steps[1])
    assert.equal(opts.length, 5)
    assert.deepEqual(opts[0], { title: 'ISBN (identifier)', p: 0.28, chosen: true })
    assert.deepEqual(opts.map((o) => o.chosen), [true, false, false, false, false])
    assert.deepEqual(opts.map((o) => o.p), [0.28, 0.19, 0.15, 0.1, 0.05])
  })

  it('a probability is a length: kept to 0–1, junk as 0', () => {
    const opts = topOptions(step({ link: 'A', detail: { top: [{ title: 'A', p: 1.4 }, { title: 'B', p: -0.1 }, { title: 'C', p: 'x' }] } }))
    assert.deepEqual(opts.map((o) => o.p), [1, 0, 0])
  })

  it('a text step has no bars', () => {
    assert.deepEqual(topOptions(step()), [])
    assert.deepEqual(topOptions(step({ detail: { stop_reason: 'max_tokens' } })), [])
  })

  it('says how sure it was and what the choice took', () => {
    assert.equal(judgmentSummary(jev.steps[0].detail), 'confidence 0.16 · 395 options · 2 rounds · 2 requests')
    assert.equal(judgmentSummary({ confidence: 0.97, options: 1, rounds: 1, asks: 1 }), 'confidence 0.97 · 1 option · 1 round · 1 request')
    assert.equal(judgmentSummary({ options: 1200, rounds: 2, asks: 5 }), '1,200 options · 2 rounds · 5 requests')
    assert.equal(judgmentSummary(null), '')
  })

  it('a text step says what thinking was sent, and how many links a small window held', () => {
    const s = step({ links: 2139, detail: { thinking_sent: 'reasoning_effort=minimal', links_shown: 1200 } })
    assert.deepEqual(stepNotes(s), ['sent reasoning_effort=minimal', 'saw the first 1,200 of 2,139 links'])
  })

  it('the stop reason comes first, and an object sent reads as key=value', () => {
    const s = step({ detail: { thinking_sent: { type: 'enabled', budget_tokens: 1024 }, stop_reason: 'max_tokens' } })
    assert.deepEqual(stepNotes(s), ['stopped: max_tokens', 'sent type=enabled budget_tokens=1024'])
  })

  it('says nothing when the whole page fit or nothing was sent', () => {
    assert.deepEqual(stepNotes(step({ links: 300, detail: { links_shown: 300, thinking_sent: null } })), [])
    assert.deepEqual(stepNotes(step()), [])
    assert.deepEqual(stepNotes(jev.steps[0]), [])
  })
})

describe('the providers', () => {
  it('a ready provider is a filled dot; Ollama says where it answers', () => {
    assert.deepEqual(providerState(PROVIDERS[1]), { tone: 'ok', title: 'Ollama: ready at http://localhost:11434' })
    assert.deepEqual(providerState(PROVIDERS[4]), { tone: 'ok', title: 'Anthropic: ready · key from .env' })
  })

  it('one that cannot race says why — down is an error, never set up is not', () => {
    assert.deepEqual(providerState(PROVIDERS[2]), { tone: 'off', title: 'OpenAI: set OPENAI_API_KEY in .env' })
    const down = provider({ id: 'ollama', label: 'Ollama', available: false, reason: 'no answer', url: 'http://localhost:11434' })
    assert.deepEqual(providerState(down), { tone: 'err', title: 'Ollama: no answer (http://localhost:11434)' })
  })

  it("a local model's cost is $0, and says so", () => {
    assert.equal(fmtLaneCost(lane(0, { provider: 'ollama', cost: 0 })), '$0 · local')
    assert.equal(fmtLaneCost(lane(0, { provider: 'ollama', cost: null })), '$0 · local')
    assert.match(costTitle(lane(0, { provider: 'ollama', cost: 0 })), /your own Ollama/)
    // Everyone else is unchanged: ≈ for a list-price estimate, — for unknown.
    assert.equal(fmtLaneCost(lane(0, { cost: 0.0531, cost_estimated: true })), '≈$0.053')
    assert.equal(fmtLaneCost(lane(0, { provider: 'openrouter', cost: 0.0042 })), '$0.0042')
    assert.equal(fmtLaneCost(lane(0, { provider: 'openrouter', cost: null })), '—')
    assert.match(costTitle(lane(0, { cost: 0.01, cost_estimated: true })), /list price/)
  })

  it('the picker hover text carries price and window', () => {
    assert.equal(
      modelHint(model({ price: { input: 1, output: 5 } })),
      'claude-opus-5 · $1 in / $5 out per million tokens',
    )
    assert.equal(
      modelHint(model({ label: 'qwen3.5:9b', model_id: 'qwen3.5:9b', price: { input: 0, output: 0 }, context: 262_144, thinks: true })),
      'qwen3.5:9b · free (local) · 262k context · thinks',
    )
  })
})

describe('where the page is', () => {
  it('reads ?race= and ?tab=history', () => {
    assert.deepEqual(parseParams('?race=0047525c4f18'), { tab: 'race', race: '0047525c4f18' })
    assert.deepEqual(parseParams('?tab=history'), { tab: 'history', race: null })
    assert.deepEqual(parseParams(''), { tab: 'race', race: null })
    assert.deepEqual(parseParams('?tab=nonsense&race='), { tab: 'race', race: null })
  })

  it('writes them back, and ?tab=race for the bare setup (the bare address is the Arcade)', () => {
    assert.equal(paramsSearch({ race: 'abc' }), '?race=abc')
    assert.equal(paramsSearch({ tab: 'history' }), '?tab=history')
    assert.equal(paramsSearch({}), '?tab=race')
    assert.equal(paramsSearch({ tab: 'race', race: null }), '?tab=race')
    for (const p of [{ tab: 'race', race: 'x1' }, { tab: 'history', race: null }, { tab: 'race', race: null }]) {
      assert.deepEqual(parseParams(paramsSearch(p)), p)
    }
  })
})

describe('the race trace', () => {
  const r = race({
    status: 'finished',
    lanes: [
      lane(0, {
        status: 'finished', elapsed_ms: 5000,
        steps: [step({ at_ms: 1000 }), step({ verdict: 'off_page', to: null, at_ms: 2000 }), step({ at_ms: 5000, to: 'Goal' })],
      }),
      lane(1, { status: 'dq', elapsed_ms: 3000, steps: [step({ verdict: 'no_pick', to: null, at_ms: 3000 })] }),
    ],
  })

  it('is a step line of hops over time with fouls on it', () => {
    const [a, b] = traceOf(r, 0)
    assert.deepEqual(a.points, [{ t: 0, hops: 0 }, { t: 1000, hops: 1 }, { t: 5000, hops: 2 }, { t: 5000, hops: 2 }])
    assert.deepEqual(a.fouls, [{ t: 2000, hops: 1, kind: 'foul', note: '' }])
    assert.deepEqual(a.end, { t: 5000, hops: 2, status: 'finished' })
    assert.equal(b.fouls[0].kind, 'no_pick')
    assert.equal(b.end?.status, 'dq')
  })

  it('a legal pick whose article never loaded is not a hop', () => {
    // Found in review: the chart ended a hop above the lane card.
    const r2 = race({
      status: 'finished',
      lanes: [lane(0, { status: 'error', elapsed_ms: 2000, steps: [step({ at_ms: 1000 }), step({ at_ms: 2000, to: null })] })],
    })
    const [t] = traceOf(r2, 0)
    assert.deepEqual(t.points.at(-1), { t: 2000, hops: 1 })
    assert.deepEqual(t.fouls, [])
  })

  it('a live lane runs on to now', () => {
    const live = race({ lanes: [lane(0, { status: 'thinking', steps: [step({ at_ms: 1000 })] })] })
    const [t] = traceOf(live, live.started_ms + 7000)
    assert.deepEqual(t.points.at(-1), { t: 7000, hops: 1 })
    assert.equal(t.end, null)
  })

  it('reads hops at any moment', () => {
    const [a] = traceOf(r, 0)
    assert.equal(hopsAt(a, 500), 0)
    assert.equal(hopsAt(a, 1000), 1)
    assert.equal(hopsAt(a, 4999), 1)
    assert.equal(hopsAt(a, 6000), 2)
  })

  it('ticks are round numbers', () => {
    assert.deepEqual(hopTicks(4), [0, 1, 2, 3, 4])
    assert.deepEqual(hopTicks(12), [0, 2, 4, 6, 8, 10, 12])
    assert.deepEqual(hopTicks(13), [0, 2, 4, 6, 8, 10, 12, 13])
    assert.deepEqual(timeTicks(25_000), [0, 5000, 10_000, 15_000, 20_000, 25_000])
    assert.deepEqual(timeTicks(3 * 60_000), [0, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000])
  })
})

describe('the horses', () => {
  const head = (lane, x, hops, since = 0) => ({ lane, x, hops, since })

  it('stand at the heads of their lines when there is room', () => {
    const at = packHorses([head(0, 300, 2), head(1, 500, 2), head(2, 300, 1)], 24, 50)
    assert.deepEqual([at.get(0), at.get(1), at.get(2)], [300, 500, 300])
  })

  it('bunch up on the same hop, the first to get there in front', () => {
    // Both still racing, so both lines run to "now": the same x.
    const at = packHorses([head(0, 500, 2, 9000), head(1, 500, 2, 4000), head(2, 490, 2, 1000)], 24, 50)
    assert.equal(at.get(1), 500)
    assert.equal(at.get(0), 476)
    assert.equal(at.get(2), 452) // behind by where its line ends, not by when it arrived
  })

  it('never stand behind the start line: a field at the gate is pushed on', () => {
    const at = packHorses([0, 1, 2].map((lane) => head(lane, 40, 0)), 24, 52)
    assert.deepEqual([at.get(0), at.get(1), at.get(2)], [100, 76, 52])
    // …and a horse far up the track is not pushed along with them.
    assert.equal(packHorses([head(0, 600, 0), head(1, 40, 0)], 24, 52).get(0), 600)
  })
})

describe('a finished race, replayed (the fixture)', () => {
  const r = fixture('race-jev.json')

  it('attaches as a snapshot and ends as it was', () => {
    let cur = applyEvent(null, { type: 'snapshot', race: r })
    cur = applyEvent(cur, { type: 'end' })
    assert.equal(cur, r)
  })

  it('every line of its trace ends where its lane card says', () => {
    for (const tr of traceOf(r, 0)) {
      const ln = r.lanes[tr.lane]
      assert.deepEqual(tr.points.at(-1), { t: ln.elapsed_ms, hops: ln.hops })
      assert.deepEqual(tr.end, { t: ln.elapsed_ms, hops: ln.hops, status: 'finished' })
      assert.equal(pathOf(ln, r.start.title).length, ln.hops + 1)
      assert.equal(pathOf(ln, r.start.title).at(-1), r.target.title)
    }
  })

  it('its cheat log holds both off-page picks, in the order they happened', () => {
    const fouls = foulsOf(r)
    assert.deepEqual(fouls.map((f) => [f.lane, f.kind, f.claimed]), [[1, 'off_page', 'Internet Archive'], [2, 'off_page', 'Wikimedia Foundation']])
    assert.equal(r.lanes.reduce((n, ln) => n + cheatCount(ln), 0), 2)
  })

  it('its clock is its slowest finisher', () => {
    assert.equal(raceElapsed(r, Date.now()), 10_245)
  })

  it('its chart lays out inside the frame', () => {
    const L = traceLayout(r, 0, 600)
    assert.equal(L.maxT, 10_245)
    assert.equal(L.yTop, 7) // the most hops (6), plus one row of headroom
    assert.equal(L.lines.length, 3)
    for (const ln of L.lines) assert.match(ln.d, new RegExp(`^M${L.M.left} `))
    // Different hops, so no field to pack: each horse at the head of its own line…
    for (const hs of L.horses) {
      const end = L.traces[hs.lane].points.at(-1)
      assert.equal(hs.x, L.x(end.t))
      assert.ok(hs.x >= L.M.left + HORSE_HALF && hs.x <= L.M.left + L.plotW)
    }
    // …drawn fewest hops first, so the leader is on top.
    assert.deepEqual(L.horses.map((hs) => hs.hops), [3, 5, 6])
    assert.equal(L.fouls.length, 2)
    assert.deepEqual(L.yTicks.map((t) => t.h), [0, 2, 4, 6, 7])
  })

  it('the crosshair reads a time from a pointer, kept on the chart', () => {
    const L = traceLayout(r, 0, 600)
    assert.equal(timeAt(L, L.M.left), 0)
    assert.equal(timeAt(L, L.M.left + L.plotW), L.maxT)
    assert.equal(timeAt(L, -50), 0)
    assert.equal(timeAt(L, 99_999), L.maxT)
    assert.equal(tipLeft(100, 600), 112)
    assert.equal(tipLeft(590, 600), 410)
    assert.equal(tipLeft(10, 100), 0)
  })
})

describe('errors and times', () => {
  it("a failure shows the server's own words", () => {
    assert.equal(detailOf('{"detail":"no race abc"}', '404 Not Found'), 'no race abc')
    const fastapi = JSON.stringify({ detail: [{ loc: ['body', 'rules', 'max_hops'], msg: 'Input should be less than or equal to 40' }] })
    assert.equal(detailOf(fastapi, '422 Unprocessable Entity'), 'rules.max_hops: Input should be less than or equal to 40')
    assert.equal(detailOf('Bad Gateway', '502 Bad Gateway'), 'Bad Gateway')
    assert.equal(detailOf('', '500 Internal Server Error'), '500 Internal Server Error')
    assert.equal(detailOf('x'.repeat(400), 'f').length, 301)
  })

  it('a stamp with or without a zone is UTC', () => {
    const now = Date.parse('2026-09-22T06:00:00Z')
    assert.equal(ago('2026-09-22T05:59:18+00:00', now), '42s')
    assert.equal(ago('2026-09-22 05:55:00', now), '5m') // SQLite's own format: no zone, and UTC
    assert.equal(ago('2026-09-22T03:00:00Z', now), '3h')
    assert.equal(ago('2026-09-20T06:00:00Z', now), '2d')
    assert.equal(ago(null, now), '—')
    assert.equal(ago('garbage', now), '—')
  })
})

describe('the podium and the finale', () => {
  it('prints a rank as the badges do', () => {
    assert.deepEqual([1, 2, 3, 4, 10].map(ordinal), ['1st', '2nd', '3rd', '4th', '10th'])
    assert.deepEqual([11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), ['11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th'])
  })

  it("names the winner by the race's own ranking, with its hops", () => {
    const r = race({
      status: 'finished', winner: 1, ranking: [1, 0],
      lanes: [lane(0, { status: 'finished', hops: 5, rank: 2 }), lane(1, { status: 'finished', hops: 3, rank: 1, label: 'jev' })],
    })
    assert.deepEqual(raceFinale(r), { win: true, lane: 1, headline: 'PLAYER 2 WINS!', sub: 'jev — 3 hops to Goal' })
  })

  it('says one hop, and a solo racer that finishes simply finishes', () => {
    const r = race({ status: 'finished', winner: 0, ranking: [0], lanes: [lane(0, { status: 'finished', hops: 1, rank: 1 })] })
    assert.deepEqual(raceFinale(r), { win: true, lane: 0, headline: 'FINISHED!', sub: 'model-0 — 1 hop to Goal' })
  })

  it('is GAME OVER when nobody reached the target', () => {
    const r = race({ status: 'finished', lanes: [lane(0, { status: 'dnf' }), lane(1, { status: 'dq' })] })
    assert.deepEqual(raceFinale(r), { win: false, lane: null, headline: 'GAME OVER', sub: 'Nobody reached Goal.' })
  })

  it("reads the fixture's winner", () => {
    const r = fixture('race-jev.json')
    const f = raceFinale(r)
    assert.equal(f.win, true)
    assert.equal(f.lane, r.winner)
    assert.match(f.headline, /^PLAYER \d WINS!$/)
    assert.ok(f.sub.startsWith(r.lanes[r.winner].label))
  })
})

describe('state.js stays pure', () => {
  it('imports nothing and touches no DOM, so this file can test it', () => {
    const src = readFileSync(new URL('../../src/wikirace/static/state.js', import.meta.url), 'utf8')
    const imports = src.match(/^\s*import\s.*$/m)
    assert.equal(imports, null, `state.js must import nothing: ${imports?.[0]}`)
    // Used, not mentioned: "a model's window" in a comment is fine.
    const dom = src.match(/\b(?:document|window|navigator|location)\s*\.|\b(?:fetch|EventSource)\s*\(/)
    assert.equal(dom, null, `state.js must not touch the browser: ${dom?.[0]}`)
  })
})
