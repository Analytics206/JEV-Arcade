/* Slot Machine — one borderline post, pulled again and again: does the verdict hold still?
 *
 * TypeSafe's self-consistency cookbooks as a one-armed bandit. The server
 * (games/slots.py) sends the same post to every lane `pulls` times, three
 * requests to a lever pull; this page draws one machine per lane: a cabinet
 * whose three reels spin while their pull is in flight and stop on its
 * verdict, a lever that drops while they spin, every pull as a chip in a
 * strip, how often the lane agreed with itself, and for Jev its probabilities
 * pull by pull against the "uncertain" line. The pure half is slots.logic.js.
 */
import { useEffect, useState } from 'preact/hooks'
import { Button } from '../ui.js'
import {
  Box,
  Chip,
  GameFrame,
  Label,
  LaneHead,
  LaneStats,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  againOf,
  html,
  startGame,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, fmtPct, isLaneLive, isRunLive, playersProblem } from './runstate.js'
import {
  LABELS,
  agreementTone,
  band,
  byPull,
  caption,
  chipsOf,
  flips,
  jackpot,
  nextPost,
  outcomeOf,
  reelsOf,
  share,
  spreadText,
} from './slots.logic.js'

const PULLS = [6, 9, 15, 21, 30]
const REEL_X = [34, 136, 238]
const REEL_Y = 60
const REEL = 92
/** The symbols on a spinning reel's strip, twice over so it loops seamlessly. */
const STRIP = ['allow', 'warn', 'remove', 'uncertain', 'allow', 'warn', 'remove', 'uncertain']

