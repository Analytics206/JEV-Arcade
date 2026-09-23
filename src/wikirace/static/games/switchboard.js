/* Switchboard — every caller patched to the right line, or to a human when unsure.
 *
 * The reference game for the Arcade's kit: a setup (players and the round's
 * params), and a run followed live. The server (games/switchboard.py) owns the
 * callers, the queues and the scoring; this page draws them as an old
 * telephone exchange in neon: the calls ringing in, a panel of 150 jacks with
 * a braided cord for each of a lane's latest connections (the newest drawn in,
 * its jack flashing), the pick behind the latest call, and every lane's tally.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  Bars,
  Box,
  Counter,
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
import { defaultPlayers, fmtPct, isLaneLive, isRunLive, playersProblem } from './runstate.js'

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
  foul: { mark: '∅', tone: 'err', label: 'not a line (foul)' },
  operator: { mark: '☎', tone: 'vi', label: 'sent to the operator' },
  dropped: { mark: '–', tone: 'warn', label: 'hung up waiting' },
}
/** The points table, as the setup shows it (the server's POINTS). */
const SCORING = [
  ['right', 'right line', '+2'],
  ['operator', 'to a human', '0'],
  ['wrong', 'wrong line', '−1'],
  ['foul', 'not a line', '−1'],
  ['dropped', 'hung up', '−1'],
]

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
          <${Box} class="sb-how">
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Callers ring in on a clock. Each lane is one operator with its own queue, taking one call at a time,
              and a caller who waits too long hangs up. Every call is routed to one of 150 lines in ten domains, or
              to <b>out of scope</b>.
            </p>
            <${RouteDiagram} threshold=${threshold} />
            <p class="g-explain">
              <b>Jev</b> answers one Choice over all 151 lines and code reads its <b>confidence</b>: under the
              threshold, the call goes to a human operator instead of a guess. A <b>text model</b> names a line
              (or says <code>operator</code>); a name that isn't a line is a foul.
            </p>
            <ul class="sb-keys" aria-label="Points per call">
              ${SCORING.map(([v, what, pts]) => html`
                <li key=${v} class=${`sb-key sb-key--${VERDICT[v].tone}`}>
                  <span class="sb-key__mark" aria-hidden="true">${VERDICT[v].mark}</span><span class="sb-key__what">${what}</span><b class="sb-key__pts tnum">${pts}</b>
                </li>
              `)}
            </ul>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} calls</span>`} />
        </div>
      </div>
    <//>
  `
}

/** How Jev's call is routed, drawn: a caller, one Choice, the confidence gate
 *  at the threshold chosen above, then a line or a human. */
