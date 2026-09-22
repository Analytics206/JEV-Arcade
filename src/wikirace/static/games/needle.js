/* Needle Hunt — find the line that answers the question, or say it isn't there.
 *
 * The server (games/needle.py) numbers the document's lines and asks every
 * lane every question; Jev answers each with one Choice over the lines and one
 * Noul, "is the answer in here at all?". This page is the visitor's side of the
 * race: the question, the whole document to hunt through (a click on a line,
 * or "not in here"), timed. Everything the players said stays sealed until the
 * visitor has answered that question; then the minimap lights up with Jev's
 * heat, the lines around its pick zoom in with their probabilities, the
 * existence dial swings, and each question's answer shows once every lane has
 * given its own.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { optionLabel } from '../state.js'
import { Button } from '../ui.js'
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
  fmtMs,
  html,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtProb, isRunLive, playersProblem } from './runstate.js'
import {
  BAND,
  BANDS,
  DIAL,
  NONE,
  POINTS,
  VERDICT,
  answerOf,
  around,
  band,
  dialBands,
  dialPoint,
  heatFor,
  heatStep,
  judgePick,
  lineAt,
  markOf,
  minimap,
  needleAngle,
  nextQuestion,
  signed,
  tallyOf,
} from './needle.logic.js'

export default function NeedleHunt({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── The visitor's answers, per run ────────────────────────────────────────── */

const STORE = 'wikirace.needle.v1'

function readStore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE) || '{}')
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

/** {k: {pick, ms} | {skipped}} for one run, remembered for the session. */
function useMine(runId) {
  const [mine, setMine] = useState(() => readStore()[runId] ?? {})
  useEffect(() => setMine(readStore()[runId] ?? {}), [runId])
  const set = (m) => {
    const s = readStore()
    const keep = Object.keys(s).slice(-40)
    const next = Object.fromEntries(keep.map((id) => [id, s[id]]))
    next[runId] = m
    try {
      sessionStorage.setItem(STORE, JSON.stringify(next))
    } catch {
      /* not remembered: the hunt still plays */
    }
    setMine(m)
  }
  return [mine, set]
}

const lineName = (pick) => (pick === NONE ? 'not in here' : pick ?? '—')

/* ── Setup ─────────────────────────────────────────────────────────────────── */

