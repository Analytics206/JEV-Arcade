/* The Big Sort — thousands of Wikipedia articles sorted into topics while you watch.
 *
 * TypeSafe's map-reduce over big data. The server (games/bigsort.py) draws the
 * articles and asks every lane for every one; each answer lands as one small
 * push. This page draws each lane as a sorting machine: a lit scoreboard (the
 * articles sorted, the articles a second), the stages (hopper, map, reduce),
 * a pixel wall with a cell per article that flashes as its answer lands and
 * drops a tile into its topic's bin, and the bins rising below. Then the
 * reduce across lanes as a sorted landscape, an inspector for any cell, and
 * how often the lanes agree.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Box,
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
  html,
  sfx,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, isLaneLive, isRunLive, playersProblem } from './runstate.js'
import {
  FOUL,
  UNSORTED,
  cellAt,
  cellRect,
  eta,
  fmtN,
  fmtSpan,
  fmtUsd,
  freshCells,
  heat,
  labelArrays,
  landscape,
  sortOutcome,
  stepCursor,
  tally,
  topicAbbr,
  wallGrid,
  wallOrder,
  wallSummary,
} from './bigsort.logic.js'

const COUNTS = [100, 250, 500, 1000, 2000]
const JEV_AT_ONCE = [8, 16, 32, 64]
const TEXT_AT_ONCE = [1, 2, 4, 8]
const LIMITS = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [300, '5 min'], [600, '10 min']]
/** The wall's drawing width in CSS pixels; the page scales it to its box. */
const WALL_W = 420
/** The page redraws at most this often while answers pour in. */
const FRAME_MS = 150
/** A landing tile's flight from its cell to its bin. */
const DROP_MS = 1000
/** Tiles launched per redraw, and alive at once, per lane: a sample of the landings, not all of them. */
const DROP_BATCH = 8
const DROP_MAX = 36
/** How long a cell that just landed stays lit before it settles to its topic's colour. */
const FLASH_MS = 260
/** The most cells lit with a glow at once (the rest just flash). */
const GLOW_MAX = 48

const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
const calmNow = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const fmtRate = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1))

