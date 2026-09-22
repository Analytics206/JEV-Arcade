// Judges' Panel: the composite and the ranking live on the page, in code.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cardOf,
  composite,
  dotOf,
  formula,
  lede,
  matrixOf,
  orderOf,
  presetOf,
  presetWeights,
  pts,
  rank,
  tilt,
} from '../../src/wikirace/static/games/judges.logic.js'

const JUDGES = [
  { id: 'kids', short: 'kids' },
  { id: 'apt', short: 'apt' },
  { id: 'shed', short: 'shed' },
]
const cell = (score, spread = 0.5) => ({ score, spread, level: Math.round(score), probabilities: [0.2, 0.2, 0.2, 0.2, 0.2] })

describe('the composite', () => {
  it('is Σ w·(score/4) / Σ w', () => {
    assert.equal(composite([4, 0, 2], [1, 1, 2]), (1 * 1 + 0 + 2 * 0.5) / 4)
    assert.equal(composite([4, 4, 4], [5, 0, 1]), 1)
    assert.equal(composite([0, 0, 0], [3, 3, 3]), 0)
  })
  it('leaves out a judge that gave no score, with its weight', () => {
    assert.equal(composite([4, null, 2], [1, 5, 1]), (1 + 0.5) / 2)
    assert.equal(composite([null, null], [1, 1]), null)
  })
  it('is null when every weight is zero', () => {
    assert.equal(composite([3, 3, 3], [0, 0, 0]), null)
  })
})

describe('the leaderboard', () => {
  const contestants = [{ name: 'A' }, { name: 'B' }, { name: 'C' }]
  const lane = {
    scored: [
      { c: 0, judges: [cell(4), cell(0), cell(1)] },
      { c: 1, judges: [cell(1), cell(4), cell(4)] },
    ],
  }
  const m = matrixOf(lane, 3, 3)
  it('reads a lane into a matrix, undefined where nothing came yet', () => {
    assert.equal(m[0][0].score, 4)
    assert.equal(m[2][0], undefined)
    const fouled = matrixOf({ scored: [{ c: 2, judges: [null, cell(2), cell(3)] }] }, 3, 3)
    assert.equal(fouled[2][0], null)
  })
  it('re-ranks when the weights move, with no new data', () => {
    const kidsFirst = rank(contestants, m, [5, 0, 0])
    assert.deepEqual(kidsFirst.map((r) => r.c.name), ['A', 'B', 'C'])
    const flatFirst = rank(contestants, m, [0, 5, 5])
    assert.deepEqual(flatFirst.map((r) => r.c.name), ['B', 'A', 'C'])
    assert.notEqual(orderOf(kidsFirst), orderOf(flatFirst))
    assert.equal(flatFirst[0].rank, 1)
    assert.equal(flatFirst[2].composite, null) // C is not scored yet: last
    assert.equal(pts(flatFirst[0].composite), 100)
  })
  it('keeps equal contestants in their own order', () => {
    const same = matrixOf({ scored: [0, 1, 2].map((c) => ({ c, judges: [cell(2), cell(2), cell(2)] })) }, 3, 3)
    assert.deepEqual(rank(contestants, same, [1, 1, 1]).map((r) => r.k), [0, 1, 2])
  })
})

describe('the cards', () => {
  it('tilt more the wider the spread, alternating sides, within a limit', () => {
    assert.ok(Math.abs(tilt(0.8, 0)) > Math.abs(tilt(0.2, 0)))
    assert.ok(tilt(0.5, 0) < 0 && tilt(0.5, 1) > 0)
    assert.equal(Math.abs(tilt(9, 2)), 16)
    assert.equal(Math.abs(tilt(NaN, 1)), 1.5)
  })
  it('read as a mean and a spread, a whole number, or nothing', () => {
    assert.deepEqual(cardOf(cell(3.44, 0.51)), { state: 'up', big: '3.4', small: '±0.5' })
    assert.deepEqual(cardOf({ score: 3, spread: 0, probabilities: null }), { state: 'up', big: '3', small: 'as written' })
    assert.equal(cardOf(null).state, 'foul')
    assert.equal(cardOf(undefined).state, 'wait')
    assert.equal(dotOf(cell(2.6)), 3)
    assert.equal(dotOf(null), null)
  })
})

describe('presets and the formula', () => {
  const presets = [{ id: 'p', weights: { kids: 5, apt: 1, shed: 0 } }]
  it('map a preset onto the judges, and recognise it again', () => {
    assert.deepEqual(presetWeights(presets[0], JUDGES), [5, 1, 0])
    assert.equal(presetOf(presets, JUDGES, [5, 1, 0]).id, 'p')
    assert.equal(presetOf(presets, JUDGES, [5, 2, 0]), null)
  })
  it('writes the formula out', () => {
    assert.equal(formula(JUDGES, [5, 1, 0]), 'score = (5·kids + 1·apt + 0·shed) / 6')
  })
  it('cuts a lede at a sentence', () => {
    const t = `${'Word '.repeat(20)}ends here. ${'More words '.repeat(30)}`
    assert.ok(lede(t, 120).endsWith('ends here.'))
    assert.equal(lede('Short.\nSecond paragraph.'), 'Short.')
  })
})