function RouteDiagram({ threshold }) {
  const t = threshold.toFixed(2)
  return html`
    <svg class="sb-route" viewBox="0 0 520 136" role="img"
      aria-label=${`Jev's route: the caller's words go to Jev as one Choice over 151 lines; at or over ${t} confidence the call is connected to the line it chose, under ${t} it goes to a human operator.`}>
      <path class="sb-route__wire" d="M104 68 H146" />
      <path class="sb-route__wire" d="M294 68 H326" />
      <path class="sb-route__wire sb-route__wire--ok" d="M388 56 C412 56 410 30 436 30" />
      <path class="sb-route__wire sb-route__wire--vi" d="M388 80 C412 80 410 106 436 106" />
      <g class="sb-route__node">
        <rect x="8" y="42" width="96" height="52" rx="10" />
        <text x="56" y="66" class="sb-route__glyph">☎</text>
        <text x="56" y="84">A CALLER</text>
      </g>
      <g class="sb-route__node sb-route__node--jev">
        <rect x="146" y="36" width="148" height="64" rx="10" />
        <text x="220" y="60" class="sb-route__big">ONE CHOICE</text>
        <text x="220" y="77">over 151 lines</text>
        <text x="220" y="92" class="sb-route__dim">and its confidence</text>
      </g>
      <g class="sb-route__gate">
        <polygon points="357,38 388,68 357,98 326,68" />
        <text x="357" y="65">≥</text>
        <text x="357" y="80" class="sb-route__t">${t}</text>
      </g>
      <g class="sb-route__node sb-route__node--ok">
        <rect x="436" y="12" width="78" height="36" rx="8" />
        <text x="475" y="35">✓ THE LINE</text>
      </g>
      <g class="sb-route__node sb-route__node--vi">
        <rect x="436" y="88" width="78" height="36" rx="8" />
        <text x="475" y="111">☎ A HUMAN</text>
      </g>
      <text x="398" y="22" class="sb-route__lbl">at or over</text>
      <text x="398" y="130" class="sb-route__lbl">under</text>
    </svg>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

/**
 * Who won: the most points among the lanes that worked through every caller (a
 * lane that failed part way is out of it); a tie shares the win. One operator
 * alone plays against no one, so its finale shows its score instead.
 */
function finaleOf(run) {
  const lanes = run.lanes
  if (lanes.length === 1) {
    const ln = lanes[0]
    if (ln.status !== 'done') return { winners: [] }
    return {
      winners: [],
      headline: `${ln.score ?? 0} POINTS`,
      sub: `${ln.label}: ${ln.right ?? 0} right, ${ln.operator ?? 0} to a human, ${ln.dropped ?? 0} hung up`,
    }
  }
  const done = lanes.filter((ln) => ln.status === 'done' && Number.isFinite(ln.score))
  if (!done.length) return { winners: [] }
  const top = Math.max(...done.map((ln) => ln.score))
  const won = done.filter((ln) => ln.score === top)
  return {
    winners: won.map((ln) => ln.index),
    sub: won.length === 1 ? `${won[0].label} · ${top} points` : `${won.map((ln) => ln.label).join(' · ')} · ${top} points each`,
  }
}

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const live = isRunLive(run)
  const now = useNow(live)
  const [focus, setFocus] = useState(0)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const lane = run.lanes[Math.min(focus, run.lanes.length - 1)]
  const fin = finaleOf(run)
  const over = !live && run.status === 'finished'
  const progress = run.total ? run.calls.length / run.total : 0
  return html`
    <${GameFrame} game=${game} class="sb-page">
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub}>
        <span class="sb-progress" title=${`${run.calls.length} of ${run.total} callers have rung`}>
          <span class="sb-progress__track"><span class="sb-progress__fill" style=${{ width: `${progress * 100}%` }} /></span>
          <span class="g-mono g-muted">${run.calls.length}/${run.total} callers · threshold ${run.threshold.toFixed(2)}</span>
        </span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="sb-stage">
        <${CallList} run=${run} live=${live} />
        <div class="sb-center">
          ${run.lanes.length > 1 &&
          html`<div class="sb-lanetabs" role="group" aria-label="Whose board">
            ${run.lanes.map(
              (ln) => html`<button type="button" class=${`sb-lanetab g-l${(ln.index % 4) + 1}${ln.index === lane.index ? ' sb-lanetab--on' : ''}`}
                aria-pressed=${ln.index === lane.index} onClick=${() => setFocus(ln.index)}>
                <${LaneNum} i=${ln.index} /><span class="sb-lanetab__name">${ln.label}</span><span class="sb-lanetab__pts tnum">${ln.score ?? 0}</span>
                ${ln.busy != null && live && html`<span class="sb-lanetab__on" aria-hidden="true" />`}</button>`,
            )}
          </div>`}
          <${Board} run=${run} lane=${lane} live=${live} />
        </div>
        <${Pick} run=${run} lane=${lane} />
      </div>
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${Tally} key=${ln.index} lane=${ln} sound=${ln.index === lane.index} win=${over && fin.winners.includes(ln.index)} />`)}
      </div>
    <//>
  `
}

