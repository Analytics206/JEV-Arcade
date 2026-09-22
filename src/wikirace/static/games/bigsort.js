/* The Big Sort — thousands of Wikipedia articles sorted into topics while you watch.
 *
 * TypeSafe's map-reduce over big data. The server (games/bigsort.py) draws the
 * articles and asks every lane for every one; each answer lands as one small
 * push. This page draws one pixel wall per lane (a canvas cell per article,
 * lit in its topic's colour when its answer lands), the counters above each,
 * the topics with every lane's counts, an inspector for any cell, and how
 * often the lanes agree.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Box,
  GameFrame,
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
  html,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtPct, isRunLive, playersProblem } from './runstate.js'
import {
  FOUL,
  cellAt,
  cellRect,
  eta,
  fmtN,
  fmtSpan,
  fmtUsd,
  heat,
  labelArrays,
  stepCursor,
  tally,
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

const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

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
    <${GameFrame} game=${game}>
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
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
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
              a lane stops where it is.
            </p>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${fmtN(r.total)} articles</span>`} />
        </div>
      </div>
    <//>
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
  const body = useMemo(
    () => view && html`<${Board} run=${view} mode=${mode} setMode=${setMode} cursor=${cursor} onCursor=${setCursor} colors=${colors} />`,
    [view, mode, cursor, colors],
  )
  if (!run) return html`<${GameFrame} game=${game}>${swatches}<${RunLoading} error=${error} /><//>`
  return html`
    <${GameFrame} game=${game}>
      ${swatches}
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
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
  return html`
    <div class="bs-head">
      <${Label} note="one cell per article, coloured when its answer comes back">${fmtN(n)} WIKIPEDIA INTROS · ${topics.length} TOPICS<//>
      <span class="spacer" />
      <div class="bs-modes" role="group" aria-label="How the walls are ordered">
        ${[['landed', 'as they land'], ['topic', 'grouped by topic']].map(
          ([m, l]) => html`<button key=${m} type="button" class=${`bs-mode${mode === m ? ' bs-mode--on' : ''}`}
            aria-pressed=${mode === m} onClick=${() => setMode(m)}>${l}</button>`,
        )}
      </div>
    </div>
    <div class=${`bs-walls bs-walls--${Math.min(run.lanes.length, 4)}`}>
      ${run.lanes.map(
        (ln, i) => html`<${WallCard} key=${ln.index} run=${run} lane=${ln} arrays=${arrays[i]} t=${tallies[i]} grid=${grid}
          mode=${mode} cursor=${cursor} onCursor=${onCursor} colors=${colors} topics=${topics} />`,
      )}
    </div>
    <div class="bs-lower">
      <${Legend} run=${run} topics=${topics} tallies=${tallies} />
      <${Inspector} run=${run} arrays=${arrays} cursor=${cursor} topics=${topics} />
      <${Agreement} run=${run} topics=${topics} />
    </div>
  `
}

/** A lane's wall, and the counters above and below it. */
function WallCard({ run, lane, arrays, t, grid, mode, cursor, onCursor, colors, topics }) {
  const n = grid.n
  const answered = t.sorted + t.fouls
  const rate = lane.rate || 0
  const over = lane.status === 'done' || lane.status === 'error' || lane.status === 'stopped'
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
  return html`
    <${Box} lane=${lane.index} class="bs-wallcard">
      <${LaneHead} lane=${lane} />
      <div class=${`bs-progress g-mono g-t-${tone}`}>${status}</div>
      <${Wall} arrays=${arrays} grid=${grid} mode=${mode} cursor=${cursor} onCursor=${onCursor} colors=${colors}
        summary=${wallSummary(lane.label, topics, t, n)} />
      <div class="bs-counters g-mono">
        <span>${lane.in_flight ? `${lane.in_flight} in flight` : `${atOnce ?? '—'} at once`}</span>
        <span>${each ? `~${fmtN(each)} tokens each` : 'tokens each: —'}</span>
        <span class="bs-counters__cost">${lane.projected_cost != null ? `≈ ${fmtUsd(lane.projected_cost)} for all ${fmtN(n)}` : 'for all: —'}</span>
      </div>
      <${LaneStats} lane=${lane} extra=${html`
        <${Stat} label="articles / s" value=${rate ? rate.toFixed(rate < 10 ? 1 : 0) : '—'} />
        <${Stat} label="sorted" value=${fmtN(t.sorted)} />`} />
    <//>
  `
}

