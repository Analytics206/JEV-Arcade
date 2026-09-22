/* Memory Match — the page's pure half: scoring a set of claims against the
 * answers (the same rules as games/memory.py, so your score is counted as
 * Jev's is), laying the board out so matched cards share a row, and reading
 * Jev's companion checks. No DOM and no Preact.
 */

/** Points per claim, and for a twin or cousin nobody claimed. */
export const POINTS = { same: 2, related: 1, cautious: 1, eager: 0, wrong: -1, missed: 0 }

/** A level as a connector reads it: 2 SAME · merge, 1 CLOSE · to a curator, 0 DIFFERENT · leave. */
export const LEVEL = [
  { n: 0, word: 'DIFFERENT', act: 'leave', tone: 'none' },
  { n: 1, word: 'CLOSE', act: 'to a curator', tone: 'warn' },
  { n: 2, word: 'SAME', act: 'merge', tone: 'ok' },
]

/** A verdict as the page writes it, with a glyph so it reads without colour. */
export const VERDICT = {
  same: { mark: '✓', tone: 'ok', label: 'twins, merged' },
  related: { mark: '✓', tone: 'ok', label: 'cousins, to a curator' },
  cautious: { mark: '✓', tone: 'ok', label: 'twins, sent to a curator' },
  eager: { mark: '!', tone: 'warn', label: 'cousins, merged too eagerly' },
  wrong: { mark: '✕', tone: 'err', label: 'not a pair' },
}

/** How a claim at *claimed* (1 related, 2 same) fared against the gold level. */
export function verdict(claimed, gold) {
  if (!(gold > 0)) return 'wrong'
  if (gold === 2) return claimed === 2 ? 'same' : 'cautious'
  return claimed === 1 ? 'related' : 'eager'
}

/** The gold level of cards a and b: 0 when they are not a dealt pair. */
export function goldOf(gold, a, b) {
  return (gold ?? []).find((g) => g.a === a && g.b === b)?.level ?? 0
}

/** Every claim judged, the pairs missed and the points: `{claims, missed, points, right, wrong}`. */
export function tally(claims, gold) {
  const judged = (claims ?? []).map((c) => ({ ...c, verdict: verdict(c.level, goldOf(gold, c.a, c.b)) }))
  const found = new Set(judged.map((c) => `${c.a}:${c.b}`))
  const missed = (gold ?? []).filter((g) => g.level > 0 && !found.has(`${g.a}:${g.b}`)).length
  return {
    claims: judged,
    missed,
    points: judged.reduce((s, c) => s + POINTS[c.verdict], 0),
    right: judged.filter((c) => ['same', 'related', 'cautious'].includes(c.verdict)).length,
    wrong: judged.filter((c) => c.verdict === 'wrong').length,
  }
}

/** The best a board allows: every twin merged, every cousin to a curator. */
export const bestOf = (gold) => (gold ?? []).reduce((s, g) => s + Math.max(0, g.level), 0)

/**
 * Which B card each row shows: a claimed B card sits in its A card's row, the
 * others fill the rows left over in their own order. `rows[r]` is a B index.
 */
export function alignB(n, claims) {
  const row = Array(n).fill(null)
  const used = new Set()
  for (const c of claims ?? []) {
    if (c.a >= 0 && c.a < n && row[c.a] == null && !used.has(c.b) && c.b >= 0 && c.b < n) {
      row[c.a] = c.b
      used.add(c.b)
    }
  }
  const rest = [...Array(n).keys()].filter((b) => !used.has(b))
  return row.map((b) => (b == null ? rest.shift() : b))
}

/** Jev's three companion checks on one comparison, each yes when p ≥ 0.5. */
export function checks(cell) {
  if (!cell) return []
  return ['brand', 'model', 'variant'].map((k) => ({ k, p: cell[k], yes: cell[k] >= 0.5 }))
}

/** The gold checks of a dealt pair, in the same shape. */
export function goldChecks(g) {
  if (!g?.fields) return []
  return ['brand', 'model', 'variant'].map((k) => ({ k, p: g.fields[k] ? 1 : 0, yes: !!g.fields[k] }))
}

/** The comparison of a and b in Jev's grid, or undefined. */
export const cellOf = (grid, a, b) => (grid ?? []).find((c) => c.a === a && c.b === b)

/** Everyone's points, best first; ties share a place. */
export function standings(entries) {
  const sorted = [...entries].sort((x, y) => (y.points ?? -Infinity) - (x.points ?? -Infinity))
  return sorted.map((e) => ({ ...e, place: 1 + sorted.filter((o) => (o.points ?? -Infinity) > (e.points ?? -Infinity)).length }))
}

/** A card's name: A1 … An, B1 … Bn. */
export const cardName = (side, i) => `${side.toUpperCase()}${i + 1}`
