/* Two Truths and a Lie — a text model writes the claims; Jev checks them against the source.
 *
 * The server (games/twotruths.py) fetches the article, has the writer make
 * three claims (two true, one a lie the introduction contradicts), shuffles
 * them and asks every judge. This page is a game show: the article, then the
 * three claims on a lit stage, each with its own lie detector (a polygraph
 * strip and a needle), and a big button under each. Every verdict stays
 * sealed until the visitor has pressed one (or asked to be shown): Jev has
 * answered long before they finish reading, which is the point. Then the
 * polygraphs draw in, the needles swing, the judges' picks light up, and —
 * once the run reveals it — the truths are stamped TRUE and the lie LIE.
 *
 * The visitor's pick and time live in sessionStorage per run, and a small
 * session tally (you vs each judge, by name) adds up the rounds.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Button } from '../ui.js'
import {
  Box,
  Chip,
  Counter,
  GameFrame,
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
  burstFrom,
  fmtK,
  fmtMs,
  html,
  laneCostText,
  sfx,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtProb, isRunLive, playersProblem } from './runstate.js'
import {
  VERDICTS,
  VERDICT_LABEL,
  VERDICT_MARK,
  clockText,
  entryOf,
  foundBy,
  needleAngle,
  pointsAttr,
  polygraph,
  revealOrder,
  signalOf,
  tallyOf,
  topVerdict,
  traceLength,
  unsealed,
} from './twotruths.logic.js'

export default function TwoTruths({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── The session: the visitor's picks and the rounds' tally ────────────────── */

const STORE = 'wikirace.twotruths.v1'
const KEEP = 60

function readStore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORE) || '{}')
    return s && typeof s === 'object' ? s : {}
  } catch {
    return {}
  }
}

function writeStore(s) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(s))
  } catch {
    /* private mode or full: the round still plays, it just is not remembered */
  }
}

/** The visitor's play on one run: {pick, ms} or {skipped}; and a setter that remembers it. */
function useMine(runId) {
  const [mine, setMine] = useState(() => readStore().mine?.[runId] ?? null)
  useEffect(() => setMine(readStore().mine?.[runId] ?? null), [runId])
  const set = (m) => {
    const s = readStore()
    s.mine = { ...(s.mine ?? {}), [runId]: m }
    writeStore(s)
    setMine(m)
  }
  return [mine, set]
}

function useRounds() {
  const [s, setS] = useState(readStore)
  const add = (runId, entry) => {
    const next = readStore()
    if (next.rounds?.[runId]) return
    next.rounds = { ...(next.rounds ?? {}), [runId]: entry }
    next.order = [...(next.order ?? []).filter((id) => id !== runId), runId].slice(-KEEP)
    writeStore(next)
    setS(next)
  }
  const entries = (s.order ?? []).map((id) => s.rounds?.[id]).filter(Boolean)
  return { entries, has: (runId) => !!s.rounds?.[runId], add }
}