export default function BigSort({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [count, setCount] = useState(500)
  const [jevAtOnce, setJevAtOnce] = useState(32)
  const [textAtOnce, setTextAtOnce] = useState(2)
  const [limit, setLimit] = useState(120)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { count, concurrency: jevAtOnce, text_concurrency: textAtOnce, time_limit_s: limit })
  const select = (value, set, options) => html`
    <select class="wr-sel" value=${value} onChange=${(e) => set(Number(e.currentTarget.value))}>
      ${options.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
    </select>`

  return html`
    <${GameFrame} game=${game} class="bs-page">
      <div class="g-setup">
        <${Box} class="bs-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="bs-params">
            <label class="g-field"><span>Articles</span>${select(count, setCount, COUNTS.map((n) => [n, `${fmtN(n)} random`]))}</label>
            <label class="g-field"><span>Time limit</span>${select(limit, setLimit, LIMITS)}</label>
            <label class="g-field"><span>Jev at once</span>${select(jevAtOnce, setJevAtOnce, JEV_AT_ONCE.map((n) => [n, `${n} in flight`]))}</label>
            <label class="g-field"><span>A text model at once</span>${select(textAtOnce, setTextAtOnce, TEXT_AT_ONCE.map((n) => [n, `${n} in flight`]))}</label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Draw the articles and sort" />
          <p class="g-muted bs-setup__note">Drawing ${fmtN(count)} random articles from Wikipedia, twenty to a request, takes a few seconds.</p>
        <//>
        <div class="bs-side">
          <${Box} class="bs-how">
            <${Label}>HOW IT'S PLAYED<//>
            <${SortDiagram} count=${count} />
            <p class="g-explain">
              ${fmtN(count)} random Wikipedia articles, the first two sentences of each, and eight topics: science &
              tech, people, places, arts, nature, history, sport and other. Every lane sorts every article
              (the <b>map</b>); code tallies what comes back (the <b>reduce</b>): counts per topic, articles a second,
              what it cost and what all of it would cost, and how often the lanes agree.
            </p>
            <p class="g-explain">
              <b>Jev</b> answers one Choice per article, many in flight at once, in about a tenth of a second each,
              for input tokens only. A <b>text model</b> gets the same question in words
              and answers <code>TOPIC: …</code>, a few at a time; a name that isn't a topic is a foul. When the time limit is up,
              a lane stops where it is. The lane that sorts the most articles wins.
            </p>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${fmtN(r.total)} articles</span>`} />
        </div>
      </div>
    <//>
  `
}

const DIA_BINS = ['science', 'people', 'places', 'arts', 'nature', 'history', 'sport', 'other']

/** The machine in miniature, for the setup: articles pour from the hopper,
 *  each lane maps each one to a topic, and the reduce stacks them in bins. */
function SortDiagram({ count }) {
  const calm = calmNow()
  const bx = (i) => 58 + i * 63
  const tiles = Array.from({ length: 14 }, (_, j) => j)
  const label = `A diagram: ${fmtN(count)} random articles pour from a hopper; every lane maps each one to one of eight topics; the reduce tallies them into eight bins.`
  return html`
    <svg class="bs-dia" viewBox="0 0 560 196" role="img" aria-label=${label}>
      <rect x="0.5" y="0.5" width="559" height="195" rx="12" class="bs-dia__bg" />
      <path d="M40 14 H176 L136 58 H80 Z" class="bs-dia__hopper" />
      ${Array.from({ length: 18 }, (_, j) => html`<rect key=${j} x=${52 + (j % 9) * 12} y=${20 + Math.floor(j / 9) * 11} width="8" height="8" rx="1.5" class="bs-dia__art" />`)}
      <text x="108" y="74" class="bs-dia__cap">${fmtN(count)} ARTICLES</text>
      <g class="bs-dia__stage">
        <rect x="232" y="16" width="150" height="52" rx="10" class="bs-dia__map" />
        <text x="307" y="37" class="bs-dia__title">MAP</text>
        <text x="307" y="55" class="bs-dia__sub">every lane, every article</text>
      </g>
      <path d="M176 38 H226" class="bs-dia__flow" />
      <path d="M382 42 H436 Q470 42 470 70 V86" class="bs-dia__flow" />
      <text x="486" y="80" class="bs-dia__title bs-dia__title--l">REDUCE</text>
      ${DIA_BINS.map(
        (key, i) => html`
          <g key=${key} class=${`bs-c${i}`}>
            <rect x=${bx(i) - 26} y="112" width="52" height="58" rx="6" class="bs-dia__bin" />
            <rect x=${bx(i) - 22} y=${calm ? 140 - i * 2 : 166} width="44" height=${calm ? 26 + i * 2 : 0} rx="3" class="bs-dia__fill">
              ${!calm && html`
                <animate attributeName="height" values="0;${46 - ((i * 5) % 22)};${46 - ((i * 5) % 22)};0" keyTimes="0;0.85;0.95;1" dur="9s" begin=${`${-i * 0.9}s`} repeatCount="indefinite" />
                <animate attributeName="y" values="166;${120 + ((i * 5) % 22)};${120 + ((i * 5) % 22)};166" keyTimes="0;0.85;0.95;1" dur="9s" begin=${`${-i * 0.9}s`} repeatCount="indefinite" />`}
            </rect>
            <text x=${bx(i)} y="184" class="bs-dia__key">${topicAbbr(key)}</text>
          </g>`,
      )}
      ${!calm &&
      tiles.map((j) => {
        const i = (j * 5) % 8
        const d = `M108 50 Q200 30 300 42 Q${(300 + bx(i)) / 2} ${60 + (j % 3) * 8} ${bx(i)} 138`
        return html`
          <rect key=${j} x="-4" y="-4" width="8" height="8" rx="1.5" class=${`bs-dia__tile bs-c${i}`} opacity="0">
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.85;1" dur="2.6s" begin=${`${(j * 0.19).toFixed(2)}s`} repeatCount="indefinite" />
            <animateMotion path=${d} dur="2.6s" begin=${`${(j * 0.19).toFixed(2)}s`} repeatCount="indefinite" />
          </rect>`
      })}
    </svg>
  `
}

/* ── A game ────────────────────────────────────────────────────────────────── */

/** *value*, but changed at most every *ms* while the run is live: the walls
 *  redraw a few times a second however fast the answers land. */
function useThrottled(value, ms) {
  const [shown, setShown] = useState(value)
  const last = useRef(0)
  const timer = useRef(null)
  const latest = useRef(value)
  latest.current = value
  useEffect(() => {
    if (value === shown) return
    const wait = last.current + ms - Date.now()
    if (wait <= 0 || !isRunLive(value)) {
      clearTimeout(timer.current)
      timer.current = null
      last.current = Date.now()
      setShown(value)
    } else if (!timer.current) {
      timer.current = setTimeout(() => {
        timer.current = null
        last.current = Date.now()
        setShown(latest.current)
      }, wait)
    }
  }, [value])
  useEffect(() => () => clearTimeout(timer.current), [])
  return shown ?? value
}

/** The topic colours as the canvas needs them: read once from swatches styled
 *  with the page's tokens, so the wall and the legend cannot disagree. */
function usePalette(n) {
  const ref = useRef(null)
  const [colors, setColors] = useState(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const kids = [...el.children]
    const read = (i) => getComputedStyle(kids[i]).backgroundColor
    setColors({
      topics: Array.from({ length: n }, (_, i) => read(i)),
      unsorted: read(n), foul: read(n + 1), cursor: read(n + 2), ink: read(n + 3),
    })
  }, [n])
  const swatches = html`
    <span class="bs-palette" ref=${ref} aria-hidden="true">
      ${Array.from({ length: n }, (_, i) => html`<i key=${i} class=${`bs-c${i}`} />`)}
      <i class="bs-c-unsorted" /><i class="bs-c-foul" /><i class="bs-c-cursor" /><i class="bs-c-ink" />
    </span>`
  return [colors, swatches]
}

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const view = useThrottled(run, FRAME_MS)
  const [mode, setMode] = useState('landed')
  const [cursor, setCursor] = useState(-1)
  const [colors, swatches] = usePalette(view?.topics?.length ?? 8)
  // A round that ends in front of you sorts its walls by topic, once, unless
  // you already chose how they are ordered: the landscape the reduce made.
  const chose = useRef(false)
  const watched = useRef(false)
  const pickMode = useMemo(() => (m) => {
    chose.current = true
    setMode(m)
  }, [])
  useEffect(() => {
    if (isRunLive(run)) {
      watched.current = true
      return
    }
    if (!watched.current || run?.status !== 'finished' || chose.current) return
    watched.current = false
    const t = setTimeout(() => setMode('topic'), 700)
    return () => clearTimeout(t)
  }, [run?.status])
  const body = useMemo(
    () => view && html`<${Board} run=${view} mode=${mode} setMode=${pickMode} cursor=${cursor} onCursor=${setCursor} colors=${colors} />`,
    [view, mode, cursor, colors],
  )
  if (!run) return html`<${GameFrame} game=${game} class="bs-page">${swatches}<${RunLoading} error=${error} /><//>`
  // The game's own rule: a lane's score is the articles it sorted, and the most wins.
  const outcome = sortOutcome(run)
  return html`
    <${GameFrame} game=${game} class="bs-page">
      ${swatches}
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${outcome.winners} headline=${outcome.headline} sub=${outcome.sub}>
        <span class="g-mono g-muted">${fmtN(run.total)} articles · ${run.topics.length} topics · lanes stop after ${fmtSpan(run.time_limit_s)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      ${body}
    <//>
  `
}

