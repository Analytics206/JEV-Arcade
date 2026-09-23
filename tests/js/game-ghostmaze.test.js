// Ghost Maze's pure page logic (src/wikirace/static/games/ghostmaze.logic.js):
// the maze's geometry against the mockup's own numbers, reading a lane, the
// stick, and what an hour costs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  CELL,
  banner,
  bestScore,
  cellXY,
  exitsOf,
  fmtInt,
  fmtMoney,
  ghostBody,
  ghostPath,
  ghostPoints,
  ghostsEaten,
  hourCost,
  isFresh,
  isOpen,
  laneMood,
  laneWorld,
  mazeLabel,
  mazeSize,
  meanLag,
  pacHalves,
  parseLayout,
  pupil,
  recentlyEaten,
  scaredMouth,
  screenText,
  soloFinale,
  startView,
  stepOf,
  stickArms,
  stickLabel,
  thinkingText,
  ticksAnswered,
  wallRects,
  upOf,
  wedgePath,
  winnersOf,
  wordsRows,
} from '../../src/wikirace/static/games/ghostmaze.logic.js'

// The arcade layout, as games/data/ghostmaze.json has it.
const ARCADE = {
  id: 'arcade',
  name: 'Arcade',
  start: 'left',
  grid: [
    'o...........o',
    '.###.###.###.',
    '.............',
    '.#.###.###.#.',
    '.#...NBC...#.',
    '.#.#.###.#.#.',
    '......P......',
    '.###.###.###.',
    'o...........o',
  ],
}
const L = parseLayout(ARCADE)
const at = (c, r) => r * L.cols + c

describe('the maze', () => {
  it('reads a layout', () => {
    assert.equal(L.cols, 13)
    assert.equal(L.rows, 9)
    assert.equal(L.player, at(6, 6))
    assert.deepEqual(L.homes, { Pinky: at(5, 4), Blinky: at(6, 4), Clyde: at(7, 4) })
    assert.deepEqual(L.power, [at(0, 0), at(12, 0), at(0, 8), at(12, 8)])
    assert.equal(L.pellets.length, 74)
    assert.equal(L.walls.size, 13 * 9 - 74 - 4 - 4)
  })
  it('puts tiles where the mockup drew them (480 by 336, tiles of 36)', () => {
    assert.deepEqual(mazeSize(L), { w: 480, h: 336 })
    assert.deepEqual(cellXY(at(6, 4), L.cols), [240, 168])
    assert.deepEqual(cellXY(at(0, 0), L.cols), [24, 24])
    assert.deepEqual(cellXY(at(12, 8), L.cols), [456, 312])
    assert.equal(CELL, 36)
  })
  it('knows the open ways', () => {
    assert.deepEqual(exitsOf(L, at(6, 6)), ['left', 'right'])
    assert.deepEqual(exitsOf(L, at(0, 0)), ['down', 'right'])
    assert.equal(isOpen(L, at(0, 0), 'up'), false) // off the grid is a wall
    assert.equal(stepOf(L, at(4, 6), 'up'), at(4, 5))
    assert.equal(stepOf(L, at(5, 6), 'up'), null)
  })
  it('draws the walls as the mockup’s thirteen blocks', () => {
    const rects = wallRects(L)
    assert.equal(rects.length, 13)
    assert.deepEqual(rects[0], { x: 47, y: 47, w: 98, h: 26 }) // the top-left block
    assert.ok(rects.some((r) => r.x === 47 && r.y === 119 && r.w === 26 && r.h === 98)) // the left pillar
    assert.ok(rects.some((r) => r.x === 119 && r.y === 191 && r.w === 26 && r.h === 26)) // a single tile
  })
  it('draws a block that is not a rectangle row by row', () => {
    const odd = parseLayout({ grid: ['P....', '.##..', '.#BNC', '.....'] })
    const rects = wallRects(odd)
    assert.equal(rects.length, 2)
    assert.deepEqual(rects.map((r) => r.w), [2 * CELL - 10, CELL - 10])
  })
})