/** A number from a string, for seeding a claim's trace. */
function hash(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

/** When each stamp lands, in seconds after the reveal, by revealOrder: two
 *  truths, a beat, then the lie. */
const STAMP_AT = [0.15, 0.55, 1.05]
const LIE_COLORS = ['#ff4d6a', '#ff4fd8', '#ffffff']
const WIN_COLORS = ['#3ef5a0', '#ff4fd8', '#ffe14d', '#ffffff']

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [writer, setWriter] = useState([])
  const [lanes, setLanes] = useState([])
  const [title, setTitle] = useState('')
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (!models.data) return
    if (!lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
    if (!writer.length) {
      const w = models.data.models.find((m) => m.kind === 'text' && m.available)
      setWriter([{ key: w?.key ?? '' }])
    }
  }, [models.data])
  const wKey = writer[0]?.key
  const wModel = models.data?.models?.find((m) => m.key === wKey)
  const problem = models.error
    ? models.error.message
    : !wKey
      ? 'Pick a text model to write the claims.'
      : wModel && !wModel.available
        ? `${wModel.model_id} cannot write: ${wModel.reason ?? 'unavailable'}`
        : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { writer: wKey, title: title.trim() || null })

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="tt-setup">
          <${PlayerPicker} info=${models.data} value=${writer} onChange=${setWriter} min=${1} max=${1}
            kinds=${['text']} label="WRITER" />
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} label="JUDGES" />
          <label class="g-field"><span>Article</span>
            <input class="wr-in" type="text" value=${title} maxlength="250" placeholder="a random one"
              onInput=${(e) => setTitle(e.currentTarget.value)} />
          </label>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Write three claims" />
          ${busy && html`<p class="tt-busy" role="status"><span class="tt-busy__dot" aria-hidden="true" />The writer is reading the article and writing three claims…</p>`}
        <//>
        <div class="tt-side">
          <${Box} class="tt-how">
            <${Label}>HOW IT'S PLAYED<//>
            <${DemoStage} />
            <ol class="tt-how__steps">
              <li class="tt-how__step tt-how__step--w">
                <span class="tt-how__n" aria-hidden="true">1</span>
                <p class="g-explain">
                  A <b>text model</b> reads the introduction of a Wikipedia article and writes three claims about it:
                  two true, one a lie the introduction contradicts. The claims are shuffled, and everyone judges them.
                </p>
              </li>
              <li class="tt-how__step tt-how__step--j">
                <span class="tt-how__n" aria-hidden="true">2</span>
                <p class="g-explain">
                  <b>Jev</b> checks each claim against the article, three Choice questions
                  side by side: <code>supported</code>, <code>contradicted</code> or <code>not_in_article</code>. It points at the
                  claim it thinks is contradicted, and it answers in a tenth of a second. A <b>text judge</b> names
                  the lie in words; naming no claim is a foul.
                </p>
              </li>
              <li class="tt-how__step tt-how__step--y">
                <span class="tt-how__n" aria-hidden="true">3</span>
                <p class="g-explain">
                  <b>You</b> pick too. Every verdict stays sealed until you have: then the polygraphs run.
                </p>
              </li>
            </ol>
            <div class="tt-rules">
              <${Chip} tone="ok">✓ found the lie · 1<//><${Chip}>missed · 0<//><${Chip} tone="err">✕ foul · 0<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.article?.title ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The round in miniature, on a loop: three cards on the stage, the lens
 *  passing over each, two TRUE stamps and then the LIE. */
