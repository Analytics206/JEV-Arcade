/* Rail Yard — Jev works the switches; the text models answer.
 *
 * Model routing, drawn as a rail yard at night. The server (games/railyard.py)
 * owns the prompts, the stations' answers, the grading and the routing rule;
 * this page draws them: the queue of carriages on the main line, Jev's switch
 * tower reading the one at the front, the points throwing, each train running
 * down the track Jev chose and marked right or wrong where it pulls in, the
 * stations lit with their arrivals, the router against "always the big one"
 * as a live scoreboard, the request behind the train in view, quality against
 * cost, and the departure board. Geometry and scales: railyard.logic.js.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Bars,
  Box,
  Chip,
  Counter,
  GameFrame,
  Label,
  LaneHead,
  LaneNum,
  LaneStats,
  Levels,
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
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtPct, fmtProb, isRunLive, playersProblem } from './runstate.js'
import {
  RULE_WORDS,
  TIER_SHORT,
  bigStation,
  bladeAngle,
  costAgainst,
  defaultTiers,
  fmtUsd,
  routePath,
  ruleLine,
  scatterScales,
  snippet,
  trackPose,
  trainText,
  tripPath,
  yardLayout,
  yardOutcome,
  yardSummary,
} from './railyard.logic.js'

const TIER_CHOICES = ['small', 'medium', 'large', 'local']
/** How a station's answer went, as a mark: shape and colour, so it reads without colour too. */
const VERDICT = {
  right: { mark: '✓', tone: 'ok', label: 'right' },
  wrong: { mark: '✕', tone: 'err', label: 'wrong' },
  foul: { mark: '!', tone: 'err', label: 'no ANSWER line (foul)' },
  leak: { mark: '⊘', tone: 'warn', label: 'private data left the yard (leak)' },
  none: { mark: '–', tone: 'warn', label: 'the station gave no answer' },
}
const FLAG_NAMES = { needs_code: 'needs code', needs_maths: 'needs maths', private_data: 'private data', long_output: 'long output' }
/** A train's run from the front of the queue to its platform. */
const TRIP_MS = 1400
/** Trains drawn on the move at once; older ones have pulled in and gone. */
const MOVING_MAX = 4
/** The queue's carriages, centre to centre, back from the front one. */
const CAR_GAP = 128
const CAR_W = 108
const CAR_H = 34

const pctOf = (x) => (Number.isFinite(x) ? x * 100 : null)
const fmtWhole = (v) => `${Math.round(v)}%`

