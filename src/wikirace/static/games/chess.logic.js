/* Legal Moves Only: the page's pure half. Board geometry (a square to its
 * place in the SVG, an arrow from one square to another, knights' arrows
 * bent), the FEN's pieces, and the readings of a run the page draws: where
 * each lane is, how each puzzle went, the session's totals.
 *
 * Plain data in, plain data out — no DOM and no Preact — so `node --test`
 * imports it as the browser does.
 */

export const FILES = 'abcdefgh'
/** A square's side in the SVG, and the board's top-left corner (room for the
 *  rank numbers on the left and the file letters below). */
export const SQ = 60
export const X0 = 24
export const Y0 = 8
export const VIEW = 520

/* Unicode's filled chess glyphs for both colours (the fill says whose), each
 * followed by U+FE0E so that no platform draws it as an emoji. */
const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
export const TEXT_STYLE = '︎'
export const NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }

/** A piece letter (`K`, `n`, …) as its glyph, text-styled. */
export function glyph(piece) {
  const g = GLYPHS[String(piece).toLowerCase()]
  return g ? g + TEXT_STYLE : ''
}

/** `e4` → [4, 3] (file, rank from 0), or null for anything that is not a square. */
export function fileRank(sq) {
  if (typeof sq !== 'string' || !/^[a-h][1-8]$/.test(sq)) return null
  return [FILES.indexOf(sq[0]), Number(sq[1]) - 1]
}

/** The pieces of a FEN, and whose move it is. */
export function parseFen(fen) {
  const [placement = '', turn = 'w'] = String(fen ?? '').trim().split(/\s+/)
  const pieces = []
  placement.split('/').slice(0, 8).forEach((row, i) => {
    let f = 0
    for (const ch of row) {
      if (/[1-8]/.test(ch)) f += Number(ch)
      else if (/[kqrbnp]/i.test(ch) && f < 8) {
        const color = ch === ch.toUpperCase() ? 'w' : 'b'
        pieces.push({ sq: `${FILES[f]}${8 - i}`, piece: ch, color, kind: ch.toLowerCase() })
        f += 1
      }
    }
  })
  return { pieces, turn: turn === 'b' ? 'b' : 'w' }
}

/** Where a square sits in the SVG: its corner (x, y) and centre (cx, cy).
 *  `flip` draws the board from black's side. */
export function squareXY(sq, flip = false) {
  const fr = fileRank(sq)
  if (!fr) return null
  const [f, r] = fr
  const x = X0 + (flip ? 7 - f : f) * SQ
  const y = Y0 + (flip ? r : 7 - r) * SQ
  return { x, y, cx: x + SQ / 2, cy: y + SQ / 2 }
}

export const isLight = (sq) => {
  const fr = fileRank(sq)
  return !!fr && (fr[0] + fr[1]) % 2 === 1
}

/** Every square, a8 … h1. */
export const SQUARES = Array.from({ length: 64 }, (_, i) => `${FILES[i % 8]}${8 - Math.floor(i / 8)}`)

/** The file letters under the board and the rank numbers beside it. */
export function coordLabels(flip = false) {
  const files = [...FILES].map((t) => ({ t, x: squareXY(`${t}1`, flip).cx, y: Y0 + 8 * SQ + 18 }))
  const ranks = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ t: String(n), x: 12, y: squareXY(`a${n}`, flip).cy + 4 }))
  return { files, ranks }
}

/** An arrow's width for a probability: linear, so width reads as p. */
export function arrowWidth(p) {
  const v = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0
  return round(2 + 14 * v)
}

export function isKnightJump(from, to) {
  const a = fileRank(from)
  const b = fileRank(to)
  if (!a || !b) return false
  const df = Math.abs(a[0] - b[0])
  const dr = Math.abs(a[1] - b[1])
  return (df === 1 && dr === 2) || (df === 2 && dr === 1)
}

const round = (n) => Math.round(n * 10) / 10
const pt = ([x, y]) => `${round(x)} ${round(y)}`

