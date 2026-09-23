/* Customs, the pure half: the belt's geometry and every reading the page
 * draws, from the run as the server streams it (games/customs.py). No DOM and
 * no Preact, so `node --test tests/js` imports it as the browser does.
 *
 * One lane is one scanner with its own belt. A bag is on the belt (arrived,
 * not yet taken), in the scanner (the lane's `busy`), or done (in the lane's
 * `answers`); the latest done bag rides the exit belt with its stamp on.
 */

/** The belt drawing, in its own viewBox units. Bags are BAG.w × BAG.h, their
 *  bottom on the belt; x is a bag's left edge. */
export const BELT = {
  w: 1232,
  h: 214,
  beltY: 176,
  beltX0: 20,
  beltX1: 860,
  scanX: 420,
  scanW: 220,
  scanY: 40,
  forkX: 860,
  chuteX: 966,
  chuteW: 246,
  chuteH: 58,
}
export const BAG = { w: 104, h: 50 }
/** Bags drawn waiting on the belt, nearest the scanner first; the rest are a count. */
export const VISIBLE_QUEUE = 3
const SLOT_GAP = 12
/** Where a bag sits: in the scanner, and out on the exit belt. */
export const SCAN_X = BELT.scanX + (BELT.scanW - BAG.w) / 2
export const OUT_X = 700
export const BAG_Y = BELT.beltY - BAG.h

/** The chutes, top to bottom: y of each box, and where the fork meets it. */
export const CHUTES = ['pass', 'inspect', 'block']
export const chuteY = (route) => 14 + CHUTES.indexOf(route) * (BELT.chuteH + 8)
export const chuteMouth = (route) => [BELT.chuteX - 6, chuteY(route) + BELT.chuteH / 2]

/** x of the j-th waiting bag (0 is next into the scanner). */
export function slotX(j) {
  return BELT.scanX - SLOT_GAP * 1.5 - BAG.w - j * (BAG.w + SLOT_GAP)
}

/** How each route reads: its chute, tone, glyph and words. Support is an
 *  inspect with care; a foul reaches no chute. */
export const ROUTE = {
  pass: { chute: 'pass', tone: 'ok', mark: '✓', word: 'PASS', say: 'passed' },
  inspect: { chute: 'inspect', tone: 'warn', mark: '◎', word: 'INSPECT', say: 'to a human' },
  support: { chute: 'inspect', tone: 'warn', mark: '♡', word: 'INSPECT', say: 'to a human, with care' },
  block: { chute: 'block', tone: 'err', mark: '✕', word: 'BLOCK', say: 'blocked' },
  foul: { chute: null, tone: 'err', mark: '!', word: 'FOUL', say: 'no verdict (foul)' },
}
export const routeOf = (r) => ROUTE[r] ?? ROUTE.foul

/** How a bag went against its label, as a mark. */
export const VERDICT = {
  right: { tone: 'ok', mark: '✓', say: 'the right route' },
  human: { tone: 'warn', mark: '◎', say: 'to a human (0)' },
  wrong: { tone: 'err', mark: '✕', say: 'the wrong route' },
  foul: { tone: 'err', mark: '!', say: 'a foul' },
}

export const HAZARD_NAME = {
  jailbreak: 'jailbreak attempt',
  harmful: 'harmful request',
  medical: 'medical advice',
  self_harm: 'self-harm signal',
}
export const hazardShort = (h) => (h ? h.replace('_', '-') : 'none')

/** A hazard's tone against the two thresholds. */
export function hazardTone(p, review, act) {
  if (!Number.isFinite(p)) return 'cy'
  if (p >= act) return 'err'
  if (p >= review) return 'warn'
  return 'ok'
}

/** What a chute's rule says, for the lane's kind of scanner. */
export function chuteRule(route, { kind, review, act }) {
  if (kind !== 'judgment') {
    return { pass: 'the model said pass', inspect: 'the model said inspect', block: 'the model said block' }[route]
  }
  return {
    pass: `every hazard under ${review.toFixed(2)}`,
    inspect: `a human looks: ${review.toFixed(2)} to ${act.toFixed(2)}`,
    block: `a hazard at ${act.toFixed(2)}, or severe`,
  }[route]
}

/**
 * A lane's belt: the bags waiting (in arrival order), the one in its scanner,
 * and its latest done bag with that bag's answer.
 * @returns {{waiting: object[], scanning: object|null, last: {bag: object, answer: object}|null, over: number}}
 */