const COUNTS = [1, 3, 5, 8, 10, 12]

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [source, setSource] = useState('constitution')
  const [count, setCount] = useState(5)
  const [question, setQuestion] = useState('')
  const [title, setTitle] = useState('')
  const [asker, setAsker] = useState('')
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const texts = (models.data?.models ?? []).filter((m) => m.kind === 'text')
  const wiki = source === 'wikipedia'
  const problem = models.error
    ? models.error.message
    : wiki && !title.trim()
      ? 'Name the Wikipedia article to search.'
      : wiki && !question.trim() && !asker
        ? 'Type a question, or pick a model to write one.'
        : playersProblem(lanes, game, models.data?.models)
  const go = () =>
    start(lanes, wiki
      ? { source, title: title.trim(), question: question.trim() || null, asker: question.trim() ? null : asker || null }
      : { source, questions: count, question: question.trim() || null })

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="nh-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <fieldset class="nh-source">
            <legend class="g-label">THE DOCUMENT</legend>
            <label class="nh-radio"><input type="radio" name="nh-source" value="constitution" checked=${!wiki}
              onChange=${() => setSource('constitution')} /> The US Constitution <span class="g-muted">(115 lines, with an answer key)</span></label>
            <label class="nh-radio"><input type="radio" name="nh-source" value="wikipedia" checked=${wiki}
              onChange=${() => setSource('wikipedia')} /> A Wikipedia article <span class="g-muted">(no key: agreement only)</span></label>
          </fieldset>
          ${wiki
            ? html`
                <label class="g-field"><span>Article</span>
                  <input class="wr-in" type="text" value=${title} maxlength="250" placeholder="e.g. Mars"
                    onInput=${(e) => setTitle(e.currentTarget.value)} />
                </label>
                <label class="g-field"><span>Question</span>
                  <input class="wr-in" type="text" value=${question} maxlength="300" placeholder="what to find in it"
                    onInput=${(e) => setQuestion(e.currentTarget.value)} />
                </label>
                <label class="g-field"><span>Or a model asks it</span>
                  <select class="wr-sel" value=${asker} disabled=${!!question.trim()} onChange=${(e) => setAsker(e.currentTarget.value)}>
                    <option value="">— I'll type the question —</option>
                    ${texts.map((m) => html`<option key=${m.key} value=${m.key} disabled=${!m.available}>${optionLabel(m)}</option>`)}
                  </select>
                </label>`
            : html`
                <label class="g-field"><span>Questions</span>
                  <select class="wr-sel" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>
                    ${COUNTS.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
                  </select>
                </label>
                <label class="g-field"><span>Or your own question</span>
                  <input class="wr-in" type="text" value=${question} maxlength="300" placeholder="optional: not scored"
                    onInput=${(e) => setQuestion(e.currentTarget.value)} />
                </label>`}
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Start the hunt" />
        <//>
        <div class="nh-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              A question, and a document split into numbered lines. Find the line that answers it — or say it
              isn't in there, because some questions have no answer in the document at all.
            </p>
            <p class="g-explain">
              <b>Jev</b> is asked two questions in one request: a Choice over every line, and a yes/no, "does any
              line answer it?". That dial reads in bands: <b>answered</b> from 0.7, <b>partly</b> from 0.35, <b>not in here</b> below.
              A <b>text model</b> reads the numbered document and names a line, or
              NONE; a line that doesn't exist is a foul.
            </p>
            <p class="g-explain">
              <b>You</b> hunt on the page, against the clock. Everyone's answers stay sealed until you have given yours.
            </p>
            <div class="nh-rules">
              <${Chip} tone="ok">right line +2<//><${Chip} tone="warn">the line next door +1<//>
              <${Chip} tone="err">wrong −1<//><${Chip} tone="err">foul −1<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id}
            render=${(r) => html`<span class="g-mono g-muted">${r.doc?.name ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/* ── A hunt ────────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const [mine, setMine] = useMine(runId)
  const [view, setView] = useState(null)
  const [t0, setT0] = useState({})
  const [zoomAt, setZoomAt] = useState(null)
  const { busy, error: startError, start } = useStarter(game.id)
  const k = view ?? nextQuestion(run?.questions, mine)
  const played = mine?.[k]
  const open = !!run && !played
  const now = useNow(!!run && (isRunLive(run) || open), 100)

  useEffect(() => {
    setView(null)
    setT0({})
  }, [runId])
  useEffect(() => setZoomAt(null), [k])
  // The visitor's clock for a question starts when it is first on the screen.
  useEffect(() => {
    if (run && open && t0[k] == null) setT0((t) => ({ ...t, [k]: Date.now() }))
  }, [!!run, k, open])

  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const n = run.questions.length
  const tally = tallyOf(run, mine)
  const answer = (pick) => {
    if (!open) return
    setView(k)
    setMine({ ...mine, [k]: { pick, ms: Math.max(0, Date.now() - (t0[k] ?? Date.now())) } })
  }
  const skip = () => {
    setView(k)
    setMine({ ...mine, [k]: { skipped: true } })
  }
  const jump = (id) => {
    if (open) document.getElementById(`nh-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    else setZoomAt(id)
  }
  const fresh = () => start(run.lanes.map((l) => ({ key: l.key })), { ...run.params, seed: null })
  const yourMs = open ? (t0[k] ? now - t0[k] : 0) : played?.ms

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${fresh}>
        <span class="g-mono g-muted">${run.doc.name} · ${run.lines.length} lines${run.doc.cut ? ' (cut)' : ''} · question ${k + 1} of ${n}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${QuestionBar} run=${run} k=${k} mine=${mine} onView=${setView} />
      <div class="nh-stage">
        <${Minimap} run=${run} k=${k} open=${open} mine=${mine} onJump=${jump} />
        ${open
          ? html`<${Hunt} run=${run} onPick=${answer} />`
          : html`<${Zoom} run=${run} k=${k} mine=${mine} at=${zoomAt} />`}
        <${Dial} run=${run} k=${k} open=${open} />
      </div>
      <${Picks} run=${run} k=${k} mine=${mine} open=${open} yourMs=${yourMs} />
      <${TallyBar} run=${run} tally=${tally} k=${k} open=${open} onSkip=${skip}
        onNext=${() => setView(Math.min(n - 1, k + 1))} onFresh=${fresh} starting=${busy} startError=${startError} />
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${LaneTally} key=${ln.index} lane=${ln} mark=${tally.lanes[ln.index]}
          scored=${run.questions.some((x) => x.scored)} played=${tally.questions} />`)}
      </div>
    <//>
  `
}

