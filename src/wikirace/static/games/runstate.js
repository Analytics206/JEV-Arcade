/* The Arcade's pure half: how a streamed game run becomes state, and the small
 * readings every game's page shares. Plain data in, plain data out — no DOM and
 * no Preact — so `node --test tests/js` imports this file as the browser does.
 *
 * `applyRunEvent` mirrors the server's mutators (games/runs.py) exactly: a
 * snapshot, a top-level patch, a lane patch, and appends and replacements in a
 * list, top-level or a lane's.
 */

/** A run's state after one streamed event. Unknown events change nothing. */
export function applyRunEvent(run, ev) {
  if (!ev || typeof ev !== 'object') return run
  if (ev.type === 'snapshot') return ev.run ?? run
  if (!run) return run
  switch (ev.type) {
    case 'patch':
      return { ...run, ...ev.patch }
    case 'lane':
      return { ...run, lanes: run.lanes.map((ln, i) => (i === ev.lane ? { ...ln, ...ev.patch } : ln)) }
    case 'push':
      return { ...run, [ev.key]: [...(run[ev.key] ?? []), ev.item] }
    case 'put': {
      const list = [...(run[ev.key] ?? [])]
      list[ev.index] = ev.item
      return { ...run, [ev.key]: list }
    }
    case 'lane_push':
      return {
        ...run,
        lanes: run.lanes.map((ln, i) => (i === ev.lane ? { ...ln, [ev.key]: [...(ln[ev.key] ?? []), ev.item] } : ln)),
      }
    default:
      return run
  }
}

export const RUN_LIVE = 'running'
export const isRunLive = (run) => !!run && run.status === RUN_LIVE
export const LANE_ENDED = ['done', 'error', 'stopped']
export const isLaneLive = (ln) => !LANE_ENDED.includes(ln.status)

export const LANE_STATUS = {
  waiting: 'waiting',
  playing: 'playing',
  rate_limited: 'rate-limited',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
}
export const RUN_STATUS = {
  running: 'running',
  finished: 'finished',
  stopped: 'stopped',
  error: 'error',
  interrupted: 'interrupted',
}

/** Badge tone for a lane's or a run's status. */
export function statusToneOf(status) {
  if (status === 'playing' || status === 'running') return 'live'
  if (status === 'rate_limited' || status === 'stopped' || status === 'interrupted') return 'warn'
  if (status === 'error') return 'err'
  if (status === 'done' || status === 'finished') return 'ok'
  return 'neutral'
}

/** A lane's cost as shown: `$0.0042`, `≈$0.0042` at list price, `$0` for a local
 *  model, `—` when nothing is known. */
export function laneCostText(ln) {
  if (!ln) return '—'
  const c = Number(ln.cost) || 0
  if (c === 0 && ln.cost_unknown) return '—'
  if (c === 0 && ln.provider === 'ollama') return '$0 · local'
  const approx = ln.cost_estimated ? '≈' : ''
  const more = ln.cost_unknown ? '+' : ''
  if (c === 0) return `${approx}$0`
  const digits = c < 0.01 ? 4 : c < 1 ? 3 : 2
  return `${approx}$${c.toFixed(digits)}${more}`
}

/** Milliseconds as a person reads a short span: 120 ms · 1.4 s · 2m 5s. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/** Average time per call for a lane. */
export const perCall = (ln) => (ln && ln.calls ? ln.think_ms / ln.calls : NaN)

/** A probability as the page writes it: 0.83. */
export const fmtProb = (p) => (Number.isFinite(p) ? p.toFixed(2) : '—')

/** A share as a percent: 92%. */
export const fmtPct = (x, digits = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—')

/* ── Players ───────────────────────────────────────────────────────────────── */

/** The players a game's setup starts with: Jev first when it may play, then the
 *  first available text models, up to *count* lanes in all. */
export function defaultPlayers(models, { kinds = ['judgment', 'text'], count = 2, jev = true } = {}) {
  const avail = (models ?? []).filter((m) => m.available && kinds.includes(m.kind))
  const out = []
  if (jev) {
    const j = avail.find((m) => m.kind === 'judgment')
    if (j) out.push({ key: j.key })
  }
  for (const m of avail) {
    if (out.length >= count) break
    if (m.kind === 'text' && !out.some((o) => o.key === m.key)) out.push({ key: m.key })
  }
  return out.slice(0, Math.max(1, count))
}

/** The lanes a run asks for, as the API reads them. */
export const lanesBody = (lanes) => lanes.filter((l) => l.key).map((l) => ({ key: l.key }))

/** What is wrong with a set of players for a game, or null. `game` is the
 *  server's game listing (GET /api/games). */
export function playersProblem(lanes, game, models) {
  const chosen = lanes.filter((l) => l.key)
  const min = game?.lanes?.min ?? 1
  const max = game?.lanes?.max ?? 4
  if (chosen.length < min) return min === 1 ? 'Pick a player.' : `Pick at least ${min} players.`
  if (chosen.length > max) return `At most ${max} players.`
  const byKey = new Map((models ?? []).map((m) => [m.key, m]))
  for (const l of chosen) {
    const m = byKey.get(l.key)
    if (m && !m.available) return `${m.model_id} cannot play: ${m.reason ?? 'unavailable'}`
    if (m && game?.kinds && !game.kinds.includes(m.kind)) return `${m.model_id} has no seat in this game.`
  }
  if (game?.needs_jev && !chosen.some((l) => (byKey.get(l.key)?.kind ?? (l.key.startsWith('typesafe:') ? 'judgment' : 'text')) === 'judgment'))
    return 'This game needs Jev in one lane.'
  return null
}

/** A lane's short provider line: `typesafe · judgment`, `openrouter · thinking low`. */
export function laneLine(ln) {
  if (ln.kind === 'judgment') return `${ln.provider} · judgment`
  return ln.thinking ? `${ln.provider} · thinking ${ln.thinking}` : ln.provider
}
