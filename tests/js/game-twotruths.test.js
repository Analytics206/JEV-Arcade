// Two Truths and a Lie's pure page logic (src/wikirace/static/games/twotruths.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  agitation,
  clockText,
  entryOf,
  foundBy,
  jevLie,
  needleAngle,
  pointsAttr,
  polygraph,
  revealOrder,
  rng,
  signalOf,
  tallyOf,
  topVerdict,
  traceLength,
  unsealed,
} from '../../src/wikirace/static/games/twotruths.logic.js'

const v = (supported, contradicted, not_in_article) => ({ supported, contradicted, not_in_article })

describe('the polygraph', () => {
  it('is calm for a truth and jumps for a lie', () => {
    const calm = polygraph(0.02, 7)
    const lie = polygraph(0.9, 7)
    assert.equal(calm.length, 91)
    assert.ok(agitation(calm) < 0.12, `calm strayed ${agitation(calm)}`)
    assert.ok(agitation(lie) > 0.6, `the lie only strayed ${agitation(lie)}`)
    assert.ok(agitation(polygraph(0.5, 7)) > agitation(calm) && agitation(polygraph(0.5, 7)) < agitation(lie))
  })
  it('stays inside its strip, left to right, and draws the same for a seed', () => {
    const pts = polygraph(1, 3, { width: 200, height: 40, n: 50 })
    assert.equal(pts[0][0], 0)
    assert.equal(pts.at(-1)[0], 200)
    assert.ok(pts.every(([x, y], i) => y >= 2 && y <= 38 && (i === 0 || x > pts[i - 1][0])))
    assert.deepEqual(polygraph(0.4, 11), polygraph(0.4, 11))
    assert.notDeepEqual(polygraph(0.4, 11), polygraph(0.4, 12))
    assert.equal(pointsAttr([[0, 1], [2.5, 3]]), '0,1 2.5,3')
    assert.equal(traceLength([[0, 0], [3, 4], [3, 10]]), 11)
  })
  it('clamps what it is given', () => {
    assert.deepEqual(polygraph(7, 5), polygraph(1, 5))
    assert.deepEqual(polygraph(-1, 5), polygraph(0, 5))
    assert.deepEqual(polygraph(undefined, 5), polygraph(0, 5))
    const r = rng(42)
    const xs = Array.from({ length: 50 }, r)
    assert.ok(xs.every((x) => x >= 0 && x < 1) && new Set(xs).size === 50)
  })
})

describe('verdicts', () => {
  it('reads the likeliest option and the lie, as the server does', () => {
    assert.equal(topVerdict(v(0.1, 0.8, 0.1)), 'contradicted')
    assert.equal(topVerdict({ ...v(0.1, 0.8, 0.1), top: 'supported' }), 'supported')
    assert.equal(topVerdict(null), null)
    assert.equal(jevLie([v(0.9, 0.05, 0.05), v(0.1, 0.6, 0.3), v(0.2, 0.6, 0.2)]), 1)
    assert.equal(jevLie([v(0.9, 0.05, 0.05), v(0.1, 0.6, 0.3), v(0.05, 0.6, 0.35)]), 2)
    assert.equal(jevLie([]), null)
  })
  it('drives a polygraph by Jev, else by the judges who named the claim', () => {
    const jev = { kind: 'judgment', verdicts: [v(0.9, 0.05, 0.05), v(0.1, 0.8, 0.1), v(0.8, 0.1, 0.1)] }
    assert.deepEqual(signalOf({ lanes: [jev] }, 1), { p: 0.8, source: 'jev', top: 'contradicted' })
    const texts = [{ kind: 'text', ms: 5, pick: 2 }, { kind: 'text', ms: 5, pick: 2 }, { kind: 'text', ms: 5, pick: 0 }, { kind: 'text' }]
    assert.deepEqual(signalOf({ lanes: texts }, 2), { p: 2 / 3, source: 'judges', top: 'contradicted' })
    assert.deepEqual(signalOf({ lanes: [{ kind: 'text' }] }, 0), { p: 0, source: null, top: null })
  })
})