/**
 * An arrow from one square's centre to another's: `d`, the shaft (a path; a
 * knight's bends, the long leg first), and `head`, the arrowhead's polygon
 * points. The tip stops just short of the centre; the head grows with the width.
 * @returns {{d: string, head: string, tip: number[], knight: boolean} | null}
 */
export function arrow(from, to, width = 6, flip = false) {
  const a = squareXY(from, flip)
  const b = squareXY(to, flip)
  if (!a || !b || from === to) return null
  const knight = isKnightJump(from, to)
  const start = [a.cx, a.cy]
  const corner = knight ? (Math.abs(b.cx - a.cx) > Math.abs(b.cy - a.cy) ? [b.cx, a.cy] : [a.cx, b.cy]) : null
  const last = corner ?? start
  const dx = b.cx - last[0]
  const dy = b.cy - last[1]
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  const headLen = Math.max(13, width * 2.1)
  const half = Math.max(8, width * 1.45)
  const tip = [b.cx - ux * 7, b.cy - uy * 7]
  const base = [tip[0] - ux * headLen, tip[1] - uy * headLen]
  const left = [base[0] - uy * half, base[1] + ux * half]
  const right = [base[0] + uy * half, base[1] - ux * half]
  const d = corner ? `M${pt(start)} L${pt(corner)} L${pt(base)}` : `M${pt(start)} L${pt(base)}`
  return { d, head: `${pt(tip)} ${pt(left)} ${pt(right)}`, tip: tip.map(round), knight }
}

/* ── Reading a run ─────────────────────────────────────────────────────────── */

const LIVE = ['waiting', 'playing', 'rate_limited']

/** How one puzzle went for a lane, as a mark: glyph, tone and words. */
export function verdictOf(r) {
  if (!r) return null
  if (r.verdict === 'solved') {
    return r.fouls
      ? { mark: '✓', tone: 'warn', label: `solved on try ${r.fouls + 1}` }
      : { mark: '✓', tone: 'ok', label: 'solved' }
  }
  if (r.verdict === 'missed') return { mark: '–', tone: 'err', label: 'missed' }
  return { mark: '✕', tone: 'err', label: 'fouled out' }
}

/**
 * Where a lane stands on puzzle *k*: `done` (with its result), `playing` (with
 * the attempts so far, for a text model), `waiting` for it, or `out` (the lane
 * ended before reaching it).
 */
export function laneOn(lane, k) {
  const result = (lane.puzzles ?? []).find((r) => r.puzzle === k)
  if (result) return { state: 'done', result, attempts: result.attempts ?? [] }
  const live = LIVE.includes(lane.status)
  if (live && (lane.at ?? 0) === k && lane.status !== 'waiting') {
    const cur = lane.current && lane.current.puzzle === k ? lane.current.attempts ?? [] : []
    return { state: 'playing', result: null, attempts: cur }
  }
  return { state: live ? 'waiting' : 'out', result: null, attempts: [] }
}

/** The puzzle to show while following the round: the one the slowest live lane
 *  is on; once nothing is live, the last one. */
export function followPuzzle(run) {
  const total = run?.puzzles?.length ?? 0
  if (!total) return 0
  const live = (run.lanes ?? []).filter((ln) => LIVE.includes(ln.status))
  const k = live.length ? Math.min(...live.map((ln) => ln.at ?? 0)) : total - 1
  return Math.max(0, Math.min(total - 1, k))
}

/** Every puzzle with each lane's mark on it, for the strip. */
export function stripOf(run) {
  return (run.puzzles ?? []).map((pz, k) => ({
    k,
    marks: run.lanes.map((ln) => {
      const on = laneOn(ln, k)
      return { index: ln.index, label: ln.label, state: on.state, verdict: verdictOf(on.result) }
    }),
  }))
}

/** The session so far, a row per lane: solved, missed, fouled out, fouls, and
 *  the time per puzzle (all of a text model's tries on it together). */