export default function RailYard({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function yardProblem(jevs, stations) {
  if (jevs !== 1) return 'The yard needs exactly one Jev: the switch tower.'
  if (stations < 2 || stations > 3) return 'Pick 2 or 3 text models: the stations.'
  return null
}

function Setup({ game }) {
  const models = useModels()
  const maxCount = game.params?.properties?.count?.maximum ?? 41
  const counts = [...new Set([10, 20, 30, maxCount])].filter((n) => n <= maxCount)
  const [lanes, setLanes] = useState([])
  const [count, setCount] = useState(20)
  const [threshold, setThreshold] = useState(0.5)
  const [chosen, setChosen] = useState({})
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 4 }))
  }, [models.data])
  const byKey = new Map((models.data?.models ?? []).map((m) => [m.key, m]))
  const kindOf = (key) => byKey.get(key)?.kind ?? (key.startsWith('typesafe:') ? 'judgment' : 'text')
  const seated = lanes.map((l, i) => ({ ...l, i })).filter((l) => l.key)
  const jevs = seated.filter((l) => kindOf(l.key) === 'judgment')
  const stations = seated.filter((l) => kindOf(l.key) === 'text')
  const defaults = defaultTiers(
    stations.map((s) => ({ provider: byKey.get(s.key)?.provider ?? s.key.split(':')[0], price: byKey.get(s.key)?.price ?? null })),
  )
  const slot = (s, j) => `${j}|${s.key}`
  const tiers = stations.map((s, j) => chosen[slot(s, j)] ?? defaults[j])
  const problem = models.error
    ? models.error.message
    : (playersProblem(lanes, game, models.data?.models) ?? yardProblem(jevs.length, stations.length))
  const go = () => start(lanes, { count, threshold, tiers })

  return html`
    <${GameFrame} game=${game} class="ry-page">
      <div class="g-setup">
        <${Box} class="ry-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} label="TOWER AND STATIONS" />
          ${stations.length > 0 &&
          html`<div class="ry-tiers">
            <${Label} note="default: by list price">STATIONS<//>
            ${stations.map(
              (s, j) => html`
                <label class=${`ry-tier g-l${(s.i % 4) + 1}`} key=${slot(s, j)}>
                  <${LaneNum} i=${s.i} />
                  <span class="ry-tier__model" title=${s.key}>${byKey.get(s.key)?.model_id ?? s.key}</span>
                  <select class="wr-sel" value=${tiers[j]} aria-label=${`Tier of station ${j + 1}`}
                    onChange=${(e) => setChosen({ ...chosen, [slot(s, j)]: e.currentTarget.value })}>
                    ${TIER_CHOICES.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
                  </select>
                </label>
              `,
            )}
            ${!tiers.includes('local') && html`<p class="ry-hint">No local station: a private prompt leaves the yard whoever takes it.</p>`}
          </div>`}
          <div class="ry-params">
            <label class="g-field"><span>Prompts</span>
              <select class="wr-sel" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>
                ${counts.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
              </select>
            </label>
            <label class="g-field ry-thr"><span>One tier up under</span>
              <input type="range" min="0.2" max="0.8" step="0.05" value=${threshold}
                onInput=${(e) => setThreshold(Number(e.currentTarget.value))} aria-label="Confidence under which a train goes one tier up" />
              <b class="tnum">${threshold.toFixed(2)}</b>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Open the yard" />
        <//>
        <div class="ry-side">
          <${Box} class="ry-how">
            <${Label}>HOW IT'S PLAYED<//>
            <${RailDiagram} tiers=${tiers.length >= 2 ? tiers : ['small', 'medium', 'large']} />
            <p class="g-explain">
              Teammates, not rivals. Each prompt is a train; each <b>text model</b> is a station with a tier,
              and <b>Jev</b> is the switch tower that sends every train to the station that should answer it. Every
              station answers every prompt anyway, so "always the big one" and "always the small one" are real
              runs to beat.
            </p>
            <p class="g-explain">
              Jev routes a train with <b>one request of six questions</b>: a Choice over the stations, a difficulty
              Score, and yes/no reads for code, maths, private data and long output. Code applies the rule. A station
              answers <code>ANSWER: …</code>, checked against the known answer; no ANSWER line is a foul, and a private
              prompt answered anywhere but a <b>local</b> station is a leak.
            </p>
            <${Rule} threshold=${threshold} />
            <div class="ry-chips">
              <${Chip} tone="ok">✓ right<//><${Chip} tone="err">✕ wrong<//><${Chip} tone="err">! foul<//>
              <${Chip} tone="warn">⊘ leak<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} prompts${
            r.summary?.router?.accuracy != null ? ` · routed ${fmtPct(r.summary.router.accuracy)}` : ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The yard in miniature, for the setup: trains leave the main line, the tower
 *  throws the points, and each pulls in at the station it was sent to, in turn. */
function RailDiagram({ tiers }) {
  const m = tiers.length
  const calm = reducedMotion()
  const mainY = 92
  const sx = 232
  const ys = m === 2 ? [58, 126] : [36, 92, 148]
  const track = (y) => `M${sx} ${mainY} C${sx + 56} ${mainY} ${sx + 66} ${y} ${sx + 116} ${y} H436`
  const trip = (y) => `M150 ${mainY} H${sx} C${sx + 56} ${mainY} ${sx + 66} ${y} ${sx + 116} ${y} H392`
  const cycle = 2.2 * m
  const angle = (y) => ((Math.atan2((y - mainY) * 0.216, 39) * 180) / Math.PI).toFixed(1)
  const label = `A diagram: prompt trains wait on the main line; Jev's switch tower throws the points and sends each one to the ${tiers.join(', ')} station.`
  return html`
    <svg class="ry-dia" viewBox="0 0 560 176" role="img" aria-label=${label}>
      <defs><${LocoDefs} /></defs>
      <rect x="0.5" y="0.5" width="559" height="175" rx="12" class="ry-dia__bg" />
      <${Tracks} paths=${[`M0 ${mainY} H${sx}`, ...ys.map(track)]} />
      ${[34, 92].map((x) => html`
        <g key=${x} transform=${`translate(${x} ${mainY})`} class="ry-q ry-q--dia">
          <rect x="-26" y="-11" width="52" height="22" rx="4" class="ry-q__body" />
          <rect x="-20" y="-5" width="40" height="4" rx="1" class="ry-q__win" />
        </g>`)}
      <g class="ry-dia__tower">
        <line x1=${sx} y1="44" x2=${sx} y2=${mainY - 8} class="ry-tower__mast" />
        <rect x=${sx - 30} y="12" width="60" height="32" rx="6" class="ry-tower__cab" />
        <text x=${sx} y="33" class="ry-tower__name">JEV</text>
        <text x=${sx - 40} y="24" class="ry-dia__note ry-dia__note--end">one request,</text>
        <text x=${sx - 40} y="37" class="ry-dia__note ry-dia__note--end">six questions</text>
      </g>
      <g class="ry-blade" transform=${`translate(${sx} ${mainY}) rotate(${angle(ys[0])})`}>
        ${!calm && html`<animateTransform attributeName="transform" type="rotate" additive="sum" calcMode="discrete"
          values=${ys.map((y) => angle(y) - angle(ys[0])).join(';')} keyTimes=${ys.map((_, j) => (j / m).toFixed(3)).join(';')}
          dur=${`${cycle}s`} repeatCount="indefinite" />`}
        <line x1="0" y1="0" x2="30" y2="0" /><circle cx="30" cy="0" r="3" />
      </g>
      <circle cx=${sx} cy=${mainY} r="5" class="ry-switch" />
      ${ys.map(
        (y, j) => html`
          <g key=${`s${y}`} class="ry-dia__st">
            <rect x="444" y=${y - 16} width="108" height="32" rx="7" class="ry-dia__plat" />
            <text x="458" y=${y + 4} class="ry-dia__tier">${tiers[j].toUpperCase()}</text>
            <circle cx="534" cy=${y} r="7" fill=${calm && j === 0 ? '#3ef5a0' : '#2c2660'} class="ry-dia__lamp">
              ${!calm && html`<animate attributeName="fill" values="#2c2660;#3ef5a0;#2c2660"
                keyTimes="0;0.34;0.62" calcMode="discrete" dur=${`${cycle}s`} begin=${`${(j * cycle) / m}s`} repeatCount="indefinite" />`}
            </circle>
            <text x="534" y=${y + 3.5} class="ry-dia__mark">✓</text>
          </g>`,
      )}
      ${calm
        ? html`<g transform=${`translate(392 ${ys[0]}) scale(0.62)`}><${Loco} k=${0} plate=${false} /></g>`
        : ys.map(
            (y, j) => html`
              <g key=${`t${y}`} opacity="0">
                <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.4;0.42;1" dur=${`${cycle}s`} begin=${`${(j * cycle) / m}s`} repeatCount="indefinite" />
                <animateMotion path=${trip(y)} rotate="auto" dur=${`${cycle}s`} calcMode="spline" keyPoints="0;1;1" keyTimes="0;0.34;1"
                  keySplines="0.6 0 0.3 1;0 0 1 1" begin=${`${(j * cycle) / m}s`} repeatCount="indefinite" />
                <g transform="scale(0.62)"><${Loco} k=${0} plate=${false} /></g>
              </g>`,
          )}
    </svg>
  `
}

const ruleText = (thr) => [
  'if private_data > 0.5: go local',
  `elif confidence < ${Number(thr).toFixed(2)}: go one tier up`,
  'else: take the top pick',
]

