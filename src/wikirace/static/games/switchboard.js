/* Switchboard — every caller patched to the right line, or to a human when unsure.
 *
 * The reference game for the Arcade's kit: a setup (players and the round's
 * params), and a run followed live. The server (games/switchboard.py) owns the
 * callers, the queues and the scoring; this page draws them: the calls as they
 * arrive, a board of 150 jacks with a cord for each of a lane's latest
 * connections, the pick behind the latest call, and every lane's tally.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  Bars,
  Box,
  Chip,
  GameFrame,
  Label,
  LaneHead,
  LaneNum,
  Meter,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  Stat,
  againOf,
  fmtMs,
  html,
  laneCostText,
  perCall,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtPct, isRunLive, playersProblem } from './runstate.js'

const CALLS = [12, 20, 30, 50, 74]
const INTERVALS = [
  [150, 'every 0.15 s'],
  [300, 'every 0.3 s'],
  [600, 'every 0.6 s'],
  [1000, 'every second'],
  [2500, 'every 2.5 s'],
]
const PATIENCE = [
  [4000, '4 s'],
  [8000, '8 s'],
  [15000, '15 s'],
  [30000, '30 s'],
]
/** How a call went, as a mark: shape and colour, so it reads without colour too. */
const VERDICT = {
  right: { mark: '✓', tone: 'ok', label: 'connected right' },
  wrong: { mark: '✕', tone: 'err', label: 'wrong line' },
  foul: { mark: '✕', tone: 'err', label: 'not a line (foul)' },
  operator: { mark: '☎', tone: 'vi', label: 'sent to the operator' },
  dropped: { mark: '–', tone: 'warn', label: 'hung up waiting' },
}

export default function Switchboard({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [calls, setCalls] = useState(30)
  const [interval, setInterval_] = useState(300)
  const [patience, setPatience] = useState(8000)
  const [threshold, setThreshold] = useState(0.5)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 3 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { calls, interval_ms: interval, patience_ms: patience, threshold })

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="sb-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="sb-params">
            <label class="g-field"><span>Callers</span>
              <select class="wr-sel" value=${calls} onChange=${(e) => setCalls(Number(e.currentTarget.value))}>
                ${CALLS.map((n) => html`<option value=${n}>${n}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>A new caller</span>
              <select class="wr-sel" value=${interval} onChange=${(e) => setInterval_(Number(e.currentTarget.value))}>
                ${INTERVALS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>Hangs up after</span>
              <select class="wr-sel" value=${patience} onChange=${(e) => setPatience(Number(e.currentTarget.value))}>
                ${PATIENCE.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
              </select>
            </label>
            <label class="g-field sb-thr"><span>To a human under</span>
              <input type="range" min="0.2" max="0.9" step="0.05" value=${threshold}
                onInput=${(e) => setThreshold(Number(e.currentTarget.value))} aria-label="Confidence threshold" />
              <b class="tnum">${threshold.toFixed(2)}</b>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Open the lines" />
        <//>
        <div class="sb-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Callers ring in on a clock. Each lane is one operator with its own queue, taking one call at a time,
              and a caller who waits too long hangs up. Every call is routed to one of 150 lines in ten domains, or
              to <b>out of scope</b>.
            </p>
            <p class="g-explain">
              <b>Jev</b> answers one Choice over all 151 lines and code reads its <b>confidence</b>: under the
              threshold, the call goes to a human operator instead of a guess. A <b>text model</b> names a line
              (or says <code>operator</code>); a name that isn't a line is a foul.
            </p>
            <div class="sb-rules">
              <${Chip} tone="ok">right +2<//><${Chip}>operator 0<//><${Chip} tone="err">wrong −1<//>
              <${Chip} tone="err">foul −1<//><${Chip} tone="warn">hung up −1<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} calls</span>`} />
        </div>
      </div>
    <//>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [focus, setFocus] = useState(0)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const lane = run.lanes[Math.min(focus, run.lanes.length - 1)]
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">${run.calls.length}/${run.total} callers · threshold ${run.threshold.toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="sb-stage">
        <${CallList} run=${run} />
        <div class="sb-center">
          ${run.lanes.length > 1 &&
          html`<div class="sb-lanetabs" role="group" aria-label="Whose board">
            ${run.lanes.map(
              (ln) => html`<button type="button" class=${`sb-lanetab${ln.index === lane.index ? ' sb-lanetab--on' : ''}`}
                aria-pressed=${ln.index === lane.index} onClick=${() => setFocus(ln.index)}>
                <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
            )}
          </div>`}
          <${Board} run=${run} lane=${lane} />
        </div>
        <${Pick} run=${run} lane=${lane} />
      </div>
      <div class="g-lanes">${run.lanes.map((ln) => html`<${Tally} key=${ln.index} lane=${ln} />`)}</div>
    <//>
  `
}