export function beltOf(run, lane) {
  const bags = run?.bags ?? []
  const answers = lane?.answers ?? []
  const done = new Set(answers.map((a) => a.bag))
  const busy = Number.isInteger(lane?.busy) ? lane.busy : null
  const waiting = bags.filter((b) => !done.has(b.i) && b.i !== busy)
  const scanning = busy !== null ? (bags.find((b) => b.i === busy) ?? null) : null
  const a = answers[answers.length - 1]
  const lastBag = a ? bags.find((b) => b.i === a.bag) : null
  return {
    waiting,
    scanning,
    last: lastBag ? { bag: lastBag, answer: a } : null,
    over: Math.max(0, waiting.length - VISIBLE_QUEUE),
  }
}

/**
 * Every bag the belt draws, with where it sits, in bag order (so a bag keeps
 * its place among its siblings and slides rather than jumps).
 * @returns {{bag: object, x: number, stage: 'queue'|'scan'|'out', answer?: object}[]}
 */
export function placements(belt) {
  const out = []
  belt.waiting.slice(0, VISIBLE_QUEUE).forEach((bag, j) => out.push({ bag, x: slotX(j), stage: 'queue' }))
  if (belt.scanning) out.push({ bag: belt.scanning, x: SCAN_X, stage: 'scan' })
  if (belt.last && belt.last.bag.i !== belt.scanning?.i) out.push({ bag: belt.last.bag, x: OUT_X, stage: 'out', answer: belt.last.answer })
  return out.sort((a, b) => a.bag.i - b.bag.i)
}

/** A message on a luggage tag: whole words, `lines` lines of about `per`
 *  characters, an ellipsis when it does not fit. */
export function tagLines(text, per = 15, lines = 2) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const out = []
  let cur = ''
  let i = 0
  for (; i < words.length; i++) {
    const w = words[i].length > per ? `${words[i].slice(0, per - 1)}…` : words[i]
    const next = cur ? `${cur} ${w}` : w
    if (next.length <= per) {
      cur = next
      continue
    }
    out.push(cur)
    cur = w
    if (out.length === lines) break
  }
  if (out.length < lines && cur) {
    out.push(cur)
    cur = ''
  }
  const cut = i < words.length || cur
  if (cut && out.length) {
    const lastLine = out[out.length - 1]
    out[out.length - 1] = `${lastLine.length >= per ? lastLine.slice(0, per - 1) : lastLine}…`
  }
  return out
}

/** Bags a second, over the lane's working time so far, and the time a bag. */
export function throughput(lane) {
  const answers = lane?.answers ?? []
  if (!answers.length) return { rate: null, perBag: null }
  const lastMs = Math.max(...answers.map((a) => a.done_ms ?? 0))
  const rate = lastMs > 0 ? answers.length / (lastMs / 1000) : null
  const perBag = answers.reduce((s, a) => s + (a.ms ?? 0), 0) / answers.length
  return { rate, perBag }
}

export const fmtRate = (r) => (Number.isFinite(r) ? `${r < 10 ? r.toFixed(1) : Math.round(r)} bags/s` : '—')

/** How many bags each label asks for, once the labels are out. */
export function labelTotals(labels) {
  const t = { pass: 0, inspect: 0, block: 0 }
  for (const lb of labels ?? []) if (lb && lb.route in t) t[lb.route] += 1
  return t
}

/** The hazard a Jev answer is loudest on: [name, p]. */
export function loudest(answer) {
  const hz = Object.entries(answer?.hazards ?? {})
  if (!hz.length) return null
  return hz.reduce((a, b) => (b[1] > a[1] ? b : a))
}

/** The lanes' marks for one bag: its answer on every lane, by lane index. */
export function marksFor(run, bagIndex) {
  return (run?.lanes ?? []).map((ln) => (ln.answers ?? []).find((a) => a.bag === bagIndex) ?? null)
}

/* ── Who won, and what each bag earned ─────────────────────────────────────── */

/** The game's winners: the highest score among the lanes that screened their
 *  whole belt (a lane that errored or was stopped is out). Ties share it. */
export function winnersOf(lanes) {
  const done = (lanes ?? []).filter((l) => l.status === 'done' && Number.isFinite(l.score))
  if (!done.length) return []
  const top = Math.max(...done.map((l) => l.score))
  return done.filter((l) => l.score === top).map((l) => l.index)
}

/** A miss (should block, passed) or a false alarm (should pass, blocked), by
 *  the game's own definitions, once a bag's label is known; otherwise null. */
export function alarmOf(route, label) {
  const c = routeOf(route).chute
  if (label === 'block' && c === 'pass') return 'miss'
  if (label === 'pass' && c === 'block') return 'false_alarm'
  return null
}

/** The counts a lane's alarms are read from, live. */
export const countsOf = (lane) => ({
  screened: lane?.screened ?? 0,
  missed: lane?.missed ?? 0,
  false_alarms: lane?.false_alarms ?? 0,
})

/**
 * Live, before the labels are out: whether the bag a lane has just tallied was
 * a miss or a false alarm, read off its counters moving by exactly one bag
 * since `prev` (countsOf, earlier). The server pushes a bag's answer before it
 * tallies it, so the tallied bag is the lane's latest answer. Null when it
 * cannot tell, so the page never calls out what it doesn't know.
 * @returns {{bag: number, kind: 'miss'|'false_alarm'}|null}
 */
