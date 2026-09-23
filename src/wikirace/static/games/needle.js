/* Needle Hunt — find the line that answers the question, or say it isn't there.
 *
 * The server (games/needle.py) numbers the document's lines and asks every
 * lane every question; Jev answers each with one Choice over the lines and one
 * Noul, "is the answer in here at all?". This page is the visitor's side of the
 * race, drawn as a document scanner: the question in the FIND field, the whole
 * document to hunt through (a click on a line, or "not in here"), timed, while
 * the scanner's beam idles down the minimap. Everything the players said stays
 * sealed until the visitor has answered that question; then the beam sweeps
 * the heat on, the scanner locks onto the lines around Jev's pick, each
 * player's pick is stamped beside its line with how it went, the existence
 * dial swings, and the match scoreboard fills in, question by question.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Finale } from '../fx.js'
import { optionLabel } from '../state.js'
import { Button } from '../ui.js'
import { SCENES } from './attract.js'
import {
  Box,
  Counter,
  GameFrame,
  LANE_COLORS,
  Label,
  LaneHead,
  LaneNum,
  LaneStats,
  NEON,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  Stat,
  burstFrom,
  fmtMs,
  html,
  sfx,
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
  matchOf,
  minimap,
  needleAngle,
  nextQuestion,
  signed,
} from './needle.logic.js'

export default function NeedleHunt({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
/** A whole number as a scoreboard writes it (Counter adds its own sign to the change). */
const num = (x) => {
  const r = Math.round(x)
  return r < 0 ? `−${-r}` : String(r)
}
/** The existence dial's bands, with a glyph each so they read without colour. */
const BAND_GLYPH = { answered: '✓', partly: '≈', absent: '∅' }

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

/** Calls `onFresh(added)` for keys that were not there before: what just
 *  happened in front of you, never what a replay opened with. */
