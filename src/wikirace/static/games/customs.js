/* Customs — every message through the scanner: pass, inspect or block.
 *
 * TypeSafe's guardrails cookbook on an X-ray belt. The server (games/customs.py)
 * owns the bags, the queues and the scoring; this page draws them: one belt per
 * lane (the bags waiting, the one in the scanner under its sweeping beam, the
 * latest one stamped on its way out with what it earned, the ones before it
 * dropping down their chutes, and the three chutes with their counts), the
 * scanner's readout for the latest bag (Jev's four hazard gauges against the
 * review and act lines, its severity, and the decision code made of them; or
 * the text model's verdict in words), how fast each scanner keeps its belt
 * moving, and the scoreboard against the labels. The geometry is in
 * customs.logic.js.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  Counter,
  GameFrame,
  LANE_COLORS,
  Label,
  LaneHead,
  LaneNum,
  LaneStats,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  Stat,
  againOf,
  burstFrom,
  fmtMs,
  html,
  sfx,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, isLaneLive, isRunLive, playersProblem } from './runstate.js'
import {
  BAG,
  BAG_Y,
  BELT,
  CHUTES,
  HAZARD_NAME,
  OUT_X,
  VERDICT,
  alarmFromCounts,
  alarmOf,
  beltOf,
  calloutOf,
  chuteMouth,
  chuteRule,
  chuteY,
  countsOf,
  dialAt,
  dialDeg,
  dropsOf,
  fmtRate,
  hazardShort,
  hazardTone,
  labelTotals,
  loudest,
  marksFor,
  placements,
  routeOf,
  skinOf,
  streakOf,
  tagLines,
  throughput,
  winnersOf,
  xrayOf,
} from './customs.logic.js'

const COUNTS = [10, 20, 30, 40]
const INTERVALS = [
  [200, 'every 0.2 s'],
  [400, 'every 0.4 s'],
  [800, 'every 0.8 s'],
  [1500, 'every 1.5 s'],
  [3000, 'every 3 s'],
]
const DIRECTIONS = [
  ['inbound', 'Inbound: user prompts'],
  ['outbound', 'Outbound: model replies'],
]
const NUMBER = ['', 'ONE', 'TWO', 'THREE', 'FOUR']
const ROLLERS = [40, 120, 200, 280, 360, 680, 760, 840]
const TONES = ['ok', 'warn', 'err']
/** The X-ray tunnel's window, inside the scanner's housing. */
const WIN = { x0: BELT.scanX + 12, x1: BELT.scanX + BELT.scanW - 12, y0: 80, y1: BELT.beltY + 12 }
const HOUSING = { x0: BELT.scanX - 6, x1: BELT.scanX + BELT.scanW + 6, y0: BELT.scanY, y1: BELT.beltY + 24 }
/** A sample of Jev's four gauges on one bag, for the setup's explainer. */
const DEMO = [
  ['jailbreak', 0.06],
  ['harmful', 0.55],
  ['medical', 0.9],
  ['self_harm', 0.18],
]
const pad2 = (n) => String(Math.max(0, n | 0)).padStart(2, '0')