/** The routing rule as code prints it; `on` marks the line a train took. */
function Rule({ threshold, on = -1 }) {
  return html`
    <div class=${`ry-rule${on >= 0 ? ' ry-rule--live' : ''}`} role="group" aria-label=${on >= 0 ? 'The routing rule, the line this train took marked' : 'The routing rule'}>
      ${ruleText(threshold).map(
        (t, j) => html`<span key=${`${j}${j === on ? 'on' : ''}`} class=${j === on ? 'ry-rule__on' : ''}>${j === on ? '▸ ' : '  '}${t}</span>`,
      )}
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [sel, setSel] = useState(null)
  if (!run) return html`<${GameFrame} game=${game} class="ry-page"><${RunLoading} error=${error} /><//>`
  const trains = run.trains ?? []
  const focus = (sel != null && trains[sel]) || trains[trains.length - 1] || null
  const summary = yardSummary(run)
  // No winner here: the tower and the stations are teammates. The finale reads
  // out the router against always the top-tier station instead.
  const outcome = yardOutcome(run, summary)
  return html`
    <${GameFrame} game=${game} class="ry-page">
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} headline=${outcome?.headline} sub=${outcome?.sub}>
        <span class="g-mono g-muted">${summary.router.n}/${run.total} trains delivered · ${run.stations.length} stations</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${Box} class="ry-yardbox">
        <${Scoreboard} run=${run} summary=${summary} />
        <${Yard} run=${run} summary=${summary} />
      <//>
      <div class="ry-row">
        <${ThisTrain} run=${run} train=${focus} pinned=${sel != null && !!trains[sel]} onFollow=${() => setSel(null)} />
        <${Scatter} run=${run} summary=${summary} />
        <${Departures} run=${run} focus=${focus?.k} onPick=${setSel} />
      </div>
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${LaneBox} key=${ln.index} run=${run} lane=${ln} summary=${summary} />`)}
      </div>
    <//>
  `
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** A value as it was when this component first drew: a delay a CSS animation
 *  was started with must not move under it. */
function useFirst(v) {
  const r = useRef(v)
  return r.current
}

const tierOf = (run, s) => run.stations[s]?.tier ?? '?'
const verdictOf = (v) => VERDICT[v] ?? { mark: '…', tone: 'neutral', label: 'on its way' }

/** The router against always the top-tier station, as lit numbers: the headline of the round. */
function Scoreboard({ run, summary }) {
  const jl = run.lanes[run.router]
  const always = summary.always.filter((a) => a.accuracy != null)
  const big = bigStation(always)
  const router = summary.router
  const vs = router.n && big ? costAgainst(router.cost, big.cost) : null
  const bigLane = big ? run.lanes[big.lane] : null
  const done = run.total ? router.n / run.total : 0
  return html`
    <div class="ry-sb">
      <div class=${`ry-sb__cell ry-sb__cell--jev g-l${((jl?.index ?? 0) % 4) + 1}`}>
        <span class="ry-sb__k">${jl && html`<${LaneNum} i=${jl.index} />`}ROUTED RIGHT</span>
        <${Counter} value=${pctOf(router.accuracy)} format=${fmtWhole} class="g-score ry-sb__v" sound=${true} />
        <span class="ry-sb__s">Jev's routing · ${router.right ?? 0} of ${router.n} right</span>
      </div>
      <div class=${`ry-sb__cell${bigLane ? ` g-l${(bigLane.index % 4) + 1}` : ''}`}>
        <span class="ry-sb__k">${bigLane && html`<${LaneNum} i=${bigLane.index} />`}ALWAYS ${(big?.tier ?? 'large').toUpperCase()}</span>
        <${Counter} value=${pctOf(big?.accuracy)} format=${fmtWhole} class="g-score ry-sb__v ry-sb__v--base" />
        <span class="ry-sb__s">${big ? `the same ${big.n} prompts, all to one station` : 'waiting for the first delivery'}</span>
      </div>
      <div class=${`ry-sb__cell ry-sb__cell--save${vs?.word === 'dearer' ? ' is-dearer' : ''}`}>
        <span class="ry-sb__k">COST AGAINST ALWAYS ${(big?.tier ?? 'large').toUpperCase()}</span>
        <span class="ry-sb__row">
          <${Counter} value=${vs ? vs.share * 100 : null} format=${fmtWhole} class="g-score ry-sb__v ry-sb__v--save" />
          <span class="ry-sb__word">${vs ? (vs.share ? vs.word : 'same cost') : ''}</span>
        </span>
        <span class="ry-sb__s">${vs ? html`<b>${fmtUsd(router.cost)}</b> against <b>${fmtUsd(big.cost)}</b>` : 'saved against sending every train to the big one'}</span>
      </div>
      <div class="ry-sb__cell ry-sb__cell--run">
        <span class="ry-sb__k">DELIVERED</span>
        <span class="ry-sb__row"><${Counter} value=${router.n} class="g-score ry-sb__v ry-sb__v--n" /><span class="ry-sb__of">/ ${run.total}</span></span>
        <span class="ry-sb__track" role="img" aria-label=${`${router.n} of ${run.total} trains delivered`}>
          <span class="ry-sb__fill" style=${{ width: `${Math.min(100, done * 100)}%` }} />
        </span>
      </div>
    </div>
  `
}

/**
 * When each train watched leaving pulls in: trains that were already out when
 * the page opened (or every train, with motion reduced) are drawn where they
 * ended, not run again.
 */
function useArrivals(trains, animate) {
  const from = useRef(null)
  const left = useRef(new Map())
  if (from.current == null) from.current = animate ? trains.length : Infinity
  const t = nowMs()
  for (const tr of trains) if (tr.k >= from.current && !left.current.has(tr.k)) left.current.set(tr.k, t)
  return {
    moving: (k) => k >= from.current,
    arriveAt: (k) => (left.current.has(k) ? left.current.get(k) + TRIP_MS : 0),
  }
}

/** The yard: the queue, the tower, a track per station, the trains on their way. */
function Yard({ run, summary }) {
  const n = run.stations.length
  const L = useMemo(() => yardLayout(n), [n])
  const trains = run.trains ?? []
  const live = isRunLive(run)
  const calm = reducedMotion()
  const arrivals = useArrivals(trains, live && !calm)
  const cur = trains[trains.length - 1] ?? null
  const next = trains.length
  const frontX = L.front.x + L.front.w / 2
  const queue = live ? run.prompts.slice(next, next + 4) : []
  const more = live ? Math.max(0, run.total - next - queue.length) : 0
  const holding = live && cur && !cur.verdict
  const reading = live && queue.length > 0 && !holding
  const moving = trains.slice(-MOVING_MAX).filter((t) => arrivals.moving(t.k))
  const parked = !moving.length && cur ? cur : null
  const jevLane = run.lanes[run.router]
  const tower = L.tower
  const towerSub = reading ? `reading no. ${queue[0].k + 1}` : holding ? `holding: no. ${cur.k + 1} out` : cur ? fmtMs(cur.jev_ms) : 'switch tower'
  const label = `Rail yard: ${trains.length} of ${run.total} trains routed by Jev's switch tower to ${n} stations (${run.stations
    .map((s) => s.tier)
    .join(', ')}).${cur ? ` Train ${cur.k + 1} went to the ${tierOf(run, cur.to)} station.` : ''}`
  return html`
    <div class="ry-yard">
      <svg viewBox=${`0 0 ${L.width} ${L.height}`} role="img" aria-label=${label} class=${`g-l${((jevLane?.index ?? 0) % 4) + 1}`}>
        <defs>
          <linearGradient id="ryBg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#0d0a2a" /><stop offset="1" stop-color="#05040f" />
          </linearGradient>
          <radialGradient id="ryHalo" cx="0.44" cy="0.55" r="0.55">
            <stop offset="0" class="ry-stop-acc" stop-opacity="0.16" /><stop offset="1" class="ry-stop-acc" stop-opacity="0" />
          </radialGradient>
          <pattern id="ryGravel" width="11" height="9" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="0.8" fill="#ffffff" fill-opacity="0.05" /><circle cx="8" cy="6.5" r="0.6" fill="#ffffff" fill-opacity="0.035" />
          </pattern>
          <${LocoDefs} />
          <linearGradient id="ryPlat" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#211a52" /><stop offset="1" stop-color="#0b0921" />
          </linearGradient>
          <linearGradient id="ryScan" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="ry-stop-lane" stop-opacity="0.5" /><stop offset="1" class="ry-stop-lane" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <rect x="0.5" y="0.5" width=${L.width - 1} height=${L.height - 1} rx="10" fill="url(#ryBg)" class="ry-yard__bg" />
        <rect x="0" y="0" width=${L.width} height=${L.height} fill="url(#ryHalo)" />
        <rect x="0" y=${L.mainY - 150} width=${L.width} height="300" fill="url(#ryGravel)" />
        <text x="24" y="30" class="ry-yard__cap">stations are the text models in this round · ${run.total} prompts with known answers</text>

        <${Tracks} paths=${[L.main, ...L.tracks.map((t) => t.d)]} />
        ${cur && html`
          <g key=${`route${cur.to}`} class="ry-route">
            <path d=${routePath(L, cur.to)} class="ry-route__glow" />
            <path d=${routePath(L, cur.to)} class="ry-route__rail" />
            <path d=${routePath(L, cur.to)} class="ry-route__gap" />
            <path d=${routePath(L, cur.to)} class="ry-route__ties" />
            ${live && html`<path d=${routePath(L, cur.to)} class="ry-route__run" />`}
          </g>`}

        ${queue.map((p, j) => html`<${QueueCar} key=${`q${p.k}`} p=${p} x=${frontX - j * CAR_GAP} y=${L.mainY} front=${j === 0} reading=${j === 0 && reading} />`)}
        ${more > 0 && html`<text x="24" y=${L.mainY - 40} class="ry-yard__more">+${more} more waiting</text>`}
        ${!live && !trains.length && html`<text x="24" y=${L.mainY + 46} class="ry-yard__more">no trains ran</text>`}
        ${trains.length > 0 && html`<${YardLog} run=${run} trains=${trains} x=${24} y=${L.mainY + 40} />`}

        <g class="ry-tower">
          ${reading && html`<polygon class="ry-tower__beam" points=${`${tower.x + 20},${tower.y + tower.h} ${tower.x + tower.w - 20},${tower.y + tower.h} ${frontX + CAR_W / 2},${L.mainY - CAR_H / 2} ${frontX - CAR_W / 2},${L.mainY - CAR_H / 2}`} />`}
          <path class="ry-tower__mast" d=${`M${L.switchX - 7} ${tower.y + tower.h} L${L.switchX - 3} ${L.mainY - 12} M${L.switchX + 7} ${tower.y + tower.h} L${L.switchX + 3} ${L.mainY - 12} M${L.switchX - 6} ${tower.y + tower.h + 10} L${L.switchX + 5} ${tower.y + tower.h + 22} M${L.switchX + 6} ${tower.y + tower.h + 10} L${L.switchX - 5} ${tower.y + tower.h + 22}`} />
          <line x1=${L.switchX} y1=${tower.y - 12} x2=${L.switchX} y2=${tower.y} class="ry-tower__mast" />
          <circle cx=${L.switchX} cy=${tower.y - 13} r="2.5" class=${`ry-tower__beacon${live ? ' is-live' : ''}`} />
          <rect x=${tower.x} y=${tower.y} width=${tower.w} height=${tower.h} rx="8" class="ry-tower__cab" />
          <rect x=${tower.x + 7} y=${tower.y + 7} width=${tower.w - 14} height="24" rx="4" class=${`ry-tower__glass${reading ? ' is-reading' : ''}`} />
          <text x=${L.switchX} y=${tower.y + 25} class="ry-tower__name">JEV</text>
          <text x=${L.switchX} y=${tower.y + 48} class="ry-tower__sub">${towerSub}</text>
        </g>
        ${jevLane && html`<text x=${tower.x + tower.w + 12} y=${tower.y + 14} class="ry-yard__who">lane ${jevLane.index + 1} · ${jevLane.label}</text>`}

        <g class="ry-blade" style=${{ transform: `translate(${L.switchX}px, ${L.mainY}px) rotate(${cur ? bladeAngle(L, cur.to) : 0}deg)` }}>
          <line x1="0" y1="0" x2="46" y2="0" /><circle cx="46" cy="0" r="3.5" />
        </g>
        ${cur && live && html`<circle key=${`throw${cur.k}`} cx=${L.switchX} cy=${L.mainY} r="16" class="ry-switch__ring" />`}
        <circle cx=${L.switchX} cy=${L.mainY} r="7" class="ry-switch" />

        ${L.stations.map((b, s) => {
          const tr = summary.traffic[s]
          return html`<${Station} key=${s} run=${run} s=${s} L=${L} on=${cur?.to === s} traffic=${tr} live=${live}
            arriveAt=${tr?.last ? arrivals.arriveAt(tr.last.k) : 0} />`
        })}

        ${parked && html`<${ParkedTrain} L=${L} train=${parked} />`}
        ${moving.map((t) => html`<${MovingTrain} key=${`m${t.k}`} L=${L} train=${t} latest=${t === cur} arriveAt=${arrivals.arriveAt(t.k)} />`)}
      </svg>
    </div>
  `
}

/** The yard's rolling stock paints: the locomotive's lit body, its headlight, a carriage's.
 *  The setup's diagram and the round's yard are never on one page, so the ids do not clash. */
function LocoDefs() {
  return html`
    <linearGradient id="ryLoco" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" class="ry-stop-hi" /><stop offset="0.45" class="ry-stop-acc" /><stop offset="1" class="ry-stop-lo" />
    </linearGradient>
    <linearGradient id="ryBeam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff3c4" stop-opacity="0.5" /><stop offset="1" stop-color="#fff3c4" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="ryCar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2e2766" /><stop offset="1" stop-color="#141033" />
    </linearGradient>
  `
}

/** Track with depth: a ballast bed, sleepers, and two steel rails with the sleepers showing between them. */
function Tracks({ paths }) {
  const layer = (cls) => html`<g class=${cls}>${paths.map((d, j) => html`<path key=${j} d=${d} />`)}</g>`
  return html`${layer('ry-ballast')}${layer('ry-ties')}${layer('ry-rails')}${layer('ry-gap')}${layer('ry-ties ry-ties--in')}`
}

/** The round so far, train by train: a tile per departure in its station's
 *  colour and number, marked as its answer went. */
function YardLog({ run, trains, x, y }) {
  const per = 21
  const step = 22
  return html`
    <g class="ry-log" aria-hidden="true">
      <text x=${x} y=${y} class="ry-log__cap">departed, in order · the station it went to, and how it went</text>
      ${trains.map((t) => {
        const st = run.stations[t.to]
        const v = t.verdict ? verdictOf(t.verdict) : null
        const tx = x + (t.k % per) * step
        const ty = y + 8 + Math.floor(t.k / per) * 34
        return html`
          <g key=${t.k} class=${`ry-log__t g-l${((st?.lane ?? 0) % 4) + 1}`} transform=${`translate(${tx} ${ty})`}>
            <g class="ry-log__in">
              <rect width="18" height="16" rx="4" class="ry-log__box" />
              <text x="9" y="12" class="ry-log__no">${st ? st.lane + 1 : '·'}</text>
            </g>
            <text key=${t.verdict ?? 'wait'} x="9" y="28" class=${`ry-log__mark ${v ? `ry-f-${v.tone}` : 'ry-log__mark--wait'}`}>${v ? v.mark : '·'}</text>
          </g>`
      })}
    </g>
  `
}

/** A locomotive, facing right, centred on the origin: its number on the side, its headlight on the track ahead. */
function Loco({ k, plate = true }) {
  return html`
    <g class="ry-loco">
      <ellipse cx="0" cy="17" rx="50" ry="4" class="ry-loco__shadow" />
      <path d="M50 -3 L132 -22 L132 22 L50 3 Z" class="ry-loco__beam" />
      <rect x="-50" y="-13" width="86" height="26" rx="5" class="ry-loco__body" />
      <path d="M34 -13 H40 Q52 -13 52 0 Q52 13 40 13 H34 Z" class="ry-loco__nose" />
      <rect x="-44" y="-8" width="56" height="7" rx="2" class="ry-loco__win" />
      <rect x="-50" y="7" width="100" height="2.5" class="ry-loco__stripe" />
      ${[-34, -14, 18].map((x) => html`<circle key=${x} cx=${x} cy="13.5" r="3.4" class="ry-loco__wheel" />`)}
      <circle cx="49" cy="0" r="2.8" class="ry-loco__lamp" />
      ${plate && html`<text x="24" y="3.8" class="ry-loco__no">${k + 1}</text>`}
    </g>
  `
}

/** A carriage waiting on the main line: its number and the start of its prompt. */
function QueueCar({ p, x, y, front, reading }) {
  const lines = snippet(trainText(p.text), 16)
  return html`
    <g class=${`ry-q${front ? ' ry-q--front' : ''}`} style=${{ transform: `translate(${x}px, ${y}px)` }}>
      <g class="ry-q__in">
        <ellipse cx="0" cy=${CAR_H / 2 + 3} rx=${CAR_W / 2} ry="4" class="ry-loco__shadow" />
        <rect x=${-CAR_W / 2} y=${-CAR_H / 2} width=${CAR_W} height=${CAR_H} rx="6" class="ry-q__body" />
        <rect x=${-CAR_W / 2 + 3} y=${-CAR_H / 2 + 2} width=${CAR_W - 6} height="2" rx="1" class="ry-q__shine" />
        ${lines.map((ln, j) => html`<text key=${j} x=${-CAR_W / 2 + 8} y=${-3 + j * 12} class="ry-q__txt">${ln}</text>`)}
        ${[-36, 36].map((cx) => html`<circle key=${cx} cx=${cx} cy=${CAR_H / 2} r="3.4" class="ry-loco__wheel" />`)}
        <rect x=${-CAR_W / 2} y=${-CAR_H / 2 - 13} width="30" height="11" rx="3" class="ry-q__plate" />
        <text x=${-CAR_W / 2 + 15} y=${-CAR_H / 2 - 4.5} class="ry-q__no">${p.k + 1}</text>
        ${reading && html`<rect x=${-CAR_W / 2} y=${-CAR_H / 2} width="8" height=${CAR_H} class="ry-q__scan" />`}
      </g>
    </g>
  `
}

/** A mark over a train as it pulls in: how its station's answer went. */
function Badge({ x, y, v, delay = 0 }) {
  const d = useFirst(delay)
  return html`
    <g transform=${`translate(${x} ${y})`} class=${`ry-badge ry-badge--${v.tone}`}>
      <g class="ry-badge__in" style=${{ animationDelay: `${Math.round(d)}ms` }}>
        <circle r="17" class="ry-badge__ring" />
        <circle r="11" class="ry-badge__disc" />
        <text y="4.2" class="ry-badge__mark">${v.mark}</text>
      </g>
    </g>
  `
}

/** A train that left while you watched: it runs the whole trip once, then waits
 *  at its platform, and pulls away out of sight once a newer one is out. */
function MovingTrain({ L, train, latest, arriveAt }) {
  const ref = useRef(null)
  const trip = useMemo(() => tripPath(L, train.to), [L, train.to])
  const end = useMemo(() => trackPose(L, train.to, 1), [L, train.to])
  useEffect(() => {
    try {
      ref.current?.beginElement?.()
    } catch {
      /* no SMIL: the train is drawn where it starts */
    }
  }, [])
  const v = train.verdict ? verdictOf(train.verdict) : null
  const gone = !latest && !!v
  const goneAt = useRef(null)
  if (gone && goneAt.current == null) goneAt.current = Math.max(0, arriveAt - nowMs()) + 700
  return html`
    <g class=${`ry-mv${gone ? ' ry-mv--gone' : ''}`} transform=${`translate(${trip.x} ${trip.y})`}
      style=${gone ? { animationDelay: `${Math.round(goneAt.current)}ms` } : undefined}>
      <g>
        <animateMotion ref=${ref} dur=${`${TRIP_MS}ms`} begin="indefinite" fill="freeze" path=${trip.d} rotate="auto"
          calcMode="spline" keyTimes="0;1" keyPoints="0;1" keySplines="0.42 0 0.25 1" />
        <${Loco} k=${train.k} />
      </g>
      ${v && html`<${Badge} key=${train.verdict} x=${end.x - trip.x} y=${end.y - trip.y - 30} v=${v} delay=${Math.max(0, arriveAt - nowMs())} />`}
    </g>
  `
}

/** The latest train, drawn where it stopped (a replay, or motion reduced). */
function ParkedTrain({ L, train }) {
  const end = trackPose(L, train.to, 1)
  const v = train.verdict ? verdictOf(train.verdict) : null
  return html`
    <g class="ry-mv" transform=${`translate(${end.x} ${end.y})`}>
      <${Loco} k=${train.k} />
      ${v && html`<${Badge} key=${`${train.k}${train.verdict}`} x=${0} y=${-30} v=${v} />`}
    </g>
  `
}

/** A station's arrival: the platform flashes the verdict's colour, the count jumps. */
function Arrival({ x, y, w, h, tone, count, cx, cy, delay }) {
  const d = Math.round(useFirst(delay))
  const style = { animationDelay: `${d}ms` }
  return html`
    <rect x=${x} y=${y} width=${w} height=${h} rx="9" class=${`ry-st__flash ry-fl--${tone}`} style=${style} />
    <text x=${cx} y=${cy} class="ry-st__count ry-st__count--pop" style=${style}>${count}</text>
  `
}

/** A station's platform: its lane, tier and model, the trains that pulled in and how they went. */
function Station({ run, s, L, on, traffic, live, arriveAt }) {
  const st = run.stations[s]
  const lane = run.lanes[st.lane]
  const t = L.tracks[s]
  const box = L.stations[s]
  const spacing = L.tracks.length > 1 ? Math.abs(L.tracks[1].y - L.tracks[0].y) : 90
  const h = Math.min(64, spacing - 18)
  const x = box.x
  const y = t.y - h / 2
  const w = box.w
  const last = traffic?.last
  const v = last ? verdictOf(last.verdict) : null
  const inbound = !!traffic && traffic.received > traffic.delivered
  const got = traffic?.delivered ?? 0
  const right = traffic?.right ?? 0
  const model = st.model_id.length > 26 ? `${st.model_id.slice(0, 25)}…` : st.model_id
  const countX = x + w - 14
  const countY = y + h / 2 - 4
  return html`
    <g class=${`ry-st g-l${(st.lane % 4) + 1}${on ? ' ry-st--on' : ''}${inbound ? ' ry-st--inbound' : ''}${lane?.status === 'error' ? ' ry-st--out' : ''}`}>
      <rect x=${x - 3} y=${y - 3} width=${w + 6} height=${h + 6} rx="12" class="ry-st__halo" />
      <rect x=${x} y=${y} width=${w} height=${h} rx="9" class="ry-st__box" />
      <rect x=${x + 3} y=${y + 1.5} width=${w - 6} height="1.5" rx="1" class="ry-st__shine" />
      <rect x=${x} y=${y + 8} width="4" height=${h - 16} rx="2" class="ry-st__stripe" />
      <rect x=${x - 13} y=${t.y - 9} width="7" height="18" rx="2" class="ry-st__buf" />
      <circle cx=${x - 9.5} cy=${t.y - 15} r="3" class="ry-st__lamp" />
      <rect x=${x + 13} y=${y + 10} width="18" height="18" rx="4" class="ry-st__num" />
      <text x=${x + 22} y=${y + 23} class="ry-st__numtxt">${st.lane + 1}</text>
      <text x=${x + 40} y=${y + 24} class="ry-st__tier">${st.tier.toUpperCase()}</text>
      <text x=${x + 40} y=${y + 40} class="ry-st__model">${model}</text>
      <text x=${x + 40} y=${y + h - 9} class="ry-st__short">${TIER_SHORT[st.tier]}</text>
      ${last && live
        ? html`<${Arrival} key=${`a${last.k}`} x=${x} y=${y} w=${w} h=${h} tone=${v.tone} count=${got} cx=${countX} cy=${countY}
            delay=${Math.max(0, arriveAt - nowMs())} />`
        : html`<text x=${countX} y=${countY} class="ry-st__count">${got}</text>`}
      <text x=${countX} y=${countY + 12} class="ry-st__unit">${got === 1 ? 'train in' : 'trains in'}</text>
      <text x=${countX} y=${y + h - 9} class="ry-st__tally">
        <tspan class="ry-f-ok">✓${right}</tspan><tspan dx="6" class="ry-f-err">✕${got - right}</tspan><tspan dx="6">${fmtUsd(traffic?.cost ?? 0)}</tspan>
      </text>
      ${v && html`
        <g key=${`v${last.k}`} transform=${`translate(${x + w - 70} ${y + 19})`} class=${`ry-st__v ry-badge--${v.tone}`}>
          <title>last train in: ${v.label}</title>
          <circle r="8.5" class="ry-badge__disc" /><text y="3.6" class="ry-badge__mark ry-badge__mark--sm">${v.mark}</text>
        </g>`}
    </g>
  `
}

/** The request behind a train: the stations' probabilities, the difficulty, the yes/no reads, the rule. */
function ThisTrain({ run, train, pinned, onFollow }) {
  const jl = run.lanes[run.router]
  const lane = jl?.index ?? 0
  if (!train) {
    return html`<${Box} lane=${lane} class="ry-train">
      <${Label}>THIS TRAIN · ONE REQUEST<//>
      <p class="g-muted">The first train is at the switch…</p>
    <//>`
  }
  const st = run.stations
  const items = train.bars.map((b) => ({
    label: `${st[b.station].tier} · ${st[b.station].model_id}`,
    p: b.p,
    strong: b.station === train.pick,
    tone: b.station === train.to && train.to !== train.pick ? 'warn' : undefined,
    title: b.station === train.to ? 'where the train went' : undefined,
  }))
  const d = train.difficulty
  const v = train.verdict ? verdictOf(train.verdict) : null
  const gold = run.gold?.[train.k]
  const line = ruleLine(train.rule)
  const dest = st[train.to]
  return html`
    <${Box} lane=${lane} class="ry-train">
      <${Label} note=${`${train.questions} questions · ${fmtMs(train.jev_ms)}`}>THIS TRAIN · ONE REQUEST<//>
      <div class="ry-train__body" key=${train.k}>
        <p class="ry-train__prompt"><span class="ry-plate">${train.k + 1}</span> ${run.prompts[train.k]?.text}</p>
        <${Bars} lane=${lane} compact items=${items} max=${4} />
        <div class="ry-train__diff">
          <span class="g-stat__k">difficulty</span>
          <${Levels} probabilities=${d.probabilities} lane=${lane} height=${22}
            labels=${['trivial', 'easy', 'moderate', 'hard']} />
          <span class="tnum">${d.score.toFixed(1)} / 3</span>
          ${gold && html`<span class="g-muted tnum" title="the difficulty we believe">ours ${gold.difficulty}</span>`}
        </div>
        <div class="ry-flags">
          ${Object.entries(FLAG_NAMES).map(([k, name]) => {
            const p = train.flags?.[k]
            return html`<span key=${k} class=${`ry-flag${p > 0.5 ? ' ry-flag--on' : ''}`}><span class="ry-flag__dot" aria-hidden="true" />${name} <b class="tnum">${fmtProb(p)}</b></span>`
          })}
        </div>
        <${Rule} threshold=${run.threshold} on=${line} />
        <p class="ry-train__to">
          <span class="ry-train__arrow" aria-hidden="true">→</span> ${dest && html`<span class=${`ry-dest g-l${(dest.lane % 4) + 1}`}><${LaneNum} i=${dest.lane} /><b>${tierOf(run, train.to).toUpperCase()}</b></span>`} <span class="g-muted">${dest?.model_id}</span>
          <span class="g-muted ry-train__why"> · ${RULE_WORDS[train.rule] ?? train.rule} · confidence ${fmtProb(train.confidence)}</span>
        </p>
        ${v
          ? html`<p key=${train.verdict} class=${`ry-stamp ry-stamp--${v.tone}`}><span class="ry-stamp__mark" aria-hidden="true">${v.mark}</span><span class="ry-stamp__label">${v.label}</span>${' '}${train.said != null &&
              html`<span class="g-mono ry-train__said">ANSWER: ${train.said || '—'}</span>`}</p>`
          : html`<p class="ry-onway">On its way to the ${tierOf(run, train.to)} station<span class="ry-dots" aria-hidden="true"><i /><i /><i /></span></p>`}
        ${gold && html`<p class="g-mono g-muted ry-train__gold">known answer: ${gold.answers.join(' · ')}</p>`}
      </div>
      ${pinned && html`<button type="button" class="ry-follow" onClick=${onFollow}>▸ Follow the latest train</button>`}
    <//>
  `
}