function useOnFresh(keys, onFresh, ready = true) {
  const seen = useRef(null)
  const sig = keys.join('|')
  useEffect(() => {
    if (!ready) return
    const prev = seen.current
    seen.current = new Set(keys)
    if (!prev) return
    const added = keys.filter((k) => !prev.has(k))
    if (added.length) onFresh(added)
  }, [sig, ready])
}

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
            <label class=${`nh-radio${wiki ? '' : ' nh-radio--on'}`}><input type="radio" name="nh-source" value="constitution" checked=${!wiki}
              onChange=${() => setSource('constitution')} /> <span>The US Constitution <span class="g-muted">(115 lines, with an answer key)</span></span></label>
            <label class=${`nh-radio${wiki ? ' nh-radio--on' : ''}`}><input type="radio" name="nh-source" value="wikipedia" checked=${wiki}
              onChange=${() => setSource('wikipedia')} /> <span>A Wikipedia article <span class="g-muted">(no key: agreement only)</span></span></label>
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
          <${Box} class="nh-howto">
            <${Label}>HOW IT'S PLAYED<//>
            <div class="nh-howto__grid">
              <${Screen} />
              <div class="nh-howto__text">
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
              </div>
            </div>
          <//>
          <div class="nh-side__row">
            <${PayTable} />
            <${DialKey} bands=${BANDS} />
          </div>
          <${RecentRuns} gameId=${game.id}
            render=${(r) => html`<span class="g-mono g-muted">${r.doc?.name ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The cabinet's own attract loop, as a little screen (still under reduced motion). */
function Screen() {
  const ref = useRef(null)
  useEffect(() => {
    const svg = ref.current?.querySelector('svg')
    if (svg?.pauseAnimations && calm()) svg.pauseAnimations()
  }, [])
  return html`<div class="nh-screen" ref=${ref}>${SCENES.needle('nhsetup')}</div>`
}

/** What each answer is worth, as the machine's pay table. */
function PayTable() {
  const rows = [
    ['right', 'the answer line', 'or NONE when there is none'],
    ['near', 'the line next door', 'just before or after, same section'],
    ['wrong', 'a wrong line', 'or NONE when there is one'],
    ['foul', 'a line that does not exist', 'text models only'],
  ]
  return html`
    <${Box} class="nh-pay">
      <${Label}>PAY TABLE<//>
      <ol class="nh-pay__list">
        ${rows.map(([v, what, note]) => html`
          <li key=${v} class=${`nh-pay__row nh-pay__row--${VERDICT[v].tone}`}>
            <span class="nh-pay__g" aria-hidden="true">${VERDICT[v].glyph}</span>
            <span class="nh-pay__k">${what}<small>${note}</small></span>
            <b class="nh-pay__v tnum">${signed(POINTS[v])}</b>
          </li>`)}
      </ol>
    <//>
  `
}

/** The existence dial's bands, as a key. */
function DialKey({ bands }) {
  return html`
    <${Box} class="nh-dialkey">
      <${Label}>IS IT IN HERE AT ALL?<//>
      <p class="g-explain">Jev's yes/no reads in three bands. Under ${bands.partly}, its pick is NONE whatever its top line.</p>
      <ul class="nh-legend">
        <li><i class="nh-sw nh-sw--answered" aria-hidden="true" /><b>${BAND_GLYPH.answered}</b> answered · ${bands.answered} and up</li>
        <li><i class="nh-sw nh-sw--partly" aria-hidden="true" /><b>${BAND_GLYPH.partly}</b> partly · ${bands.partly} to ${bands.answered}</li>
        <li><i class="nh-sw nh-sw--absent" aria-hidden="true" /><b>${BAND_GLYPH.absent}</b> not in here · under ${bands.partly}</li>
      </ul>
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
  const [myEnd, setMyEnd] = useState(false)
  const { busy, error: startError, start } = useStarter(game.id)
  const k = view ?? nextQuestion(run?.questions, mine)
  const played = mine?.[k]
  const open = !!run && !played
  const now = useNow(!!run && (isRunLive(run) || open), 100)
  const match = useMemo(() => (run ? matchOf(run, mine) : null), [run, mine])
  const finished = !!run && !isRunLive(run) && run.status === 'finished'

  useEffect(() => {
    setView(null)
    setT0({})
    setMyEnd(false)
  }, [runId])
  useEffect(() => setZoomAt(null), [k])
  // The visitor's clock for a question starts when it is first on the screen.
  useEffect(() => {
    if (run && open && t0[k] == null) setT0((t) => ({ ...t, [k]: Date.now() }))
  }, [!!run, k, open])

  // A verdict of the visitor's own, just revealed: confetti for a right one.
  const mineOut = (match?.you.cells ?? []).map((c, i) => (VERDICT[c.state] && c.state !== 'unscored' ? `${i}:${c.state}` : null)).filter(Boolean)
  useOnFresh(mineOut, (added) => {
    if (!added.some((x) => x.endsWith(':right'))) return
    setTimeout(() => burstFrom(document.getElementById('nh-card-you'), { colors: ['#b6ff3e', '#3ef5a0', '#ffffff'], count: 40, power: 0.65 }), 450)
  }, !!run)
  // The match over in front of you, after the run: the visitor's last answer
  // decides it, so the finale is this page's (the run bar's played when the
  // run ended, while the visitor was still hunting).
  const over = !!match && match.done && finished
  const was = useRef(null)
  useEffect(() => {
    if (!run) return
    const prev = was.current
    was.current = { over, finished }
    if (prev && prev.finished && !prev.over && over) setMyEnd(true)
  }, [!!run, over, finished])

  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const n = run.questions.length
  const answer = (pick) => {
    if (!open) return
    sfx.select()
    setView(k)
    setMine({ ...mine, [k]: { pick, ms: Math.max(0, Date.now() - (t0[k] ?? Date.now())) } })
  }
  const skip = () => {
    sfx.hover()
    setView(k)
    setMine({ ...mine, [k]: { skipped: true } })
  }
  const jump = (id) => {
    if (open) document.getElementById(`nh-${id}`)?.scrollIntoView({ block: 'center', behavior: calm() ? 'auto' : 'smooth' })
    else setZoomAt(id)
  }
  const fresh = () => start(run.lanes.map((l) => ({ key: l.key })), { ...run.params, seed: null })
  const yourMs = open ? (t0[k] ? now - t0[k] : 0) : played?.ms
  const fin = finaleOf(run, match)

  return html`
    <${GameFrame} game=${game} class="nh-page">
      <${RunBar} run=${run} now=${now} onAgain=${fresh} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub} win=${!fin.quiet}>
        <span class="g-mono g-muted">${run.doc.name} · ${run.lines.length} lines${run.doc.cut ? ' (cut)' : ''} · question ${k + 1} of ${n}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${QuestionBar} run=${run} k=${k} mine=${mine} match=${match} open=${open} onView=${setView} />
      <div class=${`nh-stage${open ? ' nh-stage--open' : ''}`}>
        <${Minimap} run=${run} k=${k} open=${open} mine=${mine} onJump=${jump} />
        ${open
          ? html`<${Hunt} run=${run} onPick=${answer} yourMs=${yourMs} />`
          : html`<${Zoom} run=${run} k=${k} mine=${mine} at=${zoomAt} />`}
        <${Dial} run=${run} k=${k} open=${open} />
      </div>
      <${Picks} run=${run} k=${k} mine=${mine} open=${open} yourMs=${yourMs} />
      <${Match} run=${run} match=${match} k=${k} open=${open} onSkip=${skip} onView=${setView}
        onNext=${() => { sfx.select(); setView(Math.min(n - 1, k + 1)) }} onFresh=${fresh} starting=${busy} startError=${startError} />
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${LaneTally} key=${ln.index} lane=${ln} mark=${match.tally.lanes[ln.index]}
          scored=${run.questions.some((x) => x.scored)} played=${match.tally.questions} />`)}
      </div>
      <${Finale} show=${myEnd} headline=${fin.headline} sub=${fin.sub} colors=${fin.colors} onClose=${() => setMyEnd(false)} />
    <//>
  `
}

/** Who won, as the run bar and the finale say it. The match is the visitor's
 *  as much as the lanes': until every question has been played (and every
 *  answer is out), nobody has won, and the players' picks stay sealed. */
function finaleOf(run, match) {
  if (isRunLive(run) || run.status !== 'finished' || !match) return {}
  if (!match.done) {
    return { headline: 'YOUR TURN', sub: 'Every player has answered. Their picks stay sealed until you give yours.', quiet: true }
  }
  if (!match.scored) return { headline: 'ALL ANSWERS IN', sub: 'A typed question has no answer key: see who agrees with whom.', quiet: true }
  const { lanes, you, best } = match.leaders
  const won = lanes.map((i) => run.lanes[i]).filter(Boolean)
  const who = [...(you ? ['You'] : []), ...won.map((l) => l.label)]
  const each = who.length > 1 ? ' each' : ''
  const sub = `${who.join(' · ')} · ${signed(best)} point${Math.abs(best) === 1 ? '' : 's'}${each}`
  const colors = won.length ? [...won.map((l) => LANE_COLORS[l.index % 4]), '#b6ff3e'] : NEON
  if (you && !won.length) return { headline: 'YOU WIN!', sub, colors }
  if (who.length > 1) return { winners: lanes, headline: 'TIE GAME!', sub, colors }
  return { winners: lanes, headline: `PLAYER ${won[0].index + 1} WINS!`, sub, colors }
}

/** The questions as cartridges, and the one being hunted in the FIND field. */
function QuestionBar({ run, k, mine, match, open, onView }) {
  const q = run.questions[k]
  return html`
    <div class="nh-qbar">
      ${run.questions.length > 1 && html`
        <div class="nh-qchips" role="group" aria-label="Questions">
          ${run.questions.map((x) => {
            const m = mine?.[x.k]
            const c = match.you.cells[x.k]
            const v = VERDICT[c.state] && c.state !== 'unscored' ? VERDICT[c.state] : null
            const state = x.k === k ? ' nh-qchip--on' : m ? ' nh-qchip--done' : ''
            return html`<button key=${x.k} type="button" class=${`nh-qchip${state}${v ? ` nh-qchip--${v.tone}` : ''}`}
              aria-pressed=${x.k === k} aria-label=${`Question ${x.k + 1}${m ? (v ? `: ${v.label}` : m.skipped ? ': shown' : ': answered') : ''}`}
              onClick=${() => { sfx.select(); onView(x.k) }}>
              <span class="nh-qchip__n">Q${x.k + 1}</span><span class="nh-qchip__g" aria-hidden="true">${v ? v.glyph : m ? (m.skipped ? '›' : '·') : ''}</span></button>`
          })}
        </div>`}
      <div class=${`nh-find${open ? ' nh-find--open' : ''}`}>
        <label for="nh-q" class="nh-find__k"><span aria-hidden="true">▸</span> FIND</label>
        <div class="nh-find__box">
          <input id="nh-q" class="nh-find__q" type="text" readonly value=${q.text} />
          <span class="nh-find__scan" aria-hidden="true" />
        </div>
        <span class="g-mono g-muted nh-find__in">in: ${run.doc.name}${q.scored ? '' : ' · no answer key'}</span>
      </div>
    </div>
  `
}

const MAP_W = 92
const MAP_H = 400
/** Room at the map's right for the answer's mark and the players' tags. */
const GUTTER = 24

/** The document at a glance, as a scanner strip: one thin bar per line. While
 *  the visitor hunts, the beam idles over it and the heat is sealed; once they
 *  answer, one sweep lights Jev's heat, the answer is marked, and every
 *  player's pick is tagged on its line. */
function Minimap({ run, k, open, mine, onJump }) {
  const lines = run.lines
  const h = useMemo(() => (open ? { heat: {}, source: null } : heatFor(run, k)), [open, run, k])
  const map = useMemo(() => minimap(lines, h.heat, { width: MAP_W, height: MAP_H }), [lines, h])
  const q = run.questions[k]
  const key = !open && q.revealed ? new Set(q.answer ?? []) : new Set()
  const yours = mine?.[k]?.pick
  const hot = map.bars.find((b) => b.id === map.hottest)
  const byId = new Map(map.bars.map((b) => [b.id, b]))
  const tags = []
  if (!open) {
    const at = new Map()
    for (const ln of run.lanes) {
      const a = answerOf(ln, k)
      const b = a?.pick && a.pick !== NONE ? byId.get(a.pick) : null
      if (!b) continue
      const j = at.get(b.id) ?? 0
      at.set(b.id, j + 1)
      tags.push({ lane: ln.index, b, j })
    }
  }
  const label = open
    ? `Map of the document's ${lines.length} lines; the heat is sealed until you answer. Click to scroll to a line.`
    : map.hottest
      ? `Map of the document's ${lines.length} lines, heat-coloured by ${h.source === 'jev' ? "Jev's probability" : 'the players’ picks'}; hottest ${map.hottest}`
      : `Map of the document's ${lines.length} lines`
  const click = (e) => {
    const box = e.currentTarget.getBoundingClientRect()
    onJump(lines[lineAt((e.clientY - box.top) / box.height, lines.length)].id)
  }
  const W = MAP_W + GUTTER
  return html`
    <${Box} class="nh-map">
      <span class="nh-map__k g-mono">SCAN</span>
      <div class="nh-map__frame">
        <svg viewBox=${`0 0 ${W} ${MAP_H}`} role="img" aria-label=${label} onClick=${click}>
          <rect x="0" y="0" width=${MAP_W} height=${MAP_H} class="nh-map__bed" />
          <g key=${open ? 'sealed' : `heat-${k}`} class=${open ? '' : 'nh-mbars--in'}>
            ${map.bars.map((b) => html`<rect key=${b.id} x="0" y=${b.y} width=${b.w} height=${b.h} rx=${b.h > 2 ? 1 : 0}
              class=${`nh-mbar nh-heat-${heatStep(b.heat)}${b.heat > 0 ? ' nh-mbar--h' : ''}`} style=${open || !b.heat ? undefined : { animationDelay: `${Math.round(b.y * 1.2)}ms` }} />`)}
          </g>
          ${hot && html`<rect key=${`hot-${k}`} class="nh-mbar--hot" x="-1" y=${hot.y - 0.6} width=${hot.w + 2} height=${Math.max(hot.h, 2.2) + 1.2} rx="1.5" />`}
          ${map.bars.filter((b) => key.has(b.id)).map((b) => html`
            <path key=${`k${b.id}`} class="nh-mark nh-mark--key" d=${`M${MAP_W + 1} ${b.y + b.h / 2} l7 -5 v10 z`} />`)}
          ${tags.map(({ lane, b, j }) => html`
            <g key=${`t${lane}`} class=${`nh-tag g-l${(lane % 4) + 1}`} transform=${`translate(${MAP_W + 9 + (j % 2) * 8} ${b.y + b.h / 2 - 4 + Math.floor(j / 2) * 9})`}>
              <rect width="8" height="8" rx="1.5" /><text x="4" y="6.6">${lane + 1}</text>
            </g>`)}
          ${yours && yours !== NONE && byId.get(yours) && html`
            <path key="you" class="nh-mark nh-mark--you" d=${`M0 ${byId.get(yours).y + byId.get(yours).h / 2} l6 -4 v8 z`} />`}
        </svg>
        <span key=${open ? 'idle' : `sweep-${k}`} class=${`nh-beam${open ? ' nh-beam--idle' : ' nh-beam--once'}`} aria-hidden="true" />
      </div>
      <span class="nh-map__note g-mono">${open ? '■ heat sealed' : h.source === 'jev' ? 'heat: Jev' : h.source ? 'heat: picks' : ''}</span>
    <//>
  `
}