/** The callers, newest first: what each said, and how each lane handled it. */
function CallList({ run }) {
  const byCall = useMemo(() => {
    const m = new Map()
    run.lanes.forEach((ln) => (ln.answers ?? []).forEach((a) => m.set(`${ln.index}:${a.call}`, a)))
    return m
  }, [run])
  const calls = [...run.calls].reverse().slice(0, 9)
  return html`
    <${Box} class="sb-calls">
      <${Label} note=${`${run.calls.length} of ${run.total}`}>CALLS<//>
      ${!calls.length && html`<p class="g-muted">The lines are open…</p>`}
      <ol class="sb-calls__list">
        ${calls.map((c) => {
          const gold = run.gold ? run.gold[c.i] : undefined
          return html`
            <li key=${c.i} class="sb-call">
              <span class="sb-call__text">“${c.text}”</span>
              <span class="sb-call__marks">
                ${run.lanes.map((ln) => {
                  const a = byCall.get(`${ln.index}:${c.i}`)
                  const v = a ? VERDICT[a.verdict] : null
                  const busy = ln.busy === c.i
                  return html`<span class=${`sb-mark g-l${(ln.index % 4) + 1}${v ? ` sb-mark--${v.tone}` : busy ? ' sb-mark--busy' : ''}`}
                    title=${`${ln.label}: ${v ? `${v.label}${a.intent ? ` (${a.intent})` : ''}` : busy ? 'on the line' : 'waiting'}`}>
                    ${v ? v.mark : busy ? '…' : '·'}</span>`
                })}
                ${gold !== undefined && html`<span class="sb-call__gold g-mono">${gold ?? 'out of scope'}</span>`}
              </span>
            </li>
          `
        })}
      </ol>
    <//>
  `
}

/* The board: a jack per intent, ten domain columns of fifteen, then out of scope
 * and the operator. A lane's six latest calls hang on it as cords, coloured by
 * how the call went. */
const COL_W = 53
const ROW_H = 20
const jackXY = (c, r) => [41.5 + COL_W * c, 54 + ROW_H * r]
const SHORT = { 'credit cards': 'CARDS', 'small talk': 'TALK', auto: 'AUTO' }

