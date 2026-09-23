/* Slot Machine — one borderline post, pulled again and again: does the verdict hold still?
 *
 * TypeSafe's self-consistency cookbooks as a one-armed bandit. The server
 * (games/slots.py) sends the same post to every lane `pulls` times, three
 * requests to a lever pull; this page draws one machine per lane: a chrome
 * cabinet with a marquee of bulbs, three cream reels behind glass that spin
 * while their pull is in flight and clunk to a stop on its verdict, a lever
 * that is yanked for every pull, a payline that lights on three in a row and a
 * coin in the tray for each; every pull as a chip, three to a lever; how often
 * the lane agreed with itself; and for Jev its probabilities pull by pull
 * against the "uncertain" line. When a lane is done its marquee says JACKPOT
 * (the verdict held on every pull) or TILT (it wobbled). The pure half is
 * slots.logic.js.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { Button } from '../ui.js'
import {
  Box,
  Counter,
  GameFrame,
  LANE_COLORS,
  Label,
  LaneHead,
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
  finale,
  flips,
  held,
  jackpot,
  leversOf,
  nextPost,
  outcomeOf,
  reelsOf,
  share,
  spreadText,
} from './slots.logic.js'

const PULLS = [6, 9, 15, 21, 30]
/* The cabinet, in its own units (viewBox 0 0 400 300). */
const REEL_X = [50, 138, 226]
const REEL_Y = 98
const REEL_W = 84
const REEL_H = 104
const PAY_Y = REEL_Y + REEL_H / 2
/** The symbols on a spinning reel's strip, twice over so it loops seamlessly. */
const STRIP = ['allow', 'warn', 'remove', 'uncertain', 'allow', 'warn', 'remove', 'uncertain']
/** The marquee's bulbs: a row along the top of the arch, two down each side. */
const BULBS = [
  ...Array.from({ length: 12 }, (_, i) => [70 + i * 20, 20]),
  [46, 42], [46, 62], [314, 42], [314, 62],
]
const pct1 = (v) => `${v.toFixed(1)}%`

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
          ${chosen && html`<p class="sl-ticket" key=${post}>“${chosen.text}” <span class="g-muted">in ${chosen.where}</span></p>`}
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
          <${Box} class="sl-how">
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
            <${Symbols} threshold=${threshold} />
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
function cookbookLine(c = { agreement_raw: 0.908, agreement_uncertain: 0.992, decided: 0.742 }) {
  return `TypeSafe's own self-consistency cookbook: with “uncertain” allowed, agreement across repeats went from ${fmtPct(c.agreement_raw, 1)} to ${fmtPct(c.agreement_uncertain, 1)}, and ${fmtPct(c.decided, 1)} of answers were still decided automatically.`
}

/** What can come up on a reel, as a slot machine's glass shows its symbols. */
function Symbols({ threshold }) {
  const rows = [
    ['allow', 'the post stays up'],
    ['warn', 'it stays up, and its author is warned'],
    ['remove', 'the post is taken down'],
    ['uncertain', `Jev's top pick is under ${threshold.toFixed(2)}: a human decides`],
    ['foul', 'a text model named no verdict'],
  ]
  return html`
    <div class="sl-symbols">
      <div class="sl-symbols__hd"><${PixelText} text="ON THE REELS" label="On the reels" /></div>
      <ul class="sl-symbols__list">
        ${rows.map(([o, what]) => {
          const oc = outcomeOf(o)
          return html`
            <li key=${o} class=${`sl-sym-row sl-tone--${oc.tone}`}>
              <span class="sl-tile" aria-hidden="true">${oc.glyph}</span><b class="sl-sym-row__w">${oc.word}</b><span class="sl-sym-row__what">${what}</span>
            </li>
          `
        })}
        <li class="sl-sym-row sl-sym-row--three sl-tone--ok">
          <span class="sl-tiles" aria-hidden="true"><span class="sl-tile">✓</span><span class="sl-tile">✓</span><span class="sl-tile">✓</span></span><b class="sl-sym-row__w">THREE IN A ROW</b><span class="sl-sym-row__what">one lever pull, the same verdict on all three reels: a coin in the tray</span>
        </li>
      </ul>
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const live = isRunLive(run)
  const now = useNow(live)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const fin = finale(run)
  const over = !live && run.status === 'finished'
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub} win=${fin.win ?? true}>
        <span class="g-mono g-muted">post ${run.post.index + 1} of ${run.posts} · ${run.total} pulls · uncertain under ${run.threshold.toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <${Post} run=${run} />
      <div class="sl-machines">
        ${run.lanes.map((ln) => html`<${Machine} key=${ln.index} run=${run} lane=${ln} live=${live} win=${over && fin.winners.includes(ln.index)} />`)}
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
      <blockquote class="sl-post__text">${run.post.text}</blockquote>
      <p class="g-mono g-muted sl-post__labels">
        ${`labels: allow · warn · remove · and for Jev, uncertain when its top pick is under ${run.threshold.toFixed(2)}`}
      </p>
      ${b && html`
        <p class="sl-post__why">
          <span class="sl-post__why-k" aria-hidden="true">WHY IT'S BORDERLINE</span>
          <b>${`Borderline between ${b.between[0]} and ${b.between[1]}.`}</b>${` ${b.note}`}
        </p>
      `}
    <//>
  `
}

