/* Needle Hunt: the page's pure half — the dial's and the minimap's geometry,
 * the heat behind them, and how the visitor's pick is scored (as the server
 * scores a lane's, games/needle.py `judge`). Plain data in, plain data out, so
 * tests/js/game-needle.test.js imports it as the browser does.
 */

export const NONE = 'NONE'
/** The cookbook's bands on "does any line answer it?". */
export const BANDS = { answered: 0.7, partly: 0.35 }
export const BAND = {
  answered: { label: 'answered', tone: 'ok' },
  partly: { label: 'partly', tone: 'warn' },
  absent: { label: 'not in here', tone: 'err' },
}
export const POINTS = { right: 2, near: 1, wrong: -1, missed: -1, foul: -1, unscored: 0 }
/** How an answer went, as a mark: tone and glyph, so it reads without colour too. */
export const VERDICT = {
  right: { tone: 'ok', glyph: '✓', label: 'right' },
  near: { tone: 'warn', glyph: '≈', label: 'the line next door' },
  wrong: { tone: 'err', glyph: '✕', label: 'wrong line' },
  missed: { tone: 'err', glyph: '✕', label: "said it isn't there" },
  foul: { tone: 'err', glyph: '✕', label: 'not a line (foul)' },
  unscored: { tone: 'dim', glyph: '·', label: 'no answer key' },
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))
const round2 = (v) => Math.round(v * 100) / 100

/** The existence dial's band for p(some line answers it). */
export function band(p, bands = BANDS) {
  if (p >= bands.answered) return 'answered'
  return p >= bands.partly ? 'partly' : 'absent'
}

/* ── The dial: a half circle, p = 0 on the left, 1 on the right ────────────── */

export const DIAL = { cx: 93, cy: 98, r: 75, width: 186, height: 112 }

/** The point on the dial's arc (radius r) for p. */
export function dialPoint(p, r = DIAL.r, geo = DIAL) {
  const t = Math.PI * (1 - clamp01(p))
  return [round2(geo.cx + r * Math.cos(t)), round2(geo.cy - r * Math.sin(t))]
}

/** An SVG arc along the dial from p0 to p1 (p0 < p1), clockwise over the top. */
export function arcPath(p0, p1, geo = DIAL) {
  const [x0, y0] = dialPoint(p0, geo.r, geo)
  const [x1, y1] = dialPoint(p1, geo.r, geo)
  return `M${x0} ${y0} A${geo.r} ${geo.r} 0 0 1 ${x1} ${y1}`
}

/** The dial's three bands, left to right, as arcs. */
export function dialBands(bands = BANDS, geo = DIAL) {
  return [
    { band: 'absent', d: arcPath(0, bands.partly, geo) },
    { band: 'partly', d: arcPath(bands.partly, bands.answered, geo) },
    { band: 'answered', d: arcPath(bands.answered, 1, geo) },
  ]
}

/** The needle's turn, in degrees clockwise from pointing left (p = 0). */
export const needleAngle = (p) => round2(clamp01(p) * 180)

/* ── The minimap: one thin bar per line, heat-coloured ─────────────────────── */

/**
 * One bar per line down a strip `width` × `height`: its place, its length (by
 * the line's own length, so the map has the document's shape) and its heat,
 * 0…1 relative to the hottest line.
 * @returns {{bars: {id, i, y, h, w, p, heat}[], hottest: string|null, step: number}}
 */
export function minimap(lines, heat = {}, { width = 92, height = 360, minShare = 0.25 } = {}) {
  const n = lines.length
  const step = height / Math.max(1, n)
  const h = step > 2 ? step * 0.7 : step
  const longest = Math.max(1, ...lines.map((l) => l.text.length))
  const scale = Math.min(longest, 360)
  const top = Math.max(0, ...lines.map((l) => heat[l.id] ?? 0))
  const bars = lines.map((l, i) => {
    const p = heat[l.id] ?? 0
    return {
      id: l.id, i, y: round2(i * step), h: round2(h),
      w: round2(width * (minShare + (1 - minShare) * Math.min(1, l.text.length / scale))),
      p, heat: top > 0 ? p / top : 0,
    }
  })
  const hottest = top > 0 ? bars.reduce((a, b) => (b.p > a.p ? b : a)).id : null
  return { bars, hottest, step }
}