function Board({ run, mode, setMode, cursor, onCursor, colors }) {
  const n = run.total ?? run.items.length
  const topics = run.topics
  const arrays = useMemo(() => run.lanes.map((ln) => labelArrays(ln.labels, n)), [run.lanes, n])
  const tallies = arrays.map((a) => tally(a.topic, topics.length))
  const grid = useMemo(() => wallGrid(n, WALL_W), [n])
  const binTop = Math.max(1, ...tallies.flatMap((t) => [...t.counts, t.fouls]))
  const live = isRunLive(run)
  const winners = !live && run.status === 'finished' ? sortOutcome(run).winners : []
  return html`
    <div class="bs-head">
      <${Label} note="one cell per article, lit as its answer comes back">${fmtN(n)} WIKIPEDIA INTROS · ${topics.length} TOPICS<//>
      <span class="spacer" />
      <div class="bs-modes" role="group" aria-label="How the walls are ordered">
        ${[['landed', 'as they land'], ['topic', 'grouped by topic']].map(
          ([m, l]) => html`<button key=${m} type="button" class=${`bs-mode${mode === m ? ' bs-mode--on' : ''}`}
            aria-pressed=${mode === m} onClick=${() => { sfx.select(); setMode(m) }}>${l}</button>`,
        )}
      </div>
    </div>
    <div class=${`bs-walls bs-walls--${Math.min(run.lanes.length, 4)}`}>
      ${run.lanes.map(
        (ln, i) => html`<${WallCard} key=${ln.index} run=${run} lane=${ln} arrays=${arrays[i]} t=${tallies[i]} grid=${grid}
          mode=${mode} cursor=${cursor} onCursor=${onCursor} colors=${colors} topics=${topics} binTop=${binTop} live=${live}
          won=${winners.includes(ln.index)} tie=${winners.length > 1} />`,
      )}
    </div>
    <div class="bs-lower">
      <${Legend} run=${run} topics=${topics} tallies=${tallies} />
      <${Inspector} run=${run} arrays=${arrays} cursor=${cursor} topics=${topics} />
      <${Agreement} run=${run} topics=${topics} />
    </div>
  `
}

