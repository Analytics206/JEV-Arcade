/* WikiRace — the tested pure half of the page (docs/design.md, "The page").
 *
 * The server owns the race; this file owns how the page reads it. `applyEvent` is
 * the one place a streamed change becomes state, and it mirrors the engine's own
 * three mutators (a lane patch, a step, a race patch) exactly — the snapshot a page
 * attaches with and the events after it must add up to what the server holds.
 *
 * Plain data in, plain data out: no DOM and no Preact here, so `node --test
 * tests/js` imports this file exactly as the browser does.
 */

/* ── Shapes, as /api/* sends them ──────────────────────────────────────────── */

/**
 * @typedef {'none'|'low'|'medium'|'high'|'xhigh'|'max'} Thinking
 *
 * @typedef {object} Provider  One of the five who can race (GET /api/models).
 * @property {string} id                anthropic | openai | openrouter | ollama | typesafe
 * @property {string} label
 * @property {'text'|'judgment'} kind
 * @property {boolean} configured       its key (Ollama: its URL) is set
 * @property {boolean} available        it can race now (Ollama: it answered)
 * @property {string|null} reason       what to fix when it cannot
 * @property {string|null} thinking     `<PROVIDER>_THINKING`
 * @property {boolean} custom_models    a lane may name a model id it does not list
 * @property {string|null} url
 * @property {string|null} key_source
 *
 * @typedef {object} RaceModel
 * @property {string} key               `provider:model_id`, split at the FIRST colon
 * @property {string} provider
 * @property {string} model_id
 * @property {string} label
 * @property {'text'|'judgment'} kind   `text` answers in words and can foul;
 *                                      `judgment` scores the page's own links
 * @property {string|null} thinking     its configured level (`@level`, provider, global)
 * @property {boolean} available
 * @property {string|null} reason
 * @property {{input: number, output: number}|null} [price]  USD per million tokens
 * @property {boolean|null} [thinks]    from Ollama, when it says
 * @property {number|null} [context]    from Ollama, when it says
 * @property {string} [note]
 * @property {boolean} [custom]         made up here for a typed-in id; the server never sends it
 *
 * @typedef {object} ModelsResponse
 * @property {Provider[]} providers
 * @property {RaceModel[]} models
 * @property {string[]} thinking_levels
 * @property {string|null} thinking     WIKIRACE_THINKING
 * @property {string[]} warnings        configuration values that were ignored
 *
 * @typedef {'ok'|'off_page'|'teleport'|'no_pick'|'dead_link'} Verdict
 * @typedef {'waiting'|'thinking'|'rate_limited'|'moving'|'finished'|'dnf'|'dq'|'error'|'stopped'} LaneStatus
 * @typedef {'running'|'finished'|'stopped'|'interrupted'} RaceStatus
 *
 * @typedef {object} Step  One turn: a move, or a foul.
 * @property {number} turn
 * @property {string} from
 * @property {number} links
 * @property {string|null} claimed
 * @property {string} reason
 * @property {Verdict} verdict
 * @property {string|null} link          the page's own spelling of the link followed
 * @property {string|null} to            where the move landed, after redirects; null on a foul
 * @property {string|null} note
 * @property {boolean} revisit
 * @property {number} tokens_in
 * @property {number} tokens_out
 * @property {number|null} cost
 * @property {number} latency_ms
 * @property {number} at_ms               from the race's start to when this turn ended
 * @property {object|null} detail         judgment: {confidence, options, rounds, asks, model, top};
 *                                        text: any of {stop_reason, thinking_sent, links_shown}
 *
 * @typedef {object} Lane
 * @property {number} index
 * @property {string} key
 * @property {string} label
 * @property {string} provider
 * @property {string} model_id
 * @property {'text'|'judgment'} kind
 * @property {string|null} thinking          the level it runs on (null: none sent)
 * @property {string|null} [thinking_request] what was asked (null: the configured one)
 * @property {LaneStatus} status
 * @property {string|null} note
 * @property {string} page
 * @property {number} hops
 * @property {number} strikes
 * @property {number} revisits
 * @property {{off_page: number, teleport: number, no_pick: number}} fouls
 * @property {number} tokens_in
 * @property {number} tokens_out
 * @property {number|null} cost              null: unknown
 * @property {boolean} cost_estimated
 * @property {number} think_ms
 * @property {number|null} elapsed_ms
 * @property {number|null} turn_started_ms  epoch ms while thinking
 * @property {number|null} finish_order
 * @property {number|null} rank
 * @property {Step[]} [steps]                absent in the history list, which carries no replays
 *
 * @typedef {{title: string, description: string, input?: string, links?: number}} Subject
 * @typedef {{max_hops: number, strikes: number, time_limit_s: number, max_links: number}} Rules
 *
 * @typedef {object} Race
 * @property {string} id
 * @property {RaceStatus} status
 * @property {string} created_at
 * @property {number} started_ms
 * @property {string|null} finished_at
 * @property {Subject} start
 * @property {Subject} target
 * @property {Rules} rules
 * @property {number[]} ranking
 * @property {number|null} winner
 * @property {Lane[]} lanes
 *
 * @typedef {{type: 'snapshot', race: Race}
 *   | {type: 'lane', lane: number, patch: Partial<Lane>}
 *   | {type: 'step', lane: number, step: Step}
 *   | {type: 'race', patch: Partial<Race>}
 *   | {type: 'end'}} RaceEvent
 */