describe('the session', () => {
  const run = {
    lie: 2, article: { title: 'Axolotl' },
    lanes: [
      { label: 'jev-1.13.0', kind: 'judgment', found: true, ms: 120 },
      { label: 'gpt', kind: 'text', found: false, ms: 5000 },
      { label: 'late', kind: 'text', found: null },
    ],
  }
  it('seals the verdicts until the visitor picks or asks', () => {
    assert.equal(unsealed(null), false)
    assert.equal(unsealed({}), false)
    assert.equal(unsealed({ pick: 0 }), true)
    assert.equal(unsealed({ skipped: true }), true)
  })
  it('makes a round only once the lie is out and the visitor has played', () => {
    assert.equal(entryOf({ ...run, lie: null }, { pick: 2 }), null)
    assert.equal(entryOf(run, null), null)
    const e = entryOf(run, { pick: 2, ms: 6200 })
    assert.deepEqual(e, {
      title: 'Axolotl', you: true, youMs: 6200,
      judges: [
        { label: 'jev-1.13.0', kind: 'judgment', found: true, ms: 120 },
        { label: 'gpt', kind: 'text', found: false, ms: 5000 },
      ],
    })
    assert.equal(entryOf(run, { skipped: true }).you, null)
  })
  it('adds up you against each judge', () => {
    const rounds = [
      entryOf(run, { pick: 2, ms: 6000 }),
      entryOf({ ...run, lie: 0 }, { pick: 1, ms: 4000 }),
      entryOf(run, { skipped: true }),
    ]
    const t = tallyOf(rounds)
    assert.equal(t.rounds, 3)
    assert.deepEqual(t.you, { found: 1, played: 2, ms: 5000 })
    assert.deepEqual(t.judges.map((j) => [j.label, j.found, j.rounds, j.ms]), [
      ['jev-1.13.0', 3, 3, 120],
      ['gpt', 0, 3, 5000],
    ])
    assert.deepEqual(tallyOf([]), { rounds: 0, you: { found: 0, played: 0, ms: null }, judges: [] })
  })
})

describe('the stage', () => {
  it('writes the duel clocks', () => {
    assert.equal(clockText(183), '0.18S')
    assert.equal(clockText(12_380), '12.3S')
    assert.equal(clockText(64_000), '1:04')
    assert.equal(clockText(NaN), '--')
  })
  it('swings the needle from TRUE to LIE with p(contradicted)', () => {
    assert.equal(needleAngle(0), -90)
    assert.equal(needleAngle(0.5), 0)
    assert.equal(needleAngle(1), 90)
    assert.equal(needleAngle(3), 90)
    assert.equal(needleAngle(undefined), -90)
  })
  it('stamps the truths first, left to right, and the lie last', () => {
    assert.deepEqual([0, 1, 2].map((k) => revealOrder(k, 0)), [2, 0, 1])
    assert.deepEqual([0, 1, 2].map((k) => revealOrder(k, 1)), [0, 2, 1])
    assert.deepEqual([0, 1, 2].map((k) => revealOrder(k, 2)), [0, 1, 2])
    assert.equal(revealOrder(1, null), 0)
  })
  it('names as winners every judge that found the lie, once it is out', () => {
    const lanes = [
      { index: 0, found: true },
      { index: 1, found: false },
      { index: 2, found: true },
      { index: 3, found: null },
    ]
    assert.deepEqual(foundBy({ lie: 1, lanes }), [0, 2])
    assert.deepEqual(foundBy({ lie: null, lanes }), [])
    assert.deepEqual(foundBy({ lie: 0, lanes: [{ index: 0, found: false }] }), [])
    assert.deepEqual(foundBy(null), [])
  })
})
