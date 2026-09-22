/* Ghost Maze's pure page logic: the maze's geometry (tiles to pixels, wall
 * blocks, the player's wedge, a ghost), reading a lane's streamed world, Jev's
 * stick, and what an hour of play costs. Plain data in, plain data out: no DOM
 * and no Preact, so `node --test` imports it as the browser does.
 *
 * A lane's world arrives compact, one event a tick (games/ghostmaze.py):
 * `player` [tile, heading, gen], `ghosts` [[tile, mode n|f|e, gen, heading]],
 * `eaten` [tiles], and the counts. A tile is row * cols + col.
 */

/** One tile, in SVG units, and the margin round the grid (the mockup's 36 and 6). */
export const CELL = 36
export const PAD = 6
export const WAYS = ['up', 'left', 'down', 'right']
export const STEP = { up: [0, -1], left: [-1, 0], down: [0, 1], right: [1, 0] }
/** A heading as an angle, SVG-wise (y down): right 0, down 90, left 180, up 270. */
export const ANGLE = { right: 0, down: 90, left: 180, up: 270 }
export const GHOST_NAMES = ['Blinky', 'Pinky', 'Clyde']
const HOME_MARK = { B: 'Blinky', N: 'Pinky', C: 'Clyde' }
const r2 = (n) => Math.round(n * 100) / 100

/* ── The maze ──────────────────────────────────────────────────────────────── */

/** A layout as the server sends it ({id, name, cols, rows, grid, start}), read. */
export function parseLayout(layout) {
  const grid = layout?.grid ?? []
  const rows = grid.length
  const cols = rows ? grid[0].length : 0
  const walls = new Set()
  const pellets = []
  const power = []
  const homes = {}
  let player = 0
  grid.forEach((line, r) =>
    [...line].forEach((ch, c) => {
      const n = r * cols + c
      if (ch === '#') walls.add(n)
      else if (ch === '.') pellets.push(n)
      else if (ch === 'o') power.push(n)
      else if (ch === 'P') player = n
      else if (HOME_MARK[ch]) homes[HOME_MARK[ch]] = n
    }),
  )
  return { id: layout?.id, name: layout?.name ?? layout?.id, blurb: layout?.blurb ?? '', start: layout?.start ?? null, grid, cols, rows, walls, pellets, power, homes, player }
}

export const mazeSize = (L) => ({ w: L.cols * CELL + 2 * PAD, h: L.rows * CELL + 2 * PAD })

/** A tile's centre in SVG units. */
export function cellXY(cell, cols) {
  const c = cell % cols
  const r = Math.floor(cell / cols)
  return [PAD + (c + 0.5) * CELL, PAD + (r + 0.5) * CELL]
}

/** The tile one step *way* from *cell*, or null into a wall or off the grid. */
export function stepOf(L, cell, way) {
  const [dc, dr] = STEP[way] ?? [0, 0]
  const c = (cell % L.cols) + dc
  const r = Math.floor(cell / L.cols) + dr
  if (c < 0 || r < 0 || c >= L.cols || r >= L.rows) return null
  const n = r * L.cols + c
  return L.walls.has(n) ? null : n
}

export const isOpen = (L, cell, way) => stepOf(L, cell, way) !== null
export const exitsOf = (L, cell) => WAYS.filter((w) => isOpen(L, cell, w))

/**
 * The walls as rectangles to draw, inset from their tiles like the mockup's:
 * each block of wall tiles (they are rectangles, the server's tests say so)
 * becomes one rect; a block that is not gets one rect per row run.
 */