function Board({ run, lane }) {
  const domains = Object.entries(run.domains ?? {})
  const where = useMemo(() => {
    const m = new Map()
    domains.forEach(([, intents], c) => intents.forEach((it, r) => m.set(it, jackXY(c, r))))
    return m
  }, [run.domains])
  const OOS_XY = [390, 392]
  const OP_XY = [490, 392]
  const recent = (lane.answers ?? []).filter((a) => a.verdict !== 'dropped').slice(-6)
  const cords = recent.map((a, j) => {
    const plug = [70 + j * 80, 486]
    const to = a.route === 'operator' ? OP_XY : a.route === 'oos' ? OOS_XY : where.get(a.intent) ?? OOS_XY
    const tone = a.route === 'operator' ? 'vi' : a.verdict === 'right' ? 'ok' : 'err'
    return { a, plug, to, tone, key: a.call }
  })
  const last = recent[recent.length - 1]
  const lit = cords.filter((c) => c.a.route === 'connect')
  return html`
    <${Box} class="sb-board">
      <svg viewBox="0 0 560 500" role="img" aria-label=${`${lane.label}'s board: its latest calls as cords to their lines`}>
        <defs>
          <pattern id="sbJack" x="15" y="44" width=${COL_W} height=${ROW_H} patternUnits="userSpaceOnUse">
            <circle cx="26.5" cy="10" r="4.6" fill="#060911" stroke="#4d5871" stroke-width="1.3" />
          </pattern>
        </defs>
        <rect x="1" y="1" width="558" height="498" rx="8" class="sb-board__bg" />
        <g class="sb-board__domains">
          ${domains.map(([d], c) => html`<text key=${d} x=${41.5 + COL_W * c} y="30">${(SHORT[d] ?? d).toUpperCase().slice(0, 7)}</text>`)}
        </g>
        <rect x="15" y="44" width=${COL_W * 10} height=${ROW_H * 15} fill="url(#sbJack)" />
        <line x1="15" y1="360" x2="545" y2="360" class="sb-board__rule" />
        <circle cx=${OOS_XY[0]} cy=${OOS_XY[1]} r="9" class="sb-jack sb-jack--oos" />
        <text x=${OOS_XY[0]} y="420" class="sb-board__cap sb-t-warn">OUT OF SCOPE</text>
        <circle cx=${OP_XY[0]} cy=${OP_XY[1]} r="11" class="sb-jack sb-jack--op" />
        <text x=${OP_XY[0]} y="420" class="sb-board__cap sb-t-vi">OPERATOR</text>
        <text x="30" y="396" class="sb-board__note">150 lines + out of scope · one Choice per call</text>
        ${lit.map(({ to, tone, key }) => html`<circle key=${`j${key}`} cx=${to[0]} cy=${to[1]} r="5.5" class=${`sb-lit sb-f-${tone}`} />`)}
        ${cords.map(({ plug, to, tone, key }, j) => html`
          <path key=${`c${key}`} class=${`sb-cord sb-s-${tone}`} opacity=${0.45 + (0.55 * (j + 1)) / cords.length}
            d=${`M${plug[0]} ${plug[1]} C${plug[0]} ${plug[1] - 120} ${to[0]} ${to[1] + 110} ${to[0]} ${to[1] + 6}`} />
          <rect key=${`p${key}`} x=${plug[0] - 8} y="476" width="16" height="20" rx="2" class="sb-plug" />
        `)}
        ${last?.intent && where.get(last.intent) && html`
          <g class="sb-callout">
            <rect x=${Math.min(where.get(last.intent)[0] + 10, 360)} y=${where.get(last.intent)[1] - 14} width="186" height="28" rx="3" />
            <text x=${Math.min(where.get(last.intent)[0] + 10, 360) + 93} y=${where.get(last.intent)[1] + 4}>${last.intent}</text>
          </g>
        `}
      </svg>
    <//>
  `
}

/** The pick behind a lane's latest call: Jev's probabilities and its
 *  confidence against the threshold, or what the text model named. */
function Pick({ run, lane }) {
  const a = [...(lane.answers ?? [])].reverse().find((x) => x.verdict !== 'dropped')
  const call = a ? run.calls[a.call] : null
  const v = a ? VERDICT[a.verdict] : null
  return html`
    <${Box} lane=${lane.index} class="sb-pick">
      <${Label}>${lane.kind === 'judgment' ? 'JEV’S PICK' : 'THE OPERATOR SAID'}<//>
      ${!a && html`<p class="g-muted">No call answered yet.</p>`}
      ${a && html`
        <p class="sb-pick__call">“${call?.text}”</p>
        ${a.top
          ? html`<${Bars} lane=${lane.index} compact items=${a.top.map((t) => ({ label: t.option, p: t.p }))} max=${5} />
              <${Label} note=${a.confidence.toFixed(2)}>CONFIDENCE<//>
              <${Meter} value=${a.confidence} tone=${a.confidence >= run.threshold ? 'ok' : 'warn'}
                marks=${[{ at: run.threshold, label: `threshold ${run.threshold}` }]} />
              <p class="g-mono g-muted sb-pick__rule">
                under ${run.threshold.toFixed(2)} → operator · top is out of scope → polite no · else connect
              </p>`
          : html`<p class="sb-pick__said g-mono">LINE: ${a.said || '—'}</p>`}
        <p class=${`sb-pick__verdict sb-t-${v.tone}`}>${v.mark} ${v.label}${a.intent ? `: ${a.intent}` : ''}
          <span class="g-muted"> · ${fmtMs(a.ms)}</span></p>
      `}
    <//>
  `
}

/** A lane's tally: the score, and how its callers fared. */
function Tally({ lane }) {
  const backlog = lane.backlog ?? []
  const answered = lane.answered ?? 0
  const max = Math.max(4, ...backlog)
  const pts = backlog.slice(-60).map((n, i, arr) => `${(i / Math.max(1, arr.length - 1)) * 100},${20 - (n / max) * 18}`)
  return html`
    <${Box} lane=${lane.index} class="sb-tally">
      <${LaneHead} lane=${lane} />
      <div class="sb-tally__row">
        <div class="sb-tally__score"><span class="tnum">${lane.score ?? 0}</span><small>points</small></div>
        <div class="g-stats sb-tally__stats">
          <${Stat} label="right" value=${`${lane.right ?? 0}${answered ? ` · ${fmtPct((lane.right ?? 0) / answered)}` : ''}`} />
          <${Stat} label="operator" value=${lane.operator ?? 0} />
          <${Stat} label="hung up" value=${lane.dropped ?? 0} tone=${lane.dropped ? 'warn' : undefined} />
          <${Stat} label="fouls" value=${lane.fouls} tone=${lane.fouls ? 'err' : undefined} />
          <${Stat} label="per call" value=${fmtMs(perCall(lane))} />
          <${Stat} label="cost" value=${laneCostText(lane)} />
        </div>
        <div class="sb-queue" title="callers waiting in this lane's queue">
          <span class="g-stat__k">queue ${lane.queue ?? 0}</span>
          <svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
            <polyline points=${pts.join(' ')} class=${`sb-spark g-l${(lane.index % 4) + 1}`} />
          </svg>
        </div>
      </div>
    <//>
  `
}
