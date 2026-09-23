/* Legal Moves Only — chess puzzles where every move Jev makes is a real move.
 *
 * The server (games/chess.py) owns the puzzles, the rules and the verdicts;
 * this page draws them. A setup (players, how many puzzles, strikes, whether
 * text models see the legal moves), then a round followed live: the board, with
 * Jev's five likeliest moves as glowing arrows whose width is the probability
 * (or a text model's tries, the illegal ones dashed red with a ✕), the mated
 * king's square flashing, a strip to step through the round's puzzles, a card
 * per lane with its score and a pip per puzzle, and the session's totals.
 *
 * Board geometry and the readings of a run are pure, in chess.logic.js.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks'
import { Button } from '../ui.js'
import {
  Bars,
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
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import {
  SQ,
  SQUARES,
  VIEW,
  X0,
  Y0,
  boardLabel,
  boardMarks,
  coordLabels,
  dots,
  followPuzzle,
  glyph,
  isLight,
  kingSquare,
  laneOn,
  lanePips,
  leadersOf,
  matesOf,
  parseFen,
  sanOf,
  sessionRows,
  squareXY,
  stripOf,
  verdictOf,
} from './chess.logic.js'

const COUNTS = [4, 8, 12, 16]
const STRIKES = [1, 2, 3, 5]
const QUESTION =
  'Which move checkmates the opponent right now? If no move mates, choose the move that wins the most material.'

export default function Chess({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

/* A sample of what a round looks like, drawn with the real board: the
 * back-rank puzzle, and Jev's arrows as it might weigh the moves. */
const SAMPLE_FEN = '6k1/1bq2ppp/n7/8/8/3Q1N2/5PPP/4R1K1 w - - 0 1'
const SAMPLE_TOP = [
  { san: 'Re8+', uci: 'e1e8', from: 'e1', to: 'e8', p: 0.71 },
  { san: 'Qxh7+', uci: 'd3h7', from: 'd3', to: 'h7', p: 0.12 },
  { san: 'Ng5', uci: 'f3g5', from: 'f3', to: 'g5', p: 0.07 },
  { san: 'Qxa6', uci: 'd3a6', from: 'd3', to: 'a6', p: 0.04 },
  { san: 'Qd8+', uci: 'd3d8', from: 'd3', to: 'd8', p: 0.03 },
]

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const most = game.params?.properties?.count?.maximum ?? 16
  const [count, setCount] = useState(Math.min(8, most))
  const [strikes, setStrikes] = useState(3)
  const [showMoves, setShowMoves] = useState(false)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 3 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { count, strikes, show_moves: showMoves })
  const counts = [...new Set([...COUNTS.filter((n) => n < most), most])]
  const sample = useMemo(() => boardMarks({ kind: 'judgment' }, { result: { top: SAMPLE_TOP } }), [])

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="ch-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="ch-params">
            <label class="g-field"><span>Puzzles</span>
              <select class="wr-sel" value=${count} onChange=${(e) => setCount(Number(e.currentTarget.value))}>
                ${counts.map((n) => html`<option key=${n} value=${n}>${n === most ? `${n} (every one)` : n}</option>`)}
              </select>
            </label>
            <label class="g-field"><span>Strikes a puzzle</span>
              <select class="wr-sel" value=${strikes} onChange=${(e) => setStrikes(Number(e.currentTarget.value))}>
                ${STRIKES.map((n) => html`<option key=${n} value=${n}>${n} ${n === 1 ? 'foul' : 'fouls'}</option>`)}
              </select>
            </label>
            <label class="ch-check">
              <input type="checkbox" checked=${showMoves} onChange=${(e) => setShowMoves(e.currentTarget.checked)} />
              <span>Show text models the list of legal moves</span>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Set up the board" />
        <//>
        <div class="ch-side">
          <${Box} class="ch-howbox">
            <${Label}>HOW IT'S PLAYED<//>
            <div class="ch-howto">
              <figure class="ch-howto__board">
                <div class="ch-bezel">
                  <${Board} fen=${SAMPLE_FEN} marks=${sample} mateKing="g8" demo
                    label="Example board: white to move. Arrows show Jev's probability for five moves; the thickest, rook e1 to e8, is the mate." />
                </div>
                <figcaption class="g-mono g-muted">example · arrow width = Jev's probability</figcaption>
              </figure>
              <div class="ch-howto__text">
                <ol class="ch-steps">
                  <li class="ch-step">
                    <span class="ch-step__n" aria-hidden="true">1</span>
                    <p class="g-explain">
                      Mate-in-one puzzles, the same ones for every player and in the same order; each player goes at
                      its own pace. Find the move that checkmates.
                    </p>
                  </li>
                  <li class="ch-step">
                    <span class="ch-step__n" aria-hidden="true">2</span>
                    <p class="g-explain">
                      <b>Jev</b> gets one Choice per puzzle over every legal move (no position has more than 218, and a
                      Choice holds 255), with the position described in words by code. It picks from real moves, so
                      it can never play an illegal one. Its five likeliest moves become the arrows.
                    </p>
                  </li>
                  <li class="ch-step">
                    <span class="ch-step__n" aria-hidden="true">3</span>
                    <p class="g-explain">
                      <b>A text model</b> gets the FEN and the pieces and writes its move, <code>MOVE: Re8</code>. A
                      move that isn't legal is a <b>foul</b>: it is told why ("the queen on d3 cannot reach f7") and
                      tries again, until the strikes run out and the puzzle is lost. A legal move that doesn't mate is
                      a miss.
                    </p>
                  </li>
                </ol>
                <div class="ch-rules">
                  <${Chip} tone="ok">✓ solved +1<//><${Chip} tone="err">– missed 0<//><${Chip} tone="err">✕ fouled out 0<//>
                </div>
              </div>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${recentNote(r)}</span>`} />
        </div>
      </div>
    <//>
  `
}

