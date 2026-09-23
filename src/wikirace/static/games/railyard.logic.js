/* Rail Yard's pure half: the yard's geometry, where a train is on its track,
 * the router against "always one station", and the chart's scales. Plain data
 * in, plain data out, so `node --test tests/js` imports it as the browser does. */

/** Tiers in order of capability, lowest first (as games/railyard.py). */
export const TIERS = ['local', 'small', 'medium', 'large']
export const RANK = Object.fromEntries(TIERS.map((t, i) => [t, i]))
/** What each tier is for, as a station's sign says it. */
export const TIER_SHORT = {
  large: 'hard reasoning, tricky code',
  medium: 'word problems, routine code',
  small: 'lookups, short answers',
  local: 'private data never leaves',
}

/**
 * Each station's tier when the player names none, as the server's default:
 * Ollama is local; the rest small to large by list price (cheapest small,
 * dearest large), in lane order when any price is unknown.
 * stations: [{provider, price: {input, output} | null}]
 */
export function defaultTiers(stations) {
  const out = stations.map((s) => (s.provider === 'ollama' ? 'local' : ''))
  const cloud = stations.map((s, i) => i).filter((i) => stations[i].provider !== 'ollama')
  const cost = (i) => (stations[i].price ? stations[i].price.input + stations[i].price.output : null)
  if (cloud.every((i) => cost(i) != null)) cloud.sort((a, b) => cost(a) - cost(b) || a - b)
  cloud.forEach((s, j) => {
    out[s] = j === cloud.length - 1 ? 'large' : j === 0 ? 'small' : 'medium'
  })
  return out
}

/* ── The yard ──────────────────────────────────────────────────────────────── */

const SWITCH_X = 540
const BEND_X = 760
const END_X = 880
/** Where the train at the front waits for the switch (its centre). */
const FRONT_X = 472
const CAR_HALF = 62

/**
 * The yard for *n* stations: the main line, the switch, one track per station
 * (a curve off the switch, then straight to its platform), the stations'
 * boxes and the queue's slots on the main line.
 */
export function yardLayout(n, { width = 1232, height = 290 } = {}) {
  const mainY = Math.round(height / 2 + 10)
  const spacing = n > 1 ? Math.min(90, (height - 70) / (n - 1)) : 0
  const tracks = Array.from({ length: Math.max(0, n) }, (_, i) => {
    const y = Math.round(mainY + (i - (n - 1) / 2) * spacing)
    const p = [
      [SWITCH_X, mainY],
      [SWITCH_X + 100, mainY],
      [SWITCH_X + 120, y],
      [BEND_X, y],
    ]
    return { y, bezier: p, d: `M${SWITCH_X} ${mainY} C${p[1].join(' ')} ${p[2].join(' ')} ${p[3].join(' ')} H${END_X}` }
  })
  const boxH = n > 3 ? 40 : 46
  return {
    width,
    height,
    mainY,
    switchX: SWITCH_X,
    main: `M0 ${mainY} H${SWITCH_X}`,
    tracks,
    stations: tracks.map((t) => ({ x: END_X + 10, y: t.y - boxH / 2, w: width - END_X - 30, h: boxH })),
    front: { x: FRONT_X - CAR_HALF, y: mainY - 26, w: CAR_HALF * 2, h: 52 },
    queue: [280, 152, 24].map((x) => ({ x, y: mainY - 22, w: 116, h: 44 })),
    tower: { x: SWITCH_X - 42, y: mainY - 112, w: 84, h: 62 },
  }
}

function cubic(p, u) {
  const v = 1 - u
  const a = v * v * v
  const b = 3 * v * v * u
  const c = 3 * v * u * u
  const d = u * u * u
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]]
}

function cubicSlope(p, u) {
  const v = 1 - u
  const dx = 3 * v * v * (p[1][0] - p[0][0]) + 6 * v * u * (p[2][0] - p[1][0]) + 3 * u * u * (p[3][0] - p[2][0])
  const dy = 3 * v * v * (p[1][1] - p[0][1]) + 6 * v * u * (p[2][1] - p[1][1]) + 3 * u * u * (p[3][1] - p[2][1])
  return (Math.atan2(dy, dx) * 180) / Math.PI
}

/** Phases of a trip: up to the switch, round the curve, along to the platform. */
const T_SWITCH = 0.12
const T_BEND = 0.72

/**
 * Where a train is at *t* (0 at the front of the queue, 1 at its station's
 * platform) on track *s*: its centre and the angle it points at, in degrees.
 */