export default function Slots({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const posts = game.params?.properties?.post?.['x-posts'] ?? []
  const [lanes, setLanes] = useState([])
  const [post, setPost] = useState('')
  const [pulls, setPulls] = useState(15)
  const [threshold, setThreshold] = useState(0.6)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { post: post === '' ? null : Number(post), pulls, threshold })
  const chosen = post === '' ? null : posts[Number(post)]

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="sl-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <label class="g-field"><span>The post</span>
            <select class="wr-sel" value=${post} onChange=${(e) => setPost(e.currentTarget.value)}>
              <option value="">A random one</option>
              ${posts.map((p, i) => html`<option key=${i} value=${String(i)}>${i + 1} · ${clip(p.text, 56)}</option>`)}
            </select>
          </label>
          ${chosen && html`<p class="sl-setup__post">“${chosen.text}” <span class="g-muted">in ${chosen.where}</span></p>`}
          <div class="sl-params">
            <label class="g-field"><span>Pulls</span>
              <select class="wr-sel" value=${pulls} onChange=${(e) => setPulls(Number(e.currentTarget.value))}>
                ${PULLS.map((n) => html`<option key=${n} value=${n}>${n}</option>`)}
              </select>
            </label>
            <label class="g-field sl-thr"><span>Uncertain under</span>
              <input type="range" min="0.4" max="0.9" step="0.05" value=${threshold}
                onInput=${(e) => setThreshold(Number(e.currentTarget.value))} aria-label="Jev's uncertain threshold" />
              <b class="tnum">${threshold.toFixed(2)}</b>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Pull the levers" />
        <//>
        <div class="sl-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              One borderline forum post, a figurative threat or a harsh review, is judged again and again with
              exactly the same words. Each lane has a slot machine: a pull of the lever sends three separate
              requests, one per reel, and each reel stops on its verdict: <b>allow</b>, <b>warn</b> or <b>remove</b>.
              A judge worth automating lands on the same answer every time.
            </p>
            <p class="g-explain">
              <b>Jev</b> answers a Choice over the three and code reads its top probability: under the threshold
              the pull is <b>uncertain</b> and a human decides. A <b>text model</b> answers in words, <code>VERDICT:
              allow | warn | remove</code>, and anything else is a foul.
            </p>
            <div class="sl-chips">
              ${LABELS.map((lb) => html`<${Chip} key=${lb} tone=${chipTone(lb)}>${outcomeOf(lb).glyph} ${lb}<//>`)}
              <${Chip} tone="cy">? uncertain → a human<//>
              <${Chip} tone="err">∅ foul<//>
            </div>
            <p class="g-explain sl-cook">${cookbookLine()}</p>
          <//>
          <${RecentRuns} gameId=${game.id}
            render=${(r) => html`<span class="g-mono g-muted">${r.post ? `post ${r.post.index + 1}` : ''}${r.total ? ` · ${r.total} pulls` : ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const chipTone = (o) => ({ ok: 'ok', warn: 'warn', err: 'err', vi: 'cy', foul: 'err' })[outcomeOf(o).tone]
function cookbookLine(c = { agreement_raw: 0.908, agreement_uncertain: 0.992, decided: 0.742 }) {
  return `TypeSafe's own self-consistency cookbook: with “uncertain” allowed, agreement across repeats went from ${fmtPct(c.agreement_raw, 1)} to ${fmtPct(c.agreement_uncertain, 1)}, and ${fmtPct(c.decided, 1)} of answers were still decided automatically.`
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const live = isRunLive(run)
  const now = useNow(live)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">post ${run.post.index + 1} of ${run.posts} · ${run.total} pulls · uncertain under ${run.threshold.toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${Post} run=${run} />
      <div class="sl-machines">
        ${run.lanes.map((ln) => html`<${Machine} key=${ln.index} run=${run} lane=${ln} live=${live} />`)}
      </div>
      <${Cookbook} run=${run} live=${live} />
    <//>
  `
}

function Post({ run }) {
  const b = run.borderline
  return html`
    <${Box} class="sl-post">
      <${Label} note=${`posted in ${run.post.where}`}>ONE BORDERLINE POST · PULLED ${run.total} TIMES<//>
      <p class="sl-post__text">“${run.post.text}”</p>
      <p class="g-mono g-muted sl-post__labels">
        ${`labels: allow · warn · remove · and for Jev, uncertain when its top pick is under ${run.threshold.toFixed(2)}`}
      </p>
      ${b && html`
        <p class="sl-post__why">
          <b>${`Borderline between ${b.between[0]} and ${b.between[1]}.`}</b>${` ${b.note}`}
        </p>
      `}
    <//>
  `
}

/* ── One machine per lane ──────────────────────────────────────────────────── */

function Machine({ run, lane, live }) {
  const jev = lane.kind === 'judgment'
  const going = live && isLaneLive(lane)
  // A reel spins only while its lane is still playing.
  const reels = reelsOf(lane, run.reels ?? 3).map((r) => (going ? r : { ...r, spinning: false }))
  const spinning = reels.some((r) => r.spinning)
  const n = (lane.pulls ?? []).length
  const agree = lane.agreement ?? 0
  const tally = lane.tally ?? {}
  return html`
    <${Box} lane=${lane.index} class="sl-machine">
      <${LaneHead} lane=${lane} />
      <${Cabinet} lane=${lane} reels=${reels} spinning=${spinning} total=${run.total} done=${n} />
      <p class="g-mono g-muted sl-caption">${caption(lane, run.threshold)}</p>
      <${Strip} lane=${lane} total=${run.total} live=${live} />
      <div class="sl-agree">
        <span class="sl-agree__tally g-mono">
          ${[...LABELS, 'uncertain', 'foul']
            .filter((o) => tally[o] || LABELS.includes(o) || (o === 'uncertain' && jev))
            .map((o) => `${outcomeOf(o).glyph} ${o} ${tally[o] ?? 0}`)
            .join(' · ')}
        </span>
        <span class=${`sl-agree__same g-mono g-t-${agreementTone(n ? agree : NaN)}`}>
          ${n ? `same answer ${share(agree, n)}` : 'no pulls yet'}
        </span>
      </div>
      <div class="g-stats sl-numbers">
        <${Num} k="agreement" v=${n ? fmtPct(agree, 1) : '—'} big />
        ${jev && html`<${Num} k="top pick alone" v=${n ? fmtPct(lane.raw_agreement, 1) : '—'} />`}
        <${Num} k="decided automatically" v=${n ? `${lane.decided}/${n}` : '—'} />
        <${Num} k="changed its mind" v=${n > 1 ? `${flips(lane)}×` : '—'} />
      </div>
      ${jev ? html`<${Band} run=${run} lane=${lane} />` : html`<${Said} lane=${lane} />`}
      <${LaneStats} lane=${lane} />
    <//>
  `
}

function Num({ k, v, big }) {
  return html`<div class=${`g-stat${big ? ' sl-num--big' : ''}`}><span class="g-stat__k">${k}</span><span class="g-stat__v tnum">${v}</span></div>`
}

/** The cabinet: a marquee, three reels behind glass, a payline, a lever. */
function Cabinet({ lane, reels, spinning, total, done }) {
  const win = jackpot(reels)
  const spins = reels.filter((r) => r.spinning).map((r) => r.n + 1)
  const marquee = win
    ? `THREE IN A ROW · ${outcomeOf(win).word}`
    : spinning
      ? spins.length > 1
        ? `PULLS ${Math.min(...spins)}–${Math.max(...spins)} OF ${total}`
        : `PULL ${spins[0]} OF ${total}`
      : done
        ? `${done} OF ${total} PULLED`
        : 'READY'
  const aria =
    `${lane.label}'s machine: ` +
    reels.map((r) => (r.spinning ? `reel ${r.reel + 1} spinning` : r.pull ? `reel ${r.reel + 1} ${r.pull.outcome}` : `reel ${r.reel + 1} empty`)).join(', ')
  const id = `sl-${lane.index}`
  return html`
    <svg class=${`sl-cabinet${win ? ' sl-cabinet--win' : ''}${spinning ? ' sl-cabinet--spin' : ''}`} viewBox="0 0 400 200" role="img" aria-label=${aria}>
      <defs>
        ${REEL_X.map((x, r) => html`<clipPath key=${r} id=${`${id}-clip-${r}`}><rect x=${x} y=${REEL_Y} width=${REEL} height=${REEL} rx="4" /></clipPath>`)}
      </defs>
      <rect x="8" y="8" width="344" height="184" rx="16" class="sl-body" />
      <rect x="24" y="18" width="312" height="26" rx="5" class="sl-marquee" />
      <text x="180" y="36" class="sl-marquee__t">${marquee}</text>
      <rect x="24" y="52" width="312" height="108" rx="8" class="sl-window" />
      ${reels.map((r) => html`<${Reel} key=${r.reel} r=${r} clip=${`url(#${id}-clip-${r.reel})`} />`)}
      <line x1="28" y1="106" x2="332" y2="106" class="sl-payline" />
      <rect x="130" y="168" width="100" height="14" rx="3" class="sl-tray" />
      <rect x="352" y="96" width="16" height="28" rx="3" class="sl-lever__base" />
      <g class=${`sl-lever${spinning ? ' sl-lever--down' : ''}`}>
        <line x1="372" y1="110" x2="372" y2="38" class="sl-lever__arm" />
        <circle cx="372" cy="30" r="11" class="sl-lever__ball" />
      </g>
    </svg>
  `
}

function Reel({ r, clip }) {
  const x = REEL_X[r.reel]
  if (r.spinning) {
    return html`
      <g clip-path=${clip}>
        <rect x=${x} y=${REEL_Y} width=${REEL} height=${REEL} rx="4" class="sl-cell sl-cell--blank" />
        <g class="sl-spin" style=${{ animationDelay: `${-0.13 * r.reel}s` }}>
          ${STRIP.map((o, k) => html`
            <g key=${k}>
              <rect x=${x + 4} y=${REEL_Y + k * REEL + 4} width=${REEL - 8} height=${REEL - 8} rx="3" class=${`sl-cell sl-tone--${outcomeOf(o).tone}`} />
              <text x=${x + REEL / 2} y=${REEL_Y + k * REEL + 56} class="sl-cell__glyph">${outcomeOf(o).glyph}</text>
            </g>
          `)}
        </g>
        <text x=${x + REEL / 2} y=${REEL_Y + 54} class="sl-cell__wait">…</text>
      </g>
    `
  }
  if (!r.pull) {
    return html`
      <rect x=${x} y=${REEL_Y} width=${REEL} height=${REEL} rx="4" class="sl-cell sl-cell--blank" />
      <text x=${x + REEL / 2} y=${REEL_Y + 54} class="sl-cell__none">—</text>
    `
  }
  const o = outcomeOf(r.pull.outcome)
  return html`
    <g class="sl-landed">
      <rect x=${x} y=${REEL_Y} width=${REEL} height=${REEL} rx="4" class=${`sl-cell sl-tone--${o.tone}`} />
      <text x=${x + REEL / 2} y=${REEL_Y + 48} class="sl-cell__glyph">${o.glyph}</text>
      <text x=${x + REEL / 2} y=${REEL_Y + 74} class="sl-cell__word">${o.word}</text>
      <text x=${x + REEL - 6} y=${REEL_Y + 14} class="sl-cell__n">#${r.pull.n + 1}</text>
    </g>
  `
}

/** Every pull as a chip, in order: its glyph and colour, or still to come. */
function Strip({ lane, total, live }) {
  const chips = chipsOf(lane, total)
  return html`
    <ol class="sl-strip" style=${{ gridTemplateColumns: `repeat(${total}, minmax(0, 1fr))` }} aria-label=${`${lane.label}: every pull, in order`}>
      ${chips.map((c) => {
        const o = c.pull ? outcomeOf(c.pull.outcome) : null
        const p = c.pull?.top_p
        const what = c.pull
          ? `${c.pull.outcome}${Number.isFinite(p) ? ` (top pick ${c.pull.top} ${p.toFixed(2)})` : c.pull.said && c.pull.outcome === 'foul' ? ` (said “${c.pull.said}”)` : ''}`
          : c.spinning && live ? 'spinning' : 'to come'
        return html`
          <li key=${c.n} class=${`sl-chip${o ? ` sl-tone--${o.tone}` : c.spinning && live ? ' sl-chip--spin' : ' sl-chip--empty'}`} title=${`pull ${c.n + 1}: ${what}`}>
            <span aria-hidden="true">${o ? o.glyph : ''}</span><span class="sr-only">${`pull ${c.n + 1}: ${what}`}</span>
          </li>
        `
      })}
    </ol>
  `
}

/** Jev's probabilities pull by pull: a line and a band per label, the threshold across. */
function Band({ run, lane }) {
  const W = 360
  const H = 110
  const b = band(lane, run.total, run.threshold, { w: W, h: H, left: 34, right: 10, top: 10, bottom: 22 })
  const spread = spreadText(lane.spread)
  return html`
    <div class="sl-band">
      <${Label} note=${spread || 'waiting for the first pull'}>JEV'S PROBABILITIES, PULL BY PULL<//>
      <svg viewBox=${`0 0 ${W} ${H}`} role="img"
        aria-label=${`Jev's probability for each verdict over ${(lane.pulls ?? []).length} pulls${spread ? `: ${spread}` : ''}; the uncertain line at ${run.threshold.toFixed(2)}`}>
        ${[0, 0.5, 1].map((v) => html`
          <g key=${v}>
            <line x1=${b.x0} y1=${b.y(v)} x2=${b.x1} y2=${b.y(v)} class="sl-band__grid" />
            <text x=${b.x0 - 6} y=${b.y(v) + 3} class="sl-band__axis">${v.toFixed(1)}</text>
          </g>
        `)}
        ${b.series.map((s) => s.band && html`
          <rect key=${`b${s.label}`} x=${b.x0} y=${s.band.y0 - 1.5} width=${b.x1 - b.x0} height=${Math.max(3, s.band.y1 - s.band.y0 + 3).toFixed(1)}
            class=${`sl-band__zone sl-tone--${outcomeOf(s.label).tone}`} />
        `)}
        <line x1=${b.x0} y1=${b.threshold} x2=${b.x1} y2=${b.threshold} class="sl-band__thr" />
        <text x=${b.x1} y=${b.threshold - 4} class="sl-band__thr-t">${`uncertain under ${run.threshold.toFixed(2)}`}</text>
        ${b.series.map((s) => html`
          <g key=${s.label} class=${`sl-band__line sl-tone--${outcomeOf(s.label).tone}`}>
            ${s.points.length > 1 && html`<polyline points=${s.points.map((p) => p.join(',')).join(' ')} />`}
            ${s.points.map((p, k) => html`<circle key=${k} cx=${p[0]} cy=${p[1]} r="2.6" />`)}
          </g>
        `)}
        ${b.uncertain.map((x, k) => html`<text key=${`u${k}`} x=${x} y=${H - 6} class="sl-band__q">?</text>`)}
      </svg>
      <p class="sl-band__key g-mono">
        ${LABELS.map((lb) => html`<span key=${lb} class=${`sl-key sl-tone--${outcomeOf(lb).tone}`}>${`${outcomeOf(lb).glyph} ${lb}`}</span>`)}
        <span class="sl-key sl-tone--vi">? went to a human</span>
      </p>
    </div>
  `
}

/** What the text model said on its latest pull. */
function Said({ lane }) {
  const ps = byPull(lane)
  const last = ps[ps.length - 1]
  return html`
    <div class="sl-said">
      <${Label} note=${last ? `pull ${last.n + 1}` : ''}>WHAT IT SAID LAST<//>
      ${last
        ? html`<div class="sl-said__box g-mono">
            <div>REASON: ${last.reason || '—'}</div>
            <div class=${last.outcome === 'foul' ? 'g-t-err' : ''}>VERDICT: ${last.said || '—'}</div>
          </div>`
        : html`<p class="g-muted">Nothing yet.</p>`}
    </div>
  `
}

/** The cookbook's published result, this round's Jev beside it, and the next post. */
function Cookbook({ run, live }) {
  const jevs = run.lanes.filter((ln) => ln.kind === 'judgment' && (ln.pulls ?? []).length)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const next = async () => {
    setBusy(true)
    setErr(null)
    try {
      await startGame(run.game, run.lanes.map((l) => ({ key: l.key })), { ...run.params, post: nextPost(run.post.index, run.posts), seed: null })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return html`
    <div class="sl-cookbook">
      <div class="sl-cookbook__text">
        <p>${cookbookLine(run.cookbook)}</p>
        ${jevs.map((ln) => {
          const n = ln.pulls.length
          return html`<p key=${ln.index} class="g-mono sl-cookbook__us">
            ${`This post, ${ln.label}: its top pick alone agreed ${fmtPct(ln.raw_agreement, 1)}; with uncertain, ${fmtPct(ln.agreement, 1)}; ${ln.decided} of ${n} decided automatically.`}
          </p>`
        })}
        ${err && html`<p class="g-t-err">${err}</p>`}
      </div>
      ${!live && html`<${Button} variant="primary" onClick=${next} disabled=${busy}>${busy ? 'Starting…' : 'Next post'}<//>`}
    </div>
  `
}