/** A lane's machine: its scoreboard, its stages, its wall and bins, its counters. */
function WallCard({ run, lane, arrays, t, grid, mode, cursor, onCursor, colors, topics, binTop, live, won, tie }) {
  const n = grid.n
  const answered = t.sorted + t.fouls
  const rate = lane.rate || 0
  const over = lane.status === 'done' || lane.status === 'error' || lane.status === 'stopped'
  const laneLive = live && isLaneLive(lane)
  let status
  let tone
  if (answered >= n) {
    status = `${fmtN(answered)} / ${fmtN(n)} · done in ${fmtSpan((lane.elapsed_ms ?? 0) / 1000)}`
    tone = 'ok'
  } else if (lane.timed_out || over) {
    const rest = eta(answered, n, rate)
    const more = Number.isFinite(rest) && rest > 0 ? `, ${fmtSpan(rest)} more at its pace` : ''
    status = `${fmtN(answered)} / ${fmtN(n)} · ${lane.timed_out ? "time's up" : lane.status}${more}`
    tone = lane.status === 'error' ? 'err' : 'warn'
  } else {
    const rest = eta(answered, n, rate)
    status = `${fmtN(answered)} / ${fmtN(n)}${rate && Number.isFinite(rest) ? ` · ${fmtSpan(rest)} to go` : ''}`
    tone = 'live'
  }
  const atOnce = lane.kind === 'judgment' ? run.params?.concurrency : run.params?.text_concurrency
  const each = lane.calls ? Math.round(lane.tokens_in / lane.calls) : null
  // A lane that finishes the whole round in front of you gets a little confetti.
  const board = useRef(null)
  const below = useRef(null)
  useEffect(() => {
    const done = answered >= n
    if (below.current && done && live) {
      burstFrom(board.current, { colors: [LANE_COLORS[lane.index % 4], '#ffffff', '#ffe14d'], count: 46, power: 0.7 })
      sfx.coin()
    }
    below.current = !done
  }, [answered >= n])
  const inFlight = lane.in_flight || 0
  return html`
    <${Box} lane=${lane.index} class=${`bs-wallcard${won ? ' bs-wallcard--win' : ''}`}>
      <${LaneHead} lane=${lane} />
      ${won && html`<div class="bs-win"><span aria-hidden="true">★</span> ${tie ? 'TIED FOR THE MOST SORTED' : 'MOST SORTED'}</div>`}
      <div class="bs-score" ref=${board}>
        <div class="bs-score__cell">
          <span class="bs-score__k">SORTED</span>
          <span class="bs-score__row"><${Counter} value=${t.sorted} format=${fmtN} class="g-score bs-score__v" /><span class="bs-score__of">/ ${fmtN(n)}</span></span>
        </div>
        <div class="bs-score__cell bs-score__cell--rate">
          <span class="bs-score__k">ARTICLES / S</span>
          <span class="g-score bs-score__v bs-score__v--rate tnum">${rate ? fmtRate(rate) : '—'}</span>
        </div>
      </div>
      <div class="bs-rail" role="img" aria-label=${`${fmtN(answered)} of ${fmtN(n)} answered${t.fouls ? `, ${fmtN(t.fouls)} fouls` : ''}`}>
        <span class=${`bs-rail__fill${laneLive ? ' is-live' : ''}`} style=${{ width: `${(t.sorted / Math.max(1, n)) * 100}%` }} />
        <span class="bs-rail__foul" style=${{ left: `${(t.sorted / Math.max(1, n)) * 100}%`, width: `${(t.fouls / Math.max(1, n)) * 100}%` }} />
      </div>
      <div class=${`bs-progress g-mono g-t-${tone}`}>${status}</div>
      <div class="bs-stages">
        <span class=${`bs-stage${laneLive && t.unsorted > 0 ? ' is-on' : ''}`}><b>HOPPER</b><span class="tnum">${fmtN(t.unsorted)} left</span></span>
        <span class=${`bs-stage__arrow${laneLive ? ' is-on' : ''}`} aria-hidden="true">▸</span>
        <span class=${`bs-stage bs-stage--map${inFlight > 0 ? ' is-on' : ''}`}><b>MAP</b><span class="tnum">${inFlight} in flight</span></span>
        <span class=${`bs-stage__arrow${laneLive ? ' is-on' : ''}`} aria-hidden="true">▸</span>
        <span class=${`bs-stage bs-stage--reduce${t.sorted > 0 ? ' is-on' : ''}`}><b>REDUCE</b><span class="tnum">${fmtN(t.sorted)} tallied</span></span>
      </div>
      <${Machine} labels=${lane.labels} arrays=${arrays} t=${t} grid=${grid} mode=${mode} cursor=${cursor} onCursor=${onCursor} colors=${colors}
        topics=${topics} binTop=${binTop} animate=${laneLive} summary=${wallSummary(lane.label, topics, t, n)} />
      <div class="bs-counters g-mono">
        <span>${inFlight ? `${inFlight} in flight` : `${atOnce ?? '—'} at once`}</span>
        <span>${each ? `~${fmtN(each)} tokens each` : 'tokens each: —'}</span>
        <span class="bs-counters__cost">${lane.projected_cost != null ? `≈ ${fmtUsd(lane.projected_cost)} for all ${fmtN(n)}` : 'for all: —'}</span>
      </div>
      <${LaneStats} lane=${lane} extra=${html`
        <${Stat} label="articles / s" value=${rate ? rate.toFixed(rate < 10 ? 1 : 0) : '—'} />
        <${Stat} label="sorted" value=${fmtN(t.sorted)} />`} />
    <//>
  `
}