/** The callers, newest first: what each said, and how each lane handled it. */
function CallList({ run, live }) {
  const byCall = useMemo(() => {
    const m = new Map()
    run.lanes.forEach((ln) => (ln.answers ?? []).forEach((a) => m.set(`${ln.index}:${a.call}`, a)))
    return m
  }, [run])
  const calls = [...run.calls].reverse().slice(0, 9)
  return html`
    <${Box} class="sb-calls">
      <${Label} note=${`${run.calls.length} of ${run.total}`}>INCOMING CALLS<//>
      ${!calls.length && html`<p class="g-muted sb-calls__wait"><span class="sb-calls__bell" aria-hidden="true">☎</span> The lines are open…</p>`}
      <ol class="sb-calls__list">
        ${calls.map((c, k) => {
          const gold = run.gold ? run.gold[c.i] : undefined
          const ringing = live && run.lanes.some((ln) => isLaneLive(ln) && !byCall.has(`${ln.index}:${c.i}`))
          return html`
            <li key=${c.i} class=${`sb-call${k === 0 ? ' sb-call--top' : ''}${ringing ? ' sb-call--ring' : ''}`}>
              <span class="sb-call__hd">
                <span class="sb-call__bell" aria-hidden="true">☎</span><span class="sb-call__no g-mono">#${c.i + 1}</span>
                ${gold !== undefined && html`<span class="sb-call__gold g-mono" title="the line this caller wanted">${gold ?? 'out of scope'}</span>`}
              </span>
              <span class="sb-call__text">“${c.text}”</span>
              <span class="sb-call__marks">
                ${run.lanes.map((ln) => {
                  const a = byCall.get(`${ln.index}:${c.i}`)
                  const v = a ? VERDICT[a.verdict] : null
                  const busy = ln.busy === c.i
                  const what = v ? `${v.label}${a.intent ? ` (${a.intent})` : ''}` : busy ? 'on the line' : 'waiting'
                  return html`<span key=${ln.index} class=${`sb-mark g-l${(ln.index % 4) + 1} sb-mark--${v ? v.tone : busy ? 'busy' : 'wait'}`} title=${`${ln.label}: ${what}`}>
                    <b aria-hidden="true">${ln.index + 1}</b><span aria-hidden="true">${v ? v.mark : busy ? '…' : '·'}</span><span class="sr-only">${`${ln.label}: ${what}`}</span></span>`
                })}
              </span>
            </li>
          `
        })}
      </ol>
    <//>
  `
}

/* The board: a jack per intent, ten domain columns of fifteen, then out of scope
 * and the operator. A lane's six latest calls hang on it as braided cords from
 * the plug shelf, coloured by how the call went; each cord keeps its plug (the
 * newest takes the oldest's place, as an operator reuses a cord pair). */
const COL_W = 53
const ROW_H = 20
const GRID_Y = 58
const jackXY = (c, r) => [41.5 + COL_W * c, GRID_Y + ROW_H * r]
const SHORT = { 'credit cards': 'CARDS', 'small talk': 'TALK', auto: 'AUTO' }
const OOS_XY = [392, 388]
const OP_XY = [490, 388]
const PLUG_Y = 440
const SLOTS = 6
const slotX = (s) => 62 + s * 87
const QUEUE_LAMPS = 12