describe('sprites', () => {
  it('draws the player as the mockup’s wedge', () => {
    assert.equal(wedgePath(240, 168, 13, 'left'), 'M240 168 L228.74 161.5 A13 13 0 1 1 228.74 174.5 Z')
    assert.equal(wedgePath(0, 0, 13, 'right'), 'M0 0 L11.26 6.5 A13 13 0 1 1 11.26 -6.5 Z')
    assert.equal(wedgePath(0, 0, 13, 'up'), 'M0 0 L6.5 -11.26 A13 13 0 1 1 -6.5 -11.26 Z')
    assert.match(wedgePath(0, 0, 13, 'down', 0), /^M-13 0 A13 13 0 1 1 13 0 A13 13 0 1 1 -13 0 Z$/)
  })
  it('draws a ghost as the mockup’s', () => {
    assert.equal(ghostPath(348, 168), 'M336 180 V168 A12 12 0 0 1 360 168 V180 L356 176 L352 180 L348 176 L344 180 L340 176 Z')
    assert.match(scaredMouth(0, 0), /^M-7\.2 4\.2 L-3\.6 1\.7 L0 4\.2 L3\.6 1\.7 L7\.2 4\.2$/)
    assert.deepEqual(pupil('left'), [-1.5, 0])
    assert.deepEqual(pupil(null), [0, 0])
  })
  it('ripples a ghost’s skirt over two frames, inside its box', () => {
    const a = ghostBody(0, 0, 12, 0)
    const b = ghostBody(0, 0, 12, 1)
    assert.notEqual(a, b)
    for (const d of [a, b]) {
      assert.match(d, /^M-12 [\d.]+ V0 A12 12 0 0 1 12 0 V[\d.]+( L-?[\d.]+ [\d.]+){12} Z$/)
      const ys = [...d.matchAll(/L(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]))
      assert.ok(ys.every((y) => y > 0 && y <= 12))
    }
    assert.match(a, /^M-12 12 V0/) // frame 0 stands on its hem's edges
    assert.match(b, /^M-12 8\.25 V0/) // frame 1 has them lifted, half a wave on
  })
  it('splits the player into two halves that chomp', () => {
    assert.deepEqual(pacHalves(13), { top: 'M-13 0 A13 13 0 0 1 13 0 Z', bottom: 'M-13 0 A13 13 0 0 0 13 0 Z' })
  })
})

describe('what just happened', () => {
  it('reads a ghost’s points off the score’s jump', () => {
    assert.equal(ghostPoints(200), 200)
    assert.equal(ghostPoints(210), 200) // a pellet on the same tick
    assert.equal(ghostPoints(410), 400)
    assert.equal(ghostPoints(800), 800)
    assert.equal(ghostPoints(10), null)
    assert.equal(ghostPoints(NaN), null)
  })
  it('finds the ghosts eaten between two views', () => {
    const before = [[1, 'n', 0, 'up'], [2, 'f', 0, 'left'], [3, 'f', 0, null]]
    const after = [[1, 'n', 0, 'up'], [9, 'e', 1, null], [4, 'f', 0, 'down']]
    assert.deepEqual(ghostsEaten(before, after), ['Pinky'])
    assert.deepEqual(ghostsEaten(after, after), [])
    assert.deepEqual(ghostsEaten(null, after), [])
  })
  it('keeps the last few tiles eaten, power pellets marked', () => {
    assert.deepEqual(recentlyEaten(L, [at(1, 0), at(0, 0), at(2, 0)], 2), [{ cell: at(0, 0), power: true }, { cell: at(2, 0), power: false }])
    assert.deepEqual(recentlyEaten(L, undefined), [])
  })
  it('names each lane’s player as the arcade does', () => {
    assert.equal(upOf(0), '1UP')
    assert.equal(upOf(3), '4UP')
  })
  it('writes READY!, GAME OVER and the rest over the maze', () => {
    assert.equal(screenText(lane()), null)
    assert.equal(screenText(lane(), true).text, 'READY!')
    assert.equal(screenText(lane({ tick: 0 })).text, 'READY!')
    assert.deepEqual(screenText(lane({ pause: 6, caught_at: 38, lives: 2 })), { text: 'READY!', sub: 'caught on tick 38 · 2 lives left', tone: 'ready' })
    assert.deepEqual(screenText(lane({ ended: 'caught', caught_at: 90 })), { text: 'GAME OVER', sub: 'caught on tick 90', tone: 'err' })
    assert.equal(screenText(lane({ ended: 'cleared' })).text, 'CLEARED!')
    assert.equal(screenText(lane({ ended: 'time', lives: 1 })).sub, '1 life left')
  })
})

describe('who won', () => {
  const run = (...lanes) => ({ lanes: lanes.map((l, index) => ({ index, label: `p${index + 1}`, status: 'done', ...l })) })
  it('is the most points among the lanes that played their game out', () => {
    assert.deepEqual(winnersOf(run({ score: 1670 }, { score: 1510 })), [0])
    assert.deepEqual(winnersOf(run({ score: 900 }, { score: 2100, status: 'error' }, { score: 1200 })), [2])
  })
  it('shares a tie, and names nobody alone or when nobody finished', () => {
    assert.deepEqual(winnersOf(run({ score: 800 }, { score: 800 }, { score: 20 })), [0, 1])
    assert.deepEqual(winnersOf(run({ score: 800 })), [])
    assert.deepEqual(winnersOf(run({ score: 800, status: 'error' }, { score: 10, status: 'stopped' })), [])
    assert.deepEqual(winnersOf({}), [])
  })
  it('ends a round of one with its own words', () => {
    assert.deepEqual(soloFinale(run({ score: 1670, ended: 'caught' })), { headline: 'GAME OVER', sub: 'p1 · 1,670 points' })
    assert.equal(soloFinale(run({ score: 2310, ended: 'cleared' })).headline, 'CLEARED!')
    assert.equal(soloFinale(run({ score: 1 }, { score: 2 })), null)
  })
})