export function trackPose(layout, s, t) {
  const tr = layout.tracks[s]
  const u = Math.max(0, Math.min(1, Number(t) || 0))
  if (!tr) return { x: FRONT_X, y: layout.mainY, angle: 0 }
  if (u <= T_SWITCH) return { x: FRONT_X + (SWITCH_X - FRONT_X) * (u / T_SWITCH), y: layout.mainY, angle: 0 }
  if (u <= T_BEND) {
    const k = (u - T_SWITCH) / (T_BEND - T_SWITCH)
    const [x, y] = cubic(tr.bezier, k)
    return { x, y, angle: cubicSlope(tr.bezier, k) }
  }
  const k = (u - T_BEND) / (1 - T_BEND)
  return { x: BEND_X + (END_X - CAR_HALF - BEND_X) * k, y: tr.y, angle: 0 }
}

/** An eased 0…1, so a train pulls away and brakes. */
export const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/**
 * A train's whole trip on track *s* as one path, for SVG motion: from the
 * front of the queue, over the switch and round the curve, to its platform.
 * The path is relative to its start {x, y}, so a train drawn at the start
 * waits there until it leaves. It ends where trackPose(…, 1) does.
 */
export function tripPath(layout, s) {
  const tr = layout.tracks[s]
  const x0 = FRONT_X
  const y0 = layout.mainY
  if (!tr) return { x: x0, y: y0, d: 'M0 0' }
  const r = ([x, y]) => `${x - x0} ${y - y0}`
  const [, p1, p2, p3] = tr.bezier
  return { x: x0, y: y0, d: `M0 0 H${SWITCH_X - x0} C${r(p1)} ${r(p2)} ${r(p3)} H${END_X - CAR_HALF - x0}` }
}

/** The line a set route lights: the main line, over the switch, down track *s* to its platform. */
export function routePath(layout, s) {
  const tr = layout.tracks[s]
  return tr ? `${layout.main} ${tr.d.slice(tr.d.indexOf('C'))}` : layout.main
}

/** Which way the switch points lie for track *s*: the angle, in degrees, from the switch towards it. */
export function bladeAngle(layout, s) {
  const tr = layout.tracks[s]
  if (!tr) return 0
  const [x, y] = cubic(tr.bezier, 0.3)
  return Math.round(((Math.atan2(y - layout.mainY, x - SWITCH_X) * 180) / Math.PI) * 10) / 10
}

/** What a train's label says of its prompt: a prompt that carries a block
 *  (code, after a blank line) is labelled by the block, its lines joined. */
export function trainText(text) {
  const parts = String(text ?? '').split(/\n\s*\n/)
  if (parts.length < 2) return String(text ?? '')
  return parts
    .slice(1)
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('; ')
}

/** The baseline the router is measured against: the top-tier station (the dearest of those). */
export function bigStation(always) {
  return [...always].sort((a, b) => (RANK[b.tier] ?? 0) - (RANK[a.tier] ?? 0) || b.cost - a.cost)[0] ?? null
}

/** How the router's cost compares with *base*'s: {share, word} ("60% cheaper", "the same cost"). */
export function costAgainst(cost, base) {
  if (!(base > 0)) return null
  const r = cost / base
  if (Math.abs(1 - r) < 0.005) return { share: 0, word: 'the same cost' }
  return r < 1 ? { share: 1 - r, word: 'cheaper' } : { share: r - 1, word: 'dearer' }
}

/** A prompt as a train's label: its words wrapped to *lines* lines of *width*, quoted, cut with an ellipsis. */
export function snippet(text, width = 17, lines = 2) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  const out = ['']
  let shown = 0
  for (const raw of words) {
    const w = raw.length > width ? `${raw.slice(0, width - 1)}…` : raw
    const line = out[out.length - 1]
    const next = line ? `${line} ${w}` : w
    if (next.length <= width) out[out.length - 1] = next
    else if (out.length < lines) out.push(w)
    else break
    shown++
  }
  if (!out[0]) return ['“”']
  const last = out.length - 1
  out[0] = `“${out[0]}`
  out[last] = shown < words.length ? `${out[last].replace(/[.,;:!?]$/, '')}…”` : `${out[last]}”`
  return out
}

/* ── The routing rule, as the page prints it ───────────────────────────────── */

export const RULE_WORDS = {
  private: 'private data: sent to the local station',
  private_no_local: 'private data, but no local station: the cheapest takes it',
  unsure_up: 'unsure: one tier up from its pick',
  unsure_top: 'unsure, but its pick is already the top tier',
  pick: 'sure: its top pick',
}

/** Which line of the printed rule a train's routing took (0, 1 or 2). */
export const ruleLine = (rule) => (rule === 'private' || rule === 'private_no_local' ? 0 : rule === 'pick' ? 2 : 1)

/* ── Router against the baselines ──────────────────────────────────────────── */

/**
 * The router against "always <station>", over the trains it has delivered so
 * far (the same prompts for every point), plus each station's own traffic.
 * @returns {{router: {n, right, accuracy, cost}, always: [{station, lane, tier, n, right, accuracy, cost}],
 *           traffic: [{received, delivered, cost, last}]}}
 */
