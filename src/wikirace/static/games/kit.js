/* The Arcade's kit: what every game's page is assembled from.
 *
 * A game is one module, `static/games/<id>.js`, whose default export is a
 * component the shell mounts with `{ game, runId }`:
 *
 *   game   the server's listing for it (GET /api/games): title, use_case,
 *          lanes {min, max}, kinds, needs_jev, params (JSON schema)
 *   runId  the run in the address (`?game=<id>&run=<id>`), or null for setup
 *
 * With no run it shows its setup and starts one with `startGame(game.id, lanes,
 * params)`, which puts the run in the address; with a run it follows it with
 * `useRun(runId)` and draws it. The server owns the run: the page only reads the
 * stream, through `applyRunEvent` (runstate.js), and can stop it (`stopRun`).
 *
 * Styles are `g-*` classes in games.css, over the page's own tokens
 * (styles.css); a game's own styles go in `<id>.css`, prefixed with its id.
 */
import { h } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { API, api, useEndpoint } from '../api.js'
import { PixelText } from '../brand.js'
import { Finale, LANE_COLORS, NEON, useJustEnded } from '../fx.js'
import { recordPlay } from '../profile.js'
import { sfx } from '../sfx.js'
import { groupModels, modelHint, optionLabel } from '../state.js'
import { Badge, Button, StatDot } from '../ui.js'
import { accentOf } from './registry.js'
import { toGame, toHub } from './route.js'
import {
  LANE_STATUS,
  RUN_STATUS,
  applyRunEvent,
  fmtMs,
  isRunLive,
  lanesBody,
  laneCostText,
  laneLine,
  perCall,
  statusToneOf,
} from './runstate.js'

export const html = htm.bind(h)
export { fmtMs, fmtPct, fmtProb, laneCostText, perCall } from './runstate.js'
/* The arcade's shared effects, for a game's own board: a number that counts up
 * (Counter), confetti (burst, burstFrom), the pixel font, and sounds. */
export { Counter, Finale, burst, burstFrom, useJustEnded, LANE_COLORS, NEON } from '../fx.js'
export { PixelText } from '../brand.js'
export { sfx } from '../sfx.js'

export const MAX_LANES = 4

/* ── Data ──────────────────────────────────────────────────────────────────── */

/** Every game's listing, by id. */
export function useGames() {
  const r = useEndpoint('/games', 0)
  const byId = new Map((r.data?.games ?? []).map((g) => [g.id, g]))
  return { ...r, byId }
}

/** Who can play: providers and models (GET /api/models), read once. */
export const useModels = () => useEndpoint('/models', 0)

/** A clock that ticks only while something is live. */
export function useNow(active, ms = 250) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

/**
 * Follow a run: its snapshot, then every change, until `end`. A dropped
 * connection heals by itself (every connection opens with a snapshot); a refused
 * one asks with a plain GET, which says why, or is the finished run anyway.
 * @returns {{run: object|null, error: string|null}}
 */
export function useRun(runId) {
  const [run, setRun] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    setRun(null)
    setError(null)
    if (!runId) return
    const path = `/games/runs/${encodeURIComponent(runId)}`
    const es = new EventSource(`${API}${path}/events`)
    let current = null
    let over = false
    let gone = false
    es.onmessage = (e) => {
      if (over || gone) return
      let ev
      try {
        ev = JSON.parse(e.data)
      } catch {
        return
      }
      if (ev?.type === 'end') {
        over = true
        es.close()
        return
      }
      current = applyRunEvent(current, ev)
      setRun(current)
      setError(null)
    }
    es.onerror = () => {
      if (over || gone) return
      if (es.readyState !== EventSource.CLOSED) {
        setError('Lost the game stream — reconnecting…')
        return
      }
      over = true
      api.get(path).then(
        (r) => {
          if (gone) return
          setRun(r)
          setError(r?.status === 'running' ? 'The game stream closed early.' : null)
        },
        (err) => !gone && setError(err.message),
      )
    }
    return () => {
      gone = true
      es.close()
    }
  }, [runId])
  return { run, error }
}