function recentNote(r) {
  const best = Math.max(0, ...(r.lanes ?? []).map((l) => l.solved ?? 0))
  return `${r.total ?? '?'} puzzles · best ${best}`
}

/* ── The board ─────────────────────────────────────────────────────────────── */

/**
 * A chessboard: bevelled squares, pieces standing on soft shadows, the lane's
 * squares lit (and a ghost of the piece where it lands), the mates ringed once
 * known, the mated king's square flashing, and glowing arrows over it all.
 * `animKey` replays the arrows' entrance; `demo` loops it (the setup's sample).
 */
function Board({ fen, flip = false, marks, mateTo = [], mateKing = null, lane = 0, label, animKey, demo = false }) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const { pieces } = useMemo(() => parseFen(fen), [fen])
  const id = (n) => `ch${n}${uid}`
  const url = (n) => `url(#${id(n)})`
  const at = (sq) => squareXY(sq, flip)
  const coords = coordLabels(flip)
  const lit = marks?.lit
  const lc = `g-l${(lane % 4) + 1}`
  const litSquares = lit ? [['from', lit.from], ['to', lit.to]].map(([k, sq]) => ({ k, c: at(sq) })).filter((s) => s.c) : []
  const mover = lit ? pieces.find((pc) => pc.sq === lit.from) : null
  const taken = lit ? pieces.find((pc) => pc.sq === lit.to) : null
  const ghost = mover && at(lit.to)
  const king = mateKing ? at(mateKing) : null
  const arrows = marks?.arrows ?? []
  const crosses = marks?.crosses ?? []
  const fouls = arrows.filter((a) => a.tone === 'err')
  const replay = `${animKey ?? ''}|${fen}`
  return html`
    <svg class=${`ch-board ${lc}${demo ? ' ch-board--demo' : ''}`} viewBox=${`0 0 ${VIEW} ${VIEW}`} role="img" aria-label=${label}>
      <defs>
        <linearGradient id=${id('L')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class="ch-stop-l0" /><stop offset="1" class="ch-stop-l1" />
        </linearGradient>
        <linearGradient id=${id('D')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class="ch-stop-d0" /><stop offset="1" class="ch-stop-d1" />
        </linearGradient>
        <linearGradient id=${id('W')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="ch-stop-w0" /><stop offset="1" class="ch-stop-w1" />
        </linearGradient>
        <linearGradient id=${id('K')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="ch-stop-k0" /><stop offset="1" class="ch-stop-k1" />
        </linearGradient>
        <linearGradient id=${id('S')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" class="ch-stop-s0" /><stop offset="0.45" class="ch-stop-s1" /><stop offset="1" class="ch-stop-s1" />
        </linearGradient>
        <pattern id=${id('B')} x=${X0} y=${Y0} width=${SQ} height=${SQ} patternUnits="userSpaceOnUse">
          <path d=${`M1 ${SQ - 1} V1 H${SQ - 1}`} class="ch-bevel-hi" />
          <path d=${`M${SQ - 1} 1 V${SQ - 1} H1`} class="ch-bevel-lo" />
        </pattern>
      </defs>

      <rect class="ch-frame__glow" x=${X0 - 4} y=${Y0 - 4} width=${8 * SQ + 8} height=${8 * SQ + 8} rx="6" />
      <g class="ch-squares">
        ${SQUARES.map((sq) => {
          const c = at(sq)
          return html`<rect key=${sq} x=${c.x} y=${c.y} width=${SQ} height=${SQ} fill=${url(isLight(sq) ? 'L' : 'D')} />`
        })}
      </g>
      <rect class="ch-bevel" x=${X0} y=${Y0} width=${8 * SQ} height=${8 * SQ} fill=${url('B')} />

      <g class="ch-lit" key=${`lit${replay}`}>
        ${litSquares.map(
          ({ k, c }) => html`<g key=${k} class=${`ch-lit__sq ch-lit__sq--${k}`}>
            <rect x=${c.x} y=${c.y} width=${SQ} height=${SQ} class="ch-lit__fill" />
            <rect x=${c.x + 2.5} y=${c.y + 2.5} width=${SQ - 5} height=${SQ - 5} rx="3" class="ch-lit__edge" />
          </g>`,
        )}
      </g>
      <g class="ch-mates">
        ${mateTo.map((sq) => {
          const c = at(sq)
          return c && html`<rect key=${sq} x=${c.x + 4} y=${c.y + 4} width=${SQ - 8} height=${SQ - 8} rx="4" />`
        })}
      </g>
      ${king && html`<g key=${`mate${replay}`} class="ch-mate" aria-hidden="true">
        <rect x=${king.x} y=${king.y} width=${SQ} height=${SQ} class="ch-mate__sq" />
        <rect x=${king.x + 3} y=${king.y + 3} width=${SQ - 6} height=${SQ - 6} rx="4" class="ch-mate__ring" />
      </g>`}

      <rect class="ch-sheen" x=${X0} y=${Y0} width=${8 * SQ} height=${8 * SQ} fill=${url('S')} />
      <rect class="ch-frame" x=${X0 - 1} y=${Y0 - 1} width=${8 * SQ + 2} height=${8 * SQ + 2} rx="3" />
      <g class="ch-coords" aria-hidden="true">
        ${coords.files.map((c) => html`<text key=${`f${c.t}`} x=${c.x} y=${c.y}>${c.t}</text>`)}
        ${coords.ranks.map((c) => html`<text key=${`r${c.t}`} x=${c.x} y=${c.y}>${c.t}</text>`)}
      </g>

      <g class="ch-pieces" key=${fen} aria-hidden="true">
        ${pieces.map((pc, n) => {
          const c = at(pc.sq)
          const cls = `ch-pc ch-pc--${pc.color}${taken && pc.sq === taken.sq ? ' ch-pc--taken' : ''}${mover && pc.sq === mover.sq ? ' ch-pc--mover' : ''}`
          return html`<g key=${pc.sq} class=${cls} style=${{ '--i': n }}>
            <ellipse cx=${c.cx} cy=${c.y + SQ - 9} rx="17" ry="4.5" class="ch-pc__shadow" />
            <text x=${c.cx} y=${c.cy} fill=${url(pc.color === 'w' ? 'W' : 'K')}>${glyph(pc.piece)}</text>
          </g>`
        })}
      </g>
      ${ghost && html`<text key=${`ghost${replay}`} x=${ghost.cx} y=${ghost.cy} class=${`ch-ghost ch-pc--${mover.color}`}
        fill=${url(mover.color === 'w' ? 'W' : 'K')} aria-hidden="true">${glyph(mover.piece)}</text>`}

      <g key=${`arrows${replay}`} class="ch-arrows" aria-hidden="true">
        ${arrows.map((a, n) => {
          const err = a.tone === 'err'
          const delay = { '--d': `${(arrows.length - 1 - n) * 90}ms` }
          return html`<g key=${a.key} class=${`ch-arrow ch-arrow--${a.tone}${a.rank === 0 && !err ? ' ch-arrow--top' : ''}`} opacity=${a.opacity} style=${delay}>
            <path d=${a.d} stroke-width=${a.width + 12} class="ch-arrow__glow" pathLength=${err ? undefined : 100} />
            <path d=${a.d} stroke-width=${a.width + 4} class="ch-arrow__case" pathLength=${err ? undefined : 100} />
            <path d=${a.d} stroke-width=${a.width} class="ch-arrow__core" pathLength=${err ? undefined : 100} />
            ${!err && html`<path d=${a.d} stroke-width=${Math.max(1, a.width / 4)} class="ch-arrow__shine" pathLength="100" />`}
            <polygon points=${a.head} class="ch-arrow__head" />
          </g>`
        })}
      </g>
      <g key=${`x${replay}`} class="ch-xs" aria-hidden="true">
        ${fouls.map(
          (a, n) => html`<g key=${a.key} transform=${`translate(${a.tip[0]} ${a.tip[1]})`}>
            <g class="ch-xbadge" style=${{ '--d': `${n * 120 + 160}ms` }}>
              <circle r="12" /><path d="M-5 -5 L5 5 M5 -5 L-5 5" />
            </g>
          </g>`,
        )}
        ${crosses.map(
          (x, n) => html`<g key=${x.key} transform=${`translate(${x.cx} ${x.cy})`}>
            <rect x=${-SQ / 2 + 4} y=${-SQ / 2 + 4} width=${SQ - 8} height=${SQ - 8} rx="4" class="ch-xsq" />
            <g class="ch-xbadge" style=${{ '--d': `${n * 120}ms` }}>
              <circle r="14" /><path d="M-6 -6 L6 6 M6 -6 L-6 6" />
            </g>
          </g>`,
        )}
      </g>
      ${king && html`<g key=${`badge${replay}`} transform=${`translate(${king.x + SQ - 11} ${king.y + 11})`} class="ch-matebadge" aria-hidden="true">
        <g class="ch-matebadge__in"><circle r="11" /><text y="0.5">#</text></g>
      </g>`}
    </svg>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  // The puzzle the viewer picked (null follows the round) and whose moves the board draws.
  const [pick, setPick] = useState(null)
  const [who, setWho] = useState(null)
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  if (!run.puzzles?.length) return html`<${GameFrame} game=${game}><${RunLoading} error=${error ?? run.note} /><//>`
  return html`<${Round} game=${game} run=${run} now=${now} error=${error} pick=${pick} setPick=${setPick} who=${who} setWho=${setWho} />`
}