/**
 * The tiles in flight from the wall to the bins: a few of the answers that
 * landed since the last redraw, each alive for one flight. Nothing flies on
 * the first draw (a replay, or a page opened mid-round) or with motion reduced.
 */
function useDrops(labels, animate) {
  const seen = useRef(null)
  const alive = useRef([])
  const count = labels?.length ?? 0
  return useMemo(() => {
    const from = seen.current
    seen.current = count
    const t = nowMs()
    alive.current = alive.current.filter((d) => t - d.at < DROP_MS)
    if (from == null || !animate || calmNow() || count <= from) return alive.current
    const fresh = labels.slice(from, count)
    const pick = fresh.length <= DROP_BATCH
      ? fresh
      : Array.from({ length: DROP_BATCH }, (_, j) => fresh[Math.floor(((j + 0.5) * fresh.length) / DROP_BATCH)])
    alive.current = [...alive.current, ...pick.map((it, j) => ({ k: it[0], t: it[1], at: t, delay: Math.round((j * FRAME_MS) / pick.length) }))].slice(-DROP_MAX)
    return alive.current
  }, [count, animate])
}

/** The wall, the tiles falling from it, and the bins they fall into. */
function Machine({ labels, arrays, t, grid, mode, cursor, onCursor, colors, topics, binTop, animate, summary }) {
  const order = useMemo(() => wallOrder(arrays.topic, mode), [arrays, mode])
  const posOf = useMemo(() => {
    const m = new Int32Array(order.length)
    order.forEach((art, pos) => (m[art] = pos))
    return m
  }, [order])
  const drops = useDrops(labels, animate)
  const bins = topics.length + 1
  for (const d of drops) {
    if (d.x != null) continue
    const r = cellRect(posOf[d.k] ?? d.k, grid)
    d.x = (((r.x + r.w / 2) / grid.width) * 100).toFixed(2)
    d.y = (((r.y + r.h / 2) / grid.height) * 100).toFixed(2)
    d.bx = ((((d.t >= 0 ? d.t : topics.length) + 0.5) / bins) * 100).toFixed(2)
  }
  return html`
    <div class="bs-mach">
      <div class="bs-wallwrap">
        <${Wall} arrays=${arrays} grid=${grid} order=${order} posOf=${posOf} mode=${mode} cursor=${cursor} onCursor=${onCursor} colors=${colors}
          summary=${summary} animate=${animate} />
        <div class="bs-drops" aria-hidden="true">
          ${drops.map(
            (d) => html`<span key=${d.k} class=${`bs-drop ${d.t >= 0 ? `bs-c${d.t}` : 'bs-c-foul'}`}
              style=${{ '--x': d.x, '--y': d.y, '--bx': d.bx, animationDelay: `${d.delay}ms` }}><i style=${{ animationDelay: `${d.delay}ms` }} /></span>`,
          )}
        </div>
      </div>
      <${Bins} t=${t} topics=${topics} top=${binTop} summary=${summary} />
    </div>
  `
}

/** The reduce, drawn: a bin per topic (and one for fouls), filled to its count on one scale for every lane. */
function Bins({ t, topics, top, summary }) {
  const bin = (key, cls, c, label, name) => html`
    <div key=${key} class=${`bs-bin ${cls}`} title=${`${name}: ${fmtN(c)}`}>
      <span key=${c} class=${`bs-bin__n tnum${c ? '' : ' is-zero'}`}>${fmtN(c)}</span>
      <span class="bs-bin__well"><span class="bs-bin__fill" style=${{ height: `${(c / top) * 100}%` }} /></span>
      <span class="bs-bin__k">${label}</span>
    </div>`
  return html`
    <div class="bs-bins" style=${{ '--bins': topics.length + 1 }} role="img" aria-label=${`The reduce so far. ${summary}`}>
      ${topics.map((tp, i) => bin(tp.key, `bs-c${i}`, t.counts[i], topicAbbr(tp.key), tp.name))}
      ${bin('foul', 'bs-c-foul bs-bin--foul', t.fouls, '✕', 'fouls: not a topic')}
    </div>
  `
}

/** Every cell of the wall at *rectOf(article)*, in its topic's colour, with a
 *  bevel (a lit top edge, a shaded bottom) when the cells are big enough. */