function DemoStage() {
  const ps = [0.03, 0.05, 0.9]
  return html`
    <div class="tt-demo">
      <svg viewBox="0 0 336 132" role="img"
        aria-label="Three claim cards on a stage: a lens checks each in turn; two calm polygraph traces are stamped TRUE and the spiking one LIE">
        <defs>
          <radialGradient id="tt-demo-spot" cx="0.5" cy="0" r="1">
            <stop offset="0" stop-color="#ff4fd8" stop-opacity=".28" />
            <stop offset="1" stop-color="#ff4fd8" stop-opacity="0" />
          </radialGradient>
        </defs>
        <rect x="0" y="0" width="336" height="132" rx="10" class="tt-demo__bg" />
        <ellipse cx="168" cy="126" rx="160" ry="8" class="tt-demo__floor" />
        ${ps.map((p, k) => html`
          <g key=${k} transform=${`translate(${8 + k * 110} 10)`}>
            <path d="M8 0 H92 L104 108 H-4 Z" fill="url(#tt-demo-spot)" />
            <rect width="100" height="108" rx="7" class="tt-demo__card" />
            <text x="9" y="17" class="tt-demo__n">${k + 1}</text>
            <path d="M24 13 H88 M9 27 H80 M9 36 H68" class="tt-demo__lines" />
            <rect x="6" y="46" width="88" height="34" rx="3" class="tt-demo__poly" />
            <polyline class=${`tt-demo__trace tt-s-${p > 0.5 ? 'err' : 'ok'}`}
              points=${pointsAttr(polygraph(p, 17 + k * 31, { width: 84, height: 30, n: 34 }).map(([x, y]) => [x + 8, y + 48]))} />
            <rect x="12" y="88" width="76" height="13" rx="6.5" class="tt-demo__btn" />
            <g transform="translate(50 62)">
              <g class=${`tt-demo__stamp--${k + 1}`}>
                <g transform="rotate(-12)">
                  <rect x=${p > 0.5 ? -24 : -32} y="-12" width=${p > 0.5 ? 48 : 64} height="24" rx="3"
                    class=${p > 0.5 ? 'tt-demo__ink--lie' : 'tt-demo__ink--true'} />
                  <text y="6" class=${p > 0.5 ? 'tt-demo__word tt-demo__word--lie' : 'tt-demo__word tt-demo__word--true'}>${p > 0.5 ? 'LIE' : 'TRUE'}</text>
                </g>
              </g>
            </g>
          </g>`)}
        <g class="tt-demo__lens">
          <circle cx="58" cy="72" r="17" />
          <line x1="70" y1="84" x2="82" y2="96" />
        </g>
      </svg>
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const [mine, setMine] = useMine(runId)
  const rounds = useRounds()
  const [shownAt, setShownAt] = useState(null)
  const open = !unsealed(mine)
  const now = useNow(!!run && (isRunLive(run) || open), 100)
  const { busy, error: startError, start } = useStarter(game.id)
  const stage = useRef(null)
  const revealed = !!run && !open && Number.isInteger(run.lie)

  // The visitor's clock starts when the claims are on the screen.
  useEffect(() => setShownAt(null), [runId])
  useEffect(() => {
    if (run && shownAt == null) setShownAt(Date.now())
  }, [!!run])
  // A round goes on the tally once the run is over and the visitor has played it.
  useEffect(() => {
    if (!run || isRunLive(run) || rounds.has(runId)) return
    const e = entryOf(run, mine)
    if (e) rounds.add(runId, e)
  }, [run?.status, run?.lie, mine])
  useReveal(runId, run, revealed, open, mine, stage)

  const tally = useMemo(() => tallyOf(rounds.entries), [rounds.entries.length])
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`

  const pick = (k) => {
    if (!open) return
    sfx.coin()
    setMine({ pick: k, ms: Math.max(0, Date.now() - (shownAt ?? Date.now())) })
  }
  const skip = () => setMine({ skipped: true })
  const next = () =>
    start(run.lanes.map((l) => ({ key: l.key })), { writer: run.writer?.key ?? run.params?.writer ?? null, title: null, seed: null })
  const round = tally.rounds + (rounds.has(runId) ? 0 : 1)
  const yourMs = open ? (shownAt ? now - shownAt : 0) : mine?.ms
  const fin = finaleOf(run, open)

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${next} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub} win=${!fin.quiet}>
        <span class="g-mono g-muted">${run.lanes.length} judge${run.lanes.length === 1 ? '' : 's'} · claims by ${run.writer?.label ?? '—'}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="tt-top">
        <${ArticleCard} run=${run} round=${round} />
        <${FlowCard} run=${run} open=${open} />
      </div>
      <section class=${`tt-stage${open ? ' is-open' : ''}${revealed ? ' is-revealed' : ''}`} ref=${stage} aria-label="The three claims">
        <${Marquee} run=${run} mine=${mine} open=${open} revealed=${revealed} />
        <div class="tt-claims">
          ${run.claims.map((c, k) => html`<${ClaimCard} key=${k} run=${run} k=${k} mine=${mine} open=${open} onPick=${pick} />`)}
        </div>
      </section>
      <${Duel} run=${run} mine=${mine} open=${open} yourMs=${yourMs} tally=${tally}
        onSkip=${skip} onNext=${next} starting=${busy} startError=${startError} />
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${JudgeCard} key=${ln.index} lane=${ln} run=${run} open=${open} />`)}
      </div>
    <//>
  `
}

/**
 * The finale's words, by the game's rule: every judge that found the lie wins
 * (a tie when several did). While the visitor has not played, the run's end
 * names nobody, so as not to give a verdict away: it hands them the buzzer.
 */
function finaleOf(run, open) {
  if (open) return { winners: [], headline: 'JUDGES ARE IN!', sub: 'Your move: pick the lie to see who found it.', quiet: true }
  const won = foundBy(run)
  if (!won.length) return { winners: [], headline: 'THE LIE GOT AWAY', sub: 'No judge found it.', quiet: true }
  if (run.lanes.length === 1) return { winners: won, headline: 'LIE FOUND!', sub: `${run.lanes[0].label} found it` }
  return { winners: won }
}

/**
 * The reveal, when it happens in front of you: the stamps land (CSS), then
 * confetti off the lie, and a cheer or a groan for your pick. A round reopened
 * after the fact just shows its stamps. When the reveal comes with the run's
 * own end (you picked before the judges finished), the finale has the fanfare.
 */
function useReveal(runId, run, revealed, open, mine, stage) {
  const seen = useRef(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    seen.current = null
  }, [runId])
  useEffect(() => {
    if (!run) return
    const was = seen.current
    seen.current = revealed
    if (was !== false || !revealed) return
    const byPick = wasOpen.current
    const right = Number.isInteger(mine?.pick) && mine.pick === run.lie
    const at = (s, f) => setTimeout(f, s * 1000)
    const ts = [
      at(STAMP_AT[2], () => burstFrom(stage.current?.querySelector('.tt-claim--lie'), { colors: LIE_COLORS, count: 46, power: 0.75 })),
    ]
    if (byPick && !mine?.skipped) {
      ts.push(at(STAMP_AT[2] + 0.35, () => {
        if (right) {
          sfx.win()
          burstFrom(stage.current?.querySelector('.tt-marquee'), { colors: WIN_COLORS, count: 120, power: 1.05 })
        } else sfx.over()
      }))
    }
    return () => ts.forEach(clearTimeout)
  }, [!!run, revealed])
  useEffect(() => {
    wasOpen.current = open
  })
}

