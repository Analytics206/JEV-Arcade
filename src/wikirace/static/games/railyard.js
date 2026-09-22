/* Rail Yard — Jev works the switches; the text models answer.
 *
 * Model routing, drawn as a rail yard. The server (games/railyard.py) owns the
 * prompts, the stations' answers, the grading and the routing rule; this page
 * draws them: the queue of trains on the main line, Jev's switch tower, a track
 * per station with the latest train running down it, the request behind the
 * train in view, quality against cost for the router and for "always one
 * station", and the departure board. Geometry and scales: railyard.logic.js.
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
  costAgainst,
  defaultTiers,
  ease,
  fmtUsd,
  ruleLine,
  scatterScales,
  snippet,
  trackPose,
  trainText,
  yardLayout,
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
const TRIP_MS = 1100

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
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="ry-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} label="TOWER AND STATIONS" />
          ${stations.length > 0 &&
          html`<div class="ry-tiers">
            <${Label} note="default: by list price">STATIONS<//>
            ${stations.map(
              (s, j) => html`
                <label class="ry-tier" key=${slot(s, j)}>
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
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
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

const ruleText = (thr) => [
  'if private_data > 0.5: go local',
  `elif confidence < ${Number(thr).toFixed(2)}: go one tier up`,
  'else: take the top pick',
]

/** The routing rule as code prints it; `on` marks the line a train took. */
function Rule({ threshold, on = -1 }) {
  return html`
    <div class="ry-rule" role="group" aria-label=${on >= 0 ? 'The routing rule, the line this train took marked' : 'The routing rule'}>
      ${ruleText(threshold).map(
        (t, j) => html`<span key=${j} class=${j === on ? 'ry-rule__on' : ''}>${j === on ? '▸ ' : '  '}${t}</span>`,
      )}
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [sel, setSel] = useState(null)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const trains = run.trains ?? []
  const focus = (sel != null && trains[sel]) || trains[trains.length - 1] || null
  const summary = yardSummary(run)
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">${summary.router.n}/${run.total} trains delivered · ${run.stations.length} stations</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${Yard} run=${run} summary=${summary} />
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

/** 0 → 1 over *ms* each time *key* changes (at once when motion is reduced). */
function useTrip(key, ms) {
  const [t, setT] = useState(1)
  useEffect(() => {
    if (key == null || reducedMotion() || typeof requestAnimationFrame === 'undefined') {
      setT(1)
      return
    }
    const t0 = performance.now()
    let raf = 0
    const step = (now) => {
      const v = Math.min(1, (now - t0) / ms)
      setT(v)
      if (v < 1) raf = requestAnimationFrame(step)
    }
    setT(0)
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [key, ms])
  return t
}

const tierOf = (run, s) => run.stations[s]?.tier ?? '?'
const verdictOf = (v) => VERDICT[v] ?? { mark: '…', tone: 'neutral', label: 'on its way' }

/** The yard: the queue, the tower, a track per station, the latest train on its way. */
function Yard({ run, summary }) {
  const n = run.stations.length
  const L = useMemo(() => yardLayout(n), [n])
  const trains = run.trains ?? []
  const cur = trains[trains.length - 1] ?? null
  const trip = ease(useTrip(cur ? cur.k : null, TRIP_MS))
  const next = trains.length
  const live = isRunLive(run)
  const front = live ? run.prompts[next] : null
  const waiting = live ? run.prompts.slice(next + 1, next + 1 + L.queue.length) : []
  const more = live ? Math.max(0, run.total - next - 1 - waiting.length) : 0
  const pose = cur ? trackPose(L, cur.to, trip) : null
  const blade = cur ? trackPose(L, cur.to, 0.22) : null
  const jevLane = run.lanes[run.router]
  const label = `Rail yard: ${trains.length} of ${run.total} trains routed by Jev's switch tower to ${n} stations (${run.stations
    .map((s) => s.tier)
    .join(', ')}).${cur ? ` Train ${cur.k + 1} went to the ${tierOf(run, cur.to)} station.` : ''}`
  return html`
    <${Box} class="ry-yard">
      <svg viewBox=${`0 0 ${L.width} ${L.height}`} role="img" aria-label=${label}>
        <rect x="0.5" y="0.5" width=${L.width - 1} height=${L.height - 1} rx="6" class="ry-yard__bg" />
        <text x="24" y="30" class="ry-yard__cap">
          stations are the text models in this round · ${run.total} prompts with known answers
        </text>
        <g class="ry-ties">
          <path d=${L.main} />
          ${L.tracks.map((t, s) => html`<path key=${s} d=${t.d} />`)}
        </g>
        <g class="ry-rails">
          <path d=${L.main} class="ry-rail--main" />
          ${L.tracks.map((t, s) => html`<path key=${s} d=${t.d} class=${cur && cur.to === s ? 'ry-rail--on' : ''} />`)}
        </g>
        ${waiting.map((p, j) => html`<${Car} key=${`q${p.k}`} box=${L.queue[j]} text=${p.text} width=${16} />`)}
        ${more > 0 && html`<text x="24" y=${L.mainY + 42} class="ry-yard__more">+${more} more</text>`}
        ${front && html`<${Car} key=${`f${front.k}`} box=${L.front} text=${front.text} front />`}
        ${!live && !trains.length && html`<text x="24" y=${L.mainY + 42} class="ry-yard__more">no trains ran</text>`}
        <g class="ry-tower">
          <rect x=${L.tower.x} y=${L.tower.y} width=${L.tower.w} height=${L.tower.h} rx="6" />
          <text x=${L.switchX} y=${L.tower.y + 26} class="ry-tower__name">JEV</text>
          <text x=${L.switchX} y=${L.tower.y + 44} class="ry-tower__sub">${cur ? fmtMs(cur.jev_ms) : 'switch tower'}</text>
          <line x1=${L.switchX} y1=${L.tower.y + L.tower.h} x2=${L.switchX} y2=${L.mainY - 10} class="ry-tower__wire" />
          ${blade && html`<line x1=${L.switchX} y1=${L.mainY} x2=${blade.x} y2=${blade.y} class="ry-blade" />`}
          <circle cx=${L.switchX} cy=${L.mainY} r="7" class="ry-switch" />
        </g>
        ${cur && pose && html`
          <g key=${`t${cur.k}`} class=${`ry-car ry-car--now${cur.verdict && trip >= 1 ? ' ry-car--in' : ''}`}
            transform=${`translate(${pose.x.toFixed(1)} ${pose.y.toFixed(1)}) rotate(${pose.angle.toFixed(1)})`}>
            <rect x="-62" y="-26" width="124" height="52" rx="6" />
            ${snippet(trainText(run.prompts[cur.k]?.text), 17).map((ln, j) => html`<text key=${j} x="-52" y=${-6 + j * 14}>${ln}</text>`)}
            <circle cx="-38" cy="27" r="4" class="ry-wheel" /><circle cx="38" cy="27" r="4" class="ry-wheel" />
          </g>
        `}
        ${L.stations.map((b, s) => html`<${Station} key=${s} run=${run} s=${s} box=${b} on=${cur?.to === s}
          traffic=${summary.traffic[s]} />`)}
        ${jevLane && html`<text x=${L.tower.x + L.tower.w + 10} y=${L.tower.y + 14} class=${`ry-yard__who g-l${(jevLane.index % 4) + 1}`}>
          lane ${jevLane.index + 1} · ${jevLane.label}</text>`}
      </svg>
    <//>
  `
}

/** A train waiting on the main line (or at the front, for the switch). */
function Car({ box, text, front = false, width = 17 }) {
  const lines = snippet(trainText(text), width)
  return html`
    <g class=${`ry-car${front ? ' ry-car--front' : ''}`}>
      <rect x=${box.x} y=${box.y} width=${box.w} height=${box.h} rx="5" />
      ${lines.map((ln, j) => html`<text key=${j} x=${box.x + 9} y=${box.y + box.h / 2 - 4 + j * 14}>${ln}</text>`)}
    </g>
  `
}

/** A station's platform: its lane, tier and model, the trains it received and what they cost. */
function Station({ run, s, box, on, traffic }) {
  const st = run.stations[s]
  const lane = run.lanes[st.lane]
  const last = traffic?.last
  const v = last ? verdictOf(last.verdict) : null
  const waiting = traffic && traffic.received > traffic.delivered
  return html`
    <g class=${`ry-station${on ? ' ry-station--on' : ''}${lane?.status === 'error' ? ' ry-station--out' : ''} g-l${(st.lane % 4) + 1}`}>
      <rect x=${box.x} y=${box.y} width=${box.w} height=${box.h} rx="5" class="ry-station__box" />
      <rect x=${box.x} y=${box.y} width="4" height=${box.h} class="ry-station__stripe" />
      <rect x=${box.x + 12} y=${box.y + 8} width="16" height="16" class="ry-station__num" />
      <text x=${box.x + 20} y=${box.y + 20} class="ry-station__numtxt">${st.lane + 1}</text>
      <text x=${box.x + 36} y=${box.y + 20}>
        <tspan class="ry-station__tier">${st.tier.toUpperCase()}</tspan>
        <tspan class="ry-station__model" dx="10">${st.model_id.length > 28 ? `${st.model_id.slice(0, 27)}…` : st.model_id}</tspan>
      </text>
      <text x=${box.x + 36} y=${box.y + box.h - 9} class="ry-station__line">
        ${TIER_SHORT[st.tier]} · ${traffic?.received ?? 0} ${traffic?.received === 1 ? 'train' : 'trains'} · ${fmtUsd(traffic?.cost ?? 0)}
      </text>
      ${waiting && html`<text x=${box.x + box.w - 14} y=${box.y + 20} class="ry-station__wait">…</text>`}
      ${!waiting && v && html`<text x=${box.x + box.w - 14} y=${box.y + 20} class=${`ry-station__v ry-f-${v.tone}`}>${v.mark}</text>`}
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
  return html`
    <${Box} lane=${lane} class="ry-train">
      <${Label} note=${`${train.questions} questions · ${fmtMs(train.jev_ms)}`}>THIS TRAIN · ONE REQUEST<//>
      <p class="ry-train__prompt"><span class="ry-train__no">${train.k + 1}</span> ${run.prompts[train.k]?.text}</p>
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
          return html`<span key=${k} class=${`ry-flag${p > 0.5 ? ' ry-flag--on' : ''}`}>${name} <b class="tnum">${fmtProb(p)}</b></span>`
        })}
      </div>
      <${Rule} threshold=${run.threshold} on=${line} />
      <p class="ry-train__to">
        → <b>${tierOf(run, train.to).toUpperCase()}</b> <span class="g-muted">${st[train.to]?.model_id}</span>
        <span class="g-muted"> · ${RULE_WORDS[train.rule] ?? train.rule} · confidence ${fmtProb(train.confidence)}</span>
      </p>
      ${v
        ? html`<p class=${`ry-train__v ry-t-${v.tone}`}><span>${v.mark} ${v.label}</span>${' '}${train.said != null &&
            html`<span class="g-mono ry-train__said">ANSWER: ${train.said || '—'}</span>`}</p>`
        : html`<p class="g-muted">On its way to the ${tierOf(run, train.to)} station…</p>`}
      ${gold && html`<p class="g-mono g-muted ry-train__gold">known answer: ${gold.answers.join(' · ')}</p>`}
      ${pinned && html`<button type="button" class="ry-follow" onClick=${onFollow}>Follow the latest train</button>`}
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
  return html`
    <${Box} class="ry-scatter">
      <${Label} note=${`same ${summary.router.n} prompts`}>QUALITY AGAINST COST<//>
      <svg viewBox="0 0 348 236" role="img" aria-label=${label}>
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
          return html`<g key=${a.station} class=${`ry-pt g-l${(a.lane % 4) + 1}`}>
            <circle cx=${x} cy=${y} r="6" />
            <text x=${x + p.dx} y=${y + 4} text-anchor=${p.anchor}>always ${a.tier}</text>
          </g>`
        })}
        ${router && (() => {
          const x = S.x(router.cost)
          const y = S.y(router.accuracy)
          const p = place(x)
          return html`<g class=${`ry-pt ry-pt--jev g-l${((jl?.index ?? 0) % 4) + 1}`}>
            <circle cx=${x} cy=${y} r="8" />
            <text x=${x + p.dx} y=${y - 8} text-anchor=${p.anchor}>Jev routing</text>
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
                  <tr key=${t.k} class=${t.k === focus ? 'ry-board__on' : ''} onClick=${() => onPick(t.k)}>
                    <td><button type="button" class="ry-board__no" onClick=${(e) => { e.stopPropagation(); onPick(t.k) }}
                      aria-label=${`Show train ${t.k + 1}`} aria-pressed=${t.k === focus}>${t.k + 1}</button></td>
                    <td class="ry-board__prompt" title=${run.prompts[t.k]?.text}>${(run.prompts[t.k]?.text ?? '').replace(/\s+/g, ' ')}</td>
                    <td><span class=${`ry-board__to g-l${(st.lane % 4) + 1}`}>${st.tier}</span>${t.rule !== 'pick' ? html`<span class="ry-board__rule" title=${RULE_WORDS[t.rule]}>${t.rule.startsWith('private') ? 'P' : '↑'}</span>` : ''}</td>
                    <td class="num">${fmtProb(t.confidence)}</td>
                    <td class="ry-board__ans">${t.said ?? (t.verdict ? '—' : '…')}</td>
                    <td class=${v ? `ry-t-${v.tone}` : 'g-muted'} title=${v?.label ?? 'on its way'}>${v ? v.mark : '…'}</td>
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
    <${Box} lane=${lane.index} class="ry-lane">
      <${LaneHead} lane=${lane} />
      <div class="ry-lane__row">
        <div class="ry-lane__score">
          <span class="tnum">${lane.score ?? '—'}${lane.score != null ? html`<small>%</small>` : ''}</span>
          <small>${isRouter ? 'routed right' : 'answered right'}</small>
        </div>
        <div class="g-stats ry-lane__stats">
          ${isRouter
            ? html`
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
          return html`<span key=${k} class=${`ry-mark${m ? ` ry-mark--${m.tone}` : ''}`}
            title=${`prompt ${k + 1}: ${m ? m.label : 'on its way'}`}>${m ? m.mark : '·'}</span>`
        })}
      </div>
      <${LaneStats} lane=${lane} fouls=${!isRouter} />
    <//>
  `
}