function paintCells(ctx, grid, topic, colors, rectOf) {
  const n = topic.length
  ctx.clearRect(0, 0, grid.width, grid.height)
  let fill = null
  for (let k = 0; k < n; k++) {
    const tp = topic[k]
    const want = tp >= 0 ? colors.topics[tp] : tp === FOUL ? colors.foul : colors.unsorted
    if (want !== fill) {
      ctx.fillStyle = want
      fill = want
    }
    const r = rectOf(k)
    ctx.fillRect(r.x, r.y, r.w, r.h)
  }
  if (grid.cell < 6) return
  ctx.fillStyle = 'rgba(255, 255, 255, 0.26)'
  for (let k = 0; k < n; k++) {
    if (topic[k] === UNSORTED) continue
    const r = rectOf(k)
    ctx.fillRect(r.x, r.y, r.w, 1)
  }
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)'
  for (let k = 0; k < n; k++) {
    if (topic[k] === UNSORTED) continue
    const r = rectOf(k)
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1)
  }
}

/** A re-sort of the wall (its order changed): every cell flies from where it
 *  was to where it goes, the first places first. */
const MOVE_MS = 1100
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2)

/** The pixel wall: a canvas cell per article, lit as its answer lands. Point
 *  at one (or focus the wall and use the arrow keys) and the inspector shows it. */
function Wall({ arrays, grid, order, posOf, mode, cursor, onCursor, colors, summary, animate }) {
  const ref = useRef(null)
  const drawn = useRef(null)
  const shownMode = useRef(mode)
  const shownPos = useRef(null)
  const move = useRef(null)
  const settle = useRef(null)
  const [tick, setTick] = useState(0)
  useEffect(() => () => clearTimeout(settle.current), [])
  useEffect(() => {
    const cv = ref.current
    if (!cv || !colors) return
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1))
    if (cv.width !== grid.width * dpr || cv.height !== grid.height * dpr) {
      cv.width = grid.width * dpr
      cv.height = grid.height * dpr
    }
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const from = shownPos.current
    const moved = shownMode.current !== mode
    shownMode.current = mode
    shownPos.current = posOf
    // The walls re-sorted: fly every cell to its new place, once. A redraw
    // that comes in mid-flight (answers still landing) carries the flight on.
    if (moved && from && from.length === posOf.length && !calmNow()) move.current = { from, t0: nowMs() }
    const mv = move.current
    if (mv && mv.from.length === posOf.length && nowMs() - mv.t0 < MOVE_MS) {
      drawn.current = arrays.topic
      const n = posOf.length
      let raf = 0
      const frame = (t) => {
        const e = (t - mv.t0) / MOVE_MS
        paintCells(ctx, grid, arrays.topic, colors, (k) => {
          const u = easeInOut(Math.max(0, Math.min(1, (e - (posOf[k] / n) * 0.35) / 0.65)))
          const a = cellRect(mv.from[k], grid)
          const b = cellRect(posOf[k], grid)
          return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w, h: a.h }
        })
        if (e < 1) raf = requestAnimationFrame(frame)
        else {
          move.current = null
          setTick((x) => x + 1)
        }
      }
      raf = requestAnimationFrame(frame)
      return () => cancelAnimationFrame(raf)
    }
    move.current = null
    const fresh = animate && !calmNow() ? freshCells(drawn.current, arrays.topic) : []
    drawn.current = arrays.topic
    paintCells(ctx, grid, arrays.topic, colors, (k) => cellRect(posOf[k], grid))
    // What just landed: lit white, with a glow of its topic, for a moment.
    if (fresh.length) {
      ctx.save()
      fresh.forEach((k, j) => {
        const tp = arrays.topic[k]
        const r = cellRect(posOf[k], grid)
        if (j < GLOW_MAX) {
          ctx.shadowColor = tp >= 0 ? colors.topics[tp] : colors.foul
          ctx.shadowBlur = 10
        } else ctx.shadowBlur = 0
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
        ctx.fillRect(r.x, r.y, r.w, r.h)
      })
      ctx.restore()
      clearTimeout(settle.current)
      settle.current = setTimeout(() => setTick((x) => x + 1), FLASH_MS)
    }
    if (cursor >= 0 && cursor < order.length) {
      const r = cellRect(posOf[cursor], grid)
      ctx.lineWidth = 3
      ctx.strokeStyle = colors.ink
      ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3)
      ctx.lineWidth = 1.5
      ctx.strokeStyle = colors.cursor
      ctx.strokeRect(r.x - 0.75, r.y - 0.75, r.w + 1.5, r.h + 1.5)
    }
  }, [arrays, order, posOf, mode, cursor, colors, grid, tick])
  const pick = (e) => {
    const b = ref.current.getBoundingClientRect()
    if (!b.width) return
    const pos = cellAt((e.clientX - b.left) * (grid.width / b.width), (e.clientY - b.top) * (grid.height / b.height), grid)
    if (pos >= 0 && order[pos] !== cursor) onCursor(order[pos])
  }
  const key = (e) => {
    const next = stepCursor(cursor >= 0 ? posOf[cursor] : -1, e.key, grid.cols, grid.n)
    if (next == null) return
    e.preventDefault()
    onCursor(order[next])
  }
  return html`<canvas ref=${ref} class="bs-wall" style=${{ aspectRatio: `${grid.width} / ${grid.height}` }}
    role="img" aria-label=${summary} tabIndex="0" onMouseMove=${pick} onClick=${pick} onKeyDown=${key}
    onFocus=${() => cursor < 0 && onCursor(order[0])} />`
}