/** A bar's colour step: 0 cold … 4 the hottest. */
export function heatStep(h) {
  if (h >= 0.75) return 4
  if (h >= 0.4) return 3
  if (h >= 0.15) return 2
  return h > 0.02 ? 1 : 0
}

/** Which line of the map a click at `fraction` (0 top … 1 bottom) is on. */
export const lineAt = (fraction, n) => Math.min(n - 1, Math.max(0, Math.floor(clamp01(fraction) * n)))

/* ── A run's answers ───────────────────────────────────────────────────────── */

export const answerOf = (lane, k) => (lane?.answers ?? []).find((a) => a.q === k) ?? null
export const markOf = (lane, k) => (lane?.marks ?? []).find((m) => m.q === k) ?? null

/**
 * The heat behind question k's map: the first Jev lane's line probabilities
 * (for a long document, lines outside its window get their window's share);
 * with no Jev, the share of text models that named each line.
 */
export function heatFor(run, k) {
  const jev = (run?.lanes ?? []).find((ln) => ln.kind === 'judgment' && answerOf(ln, k))
  if (jev) {
    const a = answerOf(jev, k)
    const heat = { ...(a.heat ?? {}) }
    const spans = run.doc?.windows
    if (a.window_p && spans) {
      spans.forEach(([s, e], w) => {
        if (w === a.window) return
        const p = (a.window_p[String(w)] ?? 0) / (e - s + 1)
        if (p <= 0) return
        for (let i = s; i <= e; i++) {
          const id = run.lines?.[i]?.id
          if (id && !(id in heat)) heat[id] = p
        }
      })
    }
    return { heat, source: 'jev', lane: jev.index, answer: a }
  }
  const said = (run?.lanes ?? []).map((ln) => answerOf(ln, k)).filter((a) => a && a.pick && a.pick !== NONE)
  const heat = {}
  for (const a of said) heat[a.pick] = (heat[a.pick] ?? 0) + 1 / said.length
  return { heat, source: said.length ? 'text' : null, lane: null, answer: null }
}

/** `radius` lines either side of `id`, in the document's order. */
export function around(lines, id, radius = 2) {
  const i = lines.findIndex((l) => l.id === id)
  if (i < 0) return []
  return lines.slice(Math.max(0, i - radius), i + radius + 1)
}

/** The line just before or after one of the answer lines, in the same section. */
export function isNear(pick, key, lines) {
  const at = new Map(lines.map((l, i) => [l.id, i]))
  const i = at.get(pick)
  if (i === undefined) return false
  return key.some((k) => {
    const j = at.get(k)
    return j !== undefined && Math.abs(i - j) === 1 && lines[i].s === lines[j].s
  })
}

/** How a pick went against the key ([] = no answer in the document; null = no key). */
export function judgePick(pick, key, lines) {
  if (key == null) return pick == null ? 'foul' : 'unscored'
  if (pick == null) return 'foul'
  if (pick === NONE) return key.length ? 'missed' : 'right'
  if (!key.length) return 'wrong'
  if (key.includes(pick)) return 'right'
  return isNear(pick, key, lines) ? 'near' : 'wrong'
}

/** The first question the visitor has not played, else the last one. */
export function nextQuestion(questions, mine) {
  const k = (questions ?? []).findIndex((q) => !mine?.[q.k])
  return k === -1 ? Math.max(0, (questions?.length ?? 1) - 1) : k
}

/**
 * The tally over the questions the visitor has played whose key is out:
 * their points and each lane's, question for question.
 */