export function wallRects(L, inset = 5) {
  const left = new Set(L.walls)
  const out = []
  const rect = (c0, r0, c1, r1) => ({
    x: PAD + c0 * CELL + inset,
    y: PAD + r0 * CELL + inset,
    w: (c1 - c0 + 1) * CELL - 2 * inset,
    h: (r1 - r0 + 1) * CELL - 2 * inset,
  })
  for (const first of [...L.walls].sort((a, b) => a - b)) {
    if (!left.has(first)) continue
    const block = [first]
    left.delete(first)
    for (let i = 0; i < block.length; i++) {
      const x = block[i]
      for (const way of WAYS) {
        const [dc, dr] = STEP[way]
        const c = (x % L.cols) + dc
        const r = Math.floor(x / L.cols) + dr
        const y = r * L.cols + c
        if (c >= 0 && r >= 0 && c < L.cols && r < L.rows && left.has(y)) {
          left.delete(y)
          block.push(y)
        }
      }
    }
    const cs = block.map((b) => b % L.cols)
    const rs = block.map((b) => Math.floor(b / L.cols))
    const [c0, c1, r0, r1] = [Math.min(...cs), Math.max(...cs), Math.min(...rs), Math.max(...rs)]
    if (block.length === (c1 - c0 + 1) * (r1 - r0 + 1)) {
      out.push(rect(c0, r0, c1, r1))
      continue
    }
    for (let r = r0; r <= r1; r++) {
      const row = cs.filter((_, i) => rs[i] === r).sort((a, b) => a - b)
      let s = row[0]
      for (let i = 1; i <= row.length; i++) {
        if (row[i] !== row[i - 1] + 1) {
          out.push(rect(s, r, row[i - 1], r))
          s = row[i]
        }
      }
    }
  }
  return out
}

/* ── Sprites ───────────────────────────────────────────────────────────────── */

/**
 * The player: a wedge of radius *r* at (cx, cy), its mouth (half-angle *mouth*
 * degrees) facing *heading*. `mouth` 0 is a whole circle.
 */
export function wedgePath(cx, cy, r, heading, mouth = 30) {
  if (!mouth) return `M${r2(cx - r)} ${r2(cy)} A${r} ${r} 0 1 1 ${r2(cx + r)} ${r2(cy)} A${r} ${r} 0 1 1 ${r2(cx - r)} ${r2(cy)} Z`
  const a = ((ANGLE[heading] ?? 0) * Math.PI) / 180
  const m = (mouth * Math.PI) / 180
  const at = (t) => `${r2(cx + r * Math.cos(t))} ${r2(cy + r * Math.sin(t))}`
  return `M${r2(cx)} ${r2(cy)} L${at(a + m)} A${r} ${r} 0 1 1 ${at(a - m)} Z`
}

/** A ghost's body, dome and skirt, centred at (cx, cy), half-width *s*. */
export function ghostPath(cx, cy, s = 12) {
  const k = (s * 2) / 3
  const q = s / 3
  const p = (x, y) => `${r2(x)} ${r2(y)}`
  return (
    `M${p(cx - s, cy + s)} V${r2(cy)} A${s} ${s} 0 0 1 ${p(cx + s, cy)} V${r2(cy + s)} ` +
    `L${p(cx + k, cy + k)} L${p(cx + q, cy + s)} L${p(cx, cy + k)} L${p(cx - q, cy + s)} L${p(cx - k, cy + k)} Z`
  )
}

/** A frightened ghost's wobbly mouth. */
export function scaredMouth(cx, cy, s = 12) {
  const y = cy + s * 0.35
  const xs = [-0.6, -0.3, 0, 0.3, 0.6].map((f) => cx + f * s)
  return xs.map((x, i) => `${i ? 'L' : 'M'}${r2(x)} ${r2(i % 2 ? y - 2.5 : y)}`).join(' ')
}

/** Where a ghost's pupils sit, looking the way it goes. */
export function pupil(heading, d = 1.5) {
  const [dx, dy] = STEP[heading] ?? [0, 0]
  return [dx * d, dy * d]
}

/* ── A lane's world ────────────────────────────────────────────────────────── */

/** A lane's streamed world, read into names. `eaten` is a Set. */
export function laneWorld(lane) {
  const [cell, heading, gen] = lane?.player ?? [0, null, 0]
  return {
    tick: lane?.tick ?? 0,
    player: { cell, heading, gen },
    ghosts: (lane?.ghosts ?? []).map(([c, mode, g, h], i) => ({ name: GHOST_NAMES[i] ?? `ghost ${i + 1}`, cell: c, mode, gen: g, heading: h })),
    score: lane?.score ?? 0,
    lives: lane?.lives ?? 0,
    left: lane?.left ?? 0,
    fright: lane?.fright ?? 0,
    pause: lane?.pause ?? 0,
    caughtAt: lane?.caught_at ?? null,
    threat: lane?.threat ?? null,
    ended: lane?.ended ?? null,
    eaten: new Set(lane?.eaten ?? []),
  }
}