/** The whole document to hunt through: every line a button, and "not in here". */
function Hunt({ run, onPick, yourMs }) {
  const lines = run.lines
  return html`
    <${Box} class="nh-center nh-hunt">
      <div class="nh-center__hd">
        <${Label} note=${`${lines.length} lines · click the one that answers it`}>THE DOCUMENT<//>
        <span class="spacer" />
        <span class="nh-clock g-mono" aria-hidden="true">${fmtMs(yourMs)}</span>
        <button type="button" class="nh-none" onClick=${() => onPick(NONE)}><span aria-hidden="true">∅</span> It's not in here</button>
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

/** One player's pick, stamped: the lane (or you) and, once the key is out, how it went. */
function Stamp({ who, verdict, points, i = 0 }) {
  const v = verdict && verdict !== 'unscored' ? VERDICT[verdict] : null
  return html`
    <span class=${`nh-stamp nh-stamp--${v ? v.tone : 'plain'}`} style=${{ '--i': i }}
      title=${v ? `${v.label} ${signed(points)}` : 'picked this line'}>
      ${who === 'you' ? html`<span class="nh-you" aria-hidden="true">YOU</span>` : html`<${LaneNum} i=${who} />`}
      ${v && html`<span aria-hidden="true">${v.glyph} ${signed(points)}</span>`}
      <span class="sr-only"> ${who === 'you' ? 'you' : `player ${who + 1}`}${v ? `: ${v.label}, ${signed(points)}` : ''}</span>
    </span>
  `
}

/** After the visitor has answered: the scanner locks onto the lines around
 *  Jev's pick, with its probabilities as heat, and every player's pick is
 *  stamped where it landed (the answer and anything else, below). */
function Zoom({ run, k, mine, at }) {
  const lines = run.lines
  const q = run.questions[k]
  const h = heatFor(run, k)
  const jev = h.answer
  const key = q.revealed && q.scored ? q.answer ?? [] : null
  const yours = mine?.[k]?.pick
  const yourV = key && yours ? judgePick(yours, key, lines) : null
  const center = at ?? jev?.top ?? key?.[0] ?? (yours !== NONE ? yours : null) ?? lines[0].id
  const shown = around(lines, center, 2)
  const ids = new Set(shown.map((l) => l.id))
  const byId = new Map(lines.map((l) => [l.id, l]))
  const hottest = Math.max(1e-9, ...Object.values(h.source === 'jev' ? h.heat : {}))
  const picks = run.lanes.map((ln) => ({ ln, a: answerOf(ln, k), m: markOf(ln, k) })).filter((x) => x.a)
  const pickersOf = (id) => picks.filter((x) => x.a.pick === id)
  const extra = [
    ...(key ?? []).filter((id) => !ids.has(id)).map((id) => ({ id, why: 'THE ANSWER' })),
    ...(yours && yours !== NONE && !ids.has(yours) && !(key ?? []).includes(yours) ? [{ id: yours, why: 'YOUR PICK' }] : []),
  ]
  const told = new Set([...ids, ...extra.map((x) => x.id)])
  for (const { ln, a } of picks) {
    if (a.pick && a.pick !== NONE && byId.has(a.pick) && !told.has(a.pick)) {
      told.add(a.pick)
      extra.push({ id: a.pick, why: `PLAYER ${ln.index + 1}'S PICK` })
    }
  }
  const stamps = (id) => {
    let i = 0
    return html`
      ${key?.includes(id) || (id === NONE && key && !key.length) ? html`<span class="nh-stamp nh-stamp--answer" style=${{ '--i': i++ }}>✓ answer</span>` : null}
      ${yours === id && html`<${Stamp} who="you" verdict=${yourV} points=${POINTS[yourV]} i=${i++} />`}
      ${pickersOf(id).map(({ ln, m }) => html`<${Stamp} key=${ln.index} who=${ln.index} verdict=${m?.verdict} points=${m?.points} i=${i++} />`)}
    `
  }
  const row = (ln) => {
    const p = h.source === 'jev' ? h.heat[ln.id] ?? 0 : null
    const isTop = jev?.top === ln.id
    const isKey = key?.includes(ln.id)
    const soft = isTop && jev?.pick === NONE
    const cls = `nh-row${isTop ? ' nh-row--top' : ''}${soft ? ' nh-row--soft' : ''}${isKey ? ' nh-row--key' : ''}${yours === ln.id ? ' nh-row--mine' : ''}`
    return html`
      <div key=${ln.id} class=${cls}>
        ${p != null && p / hottest >= 0.04 && html`<span class="nh-row__heat" style=${{ width: `${(p / hottest) * 100}%` }} aria-hidden="true" />`}
        ${isTop && html`<span class="nh-lockon" aria-hidden="true" />`}
        <span class="nh-row__id g-mono">${ln.id}</span>
        <span class="nh-row__t">${ln.text}<span class="nh-row__tags">${stamps(ln.id)}</span></span>
        <span class="nh-row__p g-mono">${p == null ? '' : fmtProb(p)}</span>
      </div>
    `
  }
  const saidNone = picks.some((x) => x.a.pick === NONE) || yours === NONE
  const noneIsKey = key && !key.length
  const where = run.doc.sections[byId.get(center)?.s] ?? ''
  return html`
    <${Box} class="nh-center nh-zoombox">
      <div class="nh-center__hd">
        <${Label} note=${where}>${at ? 'AROUND THE LINE YOU CHOSE ON THE MAP' : jev ? 'WHERE JEV POINTS' : 'AROUND THE PICK'}<//>
        <span class="spacer" />
        ${jev?.top && html`<span class=${`nh-locked g-mono${jev.pick === NONE ? ' nh-locked--soft' : ''}`} key=${`${k}-${jev.top}`}>
          <span aria-hidden="true">◎</span> ${jev.pick === NONE ? `closest: ${jev.top}` : `locked on ${jev.top}`}</span>`}
      </div>
      <div class="nh-zoom" key=${`${k}-${center}`}>${shown.map(row)}</div>
      ${(saidNone || noneIsKey || jev?.pick === NONE) && html`
        <div class=${`nh-row nh-row--none${noneIsKey ? ' nh-row--key' : ''}${yours === NONE ? ' nh-row--mine' : ''}`} key=${`none-${k}`}>
          <span class="nh-row__id g-mono" aria-hidden="true">∅</span>
          <span class="nh-row__t">Not in this document<span class="nh-row__tags">${stamps(NONE)}</span></span>
          <span class="nh-row__p g-mono">${jev && Number.isFinite(jev.exists) ? fmtProb(1 - jev.exists) : ''}</span>
        </div>`}
      ${jev?.pick === NONE && html`<p class="nh-note g-mono">Jev's closest line is locked on, but its dial says the answer isn't in here: it answers NONE.</p>`}
      ${noneIsKey && html`<p class="nh-note nh-t-ok g-mono">✓ The answer is not in this document.</p>`}
      ${!key && q.scored && html`<p class="nh-note g-mono g-muted">■ The answer shows once every player has given one.</p>`}
      ${extra.map((x) => html`
        <div key=${`x${x.id}`} class="nh-extra">
          <span class="nh-extra__k">${x.why} · ${run.doc.sections[byId.get(x.id)?.s] ?? ''}</span>
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
  const len = DIAL.r - 6
  const ticks = Array.from({ length: 21 }, (_, i) => i / 20)
  const label = open
    ? 'The existence dial, sealed until you answer'
    : b
      ? `The existence dial at ${fmtProb(p)}: ${BAND[b].label}`
      : 'The existence dial: no Jev reading for this question'
  const lit = !open && b
  return html`
    <${Box} class=${`nh-dial${lit ? ` nh-dial--${tone}` : ''}`}>
      <${Label}>IS IT IN HERE AT ALL?<//>
      <svg viewBox=${`0 0 ${DIAL.width} ${DIAL.height}`} role="img" aria-label=${label}>
        <path class="nh-dial__bed" d=${`M${DIAL.cx - DIAL.r - 12} ${DIAL.cy} A${DIAL.r + 12} ${DIAL.r + 12} 0 0 1 ${DIAL.cx + DIAL.r + 12} ${DIAL.cy}`} />
        ${ticks.map((t) => {
          const major = Math.round(t * 20) % 5 === 0
          const [x1, y1] = dialPoint(t, DIAL.r + 9)
          const [x2, y2] = dialPoint(t, DIAL.r + (major ? 15 : 12))
          return html`<line key=${t} class=${`nh-dial__tick${major ? ' nh-dial__tick--major' : ''}`} x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`
        })}
        ${dialBands(bands).map((x) => html`<g key=${x.band} class=${`nh-arc nh-arc--${x.band}${open ? ' nh-arc--sealed' : b === x.band ? ' nh-arc--on' : ''}`}>
          <path class="nh-arc__glow" d=${x.d} /><path class="nh-arc__line" d=${x.d} /></g>`)}
        ${[bands.partly, bands.answered].map((t) => {
          const [[x1, y1], [x2, y2]] = [dialPoint(t, DIAL.r - 9), dialPoint(t, DIAL.r + 9)]
          return html`<line key=${t} class="nh-tick" x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`
        })}
        ${!open && Number.isFinite(p) && html`
          <g key=${`n${k}`} class="nh-needle" style=${{ transform: `rotate(${needleAngle(p)}deg)` }}>
            <path class="nh-needle__body" d=${`M${DIAL.cx - len} ${DIAL.cy} L${DIAL.cx + 2} ${DIAL.cy - 3.2} L${DIAL.cx + 12} ${DIAL.cy} L${DIAL.cx + 2} ${DIAL.cy + 3.2} Z`} />
            <circle class="nh-needle__tip" cx=${DIAL.cx - len} cy=${DIAL.cy} r="2.6" />
          </g>`}
        <circle class="nh-hub" cx=${DIAL.cx} cy=${DIAL.cy} r="8" />
        <circle class="nh-hub__cap" cx=${DIAL.cx} cy=${DIAL.cy} r="3.2" />
        ${open && html`<text class="nh-dial__q" x=${DIAL.cx} y=${DIAL.cy - 24}>?</text>`}
      </svg>
      <span key=${open ? 'sealed' : `v${k}`} class=${`nh-dial__v g-mono nh-t-${open ? 'dim' : tone}`}>${open ? 'sealed' : Number.isFinite(p) ? fmtProb(p) : '—'}</span>
      <span key=${open ? 's' : `b${k}`} class=${`nh-dial__band${lit ? ` nh-dial__band--${tone}` : ''}`}>
        ${open ? html`<span aria-hidden="true">■</span> until you answer` : b ? html`<span aria-hidden="true">${BAND_GLYPH[b]}</span> ${BAND[b].label}` : 'no Jev in this game'}</span>
      <ul class="nh-legend">
        <li class=${b === 'answered' && !open ? 'is-on' : ''}><i class="nh-sw nh-sw--answered" aria-hidden="true" />answered · ${bands.answered} and up</li>
        <li class=${b === 'partly' && !open ? 'is-on' : ''}><i class="nh-sw nh-sw--partly" aria-hidden="true" />partly · ${bands.partly} to ${bands.answered}</li>
        <li class=${b === 'absent' && !open ? 'is-on' : ''}><i class="nh-sw nh-sw--absent" aria-hidden="true" />not in here · under ${bands.partly}</li>
      </ul>
    <//>
  `
}