function Round({ game, run, now, error, pick, setPick, who, setWho }) {
  const total = run.puzzles.length
  const live = isRunLive(run)
  const k = Math.min(pick ?? followPuzzle(run), total - 1)
  const pz = run.puzzles[k]
  const jev = run.lanes.find((ln) => ln.kind === 'judgment')
  const focus = run.lanes[Math.min(who ?? jev?.index ?? 0, run.lanes.length - 1)]
  const on = laneOn(focus, k)
  const mates = matesOf(run, k)
  const flip = pz.side === 'black'
  const marks = boardMarks(focus, on, flip)
  const mateTo = [...new Set((run.key?.[k]?.mates ?? []).map((m) => m.to))]
  const v = verdictOf(on.result)
  const solved = on.result?.verdict === 'solved'
  const mateKing = solved ? kingSquare(pz.fen, flip ? 'w' : 'b') : null
  const top = on.result?.top?.[0]
  let played = ''
  if (focus.kind === 'judgment' && top) played = `top move ${sanOf(top.san, top.uci, withOwn(mates, on.result))}`
  else if (on.result?.move) played = `played ${sanOf(on.result.move, on.result.uci, withOwn(mates, on.result))}`

  // Who won, by the game's rule (most puzzles solved; every one of them on a
  // tie). A lone player has nobody to beat: its finale is its tally.
  const multi = run.lanes.length > 1
  const leaders = leadersOf(run)
  const solo = multi ? null : run.lanes[0]
  const soloSolved = solo?.solved ?? 0
  const headline = solo ? (soloSolved === total ? 'PERFECT ROUND!' : `${soloSolved}/${total} SOLVED`) : undefined

  // A mate landing on the board while you watch: a little confetti off the king.
  const boardRef = useRef(null)
  const seen = useRef(null)
  const sig = `${run.id}:${focus.index}:${k}`
  useEffect(() => {
    const prev = seen.current
    seen.current = { sig, state: on.state }
    if (!live || !prev || prev.sig !== sig || prev.state === 'done' || on.state !== 'done' || !solved) return
    const el = boardRef.current?.querySelector('.ch-matebadge') ?? boardRef.current
    burstFrom(el, { colors: [LANE_COLORS[focus.index % 4], '#ffe14d', '#ffffff'], count: 34, power: 0.6 })
    sfx.up()
  }, [sig, on.state, solved])

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${multi ? leaders : undefined}
        headline=${headline} sub=${solo ? solo.label : undefined} win=${!solo || soloSolved > 0}>
        <span class="g-mono g-muted">
          ${total} puzzles · ${run.strikes} ${run.strikes === 1 ? 'strike' : 'strikes'} a puzzle${run.show_moves ? ' · text models see the legal moves' : ''}
        </span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="ch-stage">
        <div class="ch-left">
          <div class="ch-head" key=${k}>
            <span class="ch-head__k"><${PixelText} text=${`PUZZLE ${k + 1}/${total}`} /><span class="sr-only">Puzzle ${k + 1} of ${total}</span></span>
            <h2 class="ch-head__title">
              <span class=${`ch-turn ch-turn--${flip ? 'b' : 'w'}`} aria-hidden="true">${glyph(flip ? 'k' : 'K')}</span>
              <span>${flip ? 'Black' : 'White'} to move, mate in 1</span>
            </h2>
            <span class="ch-head__theme g-mono">
              theme: ${pz.theme} · difficulty <span class="ch-dots" title=${`${pz.difficulty} of 3`} aria-label=${`${pz.difficulty} of 3`}>${dots(pz.difficulty)}</span>
            </span>
          </div>
          <${Strip} run=${run} k=${k} onPick=${setPick} />
          <div class="ch-nav">
            <${Button} variant="ghost" size="sm" disabled=${k === 0} onClick=${() => setPick(k - 1)}>‹ Previous<//>
            <${Button} variant="ghost" size="sm" disabled=${k >= total - 1} onClick=${() => setPick(k + 1)}>Next ›<//>
            <${Button} variant=${pick === null ? 'secondary' : 'ghost'} size="sm" aria-pressed=${pick === null} onClick=${() => setPick(null)}>
              Follow the round
            <//>
          </div>
          <${Asked} pz=${pz} question=${run.question ?? QUESTION} />
          <${Answer} run=${run} k=${k} />
        </div>
        <div class="ch-center">
          ${multi &&
          html`<div class="ch-tabs" role="group" aria-label="Whose moves the board shows">
            ${run.lanes.map(
              (ln) => html`<button type="button" key=${ln.index} class=${`ch-tab g-l${(ln.index % 4) + 1}${ln.index === focus.index ? ' ch-tab--on' : ''}`}
                aria-pressed=${ln.index === focus.index} onClick=${() => { sfx.select(); setWho(ln.index) }}>
                <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
            )}
          </div>`}
          <div class=${`ch-bezel ch-bezel--live g-l${(focus.index % 4) + 1}${solved ? ' is-mate' : ''}`} ref=${boardRef}>
            <${Board} fen=${pz.fen} flip=${flip} marks=${marks} mateTo=${mateTo} mateKing=${mateKing} lane=${focus.index}
              animKey=${`${focus.index}:${k}:${on.state}:${on.attempts.length}`}
              label=${boardLabel({ pz, lane: focus, on, mates })} />
            ${on.state === 'playing' && html`<span class="ch-scan" aria-hidden="true"><i /></span>`}
          </div>
          <div class="ch-caption">
            <span class="ch-caption__v">
              ${v
                ? html`<span class=${`ch-verdict ch-verdict--${v.tone}`} key=${`${focus.index}:${k}`}>${v.mark} ${v.label}</span>`
                : on.state === 'playing'
                  ? html`<span class="ch-verdict ch-verdict--live">${focus.label} is thinking…</span>`
                  : null}
              ${played && html`<span class="ch-caption__mv g-mono">${played}</span>`}
            </span>
            <span class="ch-caption__k g-mono">${focus.kind === 'judgment' ? 'arrow width = Jev’s probability for that move' : 'the move played; dashed red ✕: tries that were not legal'}</span>
          </div>
        </div>
        <div class="ch-right">
          ${run.lanes.map(
            (ln) => html`<${LaneBox} key=${ln.index} lane=${ln} k=${k} total=${total} mates=${mates} strikes=${run.strikes}
              lead=${multi && leaders.includes(ln.index)} live=${live} />`,
          )}
          <${Session} run=${run} leaders=${multi ? leaders : []} live=${live} />
        </div>
      </div>
    <//>
  `
}