/** Quality against cost: "always <station>" for each station, and Jev's routing. */
function Scatter({ run, summary }) {
  const jl = run.lanes[run.router]
  const always = summary.always.filter((a) => a.accuracy != null)
  const router = summary.router.accuracy != null ? summary.router : null
  const pts = [...always, ...(router ? [router] : [])]
  const S = scatterScales(pts, { left: 44, right: 336, top: 18, bottom: 196 })
  const tierPriced = run.summary?.tier_priced ?? run.lanes.some((ln) => (ln.answers ?? []).some((a) => a.basis === 'tier'))
  const big = bigStation(always)
  const vs = router && big ? costAgainst(router.cost, big.cost) : null
  const place = (x) => (x > 250 ? { dx: -12, anchor: 'end' } : { dx: 12, anchor: 'start' })
  const label = router
    ? `Share right against cost. Jev's routing: ${fmtPct(router.accuracy)} for ${fmtUsd(router.cost)}. ${always
        .map((a) => `Always ${a.tier}: ${fmtPct(a.accuracy)} for ${fmtUsd(a.cost)}`)
        .join('. ')}.`
    : 'Share right against cost: nothing delivered yet.'
  const at = (x, y) => ({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` })
  return html`
    <${Box} class="ry-scatter">
      <${Label} note=${`same ${summary.router.n} prompts`}>QUALITY AGAINST COST<//>
      <svg viewBox="0 0 348 236" role="img" aria-label=${label}>
        <defs>
          <radialGradient id="ryBetter" cx="0" cy="0" r="1">
            <stop offset="0" stop-color="#3ef5a0" stop-opacity="0.16" /><stop offset="1" stop-color="#3ef5a0" stop-opacity="0" />
          </radialGradient>
        </defs>
        <rect x="44" y="18" width="292" height="178" rx="4" class="ry-plot" />
        <rect x="44" y="18" width="220" height="150" fill="url(#ryBetter)" />
        <text x="50" y="31" class="ry-plot__better">↖ better: more right, for less</text>
        <g class="ry-grid">${S.yTicks.map((t) => html`<line key=${t.v} x1="44" y1=${t.at} x2="336" y2=${t.at} />`)}</g>
        <g class="ry-axis">
          ${S.yTicks.map((t) => html`<text key=${t.v} x="38" y=${t.at + 4} text-anchor="end">${t.label}</text>`)}
          ${S.xTicks.map((t, j) => html`<text key=${j} x=${t.at} y="214" text-anchor=${j === 0 ? 'start' : j === 2 ? 'end' : 'middle'}>${t.label}</text>`)}
          <text x="190" y="231" text-anchor="middle">cost of the round${tierPriced ? ' (≈ tier prices)' : ''}</text>
        </g>
        ${!pts.length && html`<text x="190" y="110" text-anchor="middle" class="ry-axis">waiting for the first delivery…</text>`}
        ${always.map((a) => {
          const x = S.x(a.cost)
          const y = S.y(a.accuracy)
          const p = place(x)
          return html`<g key=${a.station} class=${`ry-pt g-l${(a.lane % 4) + 1}`} style=${at(x, y)}>
            <circle r="9" class="ry-pt__glow" />
            <circle r="5.5" class="ry-pt__dot" />
            <text x=${p.dx} y="4" text-anchor=${p.anchor}>always ${a.tier}</text>
          </g>`
        })}
        ${router && (() => {
          const x = S.x(router.cost)
          const y = S.y(router.accuracy)
          const p = place(x)
          return html`<g class=${`ry-pt ry-pt--jev g-l${((jl?.index ?? 0) % 4) + 1}`} style=${at(x, y)}>
            <circle r="15" class="ry-pt__halo" />
            <circle r="8" class="ry-pt__dot" />
            <text x=${p.dx} y="-9" text-anchor=${p.anchor}>Jev routing</text>
          </g>`
        })()}
      </svg>
      ${router && big && html`<p class="ry-scatter__cap">
        Jev's routing <b>${fmtPct(router.accuracy)}</b> for <b>${fmtUsd(router.cost)}</b>;
        always ${big.tier} <b>${fmtPct(big.accuracy)}</b> for <b>${fmtUsd(big.cost)}</b>${vs
          ? html` · <span class=${vs.word === 'dearer' ? 'ry-t-warn' : 'ry-t-ok'}>${vs.share ? `${fmtPct(vs.share)} ` : ''}${vs.word}</span>`
          : ''}
      </p>`}
    <//>
  `
}

/** The departure board: every train routed, newest first. */
function Departures({ run, focus, onPick }) {
  const rows = [...(run.trains ?? [])].reverse()
  return html`
    <${Box} class="ry-board">
      <${Label} class="ry-board__hd" note=${`${rows.length} of ${run.total}`}>DEPARTURES<//>
      ${!rows.length && html`<p class="g-muted">No departures yet.</p>`}
      ${rows.length > 0 && html`
        <div class="ry-board__scroll">
          <table class="ry-board__table">
            <thead><tr><th>no.</th><th>prompt</th><th>to</th><th class="num">conf</th><th>answer</th><th>ok</th></tr></thead>
            <tbody>
              ${rows.map((t) => {
                const v = t.verdict ? verdictOf(t.verdict) : null
                const st = run.stations[t.to]
                return html`
                  <tr key=${t.k} class=${`ry-board__row${t.k === focus ? ' ry-board__on' : ''}`} onClick=${() => onPick(t.k)}>
                    <td><button type="button" class="ry-board__no" onClick=${(e) => { e.stopPropagation(); onPick(t.k) }}
                      aria-label=${`Show train ${t.k + 1}`} aria-pressed=${t.k === focus}>${t.k + 1}</button></td>
                    <td class="ry-board__prompt" title=${run.prompts[t.k]?.text}>${(run.prompts[t.k]?.text ?? '').replace(/\s+/g, ' ')}</td>
                    <td><span class=${`ry-board__to g-l${(st.lane % 4) + 1}`}>${st.tier}</span>${t.rule !== 'pick' ? html`<span class="ry-board__rule" title=${RULE_WORDS[t.rule]}>${t.rule.startsWith('private') ? 'P' : '↑'}</span>` : ''}</td>
                    <td class="num">${fmtProb(t.confidence)}</td>
                    <td class="ry-board__ans">${t.said ?? (t.verdict ? '—' : '…')}</td>
                    <td class=${v ? `ry-t-${v.tone}` : 'g-muted'} title=${v?.label ?? 'on its way'}><span key=${t.verdict ?? 'wait'} class=${v ? 'ry-board__v' : 'ry-board__wait'}>${v ? v.mark : '…'}</span></td>
                  </tr>
                `
              })}
            </tbody>
          </table>
        </div>
      `}
      <p class="ry-board__foot g-mono">✓ checked against the prompt's known answer · ↑ one tier up · P private</p>
    <//>
  `
}

/** A lane: the router's routing, or a station's answers, with a mark per prompt. */
function LaneBox({ run, lane, summary }) {
  const isRouter = lane.index === run.router
  const s = run.stations.findIndex((st) => st.lane === lane.index)
  const marks = isRouter
    ? (run.trains ?? []).map((t) => ({ k: t.k, v: t.verdict }))
    : [...(lane.answers ?? [])].sort((a, b) => a.k - b.k).map((a) => ({ k: a.k, v: a.verdict }))
  const always = s >= 0 ? summary.always[s] : null
  const traffic = s >= 0 ? summary.traffic[s] : null
  const tierPriced = (lane.answers ?? []).some((a) => a.basis === 'tier')
  return html`
    <${Box} lane=${lane.index} class=${`ry-lane${isRouter ? ' ry-lane--tower' : ''}`}>
      <${LaneHead} lane=${lane} />
      <div class="ry-lane__row">
        <div class="ry-lane__score">
          <${Counter} value=${lane.score ?? null} format=${fmtWhole} class="g-score ry-lane__num" />
          <small>${isRouter ? 'routed right' : 'answered right'}</small>
        </div>
        <div class="g-stats ry-lane__stats">
          ${isRouter
            ? html`
                <${Stat} label="role" value="switch tower" />
                <${Stat} label="trains" value=${`${lane.delivered ?? 0}/${run.total}`} />
                <${Stat} label="router cost" value=${fmtUsd(summary.router.cost)} title="the routed stations' calls, plus Jev's own" />
                <${Stat} label="Jev's own" value=${laneCostText(lane)} />
              `
            : html`
                <${Stat} label="tier" value=${run.stations[s]?.tier ?? '—'} />
                <${Stat} label="answered" value=${`${lane.answered ?? 0}/${run.total}`} />
                <${Stat} label="trains in" value=${traffic?.received ?? 0} />
                <${Stat} label="always this" value=${always?.accuracy != null ? fmtPct(always.accuracy) : '—'}
                  title="its share right over the prompts the router has delivered" />
                <${Stat} label="all answers" value=${`${tierPriced ? '≈' : ''}${fmtUsd(lane.est_cost ?? 0)}`}
                  title=${tierPriced ? 'priced at its tier: the provider billed nothing and no list price is known' : 'billed, or at list price'} />
              `}
        </div>
      </div>
      <div class="ry-marks" aria-label=${`${lane.label}: how each prompt went`}>
        ${marks.map(({ k, v }) => {
          const m = v ? verdictOf(v) : null
          return html`<span key=${`${k}${v ?? ''}`} class=${`ry-mark${m ? ` ry-mark--${m.tone}` : ' ry-mark--wait'}`}
            title=${`prompt ${k + 1}: ${m ? m.label : 'on its way'}`}>${m ? m.mark : '·'}</span>`
        })}
      </div>
      <${LaneStats} lane=${lane} fouls=${!isRouter} />
    <//>
  `
}