/* ── The reducer ───────────────────────────────────────────────────────────── */

/** One streamed change applied to the race. Never mutates its input.
 *  @param {Race|null} race  @param {RaceEvent} ev  @returns {Race|null} */
export function applyEvent(race, ev) {
  switch (ev?.type) {
    case 'snapshot':
      return ev.race
    case 'end':
      return race
    case 'race':
      return race ? { ...race, ...ev.patch } : race
    case 'lane':
      return race ? withLane(race, ev.lane, (ln) => ({ ...ln, ...ev.patch })) : race
    case 'step':
      return race ? withLane(race, ev.lane, (ln) => ({ ...ln, steps: [...(ln.steps ?? []), ev.step] })) : race
    default:
      return race
  }
}

function withLane(race, i, fn) {
  if (!race.lanes[i]) return race
  return { ...race, lanes: race.lanes.map((ln, j) => (j === i ? fn(ln) : ln)) }
}

/* ── Reading a race ────────────────────────────────────────────────────────── */

export const LIVE_LANE = ['waiting', 'thinking', 'rate_limited', 'moving']

export const isLive = (ln) => LIVE_LANE.includes(ln.status)

/** Start … current article, as the lane travelled it. */
export function pathOf(lane, start) {
  return [start, ...(lane.steps ?? []).filter((s) => s.verdict === 'ok' && s.to).map((s) => s.to)]
}

const FOUL_KINDS = new Set(['off_page', 'teleport', 'no_pick'])

/** Every foul in the race, in the order they happened — the cheat log. */
export function foulsOf(race) {
  const out = []
  for (const ln of race.lanes) {
    for (const s of ln.steps ?? []) {
      if (!FOUL_KINDS.has(s.verdict)) continue
      out.push({
        lane: ln.index, label: ln.label, turn: s.turn, kind: s.verdict,
        claimed: s.claimed, from: s.from, note: s.note ?? '', at_ms: s.at_ms,
      })
    }
  }
  return out.sort((a, b) => a.at_ms - b.at_ms || a.lane - b.lane)
}

export const foulCount = (ln) => ln.fouls.off_page + ln.fouls.teleport + ln.fouls.no_pick

/** Cheats, as distinct from a reply that named nothing. */
export const cheatCount = (ln) => ln.fouls.off_page + ln.fouls.teleport

/** Milliseconds the race has been running — its own clock once it is over. */
export function raceElapsed(race, now) {
  if (race.status === 'running') return Math.max(0, now - race.started_ms)
  const ends = race.lanes.map((ln) => ln.elapsed_ms ?? 0)
  return Math.max(0, ...ends)
}

/** A lane's own clock: frozen at its finish, running while it races. */
export function laneElapsed(lane, race, now) {
  if (lane.elapsed_ms != null) return lane.elapsed_ms
  return race.status === 'running' ? Math.max(0, now - race.started_ms) : 0
}

/** How long the current turn has been thinking, or null when it is not. A
 *  rate-limited wait is not thinking, so it does not count here. */
export function turnElapsed(lane, now) {
  if (lane.status !== 'thinking' || lane.turn_started_ms == null) return null
  return Math.max(0, now - lane.turn_started_ms)
}

/* ── Words and numbers ─────────────────────────────────────────────────────── */

export const STATUS_LABEL = {
  waiting: 'on the line',
  thinking: 'thinking',
  rate_limited: 'rate-limited',
  moving: 'following link',
  finished: 'finished',
  dnf: 'did not finish',
  dq: 'disqualified',
  error: 'error',
  stopped: 'stopped',
}

/** @returns {'neutral'|'ok'|'warn'|'err'|'live'|'accent'} */
export function statusTone(s) {
  if (s === 'finished') return 'ok'
  if (s === 'dq' || s === 'error') return 'err'
  if (s === 'dnf' || s === 'stopped' || s === 'rate_limited') return 'warn'
  if (s === 'thinking' || s === 'moving') return 'live'
  return 'neutral'
}