export function yardSummary(run) {
  const stations = run?.stations ?? []
  const trains = (run?.trains ?? []).filter(Boolean)
  const done = trains.filter((t) => t.verdict)
  const ks = new Set(done.map((t) => t.k))
  const acc = (r, n) => (n ? r / n : null)
  const right = done.filter((t) => t.verdict === 'right').length
  const router = {
    n: done.length,
    right,
    accuracy: acc(right, done.length),
    cost: done.reduce((a, t) => a + (t.cost ?? 0) + (t.jev_cost ?? 0), 0),
  }
  const always = stations.map((st, s) => {
    const answers = (run.lanes?.[st.lane]?.answers ?? []).filter((a) => ks.has(a.k))
    const r = answers.filter((a) => a.verdict === 'right').length
    return {
      station: s, lane: st.lane, tier: st.tier, n: ks.size, right: r, accuracy: acc(r, ks.size),
      cost: answers.reduce((a, x) => a + (x.cost ?? 0), 0),
    }
  })
  const traffic = stations.map((_, s) => {
    const mine = trains.filter((t) => t.to === s)
    const got = mine.filter((t) => t.verdict)
    return {
      received: mine.length, delivered: got.length, right: got.filter((t) => t.verdict === 'right').length,
      cost: got.reduce((a, t) => a + (t.cost ?? 0), 0), last: got[got.length - 1] ?? null,
    }
  })
  return { router, always, traffic }
}

/**
 * The round's close, as the finale says it. Rail Yard has no winner: the tower
 * and the stations are teammates. What it has is the router against always the
 * top-tier station, over the same trains, so that is what the finale reads out.
 * Null before any train is delivered.
 * @returns {{headline: string, sub: string} | null}
 */
export function yardOutcome(run, summary) {
  const router = summary?.router
  if (!router?.n) return null
  const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')
  const big = bigStation((summary.always ?? []).filter((a) => a.accuracy != null))
  const vs = big ? costAgainst(router.cost, big.cost) : null
  const all = router.n >= (run?.total ?? Infinity)
  const parts = [`Jev's routing ${pct(router.accuracy)} right for ${fmtUsd(router.cost)}`]
  if (big) parts.push(`always ${big.tier} ${pct(big.accuracy)} for ${fmtUsd(big.cost)}`)
  if (vs) parts.push(vs.share ? `${pct(vs.share)} ${vs.word}` : vs.word)
  return { headline: all ? 'ALL TRAINS IN' : 'YARD CLOSED', sub: parts.join(' · ') }
}

/* ── The chart ─────────────────────────────────────────────────────────────── */

/** The smallest of 1, 2, 2.5 and 5 times a power of ten at or above *v*. */
export function niceCeil(v) {
  if (!(v > 0)) return 0.001
  const e = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * e >= v * (1 - 1e-9)) return m * e
  return 10 * e
}

/** Dollars, short: $0 · $0.0042 · $0.05 · $1.8 · 4.2e-7 as $4.2e-7. */
export function fmtUsd(v) {
  if (!Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  return `$${String(+v.toPrecision(2))}`
}

/**
 * Scales for quality (share right, up) against cost (right) inside the box
 * {left, right, top, bottom}: cost from $0 to a round ceiling, quality from a
 * round floor under the lowest point to 100%.
 * points: [{cost, accuracy}]
 */
export function scatterScales(points, { left = 40, right = 340, top = 20, bottom = 200 } = {}) {
  const costs = points.map((p) => p.cost).filter(Number.isFinite)
  const accs = points.map((p) => p.accuracy).filter(Number.isFinite)
  const xMax = niceCeil(Math.max(0, ...costs) * 1.08)
  const minAcc = accs.length ? Math.min(...accs) : 0.5
  let yLo = Math.max(0, Math.floor((minAcc - 0.05) * 10 + 1e-9) / 10)
  if (1 - yLo < 0.2) yLo = 0.8
  const x = (c) => left + (Math.max(0, c) / xMax) * (right - left)
  const y = (a) => bottom - ((a - yLo) / (1 - yLo)) * (bottom - top)
  const step = 1 - yLo > 0.5 ? 0.2 : 0.1
  const count = Math.round((1 - yLo) / step)
  const yTicks = Array.from({ length: count + 1 }, (_, i) => {
    const v = Math.round((1 - i * step) * 100) / 100
    return { v, at: y(v), label: `${Math.round(v * 100)}%` }
  }).filter((t) => t.v >= yLo - 1e-9)
  const xTicks = [0, xMax / 2, xMax].map((v) => ({ v, at: x(v), label: fmtUsd(v) }))
  return { x, y, xMax, yLo, xTicks, yTicks }
}
