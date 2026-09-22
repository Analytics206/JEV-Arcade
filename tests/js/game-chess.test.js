// Legal Moves Only's pure page logic (src/wikirace/static/games/chess.logic.js):
// board geometry, the FEN's pieces, arrows, and the readings of a run.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SQUARES,
  arrow,
  arrowWidth,
  boardLabel,
  boardMarks,
  coordLabels,
  dots,
  fileRank,
  followPuzzle,
  glyph,
  isKnightJump,
  isLight,
  laneOn,
  matesOf,
  parseFen,
  sanOf,
  sessionRows,
  squareXY,
  stripOf,
  verdictOf,
} from '../../src/wikirace/static/games/chess.logic.js'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const BACK_RANK = '6k1/1bq2ppp/n7/8/8/3Q1N2/5PPP/4R1K1 w - - 0 1'

describe('the board', () => {
  it('puts every square where the drawing has it, from either side', () => {
    assert.deepEqual(squareXY('a1'), { x: 24, y: 428, cx: 54, cy: 458 })
    assert.deepEqual(squareXY('h8'), { x: 444, y: 8, cx: 474, cy: 38 })
    assert.equal(squareXY('e8').cx, 294)
    assert.deepEqual(squareXY('a1', true), squareXY('h8'))
    assert.deepEqual(squareXY('e4', true), squareXY('d5'))
    assert.equal(squareXY('i9'), null)
    assert.equal(fileRank('e4').join(), '4,3')
    assert.equal(SQUARES.length, 64)
    assert.equal(SQUARES[0], 'a8')
    assert.equal(SQUARES[63], 'h1')
  })
  it('colours a1 dark and h1 light', () => {
    assert.equal(isLight('a1'), false)
    assert.equal(isLight('h1'), true)
    assert.equal(isLight('a8'), true)
    assert.equal(SQUARES.filter(isLight).length, 32)
  })
  it('labels files below and ranks beside, flipped with the board', () => {
    const c = coordLabels()
    assert.deepEqual(c.files[0], { t: 'a', x: 54, y: 506 })
    assert.deepEqual(c.ranks[7], { t: '8', x: 12, y: 42 })
    assert.equal(coordLabels(true).files[0].x, 474)
  })
  it('reads the pieces of a FEN and whose move it is', () => {
    const start = parseFen(START)
    assert.equal(start.pieces.length, 32)
    assert.equal(start.turn, 'w')
    const p = parseFen(BACK_RANK)
    const at = Object.fromEntries(p.pieces.map((x) => [x.sq, x.piece]))
    assert.equal(at.g1, 'K')
    assert.equal(at.e1, 'R')
    assert.equal(at.c7, 'q')
    assert.equal(p.pieces.find((x) => x.sq === 'c7').color, 'b')
    assert.equal(parseFen('6k1/8/8/8/8/8/8/6K1 b - - 0 1').turn, 'b')
    assert.deepEqual(parseFen(''), { pieces: [], turn: 'w' })
  })
  it('draws pieces as text glyphs, never as emoji', () => {
    assert.equal(glyph('K'), '♚︎')
    assert.equal(glyph('p'), '♟︎')
    for (const c of 'KQRBNPkqrbnp') assert.ok(glyph(c).endsWith('︎'), c)
    assert.equal(glyph('x'), '')
  })
})

describe('arrows', () => {
  it('have a width that is the probability', () => {
    assert.equal(arrowWidth(0), 2)
    assert.equal(arrowWidth(1), 16)
    assert.equal(arrowWidth(0.5), 9)
    assert.ok(arrowWidth(0.71) > arrowWidth(0.12))
    assert.equal(arrowWidth(7), 16)
    assert.equal(arrowWidth(NaN), 2)
  })
  it('run from centre to just short of the centre, the head pointing along', () => {
    const a = arrow('e1', 'e8', 12)
    assert.equal(a.knight, false)
    assert.ok(a.d.startsWith('M294 458 L294 '))
    assert.deepEqual(a.tip, [294, 45])
    const head = a.head.split(' ').map(Number)
    assert.equal(head.length, 6)
    assert.equal(head[0], 294)
    assert.ok(head[3] > head[1] && head[5] === head[3], 'the base lies below the tip, level')
    assert.ok(arrow('e1', 'e8', 14).head !== arrow('e1', 'e8', 2).head, 'the head grows with the width')
  })
  it('bend for a knight, the long leg first', () => {
    assert.ok(isKnightJump('f3', 'g5'))
    assert.ok(!isKnightJump('f3', 'f5'))
    const a = arrow('f3', 'g5', 4)
    assert.equal(a.knight, true)
    assert.ok(a.d.includes('L354 218'), a.d)
    assert.equal((a.d.match(/L/g) ?? []).length, 2)
    const b = arrow('g1', 'e2', 4)
    assert.ok(b.d.includes('L294 458'), b.d)
  })
  it('refuse nonsense', () => {
    assert.equal(arrow('e1', 'e1', 4), null)
    assert.equal(arrow('e1', 'z9', 4), null)
  })
})