/** Everyone's line for this question as a row of cards: sealed while the
 *  visitor hunts, then each pick, how long it took, and a stamp for how it went. */
function Picks({ run, k, mine, open, yourMs }) {
  const q = run.questions[k]
  const played = mine?.[k]
  const lines = run.lines
  const jev = heatFor(run, k).answer
  const yourKey = q.scored && played && !played.skipped && q.revealed ? judgePick(played.pick, q.answer, lines) : null
  const yourV = yourKey ? VERDICT[yourKey] : null
  return html`
    <div class="nh-cards" role="list" aria-label="Every player's answer">
      ${run.lanes.map((ln) => {
        const a = answerOf(ln, k)
        const m = markOf(ln, k)
        // Sealed until the visitor has answered: nothing of how it went shows.
        const v = !open && m && m.verdict !== 'unscored' ? VERDICT[m.verdict] : null
        const out = ln.status === 'error' || ln.status === 'stopped'
        let body
        if (!a) body = html`<span class="nh-card__wait">${out ? 'could not answer' : ln.status === 'rate_limited' ? 'waiting out a rate limit…' : html`hunting<span class="nh-dots" aria-hidden="true"><i /><i /><i /></span>`}</span>`
        else if (open) body = html`<span class="nh-card__seal"><span aria-hidden="true">■</span> sealed</span>`
        else body = html`
          <span class=${`nh-card__line${a.foul ? ' nh-t-err' : ''}${a.pick === NONE ? ' nh-card__line--none' : ''}`}>${a.foul ? `“${a.said || '—'}”` : a.pick === NONE ? '∅ NONE' : a.pick}</span>
          ${a.foul && html`<span class="nh-t-err nh-card__sub">is no line</span>`}`
        return html`<div key=${ln.index} role="listitem" class=${`nh-card g-l${(ln.index % 4) + 1}${open && a ? ' nh-card--sealed' : ''}${v ? ` nh-card--${v.tone}` : ''}`}>
          <div class="nh-card__hd"><${LaneNum} i=${ln.index} out=${out} /><b class="nh-card__who">${ln.label}</b><span class="spacer" />
            ${a && html`<span class="nh-card__ms g-mono">${fmtMs(a.ms)}</span>`}</div>
          <div class="nh-card__pick">${body}</div>
          ${!open && a && html`<div class="nh-card__meta g-mono">
            ${Number.isFinite(a.exists) && html`<span class=${`nh-t-${BAND[a.band].tone}`}>${BAND_GLYPH[a.band]} dial ${fmtProb(a.exists)}</span>`}
            ${!v && !q.scored && jev && a !== jev && html`<span class="g-muted">${a.pick === jev.pick ? '= agrees with Jev' : '≠ differs from Jev'}</span>`}
            ${!v && q.scored && !q.revealed && html`<span class="g-muted">■ key not out yet</span>`}
          </div>`}
          ${!open && v && html`<span key=${`v${k}`} class=${`nh-verdict nh-verdict--${v.tone}`}>${v.glyph} ${v.label} <b>${signed(m.points)}</b></span>`}
          ${!open && a?.reason && html`<q class="nh-card__why">${a.reason}</q>`}
        </div>`
      })}
      <div id="nh-card-you" role="listitem" class=${`nh-card nh-card--you${open ? ' nh-card--hunting' : ''}${yourV ? ` nh-card--${yourV.tone}` : ''}`}>
        <div class="nh-card__hd"><span class="nh-you" aria-hidden="true">YOU</span><b class="nh-card__who">You</b><span class="spacer" />
          <span class="nh-card__ms g-mono">${fmtMs(yourMs)}</span></div>
        <div class="nh-card__pick">
          ${open
            ? html`<span class="nh-card__wait" aria-live="off">still hunting<span class="nh-dots" aria-hidden="true"><i /><i /><i /></span></span>`
            : played.skipped
              ? html`<span class="nh-card__wait">asked to be shown</span>`
              : html`<span class=${`nh-card__line${played.pick === NONE ? ' nh-card__line--none' : ''}`}>${played.pick === NONE ? '∅ NONE' : lineName(played.pick)}</span>`}
        </div>
        ${!open && !played.skipped && html`<div class="nh-card__meta g-mono">
          ${!yourV && !q.scored && jev && html`<span class="g-muted">${played.pick === jev.pick ? '= agrees with Jev' : '≠ differs from Jev'}</span>`}
          ${!yourV && q.scored && html`<span class="g-muted">■ the answer shows once every player has given one</span>`}
        </div>`}
        ${yourV && html`<span key=${`v${k}`} class=${`nh-verdict nh-verdict--${yourV.tone}`}>${yourV.glyph} ${yourV.label} <b>${signed(POINTS[yourKey])}</b></span>`}
      </div>
    </div>
  `
}

