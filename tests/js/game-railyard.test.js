// Rail Yard's pure half (src/wikirace/static/games/railyard.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  bigStation,
  costAgainst,
  defaultTiers,
  ease,
  fmtUsd,
  niceCeil,
  ruleLine,
  scatterScales,
  snippet,
  trackPose,
  trainText,
  yardLayout,
  yardSummary,
} from '../../src/wikirace/static/games/railyard.logic.js'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

describe('default tiers', () => {
  it('ranks by list price, keeps lane order when a price is unknown, and makes Ollama local', () => {
    const p = (input, output) => ({ input, output })
    assert.deepEqual(defaultTiers([
      { provider: 'anthropic', price: p(5, 25) },
      { provider: 'anthropic', price: p(1, 5) },
      { provider: 'ollama', price: p(0, 0) },
    ]), ['large', 'small', 'local'])
    assert.deepEqual(defaultTiers([{ provider: 'openrouter', price: null }, { provider: 'openrouter', price: null },
      { provider: 'openrouter', price: null }]), ['small', 'medium', 'large'])
    assert.deepEqual(defaultTiers([{ provider: 'openai', price: p(0.05, 0.4) }, { provider: 'ollama', price: p(0, 0) }]),
      ['large', 'local'])
  })
})

describe('the yard', () => {
  it('spreads one track per station around the main line, each ending at its platform', () => {
    const L = yardLayout(3)
    assert.equal(L.tracks.length, 3)
    assert.deepEqual(L.tracks.map((t) => t.y), [L.mainY - 90, L.mainY, L.mainY + 90])
    for (const [s, t] of L.tracks.entries()) {
      assert.ok(t.d.startsWith(`M540 ${L.mainY} C`) && t.d.endsWith('H880'))
      assert.equal(L.stations[s].y + L.stations[s].h / 2, t.y)
      assert.ok(L.stations[s].x + L.stations[s].w <= L.width)
    }
    const two = yardLayout(2)
    assert.ok(two.tracks[0].y >= 0 && two.tracks[1].y <= two.height && two.tracks[0].y < two.tracks[1].y)
  })
  it('runs a train from the front of the queue, round the switch, to its platform', () => {
    const L = yardLayout(3)
    const start = trackPose(L, 0, 0)
    assert.deepEqual([start.y, start.angle], [L.mainY, 0])
    const atSwitch = trackPose(L, 0, 0.12)
    near(atSwitch.x, 540)
    const mid = trackPose(L, 0, 0.42)
    assert.ok(mid.y < L.mainY && mid.y > L.tracks[0].y && mid.angle < 0, 'climbing towards the top track')
    const down = trackPose(L, 2, 0.42)
    assert.ok(down.angle > 0)
    const end = trackPose(L, 0, 1)
    assert.deepEqual([end.x + 62, end.y, end.angle], [880, L.tracks[0].y, 0])
    near(trackPose(L, 1, 0.5).y, L.mainY)
    assert.equal(trackPose(L, 1, 7).x, trackPose(L, 1, 1).x)
    near(ease(0), 0)
    near(ease(1), 1)
    near(ease(0.5), 0.5)
  })
  it('labels a train with its prompt, wrapped and cut', () => {
    assert.deepEqual(snippet('What is the capital of Australia?'), ['“What is the', 'capital of…”'])
    assert.deepEqual(snippet('Convert this.'), ['“Convert this.”'])
    assert.deepEqual(snippet(''), ['“”'])
    const [a, b] = snippet('What does this Python print?\n\nprint(len("hello world"))')
    assert.ok(a.length <= 18 && b.endsWith('…”'))
  })
  it('labels a prompt that carries code by its code', () => {
    assert.equal(trainText('What does this Python print?\n\nx = [1]\ny = x\nprint(len(x))'), 'x = [1]; y = x; print(len(x))')
    assert.equal(trainText('What is the capital of Australia?'), 'What is the capital of Australia?')
  })
  it('measures the router against the top-tier station', () => {
    const always = [{ tier: 'small', cost: 0.04 }, { tier: 'large', cost: 0.04 }, { tier: 'local', cost: 0 }]
    assert.equal(bigStation(always).tier, 'large')
    assert.deepEqual(costAgainst(0.04, 0.04), { share: 0, word: 'the same cost' })
    assert.equal(costAgainst(0.01, 0.04).word, 'cheaper')
    near(costAgainst(0.01, 0.04).share, 0.75)
    assert.equal(costAgainst(0.06, 0.04).word, 'dearer')
    assert.equal(costAgainst(0.01, 0), null)
  })
  it('prints the rule a train took', () => {
    assert.deepEqual(['private', 'private_no_local', 'unsure_up', 'unsure_top', 'pick'].map(ruleLine), [0, 0, 1, 1, 2])
  })
})