/** The world at the start of a layout: for the setup's preview. */
export function startView(L) {
  return {
    tick: 0,
    player: [L.player, L.start, 0],
    ghosts: GHOST_NAMES.map((n) => [L.homes[n] ?? L.player, 'n', 0, null]),
    score: 0,
    lives: 3,
    left: L.pellets.length + L.power.length,
    eaten: [],
  }
}

const ENDED = ['error', 'stopped', 'rate_limited', 'waiting']
const lives = (n) => `${n} ${n === 1 ? 'life' : 'lives'} left`

/** A lane's state as a chip (tone, with a glyph so it reads without colour),
 *  or null where the lane's own status badge says it better. */
export function laneMood(lane) {
  if (!lane || ENDED.includes(lane.status)) return null
  const w = laneWorld(lane)
  if (w.ended === 'cleared') return { text: '✓ cleared the maze', tone: 'ok' }
  if (w.ended === 'caught') return { text: '✕ out of lives', tone: 'err' }
  if (w.ended === 'time') return { text: `■ time · ${lives(w.lives)}`, tone: 'neutral' }
  if (w.pause > 0) return { text: `✕ caught · ${lives(w.lives)}`, tone: 'err' }
  if (w.fright > 0) return { text: '◆ power · ghosts frightened', tone: 'cy' }
  if (w.threat) return { text: `! alive · ${w.threat} close`, tone: 'warn' }
  return { text: '● alive', tone: 'ok' }
}

/** What the maze shows across its top: a catch, or how the lane's game ended. */
export function banner(lane) {
  const w = laneWorld(lane)
  if (w.ended === 'cleared') return { text: 'CLEARED', tone: 'ok' }
  if (w.ended === 'caught') return { text: `OUT OF LIVES · tick ${w.caughtAt ?? w.tick}`, tone: 'err' }
  if (w.ended === 'time') return { text: 'TIME', tone: 'neutral' }
  if (w.pause > 0 && w.caughtAt != null) return { text: `CAUGHT · tick ${w.caughtAt}`, tone: 'err' }
  return null
}

/** Ticks the world has run against ticks that got a fresh decision. */
export function ticksAnswered(lane) {
  const ticks = lane?.tick ?? 0
  const answered = lane?.answered ?? 0
  const share = ticks ? Math.min(1, answered / ticks) : answered ? 1 : 0
  return { answered, ticks, share, tone: share >= 0.8 ? 'ok' : share >= 0.3 ? 'warn' : 'err' }
}

/** How many ticks late an answer lands, on average. */
export const meanLag = (lane) => (lane?.answered ? lane.lag / lane.answered : NaN)

/** Whether a lane's latest decision is fresh enough to draw on its maze. */
export const isFresh = (lane, within = 2) => !!lane?.last && (lane.tick ?? 0) - (lane.last.at ?? 0) <= within

/** How long a call in flight has been out, by the world's clock ("4.1 s on
 *  tick 371"), once it has been out *minTicks* ticks at least. */
export function thinkingText(lane, tickMs, minTicks = 0) {
  if (lane?.asking == null) return null
  const ticks = Math.max(0, (lane.tick ?? 0) - lane.asking)
  if (ticks < minTicks) return null
  return ticks ? `thinking · ${((ticks * tickMs) / 1000).toFixed(1)} s on tick ${lane.asking}` : `thinking on tick ${lane.asking}`
}

/** A lane's words as rows for the page: [key, value], each ghost its own row. */
export function wordsRows(words) {
  const s = words?.state
  if (!s) return []
  const ghosts = (s.ghosts ?? []).map((g) => {
    const i = g.indexOf(': ')
    return i > 0 ? [g.slice(0, i), g.slice(i + 2)] : ['ghost', g]
  })
  return [['you', s.you], ...ghosts, ['pellets', s.pellets], ['power', s.power], ['exits', s.exits]]
}

