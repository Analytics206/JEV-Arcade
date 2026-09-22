/* Drive-Thru — orders in plain words, out as typed function calls.
 *
 * TypeSafe's function calling, at a drive-thru. The server (games/drivethru.py)
 * owns the cars, the queues, the questions and the scoring; this page draws
 * them: the customer at the speaker (the change in their order marked), the
 * ticket each window printed for that car (receipt style, every field with how
 * sure Jev was and the least sure part read back), the calls code makes from
 * it, and each window's line of cars. Pure helpers: drivethru.logic.js.
 */
import { useEffect, useState } from 'preact/hooks'
import {
  Box,
  Chip,
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
  fmtMs,
  html,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtPct, fmtProb, isRunLive, playersProblem } from './runstate.js'
import {
  altsText,
  callsOf,
  goldText,
  latestCar,
  lineMarks,
  queueLayout,
  receiptRows,
  splitChange,
  windowCars,
  windowCounts,
} from './drivethru.logic.js'

const COUNTS = [8, 12, 20, 32]
const INTERVALS = [
  [800, 'every 0.8 s'],
  [1500, 'every 1.5 s'],
  [2500, 'every 2.5 s'],
  [4000, 'every 4 s'],
]
const PATIENCE = [
  [8000, '8 s'],
  [15000, '15 s'],
  [30000, '30 s'],
  [60000, 'a minute'],
]
/** How a car went at a window, as a mark: shape and colour, so it reads without colour too. */
const MARK = {
  exact: { mark: '✓', tone: 'ok', label: 'exact order' },
  served: { mark: '✕', tone: 'err', label: 'served, not exact' },
  dropped: { mark: '–', tone: 'warn', label: 'drove off waiting' },
  busy: { mark: '…', tone: 'busy', label: 'at the window' },
  waiting: { mark: '·', tone: 'wait', label: 'waiting in line' },
}