/* ── One machine per lane ──────────────────────────────────────────────────── */

function Machine({ run, lane, live, win }) {
  const jev = lane.kind === 'judgment'
  const going = live && isLaneLive(lane)
  const reelsN = run.reels ?? 3
  // A reel spins only while its lane is still playing.
  const reels = reelsOf(lane, reelsN).map((r) => (going ? r : { ...r, spinning: false }))
  const levers = leversOf(lane, run.total, reelsN)
  const n = (lane.pulls ?? []).length
  const ended = !going && lane.status === 'done' && n > 0
  const steady = ended && held(lane)
  const wrap = useRef(null)
  const was = useRef(going)
  // The moment a machine you are watching finishes with its verdict held: coins.
  useEffect(() => {
    if (was.current && !going && lane.status === 'done' && held(lane)) {
      burstFrom(wrap.current, { colors: [LANE_COLORS[lane.index % 4], '#ffe14d', '#ffffff'], count: 48, power: 0.75 })
    }
    was.current = going
  }, [going])
  return html`
    <${Box} lane=${lane.index} class=${`sl-machine${win ? ' sl-machine--win' : ''}`}>
      ${win && html`<span class="sl-machine__crown"><span aria-hidden="true">★</span> STEADIEST</span>`}
      <${LaneHead} lane=${lane} />
      <div class=${`sl-cabwrap${ended ? (steady ? ' sl-cabwrap--held' : ' sl-cabwrap--tilt') : ''}`} ref=${wrap}>
        <${Cabinet} lane=${lane} reels=${reels} levers=${levers} total=${run.total} done=${n} ended=${ended} steady=${steady} going=${going} />
        ${ended && html`
          <div class=${`sl-sign sl-sign--${steady ? 'held' : 'tilt'}`}>
            <${PixelText} text=${steady ? 'JACKPOT' : 'TILT'} label=${steady ? 'Jackpot: the verdict held' : 'Tilt: the verdict wobbled'} />
          </div>
        `}
      </div>
      <p class="g-mono g-muted sl-caption">${caption(lane, run.threshold)}</p>
      <${Strip} lane=${lane} levers=${levers} live=${live} />
      <${Score} lane=${lane} jev=${jev} />
      <div class="g-stats sl-numbers">
        ${jev && html`<${Stat} label="top pick alone" value=${n ? fmtPct(lane.raw_agreement, 1) : '—'} />`}
        <${Stat} label="decided automatically" value=${n ? `${lane.decided}/${n}` : '—'} />
        <${Stat} label="changed its mind" value=${n > 1 ? `${flips(lane)}×` : '—'} tone=${n > 1 && flips(lane) ? 'warn' : undefined} />
      </div>
      ${jev ? html`<${Band} run=${run} lane=${lane} />` : html`<${Said} lane=${lane} />`}
      <${LaneStats} lane=${lane} />
    <//>
  `
}

/** The cabinet: a marquee of bulbs, three reels behind glass on a payline, an
 *  LED readout, a coin tray and a lever. */
