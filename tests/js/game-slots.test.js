// Slot Machine's pure page logic: reels, chips and the probability band (static/games/slots.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABELS,
  agreementTone,
  band,
  byPull,
  caption,
  chipsOf,
  flips,
  jackpot,
  nextPost,
  outcomeOf,
  reelsOf,
  share,
  spreadText,
} from '../../src/wikirace/static/games/slots.logic.js'

const pull = (n, outcome, extra = {}) => ({ n, reel: n % 3, outcome, top: LABELS.includes(outcome) ? outcome : 'warn', ...extra })

describe('the reels', () => {
  it('show each reel\'s latest pull, whatever order the pulls landed in', () => {
    const lane = { pulls: [pull(4, 'warn'), pull(0, 'allow'), pull(2, 'remove'), pull(1, 'warn'), pull(3, 'allow')], spinning: [null, null, 5] }
    const reels = reelsOf(lane)
    assert.deepEqual(reels.map((r) => r.pull?.n), [3, 4, 2])
    assert.deepEqual(reels.map((r) => r.spinning), [false, false, true])
    assert.equal(reels[2].n, 5)
    assert.equal(jackpot(reels), null)
    assert.deepEqual(byPull(lane).map((p) => p.n), [0, 1, 2, 3, 4])
  })
  it('call three in a row only when all three have landed on the same outcome', () => {
    const three = { pulls: [pull(0, 'uncertain'), pull(1, 'uncertain'), pull(2, 'uncertain')], spinning: [null, null, null] }
    assert.equal(jackpot(reelsOf(three)), 'uncertain')
    assert.equal(jackpot(reelsOf({ ...three, spinning: [3, null, null] })), null)
    assert.equal(jackpot(reelsOf({ pulls: [pull(0, 'warn'), pull(1, 'warn')] })), null)
    assert.equal(jackpot([]), null)
  })
  it('read every outcome with a glyph and a tone, a foul included', () => {
    for (const o of [...LABELS, 'uncertain', 'foul']) assert.ok(outcomeOf(o).glyph && outcomeOf(o).tone && outcomeOf(o).word)
    assert.equal(outcomeOf('flag for review').word, 'FOUL')
    assert.equal(new Set([...LABELS, 'uncertain', 'foul'].map((o) => outcomeOf(o).glyph)).size, 5)
  })
})

describe('the strip and the numbers', () => {
  it('lays out one chip per pull: landed, spinning or to come', () => {
    const chips = chipsOf({ pulls: [pull(0, 'allow'), pull(2, 'warn')], spinning: [3, 1, null] }, 5)
    assert.deepEqual(chips.map((c) => [c.n, c.pull?.outcome ?? null, c.spinning]), [
      [0, 'allow', false], [1, null, true], [2, 'warn', false], [3, null, true], [4, null, false],
    ])
  })
  it('counts the times the verdict changed its mind, in pull order', () => {
    assert.equal(flips({ pulls: [pull(2, 'warn'), pull(0, 'allow'), pull(1, 'warn'), pull(3, 'warn')] }), 1)
    assert.equal(flips({ pulls: [pull(0, 'allow'), pull(1, 'warn'), pull(2, 'allow')] }), 2)
    assert.equal(flips({}), 0)
  })
  it('writes shares, tones and spreads', () => {
    assert.equal(share(7 / 15, 15), '7/15')
    assert.equal(agreementTone(1), 'ok')
    assert.equal(agreementTone(0.7), 'warn')
    assert.equal(agreementTone(0.4), 'err')
    assert.equal(agreementTone(NaN), 'neutral')
    assert.equal(spreadText({ allow: [0.4, 0.46], warn: [0.4, 0.42], remove: [0.12, 0.14] }), 'allow 0.40–0.46 · warn 0.40–0.42 · remove 0.12–0.14')
    assert.equal(spreadText(null), '')
    assert.equal(nextPost(11, 12), 0)
    assert.equal(nextPost(3, 12), 4)
  })
  it('captions the latest pulls, and says when Jev hands one to a human', () => {
    const jev = { kind: 'judgment', pulls: [pull(0, 'uncertain', { top: 'allow', top_p: 0.46 })] }
    assert.equal(caption(jev, 0.6), 'pulls 1 · top pick allow 0.46, under 0.60, so a human decides')
    const text = { kind: 'text', pulls: [pull(0, 'foul', { said: 'escalate' })] }
    assert.equal(caption(text, 0.6), 'pulls 1 · the last said “escalate”')
    assert.equal(caption({ pulls: [], spinning: [0, 1, 2] }, 0.6), 'the first pull is spinning…')
  })
})

describe('the probability band', () => {
  const p = (allow, warn, remove) => ({ allow, warn, remove })
  const lane = { pulls: [pull(0, 'warn', { p: p(0.3, 0.62, 0.08) }), pull(1, 'uncertain', { p: p(0.35, 0.58, 0.07) })] }
  const box = { w: 200, h: 100, left: 0, right: 0, top: 0, bottom: 0 }
  it('puts a dot per pull per label, from the top for 1 to the bottom for 0', () => {
    const b = band(lane, 4, 0.6, box)
    const warn = b.series.find((s) => s.label === 'warn')
    assert.deepEqual(warn.points, [[25, 38], [75, 42]])
    assert.deepEqual(warn.band, { y0: 38, y1: 42 })
    assert.equal(b.threshold, 40)
    assert.deepEqual(b.uncertain, [75])
    assert.equal(b.y(1), 0)
    assert.equal(b.y(0), 100)
  })
  it('draws nothing for a text lane, which has no probabilities', () => {
    const b = band({ pulls: [pull(0, 'warn')] }, 3, 0.6, box)
    assert.ok(b.series.every((s) => s.points.length === 0 && s.band === null))
  })
})