export default function DriveThru({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [count, setCount] = useState(12)
  const [interval, setInterval_] = useState(1500)
  const [patience, setPatience] = useState(15000)
  const [readback, setReadback] = useState(0.9)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { count, interval_ms: interval, patience_ms: patience, readback })

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="dt-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} label="WINDOWS" />
          <div class="dt-params">
            <label class="g-field"><span>Cars</span>
              <select class="wr-sel" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>
                ${COUNTS.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>A new car</span>
              <select class="wr-sel" value=${interval} onChange=${(e) => setInterval_(Number(e.currentTarget.value))}>
                ${INTERVALS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>Drives off after</span>
              <select class="wr-sel" value=${patience} onChange=${(e) => setPatience(Number(e.currentTarget.value))}>
                ${PATIENCE.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
              </select>
            </label>
            <label class="g-field dt-thr"><span>Read back under</span>
              <input type="range" min="0.5" max="0.99" step="0.01" value=${readback}
                onInput=${(e) => setReadback(Number(e.currentTarget.value))} aria-label="Read back the least sure part under this confidence" />
              <b class="tnum">${readback.toFixed(2)}</b>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Open the windows" />
        <//>
        <div class="dt-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Cars pull up to the speaker on a clock and every window takes every order, one car at a time; a car
              that waits too long drives off. The menu is seven items (burgers, a chicken sandwich, nuggets, fries,
              Coke, milkshakes), three with sizes, and a few modifiers like <code>no_pickles</code> and <code>no_ice</code>.
            </p>
            <p class="g-explain">
              <b>Jev</b> gets every argument of the till's <code>add_item</code> call as a closed question, all
              in <b>one request</b>: how many of each item, which size, each modifier, "only some of them?", and
              "anything not on the menu?". Code builds the calls, and an order is only as sure as its least sure
              argument: under the line, the window reads that part back. A <b>text model</b> writes the till lines
              itself; an item, size or modifier the menu doesn't have is a foul.
            </p>
            <div class="dt-chips">
              <${Chip} tone="ok">exact order +3<//><${Chip} tone="ok">each line right +1<//>
              <${Chip} tone="err">item wrong −1<//><${Chip} tone="err">foul −1<//><${Chip} tone="warn">drove off −2<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} cars</span>`} />
        </div>
      </div>
    <//>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [pinned, setPinned] = useState(null)
  const [callLane, setCallLane] = useState(null)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const cars = run.cars ?? []
  const car = pinned != null && cars[pinned] ? pinned : latestCar(run)
  const jevLane = run.lanes.find((ln) => ln.kind === 'judgment')
  const shown = run.lanes[callLane ?? jevLane?.index ?? 0] ?? run.lanes[0]
  const step = (d) => {
    if (car == null || !cars.length) return
    setPinned(Math.max(0, Math.min(cars.length - 1, car + d)))
  }
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">${cars.length}/${run.total} cars · read back under ${Number(run.readback).toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="dt-stage">
        <${Speaker} run=${run} car=${car} pinned=${pinned != null} onStep=${step} onFollow=${() => setPinned(null)} />
        <div class="dt-tickets" role="group" aria-label=${car != null ? `Tickets for car ${car + 1}` : 'Tickets'}>
          ${run.lanes.map((ln) => html`<${Ticket} key=${ln.index} run=${run} lane=${ln} car=${car} />`)}
        </div>
        <div class="dt-right">
          <${Calls} run=${run} lane=${shown} car=${car} onLane=${setCallLane} />
          <${MenuBoard} run=${run} />
        </div>
      </div>
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${Window} key=${ln.index} run=${run} lane=${ln} car=${car} onPick=${setPinned} />`)}
      </div>
    <//>
  `
}

/** The customer at the speaker: what they said, the change marked; what they wanted, once revealed. */
function Speaker({ run, car, pinned, onStep, onFollow }) {
  const c = car != null ? run.cars?.[car] : null
  const gold = c && run.gold ? run.gold[c.i] : null
  return html`
    <${Box} class="dt-speaker">
      <${Label} note=${c ? `${car + 1} of ${run.total}` : null}>${c ? `AT THE SPEAKER · CAR ${c.i + 1}` : 'AT THE SPEAKER'}<//>
      ${!c && html`<p class="g-muted">The first car is pulling in…</p>`}
      ${c && html`
        <p class="dt-bubble">
          ${splitChange(c.said, c.change).map((part, j) =>
            part.change ? html`<mark key=${j} class="dt-change" title="changed mid-order">${part.text}</mark>` : html`<span key=${j}>${part.text}</span>`,
          )}
        </p>
      `}
      <svg viewBox="0 0 220 64" class="dt-speaker__art" role="img"
        aria-label=${c ? `Car ${c.i + 1} at the speaker post` : 'An empty lane at the speaker post'}>
        <line x1="0" y1="60" x2="220" y2="60" class="dt-road" />
        ${c && html`
          <g class="dt-bigcar">
            <path d="M10 44 L22 24 H86 L104 38 H132 C138 38 140 42 140 46 V52 H10 Z" />
            <rect x="30" y="28" width="24" height="12" rx="2" class="dt-bigcar__glass" />
            <rect x="58" y="28" width="24" height="12" rx="2" class="dt-bigcar__glass" />
            <circle cx="38" cy="54" r="8" class="dt-wheel" /><circle cx="114" cy="54" r="8" class="dt-wheel" />
          </g>
        `}
        <g class="dt-post">
          <rect x="176" y="30" width="6" height="30" />
          <rect x="164" y="6" width="30" height="28" rx="4" class="dt-post__box" />
          ${[12, 17, 22, 27].map((y) => html`<line key=${y} x1="170" y1=${y} x2="188" y2=${y} class="dt-post__grille" />`)}
        </g>
      </svg>
      ${gold && html`
        <div class="dt-gold">
          <span class="g-stat__k">what they wanted</span>
          <span class="g-mono">${goldText(gold, run)}</span>
        </div>
      `}
      <div class="dt-nav">
        <button type="button" class="dt-navbtn" onClick=${() => onStep(-1)} disabled=${car == null || car <= 0}
          aria-label="Previous car">‹ car</button>
        <button type="button" class="dt-navbtn" onClick=${() => onStep(1)} disabled=${car == null || car >= (run.cars?.length ?? 0) - 1}
          aria-label="Next car">car ›</button>
        ${pinned && html`<button type="button" class="dt-navbtn dt-navbtn--on" onClick=${onFollow}>follow the newest</button>`}
      </div>
    <//>
  `
}

/** The ticket one window printed for a car: receipt rows, the least sure marked, the read-back, the points. */
function Ticket({ run, lane, car }) {
  const t = car != null ? (lane.tickets ?? []).find((x) => x.car === car) : null
  const isJev = lane.kind === 'judgment'
  const gold = run.gold && car != null ? run.gold[car] : null
  const head = html`
    <div class="dt-ticket__hd">
      <${LaneNum} i=${lane.index} />
      <span>${car != null ? `ORDER · CAR ${car + 1}` : 'ORDER'}</span>
      <span class="spacer" />
      <span class="dt-ticket__who" title=${lane.key}>${lane.label}${t?.ms != null ? ` · ${fmtMs(t.ms)}` : ''}</span>
    </div>
  `
  if (!t || t.status !== 'served') {
    const why = !t
      ? lane.busy === car
        ? 'at the window: taking the order…'
        : car != null && car < (run.cars?.length ?? 0)
          ? lane.status === 'error' || lane.status === 'stopped'
            ? 'this window has closed'
            : 'waiting in line'
          : ''
      : `drove off after ${fmtMs(t.waited_ms)} in line`
    return html`
      <section class=${`dt-ticket dt-ticket--empty g-l${(lane.index % 4) + 1}`} aria-label=${`${lane.label}: no ticket for this car`}>
        ${head}
        <div class="dt-ticket__rule" />
        <p class=${`dt-ticket__none${t ? ' dt-t-warn' : ''}`}>${t ? `– ${why}` : why}</p>
        ${t && html`<p class="dt-ticket__pts dt-t-warn">${t.points} points</p>`}
      </section>
    `
  }
  const rows = receiptRows(t, run)
  const marks = gold ? itemMarks(t.lines, gold) : null
  const alts = isJev ? altsText(t.least, !!run.cars?.[car]?.change) : ''
  const errs = t.errors ?? 0
  const fouls = (t.fouls ?? []).length
  return html`
    <section class=${`dt-ticket g-l${(lane.index % 4) + 1}`} aria-label=${`${lane.label}'s ticket for car ${car + 1}`}>
      ${head}
      ${isJev && html`<div class="dt-ticket__sub">${t.questions} questions · ${t.requests === 1 ? 'one request' : `${t.requests} requests`}</div>`}
      <div class="dt-ticket__rule" />
      ${!rows.length && html`<p class="dt-ticket__none">nothing rung up</p>`}
      <ul class="dt-rows">
        ${rows.map((r, j) => html`
          <li key=${j} class=${`dt-row dt-row--${r.kind}${r.least ? ' dt-row--least' : ''}`} title=${r.title ?? r.why}>
            <span class="dt-row__k">${r.kind === 'foul' ? html`<s>${r.text}</s>` : r.text}${r.kind === 'foul' ? html` <b class="dt-t-err">✕ foul</b>` : ''}</span>
            ${r.conf != null && html`<span class="dt-row__v tnum">${fmtProb(r.conf)}</span>`}
            ${marks && r.kind === 'item' && html`<span class=${`dt-row__mark ${marks.get(r.item) ? 'dt-t-ok' : 'dt-t-err'}`}
              title=${marks.get(r.item) ? 'as ordered' : 'not as ordered'}>${marks.get(r.item) ? '✓' : '✕'}</span>`}
          </li>
          ${r.least && alts && html`<li key=${`a${j}`} class="dt-row dt-row--alts">${alts}</li>`}
        `)}
      </ul>
      <div class="dt-ticket__rule" />
      ${isJev
        ? t.readback
          ? html`<p class="dt-readback">Least sure part <b class="tnum">${fmtProb(t.confidence)}</b> is under ${Number(run.readback).toFixed(2)},
              so the window reads it back: <strong>“${t.readback}”</strong></p>`
          : html`<p class="dt-readback">Sure of every part (least <b class="tnum">${fmtProb(t.confidence)}</b>): no read-back.</p>`
        : html`<p class="dt-readback">A text model gives no confidence, so there is nothing to read back.</p>`}
      <p class=${`dt-ticket__pts ${t.exact ? 'dt-t-ok' : t.points < 0 ? 'dt-t-err' : ''}`}>
        ${t.points > 0 ? '+' : ''}${t.points} · ${t.exact ? '✓ exact' : `${errs} item${errs === 1 ? '' : 's'} off`}${fouls
          ? ` · ${fouls} foul${fouls === 1 ? '' : 's'}`
          : ''}${t.off_right === false ? (t.off_menu ? ' · asked about nothing off the menu' : ' · missed the off-menu ask') : ''}
      </p>
    </section>
  `
}

/** Per item on a ticket, whether all its lines are on the gold ticket. */
function itemMarks(lines, gold) {
  const ok = lineMarks(lines, gold)
  const m = new Map()
  ;(lines ?? []).forEach((l, j) => m.set(l.item, (m.get(l.item) ?? true) && ok[j]))
  return m
}

/** The calls code makes from one window's ticket for the car in view. */
function Calls({ run, lane, car, onLane }) {
  const t = car != null ? (lane.tickets ?? []).find((x) => x.car === car) : null
  const isJev = lane.kind === 'judgment'
  return html`
    <${Box} lane=${lane.index} class="dt-calls">
      <${Label}>THE CALLS CODE MAKES<//>
      ${run.lanes.length > 1 && html`
        <div class="dt-tabs" role="group" aria-label="Whose calls">
          ${run.lanes.map((ln) => html`
            <button key=${ln.index} type="button" class=${`dt-tab${ln.index === lane.index ? ' dt-tab--on' : ''}`}
              aria-pressed=${ln.index === lane.index} onClick=${() => onLane(ln.index)}>
              <${LaneNum} i=${ln.index} /> ${ln.label}
            </button>
          `)}
        </div>
      `}
      ${t
        ? html`<pre class="g-code dt-code">${callsOf(t).join('\n')}</pre>`
        : html`<p class="g-muted">No ticket from this window for this car yet.</p>`}
      <p class="dt-calls__why">
        ${isJev
          ? 'One request asks every argument as a closed question; code reads the answers and makes the calls. A call is only as sure as its least sure argument.'
          : 'The text model typed these lines itself; code only parsed them. A name that is not on the menu is a foul, and its line is dropped.'}
      </p>
    <//>
  `
}

/** The menu, as the windows were given it. */
function MenuBoard({ run }) {
  return html`
    <${Box} class="dt-menu">
      <${Label} note=${`${run.default_size} when no size is said`}>THE MENU<//>
      <ul class="dt-menu__list">
        ${(run.menu ?? []).map((it) => html`
          <li key=${it.id}>
            <span class="dt-menu__item">${it.id.replace(/_/g, ' ')}</span>
            <span class="dt-menu__opts g-mono">${[...(it.sizes ?? []).map((s) => s[0].toUpperCase()), ...(it.mods ?? []).map((m) => run.mods?.[m] ?? m)].join(' · ')}</span>
          </li>
        `)}
      </ul>
    <//>
  `
}

/** One window: its line of cars, a mark per car, and its tally. */
function Window({ run, lane, car, onPick }) {
  const cars = windowCars(run.cars, lane)
  const counts = windowCounts(cars)
  const L = queueLayout(cars, { width: 380 })
  const isJev = lane.kind === 'judgment'
  const fields = lane.fields_total ? lane.fields_right / lane.fields_total : NaN
  const label = `${lane.label}'s window: ${counts.served} served, ${counts.waiting} waiting, ${counts.dropped} drove off`
  return html`
    <${Box} lane=${lane.index} class="dt-window">
      <${LaneHead} lane=${lane} />
      <div class="dt-window__row">
        <div class="dt-window__score">
          <span class="tnum">${lane.score ?? 0}</span><small>points</small>
        </div>
        <div class="dt-window__strip">
          <span class=${`dt-window__counts g-mono${counts.dropped ? ' dt-t-warn' : ''}`}>
            ${counts.served} served · ${counts.waiting} waiting · ${counts.dropped} drove off
          </span>
          <svg viewBox="0 0 380 34" role="img" aria-label=${label}>
            <line x1="0" y1="30" x2="380" y2="30" class="dt-road" />
            ${L.waiting.map((w) => html`<${MiniCar} key=${w.i} x=${w.x} tone="wait" />`)}
            ${L.atWindow && html`<${MiniCar} x=${L.atWindow.x} tone="busy" />`}
            <rect x=${L.window.x} y="3" width=${L.window.w} height="26" class="dt-booth" />
            <rect x=${L.window.x + 4} y="8" width=${L.window.w - 8} height="9" class="dt-booth__pane" />
            ${L.more > 0 && html`<text x="2" y="11" class="dt-more">+${L.more}</text>`}
          </svg>
        </div>
      </div>
      <div class="dt-marks" role="group" aria-label=${`${lane.label}: each car`}>
        ${cars.map((c) => {
          const m = MARK[c.status]
          return html`<button key=${c.i} type="button" class=${`dt-mark dt-mark--${m.tone}${c.i === car ? ' dt-mark--on' : ''}`}
            title=${`car ${c.i + 1}: ${m.label}${c.ticket?.points != null ? ` (${c.ticket.points > 0 ? '+' : ''}${c.ticket.points})` : ''}`}
            aria-label=${`Car ${c.i + 1}: ${m.label}`} onClick=${() => onPick(c.i)}>${m.mark}</button>`
        })}
      </div>
      <div class="g-stats dt-window__stats">
        <${Stat} label="exact" value=${`${lane.exact ?? 0}/${counts.served}`} />
        <${Stat} label="fields right" value=${fmtPct(fields)} title="quantity, size and modifiers per item, and the off-menu ask" />
        ${isJev && html`<${Stat} label="read back" value=${lane.readbacks ?? 0} />`}
        <${Stat} label="drove off" value=${lane.dropped ?? 0} tone=${lane.dropped ? 'warn' : undefined} />
      </div>
      <${LaneStats} lane=${lane} fouls=${!isJev} />
    <//>
  `
}

/** A small car in a window's line. */
function MiniCar({ x, tone }) {
  return html`
    <g class=${`dt-mini dt-mini--${tone}`} transform=${`translate(${x} 10)`}>
      <path d="M0 13 L5 5 H22 L28 10 H34 Q36 10 36 13 V16 H0 Z" />
      <circle cx="8" cy="17" r="3" class="dt-wheel" /><circle cx="28" cy="17" r="3" class="dt-wheel" />
    </g>
  `
}
