/* Slot Machine, the pure half: the reels, the tally strip and the probability
 * band, from the run as the server streams it (games/slots.py). No DOM and no
 * Preact, so `node --test tests/js` imports it as the browser does.
 *
 * A lane's pulls land in any order (three reels spin at once); each has `n`
 * (its number) and `reel` (n mod 3). `spinning[r]` is the pull on reel r
 * that is still in flight, or null.
 */

export const LABELS = ['allow', 'warn', 'remove']
/** How an outcome reads: tone, a glyph (so it reads without colour) and its word. */
export const OUTCOME = {
  allow: { tone: 'ok', glyph: '✓', word: 'ALLOW' },
  warn: { tone: 'warn', glyph: '!', word: 'WARN' },
  remove: { tone: 'err', glyph: '✕', word: 'REMOVE' },
  uncertain: { tone: 'vi', glyph: '?', word: 'UNCERTAIN' },
  foul: { tone: 'foul', glyph: '∅', word: 'FOUL' },
}
export const outcomeOf = (o) => OUTCOME[o] ?? OUTCOME.foul

/** A lane's pulls in pull order. */
export const byPull = (lane) => [...(lane?.pulls ?? [])].sort((a, b) => a.n - b.n)

/** Each reel: spinning (and on which pull) or showing the latest pull it landed. */
export function reelsOf(lane, reels = 3) {
  const pulls = byPull(lane)
  const spinning = lane?.spinning ?? []
  return Array.from({ length: reels }, (_, r) => {
    const mine = pulls.filter((p) => p.reel === r)
    const landed = mine.length ? mine[mine.length - 1] : null
    const spin = spinning[r] ?? null
    return { reel: r, spinning: spin !== null, n: spin ?? landed?.n ?? null, pull: landed }
  })
}

/** The outcome all three reels show when they agree and none is spinning, else null. */
export function jackpot(reels) {
  if (!reels.length || reels.some((r) => r.spinning || !r.pull)) return null
  const o = reels[0].pull.outcome
  return reels.every((r) => r.pull.outcome === o) ? o : null
}

/** One chip per pull, in order: landed, spinning or still to come. */
export function chipsOf(lane, total) {
  const at = new Map((lane?.pulls ?? []).map((p) => [p.n, p]))
  const spinning = new Set((lane?.spinning ?? []).filter((n) => n !== null && n !== undefined))
  return Array.from({ length: total }, (_, n) => ({ n, pull: at.get(n) ?? null, spinning: spinning.has(n) }))
}

/** How many times the outcome changed from one pull to the next (in pull order). */
export function flips(lane) {
  const ps = byPull(lane)
  let k = 0
  for (let i = 1; i < ps.length; i++) if (ps[i].outcome !== ps[i - 1].outcome) k++
  return k
}

/** "7/15" */
export const share = (k, n) => `${Math.round((k ?? 0) * n)}/${n}`

/** A tone for an agreement share: steady, wobbly or all over the place. */
export function agreementTone(a) {
  if (!Number.isFinite(a)) return 'neutral'
  if (a >= 0.9) return 'ok'
  if (a >= 0.6) return 'warn'
  return 'err'
}

/** What the reels' latest pulls say, in words. */
export function caption(lane, threshold) {
  const pulls = byPull(lane)
  if (!pulls.length) return (lane?.spinning ?? []).some((s) => s !== null && s !== undefined) ? 'the first pull is spinning…' : 'no pulls yet'
  const last = pulls.slice(-3)
  const nums = last.map((p) => p.n + 1).join(', ')
  const p = last[last.length - 1]
  if (lane.kind !== 'judgment') {
    return `pulls ${nums} · the last said ${p.said ? `“${p.said}”` : 'nothing readable'}`
  }
  const tp = Number(p.top_p)
  const rule = tp < threshold ? `under ${threshold.toFixed(2)}, so a human decides` : `at or over ${threshold.toFixed(2)}, so it stands`
  return `pulls ${nums} · top pick ${p.top} ${tp.toFixed(2)}, ${rule}`
}

/** Each label's lowest and highest probability over the pulls, as text. */
export function spreadText(spread) {
  if (!spread) return ''
  return LABELS.map((lb) => `${lb} ${spread[lb][0].toFixed(2)}–${spread[lb][1].toFixed(2)}`).join(' · ')
}

/**
 * Jev's probabilities pull by pull, for a small chart: per label a line, a dot
 * per pull and the band from its lowest to its highest value; the threshold as
 * a line; and where a pull went to a human.
 * box: {w, h, left, right, top, bottom}
 */
