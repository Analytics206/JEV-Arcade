/* Legal Moves Only — chess puzzles where every move Jev makes is a real move.
 *
 * The server (games/chess.py) owns the puzzles, the rules and the verdicts;
 * this page draws them. A setup (players, how many puzzles, strikes, whether
 * text models see the legal moves), then a round followed live: the board, with
 * Jev's five likeliest moves as arrows whose width is the probability (or a
 * text model's tries, the illegal ones in red), a strip to step through the
 * round's puzzles, a card per lane, and the session's totals.
 *
 * Board geometry and the readings of a run are pure, in chess.logic.js.
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
  againOf,
  fmtMs,
  html,
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
  laneOn,
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
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <div class="ch-howto">
              <figure class="ch-howto__board">
                <${Board} fen=${SAMPLE_FEN} marks=${sample}
                  label="Example board: white to move. Arrows show Jev's probability for five moves; the thickest, rook e1 to e8, is the mate." />
                <figcaption class="g-mono g-muted">example · arrow width = Jev's probability</figcaption>
              </figure>
              <div class="ch-howto__text">
                <p class="g-explain">
                  Mate-in-one puzzles, the same ones for every player and in the same order; each player goes at its
                  own pace. Find the move that checkmates.
                </p>
                <p class="g-explain">
                  <b>Jev</b> gets one Choice per puzzle over every legal move (no position has more than 218, and a
                  Choice holds 255), with the position described in words by code. It picks from real moves, so it
                  can never play an illegal one. Its five likeliest moves become the arrows.
                </p>
                <p class="g-explain">
                  <b>A text model</b> gets the FEN and the pieces and writes its move, <code>MOVE: Re8</code>. A move
                  that isn't legal is a <b>foul</b>: it is told why ("the queen on d3 cannot reach f7") and tries
                  again, until the strikes run out and the puzzle is lost. A legal move that doesn't mate is a miss.
                </p>
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

/** A chessboard with its pieces, the lane's squares lit, the mates ringed once
 *  known, and arrows over it all. */
