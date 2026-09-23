/* Blind Tasting — the page's pure half: where a measurement's tick and band
 * fall on its track, who wins (closest without going over, the server's own
 * rule, so your guess is judged as the lanes are), reading your guess, and the
 * model's scatter. No DOM and no Preact.
 */

export const LOW = 80
export const HIGH = 100
/** The top level of every Score Jev answers here. */
export const TOP = 4

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * A Score feature on a track *width* wide, levels 0 … top: the band from
 * mean − spread to mean + spread (clipped to the track) and the tick at the
 * mean. `{x, w, tick}`, in the track's units.
 */
export function band(mean, spread, width, top = TOP) {
  const at = (v) => (clamp(v, 0, top) / top) * width
  const m = Number.isFinite(mean) ? mean : 0
  const s = Number.isFinite(spread) ? Math.max(0, spread) : 0
  const x = at(m - s)
  return { x, w: at(m + s) - x, tick: at(m) }
}

/** A yes/no feature's bar on a track *width* wide. */
export const barWidth = (p, width) => clamp(Number(p) || 0, 0, 1) * width

/**
 * Who guessed closest without going over: the keys of every guess tied at
 * the best, none when every guess went over. guesses: [{key, guess}].
 */
export function winners(guesses, critic) {
  if (!Number.isFinite(critic)) return []
  const under = guesses.filter((g) => Number.isFinite(g.guess) && g.guess <= critic)
  if (!under.length) return []
  const best = Math.max(...under.map((g) => g.guess))
  return under.filter((g) => g.guess === best).map((g) => g.key)
}

/** A guess's fate once the critic has spoken: won | over | under | none (no guess) | sealed. */
export function fateOf(guess, critic, won) {
  if (!Number.isFinite(guess)) return 'none'
  if (!Number.isFinite(critic)) return 'sealed'
  if (guess > critic) return 'over'
  return won ? 'won' : 'under'
}

/** Your guess as typed: a whole number from 80 to 100, or null. */
export function parseGuess(text) {
  const t = String(text ?? '').trim()
  if (!/^\d{2,3}$/.test(t)) return null
  const n = Number(t)
  return n >= LOW && n <= HIGH ? n : null
}

/** A model weight as the page writes it: +1.8 or −0.6 (points per spread of the set). */
export const fmtWeight = (w) => `${w >= 0 ? '+' : '−'}${Math.abs(Number(w) || 0).toFixed(1)}`

/** Where a score (80 … 100) falls along *size*, from *pad* in: for the scatter's axes. */
export const axis = (v, size, pad = 0) => pad + ((clamp(v, LOW, HIGH) - LOW) / (HIGH - LOW)) * (size - 2 * pad)

/**
 * The model's leave-one-out predictions against the critic's scores, as
 * points in a *size* square: x the prediction, y the critic (up is higher).
 */
export function scatter(points, size, pad = 0) {
  return (points ?? []).map((p) => ({ n: p.n, x: axis(p.pred, size, pad), y: size - axis(p.critic, size, pad) }))
}

/* ── The dial ──────────────────────────────────────────────────────────────── */

/** A score (80 … 100) as the dial's angle: −90° (80, far left) to +90° (100,
 *  far right), 0° straight up at 90. Clamped to the scale. */
export const dialAngle = (v) => -90 + ((clamp(Number(v) || LOW, LOW, HIGH) - LOW) / (HIGH - LOW)) * 180

/** The point *r* from (cx, cy) at *deg* degrees clockwise from straight up. */
export function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180
  return [Math.round((cx + r * Math.sin(a)) * 100) / 100, Math.round((cy - r * Math.cos(a)) * 100) / 100]
}

/** An SVG arc of radius *r* about (cx, cy), clockwise from *a0* to *a1* degrees. */
export function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  return `M${x0} ${y0} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`
}

/** What is in the glass, from the note's style: red, white, rose, sparkling or sweet. */
export function wineKind(style) {
  const s = String(style ?? '').toLowerCase()
  if (/ros[eé]/.test(s)) return 'rose'
  if (/sparkling|champagne|cava|prosecco|cr[eé]mant/.test(s)) return 'sparkling'
  if (/sweet|sauternes|port|tokaji|ice ?wine/.test(s)) return 'sweet'
  if (/white|blanc|riesling|chardonnay|chenin|grigio|gris|gew[uü]rz|viognier|albari|gr[uü]ner|semillon|s[eé]millon|muscadet|verdejo|vermentino|marsanne|roussanne/.test(s)) return 'white'
  return 'red'
}

/** The level whose words are nearest a mean, for a tooltip. */
export const nearestLevel = (mean, levels) => levels?.[clamp(Math.round(Number(mean) || 0), 0, (levels?.length ?? 1) - 1)]