/** The mates known for a result: the key's, plus the lane's own move if it solved. */
function withOwn(mates, r) {
  if (!r || r.verdict !== 'solved' || !r.uci) return mates
  return new Set([...mates, r.uci])
}

/** The round's puzzles, each with a mark per lane; the one shown is pressed. */
function Strip({ run, k, onPick }) {
  const strip = stripOf(run)
  return html`
    <div class="ch-strip" role="group" aria-label="The round's puzzles">
      ${strip.map((s) => {
        const said = s.marks.map((m) => `${m.label}: ${m.verdict ? m.verdict.label : m.state}`).join('; ')
        const pick = () => {
          sfx.select()
          onPick(s.k)
        }
        return html`
          <button type="button" key=${s.k} class=${`ch-pz${s.k === k ? ' ch-pz--on' : ''}`} aria-pressed=${s.k === k}
            aria-label=${`Puzzle ${s.k + 1}. ${said}`} title=${said} onClick=${pick}>
            <span class="ch-pz__n tnum">${s.k + 1}</span>
            <span class="ch-pz__marks" aria-hidden="true">
              ${s.marks.map(
                (m) => html`<span key=${m.index} class=${`ch-mk g-l${(m.index % 4) + 1}${m.verdict ? ` ch-mk--${m.verdict.tone}` : m.state === 'playing' ? ' ch-mk--live' : ''}`}>
                  ${m.verdict ? m.verdict.mark : m.state === 'playing' ? '…' : '·'}</span>`,
              )}
            </span>
          </button>
        `
      })}
    </div>
  `
}