export const VERDICT = {
  ok: { label: 'move', glyph: '→', tone: 'ok' },
  off_page: { label: 'link not on page', glyph: '✕', tone: 'err' },
  teleport: { label: 'jumped to the target', glyph: '⤳', tone: 'err' },
  no_pick: { label: 'no pick', glyph: '?', tone: 'warn' },
  dead_link: { label: 'dead link', glyph: '∅', tone: 'neutral' },
}

/** 1,234 — one grouping everywhere, because every other word on the page is English. */
export const fmtInt = (n) => Math.round(n).toLocaleString('en-US')

const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`

/** 0.8s · 42s · 3:05 · 1:02:07 */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** 940 · 12.3k · 1.24M */
export function fmtTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** $0.0042 · ≈$1.23 · — ; `≈` marks a list-price estimate rather than a billed cost. */
export function fmtCost(cost, estimated = false) {
  if (cost == null || !Number.isFinite(cost)) return '—'
  const digits = cost < 0.01 ? 4 : cost < 1 ? 3 : 2
  return `${estimated ? '≈' : ''}$${cost.toFixed(digits)}`
}

/** A local model costs nothing, and "$0.0000" would read like a rounding. */
const isLocalFree = (ln) => ln.provider === 'ollama' && !ln.cost

/** A lane's cost as the cards and the results show it. */
export function fmtLaneCost(ln) {
  return isLocalFree(ln) ? '$0 · local' : fmtCost(ln.cost, ln.cost_estimated)
}

/** Where a lane's cost comes from, in words, for its hover text. */
export function costTitle(ln) {
  if (isLocalFree(ln)) return 'Free: the model runs on your own Ollama'
  if (ln.cost == null) return 'The provider reports no cost and there is no list price for this model'
  return ln.cost_estimated ? 'Estimated at list price — the provider reported none' : 'As billed by the provider'
}

export function wikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

/** A probability to two decimals — how Jev's own reasons print them. */
export const fmtP = (p) => (Number.isFinite(p) ? p.toFixed(2) : '—')

/**
 * Parse a server timestamp to epoch ms, or NaN. A stamp without a zone is UTC
 * (SQLite's own format); JS would read it as local time, silently, and always in
 * the direction that makes a race look like it happened in the future.
 */
export function parseStamp(iso) {
  if (!iso) return NaN
  return Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
}

/** Compact relative time for the history: 42s · 5m · 3h · 2d. */
export function ago(iso, now = Date.now()) {
  const t = parseStamp(iso)
  if (Number.isNaN(t)) return '—'
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

/** The words a failed request shows: the server's `detail` — a sentence, or
 *  FastAPI's list of field errors — else the body as it came, else *fallback*. */
export function detailOf(body, fallback) {
  let detail = typeof body === 'string' ? body : ''
  try {
    const d = JSON.parse(detail)?.detail
    if (typeof d === 'string' && d) detail = d
    else if (Array.isArray(d) && d.length) {
      detail = d
        .map((x) => {
          if (!x || typeof x !== 'object') return String(x)
          const where = Array.isArray(x.loc) ? x.loc.filter((p) => p !== 'body').join('.') : ''
          return where ? `${where}: ${x.msg}` : String(x.msg)
        })
        .join('; ')
    }
  } catch {
    /* not JSON: the body as it is */
  }
  detail = detail.trim()
  // An HTML error page from a proxy is not a sentence; keep it from flooding the rail.
  return detail ? (detail.length > 300 ? `${detail.slice(0, 300)}…` : detail) : fallback
}

/* ── A step, read out ──────────────────────────────────────────────────────── */

const clamp01 = (p) => (Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0)

/** Jev's evidence for one move, as the bars draw it: each of its top options with
 *  its probability (0–1, so a bar's length is the probability itself), and the one
 *  it followed marked. Empty for a text step. */
export function topOptions(step) {
  const top = step?.detail?.top
  if (!Array.isArray(top) || !top.length) return []
  const chosen = step.link ?? step.claimed
  return top.map((o) => ({ title: String(o?.title ?? ''), p: clamp01(Number(o?.p)), chosen: o?.title === chosen }))
}

/** "confidence 0.16 · 395 options · 2 rounds · 2 requests" — a judgment step's
 *  numbers, where a text step has its reason. */
export function judgmentSummary(detail) {
  if (!detail || typeof detail !== 'object') return ''
  const parts = []
  if (Number.isFinite(detail.confidence)) parts.push(`confidence ${fmtP(detail.confidence)}`)
  if (Number.isFinite(detail.options)) parts.push(plural(detail.options, 'option'))
  if (Number.isFinite(detail.rounds)) parts.push(plural(detail.rounds, 'round'))
  if (Number.isFinite(detail.asks)) parts.push(plural(detail.asks, 'request'))
  return parts.join(' · ')
}

/** What was sent as thinking, as one short phrase: a string as it came, an object
 *  as `key=value` pairs. */
function fmtSent(v) {
  if (v == null || v === '' || v === false) return ''
  if (typeof v !== 'object') return String(v)
  return Object.entries(v)
    .map(([k, x]) => `${k}=${x !== null && typeof x === 'object' ? JSON.stringify(x) : x}`)
    .join(' ')
}

/** What a text step's meta line adds after its numbers: why the reply stopped when
 *  that was not a normal stop, the thinking actually sent, and — when a local
 *  model's window could not hold the whole page — how many links it saw. */
export function stepNotes(step) {
  const d = step?.detail
  if (!d || typeof d !== 'object') return []
  const out = []
  if (typeof d.stop_reason === 'string' && d.stop_reason) out.push(`stopped: ${d.stop_reason}`)
  const sent = fmtSent(d.thinking_sent)
  if (sent) out.push(`sent ${sent}`)
  if (Number.isFinite(d.links_shown)) {
    if (!Number.isFinite(step.links)) out.push(`saw the first ${fmtInt(d.links_shown)} links`)
    else if (d.links_shown < step.links) out.push(`saw the first ${fmtInt(d.links_shown)} of ${fmtInt(step.links)} links`)
  }
  return out
}

/** 1st · 2nd · 3rd · 4th · 11th · 22nd — a rank as the podium badges print it. */
export function ordinal(n) {
  const k = Math.round(n)
  const teen = k % 100 >= 11 && k % 100 <= 13
  const suffix = teen ? 'th' : ['th', 'st', 'nd', 'rd'][k % 10] ?? 'th'
  return `${k}${suffix}`
}

/**
 * The sign over the page when a race ends in front of you: who won, by the
 * race's own ranking (`race.winner`), and how many hops it took — or, when
 * nobody reached the target, GAME OVER. `lane` is the winner's index, or null.
 */
export function raceFinale(race) {
  const w = race.winner != null ? race.lanes[race.winner] : null
  if (!w) return { win: false, lane: null, headline: 'GAME OVER', sub: `Nobody reached ${race.target.title}.` }
  const hops = `${fmtInt(w.hops)} hop${w.hops === 1 ? '' : 's'}`
  const headline = race.lanes.length > 1 ? `PLAYER ${w.index + 1} WINS!` : 'FINISHED!'
  const when = Number.isFinite(w.elapsed_ms) ? ` in ${fmtDuration(w.elapsed_ms)}` : ''
  const first = race.lanes.length > 1 ? 'first to' : 'reached'
  return { win: true, lane: w.index, headline, sub: `${w.label} — ${first} ${race.target.title}${when}, ${hops}` }
}

/** The line under a racer's name: who runs it, and the thinking it runs on. */
export function laneSub(ln) {
  const who = ln.kind === 'judgment' ? `${ln.provider} · judgment` : ln.provider
  return ln.thinking ? `${who} · thinking ${ln.thinking}` : who
}

/* ── The setup form ────────────────────────────────────────────────────────── */

export const MAX_LANES = 4

/**
 * @typedef {object} LaneDraft  One racer in the setup.
 * @property {string} key       `provider:model_id`; '' before a model is picked
 * @property {''|string} thinking  '' is the configured level (sent as null)
 * @property {boolean} [custom] the person chose "Custom model id…" and is typing one
 *
 * @typedef {{start: string, target: string, lanes: LaneDraft[], rules: Rules}} Setup
 */

export const DEFAULT_RULES = { max_hops: 12, strikes: 3, time_limit_s: 600, max_links: 0 }

/** Each rule's range, as POST /api/races checks it. */
export const RULE_RANGE = { max_hops: [1, 40], strikes: [1, 10], time_limit_s: [30, 3600], max_links: [0, 10_000] }

/** A rule's value inside its range; a blank or junk entry is the lowest. */
export function clampRule(k, v) {
  const [lo, hi] = RULE_RANGE[k]
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo
}

/** Rules from anywhere (a saved setup, a rematch) that the server will take. */
export function sanitizeRules(r) {
  const out = {}
  for (const k of Object.keys(DEFAULT_RULES)) {
    const v = r && typeof r === 'object' ? r[k] : undefined
    out[k] = v != null && v !== '' && Number.isFinite(Number(v)) ? clampRule(k, v) : DEFAULT_RULES[k]
  }
  return out
}

/** A select's preset values, plus the current one when it is not a preset (a
 *  rematch of a race run with other rules) — or the select would show a lie. */
export function withValue(options, value) {
  return options.includes(value) ? options : [...options, value]
}

/** MediaWiki's own title rule: spaces for underscores, single-spaced, the first
 *  letter upper-case — and case-sensitive after it ("AIDS" is not "Aids"). */
export function normalizeTitle(title) {
  const t = title.replace(/_/g, ' ').split(/\s+/).filter(Boolean).join(' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** `provider:model_id`, split at the FIRST colon — `ollama:qwen3.5:9b` is
 *  Ollama's `qwen3.5:9b`, exactly as the server splits it. */
export function splitKey(key) {
  const i = key.indexOf(':')
  return i === -1 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)]
}

/** The lane key for a typed-in model id. */
export const customKey = (provider, id) => `${provider}:${String(id).trim()}`

const providerById = (info, id) => (info?.providers ?? []).find((p) => p.id === id) ?? null

/** Where the "Custom model id…" choice is offered: an available provider that
 *  races any model id it is given. TypeSafe takes only its listed models. */
export const takesCustom = (p) => !!(p && p.custom_models && p.available)

/** What a racer in the setup races as: its listed model — or, for an id typed in,
 *  one made up from its provider, which is what the server does with it. Null
 *  when it names nothing that can be raced. */
export function laneModel(lane, info) {
  const listed = (info?.models ?? []).find((m) => m.key === lane.key)
  if (listed) return listed
  const [pid, model_id] = splitKey(lane.key)
  const p = providerById(info, pid)
  if (!p?.custom_models) return null
  return {
    key: lane.key, provider: p.id, model_id, label: model_id, kind: p.kind,
    thinking: p.thinking ?? info?.thinking ?? null, available: p.available, reason: p.reason,
    price: null, custom: true,
  }
}

/** A racer shows the model-id box when the person asked for it, or when its key
 *  is not on the list but its provider takes it (a saved line-up, a rematch). */
export function isCustomLane(lane, info) {
  if (lane.custom) return true
  return !!laneModel(lane, info)?.custom
}

const providerLabel = (info, id) => providerById(info, id)?.label ?? id

/** Why the race cannot start yet, or null.
 *  @param {Setup} setup  @param {ModelsResponse|null} info */
export function setupProblem(setup, info) {
  const start = normalizeTitle(setup.start)
  const target = normalizeTitle(setup.target)
  if (!start) return 'Pick a starting article.'
  if (!target) return 'Pick a target article.'
  if (start === target) return 'Start and target are the same article.'
  if (!setup.lanes.length) return 'Add at least one racer.'
  if (setup.lanes.length > MAX_LANES) return `At most ${MAX_LANES} racers.`
  for (const [i, ln] of setup.lanes.entries()) {
    const m = laneModel(ln, info)
    if (!m) return `Racer ${i + 1} has no model.`
    if (!m.model_id) return `Racer ${i + 1}: type the ${providerLabel(info, m.provider)} model id.`
    if (!m.available) return `${m.label} cannot race: ${m.reason ?? 'unavailable'}.`
  }
  return null
}

/** The body POST /api/races takes. A thinking left at the configured level is
 *  sent as null, so the server's configuration decides it, not this page. */
export function raceBody(setup) {
  return {
    start: setup.start.trim(),
    target: setup.target.trim(),
    lanes: setup.lanes.map((ln) => ({ key: ln.key, thinking: ln.thinking || null })),
    rules: setup.rules,
  }
}

/** A finished race's line-up, back in the setup. The thinking the person ASKED
 *  for: `thinking` is what it resolved to, and bringing that back would pin the
 *  configured level of the day instead of following the configuration. */
export function rematchLanes(race) {
  return race.lanes.map((ln) => ({ key: ln.key, thinking: ln.thinking_request ?? '' }))
}

/** The per-racer thinking choices: first the configured level (sent as null),
 *  then every level the server takes. */
export function thinkingOptions(levels, configured) {
  return [
    ['', configured ? `thinking: ${configured} (configured)` : 'thinking: model default'],
    ...(levels ?? []).map((l) => [l, `thinking: ${l}`]),
  ]
}

/** One line per model in the picker: long ids stay whole, and a model that
 *  cannot race says why. */
export function optionLabel(m) {
  let s = m.label
  if (m.label !== m.model_id) s += ` (${m.model_id})`
  if (m.kind === 'judgment') s += ' — judgment'
  else if (m.thinking) s += ` · thinking ${m.thinking}`
  if (!m.available) s += ` — ${m.reason ?? 'unavailable'}`
  return s
}

/** The picker's hover text: the option line, then price, window and note. */
export function modelHint(m) {
  const bits = [optionLabel(m)]
  if (m.price && Number.isFinite(m.price.input)) {
    bits.push(
      m.price.input === 0 && m.price.output === 0
        ? 'free (local)'
        : `$${m.price.input} in / $${m.price.output} out per million tokens`,
    )
  }
  if (Number.isFinite(m.context)) bits.push(`${fmtTokens(m.context)} context`)
  if (m.thinks === true) bits.push('thinks')
  if (m.note) bits.push(m.note)
  return bits.join(' · ')
}

export const POOLS = [
  ['classic', 'Classic'],
  ['trending', 'Trending'],
  ['wild', 'Wild'],
]

/** What a returning visitor gets back: the last line-up, rules and pool. Not
 *  the subjects — a new visit is a new race.
 *  @typedef {{lanes: LaneDraft[], rules: Rules, pool: string}} Saved */

const SETUP_KEY = 'wikirace.setup.v1'

/** The saved setup, or null. *store* is any Storage (tests pass their own);
 *  the default is looked up inside the try, because merely touching
 *  localStorage throws where site data is blocked. */
export function loadSaved(store) {
  try {
    const raw = (store ?? globalThis.localStorage)?.getItem(SETUP_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!Array.isArray(s?.lanes)) return null
    return {
      lanes: s.lanes
        .filter((l) => typeof l?.key === 'string')
        .slice(0, MAX_LANES)
        .map((l) => ({ key: l.key, thinking: typeof l.thinking === 'string' ? l.thinking : '', ...(l.custom ? { custom: true } : {}) })),
      rules: sanitizeRules(s.rules),
      pool: s.pool === 'trending' || s.pool === 'wild' ? s.pool : 'classic',
    }
  } catch {
    return null
  }
}

export function saveSaved(s, store) {
  try {
    ;(store ?? globalThis.localStorage)?.setItem(SETUP_KEY, JSON.stringify(s))
  } catch {
    /* private mode, blocked or full: the page still works, it just forgets */
  }
}

/** The picker's providers, in this order; one the page does not know goes last. */
export const PROVIDER_ORDER = ['anthropic', 'openai', 'openrouter', 'ollama', 'typesafe']

/** Models grouped for the picker: one group per provider, in PROVIDER_ORDER, each
 *  saying whether it offers "Custom model id…". A provider that takes typed-in ids
 *  gets its group even when it lists nothing. */
export function groupModels(models, providers = []) {
  const byId = new Map(providers.map((p) => [p.id, p]))
  const groups = new Map()
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m])
  for (const p of providers) if (takesCustom(p) && !groups.has(p.id)) groups.set(p.id, [])
  const rank = (id) => {
    const i = PROVIDER_ORDER.indexOf(id)
    return i === -1 ? PROVIDER_ORDER.length : i
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([id, ms]) => ({ provider: id, label: byId.get(id)?.label ?? id, models: ms, custom: takesCustom(byId.get(id)) }))
}

/**
 * A first line-up for a fresh page: up to three text models from different
 * providers, then Jev when it can race — so the default race is the comparison
 * the page exists for, not four copies of one vendor.
 */
export function defaultLanes(models) {
  const ok = models.filter((m) => m.available)
  const picked = []
  const providers = new Set()
  for (const m of ok.filter((m) => m.kind === 'text')) {
    if (providers.has(m.provider)) continue
    providers.add(m.provider)
    picked.push(m)
    if (picked.length === 3) break
  }
  const judge = ok.find((m) => m.kind === 'judgment')
  if (judge) picked.push(judge)
  return picked.slice(0, MAX_LANES).map((m) => ({ key: m.key, thinking: '' }))
}

/** Once the models are known, drop racers whose model is gone — a typed-in id
 *  stays while its provider still takes one — and give a first visit (or one whose
 *  line-up vanished) a line-up that spans providers. */
export function reconcileLanes(lanes, info) {
  const known = lanes.filter((l) => l.key === '' || laneModel(l, info))
  return known.length ? known : defaultLanes(info?.models ?? [])
}

/** A provider's dot in the setup rail: ready, down (configured, not answering), or
 *  not set up at all — which is not an error, just a provider nobody configured. */
export function providerState(p) {
  if (p.available) {
    const where = p.url ? ` at ${p.url}` : ''
    const key = p.key_source ? ` · key from ${p.key_source}` : ''
    return { tone: 'ok', title: `${p.label}: ready${where}${key}` }
  }
  const title = `${p.label}: ${p.reason ?? 'unavailable'}${p.url ? ` (${p.url})` : ''}`
  return { tone: p.configured ? 'err' : 'off', title }
}

/* ── Where the page is ─────────────────────────────────────────────────────── */

/** The page's place, from its query string: `?race=<id>` attaches to a race and
 *  `?tab=history` opens the history. */
export function parseParams(search) {
  const q = new URLSearchParams(search)
  return { tab: q.get('tab') === 'history' ? 'history' : 'race', race: q.get('race') || null }
}

/** …and back: the query string for a place, `?tab=race` for the bare setup (the
 *  bare address is the Arcade's floor). */
export function paramsSearch({ tab, race }) {
  const q = new URLSearchParams()
  if (tab === 'history') q.set('tab', 'history')
  if (race) q.set('race', race)
  const s = q.toString()
  return s ? `?${s}` : '?tab=race'
}

/* ── The race trace (chart) ────────────────────────────────────────────────── */

/**
 * @typedef {{t: number, hops: number}} TracePoint
 * @typedef {{t: number, hops: number, kind: 'foul'|'no_pick', note: string}} TraceMark
 * @typedef {object} Trace
 * @property {number} lane
 * @property {TracePoint[]} points  a step line: hop count over time, ending at the lane's end or "now"
 * @property {TraceMark[]} fouls
 * @property {{t: number, hops: number, status: LaneStatus}|null} end
 */

/** Hop count over time for every lane, for the step chart. */
export function traceOf(race, now) {
  const clock = raceElapsed(race, now)
  return race.lanes.map((ln) => {
    const points = [{ t: 0, hops: 0 }]
    const fouls = []
    let hops = 0
    for (const s of ln.steps ?? []) {
      // A legal pick whose article then failed to load is an `ok` step with
      // nowhere reached: not a hop (the lane card and pathOf agree).
      if (s.verdict === 'ok' && s.to) {
        hops += 1
        points.push({ t: s.at_ms, hops })
      } else if (s.verdict === 'ok' || s.verdict === 'dead_link') {
        continue
      } else if (s.verdict === 'no_pick') {
        fouls.push({ t: s.at_ms, hops, kind: 'no_pick', note: s.note ?? '' })
      } else {
        fouls.push({ t: s.at_ms, hops, kind: 'foul', note: s.note ?? '' })
      }
    }
    const endT = ln.elapsed_ms ?? (race.status === 'running' ? clock : points[points.length - 1].t)
    points.push({ t: Math.max(endT, points[points.length - 1].t), hops })
    const ended = !isLive(ln) && ln.elapsed_ms != null
    return { lane: ln.index, points, fouls, end: ended ? { t: endT, hops, status: ln.status } : null }
  })
}

/** Where each racer's horse stands along the trace, in px, by lane. At the head
 *  of its line — unless another horse on the same hop is already there, when it
 *  falls in behind as a bunched field, first to arrive in front — and never
 *  behind *minX*, the start line, which pushes a pack at the gate on.
 *  @param {{lane: number, x: number, hops: number, since: number}[]} heads
 *    `x` is where its line ends; `since` when it reached this hop (race ms) */
export function packHorses(heads, gap, minX) {
  const at = new Map()
  const fields = new Map()
  for (const h of heads) fields.set(h.hops, [...(fields.get(h.hops) ?? []), h])
  for (const field of fields.values()) {
    field.sort((a, b) => b.x - a.x || a.since - b.since || a.lane - b.lane)
    // Front to back: each horse no nearer than a gap behind the one ahead…
    const xs = []
    for (const h of field) xs.push(xs.length ? Math.min(h.x, xs[xs.length - 1] - gap) : h.x)
    // …then back to front: nobody behind the start line, and a horse pushed
    // forward pushes the one ahead of it.
    for (let k = xs.length - 1; k >= 0; k--) {
      xs[k] = Math.max(xs[k], k === xs.length - 1 ? minX : xs[k + 1] + gap)
    }
    field.forEach((h, k) => at.set(h.lane, xs[k]))
  }
  return at
}

/** Hops each lane had made at time *t* — the crosshair's readout. */
export function hopsAt(trace, t) {
  let hops = 0
  for (const p of trace.points) {
    if (p.t <= t) hops = p.hops
    else break
  }
  return hops
}

/** Clean y ticks: every hop up to 6, then every other, up to the top. */
export function hopTicks(max) {
  const top = Math.max(1, Math.ceil(max))
  const step = top <= 6 ? 1 : top <= 14 ? 2 : 5
  const out = []
  for (let v = 0; v <= top; v += step) out.push(v)
  if (out[out.length - 1] !== top) out.push(top)
  return out
}

/** Round-number x ticks in milliseconds for a clock that has run *ms*. */
export function timeTicks(ms) {
  const s = Math.max(1, ms / 1000)
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  const step = steps.find((x) => s / x <= 6) ?? 3600
  const out = []
  for (let v = 0; v <= s + 1e-9; v += step) out.push(v * 1000)
  return out
}

/* The chart's frame. Headroom above the top line and past the right edge: a
 * horse stands up out of its line, and a finisher's flag flies beyond its nose. */
export const TRACE_H = 228
export const TRACE_M = { top: 32, right: 34, bottom: 26, left: 34 }

/* The horse is a flat, chunky cut-out — the carnival kind, which stays a horse at
 * 37 px — drawn in a 44 × 30 box with its hooves at (22, 29), then scaled. HALF is
 * half its width on screen, GAP how close a bunched field runs. */
export const HORSE_SCALE = 0.85
export const HORSE_HALF = 22 * HORSE_SCALE
export const PACK_GAP = 24

/**
 * Everything the chart draws, in px, for a plot *width* wide: the step lines, the
 * horses (back of each bunched field first, so the one in front is drawn over it),
 * the foul marks and the ticks. The chart component only turns this into SVG.
 *
 * Lines are nudged a few pixels apart vertically: racers share hop counts all the
 * time, and exactly overlapping step lines hide one another. The values are
 * integers and the tooltip reads them exactly, so the nudge costs no accuracy.
 */
export function traceLayout(race, now, width) {
  const M = TRACE_M
  const traces = traceOf(race, now)
  const n = race.lanes.length
  const last = (tr) => tr.points[tr.points.length - 1]
  const maxT = Math.max(10_000, ...traces.map((tr) => last(tr).t))
  const maxHops = Math.max(0, ...traces.map((tr) => last(tr).hops))
  const yTop = Math.max(maxHops, Math.min(race.rules.max_hops, Math.max(maxHops + 1, 3)))
  const plotW = Math.max(40, width - M.left - M.right)
  const plotH = TRACE_H - M.top - M.bottom
  const x = (t) => M.left + (t / maxT) * plotW
  const y = (h) => M.top + plotH - (h / yTop) * plotH
  const nudge = (i) => (i - (n - 1) / 2) * 3

  const lines = traces.map((tr) => {
    const dy = nudge(tr.lane)
    const [p0, ...rest] = tr.points
    const d = rest.reduce((acc, p) => `${acc} H${x(p.t)} V${y(p.hops) + dy}`, `M${x(p0.t)} ${y(p0.hops) + dy}`)
    return { lane: tr.lane, d }
  })

  // Each horse at the head of its line, a bunched field falling in behind.
  const heads = traces.map((tr) => {
    const since = tr.points.length > 1 ? tr.points[tr.points.length - 2].t : 0
    return { lane: tr.lane, x: x(last(tr).t), hops: last(tr).hops, since }
  })
  const standAt = packHorses(heads, PACK_GAP, M.left + HORSE_HALF)
  const horses = heads
    .map((h) => ({
      lane: h.lane, hops: h.hops, x: standAt.get(h.lane) ?? h.x, y: y(h.hops) + nudge(h.lane),
      status: race.lanes[h.lane]?.status ?? 'waiting',
    }))
    .sort((a, b) => a.hops - b.hops || a.x - b.x)

  const fouls = traces.flatMap((tr) =>
    tr.fouls.map((f, k) => ({ lane: tr.lane, k, cx: x(f.t), cy: y(f.hops) + nudge(tr.lane), kind: f.kind, note: f.note })),
  )

  return {
    traces, width, H: TRACE_H, M, plotW, plotH, maxT, yTop, x, y, lines, horses, fouls,
    yTicks: hopTicks(yTop).map((h) => ({ h, y: y(h) })),
    xTicks: timeTicks(maxT).map((t) => ({ t, x: x(t) })),
  }
}

/** The race time under a pointer at px *px* across the chart, clamped to it. */
export function timeAt(layout, px) {
  return Math.min(layout.maxT, Math.max(0, ((px - layout.M.left) / layout.plotW) * layout.maxT))
}

/** Where the crosshair's tooltip sits: just right of the pointer, kept inside
 *  the chart (190 px is its widest). */
export function tipLeft(px, width) {
  return Math.min(Math.max(px + 12, 0), Math.max(0, width - 190))
}