/** Start a run of *gameId* and open it. Throws the server's own reason. */
export async function startGame(gameId, lanes, params = {}) {
  const run = await api.post(`/games/${encodeURIComponent(gameId)}/runs`, { lanes: lanesBody(lanes), params })
  recordPlay(gameId)
  sfx.start()
  toGame(gameId, run.id)
  return run
}

export const stopRun = (runId) => api.post(`/games/runs/${encodeURIComponent(runId)}/stop`)

/** A start button's state: busy while the request is out, and its error. */
export function useStarter(gameId) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const start = useCallback(
    async (lanes, params) => {
      setBusy(true)
      setError(null)
      try {
        await startGame(gameId, lanes, params)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [gameId],
  )
  return { busy, error, start }
}

/* ── Frame ─────────────────────────────────────────────────────────────────── */

/** The top of every game's page: its marquee (the name in lights, in the
 *  cabinet's own neon), what it is, the use case it shows, and a way back to
 *  the floor. `actions` sit on the right. */
export function GameFrame({ game, title, tagline, useCase, actions, children, class: cls }) {
  const name = title ?? game?.title ?? ''
  const use = useCase ?? game?.use_case
  const back = () => {
    sfx.select()
    toHub()
  }
  return html`
    <div class=${`g-page${cls ? ` ${cls}` : ''}`} style=${{ '--acc': accentOf(game?.id) }}>
      <header class="g-page__hd">
        <button type="button" class="g-back" onClick=${back} aria-label="Back to the Arcade floor">◂ Floor</button>
        <div class="g-marquee">
          <h1 class="g-page__title"><span class="sr-only">${name}</span><${PixelText} text=${name} /></h1>
          <p class="g-page__tag">${tagline ?? game?.tagline}</p>
        </div>
        <span class="spacer" />
        ${use && html`<span class="g-usecase"><span class="g-usecase__k">USE CASE</span>${use}</span>`}
        ${actions}
      </header>
      ${children}
    </div>
  `
}

/** A small uppercase section label, optionally with a count or note beside it. */
export function Label({ children, note, class: cls }) {
  return html`<div class=${`g-label${cls ? ` ${cls}` : ''}`}>
    <span>${children}</span>${note != null && html`<span class="g-label__note">${note}</span>`}
  </div>`
}

/** A bordered box. `lane` (0-based) puts that lane's colour on its top edge. */
export function Box({ lane, class: cls, children, ...rest }) {
  const lc = Number.isInteger(lane) ? ` g-lane g-l${(lane % 4) + 1}` : ''
  return html`<section class=${`g-box${lc}${cls ? ` ${cls}` : ''}`} ...${rest}>${children}</section>`
}

/** A labelled pill: tone ok | warn | err | live | cy | neutral. */
export function Chip({ tone = 'neutral', title, children }) {
  return html`<span class=${`g-chip g-chip--${tone}`} title=${title}>${children}</span>`
}

/** One number with its label above it. */
export function Stat({ label, value, tone, title }) {
  return html`<div class="g-stat" title=${title}>
    <span class="g-stat__k">${label}</span><span class=${`g-stat__v tnum${tone ? ` g-t-${tone}` : ''}`}>${value}</span>
  </div>`
}

/* ── Lanes ─────────────────────────────────────────────────────────────────── */

/** A lane's number in its lane colour, as WikiRace shows racers. */
export function LaneNum({ i, out = false }) {
  return html`<span class=${`g-num g-l${(i % 4) + 1}${out ? ' g-num--out' : ''}`} aria-hidden="true">${i + 1}</span>`
}

/** A lane's heading row: number, name, provider line, status. */
export function LaneHead({ lane, badge }) {
  const tone = statusToneOf(lane.status)
  return html`
    <div class="g-lanehd">
      <${LaneNum} i=${lane.index} out=${lane.status === 'error' || lane.status === 'stopped'} />
      <span class="g-lanehd__name" title=${lane.key}>${lane.label}</span>
      <span class="g-lanehd__sub">${laneLine(lane)}</span>
      <span class="spacer" />
      ${badge ?? html`<${Badge} tone=${tone}>${LANE_STATUS[lane.status] ?? lane.status}<//>`}
    </div>
    ${lane.note && html`<p class=${`g-lanenote g-t-${tone}`}>${lane.note}</p>`}
  `
}

/** Calls, time per call, tokens, cost and fouls: every lane's running totals. */
export function LaneStats({ lane, fouls = true, extra }) {
  return html`
    <div class="g-stats">
      <${Stat} label="calls" value=${lane.calls} />
      <${Stat} label="per call" value=${fmtMs(perCall(lane))} />
      <${Stat} label="tokens in / out" value=${`${fmtK(lane.tokens_in)} / ${fmtK(lane.tokens_out)}`} />
      <${Stat} label="cost" value=${laneCostText(lane)} />
      ${fouls && html`<${Stat} label="fouls" value=${lane.fouls} tone=${lane.fouls ? 'err' : undefined} />`}
      ${extra}
    </div>
  `
}

/** A whole lane card: heading, then whatever the game shows, then the totals. */
export function LaneCard({ lane, children, stats = true, fouls = true, badge, class: cls }) {
  return html`
    <${Box} lane=${lane.index} class=${`g-lanecard${cls ? ` ${cls}` : ''}`}>
      <${LaneHead} lane=${lane} badge=${badge} />
      ${children}
      ${stats && html`<${LaneStats} lane=${lane} fouls=${fouls} />`}
    <//>
  `
}

export function fmtK(n) {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/* ── Showing Jev's numbers ─────────────────────────────────────────────────── */

/**
 * Probability bars, as WikiRace shows Jev's links: the label, a bar, the value.
 * items: [{label, p, strong?, tone?, title?}] — `lane` colours the bars.
 */
export function Bars({ items, lane = 0, max = 6, compact = false }) {
  return html`
    <ol class=${`g-bars${compact ? ' g-bars--compact' : ''} g-l${(lane % 4) + 1}`}>
      ${items.slice(0, max).map(
        (it, i) => html`
          <li key=${it.label} class=${`g-bar${it.strong ?? i === 0 ? ' g-bar--top' : ''}${it.tone ? ` g-bar--${it.tone}` : ''}`} title=${it.title}>
            <span class="g-bar__k">${it.label}</span>
            <span class="g-bar__track"><span class="g-bar__fill" style=${{ width: `${Math.max(0, Math.min(1, it.p)) * 100}%` }} /></span>
            <span class="g-bar__v tnum">${Number.isFinite(it.p) ? it.p.toFixed(2) : '—'}</span>
          </li>
        `,
      )}
    </ol>
  `
}

/**
 * One value on a 0…1 track with threshold ticks, e.g. a hazard against its review
 * and block lines. marks: [{at, label}]; tone colours the fill.
 */
export function Meter({ value, marks = [], tone = 'cy', label, title }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0))
  return html`
    <div class=${`g-meter${label ? '' : ' g-meter--bare'}`} title=${title}>
      ${label && html`<span class="g-meter__k">${label}</span>`}
      <span class="g-meter__track">
        <span class=${`g-meter__fill g-fill--${tone}`} style=${{ width: `${v * 100}%` }} />
        ${marks.map((m) => html`<span key=${m.at} class="g-meter__mark" style=${{ left: `${m.at * 100}%` }} title=${m.label} />`)}
      </span>
      <span class="g-meter__v tnum">${Number.isFinite(value) ? Number(value).toFixed(2) : '—'}</span>
    </div>
  `
}

/** A score's distribution over its levels as a row of columns (Jev's Score). */
export function Levels({ probabilities = [], labels, lane = 0, height = 30 }) {
  const top = probabilities.indexOf(Math.max(...probabilities))
  return html`
    <span class=${`g-levels g-l${(lane % 4) + 1}`} style=${{ height: `${height}px` }}>
      ${probabilities.map(
        (p, i) => html`<span key=${i} class=${`g-levels__col${i === top ? ' g-levels__col--top' : ''}`}
          style=${{ height: `${Math.max(2, p * height)}px` }} title=${`${labels?.[i] ?? `level ${i}`}: ${p.toFixed(2)}`} />`,
      )}
    </span>
  `
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

/**
 * Choose the players: one row per lane, a model from every provider that can
 * play (grouped by provider), up to `max`. `kinds` limits who may sit.
 * value: [{key}] · onChange(lanes)
 */
export function PlayerPicker({ info, value, onChange, min = 1, max = MAX_LANES, kinds = ['judgment', 'text'], label = 'PLAYERS' }) {
  const models = (info?.models ?? []).filter((m) => kinds.includes(m.kind))
  const groups = groupModels(models, (info?.providers ?? []).filter((p) => kinds.includes(p.kind)))
  const set = (i, key) => {
    sfx.select()
    onChange(value.map((l, j) => (j === i ? { key } : l)))
  }
  const add = () => {
    sfx.coin()
    onChange([...value, { key: '' }])
  }
  const remove = (i) => {
    sfx.hover()
    onChange(value.filter((_, j) => j !== i))
  }
  return html`
    <div class="g-players">
      <${Label} note=${`${value.filter((l) => l.key).length}/${max}`}>${label === 'PLAYERS' ? 'PLAYER SELECT' : label}<//>
      ${!info && html`<p class="g-muted">Reading who can play…</p>`}
      ${value.map(
        (l, i) => html`
          <div class=${`g-players__row g-l${(i % 4) + 1}${l.key ? ' is-in' : ''}`} key=${i}>
            <span class="g-slot" aria-hidden="true">P${i + 1}</span>
            <select class="wr-sel" value=${l.key} onChange=${(e) => set(i, e.currentTarget.value)} aria-label=${`Player ${i + 1}`}
              title=${models.find((m) => m.key === l.key) ? modelHint(models.find((m) => m.key === l.key)) : undefined}>
              <option value="">— pick a model —</option>
              ${l.key && !models.some((m) => m.key === l.key) && html`<option value=${l.key} disabled>${l.key}</option>`}
              ${groups.map(
                (g) => html`<optgroup key=${g.provider} label=${g.label}>
                  ${g.models.map((m) => html`<option key=${m.key} value=${m.key} disabled=${!m.available}>${optionLabel(m)}</option>`)}
                </optgroup>`,
              )}
            </select>
            <button type="button" class="wr-x" onClick=${() => remove(i)} disabled=${value.length <= min}
              aria-label=${`Remove player ${i + 1}`} title="Take this player off">✕</button>
          </div>
        `,
      )}
      ${value.length < max && html`<button type="button" class="g-join" onClick=${add}><span aria-hidden="true">+</span> Player ${value.length + 1}: press to join</button>`}
    </div>
  `
}

/** The start row: the big arcade button, and what stops it (a problem) or went
 *  wrong. The label is lit in the pixel font; the button keeps it as text. */
export function StartButton({ onStart, problem, busy, error, label = 'Start' }) {
  const text = busy ? 'Starting…' : label
  return html`
    <div class="g-start">
      <button type="button" class="g-start__btn" onClick=${onStart} disabled=${!!problem || busy} aria-label=${text}>
        <${PixelText} text=${text} />
      </button>
      ${(error || problem) && html`<p class=${`g-start__msg${error ? ' g-t-err' : ''}`}>${error || problem}</p>`}
    </div>
  `
}

/* ── A run ─────────────────────────────────────────────────────────────────── */

/**
 * A run's scoreboard: the status, the clock, and stop / play again / new. When
 * a run finishes in front of you, the finale plays over the page: `winners`
 * (lane indexes, by the game's own rule for who won) are named in it and after
 * it, in the bar; with none it says GAME OVER. `headline` and `sub` replace
 * its words; `win={false}` plays it without the fanfare and confetti (an end
 * that is not a triumph). `winLabel` names a winner who is not a lane (the
 * visitor, say) in the bar.
 */
export function RunBar({ run, now, onAgain, onNew, children, winners, headline, sub, win = true, winLabel }) {
  const live = isRunLive(run)
  const ms = live ? Math.max(0, now - Date.parse(run.created_at)) : run.elapsed_ms
  const [stopping, setStopping] = useState(false)
  const [ended, closeFinale] = useJustEnded(live)
  const won = (winners ?? []).map((i) => run.lanes[i]).filter(Boolean)
  const fin = finaleOf(run, won, headline, sub)
  return html`
    <div class=${`g-runbar${live ? ' is-live' : ''}`}>
      <${Badge} tone=${statusToneOf(run.status)}>${live && html`<${StatDot} tone="live" />`} ${RUN_STATUS[run.status] ?? run.status}<//>
      <span class="g-runbar__clock" title="Game clock"><${PixelText} text=${fmtClock(ms)} label=${fmtClock(ms)} /></span>
      ${children}
      <span class="spacer" />
      ${!live && run.status === 'finished' && winLabel && html`
        <span class="g-runbar__win"><span class="g-runbar__star" aria-hidden="true">★</span> Winner: ${winLabel}</span>`}
      ${!live && run.status === 'finished' && !winLabel && won.length > 0 && html`
        <span class="g-runbar__win"><span class="g-runbar__star" aria-hidden="true">★</span> ${won.length > 1 ? 'Tie:' : 'Winner:'}
          ${won.map((l) => html`<span class="g-runbar__who"><${LaneNum} i=${l.index} /> ${l.label}</span>`)}</span>`}
      ${live
        ? html`<${Button} variant="danger" size="sm" disabled=${stopping}
            onClick=${async () => { setStopping(true); try { await stopRun(run.id) } catch { setStopping(false) } }}>
            ${stopping ? 'Stopping…' : 'Stop'}<//>`
        : html`
            ${onAgain && html`<${Button} variant="primary" size="sm" onClick=${onAgain}>Play again<//>`}
            <${Button} variant="ghost" size="sm" onClick=${onNew ?? (() => toGame(run.game))}>New game<//>
          `}
    </div>
    ${run.note && html`<p class=${`g-runnote g-t-${statusToneOf(run.status)}`}>${run.note}</p>`}
    <${Finale} show=${ended && run.status === 'finished'} headline=${fin.headline} sub=${fin.sub} colors=${fin.colors} win=${win} onClose=${closeFinale} />
  `
}

/** The finale's words: who won, by the game's rule, or GAME OVER. */
function finaleOf(run, won, headline, sub) {
  const colors = won.length ? won.map((l) => LANE_COLORS[l.index % 4]) : NEON
  if (headline) return { headline, sub, colors }
  if (won.length === 1 && run.lanes.length > 1) return { headline: `PLAYER ${won[0].index + 1} WINS!`, sub: sub ?? won[0].label, colors }
  if (won.length > 1) return { headline: 'TIE GAME!', sub: sub ?? won.map((l) => l.label).join(' · '), colors }
  return { headline: 'GAME OVER', sub, colors }
}

export function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "Play again": the same players and params, a new run. */
export function againOf(run) {
  return () => startGame(run.game, run.lanes.map((l) => ({ key: l.key })), run.params)
}

/** What a game shows while its run loads, or when it failed to. */
export function RunLoading({ error }) {
  return html`<div class="g-loading">${error ? html`<p class="g-t-err">${error}</p>` : html`<div class="g-boot"><${PixelText} text="LOADING" /><span class="g-muted">the game…</span></div>`}</div>`
}

/** A game's list of recent runs, to reopen one. */
export function RecentRuns({ gameId, limit = 8, render }) {
  const r = useEndpoint(`/games/runs?game=${encodeURIComponent(gameId)}&limit=${limit}`, 15_000)
  const rows = r.data?.runs ?? []
  if (!rows.length) return null
  return html`
    <div class="g-recent">
      <${Label} note="replay any of this cabinet's last plays">RECENT GAMES<//>
      <ul>
        ${rows.map(
          (run) => html`<li key=${run.id}>
            <button type="button" class="g-recent__row" onClick=${() => { sfx.select(); toGame(gameId, run.id) }}>
              <${Badge} tone=${statusToneOf(run.status)}>${RUN_STATUS[run.status] ?? run.status}<//>
              <span class="g-recent__who">${run.lanes.map((l) => l.label).join(' · ')}</span>
              ${render ? render(run) : null}
            </button>
          </li>`,
        )}
      </ul>
    </div>
  `
}