/** The pixel wall: a canvas cell per article. Point at one (or focus the wall
 *  and use the arrow keys) and the inspector shows it. */
function Wall({ arrays, grid, mode, cursor, onCursor, colors, summary }) {
  const ref = useRef(null)
  const order = useMemo(() => wallOrder(arrays.topic, mode), [arrays, mode])
  const posOf = useMemo(() => {
    const m = new Int32Array(order.length)
    order.forEach((art, pos) => (m[art] = pos))
    return m
  }, [order])
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
    ctx.clearRect(0, 0, grid.width, grid.height)
    let fill = null
    for (let pos = 0; pos < order.length; pos++) {
      const tp = arrays.topic[order[pos]]
      const want = tp >= 0 ? colors.topics[tp] : tp === FOUL ? colors.foul : colors.unsorted
      if (want !== fill) {
        ctx.fillStyle = want
        fill = want
      }
      const r = cellRect(pos, grid)
      ctx.fillRect(r.x, r.y, r.w, r.h)
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
  }, [arrays, order, posOf, cursor, colors, grid])
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

/** The reduce: articles per topic, a column per lane, each with a bar. */
function Legend({ run, topics, tallies }) {
  const top = Math.max(1, ...tallies.flatMap((t) => t.counts))
  const cell = (c, j) => html`<td key=${j} class="num bs-legend__n">
    <span class="tnum">${fmtN(c)}</span><span class=${`bs-legend__bar g-l${(run.lanes[j].index % 4) + 1}`} style=${{ width: `${(c / top) * 100}%` }} /></td>`
  return html`
    <${Box} class="bs-legend">
      <${Label}>TOPICS<//>
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
  return html`
    <${Box} class="bs-inspect">
      <${Label} note=${item ? `article ${fmtN(cursor + 1)} of ${fmtN(run.total)}` : null}>INSPECTOR<//>
      ${!item
        ? html`<p class="g-muted">Point at a cell, or focus a wall and use the arrow keys, to see its article and every lane's topic for it.</p>`
        : html`
          <a class="bs-inspect__title" href=${wikiUrl(item.title)} target="_blank" rel="noopener noreferrer">${item.title}</a>
          <p class="bs-inspect__text">${item.text}</p>
          <ul class="bs-inspect__lanes">
            ${run.lanes.map((ln, j) => {
              const tp = arrays[j].topic[cursor]
              const p = arrays[j].p[cursor]
              let what
              if (tp >= 0) {
                what = html`<span class=${`bs-sw bs-c${tp}`} aria-hidden="true" /><b>${topics[tp].name}</b>
                  ${Number.isFinite(p) && html`<span class="g-mono g-muted">p ${p.toFixed(2)}</span>`}`
              } else if (tp === FOUL) {
                what = html`<span class="g-t-err">✕ foul: “${arrays[j].said.get(cursor) ?? '?'}”</span>`
              } else {
                what = html`<span class="g-muted">not sorted yet</span>`
              }
              return html`<li key=${ln.index}><${LaneNum} i=${ln.index} /><span class="bs-inspect__who">${ln.label}</span>${what}</li>`
            })}
          </ul>
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
              <span class="tnum">${r.rate != null ? fmtPct(r.rate) : '—'}</span>
              <small>agree, over ${fmtN(r.both)} articles both sorted</small>
            </div>
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
