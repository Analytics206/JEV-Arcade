// Needle Hunt's pure page logic (src/wikirace/static/games/needle.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIAL,
  NONE,
  arcPath,
  around,
  band,
  dialBands,
  dialPoint,
  heatFor,
  heatStep,
  isNear,
  judgePick,
  lineAt,
  minimap,
  needleAngle,
  nextQuestion,
  signed,
  tallyOf,
} from '../../src/wikirace/static/games/needle.logic.js'

const lines = [
  { id: 'L001', text: 'We the People of the United States.', s: 0 },
  { id: 'L002', text: 'All legislative Powers.', s: 1 },
  { id: 'L003', text: 'The House of Representatives shall be composed of Members chosen every second Year.', s: 2 },
  { id: 'L004', text: 'No Person shall be a Representative who shall not have attained to the Age of twenty five Years.', s: 2 },
  { id: 'L005', text: 'The Senate of the United States.', s: 3 },
]

describe('the dial', () => {
  it('runs from the left (0) over the top to the right (1)', () => {
    assert.deepEqual(dialPoint(0), [DIAL.cx - DIAL.r, DIAL.cy])
    assert.deepEqual(dialPoint(1), [DIAL.cx + DIAL.r, DIAL.cy])
    assert.deepEqual(dialPoint(0.5), [DIAL.cx, DIAL.cy - DIAL.r])
    // The mockup's own boundary of the partly band.
    assert.deepEqual(dialPoint(0.35), [58.95, 31.17])
    assert.deepEqual(dialPoint(-3), dialPoint(0))
  })
  it('draws the three bands as arcs that meet', () => {
    const [absent, partly, answered] = dialBands()
    assert.equal(absent.band, 'absent')
    assert.equal(absent.d, 'M18 98 A75 75 0 0 1 58.95 31.17')
    assert.ok(partly.d.startsWith('M58.95 31.17 ') && answered.d.endsWith(' 168 98'))
    assert.equal(arcPath(0.7, 1), answered.d)
  })
  it('turns the needle and reads the bands', () => {
    assert.equal(needleAngle(0), 0)
    assert.equal(needleAngle(0.97), 174.6)
    assert.equal(needleAngle(2), 180)
    assert.deepEqual([0.95, 0.7, 0.69, 0.35, 0.34].map((p) => band(p)), ['answered', 'answered', 'partly', 'partly', 'absent'])
  })
})

describe('the minimap', () => {
  it('lays one bar per line down the strip, as long as its line', () => {
    const m = minimap(lines, {}, { width: 100, height: 50 })
    assert.equal(m.bars.length, 5)
    assert.deepEqual(m.bars.map((b) => b.y), [0, 10, 20, 30, 40])
    assert.ok(m.bars.every((b) => b.h === 7 && b.y + b.h <= 50))
    assert.ok(m.bars[3].w === 100 && m.bars[1].w < m.bars[2].w && m.bars[1].w >= 25)
    assert.equal(m.hottest, null)
    assert.ok(m.bars.every((b) => b.heat === 0))
  })
  it('heats bars against the hottest, which glows', () => {
    const m = minimap(lines, { L004: 0.8, L003: 0.1, L999: 1 }, { width: 100, height: 50 })
    assert.equal(m.hottest, 'L004')
    assert.equal(m.bars[3].heat, 1)
    assert.equal(m.bars[2].heat, 0.125)
    assert.deepEqual([1, 0.5, 0.2, 0.05, 0.01, 0].map(heatStep), [4, 3, 2, 1, 0, 0])
  })
  it('packs a long document edge to edge and maps a click to its line', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ id: `L${i}`, text: 'x'.repeat(i % 300), s: 0 }))
    const m = minimap(many, {}, { height: 360 })
    assert.equal(m.bars[1].h, 0.4)
    assert.ok(m.bars.at(-1).y + m.bars.at(-1).h <= 360.01)
    assert.equal(lineAt(0, 900), 0)
    assert.equal(lineAt(0.5, 900), 450)
    assert.equal(lineAt(1, 900), 899)
  })
})