/** The questions as chips, and the one being hunted in the FIND field. */
function QuestionBar({ run, k, mine, onView }) {
  const q = run.questions[k]
  const lines = run.lines
  return html`
    <div class="nh-qbar">
      ${run.questions.length > 1 && html`
        <div class="nh-qchips" role="group" aria-label="Questions">
          ${run.questions.map((x) => {
            const m = mine?.[x.k]
            const v = m && !m.skipped && x.revealed ? VERDICT[judgePick(m.pick, x.answer, lines)] : null
            const state = x.k === k ? ' nh-qchip--on' : m ? ' nh-qchip--done' : ''
            return html`<button key=${x.k} type="button" class=${`nh-qchip${state}${v ? ` nh-t-${v.tone}` : ''}`}
              aria-pressed=${x.k === k} aria-label=${`Question ${x.k + 1}${m ? (v ? `: ${v.label}` : ': answered') : ''}`}
              onClick=${() => onView(x.k)}>Q${x.k + 1}${v ? ` ${v.glyph}` : m ? ' ·' : ''}</button>`
          })}
        </div>`}
      <div class="nh-find">
        <label for="nh-q" class="g-label">FIND</label>
        <input id="nh-q" class="nh-find__q" type="text" readonly value=${q.text} />
        <span class="g-mono g-muted nh-find__in">in: ${run.doc.name}${q.scored ? '' : ' · no answer key'}</span>
      </div>
    </div>
  `
}

const MAP_W = 92
const MAP_H = 400

/** The document at a glance: one thin bar per line, heat-coloured by Jev's
 *  probability once the visitor has answered, the hottest line glowing. */