const lane = (over = {}) => ({
  index: 0,
  label: 'jev-1.13.0',
  kind: 'judgment',
  status: 'playing',
  tick: 40,
  player: [at(4, 6), 'left', 0],
  ghosts: [
    [at(6, 4), 'n', 0, 'down'],
    [at(5, 4), 'f', 1, null],
    [at(7, 4), 'e', 2, null],
  ],
  score: 120,
  lives: 3,
  left: 60,
  fright: 0,
  pause: 0,
  caught_at: null,
  threat: null,
  ended: null,
  eaten: [at(5, 6), at(4, 6)],
  answered: 30,
  lag: 15,
  calls: 32,
  tokens_in: 9600,
  tokens_out: 0,
  cost: 9600 * 0.042e-6,
  cost_estimated: true,
  cost_unknown: false,
  think_ms: 3200,
  ...over,
})

describe('a lane', () => {
  it('reads the streamed world into names', () => {
    const w = laneWorld(lane())
    assert.deepEqual(w.player, { cell: at(4, 6), heading: 'left', gen: 0 })
    assert.deepEqual(w.ghosts.map((g) => [g.name, g.mode, g.gen]), [['Blinky', 'n', 0], ['Pinky', 'f', 1], ['Clyde', 'e', 2]])
    assert.ok(w.eaten.has(at(5, 6)) && w.eaten.size === 2)
    assert.equal(laneWorld({}).score, 0)
  })
  it('says how the lane is doing, with a glyph and a tone', () => {
    assert.deepEqual(laneMood(lane()), { text: '● alive', tone: 'ok' })
    assert.deepEqual(laneMood(lane({ threat: 'Blinky' })), { text: '! alive · Blinky close', tone: 'warn' })
    assert.deepEqual(laneMood(lane({ fright: 30 })), { text: '◆ power · ghosts frightened', tone: 'cy' })
    assert.deepEqual(laneMood(lane({ pause: 5, lives: 1, caught_at: 38 })), { text: '✕ caught · 1 life left', tone: 'err' })
    assert.equal(laneMood(lane({ ended: 'cleared', status: 'done' })).tone, 'ok')
    assert.equal(laneMood(lane({ ended: 'caught', status: 'done' })).text, '✕ out of lives')
    assert.equal(laneMood(lane({ status: 'error' })), null) // the lane's own badge says it
  })
  it('flashes a catch, and says how a game ended', () => {
    assert.equal(banner(lane()), null)
    assert.deepEqual(banner(lane({ pause: 8, caught_at: 412 })), { text: 'CAUGHT · tick 412', tone: 'err' })
    assert.deepEqual(banner(lane({ ended: 'cleared' })), { text: 'CLEARED', tone: 'ok' })
    assert.equal(banner(lane({ ended: 'time' })).text, 'TIME')
  })
  it('counts the ticks answered and how late answers land', () => {
    assert.deepEqual(ticksAnswered(lane()), { answered: 30, ticks: 40, share: 0.75, tone: 'warn' })
    assert.equal(ticksAnswered(lane({ answered: 40 })).tone, 'ok')
    assert.equal(ticksAnswered(lane({ answered: 4 })).tone, 'err')
    assert.equal(meanLag(lane()), 0.5)
    assert.ok(Number.isNaN(meanLag(lane({ answered: 0 }))))
  })
  it('says how long a call has been out, by the world’s clock', () => {
    assert.equal(thinkingText(lane({ tick: 412, asking: 371 }), 100), 'thinking · 4.1 s on tick 371')
    assert.equal(thinkingText(lane({ tick: 412, asking: 411 }), 100, 3), null) // Jev, inside a tick or two
    assert.equal(thinkingText(lane({ tick: 12, asking: 12 }), 100), 'thinking on tick 12')
    assert.equal(thinkingText(lane({ asking: null }), 100), null)
  })
  it('keeps a decision on the maze while it is fresh', () => {
    assert.equal(isFresh(lane({ last: { tick: 38, at: 39 } })), true)
    assert.equal(isFresh(lane({ last: { tick: 20, at: 30 } })), false)
    assert.equal(isFresh(lane()), false)
  })
  it('lays the words out a row each', () => {
    const words = {
      tick: 40,
      state: {
        you: 'at a junction, heading left',
        ghosts: ['Blinky: dangerous, close, 3 tiles, reached by going right', 'Pinky: far away'],
        pellets: '4 pellets to the left',
        power: 'off; none left',
        exits: 'open: left, up, right; down is a wall',
      },
    }
    assert.deepEqual(wordsRows(words).map(([k]) => k), ['you', 'Blinky', 'Pinky', 'pellets', 'power', 'exits'])
    assert.equal(wordsRows(words)[1][1], 'dangerous, close, 3 tiles, reached by going right')
    assert.deepEqual(wordsRows(null), [])
  })
  it('describes its maze for a screen reader', () => {
    const text = mazeLabel(lane({ threat: 'Blinky' }), L)
    assert.match(text, /^jev-1\.13\.0's maze, the player heading left, score 120, 3 lives left, 60 pellets left, Blinky is close\.$/)
    assert.match(mazeLabel(lane({ player: [at(0, 6), 'left', 0], pause: 3, caught_at: 30 }), L), /standing against a wall.*caught · tick 30/)
  })
  it('starts a layout for the setup’s preview', () => {
    const v = laneWorld({ index: 0, ...startView(L) })
    assert.equal(v.player.cell, L.player)
    assert.equal(v.player.heading, 'left')
    assert.deepEqual(v.ghosts.map((g) => g.cell), [L.homes.Blinky, L.homes.Pinky, L.homes.Clyde])
  })
})

describe('the stick', () => {
  const jev = { tick: 40, at: 40, offered: ['left', 'up', 'right'], dir: 'left', p: { left: 0.86, up: 0.11, right: 0.03 } }
  it('sizes an arm by its probability, and a wall is not offered', () => {
    const arms = stickArms(jev)
    const by = Object.fromEntries(arms.map((a) => [a.way, a]))
    assert.equal(by.down.offered, false)
    assert.equal(by.down.p, 0)
    assert.ok(by.left.chosen && by.left.width > by.up.width && by.up.width > by.right.width)
    assert.ok(by.left.len > by.up.len && by.left.opacity > by.right.opacity)
    assert.equal(by.left.width, 10.6)
  })
  it('gives a text model one arm, the way it named', () => {
    const arms = stickArms({ offered: ['left', 'right'], dir: 'right' })
    assert.deepEqual(arms.filter((a) => a.p).map((a) => a.way), ['right'])
  })
  it('says what it shows', () => {
    assert.equal(stickLabel({ label: 'jev', last: jev }), "jev's stick: left 0.86, up 0.11, right 0.03; down is a wall and is not offered.")
    assert.equal(
      stickLabel({ label: 'gpt', last: { offered: ['left', 'right'], dir: null, foul: 'into a wall' } }),
      "gpt's stick: a foul (into a wall); up and down are walls and are not offered.",
    )
    assert.match(stickLabel({ label: 'x' }), /no decision yet/)
  })
})

describe('what an hour costs', () => {
  it('prices Jev at ten decisions a second', () => {
    const c = hourCost(lane({ calls: 100, tokens_in: 30_000, think_ms: 9000, cost: 30_000 * 0.042e-6 }), 100)
    assert.equal(c.tokens, 300)
    assert.equal(c.perHour, 36_000) // one a tick at most: it answers faster than the clock
    assert.ok(Math.abs(c.dollars - 0.4536) < 1e-9)
    assert.equal(fmtMoney(c.dollars), '$0.45')
  })
  it('prices a slow text model at its own pace, and at ten a second', () => {
    const c = hourCost(lane({ kind: 'text', calls: 10, tokens_in: 8000, tokens_out: 50, think_ms: 38_000, cost: 0.03 }), 100)
    assert.equal(Math.round(c.perHour), 947)
    assert.ok(Math.abs(c.dollars - 0.003 * (3_600_000 / 3800)) < 1e-9)
    assert.ok(Math.abs(c.atTen - 108) < 1e-9)
  })
  it('knows when it does not know', () => {
    assert.equal(hourCost(lane({ calls: 4, cost: 0, cost_unknown: true })).dollars, null)
    assert.equal(hourCost(lane({ calls: 0 })).dollars, null)
    assert.equal(fmtMoney(null), '—')
    assert.equal(fmtMoney(0.0042), '$0.0042')
    assert.equal(fmtMoney(1234.4), '$1,234')
    assert.equal(fmtInt(36000), '36,000')
  })
  it('finds a run’s best score', () => {
    assert.equal(bestScore({ lanes: [{ score: 610 }, { score: 1840 }, { score: null }] }), 1840)
    assert.equal(bestScore({}), 0)
  })
})
