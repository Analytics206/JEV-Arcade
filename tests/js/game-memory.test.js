// Memory Match: your claims are scored on the page by the server's own rules.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LEVEL_MARK,
  POINTS,
  alignB,
  bestOf,
  cardName,
  cellOf,
  checks,
  goldChecks,
  goldOf,
  perfectBoard,
  perfectClaim,
  podium,
  standings,
  tally,
  verdict,
} from '../../src/wikirace/static/games/memory.logic.js'

const GOLD = [
  { a: 0, b: 5, level: 2, fields: { brand: true, model: true, variant: true } },
  { a: 1, b: 6, level: 1, fields: { brand: true, model: true, variant: false } },
  { a: 2, b: 7, level: 0, fields: { brand: true, model: false, variant: true } },
  { a: 3, b: 4, level: 2, fields: { brand: true, model: true, variant: true } },
]

describe('scoring', () => {
  it('judges a claim against the gold level', () => {
    assert.equal(verdict(2, 2), 'same')
    assert.equal(verdict(1, 1), 'related')
    assert.equal(verdict(1, 2), 'cautious')
    assert.equal(verdict(2, 1), 'eager')
    assert.equal(verdict(2, 0), 'wrong')
    assert.equal(goldOf(GOLD, 3, 5), 0)
  })
  it('counts points, the right, the wrong and the missed, as the server does', () => {
    const t = tally(
      [
        { a: 0, b: 5, level: 2 },
        { a: 1, b: 6, level: 2 },
        { a: 2, b: 7, level: 1 },
        { a: 3, b: 5, level: 1 },
      ],
      GOLD,
    )
    assert.deepEqual(t.claims.map((c) => c.verdict), ['same', 'eager', 'wrong', 'wrong'])
    assert.equal(t.points, POINTS.same + POINTS.eager + 2 * POINTS.wrong)
    assert.equal(t.points, 0)
    assert.equal(t.missed, 1)
    assert.equal(t.right, 1)
    assert.equal(t.wrong, 2)
    assert.equal(tally([], GOLD).missed, 3)
    assert.equal(bestOf(GOLD), 5)
  })
  it('ranks everyone, ties sharing a place', () => {
    const s = standings([{ who: 'you', points: 3 }, { who: 'jev', points: 5 }, { who: 'text', points: 3 }, { who: 'late', points: null }])
    assert.deepEqual(s.map((e) => [e.who, e.place]), [['jev', 1], ['you', 2], ['text', 2], ['late', 4]])
  })
})

describe('the board', () => {
  it('puts each claimed B card in its A card’s row, the rest in order', () => {
    assert.deepEqual(alignB(4, []), [0, 1, 2, 3])
    assert.deepEqual(alignB(4, [{ a: 0, b: 3 }, { a: 2, b: 0 }]), [3, 1, 0, 2])
    // A B card named twice stays in the first row that named it.
    assert.deepEqual(alignB(3, [{ a: 0, b: 2 }, { a: 1, b: 2 }]), [2, 0, 1])
    const rows = alignB(6, [{ a: 5, b: 0 }, { a: 1, b: 4 }])
    assert.deepEqual([...rows].sort(), [0, 1, 2, 3, 4, 5])
  })
  it('reads Jev’s companion checks and the gold ones', () => {
    const cell = { a: 0, b: 1, score: 1.2, brand: 0.93, model: 0.81, variant: 0.12 }
    assert.deepEqual(checks(cell).map((c) => [c.k, c.yes]), [['brand', true], ['model', true], ['variant', false]])
    assert.equal(cellOf([cell], 0, 1), cell)
    assert.equal(cellOf([cell], 1, 0), undefined)
    assert.deepEqual(goldChecks(GOLD[1]).map((c) => c.yes), [true, true, false])
    assert.equal(cardName('b', 2), 'B3')
  })
})

describe('who won', () => {
  it('names everyone sharing the best points, and leaves out whoever has none', () => {
    const top = podium([{ key: 'you', points: 3 }, { key: 'l0', points: 5 }, { key: 'l1', points: 5 }, { key: 'l2', points: null }])
    assert.deepEqual(top.map((e) => e.key), ['l0', 'l1'])
    assert.deepEqual(podium([{ key: 'you', points: -1 }]).map((e) => e.key), ['you'])
    assert.deepEqual(podium([{ key: 'l0', points: null }]), [])
    assert.deepEqual(podium(null), [])
  })
  it('knows a perfect call and a perfect board', () => {
    assert.ok(perfectClaim('same') && perfectClaim('related'))
    assert.ok(!perfectClaim('cautious') && !perfectClaim('eager') && !perfectClaim('wrong'))
    assert.ok(perfectBoard(5, GOLD))
    assert.ok(!perfectBoard(4, GOLD))
    assert.ok(!perfectBoard(0, []))
    assert.deepEqual(LEVEL_MARK, ['≠', '≈', '='])
  })
})