/** What Jev reads for this puzzle, field by field, and the one question. */
function Asked({ pz, question }) {
  return html`
    <${Box} class="ch-asked">
      <${Label}>HOW JEV IS ASKED<//>
      <p class="ch-asked__sub">the state, in words (code writes it)</p>
      <dl class="ch-state">
        ${Object.entries(pz.state ?? {}).map(
          ([name, v]) => html`<div key=${name} class="ch-state__row"><dt>${name}</dt><dd>${v}</dd></div>`,
        )}
      </dl>
      <p class="ch-asked__sub">one choice question</p>
      <p class="ch-asked__q">“${question}”</p>
      <p class="ch-asked__sub">options: the ${pz.legal} legal moves, under ids that say nothing</p>
    <//>
  `
}

function Answer({ run, k }) {
  const key = run.key?.[k]
  return html`
    <${Box} class=${`ch-answer${key ? ' is-out' : ''}`}>
      <${Label}>THE ANSWER<//>
      ${key
        ? html`<p class="ch-answer__mv" key=${k}><span class="ch-answer__hash" aria-hidden="true">#</span>${key.mates.map((m) => m.san).join(' or ')}</p>
            ${key.idea && html`<p class="g-explain">${key.idea}</p>`}`
        : html`<p class="ch-answer__sealed"><span aria-hidden="true">▸</span> sealed until the round ends</p>`}
    <//>
  `
}