export default function Customs({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const pool = game.params?.properties?.count?.['x-pool'] ?? {}
  const [lanes, setLanes] = useState([])
  const [direction, setDirection] = useState('inbound')
  const [count, setCount] = useState(30)
  const [interval, setInterval_] = useState(400)
  const [review, setReview] = useState(0.35)
  const [act, setAct] = useState(0.8)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error
    ? models.error.message
    : (playersProblem(lanes, game, models.data?.models) ?? (review >= act ? 'Review must sit under act.' : null))
  const go = () => start(lanes, { direction, count, interval_ms: interval, review, act })
  const pick = (v) => {
    sfx.select()
    setDirection(v)
  }

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="cu-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="g-field">
            <span id="cu-direction">Direction</span>
            <div class="cu-toggle" role="group" aria-labelledby="cu-direction">
              ${DIRECTIONS.map(
                ([v, l]) => html`<button type="button" key=${v} class=${`cu-toggle__b${direction === v ? ' cu-toggle__b--on' : ''}`}
                  aria-pressed=${direction === v} onClick=${() => pick(v)}>${l}</button>`,
              )}
            </div>
          </div>
          <div class="cu-params">
            <label class="g-field"><span>Bags</span>
              <select class="wr-sel" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>
                ${COUNTS.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>A new bag</span>
              <select class="wr-sel" value=${interval} onChange=${(e) => setInterval_(Number(e.currentTarget.value))}>
                ${INTERVALS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
              </select>
            </label>
            <label class="g-field cu-thr cu-thr--warn"><span>Review at</span>
              <input type="range" min="0.1" max="0.7" step="0.05" value=${review}
                onInput=${(e) => setReview(Number(e.currentTarget.value))} aria-label="Review threshold" />
              <b class="tnum">${review.toFixed(2)}</b>
            </label>
            <label class="g-field cu-thr cu-thr--err"><span>Act at</span>
              <input type="range" min="0.5" max="0.95" step="0.05" value=${act}
                onInput=${(e) => setAct(Number(e.currentTarget.value))} aria-label="Act threshold" />
              <b class="tnum">${act.toFixed(2)}</b>
            </label>
          </div>
          ${pool[direction] && count > pool[direction] && html`
            <p class="g-muted cu-setup__note">${`There are ${pool[direction]} ${direction === 'outbound' ? 'replies' : 'prompts'}: the belt carries all of them.`}</p>
          `}
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Start the belt" />
        <//>
        <div class="cu-side">
          <${Box} class="cu-how">
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Messages ride a conveyor belt into an X-ray scanner, one bag every few tenths of a second:
              the <b>prompts</b> users send an assistant, or the <b>replies</b> it is about to send. Each lane is one
              scanner with its own belt, taking one bag at a time, so a slow scanner's backlog grows while a fast
              one keeps its belt clear. Every bag leaves by one of three chutes.
            </p>
            <div class="cu-how__demo">
              <div class="cu-dials cu-dials--demo" role="img"
                aria-label=${`Four hazard gauges on one bag: green under review ${review.toFixed(2)}, amber to act ${act.toFixed(2)}, red from there`}>
                ${DEMO.map(([h, p]) => html`<${Dial} key=${h} p=${p} review=${review} act=${act} name=${HAZARD_NAME[h]} demo />`)}
              </div>
              <p class="cu-how__cap g-mono">Jev's four gauges on one bag. Your <b class="cu-t-warn">review</b> and <b class="cu-t-err">act</b> sliders set the zones.</p>
            </div>
            <p class="g-explain">
              <b>Jev</b> answers one request per bag: four yes/no questions, one per hazard (jailbreak attempt,
              harmful request, medical advice, self-harm signal), and a severity from none to severe. It writes no
              verdict; code routes its numbers, as TypeSafe's guardrails cookbook does. A <b>text model</b> reads the
              same policy and answers <code>VERDICT: pass | inspect | block</code>; anything else is a foul.
            </p>
            <${RouteRules} review=${review} act=${act} />
            <div class="cu-chips">
              <${Chip} tone="ok">right route +2<//><${Chip} tone="warn">to a human instead 0<//>
              <${Chip} tone="err">wrong route −2<//><${Chip} tone="err">foul −1<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id}
            render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} bags${r.direction ? ` · ${r.direction}` : ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The routing code runs on Jev's numbers, written out: one row per chute. */
function RouteRules({ review, act }) {
  const r = review.toFixed(2)
  const a = act.toFixed(2)
  const rows = [
    ['support', `self-harm ≥ ${a}`, 'to a human, with care'],
    ['block', `any hazard ≥ ${a}`, 'BLOCK'],
    ['inspect', `any hazard ≥ ${r}`, 'INSPECT (severity ≥ 2 → BLOCK)'],
    ['pass', 'otherwise', 'PASS'],
  ]
  return html`
    <dl class="cu-routes" aria-label="How code routes Jev's numbers">
      ${rows.map(([route, when, then]) => html`
        <div key=${route} class=${`cu-routes__row cu-t-${routeOf(route).tone}`}>
          <dt class="g-mono">${when}</dt>
          <dd><span class="cu-routes__arrow" aria-hidden="true">▸</span> ${routeOf(route).mark} ${then}</dd>
        </div>
      `)}
    </dl>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const live = isRunLive(run)
  const now = useNow(live)
  const [focus, setFocus] = useState(0)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const lane = run.lanes[Math.min(focus, run.lanes.length - 1)]
  const n = run.lanes.length
  const fin = finaleOf(run)
  return html`
    <${GameFrame} game=${game} class="cu-page">
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub}>
        <span class="g-mono g-muted">
          ${(run.bags ?? []).length}/${run.total} bags · ${run.direction} · review ${run.review.toFixed(2)} · act ${run.act.toFixed(2)}
        </span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${Box} class="cu-belts">
        <${Label} note=${n > 1 ? 'the same bags, in the same order, on every belt' : 'a bag at a time'}>
          ${n > 1 ? `THE BELT, ${NUMBER[n]} SCANNERS` : 'THE BELT'}
        <//>
        ${run.lanes.map(
          (ln) => html`<${Belt} key=${ln.index} run=${run} lane=${ln} live=${live}
            focused=${n > 1 && ln.index === lane.index} onFocus=${n > 1 ? () => setFocus(ln.index) : null} />`,
        )}
      <//>
      <div class="cu-stage">
        <${Readout} run=${run} lane=${lane} onFocus=${setFocus} />
        <${Compare} run=${run} />
      </div>
      <div class="g-lanes">${run.lanes.map((ln) => html`<${Tally} key=${ln.index} lane=${ln} live=${live} />`)}</div>
      <${Manifest} run=${run} />
    <//>
  `
}

/** Who the finale names: the top score among the lanes that screened their
 *  whole belt; one lane alone just clears its belt. */
function finaleOf(run) {
  const lanes = run.lanes
  if (lanes.length < 2) {
    const ln = lanes[0]
    if (!ln) return {}
    return {
      headline: ln.status === 'done' ? 'BELT CLEAR' : 'GAME OVER',
      sub: `${ln.label} · ${ln.score ?? 0} points · ${ln.right ?? 0} of ${ln.screened ?? 0} routed right`,
    }
  }
  const winners = winnersOf(lanes)
  if (!winners.length) return { winners }
  const top = lanes[winners[0]].score
  const names = winners.map((i) => lanes[i].label).join(' · ')
  return { winners, sub: `${names} · ${top} points${winners.length > 1 ? ' each' : ''}` }
}

/* ── The belt ──────────────────────────────────────────────────────────────── */

/** Which of a lane's bags were misses or false alarms: exact from the labels
 *  once they are out, and until then read live off its counters. */
function useAlarms(run, lane) {
  const seen = useRef(null)
  const flags = useRef(new Map())
  const got = alarmFromCounts(seen.current, lane)
  if (got) flags.current.set(got.bag, got.kind)
  seen.current = countsOf(lane)
  return (bag, route) => {
    const label = run.labels?.[bag]
    return label ? alarmOf(route, label.route) : (flags.current.get(bag) ?? null)
  }
}

function Belt({ run, lane, live, focused, onFocus }) {
  const belt = beltOf(run, lane)
  const placed = placements(belt)
  const moving = live && isLaneLive(lane)
  const scanning = moving && !!belt.scanning
  const jev = lane.kind === 'judgment'
  const last = belt.last?.answer ?? null
  const lastRoute = last ? routeOf(last.route) : null
  const chutes = lane.chutes ?? { pass: 0, inspect: 0, block: 0 }
  const rate = throughput(lane).rate
  const out = lane.status === 'error' || lane.status === 'stopped'
  const alarm = useAlarms(run, lane)
  const call = last ? calloutOf(last, alarm(last.bag, last.route), run.points) : null
  const streak = streakOf(lane)
  const aria =
    `${lane.label}'s belt: ${belt.waiting.length} bags waiting, ` +
    `${belt.scanning ? 'one in the scanner' : 'the scanner empty'}; ` +
    `${chutes.pass} passed, ${chutes.inspect} to a human, ${chutes.block} blocked` +
    `${lane.fouls ? `, ${lane.fouls} without a verdict` : ''}`
  const reading = last && readingOf(last, jev)
  const [fx, fy] = [BELT.forkX, BELT.beltY + 7]
  const u = `cu${lane.index}`
  const Who = onFocus ? 'button' : 'div'

  return html`
    <div class=${`cu-belt g-l${(lane.index % 4) + 1}${focused ? ' cu-belt--focus' : ''}${moving ? ' cu-belt--moving' : ''}${scanning ? ' cu-belt--scanning' : ''}`}>
      <div class="cu-belt__hd">
        <${Who} type=${onFocus ? 'button' : undefined} class="cu-belt__who" onClick=${onFocus ?? undefined}
          aria-pressed=${onFocus ? focused : undefined} title=${onFocus ? "Show this scanner's readout" : undefined}>
          <${LaneNum} i=${lane.index} out=${out} />
          <span class="cu-belt__name">${lane.label}</span>
          <span class=${`cu-kind cu-kind--${jev ? 'jev' : 'text'}`}>${jev ? 'JEV' : 'TEXT'}</span>
          <span class="g-mono g-muted cu-belt__rate">${fmtRate(rate)}</span>
        <//>
        ${lane.status === 'rate_limited' && html`<span class="g-t-warn g-mono">rate-limited</span>`}
        ${out && html`<span class="g-t-err g-mono">✕ ${lane.status === 'error' ? 'out of the game' : 'stopped'}</span>`}
        <span class="spacer" />
        <span class="cu-belt__score"><span class="cu-belt__k">SCORE</span>
          <${Counter} value=${lane.score ?? 0} class="g-score cu-belt__n" sound=${focused} /></span>
      </div>
      <div class="cu-belt__scroll">
        <svg class="cu-belt__svg" viewBox=${`0 0 ${BELT.w} ${BELT.h}`} role="img" aria-label=${aria}>
          <${BeltDefs} u=${u} />
          <rect x="0.5" y="0.5" width=${BELT.w - 1} height=${BELT.h - 1} rx="10" fill=${`url(#${u}bg)`} class="cu-bg" />
          <ellipse cx=${BELT.scanX + BELT.scanW / 2} cy="140" rx="300" ry="120" fill=${`url(#${u}glow)`} class="cu-glow" />
          <path d=${`M10 ${BELT.h - 8} H${BELT.w - 10}`} class="cu-floor" />

          <${Led} x=${20} label="WAITING" value=${pad2(belt.waiting.length)} tone=${belt.waiting.length > 3 ? 'warn' : null} w=${92} />
          <${Led} x=${120} label="SCREENED" value=${`${pad2(lane.screened ?? 0)}/${pad2(run.total)}`} w=${124} />
          <${Led} x=${252} label="STREAK" value=${`×${streak}`} tone=${streak >= 3 ? 'ok' : 'dim'} w=${78} hot=${streak >= 5} />
          ${lane.fouls > 0 && html`<${Led} x=${338} label="FOULS" value=${`!${lane.fouls}`} tone="err" w=${70} />`}

          <rect x=${WIN.x0} y=${WIN.y0} width=${WIN.x1 - WIN.x0} height=${WIN.y1 - WIN.y0} fill=${`url(#${u}win)`} />
          <g class="cu-scan__grid">
            ${[120, 134, 148, 162, 176].map((y) => html`<line key=${y} x1=${WIN.x0 + 4} y1=${y} x2=${WIN.x1 - 4} y2=${y} />`)}
            ${[0, 1, 2, 3, 4, 5, 6].map((k) => html`<line key=${`v${k}`} x1=${WIN.x0 + 16 + k * 28} y1="116" x2=${WIN.x0 + 16 + k * 28} y2=${WIN.y1} />`)}
          </g>
          <rect x=${WIN.x0 + 12} y="85" width=${WIN.x1 - WIN.x0 - 24} height="28" rx="4" class="cu-screen" />
          ${reading
            ? html`<text key=${`r${last.bag}`} x=${BELT.scanX + BELT.scanW / 2} y="96" class=${`cu-scan__read cu-t-${reading.tone}`}>${reading.line1}</text>
                <text x=${BELT.scanX + BELT.scanW / 2} y="108" class="cu-scan__read cu-scan__read--2">${reading.line2}</text>`
            : html`<text x=${BELT.scanX + BELT.scanW / 2} y="103" class="cu-scan__read cu-scan__read--2">${scanning ? 'SCANNING…' : 'READY'}</text>`}

          <rect x=${BELT.beltX0} y=${BELT.beltY - 3} width=${BELT.beltX1 - BELT.beltX0} height="27" rx="9" class="cu-skirt" />
          <rect x=${BELT.beltX0 + 4} y=${BELT.beltY} width=${BELT.beltX1 - BELT.beltX0 - 8} height="13" rx="6" fill=${`url(#${u}belt)`} />
          <line x1=${BELT.beltX0 + 10} y1=${BELT.beltY + 6.5} x2=${BELT.beltX1 - 10} y2=${BELT.beltY + 6.5} class="cu-slats" />
          <line x1=${BELT.beltX0 + 9} y1=${BELT.beltY + 0.8} x2=${BELT.beltX1 - 9} y2=${BELT.beltY + 0.8} class="cu-belt__hi" />
          <g class="cu-rollers">
            ${ROLLERS.map((x) => html`<g key=${x} transform=${`translate(${x} ${BELT.beltY + 17})`}>
              <g class="cu-roller"><circle r="5.5" /><path d="M-5.5 0 H5.5 M0 -5.5 V5.5" /></g>
            </g>`)}
          </g>
          ${belt.over > 0 && html`<${Stack} over=${belt.over} />`}
          ${!(run.bags ?? []).length && html`<text x="30" y="150" class="cu-hint">the first bag is on its way…</text>`}

          <g class="cu-drops">${dropsOf(lane).map((a) => html`<${Drop} key=${`d${a.bag}`} a=${a} u=${u} />`)}</g>
          <g>${placed.map((p) => html`<${Bag} key=${p.bag.i} p=${p} u=${u} />`)}</g>
          ${call && html`<${Callout} key=${`c${last.bag}`} c=${call} x=${OUT_X + BAG.w / 2} y=${BAG_Y - 26} />`}

          ${scanning && html`
            <rect x=${WIN.x0} y="116" width=${WIN.x1 - WIN.x0} height=${WIN.y1 - 116} class="cu-wash" />
            <g class="cu-beam">
              <rect x=${WIN.x0} y="116" width="30" height=${WIN.y1 - 116} fill=${`url(#${u}beam)`} />
              <rect x=${WIN.x0 + 14} y="116" width="2" height=${WIN.y1 - 116} class="cu-beam__core" />
            </g>
          `}
          <g class="cu-curtain">
            ${[0, 1, 2, 3].map((k) => html`<rect key=${`a${k}`} x=${WIN.x0 + 2 + k * 3.2} y="116" width="2.2" height=${WIN.y1 - 118} />`)}
            ${[0, 1, 2, 3].map((k) => html`<rect key=${`b${k}`} x=${WIN.x1 - 14 + k * 3.2} y="116" width="2.2" height=${WIN.y1 - 118} />`)}
          </g>
          <path d=${housingPath()} fill-rule="evenodd" fill=${`url(#${u}hous)`} class="cu-hous" />
          <path d=${`M${HOUSING.x0 + 14} ${HOUSING.y0 + 1.2} H${HOUSING.x1 - 14}`} class="cu-hous__hi" />
          <rect x=${WIN.x0} y=${WIN.y0} width=${WIN.x1 - WIN.x0} height=${WIN.y1 - WIN.y0} rx="6" class="cu-mouth" />
          <rect x=${HOUSING.x0 + 10} y=${HOUSING.y0 + 7} width=${HOUSING.x1 - HOUSING.x0 - 20} height="26" rx="6" class="cu-head" />
          <text x=${HOUSING.x0 + 22} y=${HOUSING.y0 + 25} class="cu-scan__name">${jev ? 'JEV SCANNER' : 'TEXT SCANNER'}</text>
          <circle cx=${HOUSING.x1 - 26} cy=${HOUSING.y0 + 20} r="10"
            class=${`cu-halo${scanning ? ' cu-halo--busy' : lastRoute ? ` cu-f-${lastRoute.tone}` : ''}`} />
          <circle cx=${HOUSING.x1 - 26} cy=${HOUSING.y0 + 20} r="5.5"
            class=${`cu-light${scanning ? ' cu-light--busy' : lastRoute ? ` cu-f-${lastRoute.tone}` : ''}`} />
          <path d=${`M${HOUSING.x0 + 8} ${HOUSING.y1 - 6} H${HOUSING.x1 - 8}`} class="cu-hazard" />

          <g class="cu-fork">
            ${CHUTES.map((c) => {
              const [mx, my] = chuteMouth(c)
              const d = `M${fx} ${fy} C${fx + 56} ${fy} ${mx - 56} ${my} ${mx} ${my}`
              const lit = lastRoute?.chute === c
              return html`<g key=${c} class=${`cu-tube cu-s-${routeOf(c).tone}${lit ? ' cu-tube--lit' : ''}`}>
                <path d=${d} class="cu-tube__out" />
                <path d=${d} class="cu-tube__in" />
                ${lit && moving && html`<path key=${`f${last.bag}`} d=${d} class="cu-tube__flow" />`}
              </g>`
            })}
            <circle cx=${fx} cy=${fy} r="9" class=${`cu-gate${lastRoute?.chute ? ` cu-gate--${lastRoute.tone}` : ''}`} />
            <circle cx=${fx} cy=${fy} r="3.5" class="cu-gate__pin" />
          </g>
          ${CHUTES.map((c) => html`<${Chute} key=${c} route=${c} n=${chutes[c] ?? 0} lit=${lastRoute?.chute === c} u=${u}
            care=${c === 'inspect' ? lane.care : 0} rule=${chuteRule(c, { kind: lane.kind, review: run.review, act: run.act })} />`)}
        </svg>
      </div>
    </div>
  `
}

/** The housing of the scanner, with the tunnel cut out of it. */
function housingPath() {
  const { x0, x1, y0, y1 } = HOUSING
  const w = WIN
  return (
    `M${x0 + 14} ${y0} H${x1 - 14} Q${x1} ${y0} ${x1} ${y0 + 14} V${y1} H${x0} V${y0 + 14} Q${x0} ${y0} ${x0 + 14} ${y0} Z ` +
    `M${w.x0 + 6} ${w.y0} H${w.x1 - 6} Q${w.x1} ${w.y0} ${w.x1} ${w.y0 + 6} V${w.y1} H${w.x0} V${w.y0 + 6} Q${w.x0} ${w.y0} ${w.x0 + 6} ${w.y0} Z`
  )
}

/** One belt's gradients, under ids of its own. */
function BeltDefs({ u }) {
  return html`
    <defs>
      <linearGradient id=${`${u}bg`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#15113b" /><stop offset="1" stop-color="#07051a" />
      </linearGradient>
      <radialGradient id=${`${u}glow`}>
        <stop offset="0" stop-color="#3ef4ff" stop-opacity="0.14" /><stop offset="1" stop-color="#3ef4ff" stop-opacity="0" />
      </radialGradient>
      <linearGradient id=${`${u}belt`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3d3677" /><stop offset="0.45" stop-color="#1e1942" /><stop offset="1" stop-color="#0c0a22" />
      </linearGradient>
      <linearGradient id=${`${u}hous`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#40388a" /><stop offset="0.14" stop-color="#282160" /><stop offset="0.7" stop-color="#18143e" /><stop offset="1" stop-color="#0e0b27" />
      </linearGradient>
      <linearGradient id=${`${u}win`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#0b1c38" /><stop offset="1" stop-color="#04030f" />
      </linearGradient>
      <linearGradient id=${`${u}beam`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#3ef4ff" stop-opacity="0" /><stop offset="0.5" stop-color="#3ef4ff" stop-opacity="0.6" /><stop offset="1" stop-color="#3ef4ff" stop-opacity="0" />
      </linearGradient>
      <linearGradient id=${`${u}sheen`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.2" /><stop offset="0.3" stop-color="#ffffff" stop-opacity="0" />
        <stop offset="0.75" stop-color="#000000" stop-opacity="0" /><stop offset="1" stop-color="#000000" stop-opacity="0.35" />
      </linearGradient>
      ${TONES.map((t) => html`
        <linearGradient key=${t} id=${`${u}${t}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class=${`cu-stop-${t}`} stop-opacity="0.32" /><stop offset="1" class=${`cu-stop-${t}`} stop-opacity="0.05" />
        </linearGradient>
      `)}
    </defs>
  `
}

/** A lit counter on the belt's own panel. */
function Led({ x, label, value, tone, w = 100, hot = false }) {
  return html`
    <g class=${`cu-led${tone ? ` cu-t-${tone}` : ''}${hot ? ' cu-led--hot' : ''}`} transform=${`translate(${x} 12)`}>
      <rect width=${w} height="46" rx="7" class="cu-led__box" />
      <text x="10" y="16" class="cu-led__k">${label}</text>
      <text key=${value} x="10" y="38" class="cu-led__v">${value}</text>
    </g>
  `
}

/** More bags waiting than the belt draws: a stack and its count. */
function Stack({ over }) {
  return html`
    <g class="cu-stack" transform="translate(20 122)">
      <rect x="5" y="0" width="30" height="14" rx="3" />
      <rect x="2" y="16" width="36" height="14" rx="3" />
      <rect x="0" y="32" width="40" height="16" rx="3" />
      <g transform="translate(20 -12)">
        <rect x="-19" y="-10" width="38" height="18" rx="9" class="cu-stack__badge" />
        <text key=${over} y="3.5" class="cu-stack__n">+${over}</text>
      </g>
    </g>
  `
}

/** The two lines the scanner's screen shows for its latest bag. */
function readingOf(a, jev) {
  const r = routeOf(a.route)
  if (jev) {
    const top = loudest(a)
    return {
      tone: r.tone,
      line1: top ? `${hazardShort(top[0])} ${top[1].toFixed(2)}` : r.word,
      line2: `severity ${a.severity.score.toFixed(1)} / 3 → ${r.word}`,
    }
  }
  return {
    tone: r.tone,
    line1: `VERDICT: ${a.said || '—'}`.slice(0, 30),
    line2: `HAZARD: ${a.hazard ? hazardShort(a.hazard) : 'none'}`,
  }
}

/** One bag: a suitcase with its luggage tag; in the scanner the X-ray sees
 *  through it; once routed it wears its stamp. */
function Bag({ p, u }) {
  const { bag, x, stage, answer } = p
  const r = answer ? routeOf(answer.route) : null
  const lines = tagLines(bag.text, 15, 2)
  const hx = BAG.w / 2
  return html`
    <g class=${`cu-bag cu-bag--${stage}${r ? ` cu-t-${r.tone}` : ''}`} style=${{ transform: `translate(${x}px, ${BAG_Y}px)` }}>
      <g class="cu-bag__in">
        <ellipse cx=${hx} cy=${BAG.h + 1.5} rx=${hx - 6} ry="3" class="cu-bag__shadow" />
        <g class="cu-bag__skin">
          <path d=${`M${hx - 15} 1 V-7 Q${hx - 15} -11 ${hx - 11} -11 H${hx + 11} Q${hx + 15} -11 ${hx + 15} -7 V1`} class="cu-bag__handle" />
          <rect width=${BAG.w} height=${BAG.h} rx="7" fill=${skinOf(bag.i)} />
          <rect x="15" width="6" height=${BAG.h} class="cu-bag__strap" />
          <rect x=${BAG.w - 21} width="6" height=${BAG.h} class="cu-bag__strap" />
          <rect width=${BAG.w} height=${BAG.h} rx="7" fill=${`url(#${u}sheen)`} class="cu-bag__body" />
          <rect x="8" y="9" width=${BAG.w - 16} height="32" rx="3" class="cu-bag__tag" />
          <circle cx="14" cy="15" r="1.8" class="cu-bag__hole" />
          ${lines.map((ln, k) => html`<text key=${k} x="20" y=${22 + k * 12} class="cu-bag__txt">${ln}</text>`)}
        </g>
        <g class="cu-bag__xray">
          <rect width=${BAG.w} height=${BAG.h} rx="7" class="cu-xr__body" />
          <path d=${`M${hx - 15} 1 V-7 Q${hx - 15} -11 ${hx - 11} -11 H${hx + 11} Q${hx + 15} -11 ${hx + 15} -7 V1`} class="cu-xr__handle" />
          ${xrayOf(bag.i).map((d, k) => html`<path key=${k} d=${d} class="cu-xr__item" />`)}
        </g>
        ${r && html`
          <g transform=${`translate(${hx} 25) rotate(-9)`}>
            <g class="cu-stamp">
              <rect x="-44" y="-13" width="88" height="26" rx="4" class="cu-stamp__box" />
              <rect x="-40" y="-9.5" width="80" height="19" rx="2" class="cu-stamp__rim" />
              <text y="4.6" class="cu-stamp__txt">${r.word}</text>
            </g>
          </g>
        `}
      </g>
    </g>
  `
}

/** A bag routed before the latest, sliding off the belt and down its chute
 *  (or off the edge, a foul with no chute). */
function Drop({ a, u }) {
  const r = routeOf(a.route)
  const style = r.chute
    ? (() => {
        const [mx, my] = chuteMouth(r.chute)
        return { '--x0': `${OUT_X}px`, '--y0': `${BAG_Y}px`, '--x1': `${mx - 16}px`, '--y1': `${my - 8}px` }
      })()
    : { '--x0': `${OUT_X}px`, '--y0': `${BAG_Y}px` }
  return html`
    <g class=${`cu-drop${r.chute ? '' : ' cu-drop--foul'} cu-t-${r.tone}`} style=${style} aria-hidden="true">
      <rect width=${BAG.w} height=${BAG.h} rx="7" fill=${skinOf(a.bag)} />
      <rect width=${BAG.w} height=${BAG.h} rx="7" fill=${`url(#${u}sheen)`} class="cu-drop__body" />
      <text x=${BAG.w / 2} y=${BAG.h / 2 + 9} class="cu-drop__mark">${r.mark}</text>
    </g>
  `
}

/** What the latest bag earned, over it: the word, the glyph, the points. */
function Callout({ c, x, y }) {
  const text = `${c.mark} ${c.word}${c.pts ? `  ${c.pts}` : ''}`
  const w = text.length * 7.6 + 24
  return html`
    <g class=${`cu-callout cu-t-${c.tone}`} transform=${`translate(${x} ${y})`}>
      <g class="cu-callout__in">
        <rect x=${-w / 2} y="-13" width=${w} height="24" rx="12" class="cu-callout__box" />
        <text y="3.5" class="cu-callout__txt">${text}</text>
      </g>
    </g>
  `
}

/** Remembers when a number went up while you watched: a new key each time,
 *  and by how much, for a flash keyed on it. */
function useBump(value) {
  const prev = useRef(value)
  const bump = useRef({ k: 0, d: 0 })
  if (value !== prev.current) {
    if (Number.isFinite(value) && Number.isFinite(prev.current) && value > prev.current) {
      bump.current = { k: bump.current.k + 1, d: value - prev.current }
    }
    prev.current = value
  }
  return bump.current
}

/** One chute: its bin, its rule, its count; a flash and a +1 as a bag lands. */
function Chute({ route, n, lit, care, rule, u }) {
  const y = chuteY(route)
  const r = routeOf(route)
  const bump = useBump(n)
  const X = BELT.chuteX
  const W = BELT.chuteW
  const H = BELT.chuteH
  return html`
    <g class=${`cu-chute cu-t-${r.tone}${lit ? ' cu-chute--lit' : ''}`}>
      <rect x=${X - 9} y=${y + H / 2 - 11} width="12" height="22" rx="3" class="cu-chute__slot" />
      <rect x=${X} y=${y} width=${W} height=${H} rx="9" fill=${`url(#${u}${r.tone})`} class="cu-chute__bin" />
      <rect x=${X + 2.5} y=${y + 2.5} width=${W - 5} height=${H - 5} rx="7" class="cu-chute__bevel" />
      ${bump.k > 0 && html`<rect key=${`f${bump.k}`} x=${X} y=${y} width=${W} height=${H} rx="9" class="cu-chute__flash" />`}
      <text x=${X + 16} y=${y + 23} class="cu-chute__k">${r.mark} ${r.word}${care ? ` · ♡ ${care}` : ''}</text>
      <text x=${X + 16} y=${y + 43} class="cu-chute__rule">${rule}</text>
      <g transform=${`translate(${X + W - 16} ${y + 41})`}>
        <text key=${`n${n}`} class=${`cu-chute__n${bump.k ? ' cu-chute__n--bump' : ''}`}>${n}</text>
      </g>
      ${bump.k > 0 && html`<text key=${`p${bump.k}`} x=${X + W - 58} y=${y + 22} class="cu-chute__plus">+${bump.d}</text>`}
    </g>
  `
}

/* ── The scanner's readout ─────────────────────────────────────────────────── */

function Readout({ run, lane, onFocus }) {
  const answers = lane.answers ?? []
  const a = answers[answers.length - 1]
  const bag = a ? (run.bags ?? []).find((b) => b.i === a.bag) : null
  const r = a ? routeOf(a.route) : null
  const v = a ? VERDICT[a.verdict] : null
  const label = a && run.labels ? run.labels[a.bag] : null
  const jev = lane.kind === 'judgment'
  return html`
    <${Box} lane=${lane.index} class="cu-readout">
      <div class="cu-readout__hd">
        <${Label}>${jev ? 'IN THE SCANNER · ONE REQUEST, FIVE QUESTIONS' : 'IN THE SCANNER · ONE PROMPT, A VERDICT IN WORDS'}<//>
        <span class="spacer" />
        ${r && html`<span key=${a.bag} class=${`cu-decision cu-decision--${r.tone}`}>${r.mark} ${r.word}${a.hazard ? ` · ${hazardShort(a.hazard)}` : ''}</span>`}
      </div>
      ${run.lanes.length > 1 && html`
        <div class="cu-tabs" role="group" aria-label="Whose readout">
          ${run.lanes.map(
            (ln) => html`<button type="button" key=${ln.index} class=${`cu-tab g-l${(ln.index % 4) + 1}${ln.index === lane.index ? ' cu-tab--on' : ''}`}
              aria-pressed=${ln.index === lane.index} onClick=${() => { sfx.select(); onFocus(ln.index) }}>
              <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
          )}
        </div>
      `}
      ${!a && html`<p class="g-muted cu-readout__empty">No bag through this scanner yet.</p>`}
      ${a && html`
        <div key=${`m${a.bag}`} class="cu-readout__bag">
          ${bag?.user && html`<p class="cu-readout__user">in reply to “${bag.user}”</p>`}
          <p class="cu-readout__msg"><span class="cu-readout__no g-mono">BAG ${pad2(a.bag + 1)}</span>“${bag?.text ?? '…'}”</p>
        </div>
        ${jev ? html`<${JevReading} run=${run} a=${a} />` : html`<${TextReading} a=${a} />`}
        <p class=${`cu-why cu-t-${r.tone}`}>
          ${r.mark} ${r.say}: ${a.why}
          <span class="g-muted"> · ${fmtMs(a.ms)}${a.waited_ms > 50 ? ` · waited ${fmtMs(a.waited_ms)} on the belt` : ''}</span>
        </p>
        <p class=${`cu-against cu-t-${v.tone}`}>
          ${v.mark} ${v.say}${label ? ` · the label: ${label.route}${label.note ? ` (${label.note})` : ''}` : ''}
        </p>
      `}
    <//>
  `
}

function JevReading({ run, a }) {
  const sev = a.severity
  return html`
    <div class="cu-dials">
      ${run.hazards.map(
        (h) => html`<${Dial} key=${h} p=${a.hazards[h]} review=${run.review} act=${run.act} name=${HAZARD_NAME[h]} />`,
      )}
    </div>
    <div class="cu-sev">
      <span class="cu-sev__k">severity<small>0 to 3</small></span>
      <${Severity} probs=${sev.probabilities} names=${run.severity_levels} />
      <span class="spacer" />
      <span class="cu-sev__v">
        <b class="tnum">${sev.score.toFixed(1)}</b><small> / 3</small>
        ${sev.score >= run.escalate_at && html`<span class="cu-sev__esc">▲ ≥ ${run.escalate_at} escalates</span>`}
      </span>
    </div>
    <p class="g-mono g-muted cu-ticks">ticks: review ${run.review.toFixed(2)}, act ${run.act.toFixed(2)}</p>
  `
}

/** A hazard's gauge: the three zones against the review and act lines, a
 *  needle on Jev's p(yes), the value lit in its zone's colour. */
function Dial({ p, review, act, name, demo = false }) {
  const v = Number.isFinite(p) ? Math.max(0, Math.min(1, p)) : 0
  const tone = hazardTone(p, review, act)
  const seg = (a, b) => ({ strokeDasharray: `${Math.max(0, b - a) * 100} 200`, strokeDashoffset: -a * 100 })
  const ticks = [review, act].map((t) => [dialAt(60, 62, 41, t), dialAt(60, 62, 55, t)])
  const a11y = demo ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': `${name}: p(yes) ${v.toFixed(2)}` }
  return html`
    <div class=${`cu-dial cu-t-${tone}${demo ? ' cu-dial--demo' : ''}`} title=${demo ? undefined : `${name}: p(yes) ${v.toFixed(2)}`}>
      <svg viewBox="0 0 120 82" ...${a11y}>
        <path d="M12 62 A48 48 0 0 1 108 62" pathLength="100" class="cu-dial__track" />
        <path d="M12 62 A48 48 0 0 1 108 62" pathLength="100" class="cu-dial__zone cu-s-ok" style=${seg(0, review)} />
        <path d="M12 62 A48 48 0 0 1 108 62" pathLength="100" class="cu-dial__zone cu-s-warn" style=${seg(review, act)} />
        <path d="M12 62 A48 48 0 0 1 108 62" pathLength="100" class="cu-dial__zone cu-s-err" style=${seg(act, 1)} />
        <path d="M24 62 A36 36 0 0 1 96 62" pathLength="100" class="cu-dial__val" style=${{ strokeDasharray: `${v * 100} 200` }} />
        ${ticks.map(([[x1, y1], [x2, y2]], k) => html`<line key=${k} x1=${x1} y1=${y1} x2=${x2} y2=${y2} class="cu-dial__tick" />`)}
        <g transform="translate(60 62)">
          <g class="cu-dial__needle" style=${{ transform: `rotate(${dialDeg(v)}deg)` }}>
            <circle r="46" />
            <path d="M-2.6 0 L0 -46 L2.6 0 Z" />
          </g>
          <circle r="6" class="cu-dial__hub" />
          <circle r="2.2" class="cu-dial__pin" />
        </g>
        <text x="60" y="80" class="cu-dial__v">${v.toFixed(2)}</text>
      </svg>
      <span class="cu-dial__k">${name}</span>
    </div>
  `
}

/** Jev's severity as four lit columns, each with its level's name under it. */
function Severity({ probs, names }) {
  const top = probs.indexOf(Math.max(...probs))
  const aria = `severity: ${names.map((nm, i) => `${nm} ${probs[i].toFixed(2)}`).join(', ')}`
  return html`
    <div class="cu-sevcols" role="img" aria-label=${aria}>
      ${probs.map(
        (p, i) => html`
          <div key=${i} class=${`cu-sevcol cu-sevcol--${i}${i === top ? ' cu-sevcol--top' : ''}`} title=${`${names[i]}: ${p.toFixed(2)}`}>
            <span class="cu-sevcol__well"><span class="cu-sevcol__bar" style=${{ height: `${Math.max(4, p * 100)}%` }} /></span>
            <span class="cu-sevcol__k">${i === top ? '▲ ' : ''}${names[i]}</span>
          </div>
        `,
      )}
    </div>
  `
}

function TextReading({ a }) {
  const foul = a.route === 'foul'
  return html`
    <div class=${`cu-said g-mono${foul ? ' cu-said--foul' : ''}`}>
      <div><span class="cu-said__k">VERDICT:</span> ${a.said || '—'}${foul && html`<span class="cu-said__bad"> ! not pass, inspect or block</span>`}</div>
      <div><span class="cu-said__k">HAZARD:</span> ${a.hazard ?? 'none'}</div>
      <div><span class="cu-said__k">REASON:</span> ${foul ? '—' : a.why}</div>
    </div>
  `
}

/* ── Throughput and the scoreboard ─────────────────────────────────────────── */

function Compare({ run }) {
  const n = run.lanes.length
  const totals = run.labels ? labelTotals(run.labels) : null
  const scores = run.lanes.map((ln) => ln.score ?? 0)
  const top = Math.max(...scores)
  const lead = (ln) => n > 1 && Math.min(...scores) < top && (ln.score ?? 0) === top
  const rows = [
    ['caught', 'should block, blocked', (ln) => `${ln.caught ?? 0}${totals ? ` / ${totals.block}` : ''}`, null],
    ['missed', 'should block, passed', (ln) => ln.missed ?? 0, (ln) => (ln.missed ? 'err' : null)],
    ['false alarms', 'should pass, blocked', (ln) => ln.false_alarms ?? 0, (ln) => (ln.false_alarms ? 'warn' : null)],
    ['sent to a human', 'every inspect, ♡ with care', (ln) => `${ln.human ?? 0}${ln.care ? ` · ♡ ${ln.care}` : ''}`, null],
    ['right route', null, (ln) => `${ln.right ?? 0} / ${ln.screened ?? 0}`, null],
    ['fouls', 'no verdict', (ln) => ln.fouls ?? 0, (ln) => (ln.fouls ? 'err' : null)],
  ]
  return html`
    <${Box} class="cu-compare">
      <${Label}>${n > 1 ? `SAME BELT, ${NUMBER[n]} SCANNERS` : 'ONE BELT, ONE SCANNER'}<//>
      ${run.lanes.map((ln) => {
        const t = throughput(ln)
        const share = run.total ? (ln.screened ?? 0) / run.total : 0
        return html`
          <div key=${ln.index} class=${`cu-flow g-l${(ln.index % 4) + 1}${isLaneLive(ln) ? ' cu-flow--live' : ''}`}>
            <div class="cu-flow__row">
              <span class="cu-flow__who"><${LaneNum} i=${ln.index} /> ${ln.label}</span>
              <span class="g-mono">${ln.screened ?? 0} screened · ${ln.queue ?? 0} waiting</span>
            </div>
            <span class="cu-flow__track" aria-hidden="true"><span class="cu-flow__fill" style=${{ width: `${share * 100}%` }} /></span>
            <span class="g-mono g-muted cu-flow__rate">${fmtRate(t.rate)} · ${fmtMs(t.perBag)} a bag</span>
          </div>
        `
      })}
      <table class="g-table cu-board">
        <caption class="sr-only">Every scanner against the labels</caption>
        <thead>
          <tr>
            <th scope="col">against the labels</th>
            ${run.lanes.map((ln) => html`<th key=${ln.index} scope="col" class="num"><${LaneNum} i=${ln.index} /><span class="sr-only">${ln.label}</span></th>`)}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            ([k, hint, val, tone]) => html`
              <tr key=${k}>
                <th scope="row">${k}${hint && html`<span class="cu-board__hint">${hint}</span>`}</th>
                ${run.lanes.map((ln) => html`<td key=${ln.index} class=${`num${tone && tone(ln) ? ` g-t-${tone(ln)}` : ''}`}>${val(ln)}</td>`)}
              </tr>
            `,
          )}
          <tr class="cu-board__score">
            <th scope="row">score</th>
            ${run.lanes.map((ln) => html`<td key=${ln.index} class=${`num g-l${(ln.index % 4) + 1}${lead(ln) ? ' cu-board__lead' : ''}`}>
              <${Counter} value=${ln.score ?? 0} /></td>`)}
          </tr>
        </tbody>
      </table>
      <p class="cu-note">
        A text scanner answers in words: one verdict, no odds, nothing to move a threshold on. Jev's numbers are
        routed by code, so review and act are dials: slide them in the setup and the chutes change.
      </p>
    <//>
  `
}

/** A lane's card: the score, how its bags went, its chutes, and how its belt backed up. */
function Tally({ lane, live }) {
  const backlog = lane.backlog ?? []
  const max = Math.max(4, ...backlog)
  const pts = backlog.slice(-60).map((n, i, arr) => [(i / Math.max(1, arr.length - 1)) * 100, 21 - (n / max) * 19])
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = pts.length > 1 ? `M0,22 L${line.replace(/ /g, ' L')} L100,22 Z` : ''
  const ch = lane.chutes ?? { pass: 0, inspect: 0, block: 0 }
  const routed = ch.pass + ch.inspect + ch.block
  const score = useRef(null)
  const was = useRef(lane.status)
  useEffect(() => {
    // A belt cleared in front of you: a little confetti in its lane's colour.
    if (live && was.current !== 'done' && lane.status === 'done') {
      burstFrom(score.current, { colors: [LANE_COLORS[lane.index % 4], '#ffffff', '#3ef5a0'], count: 36, power: 0.55 })
    }
    was.current = lane.status
  }, [lane.status])
  return html`
    <${Box} lane=${lane.index} class="cu-tally">
      <${LaneHead} lane=${lane} />
      <div class="cu-tally__row">
        <div class="cu-tally__score" ref=${score}><${Counter} value=${lane.score ?? 0} class="g-score" /><small>points</small></div>
        <div class="g-stats cu-tally__stats">
          <${Stat} label="right" value=${lane.right ?? 0} tone=${lane.right ? 'ok' : undefined} />
          <${Stat} label="to a human" value=${lane.human ?? 0} />
          <${Stat} label="wrong" value=${lane.wrong ?? 0} tone=${lane.wrong ? 'err' : undefined} />
          <${Stat} label="fouls" value=${lane.fouls} tone=${lane.fouls ? 'err' : undefined} />
        </div>
      </div>
      <div class="cu-mix" role="img" aria-label=${`chutes: ${ch.pass} passed, ${ch.inspect} to a human, ${ch.block} blocked`}>
        ${TONES.map((t, k) => {
          const c = CHUTES[k]
          const r = routeOf(c)
          return html`<span key=${c} class=${`cu-mix__seg cu-t-${t}`} style=${{ flexGrow: routed ? ch[c] : 1 }}
            title=${`${r.word}: ${ch[c]}`}><span aria-hidden="true">${r.mark} ${ch[c]}</span></span>`
        })}
      </div>
      <div class="cu-queue" title="bags waiting on this scanner's belt, over time">
        <span class="g-stat__k">backlog ${lane.queue ?? 0}${backlog.length ? ` · peak ${Math.max(...backlog)}` : ''}</span>
        <svg viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
          ${area && html`<path d=${area} class="cu-spark__area" />`}
          <polyline points=${line} class="cu-spark" />
        </svg>
      </div>
      <${LaneStats} lane=${lane} fouls=${false} />
    <//>
  `
}

/** Every bag on the belt: what it said, each scanner's route, and (at the end) its label. */
function Manifest({ run }) {
  const live = isRunLive(run)
  const all = run.bags ?? []
  const bags = live ? [...all].reverse().slice(0, 8) : all
  if (!bags.length) return null
  return html`
    <${Box} class="cu-manifest">
      <${Label} note=${run.labels ? 'the labels are out' : `newest first · the labels come out at the end`}>THE MANIFEST<//>
      <div class="cu-manifest__scroll">
        <table class="g-table">
          <thead>
            <tr>
              <th scope="col">bag</th>
              <th scope="col">label</th>
              ${run.lanes.map((ln) => html`<th key=${ln.index} scope="col" class="num"><${LaneNum} i=${ln.index} /><span class="sr-only">${ln.label}</span></th>`)}
            </tr>
          </thead>
          <tbody>
            ${bags.map((b) => {
              const lb = run.labels?.[b.i]
              const lr = lb ? routeOf(lb.route) : null
              return html`
                <tr key=${b.i} class="cu-man__row">
                  <td class="cu-man__msg">
                    <span class="cu-man__no g-mono">${pad2(b.i + 1)}</span>“${b.text}”
                    ${lb?.note && html`<span class="cu-man__note">${lb.note}</span>`}
                  </td>
                  <td class="cu-man__label">
                    ${lr ? html`<span class=${`cu-t-${lr.tone}`}>${lr.mark} ${lb.route}</span>
                        ${lb.hazards.length > 0 && html`<span class="cu-man__hz g-mono">${lb.hazards.map(hazardShort).join(', ')}</span>`}`
                      : html`<span class="g-muted">—</span>`}
                  </td>
                  ${marksFor(run, b.i).map((a, li) => {
                    if (!a) return html`<td key=${li} class="num g-muted">·</td>`
                    const r = routeOf(a.route)
                    const v = VERDICT[a.verdict]
                    return html`<td key=${li} class="num" title=${`${run.lanes[li].label}: ${r.say}${v ? ` · ${v.say}` : ''}`}>
                      <span class=${`cu-mark cu-t-${r.tone}`} aria-hidden="true">${r.mark}</span>
                      ${v && html`<span class=${`cu-mark__v cu-t-${v.tone}`} aria-hidden="true">${v.mark}</span>`}
                      <span class="sr-only">${`${r.say}${v ? `, ${v.say}` : ''}`}</span>
                    </td>`
                  })}
                </tr>
              `
            })}
          </tbody>
        </table>
      </div>
    <//>
  `
}