/* A run as the server streams it: Jev done with two puzzles, a text model on
 * its second with a foul so far. */
const run = {
  status: 'running',
  puzzles: [
    { i: 0, fen: BACK_RANK, side: 'white', theme: 'back-rank mate', difficulty: 1, legal: 45 },
    { i: 1, fen: '6k1/Q7/5K2/8/8/8/8/8 w - - 0 1', side: 'white', theme: 'king and queen mate', difficulty: 1, legal: 27 },
    { i: 2, fen: '6k1/5ppp/8/8/Q3n3/8/6PP/6RK b - - 0 1', side: 'black', theme: 'smothered mate', difficulty: 2, legal: 16 },
  ],
  key: null,
  lanes: [
    {
      index: 0, label: 'jev-1.13.0', kind: 'judgment', status: 'playing', at: 2, solved: 1, missed: 1, failed: 0, fouls: 0,
      puzzles: [
        {
          puzzle: 0, move: 'Re8#', uci: 'e1e8', from: 'e1', to: 'e8', verdict: 'solved', fouls: 0, ms: 200,
          top: [
            { san: 'Re8+', uci: 'e1e8', from: 'e1', to: 'e8', p: 0.71 },
            { san: 'Qxh7+', uci: 'd3h7', from: 'd3', to: 'h7', p: 0.12 },
            { san: 'Ng5', uci: 'f3g5', from: 'f3', to: 'g5', p: 0.07 },
          ],
        },
        { puzzle: 1, move: 'Qb8+', uci: 'a7b8', from: 'a7', to: 'b8', verdict: 'missed', fouls: 0, ms: 100, top: [] },
      ],
    },
    {
      index: 1, label: 'test/a', kind: 'text', status: 'playing', at: 1, solved: 1, missed: 0, failed: 0, fouls: 1,
      current: { puzzle: 1, attempts: [{ said: 'Qh8', foul: 'the queen on a7 cannot reach h8', from: 'a7', to: 'h8' }] },
      puzzles: [
        {
          puzzle: 0, move: 'Re8#', uci: 'e1e8', from: 'e1', to: 'e8', verdict: 'solved', fouls: 1, ms: 5000,
          attempts: [
            { said: 'Qxf7#', foul: 'the queen on d3 cannot reach f7', from: null, to: 'f7' },
            { said: 'Re8#', san: 'Re8#', uci: 'e1e8', from: 'e1', to: 'e8', reason: 'sealed in' },
          ],
        },
      ],
    },
    { index: 2, label: 'test/b', kind: 'text', status: 'error', at: 0, solved: 0, fouls: 0, puzzles: [] },
  ],
}