/* ── A lane ────────────────────────────────────────────────────────────────── */

function LaneBox({ lane, k, total, mates, strikes, lead, live }) {
  const on = laneOn(lane, k)
  const v = verdictOf(on.result)
  const badge = v
    ? html`<${Chip} tone=${v.tone}>${v.mark} ${v.label} · ${fmtMs(on.result.ms)}<//>`
    : on.state === 'playing'
      ? html`<${Chip} tone="live">${lane.status === 'rate_limited' ? 'rate-limited' : 'thinking…'}<//>`
      : on.state === 'waiting'
        ? html`<${Chip}>not here yet<//>`
        : undefined
  return html`
    <${Box} lane=${lane.index} class=${`ch-lane${lead ? ' ch-lane--lead' : ''}`}>
      <${LaneHead} lane=${lane} badge=${badge} />
      <div class="ch-tally">
        <div class="ch-tally__score">
          <${Counter} value=${lane.solved ?? 0} class="g-score" sound />
          <span class="ch-tally__of"><span class="tnum">/${total}</span><small>solved</small></span>
        </div>
        <${Pips} lane=${lane} total=${total} k=${k} />
        ${lead && html`<span class="ch-lead" title=${live ? 'most puzzles solved so far' : 'most puzzles solved'}><span aria-hidden="true">★</span> ${live ? 'leading' : 'winner'}</span>`}
      </div>
      ${lane.kind === 'judgment'
        ? html`<${JevPick} lane=${lane} on=${on} mates=${withOwn(mates, on.result)} />`
        : html`<${Tries} on=${on} strikes=${strikes} mates=${withOwn(mates, on.result)} />`}
      <${LaneStats} lane=${lane} fouls=${lane.kind !== 'judgment'} />
    <//>
  `
}