/** The sign over the stage: the question, then your answer's fate. When the
 *  reveal happens in front of you, it holds a drum roll until the lie's stamp
 *  lands, so the sign does not tell before the stage does. */
function Marquee({ run, mine, open, revealed }) {
  const [drum, setDrum] = useState(false)
  const was = useRef(revealed)
  useEffect(() => {
    const before = was.current
    was.current = revealed
    if (!revealed || before) return
    setDrum(true)
    const t = setTimeout(() => setDrum(false), STAMP_AT[2] * 1000 + 250)
    return () => clearTimeout(t)
  }, [revealed])
  const lie = run.lie + 1
  const right = revealed && mine?.pick === run.lie
  const [text, tone, sub] = open
    ? ['WHICH ONE IS THE LIE?', 'acc', 'Read the article, then press the button under the lie. Every verdict stays sealed until you do.']
    : !revealed || drum
      ? drum
        ? ['AND THE LIE IS...', 'yl', mine?.skipped ? 'Here it comes.' : `You said claim ${mine.pick + 1}.`]
        : ['LOCKED IN!', 'yl', mine?.skipped ? 'Waiting for the reveal…' : `You said claim ${mine.pick + 1}. Waiting for the reveal…`]
      : mine?.skipped
        ? [`CLAIM ${lie} IS THE LIE`, 'err', 'You asked to be shown.']
        : right
          ? ['YOU GOT IT!', 'ok', `Claim ${lie} is the lie, and you found it.`]
          : ['FOOLED YOU!', 'err', `You said claim ${mine.pick + 1}; the lie is claim ${lie}.`]
  return html`
    <div class=${`tt-marquee tt-marquee--${tone}${drum ? ' is-drum' : ''}`} role="status">
      <span class="tt-marquee__bulbs" aria-hidden="true" />
      <div class="tt-marquee__text" key=${text}><${PixelText} text=${text} label=${text} /></div>
      <p class="tt-marquee__sub" key=${sub}>${sub}</p>
      <span class="tt-marquee__bulbs tt-marquee__bulbs--b" aria-hidden="true" />
    </div>
  `
}

function ArticleCard({ run, round }) {
  const a = run.article
  return html`
    <${Box} class="tt-article">
      <${Label} note="the introduction, as the writer and every judge read it">ROUND ${round} · THE ARTICLE<//>
      <h2 class="tt-article__title">
        <span class="tt-article__w" aria-hidden="true"><${PixelText} text="W" /></span>
        <a href=${a.url} target="_blank" rel="noopener noreferrer">${a.title}</a>
      </h2>
      <div class="tt-article__intro scroll-y">
        ${a.intro.split('\n\n').map((p, i) => html`<p key=${i}>${p}</p>`)}
      </div>
    <//>
  `
}

/** How a round goes, lit as it goes: the claims written, the judges checking,
 *  your guess. */
function FlowCard({ run, open }) {
  const w = run.writer
  const jevs = run.lanes.filter((ln) => ln.kind === 'judgment')
  const checked = jevs.every((ln) => ln.verdicts || ln.status === 'error' || ln.status === 'stopped')
  const steps = [
    { key: 'w', text: 'text model writes 3 claims', state: 'done' },
    { key: 'j', text: 'Jev checks each', state: checked ? 'done' : 'live' },
    { key: 'y', text: 'you guess', state: open ? (checked ? 'live' : 'next') : 'done' },
  ]
  return html`
    <${Box} class="tt-flow">
      <${Label}>EACH ROUND<//>
      <ol class="tt-flow__steps">
        ${steps.map((s, i) => html`
          <li key=${s.key} class=${`tt-step tt-step--${s.key} is-${s.state}`}>
            <span class="tt-step__n" aria-hidden="true">${s.state === 'done' ? '✓' : i + 1}</span>
            <span class="tt-step__t">${s.text}</span>
            <span class="sr-only">${s.state === 'done' ? ' (done)' : s.state === 'live' ? ' (now)' : ''}</span>
          </li>
          ${i < steps.length - 1 && html`<li key=${`a${i}`} class=${`tt-flow__wire${steps[i + 1].state !== 'next' ? ' is-on' : ''}`} aria-hidden="true" />`}
        `)}
      </ol>
      <p class="g-mono g-muted tt-flow__note">3 choice questions, side by side: supported · contradicted · not in the article</p>
      ${w && html`
        <div class="g-stats">
          <${Stat} label="writer" value=${w.label} title=${w.key} />
          <${Stat} label="wrote in" value=${fmtMs(w.ms)} />
          <${Stat} label="tokens in / out" value=${`${fmtK(w.tokens_in)} / ${fmtK(w.tokens_out)}`} />
          <${Stat} label="cost" value=${laneCostText(w)} />
          ${w.attempts > 1 && html`<${Stat} label="tries" value=${w.attempts} tone="warn" title="its first reply was not in the format asked" />`}
        </div>
      `}
    <//>
  `
}