function Cabinet({ lane, reels, levers, total, done, ended, steady, going }) {
  const now = jackpot(reels)
  const spinning = reels.some((r) => r.spinning)
  const spins = reels.filter((r) => r.spinning).map((r) => r.n + 1)
  const wins = levers.filter((g) => g.win)
  const lastWin = wins[wins.length - 1]
  const marquee = ended
    ? ''
    : now
      ? `THREE IN A ROW · ${outcomeOf(now).word}`
      : spinning
        ? spins.length > 1
          ? `PULLS ${Math.min(...spins)}–${Math.max(...spins)} OF ${total}`
          : `PULL ${spins[0]} OF ${total}`
        : done
          ? `${done} OF ${total} PULLED`
          : 'READY'
  const ledText = ended
    ? steady
      ? `VERDICT HELD · ${share(lane.agreement, done)}`
      : `WOBBLED · ${share(lane.agreement, done)} THE SAME`
    : `LEVER ${lane.lever ?? 0}/${levers.length} · ★ ${wins.length}`
  const aria =
    `${lane.label}'s machine: ` +
    reels.map((r) => (r.spinning ? `reel ${r.reel + 1} spinning` : r.pull ? `reel ${r.reel + 1} ${r.pull.outcome}` : `reel ${r.reel + 1} empty`)).join(', ') +
    `; ${wins.length} of ${levers.filter((g) => g.landed).length} lever pulls three in a row` +
    (ended ? `; the verdict ${steady ? 'held' : 'wobbled'}` : '')
  const id = `sl-${lane.index}`
  const state = ended ? (steady ? ' sl-cab--held' : ' sl-cab--tilt') : spinning ? ' sl-cab--spin' : now ? ' sl-cab--jackpot' : ''
  return html`
    <svg class=${`sl-cab${state}`} viewBox="0 0 400 300" role="img" aria-label=${aria}>
      <defs>
        ${REEL_X.map((x, r) => html`<clipPath key=${r} id=${`${id}-clip-${r}`}><rect x=${x} y=${REEL_Y} width=${REEL_W} height=${REEL_H} rx="5" /></clipPath>`)}
        <linearGradient id=${`${id}-chrome`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" /><stop offset=".2" stop-color="#b9bfe6" /><stop offset=".5" stop-color="#4b4f7e" />
          <stop offset=".64" stop-color="#9aa0cf" /><stop offset="1" stop-color="#2b2d52" />
        </linearGradient>
        <linearGradient id=${`${id}-chromeh`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#4b4f7e" /><stop offset=".35" stop-color="#f4f5ff" /><stop offset=".6" stop-color="#9aa0cf" /><stop offset="1" stop-color="#2b2d52" />
        </linearGradient>
        <linearGradient id=${`${id}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="sl-st-body0" /><stop offset=".55" class="sl-st-body1" /><stop offset="1" class="sl-st-body2" />
        </linearGradient>
        <linearGradient id=${`${id}-top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="sl-st-top0" /><stop offset="1" class="sl-st-top1" />
        </linearGradient>
        <linearGradient id=${`${id}-drum`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#cfc6ee" /><stop offset=".5" stop-color="#fbf9ff" /><stop offset="1" stop-color="#cfc6ee" />
        </linearGradient>
        <linearGradient id=${`${id}-shade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#07051a" stop-opacity=".88" /><stop offset=".24" stop-color="#07051a" stop-opacity="0" />
          <stop offset=".5" stop-color="#ffffff" stop-opacity=".12" /><stop offset=".76" stop-color="#07051a" stop-opacity="0" />
          <stop offset="1" stop-color="#07051a" stop-opacity=".88" />
        </linearGradient>
        <radialGradient id=${`${id}-ball`} cx=".35" cy=".3" r=".75">
          <stop offset="0" stop-color="#ffffff" /><stop offset=".25" class="sl-st-ball0" /><stop offset="1" class="sl-st-ball1" />
        </radialGradient>
        <radialGradient id=${`${id}-coin`} cx=".38" cy=".32" r=".7">
          <stop offset="0" stop-color="#fffbe0" /><stop offset=".45" stop-color="#ffe14d" /><stop offset="1" stop-color="#a87a00" />
        </radialGradient>
      </defs>

      <path d="M34 78 V44 Q34 10 68 10 H292 Q326 10 326 44 V78 Z" fill=${`url(#${id}-top)`} stroke=${`url(#${id}-chrome)`} stroke-width="3" />
      <rect x="62" y="30" width="236" height="34" rx="7" class="sl-marquee" />
      <text x="180" y="52" class="sl-marquee__t">${marquee}</text>
      <g class="sl-bulbs" aria-hidden="true">
        ${BULBS.map(([x, y], i) => html`<circle key=${i} cx=${x} cy=${y} r="3.8" class=${`sl-bulb sl-bulb--${i % 3}`} />`)}
      </g>

      <rect x="20" y="70" width="320" height="222" rx="18" fill=${`url(#${id}-body)`} stroke=${`url(#${id}-chrome)`} stroke-width="3" />
      <rect x="28" y="78" width="304" height="206" rx="13" class="sl-body__inner" />

      <rect x="36" y="86" width="288" height="128" rx="12" fill=${`url(#${id}-chrome)`} />
      <rect x="42" y="92" width="276" height="116" rx="8" class="sl-glass" />
      ${reels.map((r) => html`<${Reel} key=${r.reel} r=${r} id=${id} />`)}
      ${now && REEL_X.map((x, k) => html`<rect key=${`rf${k}`} x=${x - 1} y=${REEL_Y - 1} width=${REEL_W + 2} height=${REEL_H + 2} rx="6" class=${`sl-reelframe sl-tone--${outcomeOf(now).tone}`} />`)}
      <line x1="46" y1=${PAY_Y} x2="314" y2=${PAY_Y} class=${`sl-payline${now ? ` sl-payline--on sl-tone--${outcomeOf(now).tone}` : ''}`} />
      ${lastWin && html`
        <g key=${`w${lastWin.lever}`} class=${`sl-winflash sl-tone--${outcomeOf(lastWin.win).tone}`}>
          <rect x="44" y=${PAY_Y - 4} width="272" height="8" rx="4" />
          <text x="30" y=${PAY_Y + 6}>★</text><text x="330" y=${PAY_Y + 6}>★</text>
        </g>
      `}
      <polygon points=${`30,${PAY_Y - 7} 40,${PAY_Y} 30,${PAY_Y + 7}`} class="sl-payarrow" />
      <polygon points=${`330,${PAY_Y - 7} 320,${PAY_Y} 330,${PAY_Y + 7}`} class="sl-payarrow" />
      <path d="M70 92 H114 L84 208 H44 Z" class="sl-sheen" />

      <rect x="70" y="222" width="220" height="24" rx="5" class="sl-led" />
      <text x="180" y="238.5" class="sl-led__t">${ledText}</text>

      <rect x="104" y="252" width="152" height="6" rx="3" fill=${`url(#${id}-chrome)`} />
      <rect x="110" y="256" width="140" height="26" rx="9" class="sl-tray" />
      ${wins.map((g, k) => html`
        <g key=${`coin${g.lever}`} class="sl-coin" style=${{ animationDelay: `${Math.min(k, 9) * 0.02}s` }}>
          <circle cx=${124 + (k % 10) * 12.5} cy="270" r="6.5" fill=${`url(#${id}-coin)`} />
          <circle cx=${124 + (k % 10) * 12.5} cy="270" r="3.8" class="sl-coin__rim" />
        </g>
      `)}

      <rect x="338" y="136" width="18" height="38" rx="4" fill=${`url(#${id}-chromeh)`} />
      <g key=${`lever${lane.lever ?? 0}`} class=${`sl-lever${going && (lane.lever ?? 0) > 0 ? ' sl-lever--yank' : ''}`}>
        <rect x="360.5" y="62" width="7" height="93" rx="3.5" fill=${`url(#${id}-chromeh)`} />
        <circle cx="364" cy="56" r="13" fill=${`url(#${id}-ball)`} class="sl-lever__ball" />
      </g>
      <circle cx="364" cy="155" r="8" fill=${`url(#${id}-chrome)`} class="sl-lever__hub" />
    </svg>
  `
}

/** One reel: a cream drum under a cylinder's shading, and on it the strip
 *  spinning, the verdict it stopped on, or nothing yet. */
function Reel({ r, id }) {
  const x = REEL_X[r.reel]
  const cx = x + REEL_W / 2
  let face
  if (r.spinning) {
    face = html`
      <g class="sl-spin" style=${{ animationDelay: `${-0.11 * r.reel}s` }}>
        ${STRIP.map((o, k) => {
          const oc = outcomeOf(o)
          const cy = REEL_Y + k * REEL_H + REEL_H / 2
          return html`
            <g key=${k} class=${`sl-tone--${oc.tone}`}>
              <text x=${cx} y=${cy + 2} class="sl-sym sl-sym--ghost">${oc.glyph}</text>
              <text x=${cx} y=${cy + 18} class="sl-sym sl-sym--blur">${oc.glyph}</text>
            </g>
          `
        })}
      </g>
      <text x=${cx} y=${PAY_Y + 10} class="sl-wait">…</text>
    `
  } else if (r.pull) {
    const o = outcomeOf(r.pull.outcome)
    face = html`
      <g key=${`l${r.pull.n}`} class=${`sl-stop sl-tone--${o.tone}`}>
        <circle cx=${cx} cy=${PAY_Y} r="27" class="sl-halo" />
        <text x=${cx} y=${PAY_Y + 15} class="sl-sym">${o.glyph}</text>
        <text x=${cx} y=${REEL_Y + REEL_H - 13} class="sl-word">${o.word}</text>
        <text x=${x + REEL_W - 6} y=${REEL_Y + 16} class="sl-no">#${r.pull.n + 1}</text>
      </g>
      <rect key=${`f${r.pull.n}`} x=${x} y=${REEL_Y} width=${REEL_W} height=${REEL_H} class="sl-clunk" />
    `
  } else {
    face = html`<text x=${cx} y=${PAY_Y + 8} class="sl-none">—</text>`
  }
  return html`
    <g clip-path=${`url(#${id}-clip-${r.reel})`}>
      <rect x=${x} y=${REEL_Y} width=${REEL_W} height=${REEL_H} fill=${`url(#${id}-drum)`} />
      ${face}
      <rect x=${x} y=${REEL_Y} width=${REEL_W} height=${REEL_H} fill=${`url(#${id}-shade)`} class="sl-shade" />
    </g>
  `
}

/** Every pull as a chip, three to a lever, in order: its glyph and colour, or
 *  still to come; a lever that came up three in a row is lit. */
function Strip({ lane, levers, live }) {
  return html`
    <ol class="sl-strip" style=${{ gridTemplateColumns: `repeat(${levers.length}, minmax(0, 1fr))` }}
      aria-label=${`${lane.label}: every pull, in order, three to a lever`}>
      ${levers.map((g) => html`
        <li key=${g.lever} class=${`sl-grp${g.win ? ` sl-grp--win sl-tone--${outcomeOf(g.win).tone}` : ''}`}>
          ${g.chips.map((c) => {
            const o = c.pull ? outcomeOf(c.pull.outcome) : null
            const p = c.pull?.top_p
            const spin = !o && c.spinning && live
            const what = c.pull
              ? `${c.pull.outcome}${Number.isFinite(p) ? ` (top pick ${c.pull.top} ${p.toFixed(2)})` : c.pull.said && c.pull.outcome === 'foul' ? ` (said “${c.pull.said}”)` : ''}`
              : spin ? 'spinning' : 'to come'
            return html`
              <span key=${c.n} class=${`sl-chip${o ? ` sl-tone--${o.tone}` : spin ? ' sl-chip--spin' : ' sl-chip--empty'}`} title=${`pull ${c.n + 1}: ${what}`}>
                <span aria-hidden="true">${o ? o.glyph : ''}</span><span class="sr-only">${`pull ${c.n + 1}: ${what}`}</span>
              </span>
            `
          })}
          ${g.win && html`<span class="sr-only">: three in a row</span>`}
        </li>
      `)}
    </ol>
  `
}

/** The lane's score, agreement, as a lit counter, and its outcomes as a
 *  win-line of symbols with their counts; the most common one is starred. */
function Score({ lane, jev }) {
  const n = (lane.pulls ?? []).length
  const tally = lane.tally ?? {}
  const outs = [...LABELS, 'uncertain', 'foul'].filter((o) => tally[o] || LABELS.includes(o) || (o === 'uncertain' && jev))
  const tone = agreementTone(n ? lane.agreement : NaN)
  return html`
    <div class="sl-score">
      <div class=${`sl-score__main sl-agr--${tone}`}>
        <span class="g-stat__k">agreement</span>
        <${Counter} value=${n ? lane.score : NaN} format=${pct1} class="g-score sl-score__v" />
        <span class="sl-score__same g-mono">${n ? `same answer ${share(lane.agreement, n)}` : 'no pulls yet'}</span>
      </div>
      <ol class="sl-pay">
        ${outs.map((o) => {
          const oc = outcomeOf(o)
          const top = n > 0 && lane.consensus === o
          return html`
            <li key=${o} class=${`sl-pay__cell sl-tone--${oc.tone}${top ? ' is-top' : ''}${tally[o] ? '' : ' is-zero'}`} title=${`${o}: ${tally[o] ?? 0}`}>
              ${top && html`<span class="sl-pay__star" aria-hidden="true">★</span>`}
              <span class="sl-pay__sym" aria-hidden="true">${oc.glyph}</span>
              <span class="sl-pay__n"><${Counter} value=${tally[o] ?? 0} /></span>
              <span class="sl-pay__w">${o}${top ? html`<span class="sr-only"> (the most common)</span>` : ''}</span>
            </li>
          `
        })}
      </ol>
    </div>
  `
}

/** Jev's probabilities pull by pull: a line and a band per label, the threshold across. */
function Band({ run, lane }) {
  const W = 360
  const H = 110
  const b = band(lane, run.total, run.threshold, { w: W, h: H, left: 34, right: 10, top: 10, bottom: 22 })
  const spread = spreadText(lane.spread)
  const lastX = Math.max(-1, ...b.series.flatMap((s) => s.points.map((p) => p[0])))
  return html`
    <div class="sl-band">
      <${Label} note=${spread || 'waiting for the first pull'}>JEV'S PROBABILITIES, PULL BY PULL<//>
      <svg viewBox=${`0 0 ${W} ${H}`} role="img"
        aria-label=${`Jev's probability for each verdict over ${(lane.pulls ?? []).length} pulls${spread ? `: ${spread}` : ''}; the uncertain line at ${run.threshold.toFixed(2)}`}>
        <rect x=${b.x0} y=${b.y(1)} width=${b.x1 - b.x0} height=${b.y(0) - b.y(1)} rx="4" class="sl-band__bg" />
        ${[0, 0.5, 1].map((v) => html`
          <g key=${v}>
            <line x1=${b.x0} y1=${b.y(v)} x2=${b.x1} y2=${b.y(v)} class="sl-band__grid" />
            <text x=${b.x0 - 6} y=${b.y(v) + 3} class="sl-band__axis">${v.toFixed(1)}</text>
          </g>
        `)}
        ${lastX >= 0 && html`<line key=${`cur${lastX}`} x1=${lastX} y1=${b.y(1)} x2=${lastX} y2=${b.y(0)} class="sl-band__cur" />`}
        ${b.series.map((s) => s.band && html`
          <rect key=${`b${s.label}`} x=${b.x0} y=${s.band.y0 - 1.5} width=${b.x1 - b.x0} height=${Math.max(3, s.band.y1 - s.band.y0 + 3).toFixed(1)}
            class=${`sl-band__zone sl-tone--${outcomeOf(s.label).tone}`} />
        `)}
        <line x1=${b.x0} y1=${b.threshold} x2=${b.x1} y2=${b.threshold} class="sl-band__thr" />
        <text x=${b.x1} y=${b.threshold - 4} class="sl-band__thr-t">${`uncertain under ${run.threshold.toFixed(2)}`}</text>
        ${b.series.map((s) => html`
          <g key=${s.label} class=${`sl-band__line sl-tone--${outcomeOf(s.label).tone}`}>
            ${s.points.length > 1 && html`<polyline points=${s.points.map((p) => p.join(',')).join(' ')} class="sl-band__glow" />`}
            ${s.points.length > 1 && html`<polyline points=${s.points.map((p) => p.join(',')).join(' ')} />`}
            ${s.points.map((p) => html`<circle key=${p[0]} cx=${p[0]} cy=${p[1]} r="2.8" class="sl-band__dot" />`)}
          </g>
        `)}
        ${b.uncertain.map((x) => html`<text key=${`u${x}`} x=${x} y=${H - 6} class="sl-band__q">?</text>`)}
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
        ? html`<div class="sl-said__box g-mono" key=${last.n}>
            <div><span class="sl-said__k">REASON:</span> ${last.reason || '—'}</div>
            <div class=${last.outcome === 'foul' ? 'g-t-err' : ''}><span class="sl-said__k">VERDICT:</span> ${last.said || '—'}</div>
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
      <span class="sl-cookbook__seal" aria-hidden="true">★</span>
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