/** A pip per puzzle for one lane: ✓ – ✕ as they land, the one it is on
 *  pulsing, the one in view ringed. */
function Pips({ lane, total, k }) {
  const pips = lanePips(lane, total)
  const said = `${lane.solved ?? 0} solved, ${lane.missed ?? 0} missed, ${lane.failed ?? 0} fouled out, of ${total}`
  return html`
    <span class="ch-pips" role="img" aria-label=${said} title=${said}>
      ${pips.map(
        (p) => html`<span key=${p.k} class=${`ch-pip${p.verdict ? ` ch-pip--${p.verdict.tone}` : ` ch-pip--${p.state}`}${p.k === k ? ' ch-pip--view' : ''}`}>
          ${p.verdict ? p.verdict.mark : ''}</span>`,
      )}
    </span>
  `
}

function waitingWords(on, what) {
  if (on.state === 'playing') return what
  if (on.state === 'waiting') return 'Still on an earlier puzzle.'
  return 'Did not reach this puzzle.'
}

/** Jev's five likeliest moves as bars, and what the top one did. */
function JevPick({ lane, on, mates }) {
  const r = on.result
  if (!r) return html`<p class="g-muted ch-wait">${waitingWords(on, 'One question over every legal move…')}</p>`
  const items = (r.top ?? []).map((t, i) => ({
    label: sanOf(t.san, t.uci, mates), p: t.p, strong: i === 0, tone: mates.has(t.uci) ? 'ok' : undefined,
    title: `${t.from} to ${t.to}`,
  }))
  return html`
    <${Bars} lane=${lane.index} items=${items} max=${5} />
    <p class="ch-meta g-mono">
      confidence ${Number.isFinite(r.confidence) ? r.confidence.toFixed(2) : '—'} · ${r.options} options · ${r.requests ?? 1} request${(r.requests ?? 1) === 1 ? '' : 's'} · fouls 0
    </p>
    ${r.note && html`<p class="ch-note"><b>${r.move}</b>: legal, but ${r.note}.</p>`}
  `
}

