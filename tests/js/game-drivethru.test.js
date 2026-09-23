// Drive-Thru's pure half (src/wikirace/static/games/drivethru.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  altsText,
  callTokens,
  callsOf,
  goldText,
  latestCar,
  leadersOf,
  lineMarks,
  queueLayout,
  receiptRows,
  sparkPath,
  splitChange,
  streakOf,
  windowCars,
  windowCounts,
} from '../../src/wikirace/static/games/drivethru.logic.js'

const run = { mods: { no_pickles: 'no pickles', no_ice: 'no ice', extra_cheese: 'extra cheese' } }
const conf = (qty, size = null, mods = {}, split = null) => ({ qty, size, mods, split })
/** Jev's ticket for car 14 of the mockup: two cheeseburgers (one no pickles), large fries, a medium Coke it was unsure of. */
const jevTicket = {
  car: 14, status: 'served', off_menu: false, clarify: null, fouls: [], readback: "That's a medium Coke?",
  lines: [
    { item: 'cheeseburger', qty: 1, size: null, mods: ['no_pickles'], conf: conf(0.97, null, { no_pickles: 0.93 }, 0.92) },
    { item: 'cheeseburger', qty: 1, size: null, mods: [], conf: conf(0.97, null, { no_pickles: 0.93 }, 0.92) },
    { item: 'fries', qty: 1, size: 'large', mods: [], conf: conf(0.97, 0.95) },
    { item: 'cola', qty: 1, size: 'medium', mods: [], conf: conf(0.96, 0.84) },
  ],
  least: { kind: 'size', item: 'cola', value: 'medium', conf: 0.84, alts: [{ option: 'medium', p: 0.84 }, { option: 'large', p: 0.12 }, { option: 'small', p: 0.04 }] },
}

describe('the speaker', () => {
  it('marks the change in what the customer said', () => {
    assert.deepEqual(splitChange('Two fries. Actually, make that one.', 'Actually, make that one.'), [
      { text: 'Two fries. ', change: false },
      { text: 'Actually, make that one.', change: true },
    ])
    assert.deepEqual(splitChange('Just a shake.', null), [{ text: 'Just a shake.', change: false }])
    assert.deepEqual(splitChange('Just a shake.', 'not in it'), [{ text: 'Just a shake.', change: false }])
  })
})

describe('the ticket', () => {
  it('prints a receipt row per item, its parts beneath, the least sure marked', () => {
    const rows = receiptRows(jevTicket, run)
    assert.deepEqual(rows.map((r) => [r.kind, r.text]), [
      ['item', '2 × cheeseburger'],
      ['sub', '#1 no pickles'],
      ['sub', '#2 as it comes'],
      ['item', '1 × fries · large'],
      ['item', '1 × cola · medium'],
    ])
    assert.deepEqual(rows.filter((r) => r.least).map((r) => r.text), ['1 × cola · medium'])
    assert.equal(rows[4].conf, 0.84)
    assert.equal(rows[1].conf, 0.92)
    assert.equal(altsText(jevTicket.least), 'large 0.12 · small 0.04')
    assert.equal(altsText(jevTicket.least, true), 'large 0.12 · small 0.04: changed mid-order')
    assert.equal(altsText({ kind: 'qty', alts: [{ option: '0', p: 0.86 }, { option: '1', p: 0.11 }, { option: '3', p: 0.001 }] }),
      'one 0.11')
  })
  it('keeps a row for an item it was least sure it did not hear, and for the off-menu ask', () => {
    const none = receiptRows({ ...jevTicket, least: { kind: 'qty', item: 'milkshake', value: 0, conf: 0.55, alts: [] } }, run)
    assert.deepEqual(none.at(-1), { kind: 'none', text: '0 × milkshake', item: 'milkshake', conf: 0.55, least: true })
    const off = receiptRows({ ...jevTicket, off_menu: true, least: { kind: 'off_menu', value: true, conf: 0.7 } }, run)
    assert.deepEqual(off.at(-1), { kind: 'clarify', text: 'asks about something not on the menu', conf: 0.7, least: true })
  })
  it("prints a text window's fouls and its clarification, with no confidences", () => {
    const rows = receiptRows({
      status: 'served', off_menu: true, clarify: 'onion rings', readback: null,
      lines: [{ item: 'fries', qty: 2, size: 'large', mods: [] }, { item: 'cola', qty: 3, size: 'small', mods: ['no_ice'] }],
      fouls: [{ line: 'ITEM: veggie burger | QTY: 1', why: '“veggie burger” is not on the menu' }],
    }, run)
    assert.deepEqual(rows.map((r) => [r.kind, r.text, r.conf]), [
      ['item', '2 × fries · large', null],
      ['item', '3 × cola · small', null],
      ['sub', 'no ice', null],
      ['clarify', 'asks about: onion rings', null],
      ['foul', 'ITEM: veggie burger | QTY: 1', null],
    ])
    assert.deepEqual(receiptRows({ status: 'dropped' }, run), [])
  })
  it('writes the calls code makes', () => {
    assert.deepEqual(callsOf(jevTicket), [
      'add_item(item="cheeseburger", qty=1, mods=["no_pickles"])',
      'add_item(item="cheeseburger", qty=1)',
      'add_item(item="fries", qty=1, size="large")',
      'add_item(item="cola", qty=1, size="medium")',
      'read_back("That\'s a medium Coke?")',
    ])
    assert.deepEqual(callsOf({ status: 'served', lines: [], off_menu: true, clarify: 'coffee', fouls: [{ why: 'bad' }] }),
      ['ask_about_off_menu(what="coffee")', '# foul: bad'])
    assert.deepEqual(callsOf({ status: 'dropped' }), ['# drove off before ordering'])
    assert.deepEqual(callsOf({ status: 'served', lines: [], fouls: [] }), ['# nothing rung up'])
  })
  it('checks its lines against the gold ticket, alike lines merged', () => {
    const gold = { lines: [{ item: 'burger', qty: 2, size: null, mods: [] }, { item: 'fries', qty: 1, size: 'large', mods: [] }], off_menu: 'coffee' }
    assert.deepEqual(lineMarks([{ item: 'burger', qty: 1, size: null, mods: [] }, { item: 'burger', qty: 1, size: null, mods: [] },
      { item: 'fries', qty: 1, size: 'small', mods: [] }], gold), [true, true, false])
    assert.equal(goldText(gold, run), '2 × burger · 1 × large fries · asks: coffee')
    assert.equal(goldText({ lines: jevTicket.lines, off_menu: null }, run),
      '2 × cheeseburger (1 no pickles) · 1 × large fries · 1 × medium cola')
  })
})