describe('reading a run', () => {
  it('marks each verdict with a glyph and a tone', () => {
    assert.deepEqual(verdictOf({ verdict: 'solved', fouls: 0 }), { mark: '✓', tone: 'ok', label: 'solved' })
    assert.equal(verdictOf({ verdict: 'solved', fouls: 2 }).label, 'solved on try 3')
    assert.equal(verdictOf({ verdict: 'missed' }).mark, '–')
    assert.equal(verdictOf({ verdict: 'failed' }).label, 'fouled out')
    assert.equal(verdictOf(null), null)
  })
  it('knows where each lane stands on each puzzle', () => {
    const [jev, text, gone] = run.lanes
    assert.equal(laneOn(jev, 0).state, 'done')
    assert.equal(laneOn(jev, 2).state, 'playing')
    assert.equal(laneOn(text, 1).state, 'playing')
    assert.equal(laneOn(text, 1).attempts.length, 1)
    assert.equal(laneOn(text, 2).state, 'waiting')
    assert.equal(laneOn(gone, 0).state, 'out')
  })
  it('follows the slowest live lane, and the last puzzle once all are over', () => {
    assert.equal(followPuzzle(run), 1)
    const over = { ...run, lanes: run.lanes.map((l) => ({ ...l, status: 'done' })) }
    assert.equal(followPuzzle(over), 2)
    assert.equal(followPuzzle({ puzzles: [], lanes: [] }), 0)
  })
  it('gives the strip a mark per lane per puzzle', () => {
    const s = stripOf(run)
    assert.equal(s.length, 3)
    assert.deepEqual(s[0].marks.map((m) => m.verdict?.tone ?? m.state), ['ok', 'warn', 'out'])
    assert.deepEqual(s[1].marks.map((m) => m.verdict?.tone ?? m.state), ['err', 'playing', 'out'])
  })
  it('totals the session: solved, fouls, time per puzzle', () => {
    const [jev, text] = sessionRows(run)
    assert.equal(jev.solved, 1)
    assert.equal(jev.played, 2)
    assert.equal(jev.perMove, 150)
    assert.equal(text.fouls, 1)
    assert.equal(text.perMove, 5000)
    assert.ok(Number.isNaN(sessionRows(run)[2].perMove))
  })
  it('writes # on a move once it is known to mate', () => {
    assert.equal(matesOf(run, 0).size, 0)
    const done = { ...run, key: [{ puzzle: 0, mates: [{ san: 'Re8#', uci: 'e1e8', from: 'e1', to: 'e8' }] }] }
    const m = matesOf(done, 0)
    assert.ok(m.has('e1e8'))
    assert.equal(sanOf('Re8+', 'e1e8', m), 'Re8#')
    assert.equal(sanOf('Qxh7+', 'd3h7', m), 'Qxh7+')
    assert.equal(sanOf(null, 'x', m), '—')
  })
})

describe('what the board draws', () => {
  it('Jev: its top moves as arrows, the likeliest widest and on top, its squares lit', () => {
    const jev = run.lanes[0]
    const b = boardMarks(jev, laneOn(jev, 0))
    assert.equal(b.arrows.length, 3)
    const last = b.arrows[b.arrows.length - 1]
    assert.equal(last.key, 'e1e8')
    assert.equal(last.width, arrowWidth(0.71))
    assert.ok(b.arrows[0].width < last.width)
    assert.deepEqual(b.lit, { from: 'e1', to: 'e8' })
    assert.equal(b.crosses.length, 0)
  })
  it('a text model: its move in its colour, a foul in red or as a cross', () => {
    const text = run.lanes[1]
    const done = boardMarks(text, laneOn(text, 0))
    assert.equal(done.crosses.length, 1)
    assert.equal(done.crosses[0].sq, 'f7')
    assert.deepEqual(done.arrows.map((a) => a.tone), ['lane'])
    assert.deepEqual(done.lit, { from: 'e1', to: 'e8' })
    const live = boardMarks(text, laneOn(text, 1))
    assert.deepEqual(live.arrows.map((a) => a.tone), ['err'])
    assert.equal(live.lit, null)
  })
  it('says what it shows, for a screen reader', () => {
    const jev = run.lanes[0]
    const mates = new Set(['e1e8'])
    const s = boardLabel({ pz: run.puzzles[0], lane: jev, on: laneOn(jev, 0), mates })
    assert.match(s, /puzzle 1: White to move, mate in one/)
    assert.match(s, /the thickest is Re8# at 0\.71/)
    const t = boardLabel({ pz: run.puzzles[0], lane: run.lanes[1], on: laneOn(run.lanes[1], 0), mates })
    assert.match(t, /test\/a played Re8#\. 1 illegal try shown in red\./)
    assert.match(boardLabel({ pz: run.puzzles[2] }), /Black to move/)
  })
  it('writes difficulty as dots', () => {
    assert.equal(dots(1), '●○○')
    assert.equal(dots(3), '●●●')
  })
})