/** A text model's tries on the puzzle: fouls in red with the reason it was
 *  told, then the move it played and its own reason. */
function Tries({ on, strikes, mates }) {
  const tries = on.attempts ?? []
  const r = on.result
  if (!tries.length) return html`<p class="g-muted ch-wait">${waitingWords(on, 'Writing a move…')}</p>`
  let strike = 0
  return html`
    <ol class="ch-tries">
      ${tries.map((t, i) => {
        if (t.foul) {
          strike += 1
          return html`<li key=${i} class="ch-try ch-try--foul">
            <span class="ch-try__mv">✕ ${t.said || '(nothing)'}</span>
            <span class="ch-try__why">foul: ${t.foul}. <b class="ch-strike">Strike ${strike} of ${strikes}.</b></span>
          </li>`
        }
        const ok = r?.verdict === 'solved'
        return html`<li key=${i} class=${`ch-try ${ok ? 'ch-try--ok' : 'ch-try--miss'}`}>
          <span class="ch-try__mv">${ok ? '✓ ' : '– '}${sanOf(t.san, t.uci, mates)}</span>
          <span class="ch-try__why">${ok ? (t.reason ? `“${t.reason}”` : 'mate') : `legal, but ${r?.note ?? 'not mate'}.`}</span>
        </li>`
      })}
    </ol>
    ${on.state === 'playing' && html`<p class="g-muted ch-wait">Trying again…</p>`}
    ${r && r.verdict === 'missed' && r.reason && html`<p class="ch-note">Its reason: “${r.reason}”</p>`}
  `
}

/* ── The session ───────────────────────────────────────────────────────────── */

function Session({ run, leaders, live }) {
  const rows = sessionRows(run)
  return html`
    <${Box} class="ch-session">
      <${Label} note=${`${run.puzzles.length} puzzles`}>THIS ROUND SO FAR<//>
      <table class="g-table ch-table">
        <thead>
          <tr>
            <th scope="col">player</th>
            <th scope="col" class="num">solved</th>
            <th scope="col" class="num">missed</th>
            <th scope="col" class="num">fouled out</th>
            <th scope="col" class="num">fouls</th>
            <th scope="col" class="num">per move</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const lead = leaders.includes(r.index)
            return html`<tr key=${r.index} class=${lead ? 'ch-table__lead' : ''}>
              <td><span class="ch-table__who"><${LaneNum} i=${r.index} /><span>${r.label}</span>${lead &&
                html`<span class="ch-table__star" title=${live ? 'leading' : 'winner'}><span aria-hidden="true">★</span><span class="sr-only">${live ? 'leading' : 'winner'}</span></span>`}</span></td>
              <td class="num ch-table__solved">${r.solved}/${r.played}</td>
              <td class="num">${r.missed}</td>
              <td class=${`num${r.failed ? ' g-t-err' : ''}`}>${r.failed}</td>
              <td class=${`num${r.fouls ? ' g-t-err' : ''}`}>${r.fouls}</td>
              <td class="num">${fmtMs(r.perMove)}</td>
            </tr>`
          })}
        </tbody>
      </table>
    <//>
  `
}