export function alarmFromCounts(prev, lane) {
  const answers = lane?.answers ?? []
  const a = answers[answers.length - 1]
  const now = countsOf(lane)
  if (!prev || !a || now.screened - prev.screened !== 1) return null
  const c = routeOf(a.route).chute
  if (now.missed > prev.missed && c === 'pass') return { bag: a.bag, kind: 'miss' }
  if (now.false_alarms > prev.false_alarms && c === 'block') return { bag: a.bag, kind: 'false_alarm' }
  return null
}

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')

/** What a routed bag earned, as the callout over it reads: a glyph, a word
 *  and its points (from the run's own table). */
export function calloutOf(answer, alarm, points) {
  const p = points?.[answer?.verdict]
  const pts = Number.isFinite(p) ? signed(p) : ''
  switch (answer?.verdict) {
    case 'right':
      return { tone: 'ok', mark: '✓', word: 'RIGHT', pts }
    case 'human':
      return { tone: 'warn', mark: '◎', word: 'TO A HUMAN', pts }
    case 'wrong':
      return { tone: 'err', mark: '✕', word: alarm === 'miss' ? 'MISSED' : alarm === 'false_alarm' ? 'FALSE ALARM' : 'WRONG CHUTE', pts }
    case 'foul':
      return { tone: 'err', mark: '!', word: 'NO VERDICT', pts }
    default:
      return null
  }
}

/** How many bags in a row a lane has routed right, up to its latest. */
export function streakOf(lane) {
  const answers = lane?.answers ?? []
  let n = 0
  for (let i = answers.length - 1; i >= 0 && answers[i].verdict === 'right'; i--) n++
  return n
}

/** The bags a lane routed just before its latest, oldest first: the page
 *  drops each into its chute. */
export function dropsOf(lane, k = 2) {
  const answers = lane?.answers ?? []
  return answers.slice(Math.max(0, answers.length - 1 - k), Math.max(0, answers.length - 1))
}

/* ── Drawing helpers ───────────────────────────────────────────────────────── */

/** A suitcase's colour, the same for a bag on every belt. */
const SKINS = ['#3b3272', '#4b2e63', '#2c4468', '#3d3f58', '#55304a', '#2f4a57']
export const skinOf = (i) => SKINS[((i % SKINS.length) + SKINS.length) % SKINS.length]

/* What the X-ray sees inside a bag: three things, the same every time for the
 * same bag. Paths in the bag's own box (BAG.w × BAG.h). */
const THINGS = [
  (x, y) => `M${x + 3} ${y} h4 v4 l2 3 v17 a2 2 0 0 1 -2 2 h-4 a2 2 0 0 1 -2 -2 v-17 l2 -3 z`, // a bottle
  (x, y) => `M${x} ${y + 2} a2 2 0 0 1 2 -2 h10 a2 2 0 0 1 2 2 v22 a2 2 0 0 1 -2 2 h-10 a2 2 0 0 1 -2 -2 z`, // a phone
  (x, y) => `M${x} ${y + 6} h24 v16 h-24 z M${x + 12} ${y + 6} v16`, // a book, open
  (x, y) => `M${x + 6} ${y + 6} m-5 0 a5 5 0 1 0 10 0 a5 5 0 1 0 -10 0 M${x + 11} ${y + 6} h12 v4 M${x + 18} ${y + 6} v3`, // a key
  (x, y) => `M${x} ${y + 20} q4 -14 12 -12 l6 -8 h6 v14 q0 6 -6 6 z`, // a shoe
  (x, y) => `M${x} ${y + 4} h22 v14 h-22 z M${x - 3} ${y + 18} h28 v3 h-28 z`, // a laptop
]
export function xrayOf(i) {
  let s = (Math.imul((i | 0) + 1, 2654435761) >>> 0) || 1
  const rnd = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
  const kinds = []
  while (kinds.length < 3) {
    const k = Math.floor(rnd() * THINGS.length)
    if (!kinds.includes(k)) kinds.push(k)
  }
  return kinds.map((k, j) => THINGS[k](10 + j * 31, 8 + Math.floor(rnd() * 12)))
}

/** A gauge's needle angle for p (0 points left, 1 right, 0.5 straight up). */
export const dialDeg = (p) => -90 + 180 * Math.max(0, Math.min(1, Number(p) || 0))

/** A point on a gauge's arc (centre cx, cy; radius r) at value t. */
export function dialAt(cx, cy, r, t) {
  const a = Math.PI * (1 - Math.max(0, Math.min(1, t)))
  return [cx + r * Math.cos(a), cy - r * Math.sin(a)]
}
