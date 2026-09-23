/* The Big Sort's pure half: the pixel wall's grid, and the readings the page
 * draws from a run. No DOM, no Preact: `node --test tests/js` imports it.
 *
 * A lane's answers arrive as `labels`, one `[article, topic, p]` each (topic
 * −1 for a foul, with what the model said as a fourth item). The wall is one
 * cell per article in a near-square grid; a cell takes its topic's colour when
 * its answer lands.
 */

export const UNSORTED = -2
export const FOUL = -1
/** The largest a cell is drawn, however few articles there are. */
const MAX_STEP = 30

/** The wall for *n* cells in *width* pixels: columns, rows, and each cell's
 *  size and step (cell + gap). Cells shrink to fit; the gap goes before they
 *  would vanish. */
export function wallGrid(n, width, { gap = 1 } = {}) {
  const count = Math.max(1, n | 0)
  const cols = Math.ceil(Math.sqrt(count))
  let step = Math.min(MAX_STEP, Math.floor((width + gap) / cols))
  if (step - gap < 2) gap = 0
  step = Math.max(1, step)
  const rows = Math.ceil(count / cols)
  const cell = Math.max(1, step - gap)
  return { n: count, cols, rows, step, cell, gap, width: cols * step - gap, height: rows * step - gap }
}

/** Where position *i* is drawn. */
export function cellRect(i, g) {
  return { x: (i % g.cols) * g.step, y: Math.floor(i / g.cols) * g.step, w: g.cell, h: g.cell }
}

/** The position under (x, y) in the wall's own pixels, or −1 off the wall. */
export function cellAt(x, y, g) {
  if (!(x >= 0 && y >= 0) || x >= g.cols * g.step || y >= g.rows * g.step) return -1
  const i = Math.floor(y / g.step) * g.cols + Math.floor(x / g.step)
  return i < g.n ? i : -1
}

/** A lane's labels as two arrays by article: its topic (UNSORTED until it
 *  lands, FOUL for a foul) and Jev's probability (NaN for a text model). */
export function labelArrays(labels, n) {
  const topic = new Int8Array(n).fill(UNSORTED)
  const p = new Float32Array(n).fill(NaN)
  const said = new Map()
  for (const item of labels ?? []) {
    const [k, t, prob, words] = item
    if (!(k >= 0 && k < n)) continue
    topic[k] = t
    if (prob != null) p[k] = prob
    if (t === FOUL && words) said.set(k, words)
  }
  return { topic, p, said }
}

/** How the wall orders its cells: `landed` keeps article order (the wall fills
 *  as answers land); `topic` groups them by topic, the legend's order, then
 *  fouls, then what has not landed. Returns article index by position. */
export function wallOrder(topic, mode) {
  const n = topic.length
  const order = Array.from({ length: n }, (_, i) => i)
  if (mode !== 'topic') return order
  const rank = (t) => (t >= 0 ? t : t === FOUL ? 1000 : 2000)
  return order.sort((a, b) => rank(topic[a]) - rank(topic[b]) || a - b)
}

/** Articles per topic, and fouls and unsorted, from a topic array. */
export function tally(topic, nTopics) {
  const counts = new Array(nTopics).fill(0)
  let fouls = 0
  let unsorted = 0
  for (const t of topic) {
    if (t >= 0) counts[t] += 1
    else if (t === FOUL) fouls += 1
    else unsorted += 1
  }
  return { counts, fouls, unsorted, sorted: counts.reduce((s, c) => s + c, 0) }
}

/** Seconds as a person reads a long wait: 41 s · 2 m 10 s · 2 h 10 m. */
export function fmtSpan(s) {
  if (!Number.isFinite(s) || s < 0) return '—'
  const secs = Math.round(s)
  if (secs < 60) return `${secs} s`
  if (secs < 3600) return secs % 60 ? `${Math.floor(secs / 60)} m ${secs % 60} s` : `${secs / 60} m`
  const mins = Math.round(s / 60)
  return mins % 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins / 60} h`
}

/** How long a lane would take for the rest at its rate so far, in seconds. */
export function eta(answered, total, rate) {
  if (answered >= total) return 0
  return rate > 0 ? (total - answered) / rate : Infinity
}

/** A dollar amount at the precision it needs: $0.0042 · $0.11 · $12.40. */
export function fmtUsd(x) {
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  const digits = x < 0.01 ? 4 : x < 1 ? 3 : 2
  return `$${x.toFixed(digits)}`
}

/** Thousands with commas: 10,000. */
export const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—')

/** How full a confusion cell looks: its share of its row's largest. */
export function heat(count, rowMax) {
  return count > 0 && rowMax > 0 ? Math.max(0.12, count / rowMax) : 0
}

/** The wall in words, for its aria-label. */
export function wallSummary(label, topics, t, total) {
  const parts = topics
    .map((tp, i) => [tp.name, t.counts[i]])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, c]) => `${c} ${name}`)
  const fouls = t.fouls ? `, ${t.fouls} fouls` : ''
  return `${label}'s wall: ${t.sorted} of ${total} articles sorted${parts.length ? `: ${parts.join(', ')}` : ''}${fouls}.`
}