/** The reduce across lanes: each lane's sorted landscape, then the counts. */
function Legend({ run, topics, tallies }) {
  const n = run.total ?? 0
  const top = Math.max(1, ...tallies.flatMap((t) => t.counts))
  const cell = (c, j) => html`<td key=${j} class="num bs-legend__n">
    <span class="tnum">${fmtN(c)}</span><span class=${`bs-legend__bar g-l${(run.lanes[j].index % 4) + 1}`} style=${{ width: `${(c / top) * 100}%` }} /></td>`
  return html`
    <${Box} class="bs-legend">
      <${Label} note="every lane's articles, by topic">THE REDUCE<//>
      <div class="bs-land">
        ${run.lanes.map((ln, j) => {
          const segs = landscape(tallies[j], n)
          const words = segs
            .filter((s) => s.n > 0 && s.kind === 'topic')
            .map((s) => `${fmtN(s.n)} ${topics[s.i].name}`)
            .join(', ')
          return html`
            <div key=${ln.index} class=${`bs-land__row g-l${(ln.index % 4) + 1}`}>
              <${LaneNum} i=${ln.index} />
              <div class="bs-land__bar" role="img" aria-label=${`${ln.label}: ${words || 'nothing sorted yet'}${tallies[j].fouls ? `, ${fmtN(tallies[j].fouls)} fouls` : ''}`}>
                ${segs.map((s) => {
                  const cls = s.kind === 'topic' ? `bs-c${s.i}` : s.kind === 'foul' ? 'bs-c-foul bs-land__seg--foul' : 'bs-land__seg--rest'
                  const tag = s.kind === 'topic' ? topicAbbr(topics[s.i].key) : s.kind === 'foul' ? '✕' : ''
                  return html`<span key=${s.kind === 'topic' ? s.i : s.kind} class=${`bs-land__seg ${cls}`} style=${{ flexGrow: s.n }}
                    title=${s.kind === 'topic' ? `${topics[s.i].name}: ${fmtN(s.n)}` : s.kind === 'foul' ? `fouls: ${fmtN(s.n)}` : `not sorted yet: ${fmtN(s.n)}`}>${s.share >= 0.07 ? tag : ''}</span>`
                })}
              </div>
            </div>`
        })}
      </div>
      <table class="g-table bs-legend__t">
        <thead>
          <tr>
            <th>topic</th>
            ${run.lanes.map((ln) => html`<th key=${ln.index} class="num" title=${ln.label}><${LaneNum} i=${ln.index} /><span class="sr-only">${ln.label}</span></th>`)}
          </tr>
        </thead>
        <tbody>
          ${topics.map(
            (tp, i) => html`<tr key=${tp.key}>
              <td class="bs-legend__k"><span class=${`bs-sw bs-c${i}`} aria-hidden="true" />${tp.name}</td>
              ${tallies.map((t, j) => cell(t.counts[i], j))}
            </tr>`,
          )}
          <tr class="bs-legend__extra">
            <td class="bs-legend__k"><span class="bs-sw bs-c-foul" aria-hidden="true" />foul: not a topic</td>
            ${tallies.map((t, j) => html`<td key=${j} class=${`num${t.fouls ? ' g-t-err' : ''}`}>${fmtN(t.fouls)}</td>`)}
          </tr>
          <tr class="bs-legend__extra">
            <td class="bs-legend__k"><span class="bs-sw bs-c-unsorted" aria-hidden="true" />not sorted yet</td>
            ${tallies.map((t, j) => html`<td key=${j} class="num g-muted">${fmtN(t.unsorted)}</td>`)}
          </tr>
        </tbody>
      </table>
    <//>
  `
}