function Minimap({ run, k, open, mine, onJump }) {
  const lines = run.lines
  const h = useMemo(() => (open ? { heat: {}, source: null } : heatFor(run, k)), [open, run, k])
  const map = useMemo(() => minimap(lines, h.heat, { width: MAP_W, height: MAP_H }), [lines, h])
  const q = run.questions[k]
  const key = !open && q.revealed ? new Set(q.answer ?? []) : new Set()
  const yours = mine?.[k]?.pick
  const hot = map.bars.find((b) => b.id === map.hottest)
  const label = open
    ? `Map of the document's ${lines.length} lines; the heat is sealed until you answer. Click to scroll to a line.`
    : map.hottest
      ? `Map of the document's ${lines.length} lines, heat-coloured by ${h.source === 'jev' ? "Jev's probability" : 'the players’ picks'}; hottest ${map.hottest}`
      : `Map of the document's ${lines.length} lines`
  const click = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    onJump(lines[lineAt((e.clientY - box.top) / box.height, lines.length)].id)
  }
  return html`
    <${Box} class="nh-map">
      <svg viewBox=${`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label=${label} onClick=${click}>
        ${map.bars.map((b) => html`<rect key=${b.id} x="0" y=${b.y} width=${b.w} height=${b.h} rx=${b.h > 2 ? 1 : 0}
          class=${`nh-bar nh-heat-${heatStep(b.heat)}`} />`)}
        ${hot && html`<rect class="nh-bar nh-bar--hot" x="0" y=${hot.y} width=${hot.w} height=${Math.max(hot.h, 2.2)} rx="1" />`}
        ${map.bars.filter((b) => key.has(b.id)).map((b) => html`
          <path key=${`k${b.id}`} class="nh-mark nh-mark--key" d=${`M${MAP_W} ${b.y + b.h / 2} l-6 -4 v8 z`} />`)}
        ${yours && yours !== NONE && map.bars.filter((b) => b.id === yours).map((b) => html`
          <path key="you" class="nh-mark nh-mark--you" d=${`M0 ${b.y + b.h / 2} l6 -4 v8 z`} />`)}
      </svg>
      <span class="nh-map__note g-mono">${open ? 'heat sealed' : h.source === 'jev' ? 'heat: Jev' : h.source ? 'heat: picks' : ''}</span>
    <//>
  `
}

/** The whole document to hunt through: every line a button, and "not in here". */
function Hunt({ run, onPick }) {
  const lines = run.lines
  return html`
    <${Box} class="nh-center">
      <div class="nh-center__hd">
        <${Label} note=${`${lines.length} lines · click the one that answers it`}>THE DOCUMENT<//>
        <span class="spacer" />
        <${Button} variant="secondary" size="sm" onClick=${() => onPick(NONE)}>It's not in here<//>
      </div>
      <ol class="nh-doc scroll-y">
        ${lines.map((ln, i) => html`
          <li key=${ln.id}>
            ${(i === 0 || lines[i - 1].s !== ln.s) && html`<span class="nh-doc__sec">${run.doc.sections[ln.s]}</span>`}
            <button type="button" id=${`nh-${ln.id}`} class="nh-line" onClick=${() => onPick(ln.id)}>
              <span class="nh-line__id">${ln.id}</span><span class="nh-line__t">${ln.text}</span>
            </button>
          </li>`)}
      </ol>
    <//>
  `
}

/** After the visitor has answered: the lines around Jev's pick with its
 *  probabilities, and wherever else the answer or the visitor's pick lies. */
function Zoom({ run, k, mine, at }) {
  const lines = run.lines
  const q = run.questions[k]
  const h = heatFor(run, k)
  const jev = h.answer
  const key = q.revealed ? q.answer ?? [] : null
  const yours = mine?.[k]?.pick
  const center = at ?? jev?.top ?? key?.[0] ?? (yours !== NONE ? yours : null) ?? lines[0].id
  const shown = around(lines, center, 2)
  const ids = new Set(shown.map((l) => l.id))
  const extra = [
    ...(key ?? []).filter((id) => !ids.has(id)).map((id) => ({ id, why: 'THE ANSWER' })),
    ...(yours && yours !== NONE && !ids.has(yours) && !(key ?? []).includes(yours) ? [{ id: yours, why: 'YOUR PICK' }] : []),
  ]
  const byId = new Map(lines.map((l) => [l.id, l]))
  const pickers = (id) => run.lanes.filter((ln) => answerOf(ln, k)?.pick === id)
  const row = (ln) => {
    const p = h.source === 'jev' ? h.heat[ln.id] ?? 0 : null
    const isTop = jev?.top === ln.id
    const isKey = key?.includes(ln.id)
    const cls = `nh-row${isTop ? ' nh-row--top' : ''}${isKey ? ' nh-row--key' : ''}${yours === ln.id ? ' nh-row--mine' : ''}`
    return html`
      <div key=${ln.id} class=${cls}>
        <span class="nh-row__id g-mono">${ln.id}</span>
        <span class="nh-row__t">${ln.text}
          <span class="nh-row__tags">
            ${isKey && html`<span class="nh-tag nh-t-ok">✓ answer</span>`}
            ${yours === ln.id && html`<span class="nh-tag nh-tag--you">you</span>`}
            ${pickers(ln.id).map((pl) => html`<${LaneNum} key=${pl.index} i=${pl.index} />`)}
          </span>
        </span>
        <span class="nh-row__p g-mono">${p == null ? '' : fmtProb(p)}</span>
      </div>
    `
  }
  const where = run.doc.sections[byId.get(center)?.s] ?? ''
  return html`
    <${Box} class="nh-center">
      <${Label} note=${where}>${at ? 'AROUND THE LINE YOU CHOSE ON THE MAP' : jev ? 'WHERE JEV POINTS' : 'AROUND THE PICK'}<//>
      <div class="nh-zoom">${shown.map(row)}</div>
      ${jev?.pick === NONE && html`<p class="nh-note g-mono">Jev's closest line, but its dial says the answer isn't in here.</p>`}
      ${key && !key.length && html`<p class="nh-note nh-t-ok g-mono">✓ The answer is not in this document.</p>`}
      ${!key && q.scored && html`<p class="nh-note g-mono g-muted">The answer shows once every player has given one.</p>`}
      ${extra.map((x) => html`
        <div key=${`x${x.id}`} class="nh-extra">
          <span class="g-stat__k">${x.why} · ${run.doc.sections[byId.get(x.id)?.s] ?? ''}</span>
          ${row(byId.get(x.id))}
        </div>`)}
      <span class="nh-grow" />
      <p class="g-mono g-muted nh-note">
        ${run.doc.windowed
          ? 'two requests: a choice over windows of 40 lines, then one over the window’s lines + one yes/no'
          : `one choice over every line id (${lines.length}) + one yes/no, same request`}
      </p>
    <//>
  `
}

/** The existence dial: a half-circle gauge in three bands, and Jev's needle. */
function Dial({ run, k, open }) {
  const bands = run.bands ?? BANDS
  const a = heatFor(run, k).answer
  const p = a?.exists
  const b = Number.isFinite(p) ? band(p, bands) : null
  const tone = b ? BAND[b].tone : 'dim'
  const len = DIAL.r - 8
  const ticks = [bands.partly, bands.answered].map((t) => [dialPoint(t, DIAL.r - 10), dialPoint(t, DIAL.r + 10)])
  const label = open
    ? 'The existence dial, sealed until you answer'
    : b
      ? `The existence dial at ${fmtProb(p)}: ${BAND[b].label}`
      : 'The existence dial: no Jev reading for this question'
  return html`
    <${Box} class="nh-dial">
      <${Label}>IS IT IN HERE AT ALL?<//>
      <svg viewBox=${`0 0 ${DIAL.width} ${DIAL.height}`} role="img" aria-label=${label}>
        ${dialBands(bands).map((x) => html`<path key=${x.band}
          class=${`nh-arc nh-arc--${x.band}${open ? ' nh-arc--sealed' : b === x.band ? ' nh-arc--on' : ''}`} d=${x.d} />`)}
        ${ticks.map(([[x1, y1], [x2, y2]], i) => html`<line key=${i} class="nh-tick" x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`)}
        ${!open && Number.isFinite(p) && html`
          <line key=${`n${k}`} class="nh-needle" x1=${DIAL.cx} y1=${DIAL.cy} x2=${DIAL.cx - len} y2=${DIAL.cy}
            style=${{ transform: `rotate(${needleAngle(p)}deg)` }} />`}
        <circle class="nh-hub" cx=${DIAL.cx} cy=${DIAL.cy} r="6" />
        ${open && html`<text class="nh-dial__q" x=${DIAL.cx} y=${DIAL.cy - 22}>?</text>`}
      </svg>
      <span class=${`nh-dial__v g-mono nh-t-${open ? 'dim' : tone}`}>${open ? 'sealed' : Number.isFinite(p) ? fmtProb(p) : '—'}</span>
      <span class="nh-dial__band">${open ? 'until you answer' : b ? BAND[b].label : 'no Jev in this game'}</span>
      <ul class="nh-legend">
        <li><i class="nh-sw nh-sw--answered" aria-hidden="true" />answered · ${bands.answered} and up</li>
        <li><i class="nh-sw nh-sw--partly" aria-hidden="true" />partly · ${bands.partly} to ${bands.answered}</li>
        <li><i class="nh-sw nh-sw--absent" aria-hidden="true" />not in here · under ${bands.partly}</li>
      </ul>
    <//>
  `
}

/** Everyone's line for this question, and how long each took. */
function Picks({ run, k, mine, open, yourMs }) {
  const q = run.questions[k]
  const played = mine?.[k]
  const lines = run.lines
  const jev = heatFor(run, k).answer
  const yourKey = q.scored && played && !played.skipped && q.revealed ? judgePick(played.pick, q.answer, lines) : null
  const yourV = yourKey ? VERDICT[yourKey] : null
  return html`
    <${Box} class="nh-picks">
      <ul class="nh-picks__list">
        ${run.lanes.map((ln) => {
          const a = answerOf(ln, k)
          const m = markOf(ln, k)
          const v = m && m.verdict !== 'unscored' ? VERDICT[m.verdict] : null
          let what
          if (!a) what = html`<span class="g-muted">${ln.status === 'error' ? 'could not answer' : ln.status === 'rate_limited' ? 'waiting out a rate limit…' : 'hunting…'}</span>`
          else if (open) what = html`<span class="g-muted">answered in ${fmtMs(a.ms)} · sealed</span>`
          else what = html`
            <span class=${`nh-picks__line${a.foul ? ' nh-t-err' : ''}`}>${a.foul ? `“${a.said || '—'}” is no line` : lineName(a.pick)}</span>
            <span class="g-muted">in ${fmtMs(a.ms)}</span>
            ${Number.isFinite(a.exists) && html`<span class=${`nh-t-${BAND[a.band].tone}`}>dial ${fmtProb(a.exists)}</span>`}
            ${v && html`<span class=${`nh-t-${v.tone}`}>${v.glyph} ${v.label} ${signed(m.points)}</span>`}
            ${!v && !q.scored && jev && a !== jev && html`<span class="g-muted">${a.pick === jev.pick ? 'agrees with Jev' : 'differs from Jev'}</span>`}
            ${a.reason && html`<q class="nh-picks__why">${a.reason}</q>`}`
          return html`<li key=${ln.index} class=${`nh-picks__row g-l${(ln.index % 4) + 1}`}>
            <${LaneNum} i=${ln.index} /><b class="nh-picks__who">${ln.label}</b>${what}</li>`
        })}
        <li class="nh-picks__row nh-picks__row--you">
          <span class="nh-you" aria-hidden="true">you</span><b class="nh-picks__who">You</b>
          ${open
            ? html`<span class="g-muted" aria-live="off">still hunting, ${fmtMs(yourMs)}</span>`
            : played.skipped
              ? html`<span class="g-muted">asked to be shown</span>`
              : html`
                  <span class="nh-picks__line">${lineName(played.pick)}</span><span class="g-muted">in ${fmtMs(yourMs)}</span>
                  ${yourV
                    ? html`<span class=${`nh-t-${yourV.tone}`}>${yourV.glyph} ${yourV.label} ${signed(POINTS[yourKey])}</span>`
                    : !q.scored && jev
                      ? html`<span class="g-muted">${played.pick === jev.pick ? 'agrees with Jev' : 'differs from Jev'}</span>`
                      : html`<span class="g-muted">the answer shows once every player has given one</span>`}`}
        </li>
      </ul>
    <//>
  `
}

/** The tally over the questions played, and what comes next. */
function TallyBar({ run, tally: t, k, open, onSkip, onNext, onFresh, starting, startError }) {
  const n = run.questions.length
  const last = k >= n - 1
  return html`
    <${Box} class="nh-bar">
      ${open && html`<${Button} variant="ghost" size="sm" onClick=${onSkip}>Show me<//>`}
      <span class="g-mono g-muted nh-bar__hint">
        ${open ? 'some questions have no answer here: the dial is the trap' : t.scored ? '' : 'no answer key for a typed question: see who agrees'}
      </span>
      <span class="spacer" />
      ${t.questions > 0 && t.scored && html`
        <div class="nh-tally">
          <${Label}>AFTER ${t.questions} QUESTION${t.questions === 1 ? '' : 'S'}<//>
          <span class="g-mono">You ${signed(t.you.points)}${t.you.ms ? ` · ${fmtMs(t.you.ms)} each` : ''}</span>
          ${t.lanes.map((ln) => html`<span key=${ln.index} class=${`g-mono nh-tally__lane g-l${(ln.index % 4) + 1}`}>
            <i class="nh-sw nh-sw--lane" aria-hidden="true" />${ln.label} ${signed(ln.points)}</span>`)}
        </div>`}
      ${!open && !last && html`<${Button} variant="primary" onClick=${onNext}>Next question<//>`}
      ${!open && last && html`<${Button} variant="primary" onClick=${onFresh} disabled=${starting || isRunLive(run)}>
        ${starting ? 'Starting…' : 'New questions'}<//>`}
    <//>
    ${startError && html`<p class="g-t-err nh-starterr">${startError}</p>`}
  `
}

/** A lane's card: its points and how its answers went, over the questions
 *  the visitor has played (the rest stay sealed). */
function LaneTally({ lane, mark, scored, played }) {
  const m = mark ?? { points: 0, right: 0, near: 0, wrong: 0 }
  return html`
    <${Box} lane=${lane.index} class="nh-lane">
      <${LaneHead} lane=${lane} />
      <div class="nh-lane__row">
        <div class="nh-lane__score"><span class="tnum">${scored ? signed(m.points) : '–'}</span><small>points</small></div>
        <div class="g-stats nh-lane__stats">
          <${Stat} label="answered" value=${lane.answered ?? 0} />
          <${Stat} label="right" value=${m.right} tone=${m.right ? 'ok' : undefined} />
          <${Stat} label="next door" value=${m.near} />
          <${Stat} label="wrong" value=${m.wrong} tone=${m.wrong ? 'err' : undefined} />
        </div>
      </div>
      <p class="g-mono g-muted nh-lane__note">
        ${scored ? `over the ${played} question${played === 1 ? '' : 's'} you have played and every player has answered` : 'a typed question has no answer key'}
      </p>
      <${LaneStats} lane=${lane} />
    <//>
  `
}
