/* Drive-Thru — orders in plain words, out as typed function calls.
 *
 * TypeSafe's function calling, at a drive-thru. The server (games/drivethru.py)
 * owns the cars, the queues, the questions and the scoring; this page draws
 * them: the customer at the speaker (their words coming through, the change in
 * their order marked), the ticket each window printed for that car (a receipt
 * that prints line by line, every field with how sure Jev was, the least sure
 * part highlighted and read back, stamped ORDER UP when exact), the calls code
 * makes from it, the menu board lit where the order touches it, and each
 * window's lane of cars. Pure helpers: drivethru.logic.js.
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
  PixelText,
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
import { defaultPlayers, fmtPct, fmtProb, isRunLive, playersProblem } from './runstate.js'
import {
  altsText,
  callTokens,
  callsOf,
  goldText,
  latestCar,
  leadersOf,
  lineMarks,
  queueLayout,
  receiptRows,
  sparkPath,
  splitChange,
  streakOf,
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

/* The setup's sample ticket: what a window prints for one car. */
const SAMPLE_SAID = 'Two cheeseburgers, one with no pickles, large fries and a Coke. Actually, make the Coke a medium.'
const SAMPLE_CHANGE = 'Actually, make the Coke a medium.'
const SAMPLE_BURGER = { qty: 0.97, size: null, mods: { no_pickles: 0.93 }, split: 0.92 }
const SAMPLE_RUN = { readback: 0.9, mods: { no_pickles: 'no pickles' }, cars: [{ i: 0, said: SAMPLE_SAID, change: SAMPLE_CHANGE }], gold: null }
const SAMPLE_LANE = {
  index: 0, kind: 'judgment', label: 'jev', key: 'jev', status: 'done',
  tickets: [{
    car: 0, status: 'served', off_menu: false, clarify: null, fouls: [], readback: "That's a medium Coke?",
    lines: [
      { item: 'cheeseburger', qty: 1, size: null, mods: ['no_pickles'], conf: SAMPLE_BURGER },
      { item: 'cheeseburger', qty: 1, size: null, mods: [], conf: SAMPLE_BURGER },
      { item: 'fries', qty: 1, size: 'large', mods: [], conf: { qty: 0.97, size: 0.95, mods: {}, split: null } },
      { item: 'cola', qty: 1, size: 'medium', mods: [], conf: { qty: 0.96, size: 0.84, mods: {}, split: null } },
    ],
    least: { kind: 'size', item: 'cola', value: 'medium', conf: 0.84, alts: [{ option: 'medium', p: 0.84 }, { option: 'large', p: 0.12 }, { option: 'small', p: 0.04 }] },
    confidence: 0.84, exact: true, errors: 0, off_right: true, points: 7, questions: 23, requests: 1, ms: 180,
  }],
}

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
            <div class="dt-how">
              <div class="dt-how__flow" aria-hidden="true">
                <div class="dt-how__step">
                  <span class="dt-how__k">1 · the speaker</span>
                  <p class="dt-bubble dt-bubble--sample">
                    ${splitChange(SAMPLE_SAID, SAMPLE_CHANGE).map((part, j) =>
                      part.change ? html`<mark key=${j} class="dt-change">${part.text}</mark>` : html`<span key=${j}>${part.text}</span>`,
                    )}
                  </p>
                </div>
                <span class="dt-how__arrow">▸</span>
                <div class="dt-how__step">
                  <span class="dt-how__k">2 · Jev's ticket</span>
                  <${Ticket} run=${SAMPLE_RUN} lane=${SAMPLE_LANE} car=${0} />
                </div>
                <span class="dt-how__arrow">▸</span>
                <div class="dt-how__step">
                  <span class="dt-how__k">3 · the calls</span>
                  <div class="dt-term"><${CallLines} lines=${callsOf(SAMPLE_LANE.tickets[0])} /></div>
                </div>
              </div>
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
                <${Chip} tone="ok">✓ exact order +3<//><${Chip} tone="ok">each line right +1<//>
                <${Chip} tone="err">✕ item wrong −1<//><${Chip} tone="err">✕ foul −1<//><${Chip} tone="warn">– drove off −2<//>
              </div>
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
  const live = isRunLive(run)
  const car = pinned != null && cars[pinned] ? pinned : latestCar(run)
  const jevLane = run.lanes.find((ln) => ln.kind === 'judgment')
  const shown = run.lanes[callLane ?? jevLane?.index ?? 0] ?? run.lanes[0]
  const shownTicket = car != null ? (shown.tickets ?? []).find((x) => x.car === car) : null
  const step = (d) => {
    if (car == null || !cars.length) return
    sfx.select()
    setPinned(Math.max(0, Math.min(cars.length - 1, car + d)))
  }

  // Who won, by the game's rule (most points; every one of them on a tie). A
  // lone window has nobody to beat: its finale is the kitchen's call.
  const multi = run.lanes.length > 1
  const leaders = leadersOf(run)
  const solo = multi ? null : run.lanes[0]
  // While live, "leading" only means something once the windows differ.
  const ahead = multi && (!live || leaders.length < run.lanes.length) ? leaders : []

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${multi ? leaders : undefined}
        headline=${solo ? 'ORDER UP!' : undefined}
        sub=${solo ? `${solo.label} · ${solo.score ?? 0} points · ${solo.exact ?? 0} of ${solo.served ?? 0} orders exact` : undefined}
        win=${!solo || (solo.exact ?? 0) > 0}>
        <span class="g-mono g-muted">${cars.length}/${run.total} cars · read back under ${Number(run.readback).toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="dt-stage">
        <${Speaker} run=${run} car=${car} live=${live} pinned=${pinned != null} onStep=${step} onFollow=${() => { sfx.select(); setPinned(null) }} />
        <div class="dt-tickets" role="group" aria-label=${car != null ? `Tickets for car ${car + 1}` : 'Tickets'}>
          ${run.lanes.map((ln) => html`<${Ticket} key=${ln.index} run=${run} lane=${ln} car=${car} />`)}
        </div>
        <div class="dt-right">
          <${Calls} run=${run} lane=${shown} car=${car} ticket=${shownTicket} onLane=${(i) => { sfx.select(); setCallLane(i) }} />
          <${MenuBoard} run=${run} ticket=${shownTicket} lane=${shown} />
        </div>
      </div>
      <div class="g-lanes">
        ${run.lanes.map(
          (ln) => html`<${Window} key=${ln.index} run=${run} lane=${ln} car=${car} live=${live}
            lead=${ahead.includes(ln.index)} onPick=${(i) => { sfx.select(); setPinned(i) }} />`,
        )}
      </div>
    <//>
  `
}

/* ── The speaker ───────────────────────────────────────────────────────────── */

/** The customer's words, coming through the speaker a word at a time; the
 *  change in the order marked. */
function Words({ said, change }) {
  let w = 0
  const word = (text, n) =>
    text.split(/(\s+)/).map((tok, m) =>
      /^\s*$/.test(tok) ? tok : html`<span key=${`${n}.${m}`} class="dt-word" style=${{ '--w': Math.min(w++, 40) }}>${tok}</span>`,
    )
  return splitChange(said, change).map((part, j) =>
    part.change
      ? html`<mark key=${j} class="dt-change" title="changed mid-order">${word(part.text, j)}</mark>`
      : html`<span key=${j}>${word(part.text, j)}</span>`,
  )
}

/** The customer at the speaker: a car rolls up, its order comes through, and
 *  what they wanted shows once revealed. */
function Speaker({ run, car, live, pinned, onStep, onFollow }) {
  const c = car != null ? run.cars?.[car] : null
  const gold = c && run.gold ? run.gold[c.i] : null
  const talking = live && c && !pinned
  return html`
    <${Box} class="dt-speaker">
      <${Label} note=${c ? `${car + 1} of ${run.total}` : null}>${c ? `AT THE SPEAKER · CAR ${c.i + 1}` : 'AT THE SPEAKER'}<//>
      <div class="dt-speech">
        ${!c && html`<p class="dt-bubble dt-bubble--wait"><span class="dt-dots" aria-hidden="true"><i /><i /><i /></span> The first car is pulling in…</p>`}
        ${c && html`
          <p class="dt-bubble" key=${c.i}>
            <${Words} said=${c.said} change=${c.change} />
            ${c.change && html`<span class="dt-bubble__tag">changed mid-order</span>`}
          </p>
        `}
      </div>
      <svg viewBox="0 0 280 118" class=${`dt-scene${c ? ` dt-car--${c.i % 4}` : ''}${talking ? ' is-talking' : ''}`} role="img"
        aria-label=${c ? `Car ${c.i + 1} at the speaker post` : 'An empty lane at the speaker post'}>
        <defs>
          <linearGradient id="dtRoad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="dt-stop-road0" /><stop offset="1" class="dt-stop-road1" />
          </linearGradient>
          <linearGradient id="dtBeam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" class="dt-stop-beam0" /><stop offset="1" class="dt-stop-beam1" />
          </linearGradient>
          <linearGradient id="dtBody" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" class="dt-stop-body0" /><stop offset="1" class="dt-stop-body1" />
          </linearGradient>
        </defs>
        <rect x="0" y="92" width="280" height="26" fill="url(#dtRoad)" />
        <line x1="0" y1="92" x2="280" y2="92" class="dt-curb" />
        <g class="dt-dashes">${[0, 1, 2, 3, 4, 5, 6].map((n) => html`<rect key=${n} x=${6 + n * 40} y="106" width="20" height="2.5" rx="1" />`)}</g>
        ${c && html`
          <g key=${c.i} class="dt-bigcar">
            <polygon points="150,70 240,52 240,98 150,82" fill="url(#dtBeam)" class="dt-beam" />
            <ellipse cx="80" cy="99" rx="70" ry="5" class="dt-bigcar__shadow" />
            <path d="M12 86 L26 62 Q30 56 38 56 H102 Q108 56 112 60 L128 74 H146 Q154 74 154 82 V90 Q154 94 150 94 H14 Q10 94 10 90 Z" class="dt-bigcar__body" fill="url(#dtBody)" />
            <path d="M34 62 H64 V76 H26 Z" class="dt-bigcar__glass" />
            <path d="M70 62 H100 L114 76 H70 Z" class="dt-bigcar__glass" />
            <rect x="144" y="78" width="10" height="5" rx="2" class="dt-bigcar__lamp" />
            <rect x="10" y="80" width="6" height="5" rx="1.5" class="dt-bigcar__tail" />
            <circle cx="42" cy="94" r="10" class="dt-wheel" /><circle cx="42" cy="94" r="4" class="dt-hub" />
            <circle cx="126" cy="94" r="10" class="dt-wheel" /><circle cx="126" cy="94" r="4" class="dt-hub" />
          </g>
        `}
        <g class="dt-post">
          <rect x="236" y="48" width="8" height="46" class="dt-post__pole" />
          <rect x="218" y="14" width="44" height="40" rx="7" class="dt-post__box" />
          ${[22, 28, 34, 40, 46].map((y) => html`<line key=${y} x1="226" y1=${y} x2="254" y2=${y} class="dt-post__grille" />`)}
          <circle cx="258" cy="19" r="2.2" class="dt-post__led" />
        </g>
        <g class="dt-waves" aria-hidden="true">
          ${[0, 1, 2].map((n) => html`<path key=${n} d=${`M${210 - n * 9} ${22 - n * 4} q${-8 - n * 3} ${12 + n * 4} 0 ${24 + n * 8}`} style=${{ '--n': n }} />`)}
        </g>
      </svg>
      ${gold && html`
        <div class="dt-gold">
          <span class="dt-gold__k">★ what they wanted</span>
          <span class="dt-gold__v g-mono">${goldText(gold, run)}</span>
        </div>
      `}
      <div class="dt-nav">
        <button type="button" class="dt-navbtn" onClick=${() => onStep(-1)} disabled=${car == null || car <= 0}
          aria-label="Previous car">‹ car</button>
        <button type="button" class="dt-navbtn" onClick=${() => onStep(1)} disabled=${car == null || car >= (run.cars?.length ?? 0) - 1}
          aria-label="Next car">car ›</button>
        ${pinned && html`<button type="button" class="dt-navbtn dt-navbtn--on" onClick=${onFollow}>▸ follow the newest</button>`}
      </div>
    <//>
  `
}

/* ── A ticket ──────────────────────────────────────────────────────────────── */

/** The stamp a ticket gets: ORDER UP when exact, else what went wrong. */
function stampOf(t) {
  if (t.status === 'dropped') return { text: 'DROVE OFF', tone: 'warn' }
  if (t.exact) return { text: 'ORDER UP!', tone: 'ok' }
  const errs = t.errors ?? 0
  if (errs) return { text: `✕ ${errs} OFF`, tone: 'err' }
  if ((t.fouls ?? []).length) return { text: '✕ FOUL', tone: 'err' }
  return { text: '✕ CHECK IT', tone: 'err' }
}

/** The ticket one window printed for a car: a receipt that feeds out of its
 *  printer line by line, the least sure row highlighted and read back, then
 *  stamped. */
function Ticket({ run, lane, car }) {
  const t = car != null ? (lane.tickets ?? []).find((x) => x.car === car) : null
  const isJev = lane.kind === 'judgment'
  const gold = run.gold && car != null ? run.gold[car] : null
  const lc = `g-l${(lane.index % 4) + 1}`
  const busy = !t && lane.busy === car && car != null
  const head = html`
    <div class="dt-ticket__hd">
      <${LaneNum} i=${lane.index} />
      <span class="dt-ticket__who" title=${lane.key}>${lane.label}</span>
      <span class="spacer" />
      <span class="dt-ticket__ms">${t?.ms != null ? fmtMs(t.ms) : ''}</span>
    </div>
    <div class="dt-ticket__no">*** ${car != null ? `ORDER ${String(car + 1).padStart(2, '0')}` : 'ORDER'} ***</div>
  `
  const printer = html`<div class=${`dt-printer${busy ? ' is-busy' : ''}`} aria-hidden="true"><span class="dt-printer__led" /><span class="dt-printer__slot" /></div>`

  if (!t || t.status !== 'served') {
    const why = !t
      ? busy
        ? 'taking the order'
        : car != null && car < (run.cars?.length ?? 0)
          ? lane.status === 'error' || lane.status === 'stopped'
            ? 'this window has closed'
            : 'waiting in line'
          : ''
      : `drove off after ${fmtMs(t.waited_ms)} in line`
    const stamp = t ? stampOf(t) : null
    return html`
      <section class=${`dt-ticket ${lc}${t ? ' dt-ticket--dropped' : ' dt-ticket--empty'}`} aria-label=${`${lane.label}: no ticket for this car`}>
        ${printer}
        <div class="dt-paper dt-paper--stub" key=${`${car}:${t ? 'dropped' : busy ? 'busy' : 'none'}`}>
          ${head}
          <div class="dt-ticket__rule" />
          <p class=${`dt-ticket__none${t ? ' dt-t-warn' : ''}`}>
            ${busy ? html`<span class="dt-dots dt-dots--ink" aria-hidden="true"><i /><i /><i /></span> ${why}` : t ? `– ${why}` : why}
          </p>
          ${t && html`<p class="dt-total dt-t-warn"><span>TOTAL</span><span class="dt-total__lead" /><span class="tnum">${t.points} PTS</span></p>`}
          ${stamp && html`<span class=${`dt-stamp dt-stamp--${stamp.tone}`} aria-hidden="true">${stamp.text}</span>`}
        </div>
      </section>
    `
  }
  const rows = receiptRows(t, run)
  const marks = gold ? itemMarks(t.lines, gold) : null
  const alts = isJev ? altsText(t.least, !!run.cars?.[car]?.change) : ''
  const errs = t.errors ?? 0
  const fouls = (t.fouls ?? []).length
  const stamp = stampOf(t)
  let n = 0
  const at = () => ({ '--i': n++ })
  return html`
    <section class=${`dt-ticket ${lc} dt-ticket--${t.exact ? 'exact' : 'off'}`} aria-label=${`${lane.label}'s ticket for car ${car + 1}`}>
      ${printer}
      <div class="dt-paper" key=${`${car}:served`}>
        ${head}
        ${isJev && html`<div class="dt-ticket__sub">${t.questions} questions · ${t.requests === 1 ? 'one request' : `${t.requests} requests`}</div>`}
        <div class="dt-ticket__rule" />
        ${!rows.length && html`<p class="dt-ticket__none">nothing rung up</p>`}
        <ul class="dt-rows">
          ${rows.map((r, j) => {
            const mk = marks && r.kind === 'item' ? marks.get(r.item) : null
            const bad = mk === false || r.kind === 'foul'
            return html`
              <li key=${j} style=${at()} class=${`dt-row dt-row--${r.kind}${r.least ? ' dt-row--least' : ''}${bad ? ' dt-row--bad' : ''}`} title=${r.title ?? r.why}>
                <span class="dt-row__k">${r.kind === 'foul' ? html`<s>${r.text}</s>` : r.text}${r.kind === 'foul' ? html` <b class="dt-t-err">✕ foul</b>` : ''}${r.least && isJev && t.readback ? html` <b class="dt-row__q" title="least sure: read back">?</b>` : ''}</span>
                ${r.conf != null && html`<span class="dt-row__v tnum">${fmtProb(r.conf)}</span>`}
                ${mk != null && html`<span class=${`dt-row__mark ${mk ? 'dt-t-ok' : 'dt-t-err'}`}
                  title=${mk ? 'as ordered' : 'not as ordered'}>${mk ? '✓' : '✕'}</span>`}
              </li>
              ${r.least && alts && html`<li key=${`a${j}`} style=${at()} class="dt-row dt-row--alts">${alts}</li>`}
            `
          })}
        </ul>
        <div class="dt-ticket__rule" />
        ${isJev
          ? t.readback
            ? html`<div class="dt-readback" style=${at()}>
                <span class="dt-readback__k">◂ READ BACK · least sure <b class="tnum">${fmtProb(t.confidence)}</b> under ${Number(run.readback).toFixed(2)}</span>
                <strong class="dt-readback__q">“${t.readback}”</strong>
              </div>`
            : html`<p class="dt-readback dt-readback--none" style=${at()}>✓ sure of every part (least <b class="tnum">${fmtProb(t.confidence)}</b>): no read-back</p>`
          : html`<p class="dt-readback dt-readback--none" style=${at()}>a text model gives no confidence: nothing to read back</p>`}
        <p class=${`dt-total ${t.exact ? 'dt-t-ok' : t.points < 0 ? 'dt-t-err' : ''}`} style=${at()}>
          <span>TOTAL</span><span class="dt-total__lead" /><span class="tnum">${t.points > 0 ? '+' : ''}${t.points} PTS</span>
        </p>
        <p class="dt-ticket__why" style=${at()}>
          ${t.exact ? '✓ exact' : `${errs} item${errs === 1 ? '' : 's'} off`}${fouls ? ` · ${fouls} foul${fouls === 1 ? '' : 's'}` : ''}${t.off_right === false ? (t.off_menu ? ' · asked about nothing off the menu' : ' · missed the off-menu ask') : ''}
        </p>
        <span class=${`dt-stamp dt-stamp--${stamp.tone}`} style=${{ '--i': n }} aria-hidden="true">${stamp.text}</span>
      </div>
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

/* ── The calls, the menu ───────────────────────────────────────────────────── */

/** Call lines as a terminal prints them: coloured by part, one after another. */
function CallLines({ lines, class: cls }) {
  return html`
    <pre class=${`dt-code${cls ? ` ${cls}` : ''}`}>${lines.map(
      (line, j) => html`<span key=${j} class="dt-code__ln" style=${{ '--i': j }}>${callTokens(line).map(
        (tk, m) => (tk.k === 'space' || tk.k === 'word'
          ? tk.t
          : html`<span key=${m} class=${`dt-tk--${tk.k === 'comment' && /foul/.test(tk.t) ? 'foul' : tk.k}`}>${tk.t}</span>`),
      )}</span>`,
    )}</pre>
  `
}

/** The calls code makes from one window's ticket for the car in view. */
function Calls({ run, lane, car, ticket, onLane }) {
  const isJev = lane.kind === 'judgment'
  return html`
    <${Box} lane=${lane.index} class="dt-calls">
      <${Label}>THE CALLS CODE MAKES<//>
      ${run.lanes.length > 1 && html`
        <div class="dt-tabs" role="group" aria-label="Whose calls">
          ${run.lanes.map((ln) => html`
            <button key=${ln.index} type="button" class=${`dt-tab g-l${(ln.index % 4) + 1}${ln.index === lane.index ? ' dt-tab--on' : ''}`}
              aria-pressed=${ln.index === lane.index} onClick=${() => onLane(ln.index)}>
              <${LaneNum} i=${ln.index} /> ${ln.label}
            </button>
          `)}
        </div>
      `}
      ${ticket
        ? html`<div class="dt-term" key=${`${lane.index}:${car}`}><span class="dt-term__prompt" aria-hidden="true">till ▸ car ${car + 1}</span><${CallLines} lines=${callsOf(ticket)} /></div>`
        : html`<p class="g-muted dt-calls__none">No ticket from this window for this car yet.</p>`}
      <p class="dt-calls__why">
        ${isJev
          ? 'One request asks every argument as a closed question; code reads the answers and makes the calls. A call is only as sure as its least sure argument.'
          : 'The text model typed these lines itself; code only parsed them. A name that is not on the menu is a foul, and its line is dropped.'}
      </p>
    <//>
  `
}

/** The menu, as the windows were given it: a lit board, the items on the
 *  order in view glowing. */
function MenuBoard({ run, ticket, lane }) {
  const on = new Set((ticket?.lines ?? []).map((l) => l.item))
  return html`
    <section class=${`dt-menu g-l${((lane?.index ?? 0) % 4) + 1}`} aria-label="The menu">
      <div class="dt-menu__sign"><${PixelText} text="MENU" /><span class="dt-menu__note g-mono">${run.default_size} when no size is said</span></div>
      <ul class="dt-menu__list">
        ${(run.menu ?? []).map((it) => html`
          <li key=${it.id} class=${`dt-menu__row${on.has(it.id) ? ' is-on' : ''}`}>
            <span class="dt-menu__item">${it.id.replace(/_/g, ' ')}</span>
            <span class="dt-menu__opts">
              ${(it.sizes ?? []).map((s) => html`<span key=${s} class="dt-menu__size" title=${s}>${s[0].toUpperCase()}</span>`)}
              ${(it.mods ?? []).map((m) => html`<span key=${m} class="dt-menu__mod">${run.mods?.[m] ?? m}</span>`)}
            </span>
          </li>
        `)}
      </ul>
    </section>
  `
}

/* ── A window ──────────────────────────────────────────────────────────────── */

/** One window: its points, its lane of cars rolling up to the booth, a mark per
 *  car, the line's length over time, and its tally. */
function Window({ run, lane, car, live, lead, onPick }) {
  const cars = windowCars(run.cars, lane)
  const counts = windowCounts(cars)
  const L = queueLayout(cars, { width: 380 })
  const isJev = lane.kind === 'judgment'
  const fields = lane.fields_total ? lane.fields_right / lane.fields_total : NaN
  const label = `${lane.label}'s window: ${counts.served} served, ${counts.waiting} waiting, ${counts.dropped} drove off`
  const streak = streakOf(cars)
  const spark = sparkPath(lane.backlog, { width: 120, height: 26 })
  const last = [...cars].reverse().find((c) => c.status === 'exact' || c.status === 'served')
  // One keyed list, so a car slides from its place in line up to the window.
  const minis = [
    ...(last ? [{ key: `gone${last.i}`, x: L.window.x - L.car - 6, tone: 'gone' }] : []),
    ...L.waiting.map((w) => ({ key: w.i, x: w.x, tone: 'wait' })),
    ...(L.atWindow ? [{ key: L.atWindow.i, x: L.atWindow.x, tone: 'busy' }] : []),
  ]

  // Three exact orders in a row (and six, nine…) while you watch: confetti off the score.
  const scoreRef = useRef(null)
  const seen = useRef(streak)
  useEffect(() => {
    const was = seen.current
    seen.current = streak
    if (live && streak > was && streak % 3 === 0) {
      burstFrom(scoreRef.current, { colors: [LANE_COLORS[lane.index % 4], '#3ef5a0', '#ffe14d'], count: 30, power: 0.6 })
      sfx.coin()
    }
  }, [streak])

  return html`
    <${Box} lane=${lane.index} class=${`dt-window${lead ? ' dt-window--lead' : ''}`}>
      ${lead && html`<span class="dt-lead" key=${live ? 'l' : 'w'}><span aria-hidden="true">★</span> ${live ? 'leading' : 'winner'}</span>`}
      <${LaneHead} lane=${lane} />
      <div class="dt-window__row">
        <div class="dt-window__score" ref=${scoreRef}>
          <${Counter} value=${lane.score ?? 0} class="g-score" sound />
          <small>points</small>
        </div>
        <div class="dt-window__strip">
          <span class="dt-window__counts g-mono">
            <span class="dt-t-okl">${counts.served} served</span> · ${counts.waiting} waiting · <span class=${counts.dropped ? 'dt-t-warnl' : ''}>${counts.dropped} drove off</span>
          </span>
          <svg viewBox="0 0 380 46" role="img" aria-label=${label} class="dt-lanesvg">
            <rect x="0" y="30" width="380" height="16" class="dt-lanesvg__road" />
            <g class="dt-dashes">${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => html`<rect key=${n} x=${4 + n * 42} y="38" width="18" height="2" rx="1" />`)}</g>
            ${minis.map((m) => html`<${MiniCar} key=${m.key} x=${m.x} tone=${m.tone} />`)}
            <g class="dt-booth">
              <rect x=${L.window.x - 2} y="2" width=${L.window.w + 8} height="34" rx="3" class="dt-booth__wall" />
              <path d=${`M${L.window.x - 5} 8 H${L.window.x + L.window.w + 9} L${L.window.x + L.window.w + 6} 2 H${L.window.x - 2} Z`} class="dt-booth__awning" />
              <rect x=${L.window.x + 1} y="12" width=${L.window.w + 2} height="12" rx="1.5" class="dt-booth__pane" />
            </g>
            ${L.more > 0 && html`<text x="2" y="12" class="dt-more">+${L.more}</text>`}
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
        ${streak >= 2 && html`<span class="dt-streak" key=${`s${Math.floor(streak / 3)}`}><span aria-hidden="true">★</span> ${streak} exact in a row</span>`}
      </div>
      <div class="dt-window__stats">
        <${Stat} label="exact" value=${`${lane.exact ?? 0}/${counts.served}`} />
        <${Stat} label="fields right" value=${fmtPct(fields)} title="quantity, size and modifiers per item, and the off-menu ask" />
        ${isJev && html`<${Stat} label="read back" value=${lane.readbacks ?? 0} />`}
        <${Stat} label="drove off" value=${lane.dropped ?? 0} tone=${lane.dropped ? 'warn' : undefined} />
        ${spark.d && html`
          <div class="dt-spark" title=${`cars in line over time, most ${spark.max}`}>
            <span class="g-stat__k">line</span>
            <svg viewBox="0 0 120 26" aria-hidden="true"><path d=${`${spark.d} L118 24 L2 24 Z`} class="dt-spark__fill" /><path d=${spark.d} class="dt-spark__line" /></svg>
          </div>
        `}
      </div>
      <${LaneStats} lane=${lane} fouls=${!isJev} />
    <//>
  `
}

/** A small car in a window's lane: waiting, at the window (lit in the lane's
 *  colour), or pulling away once served. It slides as the line moves up. */
function MiniCar({ x, tone }) {
  return html`
    <g class=${`dt-mini dt-mini--${tone}`} style=${{ transform: `translate(${x}px, 14px)` }}>
      <g class="dt-mini__in">
        <path d="M1 16 L6 7 Q7 5 9 5 H22 Q24 5 25 6 L30 11 H33 Q36 11 36 14 V17 Q36 18 35 18 H2 Q1 18 1 17 Z" class="dt-mini__body" />
        <path d="M9 7 H16 V11 H7 Z M18 7 H23 L27 11 H18 Z" class="dt-mini__glass" />
        <circle cx="9" cy="18" r="3.4" class="dt-wheel" /><circle cx="28" cy="18" r="3.4" class="dt-wheel" />
        <rect x="33" y="12.5" width="3" height="2" rx="1" class="dt-mini__lamp" />
      </g>
    </g>
  `
}