export function tallyOf(run, mine) {
  const lines = run?.lines ?? []
  const done = (run?.questions ?? []).filter((q) => q.revealed && mine?.[q.k])
  const you = { points: 0, right: 0, played: 0, ms: [] }
  for (const q of done) {
    const m = mine[q.k]
    if (m.skipped) continue
    const v = judgePick(m.pick, q.answer, lines)
    you.points += POINTS[v]
    you.right += v === 'right' ? 1 : 0
    you.played += 1
    if (Number.isFinite(m.ms)) you.ms.push(m.ms)
  }
  const lanes = (run?.lanes ?? []).map((ln) => {
    const marks = done.map((q) => markOf(ln, q.k)).filter(Boolean)
    return {
      index: ln.index, label: ln.label, kind: ln.kind,
      points: marks.reduce((s, m) => s + m.points, 0),
      right: marks.filter((m) => m.verdict === 'right').length,
      near: marks.filter((m) => m.verdict === 'near').length,
      wrong: marks.filter((m) => ['wrong', 'missed', 'foul'].includes(m.verdict)).length,
    }
  })
  return {
    questions: done.length,
    scored: done.some((q) => q.scored),
    you: { points: you.points, right: you.right, played: you.played,
      ms: you.ms.length ? you.ms.reduce((a, b) => a + b, 0) / you.ms.length : null },
    lanes,
  }
}

/** A signed score as the tally writes it: +4, 0, −2. */
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')

/**
 * The match as its scoreboard shows it: a row for the visitor and one per
 * lane, a cell per question, the totals (tallyOf's, so they agree with it),
 * whether the match is over, and who leads.
 *
 * A cell's `state` is a verdict (right, near, wrong, missed, foul, unscored,
 * with its `points`) once the visitor has played the question and every
 * player has answered it; else `skipped` (the visitor asked to be shown),
 * `pending` (played, the key not out yet), `sealed` (a lane's answer, sealed
 * until the visitor gives theirs) or `hunting` (no answer yet).
 *
 * The match is `done` when every question is revealed and played. The
 * leaders have the most points: the lanes still in the game (a lane that
 * dropped out is out of it when another played on), and the visitor once
 * they have answered one question themselves.
 */
export function matchOf(run, mine) {
  const lines = run?.lines ?? []
  const qs = run?.questions ?? []
  const tally = tallyOf(run, mine)
  const youCells = qs.map((q) => {
    const m = mine?.[q.k]
    if (!m) return { state: 'hunting' }
    if (m.skipped) return { state: 'skipped' }
    if (!q.revealed) return { state: 'pending' }
    const v = judgePick(m.pick, q.answer, lines)
    return { state: v, points: POINTS[v] }
  })
  const lanes = (run?.lanes ?? []).map((ln, j) => ({
    index: ln.index, label: ln.label, kind: ln.kind, status: ln.status, points: tally.lanes[j].points,
    cells: qs.map((q) => {
      if (!answerOf(ln, q.k)) return { state: 'hunting' }
      if (!mine?.[q.k]) return { state: 'sealed' }
      const mk = q.revealed ? markOf(ln, q.k) : null
      return mk ? { state: mk.verdict, points: mk.points } : { state: 'pending' }
    }),
  }))
  const you = { points: tally.you.points, played: tally.you.played, cells: youCells }
  const inPlay = lanes.filter((l) => l.status === 'done')
  const field = inPlay.length ? inPlay : lanes
  const scores = [...field.map((l) => l.points), ...(you.played ? [you.points] : [])]
  const best = scores.length ? Math.max(...scores) : null
  return {
    you, lanes, tally,
    done: qs.length > 0 && tally.questions === qs.length,
    scored: qs.some((q) => q.scored),
    leaders: {
      best,
      lanes: best == null ? [] : field.filter((l) => l.points === best).map((l) => l.index),
      you: !!you.played && you.points === best,
    },
  }
}