/** The articles that landed since the wall was last drawn: those UNSORTED in
 *  *before* and answered (a topic or a foul) in *after*. */
export function freshCells(before, after) {
  const out = []
  if (!before || before.length !== after.length) return out
  for (let k = 0; k < after.length; k++) if (before[k] === UNSORTED && after[k] !== UNSORTED) out.push(k)
  return out
}

/** A topic's short name for a bin too narrow for its whole name: SCI, PPL, GEO… */
const ABBR = { science: 'SCI', people: 'PPL', places: 'GEO', arts: 'ART', nature: 'NAT', history: 'HIS', sport: 'SPT', other: 'OTH' }
export const topicAbbr = (key) => ABBR[key] ?? String(key ?? '').slice(0, 3).toUpperCase()

/**
 * A lane's sorted landscape: each topic's share of the round, then the fouls
 * and what has not landed, as segments that add up to the whole wall.
 * @returns {[{kind: 'topic'|'foul'|'unsorted', i?: number, n: number, share: number}]}
 */
export function landscape(t, total) {
  const all = Math.max(1, total)
  return [
    ...t.counts.map((n, i) => ({ kind: 'topic', i, n, share: n / all })),
    { kind: 'foul', n: t.fouls, share: t.fouls / all },
    { kind: 'unsorted', n: t.unsorted, share: t.unsorted / all },
  ]
}

/**
 * Who won, by the game's own rule: a lane's score is the articles it sorted
 * (fouls are not sorted), so the most wins, and lanes level at the top tie.
 * No winner in a solo round, or when nobody sorted anything.
 * @returns {number[]} lane indexes
 */
export function sortWinners(lanes) {
  const ls = lanes ?? []
  if (ls.length < 2) return []
  const top = Math.max(...ls.map((ln) => Number(ln.score) || 0))
  if (!(top > 0)) return []
  return ls.filter((ln) => (Number(ln.score) || 0) === top).map((ln) => ln.index)
}

/** The finale's words for a round: the winners, or for a round every lane
 *  finished or a solo one, what happened (ALL SORTED, TIME'S UP). */
export function sortOutcome(run) {
  const lanes = run?.lanes ?? []
  const n = run?.total ?? 0
  const winners = sortWinners(lanes)
  const everyone = lanes.length > 0 && lanes.every((ln) => (Number(ln.score) || 0) >= n && n > 0)
  const count = (ln) => `${fmtN(Number(ln.score) || 0)} of ${fmtN(n)}`
  if (lanes.length === 1) {
    const ln = lanes[0]
    if (everyone) return { winners, headline: 'ALL SORTED', sub: `${ln.label} sorted all ${fmtN(n)} articles` }
    if (ln.timed_out) return { winners, headline: "TIME'S UP", sub: `${ln.label} sorted ${count(ln)} articles` }
    return { winners }
  }
  if (everyone) return { winners, headline: 'ALL SORTED', sub: `every lane sorted all ${fmtN(n)} articles` }
  if (winners.length === 1) {
    const ln = lanes.find((l) => l.index === winners[0])
    return { winners, sub: `${ln.label} · ${count(ln)} sorted` }
  }
  return { winners }
}

/** The cursor moved by an arrow key on a wall of *cols* columns and *n* cells. */
export function stepCursor(at, key, cols, n) {
  const i = at < 0 ? 0 : at
  const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, Home: -i, End: n - 1 - i }
  if (!(key in moves)) return null
  return Math.max(0, Math.min(n - 1, i + moves[key]))
}