/* ── The stick ─────────────────────────────────────────────────────────────── */

/**
 * Jev's stick for a decision: an arm per way, sized by its probability; a way
 * not offered is a wall. A text model's stick has one arm, the way it named.
 * → [{way, offered, p, chosen, len, width, opacity}]
 */
export function stickArms(last) {
  const offered = new Set(last?.offered ?? [])
  const probs = last?.p
  return WAYS.map((way) => {
    const on = offered.has(way)
    const p = !on ? 0 : probs ? Number(probs[way]) || 0 : last?.dir === way ? 1 : 0
    return {
      way,
      offered: on,
      p,
      chosen: last?.dir === way,
      len: r2(12 + 30 * p),
      width: r2(2 + 10 * p),
      opacity: r2(0.45 + 0.55 * p),
    }
  })
}

/** What the stick shows, in words, for its aria-label. */
export function stickLabel(lane) {
  const last = lane?.last
  if (!last) return `${lane?.label ?? 'This lane'}'s stick: no decision yet.`
  const arms = stickArms(last)
  const on = arms.filter((a) => a.offered)
  const walls = arms.filter((a) => !a.offered).map((a) => a.way)
  const said = last.p
    ? on.sort((a, b) => b.p - a.p).map((a) => `${a.way} ${a.p.toFixed(2)}`).join(', ')
    : last.foul
      ? `a foul (${last.foul})`
      : `${last.dir}`
  const wallText = walls.length ? `; ${walls.join(' and ')} ${walls.length === 1 ? 'is a wall and is' : 'are walls and are'} not offered` : ''
  return `${lane.label}'s stick: ${said}${wallText}.`
}

/* ── Cost ──────────────────────────────────────────────────────────────────── */

/**
 * What an hour of play costs a lane at its own pace, from what its calls have
 * cost so far: a decision's tokens and price, times the decisions an hour it
 * can make (one a tick at most). `atTen`: the same price at ten a second, the
 * pace of TypeSafe's Doom demo. Prices are null when unknown.
 */
export function hourCost(lane, tickMs = 100) {
  const calls = lane?.calls ?? 0
  if (!calls) return { tokens: NaN, perHour: NaN, dollars: null, atTen: null, calls }
  const tokens = ((lane.tokens_in ?? 0) + (lane.tokens_out ?? 0)) / calls
  const msPer = Math.max((lane.think_ms ?? 0) / calls, tickMs, 1)
  const perHour = 3_600_000 / msPer
  const known = !(lane.cost_unknown && !lane.cost)
  const each = known ? (lane.cost ?? 0) / calls : null
  return { tokens, perHour, dollars: each == null ? null : each * perHour, atTen: each == null ? null : each * 36_000, calls }
}

export function fmtMoney(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  if (x < 0.01) return `$${x.toFixed(4)}`
  if (x < 10) return `$${x.toFixed(2)}`
  return `$${Math.round(x).toLocaleString('en-US')}`
}

export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')

/* ── Words for the drawing ─────────────────────────────────────────────────── */

/** The maze in a sentence, for its aria-label. */
export function mazeLabel(lane, L) {
  const w = laneWorld(lane)
  const how = w.player.heading && isOpen(L, w.player.cell, w.player.heading) ? `heading ${w.player.heading}` : 'standing against a wall'
  const b = banner(lane)
  const parts = [
    `${lane?.label ?? 'The'}'s maze`,
    `the player ${how}`,
    `score ${w.score}`,
    lives(w.lives),
    `${w.left} pellets left`,
  ]
  if (w.threat) parts.push(`${w.threat} is close`)
  if (w.fright) parts.push('the ghosts are frightened')
  if (b) parts.push(b.text.toLowerCase())
  return `${parts.join(', ')}.`
}

/** The best score in a run (for the recent-runs list). */
export const bestScore = (run) => Math.max(0, ...(run?.lanes ?? []).map((l) => Number(l.score) || 0))