export function band(lane, total, threshold, box = { w: 360, h: 110, left: 34, right: 10, top: 10, bottom: 22 }) {
  const ps = byPull(lane).filter((p) => p.p)
  const plotW = box.w - box.left - box.right
  const plotH = box.h - box.top - box.bottom
  const step = plotW / Math.max(1, total)
  const r1 = (v) => Math.round(v * 10) / 10
  const x = (n) => r1(box.left + (n + 0.5) * step)
  const y = (p) => r1(box.top + (1 - p) * plotH)
  const series = LABELS.map((lb) => {
    const pts = ps.map((p) => [x(p.n), y(p.p[lb])])
    const vals = ps.map((p) => p.p[lb])
    return {
      label: lb,
      points: pts,
      band: vals.length ? { y0: y(Math.max(...vals)), y1: y(Math.min(...vals)) } : null,
    }
  })
  return {
    series,
    threshold: y(threshold),
    uncertain: ps.filter((p) => p.outcome === 'uncertain').map((p) => x(p.n)),
    x0: box.left,
    x1: box.w - box.right,
    y,
    step,
  }
}

/** The next post's index, wrapping round. */
export const nextPost = (index, count) => (count ? (index + 1) % count : 0)

/**
 * The pulls grouped by lever: one lever pull spins `reels` pulls at once
 * (pulls n…n+reels−1 from n = lever × reels). Each group's `win` is the outcome
 * when all its reels have landed on the same one (three in a row), else null;
 * `landed` says every reel of it is in.
 */
export function leversOf(lane, total, reels = 3) {
  const chips = chipsOf(lane, total)
  const out = []
  for (let at = 0; at < chips.length; at += reels) {
    const group = chips.slice(at, at + reels)
    const landed = group.every((c) => c.pull)
    const o = landed ? group[0].pull.outcome : null
    const win = landed && group.length === reels && group.every((c) => c.pull.outcome === o) ? o : null
    out.push({ lever: at / reels, chips: group, landed, win })
  }
  return out
}

/** A lane that pulled every time and gave the same outcome on every pull. */
export const held = (lane) => (lane?.pulls ?? []).length > 0 && lane.agreement === 1

/**
 * Who won a round with two lanes or more: the steadiest verdict, the highest
 * agreement (the lane's score) among the lanes that finished every pull; a tie
 * shares it. One lane alone has no one to beat.
 */
export function steadiest(lanes) {
  if ((lanes?.length ?? 0) < 2) return []
  const done = lanes.filter((ln) => ln.status === 'done' && Number.isFinite(ln.score))
  if (!done.length) return []
  const top = Math.max(...done.map((ln) => ln.score))
  return done.filter((ln) => ln.score === top).map((ln) => ln.index)
}

/** How a lane's verdict fared, in words: "allow on all 15 pulls" or "the same
 *  verdict 9/15, changed its mind 6×". */
export function heldText(lane) {
  const n = (lane?.pulls ?? []).length
  if (!n) return 'no pulls'
  if (held(lane)) return `${lane.consensus ?? byPull(lane)[0].outcome} on all ${n} pulls`
  return `the same verdict ${share(lane.agreement, n)}, changed its mind ${flips(lane)}×`
}

/**
 * The finale's words for a finished round: `winners` (lane indexes) by
 * steadiest(); one lane alone gets VERDICT HELD or VERDICT WOBBLED instead.
 * @returns {{winners: number[], headline?: string, sub?: string}}
 */
export function finale(run) {
  const lanes = run?.lanes ?? []
  if (lanes.length === 1) {
    const ln = lanes[0]
    if (ln.status !== 'done' || !(ln.pulls ?? []).length) return { winners: [] }
    return { winners: [], headline: held(ln) ? 'VERDICT HELD' : 'VERDICT WOBBLED', sub: `${ln.label}: ${heldText(ln)}`, win: held(ln) }
  }
  const winners = steadiest(lanes)
  const won = winners.map((i) => lanes.find((ln) => ln.index === i))
  if (won.length === 1) return { winners, sub: `${won[0].label}: ${heldText(won[0])}` }
  if (won.length > 1) {
    const n = (won[0].pulls ?? []).length
    return { winners, sub: `${won.map((ln) => ln.label).join(' · ')}: equally steady, the same verdict ${share(won[0].agreement, n)}` }
  }
  return { winners }
}