/** One claim on the stage: its number, its words, its lie detector, Jev's
 *  three bars, the judges who called it the lie, and the visitor's button.
 *  Sealed until they press one; stamped at the reveal. */
function ClaimCard({ run, k, mine, open, onPick }) {
  const claim = run.claims[k]
  const revealed = !open && Number.isInteger(run.lie)
  const isLie = revealed && run.lie === k
  const yours = mine?.pick === k
  const sig = signalOf(run, k)
  const jevs = run.lanes.filter((ln) => ln.kind === 'judgment')
  const callers = open ? [] : run.lanes.filter((ln) => ln.kind !== 'judgment' && ln.pick === k)
  const order = revealed ? revealOrder(k, run.lie) : 0
  const cls = `tt-claim${isLie ? ' tt-claim--lie' : revealed ? ' tt-claim--true' : ''}${yours ? ' tt-claim--mine' : ''}${open ? '' : ' is-judged'}`
  const mark = revealed ? (isLie ? ' ✓' : ' ✕') : ''
  const buzz = `tt-buzz${yours ? ' tt-buzz--on' : ''}${yours && revealed ? (isLie ? ' tt-buzz--right' : ' tt-buzz--wrong') : ''}`
  return html`
    <${Box} class=${cls} style=${{ '--tt-k': k, '--tt-d': `${STAMP_AT[order]}s` }}>
      <div class="tt-claim__hd">
        <span class="tt-claim__n"><${PixelText} text=${String(k + 1)} label=${`Claim ${k + 1}`} /></span>
        <span class="tt-claim__k" aria-hidden="true">CLAIM</span>
        <span class="spacer" />
        ${isLie
          ? html`<span class="sr-only">✕ the lie</span>`
          : revealed
            ? html`<span class="sr-only">✓ true</span>`
            : open
              ? html`<span class="tt-tag tt-tag--sealed">sealed</span>`
              : html`<span class="tt-tag tt-tag--wait">awaiting the reveal</span>`}
      </div>
      <p class="tt-claim__text">${claim.text}</p>
      <div class="tt-detector">
        <${Polygraph} k=${k} sig=${sig} open=${open} seed=${hash(`${run.id}:${k}`)} />
        <${Needle} k=${k} sig=${sig} open=${open} />
      </div>
      ${jevs.map((ln) => html`<${JevVerdict} key=${ln.index} lane=${ln} k=${k} open=${open} many=${jevs.length > 1} />`)}
      ${callers.length > 0 && html`
        <ul class="tt-says">
          ${callers.map((ln) => html`
            <li key=${ln.index} class=${`g-l${(ln.index % 4) + 1}`}>
              <${LaneNum} i=${ln.index} /> <b>${ln.label}</b> calls it the lie
              ${ln.reason && html`<q>${ln.reason}</q>`}
            </li>`)}
        </ul>
      `}
      ${isLie && run.why && html`<p class="tt-why"><span class="g-stat__k">the writer says </span>${run.why}</p>`}
      <span class="tt-grow" />
      <button type="button" class=${buzz} disabled=${!open} aria-pressed=${yours} onClick=${() => onPick(k)}>
        <span class="tt-buzz__cap">${yours ? `Your pick: this one's the lie${mark}` : "This one's the lie"}</span>
      </button>
      ${revealed && html`<span class=${`tt-stamp tt-stamp--${isLie ? 'lie' : 'true'}`} aria-hidden="true">${isLie ? 'LIE' : 'TRUE'}</span>`}
    <//>
  `
}

const W = 360
const H = 84

/** The polygraph strip: a pen that wanders for a truth and jumps for a lie.
 *  While sealed it idles, a scan beam sweeping; unsealed, the trace draws in. */
function Polygraph({ k, sig, open, seed }) {
  const pts = useMemo(() => polygraph(open ? 0.05 : sig.p, seed, { width: W, height: H }), [open, sig.p, seed])
  const tone = VERDICT_MARK[sig.top]?.tone ?? 'dim'
  const label = open
    ? `Polygraph for claim ${k + 1}: sealed until you pick`
    : sig.source === 'jev'
      ? `Polygraph for claim ${k + 1}: Jev puts ${fmtProb(sig.p)} on contradicted, ${sig.p >= 0.5 ? 'a jumpy trace' : 'a calm trace'}`
      : sig.source === 'judges'
        ? `Polygraph for claim ${k + 1}: ${Math.round(sig.p * 100)}% of the judges call it the lie`
        : `Polygraph for claim ${k + 1}: no verdict yet`
  const end = pts[pts.length - 1]
  const attr = pointsAttr(pts)
  const len = traceLength(pts)
  return html`
    <div class=${`tt-poly${open ? ' is-idle' : ` tt-poly--${tone}`}`}>
      <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${label}>
        <g class="tt-poly__grid">
          ${[21, 42, 63].map((y) => html`<line key=${`h${y}`} x1="0" y1=${y} x2=${W} y2=${y} class=${y === 42 ? 'tt-poly__mid' : ''} />`)}
          ${[60, 120, 180, 240, 300].map((x) => html`<line key=${`v${x}`} x1=${x} y1="0" x2=${x} y2=${H} class="tt-poly__tick" />`)}
        </g>
        ${open
          ? html`<polyline class="tt-trace tt-trace--idle" points=${attr} />`
          : html`
              <polyline key="glow" class=${`tt-trace tt-trace--glow tt-trace--draw tt-s-${tone}`} points=${attr} style=${{ '--len': len }} />
              <polyline key="live" class=${`tt-trace tt-trace--draw tt-s-${tone}`} points=${attr} style=${{ '--len': len }} />
              <circle key="ring" class=${`tt-pen__ring tt-s-${tone}`} cx=${end[0] - 4} cy=${end[1]} r="7" />
              <circle key="pen" class=${`tt-pen tt-f-${tone}`} cx=${end[0] - 4} cy=${end[1]} r="3.5" />`}
      </svg>
      ${open && html`<span class="tt-poly__scan" aria-hidden="true" />`}
      <span class=${`tt-poly__p g-mono${open ? '' : ` tt-t-${tone}`}`}>
        ${open ? 'p(contradicted) ?' : sig.source === 'jev' ? `p(contradicted) ${fmtProb(sig.p)}` : sig.source ? `judges ${Math.round(sig.p * 100)}%` : '—'}
      </span>
    </div>
  `
}

/** The lie detector's needle: TRUE on the left, LIE on the right, swung by
 *  the same signal as the polygraph. It fidgets while sealed. Decoration: the
 *  polygraph beside it says the number. */
function Needle({ k, sig, open }) {
  const tone = open ? 'idle' : VERDICT_MARK[sig.top]?.tone ?? 'dim'
  const a = open || !sig.source ? 0 : needleAngle(sig.p)
  const ticks = [-90, -45, 0, 45, 90]
  return html`
    <div class=${`tt-needle tt-needle--${tone}`} aria-hidden="true">
      <svg viewBox="0 0 120 74">
        <defs>
          <linearGradient id=${`tt-dial-${k}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stop-color="#3ef5a0" /><stop offset=".5" stop-color="#ffb545" /><stop offset="1" stop-color="#ff4d6a" />
          </linearGradient>
        </defs>
        <path class="tt-needle__well" d="M10 62 A50 50 0 0 1 110 62 Z" />
        <path class="tt-needle__glow" d="M16 62 A44 44 0 0 1 104 62" stroke=${`url(#tt-dial-${k})`} />
        <path class="tt-needle__arc" d="M16 62 A44 44 0 0 1 104 62" stroke=${`url(#tt-dial-${k})`} />
        ${ticks.map((t) => html`<line key=${t} class="tt-needle__tick" x1="60" y1="12" x2="60" y2="20" transform=${`rotate(${t} 60 62)`} />`)}
        <g class=${`tt-needle__hand${open ? ' is-idle' : ''}`} style=${{ transform: `rotate(${a}deg)` }}>
          <path d="M58.2 62 L60 22 L61.8 62 Z" />
        </g>
        <circle class="tt-needle__hub" cx="60" cy="62" r="5.5" />
        <text class="tt-needle__lbl tt-needle__lbl--ok" x="6" y="73">TRUE</text>
        <text class="tt-needle__lbl tt-needle__lbl--err" x="114" y="73" text-anchor="end">LIE</text>
      </svg>
    </div>
  `
}

/** Jev's three probabilities for one claim, or where they are. */
function JevVerdict({ lane, k, open, many }) {
  const v = lane.verdicts?.[k]
  const who = many && html`<${LaneNum} i=${lane.index} /> `
  if (!v) {
    const why = lane.status === 'error' ? 'could not check it' : 'checking…'
    return html`<p class=${`tt-wait g-mono${lane.status === 'error' ? '' : ' is-busy'}`}>${who}${lane.label} ${why}</p>`
  }
  if (open) {
    return html`<p class="tt-wait tt-wait--sealed g-mono">${who}${lane.label} answered in ${fmtMs(lane.ms)} · sealed until you pick</p>`
  }
  const top = topVerdict(v)
  return html`
    <div class=${`tt-jev g-l${(lane.index % 4) + 1}`}>
      ${many && html`<span class="tt-jev__who">${who}${lane.label}</span>`}
      <ol class="tt-vbars">
        ${VERDICTS.map((key, i) => {
          const m = VERDICT_MARK[key]
          const p = Math.max(0, Math.min(1, v[key] ?? 0))
          return html`<li key=${key} class=${`tt-vbar tt-vbar--${m.tone}${key === top ? ' is-top' : ''}`} style=${{ '--i': i }}>
            <span class="tt-vbar__g" aria-hidden="true">${m.glyph}</span>
            <span class="tt-vbar__k">${VERDICT_LABEL[key]}</span>
            <span class="tt-vbar__track"><span class="tt-vbar__fill" style=${{ width: `${p * 100}%` }} /></span>
            <span class="tt-vbar__v tnum">${fmtProb(v[key])}</span>
          </li>`
        })}
      </ol>
    </div>
  `
}

/** Jev's clock against yours, the session tally, and the next round. */
function Duel({ run, mine, open, yourMs, tally, onSkip, onNext, starting, startError }) {
  const jev = run.lanes.find((ln) => ln.kind === 'judgment' && Number.isFinite(ln.ms))
  const byLabel = new Map(run.lanes.map((ln) => [ln.label, ln.index]))
  const youSaid = open ? `you: still reading, ${fmtMs(yourMs)}` : mine?.skipped ? 'you asked to be shown' : `you took ${fmtMs(yourMs)}`
  return html`
    <${Box} class="tt-duel">
      <div class="tt-duel__clocks">
        <div class=${`tt-clock${jev ? ` g-l${(jev.index % 4) + 1}` : ' is-wait'}`}>
          <span class="tt-clock__k">${jev ? html`<${LaneNum} i=${jev.index} /><span class="tt-clock__name">${jev.label}</span>` : 'THE JUDGES'}</span>
          <span class="tt-clock__v">
            ${jev
              ? html`<${PixelText} text=${clockText(jev.ms)} label=${`${jev.label} checked all three in ${fmtMs(jev.ms)}`} />`
              : html`<span class="tt-clock__dots" aria-hidden="true"><i /><i /><i /></span><span class="sr-only">the judges are reading…</span>`}
          </span>
          <span class="tt-clock__sub">${jev ? 'checked all three' : 'reading…'}</span>
        </div>
        <span class="tt-vs" aria-hidden="true"><${PixelText} text="VS" /></span>
        <div class=${`tt-clock tt-clock--you${open ? ' is-live' : ''}`}>
          <span class="tt-clock__k">YOU</span>
          <span class="tt-clock__v" aria-hidden="true">
            <${PixelText} text=${mine?.skipped ? 'PASS' : clockText(yourMs)} />
          </span>
          <span class="tt-clock__sub">${open ? 'still reading' : mine?.skipped ? 'asked to be shown' : 'to pick'}</span>
          <span class="sr-only">${youSaid}</span>
        </div>
        ${open && html`<${Button} variant="ghost" size="sm" class="tt-duel__skip" onClick=${onSkip}>Show me<//>`}
      </div>
      <div class="tt-tally">
        ${tally.rounds
          ? html`
              <${Label}>AFTER ${tally.rounds} ROUND${tally.rounds === 1 ? '' : 'S'}<//>
              <div class="tt-tally__row">
                <span class="tt-tally__c tt-tally__c--you">
                  <span class="tt-tally__who">You</span>
                  <span class="tt-tally__n"><${Counter} value=${tally.you.found} sound />/${tally.you.played}</span>
                </span>
                ${tally.judges.map((j) => html`
                  <span key=${j.label} class=${`tt-tally__c${byLabel.has(j.label) ? ` g-l${(byLabel.get(j.label) % 4) + 1}` : ''}`}
                    title=${j.kind !== 'judgment' && Number.isFinite(j.ms) ? `${fmtMs(j.ms)} a round` : undefined}>
                    <span class="tt-tally__who">${byLabel.has(j.label) && html`<i class="tt-swatch" aria-hidden="true" />`}${j.label}</span>
                    <span class="tt-tally__n"><${Counter} value=${j.found} />/${j.rounds}</span>
                    ${j.kind !== 'judgment' && Number.isFinite(j.ms) && html`<small class="tt-tally__ms">${fmtMs(j.ms)} a round</small>`}
                  </span>`)}
              </div>`
          : html`<span class="g-mono g-muted">the session's first round</span>`}
      </div>
      <${Button} variant="primary" class="tt-next" onClick=${onNext} disabled=${starting || isRunLive(run)}>
        ${starting ? 'Writing…' : 'Next article ▸'}
      <//>
    <//>
    ${startError && html`<p class="g-t-err tt-starterr">${startError}</p>`}
  `
}

/** Three lamps, one per claim: the judge's pick lit in its lane's colour, the
 *  lie ringed once it is out. Decoration: the words beside it say the same. */
function Lamps({ n, pick, lie, lane }) {
  return html`
    <span class=${`tt-lamps g-l${(lane % 4) + 1}`} aria-hidden="true">
      ${Array.from({ length: n }, (_, k) => html`
        <span key=${k} class=${`tt-lamp${pick === k ? ' is-on' : ''}${lie === k ? ' is-lie' : ''}`}>${k + 1}</span>`)}
    </span>
  `
}

/** A judge's lane: what it picked, why, whether it found the lie, what it cost. */
function JudgeCard({ lane, run, open }) {
  const answered = Number.isFinite(lane.ms)
  const revealed = !open && Number.isInteger(run.lie)
  let body
  if (!answered) {
    body = html`<p class="g-muted tt-judge__wait">${lane.status === 'error' ? 'could not judge' : lane.kind === 'judgment' ? 'checking the three claims…' : 'reading the article…'}</p>`
  } else if (open) {
    body = html`<p class="g-muted">answered in ${fmtMs(lane.ms)} · sealed until you pick</p>`
  } else if (lane.kind === 'judgment') {
    body = html`<p>picked <b>claim ${lane.pick + 1}</b> · p(contradicted) ${fmtProb(lane.verdicts?.[lane.pick]?.contradicted)}
      <span class="g-muted"> · ${lane.requests ?? 3} requests side by side</span></p>`
  } else if (lane.foul) {
    body = html`<p class="g-t-err">✕ foul: “LIE: ${lane.said || '—'}” names no claim</p>`
  } else {
    body = html`<p>picked <b>claim ${lane.pick + 1}</b>${lane.reason && html` · <q class="tt-q">${lane.reason}</q>`}</p>`
  }
  const verdict = revealed && typeof lane.found === 'boolean'
    ? lane.found ? { tone: 'ok', text: '✓ found the lie' } : { tone: 'err', text: lane.foul ? '✕ named no claim' : '✕ missed it' }
    : null
  const showPick = !open && answered && Number.isInteger(lane.pick)
  return html`
    <${Box} lane=${lane.index} class=${`tt-judge${verdict ? ` tt-judge--${verdict.tone}` : ''}`}>
      <${LaneHead} lane=${lane} />
      <div class="tt-judge__row">
        <div class="tt-judge__score">
          <${Counter} value=${revealed && lane.score != null ? lane.score : NaN} blank="–" class="g-score" />
          <small>found</small>
        </div>
        <${Lamps} n=${run.claims.length} pick=${showPick ? lane.pick : null} lie=${revealed ? run.lie : null} lane=${lane.index} />
        <div class="tt-judge__body">
          ${body}
          ${verdict && html`<p class=${`tt-verdict tt-verdict--${verdict.tone}`}>${verdict.text}</p>`}
        </div>
      </div>
      <${LaneStats} lane=${lane} />
    <//>
  `
}
