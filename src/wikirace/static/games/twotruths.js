/* Two Truths and a Lie — a text model writes the claims; Jev checks them against the source.
 *
 * The server (games/twotruths.py) fetches the article, has the writer make
 * three claims (two true, one a lie the introduction contradicts), shuffles
 * them and asks every judge. This page shows the article and the claims at
 * once and keeps every verdict sealed until the visitor has picked the lie
 * (or asked to be shown): Jev has answered long before they finish reading,
 * which is the point. Then the polygraphs draw in, the bars and the judges'
 * picks appear, and — once the run reveals it — the lie is stamped.
 *
 * The visitor's pick and time live in sessionStorage per run, and a small
 * session tally (you vs each judge, by name) adds up the rounds.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
import { Button } from '../ui.js'
import {
  Bars,
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
  fmtK,
  fmtMs,
  html,
  laneCostText,
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
  entryOf,
  pointsAttr,
  polygraph,
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
          ${busy && html`<p class="tt-busy" role="status">The writer is reading the article and writing three claims…</p>`}
        <//>
        <div class="tt-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              A <b>text model</b> reads the introduction of a Wikipedia article and writes three claims about it:
              two true, one a lie the introduction contradicts. The claims are shuffled, and everyone judges them.
            </p>
            <p class="g-explain">
              <b>Jev</b> checks each claim against the article, three Choice questions
              side by side: <code>supported</code>, <code>contradicted</code> or <code>not_in_article</code>. It points at the
              claim it thinks is contradicted, and it answers in a tenth of a second. A <b>text judge</b> names
              the lie in words; naming no claim is a foul.
            </p>
            <p class="g-explain">
              <b>You</b> pick too. Every verdict stays sealed until you have: then the polygraphs run.
            </p>
            <${SamplePoly} />
            <div class="tt-rules">
              <${Chip} tone="ok">found the lie · 1<//><${Chip}>missed · 0<//><${Chip} tone="err">foul · 0<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.article?.title ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** Three small traces: two calm truths and a jumpy lie, as the hub card shows. */
