// The Arcade's pure half: routes and the run reducer (src/wikirace/static/games/).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, routeSearch } from '../../src/wikirace/static/games/route.js'
import {
  applyRunEvent,
  defaultPlayers,
  fmtMs,
  isRunLive,
  laneCostText,
  lanesBody,
  playersProblem,
  statusToneOf,
} from '../../src/wikirace/static/games/runstate.js'

describe('routes', () => {
  it('leaves every WikiRace address to WikiRace', () => {
    for (const s of ['?race=abc123', '?tab=history', '?tab=race', '?tab=race&race=abc123']) {
      assert.deepEqual(parseRoute(s), { view: 'wikirace' }, s)
    }
  })
  it('opens on the Arcade: the bare address, ?tab=arcade, and anything it cannot read', () => {
    for (const s of ['', '?tab=arcade', '?tab=nonsense', '?game=', '?game=Bad!']) {
      assert.deepEqual(parseRoute(s), { view: 'hub' }, s)
    }
  })
  it('names the hub and a game, with or without a run', () => {
    assert.deepEqual(parseRoute('?tab=arcade'), { view: 'hub' })
    assert.deepEqual(parseRoute('?game=chess'), { view: 'game', game: 'chess', run: null })
    assert.deepEqual(parseRoute('?game=chess&run=0a1b2c3d4e5f'), { view: 'game', game: 'chess', run: '0a1b2c3d4e5f' })
    assert.deepEqual(parseRoute('?game=chess&run=<script>'), { view: 'game', game: 'chess', run: null })
  })
  it('round-trips', () => {
    for (const r of [{ view: 'hub' }, { view: 'wikirace' }, { view: 'game', game: 'switchboard', run: null }, { view: 'game', game: 'bigsort', run: 'abcdef123456' }]) {
      assert.deepEqual(parseRoute(routeSearch(r)), r)
    }
    assert.equal(routeSearch({ view: 'hub' }), '')
    assert.equal(routeSearch({ view: 'wikirace' }), '?tab=race')
  })
})

describe('the run reducer', () => {
  const run = { id: 'r', status: 'running', lanes: [{ index: 0, calls: 0 }, { index: 1, calls: 0 }], items: [] }
  it('applies every event the server emits', () => {
    let r = applyRunEvent(null, { type: 'snapshot', run })
    assert.equal(r, run)
    r = applyRunEvent(r, { type: 'patch', patch: { note: 'hi' } })
    r = applyRunEvent(r, { type: 'lane', lane: 1, patch: { calls: 3 } })
    r = applyRunEvent(r, { type: 'push', key: 'items', item: { n: 1 } })
    r = applyRunEvent(r, { type: 'push', key: 'fresh', item: 'x' })
    r = applyRunEvent(r, { type: 'put', key: 'items', index: 0, item: { n: 2 } })
    r = applyRunEvent(r, { type: 'lane_push', lane: 0, key: 'moves', item: 'e4' })
    assert.deepEqual(r, {
      id: 'r', status: 'running', note: 'hi', items: [{ n: 2 }], fresh: ['x'],
      lanes: [{ index: 0, calls: 0, moves: ['e4'] }, { index: 1, calls: 3 }],
    })
    assert.equal(run.items.length, 0, 'the old state is untouched')
    assert.equal(applyRunEvent(r, { type: 'mystery' }), r)
    assert.equal(applyRunEvent(null, { type: 'patch', patch: {} }), null)
  })
  it('reads status and cost', () => {
    assert.ok(isRunLive({ status: 'running' }))
    assert.ok(!isRunLive({ status: 'finished' }))
    assert.equal(statusToneOf('playing'), 'live')
    assert.equal(statusToneOf('error'), 'err')
    assert.equal(laneCostText({ cost: 0.0042, cost_estimated: true }), '≈$0.0042')
    assert.equal(laneCostText({ cost: 0, cost_unknown: true }), '—')
    assert.equal(laneCostText({ cost: 0, provider: 'ollama' }), '$0 · local')
    assert.equal(laneCostText({ cost: 1.5, cost_unknown: true }), '$1.50+')
    assert.equal(fmtMs(120), '120 ms')
    assert.equal(fmtMs(1400), '1.4 s')
    assert.equal(fmtMs(125_000), '2m 5s')
  })
})

describe('players', () => {
  const models = [
    { key: 'openrouter:a', kind: 'text', available: true, model_id: 'a' },
    { key: 'typesafe:jev', kind: 'judgment', available: true, model_id: 'jev' },
    { key: 'openai:x', kind: 'text', available: false, model_id: 'x', reason: 'no key' },
    { key: 'openrouter:b', kind: 'text', available: true, model_id: 'b' },
  ]
  it('starts with Jev, then the first text models that can play', () => {
    assert.deepEqual(defaultPlayers(models, { count: 3 }), [{ key: 'typesafe:jev' }, { key: 'openrouter:a' }, { key: 'openrouter:b' }])
    assert.deepEqual(defaultPlayers(models, { kinds: ['text'], count: 1, jev: false }), [{ key: 'openrouter:a' }])
  })
  it('says what is wrong with a line-up', () => {
    const game = { lanes: { min: 1, max: 2 }, kinds: ['judgment', 'text'], needs_jev: true }
    assert.equal(playersProblem([], game, models), 'Pick a player.')
    assert.equal(playersProblem([{ key: 'openrouter:a' }], game, models), 'This game needs Jev in one lane.')
    assert.match(playersProblem([{ key: 'openai:x' }], game, models), /cannot play: no key/)
    assert.equal(playersProblem([{ key: 'typesafe:jev' }, { key: '' }], game, models), null)
    assert.deepEqual(lanesBody([{ key: 'typesafe:jev' }, { key: '' }]), [{ key: 'typesafe:jev' }])
  })
})
