/* Two Truths and a Lie: the page's pure half. Plain data in, plain data out —
 * no DOM, no Preact — so tests/js/game-twotruths.test.js imports it as the
 * browser does.
 *
 * The polygraph: each claim gets a pen trace whose agitation grows with the
 * probability that the claim is contradicted — a calm wander for a truth, a
 * burst of spikes for the lie. Seeded, so a claim draws the same trace on
 * every render.
 */

export const VERDICTS = ['supported', 'contradicted', 'not_in_article']
export const VERDICT_LABEL = { supported: 'supported', contradicted: 'contradicted', not_in_article: 'not in article' }
/** A verdict as a mark: tone and glyph, so it reads without colour too. */
export const VERDICT_MARK = {
  supported: { tone: 'ok', glyph: '✓' },
  contradicted: { tone: 'err', glyph: '✕' },
  not_in_article: { tone: 'dim', glyph: '?' },
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round1 = (v) => Math.round(v * 10) / 10

/** A small seeded generator (mulberry32): the same seed, the same numbers. */
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The polygraph's pen trace for a claim, as [x, y] points across a strip of
 * `width` × `height`. `p` (0…1) is how agitated the pen is: near 0 a gentle
 * wander about the middle line; near 1 a burst of alternating spikes over the
 * middle third, as a needle jumps when the subject lies.
 */
export function polygraph(p, seed = 1, { width = 360, height = 84, n = 90 } = {}) {
  const r = rng(seed)
  const a = clamp(Number(p) || 0, 0, 1)
  const mid = height / 2
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const bell = Math.exp(-((t - 0.5) ** 2) / (2 * 0.13 ** 2))
    const wander = (r() - 0.5) * height * (0.05 + 0.07 * a)
    const spike = (i % 2 ? 1 : -1) * bell * a ** 1.4 * height * 0.46 * (0.55 + 0.45 * r())
    pts.push([round1(t * width), round1(clamp(mid + wander + spike, 2, height - 2))])
  }
  return pts
}

export const pointsAttr = (pts) => pts.map(([x, y]) => `${x},${y}`).join(' ')

/** A trace's length in its own units: the dash that draws it in. */
export function traceLength(pts) {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return Math.ceil(n)
}

/** How far a trace strays from the middle line, as a share of half the strip. */
export function agitation(pts, height = 84) {
  const mid = height / 2
  return pts.reduce((m, [, y]) => Math.max(m, Math.abs(y - mid)), 0) / mid
}

/** A verdict's likeliest option. */
export function topVerdict(v) {
  if (!v) return null
  return v.top ?? VERDICTS.reduce((best, k) => ((v[k] ?? 0) > (v[best] ?? 0) ? k : best), VERDICTS[0])
}

/** Jev's pick for the lie: the likeliest contradicted, ties to not_in_article
 *  (the server's rule, games/twotruths.py `jev_lie`). */
export function jevLie(verdicts) {
  if (!verdicts?.length) return null
  let best = 0
  for (let k = 1; k < verdicts.length; k++) {
    const a = verdicts[k]
    const b = verdicts[best]
    if (a.contradicted > b.contradicted || (a.contradicted === b.contradicted && a.not_in_article > b.not_in_article)) best = k
  }
  return best
}

/**
 * What drives claim k's polygraph: the first Jev lane's p(contradicted); with
 * no Jev, the share of text judges that named it the lie.
 * @returns {{p: number, source: 'jev'|'judges'|null, top: string|null}}
 */
export function signalOf(run, k) {
  const jev = run?.lanes?.find((ln) => ln.kind === 'judgment' && ln.verdicts)
  if (jev) {
    const v = jev.verdicts[k]
    return { p: v.contradicted, source: 'jev', top: topVerdict(v) }
  }
  const said = (run?.lanes ?? []).filter((ln) => ln.kind !== 'judgment' && 'ms' in ln)
  if (!said.length) return { p: 0, source: null, top: null }
  const p = said.filter((ln) => ln.pick === k).length / said.length
  return { p, source: 'judges', top: p >= 0.5 ? 'contradicted' : 'supported' }
}

/** The visitor has played this round: picked a claim or asked to be shown. */
export const unsealed = (mine) => !!mine && (Number.isInteger(mine.pick) || !!mine.skipped)

/** One round for the session tally, once the run has revealed the lie and the
 *  visitor has played; null before. */
export function entryOf(run, mine) {
  if (!run || !Number.isInteger(run.lie) || !unsealed(mine)) return null
  return {
    title: run.article?.title ?? null,
    you: mine.skipped ? null : mine.pick === run.lie,
    youMs: Number.isFinite(mine.ms) ? mine.ms : null,
    judges: (run.lanes ?? [])
      .filter((ln) => typeof ln.found === 'boolean')
      .map((ln) => ({ label: ln.label, kind: ln.kind, found: ln.found, ms: Number.isFinite(ln.ms) ? ln.ms : null })),
  }
}

/**
 * The session's tally over its rounds (entries, oldest first): the visitor's
 * finds of the rounds they guessed, and each judge's, by label.
 * @returns {{rounds: number, you: {found: number, played: number, ms: number|null},
 *            judges: {label: string, kind: string, found: number, rounds: number, ms: number|null}[]}}
 */
export function tallyOf(entries) {
  const list = (entries ?? []).filter(Boolean)
  const guessed = list.filter((e) => e.you !== null && e.you !== undefined)
  const yourMs = guessed.map((e) => e.youMs).filter(Number.isFinite)
  const byLabel = new Map()
  for (const e of list) {
    for (const j of e.judges ?? []) {
      const t = byLabel.get(j.label) ?? { label: j.label, kind: j.kind, found: 0, rounds: 0, msSum: 0, msN: 0 }
      t.rounds += 1
      t.found += j.found ? 1 : 0
      if (Number.isFinite(j.ms)) {
        t.msSum += j.ms
        t.msN += 1
      }
      byLabel.set(j.label, t)
    }
  }
  return {
    rounds: list.length,
    you: {
      found: guessed.filter((e) => e.you).length,
      played: guessed.length,
      ms: yourMs.length ? yourMs.reduce((a, b) => a + b, 0) / yourMs.length : null,
    },
    judges: [...byLabel.values()].map(({ msSum, msN, ...t }) => ({ ...t, ms: msN ? msSum / msN : null })),
  }
}
