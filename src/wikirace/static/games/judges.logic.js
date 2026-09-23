/* Judges' Panel — the page's pure half: the composite, the ranking, a card's
 * tilt. No DOM and no Preact, so `node --test tests/js` imports it as the
 * browser does.
 *
 * The server stores what Jev said once per contestant and judge (a mean level
 * 0 … 4, its spread, the level probabilities); everything the weights decide
 * happens here, in code, with no new request:
 *
 *   composite = Σ w·(score/4) / Σ w
 */

/** The top level of every rubric. */
export const TOP = 4

/**
 * One contestant's composite, 0 … 1. `scores[j]` is judge j's mean level
 * (null for a judge that gave none: a text model's foul, left out along with
 * its weight). null when no weight is on a judge that scored.
 */
export function composite(scores, weights, top = TOP) {
  let num = 0
  let den = 0
  scores.forEach((s, j) => {
    const w = Number(weights[j]) || 0
    if (s == null || !Number.isFinite(s) || w <= 0) return
    num += w * (s / top)
    den += w
  })
  return den > 0 ? num / den : null
}

/**
 * A lane's scores as a matrix: `m[c][j]` is `{score, spread, level,
 * probabilities}`, null when that judge gave no score (a foul), undefined
 * while it has not been asked yet.
 */
export function matrixOf(lane, nContestants, nJudges) {
  const m = Array.from({ length: nContestants }, () => Array(nJudges).fill(undefined))
  for (const s of lane?.scored ?? []) {
    if (!m[s.c]) continue
    s.judges.forEach((cell, j) => {
      if (j < nJudges) m[s.c][j] = cell
    })
  }
  return m
}

/**
 * The leaderboard, best first: `{k, c, cells, composite, done, rank}` per
 * contestant. A contestant not scored yet has a null composite and sorts
 * last; ties keep the contestants' own order, so equal rows never swap.
 */
export function rank(contestants, matrix, weights) {
  const rows = contestants.map((c, k) => {
    const cells = matrix[k] ?? []
    const done = cells.length > 0 && cells.every((x) => x !== undefined)
    const value = done ? composite(cells.map((x) => (x ? x.score : null)), weights) : null
    return { k, c, cells, done, composite: value }
  })
  rows.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1) || a.k - b.k)
  return rows.map((r, i) => ({ ...r, rank: i + 1 }))
}

/** The order of a leaderboard as one comparable string. */
export const orderOf = (rows) => rows.map((r) => r.k).join(',')

/**
 * How far a judge's card tilts, in degrees: a little always, more the wider
 * Jev's distribution (its spread, in levels), leaning left and right in turn.
 */
export function tilt(spread, i) {
  const s = Number.isFinite(spread) ? Math.max(0, spread) : 0
  return (i % 2 ? 1 : -1) * Math.min(16, 1.5 + s * 8)
}

/** A preset's weights, in the judges' order. */
export const presetWeights = (preset, judges) => judges.map((j) => Number(preset?.weights?.[j.id]) || 0)

/** The preset these weights are, or null. */
export function presetOf(presets, judges, weights) {
  return (presets ?? []).find((p) => presetWeights(p, judges).every((w, j) => w === weights[j])) ?? null
}

/** The formula as the page writes it: `score = (5·kids + 5·apt + …) / 16`. */
export function formula(judges, weights) {
  const total = weights.reduce((a, w) => a + (Number(w) || 0), 0)
  return `score = (${judges.map((j, i) => `${weights[i]}·${j.short}`).join(' + ')}) / ${total}`
}

/** A composite as the leaderboard writes it, 0 … 100. */
export const pts = (x) => (Number.isFinite(x) ? Math.round(x * 100) : null)

/** A cell as its card reads: the mean to one decimal and the spread. */
export function cardOf(cell) {
  if (cell === undefined) return { state: 'wait', big: '…', small: 'judging' }
  if (cell === null) return { state: 'foul', big: '✕', small: 'no score' }
  const whole = cell.probabilities == null
  return {
    state: 'up',
    big: whole ? String(Math.round(cell.score * 10) / 10) : cell.score.toFixed(1),
    small: whole ? 'as written' : `±${(cell.spread ?? 0).toFixed(1)}`,
  }
}

/** Which judge levels the card shows as dots: the mean rounded, or null. */
export const dotOf = (cell) => (cell ? Math.max(0, Math.min(TOP, Math.round(cell.score))) : null)

/**
 * How far each contestant moved between two rankings: `{k: places}`, up
 * positive, for those that moved only. `before` is a Map (or object) of
 * contestant → rank from the last ranking; empty when there was none.
 */
export function rankMoves(before, rows) {
  const out = {}
  if (!before) return out
  const was = before instanceof Map ? before : new Map(Object.entries(before).map(([k, v]) => [Number(k), v]))
  for (const r of rows ?? []) {
    const p = was.get(r.k)
    if (p != null && p !== r.rank) out[r.k] = p - r.rank
  }
  return out
}

/** A ranking as a Map of contestant → rank, to compare the next one with. */
export const ranksOf = (rows) => new Map((rows ?? []).map((r) => [r.k, r.rank]))

/**
 * The podium: the top three scored rows, laid out as a podium stands them,
 * second, first, third. → [{row, place}] (fewer while fewer are scored).
 */
export function podiumOf(rows) {
  const top = (rows ?? []).filter((r) => r.done && r.composite != null).slice(0, 3)
  const at = [1, 0, 2].filter((i) => top[i])
  return at.map((i) => ({ row: top[i], place: i + 1 }))
}

/** How brightly a judge's spotlight burns for its weight (0 … 5): dim when
 *  it does not count, full at the top of the fader. */
export const beamOf = (weight, max = 5) => Math.round((0.12 + 0.88 * Math.max(0, Math.min(1, (Number(weight) || 0) / max))) * 100) / 100

/**
 * What the finale says when a panel has scored everyone: the scores are in,
 * and who tops the board as the visitor has weighted it (the game's own
 * ranking, not a lane's win). null before anyone is ranked.
 */
export function finaleOf(topic, rows, preset) {
  const first = (rows ?? []).find((r) => r.rank === 1 && r.done && r.composite != null)
  if (!first) return null
  const mix = preset ? `“${preset.label}”` : 'your weights'
  return { headline: 'SCORES ARE IN!', sub: `${first.c.name} tops ${mix} · drag a weight to re-rank` }
}

/** The first sentence or two of an introduction, for the spotlight. */
export function lede(text, max = 240) {
  const t = String(text ?? '').split('\n')[0]
  if (t.length <= max) return t
  const cut = t.lastIndexOf('. ', max)
  return cut > 60 ? t.slice(0, cut + 1) : `${t.slice(0, max).trimEnd()}…`
}