/** One article, and what every lane made of it. */
function Inspector({ run, arrays, cursor, topics }) {
  const item = cursor >= 0 ? run.items[cursor] : null
  const picks = item ? arrays.map((a) => a.topic[cursor]).filter((tp) => tp >= 0) : []
  const agree = picks.length > 1 && picks.every((tp) => tp === picks[0])
  return html`
    <${Box} class="bs-inspect">
      <${Label} note=${item ? `article ${fmtN(cursor + 1)} of ${fmtN(run.total)}` : null}>INSPECTOR<//>
      ${!item
        ? html`<p class="g-muted">Point at a cell, or focus a wall and use the arrow keys, to see its article and every lane's topic for it.</p>`
        : html`
          <div class="bs-inspect__body" key=${cursor}>
            <a class="bs-inspect__title" href=${wikiUrl(item.title)} target="_blank" rel="noopener noreferrer">${item.title}</a>
            <p class="bs-inspect__text">${item.text}</p>
            <ul class="bs-inspect__lanes">
              ${run.lanes.map((ln, j) => {
                const tp = arrays[j].topic[cursor]
                const p = arrays[j].p[cursor]
                let what
                if (tp >= 0) {
                  what = html`<span class=${`bs-topic bs-c${tp}`}><span class="bs-sw" aria-hidden="true" /><b>${topics[tp].name}</b></span>
                    ${Number.isFinite(p) && html`<span class="g-mono g-muted">p ${p.toFixed(2)}</span>`}`
                } else if (tp === FOUL) {
                  what = html`<span class="g-t-err">✕ foul: “${arrays[j].said.get(cursor) ?? '?'}”</span>`
                } else {
                  what = html`<span class="g-muted">not sorted yet</span>`
                }
                return html`<li key=${ln.index}><${LaneNum} i=${ln.index} /><span class="bs-inspect__who">${ln.label}</span>${what}</li>`
              })}
            </ul>
            ${picks.length > 1 && html`<p class=${`bs-inspect__agree ${agree ? 'g-t-ok' : 'g-t-warn'}`}>${agree ? '✓ every lane that sorted it agrees' : '≠ the lanes disagree on this one'}</p>`}
          </div>
        `}
    <//>
  `
}

/** Where two lanes sorted the same articles: how often they agree, and where not. */
function Agreement({ run, topics }) {
  const pairs = run.agreement ?? []
  return html`
    <${Box} class="bs-agree">
      <${Label}>AGREEMENT<//>
      ${!pairs.length && html`<p class="g-muted">With two lanes or more, this compares their topics on the articles both sorted.</p>`}
      ${pairs.map((r) => {
        const a = run.lanes[r.a]
        const b = run.lanes[r.b]
        return html`
          <div key=${`${r.a}-${r.b}`} class="bs-pair">
            <div class="bs-pair__hd">
              <${LaneNum} i=${r.a} /><span>${a.label}</span><span class="g-muted">and</span><${LaneNum} i=${r.b} /><span>${b.label}</span>
            </div>
            <div class="bs-pair__rate">
              <${Counter} value=${r.rate != null ? r.rate * 100 : null} format=${(v) => `${v.toFixed(1)}%`} class="g-score bs-pair__v" />
              <small>agree, over ${fmtN(r.both)} articles both sorted</small>
            </div>
            ${r.rate != null && html`<span class="bs-pair__meter" aria-hidden="true"><span style=${{ width: `${r.rate * 100}%` }} /></span>`}
            ${r.both > 0 && html`<${Confusion} r=${r} topics=${topics} a=${a} b=${b} />`}
          </div>
        `
      })}
    <//>
  `
}

function Confusion({ r, topics, a, b }) {
  const rowMax = r.confusion.map((row) => Math.max(...row))
  return html`
    <table class="bs-conf">
      <caption class="sr-only">Rows: ${a.label}'s topic. Columns: ${b.label}'s topic. Each cell counts the articles.</caption>
      <thead>
        <tr>
          <th scope="col"><span class="g-mono bs-conf__corner">${a.index + 1}↓ ${b.index + 1}→</span></th>
          ${topics.map((tp, j) => html`<th key=${j} scope="col" title=${tp.name}><span class=${`bs-sw bs-c${j}`} aria-hidden="true" /><span class="sr-only">${tp.name}</span></th>`)}
        </tr>
      </thead>
      <tbody>
        ${topics.map(
          (tp, i) => html`<tr key=${tp.key}>
            <th scope="row" class="bs-conf__row" title=${tp.name}><span class=${`bs-sw bs-c${i}`} aria-hidden="true" />${tp.key}</th>
            ${r.confusion[i].map(
              (c, j) => html`<td key=${j} class=${`bs-conf__c${i === j ? ' bs-conf__c--same' : ''}`} style=${{ '--h': heat(c, rowMax[i]) }}
                title=${`${a.label}: ${topics[i].name} · ${b.label}: ${topics[j].name} · ${c}`}>${c || ''}</td>`,
            )}
          </tr>`,
        )}
      </tbody>
    </table>
  `
}
