// The Big Sort's pure page logic (src/wikirace/static/games/bigsort.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOUL,
  UNSORTED,
  cellAt,
  cellRect,
  eta,
  fmtN,
  fmtSpan,
  fmtUsd,
  heat,
  labelArrays,
  stepCursor,
  tally,
  wallGrid,
  wallOrder,
  wallSummary,
} from '../../src/wikirace/static/games/bigsort.logic.js'

describe('the wall', () => {
  it('fits any count into a near-square grid within the width', () => {
    for (const n of [20, 100, 250, 500, 1000, 1999, 2000]) {
      const g = wallGrid(n, 420)
      assert.ok(g.cols * g.rows >= n && (g.rows - 1) * g.cols < n, `${n} fits with no spare row`)
      assert.ok(Math.abs(g.cols - g.rows) <= 1, `${n} is near square`)
      assert.ok(g.width <= 420 && g.cell >= 1, `${n} fits the width`)
      assert.equal(g.width, g.cols * g.step - g.gap)
    }
    const g = wallGrid(500, 420)
    assert.deepEqual([g.cols, g.rows, g.step, g.cell, g.gap], [23, 22, 18, 17, 1])
    assert.equal(wallGrid(20, 420).step, 30) // few articles: big cells, not giant ones
    assert.equal(wallGrid(2000, 60).gap, 0) // too small for gaps: the gap goes first
  })
  it('finds the cell under a point, and the point of a cell', () => {
    const g = wallGrid(500, 420)
    for (const i of [0, 1, 22, 23, 250, 499]) {
      const r = cellRect(i, g)
      assert.equal(cellAt(r.x + r.w / 2, r.y + r.h / 2, g), i)
      assert.equal(cellAt(r.x, r.y, g), i)
    }
    assert.equal(cellAt(-1, 3, g), -1)
    assert.equal(cellAt(g.cols * g.step + 1, 0, g), -1)
    // The last row is short: past its last cell is off the wall.
    const last = cellRect(499, g)
    assert.equal(cellAt(last.x + g.step + 1, last.y + 1, g), -1)
  })
  it('moves a cursor with the arrow keys, never off the wall', () => {
    assert.equal(stepCursor(-1, 'ArrowRight', 23, 500), 1)
    assert.equal(stepCursor(5, 'ArrowDown', 23, 500), 28)
    assert.equal(stepCursor(5, 'ArrowUp', 23, 500), 0)
    assert.equal(stepCursor(490, 'ArrowDown', 23, 500), 499)
    assert.equal(stepCursor(40, 'Home', 23, 500), 0)
    assert.equal(stepCursor(40, 'End', 23, 500), 499)
    assert.equal(stepCursor(40, 'a', 23, 500), null)
  })
})

describe('reading the answers', () => {
  const labels = [[0, 2, 0.91], [3, 0, 0.55], [1, FOUL, null, 'miscellany'], [2, 2, 0.7], [9, 1, 0.8]]
  it('turns pushes into arrays by article, fouls and all', () => {
    const { topic, p, said } = labelArrays(labels, 5)
    assert.deepEqual([...topic], [2, FOUL, 2, 0, UNSORTED])
    assert.ok(Math.abs(p[0] - 0.91) < 1e-6 && Number.isNaN(p[1]) && Number.isNaN(p[4]))
    assert.equal(said.get(1), 'miscellany')
  })
  it('tallies topics, fouls and what has not landed', () => {
    const { topic } = labelArrays(labels, 5)
    assert.deepEqual(tally(topic, 3), { counts: [1, 0, 2], fouls: 1, unsorted: 1, sorted: 3 })
  })
  it('orders a wall as answers land, or grouped by topic then fouls then the rest', () => {
    const { topic } = labelArrays(labels, 5)
    assert.deepEqual(wallOrder(topic, 'landed'), [0, 1, 2, 3, 4])
    assert.deepEqual(wallOrder(topic, 'topic'), [3, 0, 2, 1, 4])
  })
  it('says what a wall shows', () => {
    const topics = [{ name: 'science & tech' }, { name: 'people' }, { name: 'places' }]
    const { topic } = labelArrays(labels, 5)
    assert.equal(wallSummary('Jev', topics, tally(topic, 3), 5), "Jev's wall: 3 of 5 articles sorted: 2 places, 1 science & tech, 1 fouls.")
  })
})

describe('numbers as the page writes them', () => {
  it('spans, costs, counts', () => {
    assert.equal(fmtSpan(41.2), '41 s')
    assert.equal(fmtSpan(130), '2 m 10 s')
    assert.equal(fmtSpan(120), '2 m')
    assert.equal(fmtSpan(119.7), '2 m')
    assert.equal(fmtSpan(7800), '2 h 10 m')
    assert.equal(fmtSpan(Infinity), '—')
    assert.equal(fmtUsd(0.00421), '$0.0042')
    assert.equal(fmtUsd(0.114), '$0.114')
    assert.equal(fmtUsd(12.4), '$12.40')
    assert.equal(fmtN(10000), '10,000')
  })
  it('estimates the time to go from the rate so far', () => {
    assert.equal(eta(312, 10000, 1.2), (10000 - 312) / 1.2)
    assert.equal(eta(10, 10, 0), 0)
    assert.equal(eta(0, 10, 0), Infinity)
  })
  it('shades a confusion cell by its share of its row', () => {
    assert.equal(heat(0, 10), 0)
    assert.equal(heat(10, 10), 1)
    assert.equal(heat(1, 100), 0.12)
  })
})