describe('a window', () => {
  const cars = [0, 1, 2, 3, 4, 5].map((i) => ({ i }))
  const lane = {
    busy: 3,
    tickets: [
      { car: 0, status: 'served', exact: true },
      { car: 1, status: 'served', exact: false },
      { car: 2, status: 'dropped' },
    ],
  }
  it('sees every arrived car as served, exact, drove off, at the window or waiting', () => {
    const s = windowCars(cars, lane)
    assert.deepEqual(s.map((c) => c.status), ['exact', 'served', 'dropped', 'busy', 'waiting', 'waiting'])
    assert.deepEqual(windowCounts(s), { served: 2, exact: 1, waiting: 3, dropped: 1 })
  })
  it('draws the car at the window and the line behind it, and counts what does not fit', () => {
    const s = windowCars(cars, lane)
    const L = queueLayout(s, { width: 380 })
    assert.equal(L.atWindow.i, 3)
    assert.ok(L.atWindow.x + L.car <= L.window.x)
    assert.deepEqual(L.waiting.map((w) => w.i), [4, 5])
    assert.ok(L.waiting[0].x > L.waiting[1].x && L.waiting[1].x >= 0)
    const long = windowCars(Array.from({ length: 30 }, (_, i) => ({ i })), { tickets: [] })
    const LL = queueLayout(long, { width: 380 })
    assert.equal(LL.atWindow, null)
    assert.equal(LL.waiting.length + LL.more, 30)
    assert.ok(LL.waiting.every((w) => w.x >= 0))
  })
  it('follows the newest car any window has taken', () => {
    assert.equal(latestCar({ cars, lanes: [lane, { tickets: [{ car: 4 }] }] }), 4)
    assert.equal(latestCar({ cars, lanes: [{ tickets: [] }] }), 5)
    assert.equal(latestCar({ cars: [], lanes: [] }), null)
  })
})

describe('what the page lights up', () => {
  it('colours a call by its parts, and joined they are the line', () => {
    const line = 'add_item(item="cheeseburger", qty=1, mods=["no_pickles"])'
    const toks = callTokens(line)
    assert.equal(toks.map((t) => t.t).join(''), line)
    assert.deepEqual(toks.filter((t) => t.k === 'fn').map((t) => t.t), ['add_item'])
    assert.deepEqual(toks.filter((t) => t.k === 'key').map((t) => t.t), ['item', 'qty', 'mods'])
    assert.deepEqual(toks.filter((t) => t.k === 'str').map((t) => t.t), ['"cheeseburger"', '"no_pickles"'])
    assert.deepEqual(toks.filter((t) => t.k === 'num').map((t) => t.t), ['1'])
    const rb = `read_back("That's a \\"medium\\" Coke?")`
    assert.equal(callTokens(rb).map((t) => t.t).join(''), rb)
    assert.deepEqual(callTokens('# foul: bad'), [{ t: '# foul: bad', k: 'comment' }])
    assert.deepEqual(callTokens(''), [])
  })
  it('names the leaders by points, below nought too, all of them on a tie', () => {
    assert.deepEqual(leadersOf({ lanes: [{ index: 0, score: 4 }, { index: 1, score: 9 }, { index: 2, score: 9 }] }), [1, 2])
    assert.deepEqual(leadersOf({ lanes: [{ index: 0, score: -3 }, { index: 1, score: -1 }] }), [1])
    assert.deepEqual(leadersOf({ lanes: [{ index: 0 }, { index: 1, score: 0 }] }), [0, 1])
    assert.deepEqual(leadersOf({ lanes: [] }), [])
  })
  it('counts the exact orders in a row, cars still in line aside', () => {
    const s = (...st) => st.map((status, i) => ({ i, status, ticket: status === 'busy' || status === 'waiting' ? null : {} }))
    assert.equal(streakOf(s('exact', 'served', 'exact', 'exact', 'busy', 'waiting')), 2)
    assert.equal(streakOf(s('exact', 'dropped')), 0)
    assert.equal(streakOf(s('exact', 'exact', 'exact')), 3)
    assert.equal(streakOf([]), 0)
  })
  it('draws the line length as a sparkline, the longest at the top', () => {
    const { d, max } = sparkPath([0, 2, 4, 1], { width: 32, height: 12, pad: 1 })
    assert.equal(max, 4)
    assert.equal(d, 'M1 11 L11 6 L21 1 L31 8.5')
    assert.equal(sparkPath([3]).d, '')
    assert.equal(sparkPath([0, 0]).max, 1)
  })
})
