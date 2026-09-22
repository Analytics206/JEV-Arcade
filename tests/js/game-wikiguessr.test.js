// WikiGuessr's pure page logic (src/wikirace/static/games/wikiguessr.logic.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  GAP,
  MAP_PAD,
  STEP,
  TILE,
  articleRuns,
  claimText,
  claimsFor,
  continentLayout,
  focusContinent,
  inkOn,
  mapSummary,
  pinPath,
  ringRect,
  scoreboard,
  stackSegments,
  tileAlpha,
  verdict,
} from '../../src/wikirace/static/games/wikiguessr.logic.js'

const DATA = JSON.parse(readFileSync(new URL('../../src/wikirace/games/data/wikiguessr.json', import.meta.url), 'utf-8'))
const MAP = DATA.countries.map((c) => [c.name, c.code, c.continent, ...c.tile])

describe('the tile map', () => {
  it('puts every country of a continent on its own square, none overlapping', () => {
    for (const cont of DATA.continents) {
      const { tiles, width, height, cols, rows } = continentLayout(MAP, cont.name)
      assert.equal(tiles.length, DATA.countries.filter((c) => c.continent === cont.name).length)
      if (!tiles.length) {
        assert.equal(cont.name, 'Antarctica')
        assert.deepEqual([width, height], [0, 0])
        continue
      }
      assert.deepEqual([cols, rows], cont.grid)
      assert.equal(width, cols * STEP - GAP)
      assert.equal(height, rows * STEP - GAP)
      for (const [i, a] of tiles.entries()) {
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= width && a.y + a.h <= height, a.name)
        for (const b of tiles.slice(i + 1)) {
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
          assert.ok(apart, `${a.name} overlaps ${b.name}`)
        }
      }
    }
  })
  it('lays out Europe as drawn: France west of Germany, Greece in the south-east', () => {
    const { tiles } = continentLayout(MAP, 'Europe')
    const at = Object.fromEntries(tiles.map((t) => [t.code, t]))
    assert.equal(at.FR.x, 1 * STEP)
    assert.equal(at.FR.cx, STEP + TILE / 2)
    assert.ok(at.FR.x < at.DE.x && at.IS.y < at.GR.y && at.PT.x < at.GR.x)
  })
  it('lights tiles by their share of the likeliest, never below a hint', () => {
    assert.equal(tileAlpha(0, 0.7), 0)
    assert.equal(tileAlpha(0.7, 0.7), 1)
    assert.ok(tileAlpha(0.04, 0.71) > 0.3 && tileAlpha(0.04, 0.71) < tileAlpha(0.1, 0.71))
    assert.ok(tileAlpha(0.0001, 0.9) >= 0.12)
    assert.equal(inkOn(1), 'dark')
    assert.equal(inkOn(0.3), 'light')
  })
  it('nests the rings of lanes that claimed the same country, their tags apart and inside the padding', () => {
    const t = { x: 0, y: 0, w: TILE, h: TILE }
    const rings = [0, 1, 2, 3].map((k) => ringRect(t, k))
    for (let k = 1; k < 4; k++) {
      assert.ok(rings[k].x < rings[k - 1].x && rings[k].w > rings[k - 1].w)
      assert.ok(rings[k].tag.x >= rings[k - 1].tag.x + rings[k - 1].tag.w, 'tags do not overlap')
    }
    assert.ok(rings[3].tag.y >= -MAP_PAD && rings[3].x >= -MAP_PAD)
    assert.ok(rings[3].tag.x + rings[3].tag.w <= t.w + MAP_PAD)
  })
  it('draws a pin whose point is where it is asked to be', () => {
    const d = pinPath(100, 80, 6)
    assert.ok(d.startsWith('M100 80 ') && d.endsWith('Z'))
    assert.ok(!/NaN|undefined/.test(d))
  })
  it('says what it shows', () => {
    const { tiles } = continentLayout(MAP, 'Europe')
    assert.equal(mapSummary('Europe', tiles, { France: 0.71, Belgium: 0.1, Spain: 0.04 }, 2),
      "Tile map of Europe coloured by Jev's belief: France 0.71, Belgium 0.10.")
    assert.equal(mapSummary('Europe', tiles, {}), `Tile map of Europe: ${tiles.length} countries.`)
  })
})

describe('reading a round', () => {
  const run = {
    lanes: [
      { index: 0, label: 'jev', kind: 'judgment', claims: [{ round: 0, kind: 'jev', claim: ['Europe', 'France'], levels: [{ top: [{ option: 'Europe', p: 0.9 }] }, { paths: [{ path: ['Europe', 'France'], score: 0.8 }] }] }] },
      { index: 1, label: 'a', kind: 'text', claims: [{ round: 0, claim: ['Europe', 'France', 'Occitania'] }, { round: 1, claim: [] }] },
    ],
    rounds: [
      { n: 0, answer: { continent: 'Europe', country: 'France', region: 'Occitania' }, results: [{ lane: 0, points: 4, marks: ['right', 'right'] }, { lane: 1, points: 10, marks: ['right', 'right', 'right'] }] },
      { n: 1, answer: { continent: 'Asia' }, results: [{ lane: 0, points: -6, marks: ['wrong'] }, { lane: 1, points: 0, marks: [] }] },
      { n: 2, answer: null, results: null },
    ],
  }
  it('finds each lane’s claim for a round', () => {
    assert.deepEqual(Object.keys(claimsFor(run, 0)), ['0', '1'])
    assert.deepEqual(Object.keys(claimsFor(run, 1)), ['1'])
    assert.deepEqual(claimsFor(run, 2), {})
  })
  it('writes a claim the way a person reads it', () => {
    assert.equal(claimText([]), 'no claim')
    assert.equal(claimText(['Europe']), 'Europe')
    assert.equal(claimText(['Europe', 'France']), 'France')
    assert.equal(claimText(['Europe', 'France', 'Occitania']), 'Occitania, France')
  })
  it('opens the map on the answer, else on Jev’s best path', () => {
    assert.equal(focusContinent(run.rounds[0], claimsFor(run, 0), 0), 'Europe')
    assert.equal(focusContinent(run.rounds[1], {}, 0), 'Asia')
    assert.equal(focusContinent({ answer: null }, claimsFor(run, 0), 0), 'Europe')
    assert.equal(focusContinent({ answer: { continent: 'Antarctica' } }, {}, null), 'Europe')
  })
  it('keeps the score over rounds', () => {
    const board = scoreboard(run)
    assert.deepEqual(board.map((r) => [r.per, r.total, r.busts]), [[[4, -6, null], -2, 1], [[10, 0, null], 10, 0]])
  })
  it('reads a level against the threshold', () => {
    assert.equal(verdict({ confidence: 0.5 }, 0.5), 'claim')
    assert.equal(verdict({ confidence: 0.29 }, 0.5), 'stop')
    assert.equal(verdict(null, 0.5), 'stop')
  })
  it('stacks the continents and splits the article into words and hidden names', () => {
    const segs = stackSegments([{ option: 'Europe', p: 0.94 }, { option: 'Africa', p: 0.03 }])
    assert.deepEqual(segs.map((s) => [s.option, s.x, s.w]), [['Europe', 0, 94], ['Africa', 94, 3]])
    assert.deepEqual(articleRuns('███ is in ██.\nNext.'), [[{ hidden: 3 }, { text: ' is in ' }, { hidden: 2 }, { text: '.' }], [{ text: 'Next.' }]])
  })
})