const CELL_GLYPH = { sealed: '■', pending: '…', hunting: '', skipped: '›' }

/** The match: a scoreboard of every player over the questions, the visitor's
 *  row first, and what comes next. */
function Match({ run, match, k, open, onSkip, onView, onNext, onFresh, starting, startError }) {
  const n = run.questions.length
  const last = k >= n - 1
  const t = match.tally
  const { leaders, done, scored } = match
  const crown = done && scored
  const cell = (c, qk, lane) => {
    const v = VERDICT[c.state]
    const shownV = v && c.state !== 'unscored'
    const text = shownV ? v.glyph : c.state === 'unscored' ? '·' : CELL_GLYPH[c.state] ?? ''
    const title = shownV ? `${v.label} ${signed(c.points)}` : c.state === 'unscored' ? 'no answer key' : c.state === 'sealed' ? 'sealed until you answer' : c.state === 'pending' ? 'the answer is not out yet' : c.state === 'skipped' ? 'you asked to be shown' : lane?.out ? 'out of the game' : 'not answered yet'
    return html`<td key=${qk} class=${`nh-cell nh-cell--${shownV ? v.tone : c.state}${qk === k ? ' is-now' : ''}`} title=${title}>
      <button type="button" class="nh-cell__b" onClick=${() => onView(qk)} aria-label=${`Question ${qk + 1}: ${title}`}>
        <span key=${c.state}>${text}${shownV && html`<small>${signed(c.points)}</small>`}</span>
      </button></td>`
  }
  return html`
    <${Box} class="nh-match">
      <div class="nh-match__hd">
        <${Label} note=${t.questions ? `after ${t.questions} of ${n} question${n === 1 ? '' : 's'}` : 'answer a question to open the scores'}>MATCH<//>
        <span class="spacer" />
        <span class="g-mono g-muted nh-match__hint">
          ${open ? 'some questions have no answer here: the dial is the trap' : scored ? '' : 'no answer key for a typed question: see who agrees'}
        </span>
        ${open && html`<${Button} variant="ghost" size="sm" onClick=${onSkip}>Show me<//>`}
        ${!open && !last && html`<${Button} variant="primary" onClick=${onNext}>Next question ▸<//>`}
        ${!open && last && html`<${Button} variant="primary" onClick=${onFresh} disabled=${starting || isRunLive(run)}>
          ${starting ? 'Starting…' : 'New questions'}<//>`}
      </div>
      <div class="scroll-x">
        <table class="nh-match__t">
          <thead>
            <tr>
              <th>player</th>
              ${run.questions.map((x) => html`<th key=${x.k} class=${`nh-match__q${x.k === k ? ' is-now' : ''}`}>Q${x.k + 1}</th>`)}
              <th class="num">points</th>
            </tr>
          </thead>
          <tbody>
            <tr class=${`nh-mrow nh-mrow--you${crown && leaders.you ? ' nh-mrow--win' : ''}`}>
              <td class="nh-mrow__who"><span class="nh-you" aria-hidden="true">YOU</span> <span>You</span>${crown && leaders.you && html`<span class="nh-star" title="winner">★</span>`}</td>
              ${match.you.cells.map((c, i) => cell(c, i))}
              <td class="num nh-mrow__total">${scored ? html`<${Counter} value=${match.you.points} format=${num} sound />` : '–'}</td>
            </tr>
            ${match.lanes.map((ln) => {
              const win = crown && leaders.lanes.includes(ln.index)
              const out = ln.status === 'error' || ln.status === 'stopped'
              return html`<tr key=${ln.index} class=${`nh-mrow g-l${(ln.index % 4) + 1}${win ? ' nh-mrow--win' : ''}`}>
                <td class="nh-mrow__who"><${LaneNum} i=${ln.index} out=${out} /> <span>${ln.label}</span>${win && html`<span class="nh-star" title="winner">★</span>`}</td>
                ${ln.cells.map((c, i) => cell(c, i, { out }))}
                <td class="num nh-mrow__total">${scored ? html`<${Counter} value=${ln.points} format=${num} />` : '–'}</td>
              </tr>`
            })}
          </tbody>
        </table>
      </div>
      ${done && scored && html`<p class="nh-match__end g-mono" key="end"><span class="nh-star" aria-hidden="true">★</span> ${leaders.you && !leaders.lanes.length ? 'You win the match' : leaders.you ? 'A tie, and you are in it' : 'The match goes to the players'} · ${signed(leaders.best)}${t.you.ms ? ` · you took ${fmtMs(t.you.ms)} a question` : ''}</p>`}
      ${!done && t.questions > 0 && scored && html`<p class="nh-match__end nh-match__end--dim g-mono">You ${signed(t.you.points)}${t.you.ms ? ` · ${fmtMs(t.you.ms)} a question` : ''} · the rest stays sealed until you play it</p>`}
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
        <div class="nh-lane__score">${scored ? html`<${Counter} value=${m.points} format=${num} class="g-score" />` : html`<span class="g-score">–</span>`}<small>points</small></div>
        <div class="g-stats nh-lane__stats">
          <${Stat} label="answered" value=${lane.answered ?? 0} />
          <${Stat} label="✓ right" value=${m.right} tone=${m.right ? 'ok' : undefined} />
          <${Stat} label="≈ next door" value=${m.near} tone=${m.near ? 'warn' : undefined} />
          <${Stat} label="✕ wrong" value=${m.wrong} tone=${m.wrong ? 'err' : undefined} />
        </div>
      </div>
      <p class="g-mono g-muted nh-lane__note">
        ${scored ? `over the ${played} question${played === 1 ? '' : 's'} you have played and every player has answered` : 'a typed question has no answer key'}
      </p>
      <${LaneStats} lane=${lane} />
    <//>
  `
}