function Board({ run, lane, live }) {
  const domains = Object.entries(run.domains ?? {})
  const where = useMemo(() => {
    const m = new Map()
    domains.forEach(([, intents], c) => intents.forEach((it, r) => m.set(it, { xy: jackXY(c, r), col: c })))
    return m
  }, [run.domains])
  const handled = (lane.answers ?? []).filter((a) => a.verdict !== 'dropped')
  const first = Math.max(0, handled.length - SLOTS)
  const cords = handled.slice(first).map((a, j) => {
    const slot = (first + j) % SLOTS
    const plug = slotX(slot)
    const at = a.route === 'connect' ? where.get(a.intent) : null
    const to = a.route === 'operator' ? OP_XY : a.route === 'oos' ? OOS_XY : at?.xy ?? OOS_XY
    const tone = a.route === 'operator' ? 'vi' : a.verdict === 'right' ? 'ok' : 'err'
    const dy = PLUG_Y - to[1]
    const d = `M${plug} ${PLUG_Y} C${plug} ${(PLUG_Y - dy * 0.5).toFixed(1)} ${to[0]} ${(to[1] + dy * 0.55).toFixed(1)} ${to[0]} ${to[1] + 7}`
    return { a, plug, slot, to, tone, d, col: at?.col, key: a.call, v: VERDICT[a.verdict] }
  })
  const last = cords[cords.length - 1]
  const lit = new Map()
  cords.forEach((c) => c.col !== undefined && lit.set(c.col, c.tone))
  const queue = lane.queue ?? 0
  const open = live && isLaneLive(lane)
  const onLine = open && lane.busy != null
  const status = onLine ? `ON THE LINE · CALL #${lane.busy + 1}` : open ? 'WAITING FOR A CALLER' : 'LINES CLOSED'
  const callout = last?.a.intent && where.get(last.a.intent)
    ? (() => {
        const [jx, jy] = where.get(last.a.intent).xy
        const w = Math.round(last.a.intent.length * 6.7 + 20)
        const x = jx + 14 + w > 548 ? jx - 14 - w : jx + 14
        return { x, y: jy - 13, w, tone: last.tone, text: last.a.intent, key: last.key }
      })()
    : null
  return html`
    <${Box} lane=${lane.index} class="sb-board">
      <svg viewBox="0 0 560 500" role="img"
        aria-label=${`${lane.label}'s board: its latest ${cords.length} calls as cords to their lines${last ? `; the newest ${last.v.label}${last.a.intent ? ` to ${last.a.intent}` : ''}` : ''}`}>
        <defs>
          <linearGradient id="sb-g-frame" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#1f1848" /><stop offset="1" stop-color="#0a0720" />
          </linearGradient>
          <linearGradient id="sb-g-panel" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#120d30" /><stop offset=".55" stop-color="#0c0924" /><stop offset="1" stop-color="#08061a" />
          </linearGradient>
          <linearGradient id="sb-g-plate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2a2358" /><stop offset="1" stop-color="#140f34" />
          </linearGradient>
          <linearGradient id="sb-g-shelf" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#2b2456" /><stop offset=".12" stop-color="#1a1440" /><stop offset="1" stop-color="#0b0820" />
          </linearGradient>
          <linearGradient id="sb-g-metal" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#5b6190" /><stop offset=".35" stop-color="#dfe3ff" /><stop offset=".6" stop-color="#9aa0cc" /><stop offset="1" stop-color="#3b3f68" />
          </linearGradient>
          <radialGradient id="sb-g-hole" cx=".5" cy=".42" r=".6">
            <stop offset="0" stop-color="#000" /><stop offset=".7" stop-color="#05040f" /><stop offset="1" stop-color="#26204e" />
          </radialGradient>
          <pattern id="sb-jack" x="15" y=${GRID_Y - 10} width=${COL_W} height=${ROW_H} patternUnits="userSpaceOnUse">
            <circle cx="26.5" cy="10" r="6.6" fill="none" stroke="#221c4a" stroke-width="1" />
            <circle cx="26.5" cy="10" r="4.8" fill="url(#sb-g-hole)" stroke="#6c73a6" stroke-width="1.3" />
          </pattern>
        </defs>
        <rect x="1" y="1" width="558" height="498" rx="14" fill="url(#sb-g-frame)" class="sb-frame" />
        <rect x="9" y="9" width="542" height="482" rx="9" fill="url(#sb-g-panel)" class="sb-panel" />
        <path d="M18 10.5 H542" class="sb-panel__hi" />

        <g class="sb-cols" aria-hidden="true">
          ${domains.map((_, c) => c > 0 && html`<line key=${c} x1=${15 + COL_W * c} y1="46" x2=${15 + COL_W * c} y2="344" />`)}
        </g>
        <g class="sb-plates">
          ${domains.map(([d], c) => html`
            <g key=${d} class=${`sb-plate${lit.has(c) ? ` sb-plate--on sb-tone--${lit.get(c)}` : ''}`}>
              <rect x=${41.5 + COL_W * c - 23} y="20" width="46" height="17" rx="3" />
              <text x=${41.5 + COL_W * c} y="32.5">${(SHORT[d] ?? d).toUpperCase().slice(0, 7)}</text>
            </g>
          `)}
          ${last?.col !== undefined && html`<rect key=${`pf${last.key}`} x=${41.5 + COL_W * last.col - 23} y="20" width="46" height="17" rx="3"
            class=${`sb-plate__flash sb-tone--${last.tone}`} />`}
        </g>
        <rect x="15" y=${GRID_Y - 10} width=${COL_W * 10} height=${ROW_H * 15} fill="url(#sb-jack)" />
        <line x1="18" y1="358" x2="542" y2="358" class="sb-rule" />

        <g class="sb-status">
          <circle cx="36" cy="378" r="6" class=${`sb-lamp${onLine ? ' sb-lamp--on' : ''}`} />
          <text x="50" y="382" class="sb-status__t">${status}</text>
          <text x="30" y="404" class="sb-status__k">QUEUE</text>
          ${Array.from({ length: QUEUE_LAMPS }, (_, k) => html`
            <rect key=${k} x=${74 + k * 13} y="396" width="9" height="10" rx="2"
              class=${`sb-q${open && k < queue ? ` sb-q--on sb-q--${k < 4 ? 'ok' : k < 8 ? 'warn' : 'err'}` : ''}`} />
          `)}
          <text x=${74 + QUEUE_LAMPS * 13 + 4} y="405" class="sb-status__n">${!open ? '' : queue > QUEUE_LAMPS ? `${queue}+` : queue}</text>
        </g>

        <g class="sb-special">
          <circle cx=${OOS_XY[0]} cy=${OOS_XY[1]} r="13" class="sb-bezel" />
          <circle cx=${OOS_XY[0]} cy=${OOS_XY[1]} r="8.5" class="sb-jack sb-jack--oos" />
          <text x=${OOS_XY[0]} y="418" class="sb-cap sb-t-warn">OUT OF SCOPE</text>
          <circle cx=${OP_XY[0]} cy=${OP_XY[1]} r="15" class="sb-bezel" />
          <circle cx=${OP_XY[0]} cy=${OP_XY[1]} r="10" class="sb-jack sb-jack--op" />
          <text x=${OP_XY[0]} y="418" class="sb-cap sb-t-vi">☎ OPERATOR</text>
        </g>

        <rect x="12" y="428" width="536" height="60" rx="6" fill="url(#sb-g-shelf)" class="sb-shelf" />
        ${Array.from({ length: SLOTS }, (_, s) => html`<rect key=${`s${s}`} x=${slotX(s) - 9} y=${PLUG_Y - 2} width="18" height="6" rx="2" class="sb-socket" />`)}

        ${cords.map(({ to, tone, key }) => html`<circle key=${`h${key}`} cx=${to[0]} cy=${to[1]} r="11" class=${`sb-halo sb-tone--${tone}`} />`)}
        ${cords.map(({ d, tone, key }, j) => html`
          <g key=${`c${key}`} class=${`sb-cord sb-tone--${tone}${j === cords.length - 1 ? ' sb-cord--new' : ''}`}
            style=${{ opacity: 0.5 + (0.5 * (j + 1)) / cords.length }}>
            <path d=${d} class="sb-cord__shade" pathLength="100" />
            <path d=${d} class="sb-cord__body" pathLength="100" />
            <path d=${d} class="sb-cord__braid" />
          </g>
        `)}
        ${cords.map(({ to, tone, key }) => html`
          <g key=${`t${key}`} class=${`sb-tip sb-tone--${tone}`}>
            <rect x=${to[0] - 3} y=${to[1] + 3} width="6" height="8" rx="1.5" fill="url(#sb-g-metal)" />
            <circle cx=${to[0]} cy=${to[1]} r="5" class="sb-tip__lamp" />
          </g>
        `)}
        ${last && html`<circle key=${`r${last.key}`} cx=${last.to[0]} cy=${last.to[1]} r="6" class=${`sb-ring sb-tone--${last.tone}`} />`}

        ${cords.map(({ plug, tone, key, a, v }) => html`
          <g key=${`p${key}`} class=${`sb-plug sb-tone--${tone}`}>
            <rect x=${plug - 7} y=${PLUG_Y} width="14" height="7" rx="2" class="sb-plug__collar" />
            <rect x=${plug - 6} y=${PLUG_Y + 6} width="12" height="16" rx="3" fill="url(#sb-g-metal)" />
            <circle cx=${plug - 12} cy=${PLUG_Y + 36} r="8" class="sb-plug__lamp" />
            <text x=${plug - 12} y=${PLUG_Y + 40} class="sb-plug__mark">${v.mark}</text>
            <text x=${plug - 1} y=${PLUG_Y + 40} class="sb-plug__no">#${a.call + 1}</text>
          </g>
        `)}

        ${callout && html`
          <g key=${`o${callout.key}`} class=${`sb-callout sb-tone--${callout.tone}`}>
            <rect x=${callout.x} y=${callout.y} width=${callout.w} height="26" rx="4" />
            <text x=${callout.x + callout.w / 2} y=${callout.y + 17}>${callout.text}</text>
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
        <div class="sb-ticket" key=${`k${a.call}`}>
          <span class="sb-ticket__no g-mono">CALL #${a.call + 1}</span>
          <p class="sb-pick__call">“${call?.text}”</p>
        </div>
        ${a.top
          ? html`<${Bars} lane=${lane.index} compact items=${a.top.map((t) => ({ label: t.option, p: t.p }))} max=${5} />
              <${Label} note=${a.confidence.toFixed(2)}>CONFIDENCE<//>
              <${Meter} value=${a.confidence} tone=${a.confidence >= run.threshold ? 'ok' : 'warn'}
                marks=${[{ at: run.threshold, label: `threshold ${run.threshold}` }]} />
              <p class="g-mono g-muted sb-pick__rule">
                under ${run.threshold.toFixed(2)} → operator · top is out of scope → polite no · else connect
              </p>`
          : html`<p class="sb-pick__said g-mono"><span class="sb-pick__k">LINE:</span> ${a.said || '—'}</p>`}
        <div class=${`sb-verdict sb-tone--${v.tone}`} key=${`v${a.call}`}>
          <span class="sb-verdict__mark" aria-hidden="true">${v.mark}</span>
          <span class="sb-verdict__txt"><b>${v.label}</b>${a.intent && html`<span class="g-mono">${a.intent}</span>`}<span class="sb-verdict__ms g-mono">answered in ${fmtMs(a.ms)}</span></span>
        </div>
      `}
    <//>
  `
}

/** A lane's tally: the score, how its callers fared, and its queue over time. */
function Tally({ lane, sound, win }) {
  const backlog = lane.backlog ?? []
  const answered = lane.answered ?? 0
  const right = lane.right ?? 0
  const op = lane.operator ?? 0
  const wrong = lane.wrong ?? 0
  const dropped = lane.dropped ?? 0
  const mix = [
    ['ok', right, '✓', 'right'],
    ['vi', op, '☎', 'operator'],
    ['err', wrong, '✕', 'wrong'],
    ['warn', dropped, '–', 'hung up'],
  ]
  const max = Math.max(4, ...backlog)
  const tail = backlog.slice(-60)
  const line = tail.map((n, i, arr) => `${((i / Math.max(1, arr.length - 1)) * 100).toFixed(1)},${(21 - (n / max) * 18).toFixed(1)}`).join(' ')
  const gid = `sb-q-${lane.index}`
  return html`
    <${Box} lane=${lane.index} class=${`sb-tally${win ? ' sb-tally--win' : ''}`}>
      ${win && html`<span class="sb-tally__crown"><span aria-hidden="true">★</span> WINNER</span>`}
      <${LaneHead} lane=${lane} />
      <div class="sb-tally__row">
        <div class="sb-tally__score">
          <${Counter} value=${lane.score ?? 0} class="g-score sb-score" sound=${sound} />
          <small>points</small>
        </div>
        <div class="sb-tally__mid">
          <div class="sb-mix" role="img" aria-label=${`${right} right, ${op} to the operator, ${wrong} wrong or foul, ${dropped} hung up`}>
            ${mix.map(([tone, n]) => html`<span key=${tone} class=${`sb-mix__seg sb-tone--${tone}`} style=${{ flexGrow: n }} />`)}
          </div>
          <div class="sb-mix__key" aria-hidden="true">
            ${mix.map(([tone, n, g, l]) => html`<span key=${tone} class=${`sb-mix__k sb-tone--${tone}`}><b>${g}</b><span class="tnum">${n}</span><small>${l}</small></span>`)}
          </div>
        </div>
        <div class="sb-queue" title="callers waiting in this lane's queue">
          <span class="g-stat__k">queue <b class="tnum">${lane.queue ?? 0}</b></span>
          <svg viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id=${gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" class="sb-q-top" /><stop offset="1" class="sb-q-bot" />
              </linearGradient>
            </defs>
            ${tail.length > 1 && html`<polygon points=${`0,22 ${line} 100,22`} fill=${`url(#${gid})`} />`}
            <polyline points=${line} class="sb-spark" />
          </svg>
        </div>
      </div>
      <div class="g-stats sb-tally__stats">
        <${Stat} label="right" value=${`${right}${answered ? ` · ${fmtPct(right / answered)}` : ''}`} />
        <${Stat} label="fouls" value=${lane.fouls} tone=${lane.fouls ? 'err' : undefined} />
        <${Stat} label="per call" value=${fmtMs(perCall(lane))} />
        <${Stat} label="cost" value=${laneCostText(lane)} />
      </div>
    <//>
  `
}