export function sessionRows(run) {
  return run.lanes.map((ln) => {
    const done = ln.puzzles ?? []
    const ms = done.reduce((a, r) => a + (Number(r.ms) || 0), 0)
    return {
      index: ln.index, label: ln.label, kind: ln.kind,
      solved: ln.solved ?? 0, missed: ln.missed ?? 0, failed: ln.failed ?? 0, fouls: ln.fouls ?? 0,
      played: done.length, perMove: done.length ? ms / done.length : NaN,
    }
  })
}

/** The mating moves of puzzle *k*, by UCI, once the key is out (else empty). */
export function matesOf(run, k) {
  return new Set((run?.key?.[k]?.mates ?? []).map((m) => m.uci))
}

/** A SAN as the page writes it: `#` once a move is known to mate. */
export function sanOf(san, uci, mates) {
  if (!san) return '—'
  return mates && mates.has(uci) ? `${san.replace(/[+#]$/, '')}#` : san
}

/** What the board draws for a lane on a puzzle: arrows (Jev's top five, width
 *  its probability; or a text model's tries, fouls dashed), highlighted squares,
 *  and a cross on a square a foul named without saying from where. */
export function boardMarks(lane, on, flip = false) {
  const arrows = []
  const crosses = []
  let lit = null
  if (!lane || !on) return { arrows, crosses, lit }
  if (lane.kind === 'judgment' && on.result) {
    const top = on.result.top ?? []
    const opacity = [0.95, 0.74, 0.62, 0.54, 0.46]
    top.forEach((t, i) => {
      const w = arrowWidth(t.p)
      const a = arrow(t.from, t.to, w, flip)
      if (a) arrows.push({ ...a, key: t.uci, width: w, opacity: opacity[i] ?? 0.4, tone: 'lane', rank: i })
    })
    arrows.reverse() // the likeliest drawn last, on top
    const first = top[0]
    if (first) lit = { from: first.from, to: first.to }
  } else {
    const tries = on.attempts ?? []
    tries.forEach((t, i) => {
      if (t.foul) {
        const a = t.from && t.to ? arrow(t.from, t.to, 4, flip) : null
        if (a) arrows.push({ ...a, key: `f${i}`, width: 4, opacity: 0.85, tone: 'err', rank: i })
        else if (t.to) crosses.push({ sq: t.to, key: `x${i}`, ...squareXY(t.to, flip) })
      } else if (t.from && t.to) {
        const a = arrow(t.from, t.to, 9, flip)
        if (a) arrows.push({ ...a, key: `m${i}`, width: 9, opacity: 0.95, tone: 'lane', rank: i })
        lit = { from: t.from, to: t.to }
      }
    })
  }
  return { arrows, crosses, lit }
}

/** The board's words for a screen reader. */
export function boardLabel({ pz, lane, on, mates }) {
  if (!pz) return 'Chess board'
  const side = pz.side === 'black' ? 'Black' : 'White'
  let s = `Chess board, puzzle ${pz.i + 1}: ${side} to move, mate in one.`
  if (lane && on?.result) {
    if (lane.kind === 'judgment' && on.result.top?.length) {
      const t = on.result.top[0]
      s += ` Arrows show ${lane.label}'s ${on.result.top.length} likeliest moves, width by probability;`
      s += ` the thickest is ${sanOf(t.san, t.uci, mates)} at ${Number(t.p).toFixed(2)}.`
    } else if (on.result.move) {
      s += ` ${lane.label} played ${on.result.move}.`
    }
    if (on.result.fouls) s += ` ${on.result.fouls} illegal ${on.result.fouls === 1 ? 'try' : 'tries'} shown in red.`
  }
  return s
}

/** Difficulty 1 to 3 as filled and hollow dots. */
export const dots = (n) => '●'.repeat(Math.max(0, Math.min(3, n | 0))) + '○'.repeat(Math.max(0, 3 - Math.min(3, n | 0)))