function SamplePoly() {
  const ps = [0.03, 0.05, 0.9]
  return html`
    <svg class="tt-sample" viewBox="0 0 330 44" role="img"
      aria-label="Three polygraph traces: two calm lines for true claims, one spiking line for the lie">
      ${ps.map((p, k) => html`
        <g key=${k} transform=${`translate(${k * 112} 0)`}>
          <rect class="tt-poly__bg" width="104" height="44" rx="3" />
          <polyline class=${`tt-trace tt-s-${p > 0.5 ? 'err' : 'ok'}`}
            points=${pointsAttr(polygraph(p, 17 + k * 31, { width: 104, height: 44, n: 40 }))} />
        </g>`)}
    </svg>
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

  const tally = useMemo(() => tallyOf(rounds.entries), [rounds.entries.length])
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`

  const pick = (k) => open && setMine({ pick: k, ms: Math.max(0, Date.now() - (shownAt ?? Date.now())) })
  const skip = () => setMine({ skipped: true })
  const next = () =>
    start(run.lanes.map((l) => ({ key: l.key })), { writer: run.writer?.key ?? run.params?.writer ?? null, title: null, seed: null })
  const round = tally.rounds + (rounds.has(runId) ? 0 : 1)
  const yourMs = open ? (shownAt ? now - shownAt : 0) : mine?.ms

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${next}>
        <span class="g-mono g-muted">${run.lanes.length} judge${run.lanes.length === 1 ? '' : 's'} · claims by ${run.writer?.label ?? '—'}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="tt-top">
        <${ArticleCard} run=${run} round=${round} />
        <${FlowCard} run=${run} />
      </div>
      <div class="tt-claims">
        ${run.claims.map((c, k) => html`<${ClaimCard} key=${k} run=${run} k=${k} mine=${mine} open=${open} onPick=${pick} />`)}
      </div>
      <${ScoreBar} run=${run} mine=${mine} open=${open} yourMs=${yourMs} tally=${tally}
        onSkip=${skip} onNext=${next} starting=${busy} startError=${startError} />
      <div class="g-lanes">
        ${run.lanes.map((ln) => html`<${JudgeCard} key=${ln.index} lane=${ln} run=${run} open=${open} />`)}
      </div>
    <//>
  `
}

function ArticleCard({ run, round }) {
  const a = run.article
  return html`
    <${Box} class="tt-article">
      <${Label} note="the introduction, as the writer and every judge read it">ROUND ${round} · THE ARTICLE<//>
      <h2 class="tt-article__title">
        <a href=${a.url} target="_blank" rel="noopener noreferrer">${a.title}</a>
      </h2>
      <div class="tt-article__intro scroll-y">
        ${a.intro.split('\n\n').map((p, i) => html`<p key=${i}>${p}</p>`)}
      </div>
    <//>
  `
}

const Arrow = () => html`<svg class="tt-arrow" width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
  <path d="M0 5 H13 M9 1 L13 5 L9 9" /></svg>`

function FlowCard({ run }) {
  const w = run.writer
  return html`
    <${Box} class="tt-flow">
      <${Label}>EACH ROUND<//>
      <div class="tt-flow__steps">
        <span class="tt-step tt-step--w">text model writes 3 claims</span><${Arrow} />
        <span class="tt-step tt-step--j">Jev checks each</span><${Arrow} />
        <span class="tt-step tt-step--y">you guess</span>
      </div>
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

/** One claim: its words, its polygraph, Jev's three bars, the judges who
 *  called it the lie, and the visitor's button. Sealed until they pick. */
function ClaimCard({ run, k, mine, open, onPick }) {
  const claim = run.claims[k]
  const revealed = !open && Number.isInteger(run.lie)
  const isLie = revealed && run.lie === k
  const yours = mine?.pick === k
  const sig = signalOf(run, k)
  const jevs = run.lanes.filter((ln) => ln.kind === 'judgment')
  const callers = open ? [] : run.lanes.filter((ln) => ln.kind !== 'judgment' && ln.pick === k)
  const cls = `tt-claim${isLie ? ' tt-claim--lie' : revealed ? ' tt-claim--true' : ''}${yours ? ' tt-claim--mine' : ''}`
  const mark = revealed ? (isLie ? ' ✓' : ' ✕') : ''
  return html`
    <${Box} class=${cls}>
      <div class="tt-claim__hd">
        <${Label}>CLAIM ${k + 1}<//>
        <span class="spacer" />
        ${isLie
          ? html`<span class="tt-stamp">THE LIE</span>`
          : revealed
            ? html`<span class="tt-true">✓ TRUE</span>`
            : open
              ? html`<span class="tt-sealedtag">sealed</span>`
              : html`<span class="tt-sealedtag">awaiting the reveal</span>`}
      </div>
      <p class="tt-claim__text">${claim.text}</p>
      <${Polygraph} k=${k} sig=${sig} open=${open} seed=${hash(`${run.id}:${k}`)} />
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
      <button type="button" class=${`tt-pick${yours ? ' tt-pick--on' : ''}`} disabled=${!open}
        aria-pressed=${yours} onClick=${() => onPick(k)}>
        ${yours ? `Your pick: this one's the lie${mark}` : "This one's the lie"}
      </button>
    <//>
  `
}

const W = 360
const H = 84

/** The polygraph strip: a pen that wanders for a truth and jumps for a lie.
 *  While sealed it idles, a scan line sweeping; unsealed, the trace draws in. */
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
  return html`
    <div class="tt-poly">
      <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${label}>
        <rect class="tt-poly__bg" width=${W} height=${H} />
        <g class="tt-poly__grid">
          ${[21, 42, 63].map((y) => html`<line key=${`h${y}`} x1="0" y1=${y} x2=${W} y2=${y} />`)}
          ${[60, 120, 180, 240, 300].map((x) => html`<line key=${`v${x}`} x1=${x} y1="0" x2=${x} y2=${H} class="tt-poly__tick" />`)}
        </g>
        ${open
          ? html`
              <polyline class="tt-trace tt-trace--idle" points=${pointsAttr(pts)} />
              <rect class="tt-scan" x="0" y="0" width="2" height=${H} />`
          : html`
              <polyline key="live" class=${`tt-trace tt-trace--draw tt-s-${tone}`} points=${pointsAttr(pts)}
                style=${{ '--len': traceLength(pts) }} />
              <circle key="pen" class=${`tt-pen tt-f-${tone}`} cx=${end[0] - 3} cy=${end[1]} r="3.5" />`}
      </svg>
      <span class=${`tt-poly__p g-mono${open ? '' : ` tt-t-${tone}`}`}>
        ${open ? 'p(contradicted) ?' : sig.source === 'jev' ? `p(contradicted) ${fmtProb(sig.p)}` : sig.source ? `judges ${Math.round(sig.p * 100)}%` : '—'}
      </span>
    </div>
  `
}

/** Jev's three probabilities for one claim, or where they are. */
function JevVerdict({ lane, k, open, many }) {
  const v = lane.verdicts?.[k]
  const who = many && html`<${LaneNum} i=${lane.index} /> `
  if (!v) {
    const why = lane.status === 'error' ? 'could not check it' : 'checking…'
    return html`<p class="tt-wait g-mono">${who}${lane.label} ${why}</p>`
  }
  if (open) {
    return html`<p class="tt-wait g-mono">${who}${lane.label} answered in ${fmtMs(lane.ms)} · sealed until you pick</p>`
  }
  const top = topVerdict(v)
  const tone = { supported: 'ok', contradicted: 'err' }
  return html`
    <div class="tt-jev">
      ${many && html`<span class="tt-jev__who">${who}${lane.label}</span>`}
      <${Bars} lane=${lane.index} compact max=${3}
        items=${VERDICTS.map((key) => ({ label: VERDICT_LABEL[key], p: v[key], strong: key === top, tone: tone[key] }))} />
    </div>
  `
}

/** The timing line and the session tally, with the next round. */
function ScoreBar({ run, mine, open, yourMs, tally, onSkip, onNext, starting, startError }) {
  const jev = run.lanes.find((ln) => ln.kind === 'judgment' && Number.isFinite(ln.ms))
  const byLabel = new Map(run.lanes.map((ln) => [ln.label, ln.index]))
  return html`
    <${Box} class="tt-bar">
      <span class="g-mono tt-bar__jev">
        ${jev
          ? html`<b class=${`tt-who g-l${(jev.index % 4) + 1}`}>${jev.label}</b> checked all three in <b>${fmtMs(jev.ms)}</b>`
          : html`<span class="g-muted">the judges are reading…</span>`}
      </span>
      <span class="g-mono g-muted" aria-live="polite">
        ${open ? `you: still reading, ${fmtMs(yourMs)}` : mine?.skipped ? 'you asked to be shown' : `you took ${fmtMs(yourMs)}`}
      </span>
      ${open && html`<${Button} variant="ghost" size="sm" onClick=${onSkip}>Show me<//>`}
      <span class="spacer" />
      <div class="tt-tally">
        ${tally.rounds
          ? html`
              <${Label}>AFTER ${tally.rounds} ROUND${tally.rounds === 1 ? '' : 'S'}<//>
              <span class="g-mono">You ${tally.you.found}/${tally.you.played}</span>
              ${tally.judges.map((j) => html`
                <span key=${j.label} class=${`g-mono tt-tally__j${byLabel.has(j.label) ? ` g-l${(byLabel.get(j.label) % 4) + 1}` : ''}`}>
                  ${byLabel.has(j.label) && html`<i class="tt-swatch" aria-hidden="true" />`}${j.label} ${j.found}/${j.rounds}${j.kind !== 'judgment' && Number.isFinite(j.ms) ? ` · ${fmtMs(j.ms)} a round` : ''}
                </span>`)}`
          : html`<span class="g-mono g-muted">the session's first round</span>`}
      </div>
      <${Button} variant="primary" onClick=${onNext} disabled=${starting || isRunLive(run)}>
        ${starting ? 'Writing…' : 'Next article'}
      <//>
    <//>
    ${startError && html`<p class="g-t-err tt-starterr">${startError}</p>`}
  `
}

/** A judge's lane: what it picked, why, whether it found the lie, what it cost. */
function JudgeCard({ lane, run, open }) {
  const answered = Number.isFinite(lane.ms)
  const revealed = !open && Number.isInteger(run.lie)
  let body
  if (!answered) {
    body = html`<p class="g-muted">${lane.status === 'error' ? 'could not judge' : lane.kind === 'judgment' ? 'checking the three claims…' : 'reading the article…'}</p>`
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
  return html`
    <${Box} lane=${lane.index} class="tt-judge">
      <${LaneHead} lane=${lane} />
      <div class="tt-judge__row">
        <div class="tt-judge__score">
          <span class="tnum">${revealed && lane.score != null ? lane.score : '–'}</span><small>found</small>
        </div>
        <div class="tt-judge__body">
          ${body}
          ${verdict && html`<p class=${`tt-verdict g-t-${verdict.tone}`}>${verdict.text}</p>`}
        </div>
      </div>
      <${LaneStats} lane=${lane} />
    <//>
  `
}