function Board({ fen, flip = false, marks, mateTo = [], lane = 0, label, animKey }) {
  const { pieces } = useMemo(() => parseFen(fen), [fen])
  const coords = coordLabels(flip)
  const lit = marks?.lit
  const lc = `g-l${(lane % 4) + 1}`
  const litSquares = lit ? [lit.from, lit.to].map((sq) => squareXY(sq, flip)).filter(Boolean) : []
  return html`
    <svg class="ch-board" viewBox=${`0 0 ${VIEW} ${VIEW}`} role="img" aria-label=${label}>
      <g class="ch-squares">
        ${SQUARES.map((sq) => {
          const c = squareXY(sq, flip)
          return html`<rect key=${sq} x=${c.x} y=${c.y} width=${SQ} height=${SQ} class=${isLight(sq) ? 'ch-sq--l' : 'ch-sq--d'} />`
        })}
      </g>
      <g class=${`ch-lit ${lc}`}>
        ${litSquares.map((c) => html`<rect key=${`${c.x},${c.y}`} x=${c.x} y=${c.y} width=${SQ} height=${SQ} />`)}
      </g>
      <g class="ch-mates">
        ${mateTo.map((sq) => {
          const c = squareXY(sq, flip)
          return c && html`<rect key=${sq} x=${c.x + 3} y=${c.y + 3} width=${SQ - 6} height=${SQ - 6} />`
        })}
      </g>
      <rect class="ch-frame" x=${X0} y=${Y0} width=${8 * SQ} height=${8 * SQ} />
      <g class="ch-coords" aria-hidden="true">
        ${coords.files.map((c) => html`<text key=${`f${c.t}`} x=${c.x} y=${c.y}>${c.t}</text>`)}
        ${coords.ranks.map((c) => html`<text key=${`r${c.t}`} x=${c.x} y=${c.y}>${c.t}</text>`)}
      </g>
      <g class="ch-pieces" aria-hidden="true">
        ${pieces.map((pc) => {
          const c = squareXY(pc.sq, flip)
          return html`<text key=${pc.sq} x=${c.cx} y=${c.cy} class=${`ch-pc ch-pc--${pc.color}`}>${glyph(pc.piece)}</text>`
        })}
      </g>
      <g key=${animKey} class=${`ch-arrows ${lc}`} aria-hidden="true">
        ${(marks?.arrows ?? []).map(
          (a) => html`<g key=${a.key} class=${`ch-arrow ch-arrow--${a.tone}`} opacity=${a.opacity}>
            <path d=${a.d} stroke-width=${a.width} />
            <polygon points=${a.head} />
          </g>`,
        )}
        ${(marks?.crosses ?? []).map(
          (x) => html`<path key=${x.key} class="ch-x"
            d=${`M${x.cx - 13} ${x.cy - 13} L${x.cx + 13} ${x.cy + 13} M${x.cx + 13} ${x.cy - 13} L${x.cx - 13} ${x.cy + 13}`} />`,
        )}
      </g>
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
  const total = run.puzzles?.length ?? 0
  if (!total) return html`<${GameFrame} game=${game}><${RunLoading} error=${error ?? run.note} /><//>`
  const k = Math.min(pick ?? followPuzzle(run), total - 1)
  const pz = run.puzzles[k]
  const jev = run.lanes.find((ln) => ln.kind === 'judgment')
  const focus = run.lanes[Math.min(who ?? jev?.index ?? 0, run.lanes.length - 1)]
  const on = laneOn(focus, k)
  const mates = matesOf(run, k)
  const flip = pz.side === 'black'
  const marks = boardMarks(focus, on, flip)
  const mateTo = [...new Set((run.key?.[k]?.mates ?? []).map((m) => m.to))]
  const top = on.result?.top?.[0]
  let played = ''
  if (focus.kind === 'judgment' && top) played = `top move: ${sanOf(top.san, top.uci, withOwn(mates, on.result))}`
  else if (on.result?.move) played = `played: ${on.result.move}`

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">
          ${total} puzzles · ${run.strikes} ${run.strikes === 1 ? 'strike' : 'strikes'} a puzzle${run.show_moves ? ' · text models see the legal moves' : ''}
        </span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="ch-stage">
        <div class="ch-left">
          <div class="ch-head">
            <span class="ch-head__k">PUZZLE ${k + 1} OF ${total}</span>
            <h2 class="ch-head__title">${flip ? 'Black' : 'White'} to move, mate in 1</h2>
            <span class="ch-head__theme g-mono">
              theme: ${pz.theme} · difficulty <span title=${`${pz.difficulty} of 3`} aria-label=${`${pz.difficulty} of 3`}>${dots(pz.difficulty)}</span>
            </span>
          </div>
          <${Strip} run=${run} k=${k} onPick=${setPick} />
          <div class="ch-step">
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
          ${run.lanes.length > 1 &&
          html`<div class="ch-tabs" role="group" aria-label="Whose moves the board shows">
            ${run.lanes.map(
              (ln) => html`<button type="button" key=${ln.index} class=${`ch-tab${ln.index === focus.index ? ' ch-tab--on' : ''}`}
                aria-pressed=${ln.index === focus.index} onClick=${() => setWho(ln.index)}>
                <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
            )}
          </div>`}
          <${Box} class="ch-boardbox">
            <${Board} fen=${pz.fen} flip=${flip} marks=${marks} mateTo=${mateTo} lane=${focus.index}
              animKey=${`${focus.index}:${k}:${on.state}:${on.attempts.length}`}
              label=${boardLabel({ pz, lane: focus, on, mates })} />
          <//>
          <div class="ch-caption g-mono">
            <span>${focus.kind === 'judgment' ? 'arrow width = Jev’s probability for that move' : 'the move played; red: tries that were not legal'}</span>
            <span>${played || (on.state === 'playing' ? `${focus.label} is thinking…` : '')}</span>
          </div>
        </div>
        <div class="ch-right">
          ${run.lanes.map((ln) => html`<${LaneBox} key=${ln.index} lane=${ln} k=${k} mates=${mates} strikes=${run.strikes} />`)}
          <${Session} run=${run} />
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
        return html`
          <button type="button" key=${s.k} class=${`ch-pz${s.k === k ? ' ch-pz--on' : ''}`} aria-pressed=${s.k === k}
            aria-label=${`Puzzle ${s.k + 1}. ${said}`} title=${said} onClick=${() => onPick(s.k)}>
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
    <${Box} class="ch-answer">
      <${Label}>THE ANSWER<//>
      ${key
        ? html`<p class="ch-answer__mv g-t-ok">${key.mates.map((m) => m.san).join(' or ')}</p>
            ${key.idea && html`<p class="g-explain">${key.idea}</p>`}`
        : html`<p class="g-muted">Shown when the round ends.</p>`}
    <//>
  `
}

/* ── A lane ────────────────────────────────────────────────────────────────── */

function LaneBox({ lane, k, mates, strikes }) {
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
    <${Box} lane=${lane.index} class="ch-lane">
      <${LaneHead} lane=${lane} badge=${badge} />
      ${lane.kind === 'judgment'
        ? html`<${JevPick} lane=${lane} on=${on} mates=${withOwn(mates, on.result)} />`
        : html`<${Tries} on=${on} strikes=${strikes} mates=${withOwn(mates, on.result)} />`}
      <${LaneStats} lane=${lane} fouls=${lane.kind !== 'judgment'} />
    <//>
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
            <span class="ch-try__why">foul: ${t.foul}. Strike ${strike} of ${strikes}.</span>
          </li>`
        }
        const ok = r?.verdict === 'solved'
        return html`<li key=${i} class=${`ch-try ${ok ? 'ch-try--ok' : 'ch-try--miss'}`}>
          <span class="ch-try__mv">${ok ? '✓ ' : ''}${sanOf(t.san, t.uci, mates)}</span>
          <span class="ch-try__why">${ok ? (t.reason ? `“${t.reason}”` : 'mate') : `legal, but ${r?.note ?? 'not mate'}.`}</span>
        </li>`
      })}
    </ol>
    ${on.state === 'playing' && html`<p class="g-muted ch-wait">Trying again…</p>`}
    ${r && r.verdict === 'missed' && r.reason && html`<p class="ch-note">Its reason: “${r.reason}”</p>`}
  `
}

/* ── The session ───────────────────────────────────────────────────────────── */

function Session({ run }) {
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
          ${rows.map(
            (r) => html`<tr key=${r.index}>
              <td><span class="ch-table__who"><${LaneNum} i=${r.index} /><span>${r.label}</span></span></td>
              <td class="num">${r.solved}/${r.played}</td>
              <td class="num">${r.missed}</td>
              <td class=${`num${r.failed ? ' g-t-err' : ''}`}>${r.failed}</td>
              <td class=${`num${r.fouls ? ' g-t-err' : ''}`}>${r.fouls}</td>
              <td class="num">${fmtMs(r.perMove)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    <//>
  `
}