describe('the heat behind a question', () => {
  const doc = { windows: [[0, 1], [2, 4]] }
  it("is Jev's, its window's share spread over the lines it did not read", () => {
    const run = {
      doc, lines,
      lanes: [
        { index: 0, kind: 'text', answers: [{ q: 0, pick: 'L003' }] },
        { index: 1, kind: 'judgment', answers: [{ q: 0, pick: 'L004', heat: { L004: 0.8, L003: 0.1 }, window: 1, window_p: { 0: 0.2, 1: 0.8 } }] },
      ],
    }
    const h = heatFor(run, 0)
    assert.equal(h.source, 'jev')
    assert.equal(h.lane, 1)
    assert.deepEqual(h.heat, { L004: 0.8, L003: 0.1, L001: 0.1, L002: 0.1 })
  })
  it("is the text models' votes when no Jev plays", () => {
    const run = { doc, lines, lanes: [
      { kind: 'text', answers: [{ q: 0, pick: 'L003' }] }, { kind: 'text', answers: [{ q: 0, pick: 'L003' }] },
      { kind: 'text', answers: [{ q: 0, pick: NONE }] }, { kind: 'text', answers: [{ q: 1, pick: 'L001' }] }] }
    assert.deepEqual(heatFor(run, 0), { heat: { L003: 1 }, source: 'text', lane: null, answer: null })
    assert.equal(heatFor({ doc, lanes: [] }, 0).source, null)
  })
  it('zooms around a line', () => {
    assert.deepEqual(around(lines, 'L003', 1).map((l) => l.id), ['L002', 'L003', 'L004'])
    assert.deepEqual(around(lines, 'L001', 2).map((l) => l.id), ['L001', 'L002', 'L003'])
    assert.deepEqual(around(lines, 'L999'), [])
  })
})

describe('scoring the visitor', () => {
  it('scores as the server does', () => {
    assert.equal(judgePick('L004', ['L004'], lines), 'right')
    assert.equal(judgePick('L003', ['L004'], lines), 'near')
    assert.equal(judgePick('L005', ['L004'], lines), 'wrong') // next door, but another section
    assert.equal(isNear('L005', ['L004'], lines), false)
    assert.equal(judgePick(NONE, ['L004'], lines), 'missed')
    assert.equal(judgePick(NONE, [], lines), 'right')
    assert.equal(judgePick('L001', [], lines), 'wrong')
    assert.equal(judgePick('L001', null, lines), 'unscored')
  })
  it('walks the questions and adds up the ones played', () => {
    const questions = [
      { k: 0, revealed: true, scored: true, answer: ['L004'] },
      { k: 1, revealed: true, scored: true, answer: [] },
      { k: 2, revealed: false, scored: true, answer: null },
    ]
    assert.equal(nextQuestion(questions, {}), 0)
    assert.equal(nextQuestion(questions, { 0: { pick: 'L004' } }), 1)
    assert.equal(nextQuestion(questions, { 0: {}, 1: {}, 2: {} }), 2)
    const run = {
      lines, questions,
      lanes: [{ index: 0, label: 'jev', kind: 'judgment', marks: [
        { q: 0, verdict: 'right', points: 2 }, { q: 1, verdict: 'wrong', points: -1 }, { q: 2, verdict: 'right', points: 2 }] }],
    }
    const t = tallyOf(run, { 0: { pick: 'L003', ms: 4000 }, 1: { pick: NONE, ms: 2000 }, 2: { pick: 'L001', ms: 1 } })
    assert.equal(t.questions, 2)
    assert.deepEqual(t.you, { points: 3, right: 1, played: 2, ms: 3000 })
    assert.deepEqual(t.lanes, [{ index: 0, label: 'jev', kind: 'judgment', points: 1, right: 1, near: 0, wrong: 1 }])
    assert.equal(tallyOf(run, { 0: { skipped: true } }).you.played, 0)
    assert.deepEqual([4, 0, -2].map(signed), ['+4', '0', '−2'])
  })
})