describe('the router against always one station', () => {
  const run = {
    stations: [{ lane: 1, tier: 'small' }, { lane: 2, tier: 'large' }],
    trains: [
      { k: 0, to: 0, verdict: 'right', cost: 0.001, jev_cost: 0.00001 },
      { k: 1, to: 1, verdict: 'right', cost: 0.01, jev_cost: 0.00001 },
      { k: 2, to: 0, verdict: null, cost: null, jev_cost: 0.00001 },
    ],
    lanes: [
      {},
      { answers: [{ k: 0, verdict: 'right', cost: 0.001 }, { k: 1, verdict: 'wrong', cost: 0.001 }, { k: 2, verdict: 'right', cost: 0.001 }] },
      { answers: [{ k: 1, verdict: 'right', cost: 0.01 }, { k: 0, verdict: 'leak', cost: 0.01 }] },
    ],
  }
  it('compares over the trains delivered so far', () => {
    const s = yardSummary(run)
    assert.equal(s.router.n, 2)
    near(s.router.accuracy, 1)
    near(s.router.cost, 0.011 + 0.00002)
    assert.deepEqual(s.always.map((a) => [a.tier, a.right, a.n]), [['small', 1, 2], ['large', 1, 2]])
    near(s.always[0].cost, 0.002)
    near(s.always[1].cost, 0.02)
    assert.deepEqual(s.traffic.map((t) => [t.received, t.delivered]), [[2, 1], [1, 1]])
    assert.equal(s.traffic[1].last.k, 1)
  })
  it('has nothing to compare before the first delivery', () => {
    const s = yardSummary({ stations: run.stations, trains: [], lanes: run.lanes })
    assert.equal(s.router.accuracy, null)
    assert.ok(s.always.every((a) => a.accuracy === null))
  })
})

describe('the chart', () => {
  it('rounds its cost axis up and its quality axis down to tens', () => {
    assert.equal(niceCeil(0.037), 0.05)
    assert.equal(niceCeil(1.9), 2)
    assert.equal(niceCeil(0), 0.001)
    const S = scatterScales([{ cost: 0.037, accuracy: 0.9 }, { cost: 0.004, accuracy: 0.62 }])
    assert.equal(S.xMax, 0.05)
    assert.equal(S.yLo, 0.5)
    assert.equal(S.x(0), 40)
    assert.equal(S.x(0.05), 340)
    assert.equal(S.y(1), 20)
    assert.equal(S.y(0.5), 200)
    assert.deepEqual(S.yTicks.map((t) => t.label), ['100%', '90%', '80%', '70%', '60%', '50%'])
    assert.deepEqual(S.xTicks.map((t) => t.label), ['$0', '$0.025', '$0.05'])
  })
  it('keeps at least a fifth of the quality range and survives a free round', () => {
    const S = scatterScales([{ cost: 0, accuracy: 1 }, { cost: 0, accuracy: 0.97 }])
    assert.equal(S.yLo, 0.8)
    assert.ok(Number.isFinite(S.x(0)))
    const wide = scatterScales([{ cost: 1, accuracy: 0.1 }])
    assert.equal(wide.yLo, 0)
    assert.deepEqual(wide.yTicks.map((t) => t.v), [1, 0.8, 0.6, 0.4, 0.2, 0])
  })
  it('writes dollars short', () => {
    assert.deepEqual([0, 0.0042, 0.05, 1.84, 4.2e-7].map(fmtUsd), ['$0', '$0.0042', '$0.05', '$1.8', '$4.2e-7'])
  })
})
