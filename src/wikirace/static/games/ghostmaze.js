/* Ghost Maze — same maze, same seed, one clock. The ghosts don't wait.
 *
 * The server (games/ghostmaze.py, ghostmaze_sim.py) owns every world and the
 * clock; this page draws them, as an arcade cabinet would: one screen per
 * lane, side by side, under a 1UP / HIGH SCORE strip and over a row of lives.
 * The maze is double-lined neon; pellets glow and spark as they go; the
 * player, in its lane's colour, chomps and faces its way, gliding tile to
 * tile (a CSS transition as long as a tick); three ghosts ripple their skirts
 * and look where they go, turn blue and flash when frightened, and fly home
 * as eyes when eaten. READY!, GAME OVER and the rest are lit in pixel type.
 * Then, for one lane at a time, the world in the words its model was given,
 * Jev's stick (an arm per way, sized by probability, walls not offered), and
 * what an hour of play costs. The geometry is ghostmaze.logic.js, where it is
 * tested.
 *
 * Per tick, a lane's DOM changes are small: the sprites' transforms, the
 * pellet eaten, the score. The walls are drawn once per layout, and nothing
 * over the maze wears a CSS filter: glows are gradients and wide strokes.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Bars,
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
  burst,
  fmtMs,
  html,
  perCall,
  sfx,
  startGame,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import {
  ANGLE,
  CELL,
  STEP,
  bestScore,
  cellXY,
  fmtInt,
  fmtMoney,
  ghostBody,
  ghostPoints,
  ghostsEaten,
  hourCost,
  isFresh,
  isOpen,
  laneMood,
  laneWorld,
  mazeLabel,
  mazeSize,
  meanLag,
  pacHalves,
  parseLayout,
  pupil,
  recentlyEaten,
  scaredMouth,
  screenText,
  soloFinale,
  startView,
  stepOf,
  stickArms,
  stickLabel,
  thinkingText,
  ticksAnswered,
  upOf,
  wallRects,
  wedgePath,
  winnersOf,
  wordsRows,
} from './ghostmaze.logic.js'

const SECONDS = [20, 30, 45, 60, 90, 120]
const TICKS = [
  [100, '10 a second (the Doom demo’s pace)'],
  [150, 'about 7 a second'],
  [200, '5 a second'],
  [300, 'about 3 a second'],
  [500, '2 a second'],
]
const MODES = [
  ['realtime', 'Real time: the world ticks on'],
  ['turns', 'Turn-based: the world waits'],
]
const GHOST_RULE = {
  Blinky: 'chases: heads for your tile',
  Pinky: 'ambushes: heads four tiles ahead of you',
  Clyde: 'wanders: turns at random',
}
const perSecond = (ms) => `${Number((1000 / ms).toFixed(1))}`

/* The sprites' shapes, drawn once: the player's two halves, a ghost's two
 * skirt frames, the shine on its dome. */
const PAC = pacHalves(13)
const SKIRT = [ghostBody(0, 0, 12, 0), ghostBody(0, 0, 12, 1)]
const SHEEN = 'M-8.6 -2.5 A9 9 0 0 1 -1 -10.4 A12.2 12.2 0 0 0 -8.6 -2.5 Z'
/* The ghosts' own colours (a board's literal colours), and their halos'. */
const GHOST_HUE = { blinky: '#ff3b5c', pinky: '#ff8fe0', clyde: '#ffa53d', scared: '#3a4bff' }
const WAY_GLYPH = { up: '▲', left: '◀', down: '▼', right: '▶' }
let UID = 0

export default function GhostMaze({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function layoutsOf(game) {
  const prop = game?.params?.properties?.layout ?? {}
  const all = prop['x-layouts'] ?? {}
  return { list: Object.values(all), byId: all, first: prop.default ?? Object.keys(all)[0] }
}

function Setup({ game }) {
  const models = useModels()
  const mazes = layoutsOf(game)
  const [lanes, setLanes] = useState([])
  const [mode, setMode] = useState('realtime')
  const [seconds, setSeconds] = useState(45)
  const [layout, setLayout] = useState(mazes.first)
  const [tickMs, setTickMs] = useState(100)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const L = useMemo(() => (mazes.byId[layout] ? parseLayout(mazes.byId[layout]) : null), [layout, game])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { mode, seconds, tick_ms: tickMs, layout })
  const ticks = Math.round((seconds * 1000) / tickMs)

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="gm-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="g-field">
            <span id="gm-mode-label">Clock</span>
            <div class="gm-seg" role="group" aria-labelledby="gm-mode-label">
              ${MODES.map(
                ([v, l]) => html`<button type="button" key=${v} class=${`gm-seg__btn${mode === v ? ' gm-seg__btn--on' : ''}`}
                  aria-pressed=${mode === v} onClick=${() => setMode(v)}>${l}</button>`,
              )}
            </div>
          </div>
          <div class="gm-params">
            <label class="g-field"><span>Round</span>
              <select class="wr-sel" value=${seconds} onChange=${(e) => setSeconds(Number(e.currentTarget.value))}>
                ${SECONDS.map((n) => html`<option key=${n} value=${n}>${n} seconds</option>`)}
              </select>
            </label>
            <label class="g-field"><span>Maze</span>
              <select class="wr-sel" value=${layout} onChange=${(e) => setLayout(e.currentTarget.value)}>
                ${mazes.list.map((m) => html`<option key=${m.id} value=${m.id}>${m.name}</option>`)}
              </select>
            </label>
            <label class="g-field gm-params__wide"><span>Ticks</span>
              <select class="wr-sel" value=${tickMs} onChange=${(e) => setTickMs(Number(e.currentTarget.value))}>
                ${TICKS.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}
              </select>
            </label>
          </div>
          <p class="g-mono g-muted gm-setup__note">
            ${fmtInt(ticks)} ticks${mode === 'turns' ? ', each waiting for its player wherever there is a choice' : ` in ${seconds} s, ready or not`}
          </p>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Release the ghosts" />
        <//>
        <div class="gm-side">
          <${Box} class="gm-howbox">
            <${Label}>HOW IT'S PLAYED<//>
            <div class="gm-how">
              <div class="gm-how__text">
                <p class="g-explain">
                  Every lane plays its own copy of the same maze from the same seed: the same pellets, the same three
                  ghosts, three lives each. In <b>real time</b> the world ticks on whatever the players are doing. Each
                  one reads its maze, asks its model which way to go, and turns the moment the answer lands, however
                  far it has run meanwhile. Between answers a player keeps going the way it last chose, to the next wall.
                </p>
                <p class="g-explain">
                  <b>Jev</b> answers one Choice per decision over the open ways only, so it cannot walk into a wall,
                  each way described in words: pellets that way, ghosts that way. A <b>text model</b> reads the same
                  words and answers <code>MOVE: left</code>; a wall, or no MOVE line, is a foul. <b>Turn-based</b>,
                  each world waits for its player at every junction, wall and close ghost.
                </p>
              </div>
              ${L && html`<div class="gm-how__maze">
                <div class="gm-cab gm-cab--demo g-l1">
                  <div class="gm-hud" aria-hidden="true">
                    <span class="gm-hud__cell"><span class="gm-hud__k gm-hud__k--up"><${PixelText} text="1UP" /></span><span class="gm-hud__v tnum">00</span></span>
                    <span class="gm-hud__cell gm-hud__cell--mid"><span class="gm-hud__k"><${PixelText} text="MAZE" /></span><span class="gm-hud__v">${L.name}</span></span>
                    <span class="gm-hud__cell gm-hud__cell--end"><span class="gm-hud__k"><${PixelText} text="PELLETS" /></span><span class="gm-hud__v tnum">${L.pellets.length + L.power.length}</span></span>
                  </div>
                  <${Maze} L=${L} lane=${{ index: 0, label: L.name, ...startView(L) }} tickMs=${tickMs} still />
                  <div class="gm-hud gm-hud--foot" aria-hidden="true"><${Lives} n=${3} /><span class="gm-hud__note tnum">${fmtInt(ticks)} ticks · ${perSecond(tickMs)}/s</span></div>
                </div>
              </div>`}
            </div>
            <div class="gm-points" role="list" aria-label="Points">
              <span class="gm-points__row" role="listitem">
                <svg class="gm-points__ico" viewBox="-12 -12 24 24" aria-hidden="true"><circle class="gm-ico-pellet" r="3.2" /></svg>
                <span class="gm-points__k">pellet</span><b class="gm-points__v">10</b>
              </span>
              <span class="gm-points__row" role="listitem">
                <svg class="gm-points__ico" viewBox="-12 -12 24 24" aria-hidden="true"><circle class="gm-ico-power" r="7" /></svg>
                <span class="gm-points__k">power pellet</span><b class="gm-points__v">50</b>
              </span>
              <span class="gm-points__row" role="listitem">
                <svg class="gm-points__ico" viewBox="-14 -14 28 28" aria-hidden="true"><${GhostIcon} name="scared" /></svg>
                <span class="gm-points__k">ghost, in one fright</span><b class="gm-points__v gm-points__v--cy">200 · 400 · 800</b>
              </span>
              <span class="gm-points__row" role="listitem">
                <svg class="gm-points__ico" viewBox="-12 -12 24 24" aria-hidden="true"><rect class="gm-ico-maze" x="-9" y="-9" width="18" height="18" rx="4" /><rect class="gm-ico-maze gm-ico-maze--in" x="-5" y="-5" width="10" height="10" rx="2" /></svg>
                <span class="gm-points__k">maze cleared</span><b class="gm-points__v gm-points__v--ok">+500</b>
              </span>
              <span class="gm-points__row" role="listitem">
                <span class="gm-points__ico gm-points__ico--lives g-l1"><${Lives} n=${3} /></span>
                <span class="gm-points__k">lives each</span><b class="gm-points__v gm-points__v--err">3</b>
              </span>
            </div>
            <ul class="gm-roster">
              ${Object.entries(GHOST_RULE).map(
                ([name, rule], i) => html`<li key=${name} class=${`gm-roster__row gm-roster__row--${name.toLowerCase()}`} style=${{ '--gm-i': i }}>
                  <svg viewBox="-15 -15 30 30" class="gm-roster__ico" aria-hidden="true"><${GhostIcon} name=${name.toLowerCase()} look=${i === 1 ? 'left' : 'right'} /></svg>
                  <b class="gm-roster__name">${name.toUpperCase()}</b><span class="gm-roster__rule">${rule}</span>
                </li>`,
              )}
            </ul>
          <//>
          <${RecentRuns}
            gameId=${game.id}
            render=${(r) => html`<span class="g-mono g-muted">${r.layout?.name ?? ''} · ${r.mode === 'turns' ? 'turn-based' : 'real time'} · best ${fmtInt(bestScore(r))}</span>`}
          />
        </div>
      </div>
    <//>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [focus, setFocus] = useState(null)
  const L = useMemo(() => (run?.layout ? parseLayout(run.layout) : null), [run?.layout])
  if (!run || !L) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const firstJev = run.lanes.find((ln) => ln.kind === 'judgment')
  const lane = run.lanes[focus ?? firstJev?.index ?? 0] ?? run.lanes[0]
  const tick = Math.max(0, ...run.lanes.map((ln) => ln.tick ?? 0))
  const again = () => startGame(run.game, run.lanes.map((ln) => ({ key: ln.key })), { ...run.params, seed: run.seed })
  const live = isRunLive(run)
  // The game's rule: the most points among the lanes that played their game out.
  const winners = winnersOf(run)
  const solo = soloFinale(run)
  const won = new Set(!live && run.status === 'finished' ? winners : [])
  const best = bestScore(run)
  const share = run.total_ticks ? Math.min(1, tick / run.total_ticks) : 0
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${again} winners=${winners} headline=${solo?.headline} sub=${solo?.sub}>
        <${Chip} tone="cy">${run.mode === 'turns' ? 'TURN-BASED · the world waits' : `REAL TIME · ${perSecond(run.tick_ms)} ticks a second`}<//>
        <span class="g-mono g-muted">${L.name} · seed ${run.seed}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="gm-top">
        <span class="g-mono g-muted gm-top__hint">
          ${run.mode === 'turns'
            ? 'each world waits for its own player wherever there is a choice'
            : 'between decisions a player keeps going the way it last chose'}
        </span>
        <span class="spacer" />
        <div class=${`gm-clock${live ? ' is-live' : ''}`} style=${{ '--gm-tick': `${run.tick_ms}ms` }}>
          <span class="gm-clock__k" aria-hidden="true"><${PixelText} text="TICK" /></span>
          <span class="gm-clock__v tnum"><span class="sr-only">tick </span>${fmtInt(tick)}</span>
          <span class="gm-clock__track" aria-hidden="true"><span class="gm-clock__fill" style=${{ transform: `scaleX(${share})` }} /></span>
          <span class="gm-clock__of g-mono tnum">of ${fmtInt(run.total_ticks)}</span>
        </div>
      </div>
      <div class=${`gm-lanes${run.lanes.length === 1 ? ' gm-lanes--one' : ''}`}>
        ${run.lanes.map((ln) => html`<${LaneMaze} key=${ln.index} run=${run} lane=${ln} L=${L} best=${best} won=${won.has(ln.index)} />`)}
      </div>
      ${run.lanes.length > 1 &&
      html`<div class="gm-tabs" role="group" aria-label="Whose decisions to show">
        <span class="g-label"><span>DECISIONS OF</span></span>
        ${run.lanes.map(
          (ln) => html`<button type="button" key=${ln.index} class=${`gm-tab g-l${(ln.index % 4) + 1}${ln.index === lane.index ? ' gm-tab--on' : ''}`}
            aria-pressed=${ln.index === lane.index} onClick=${() => { sfx.select(); setFocus(ln.index) }}>
            <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
        )}
      </div>`}
      <div class="gm-bottom">
        <${Words} lane=${lane} />
        <${Stick} lane=${lane} />
        <${HourCost} run=${run} />
      </div>
    <//>
  `
}

/** One lane: its heading, then its cabinet's screen (1UP and HIGH SCORE over
 *  the maze, lives and the ticks it answered under it), then its numbers. */
function LaneMaze({ run, lane, L, best, won }) {
  const mood = laneMood(lane)
  // Jev answers inside a tick or two: only a call out a while is worth a word.
  const thinking = lane.status === 'playing' ? thinkingText(lane, run.tick_ms, run.mode === 'turns' ? 0 : 3) : null
  const answered = ticksAnswered(lane)
  const livesLeft = lane.lives ?? 0
  const badge = mood
    ? html`<span class="gm-badge">${thinking && html`<span class="gm-think">${thinking}</span>`}<${Chip} tone=${mood.tone}>${mood.text}<//></span>`
    : undefined
  const lag = meanLag(lane)
  const score = lane.score ?? 0
  const live = lane.status === 'playing'
  const top = run.lanes.length > 1 && score > 0 && score >= best
  return html`
    <${Box} lane=${lane.index} class=${`gm-lane${won ? ' gm-lane--win' : ''}`}>
      <${LaneHead} lane=${lane} badge=${badge} />
      <div class=${`gm-cab g-l${(lane.index % 4) + 1}${live ? ' is-live' : ''}`}>
        <div class="gm-hud">
          <span class="gm-hud__cell">
            <span class=${`gm-hud__k gm-hud__k--up${live ? ' is-blink' : ''}`} aria-hidden="true"><${PixelText} text=${upOf(lane.index)} /></span>
            <span class="sr-only">score</span><${Counter} value=${score} format=${fmtInt} class="gm-hud__v gm-hud__score" />
          </span>
          <span class=${`gm-hud__cell gm-hud__cell--mid${top ? ' is-top' : ''}`} title=${top ? 'this lane holds the round’s high score' : 'the round’s high score'}>
            <span class="gm-hud__k" aria-hidden="true"><${PixelText} text="HIGH SCORE" /></span>
            <span class="gm-hud__v tnum"><span class="sr-only">high score </span>${fmtInt(best)}${top ? html`<span class="gm-hud__crown" aria-label=", held here"> ★</span>` : null}</span>
          </span>
          <span class="gm-hud__cell gm-hud__cell--end">
            <span class="gm-hud__k" aria-hidden="true"><${PixelText} text="PELLETS" /></span>
            <span class="gm-hud__v tnum"><span class="sr-only">pellets left </span>${fmtInt(lane.left ?? 0)}</span>
          </span>
        </div>
        <${Maze} L=${L} lane=${lane} tickMs=${run.tick_ms} flashAt=${run.fright_ending} />
        <div class="gm-hud gm-hud--foot">
          <${Lives} n=${livesLeft} of=${run.lives ?? 3} label />
          ${won && html`<span class="gm-win"><span aria-hidden="true">★</span> WINNER</span>`}
          <span class="spacer" />
          ${run.mode === 'turns'
            ? html`<span class="gm-rate" title="decisions made: the world waited for each">
                <span class="gm-rate__k">decisions</span><b class="gm-rate__v tnum">${fmtInt(lane.answered ?? 0)}</b></span>`
            : html`<span class="gm-rate" title="ticks that got a fresh decision, of the ticks the world ran">
                <span class="gm-rate__k">ticks answered</span>
                <span class="gm-rate__track" aria-hidden="true"><span class=${`gm-rate__fill g-fill--${answered.ticks ? answered.tone : 'cy'}`} style=${{ transform: `scaleX(${answered.share})` }} /></span>
                <b class=${`gm-rate__v tnum${answered.ticks ? ` g-t-${answered.tone}` : ''}`}>${fmtInt(answered.answered)}/${fmtInt(answered.ticks)}</b>
              </span>`}
          <span class="gm-rate" title="time per decision"><span class="gm-rate__k">per decision</span><b class="gm-rate__v tnum">${fmtMs(perCall(lane))}</b></span>
        </div>
      </div>
      <${LaneStats} lane=${lane} extra=${html`
        <${Stat} label="lands late by" value=${Number.isFinite(lag) ? `${lag.toFixed(1)} ticks` : '—'} title="ticks between the state asked about and the answer landing" />
        ${lane.late ? html`<${Stat} label="too late" value=${lane.late} tone="warn" title="answers about a life already lost" />` : null}
      `} />
    <//>
  `
}

/** Lives as the arcade shows them: a small player each, facing left; a life
 *  lost is an empty outline. */
const LIFE = wedgePath(0, 0, 6.4, 'left', 36)
function Lives({ n, of = 3, label = false }) {
  const all = Math.max(of, n, 0)
  const a11y = label ? { role: 'img', 'aria-label': `${n} ${n === 1 ? 'life' : 'lives'} left of ${all}` } : { 'aria-hidden': 'true' }
  return html`
    <span class="gm-lives" ...${a11y}>
      ${Array.from({ length: all }, (_, i) => html`<svg key=${i} class=${`gm-life${i < n ? '' : ' gm-life--lost'}`} viewBox="-8 -8 16 16" aria-hidden="true"><path d=${LIFE} /></svg>`)}
    </span>
  `
}

/* ── The maze ──────────────────────────────────────────────────────────────── */

const pct = (v, of) => `${((v / of) * 100).toFixed(2)}%`

/** The screen's gradients, once per maze (ids unique to it). */
function defsOf(uid) {
  const halo = (name, color) => html`<radialGradient id=${`${uid}-h${name}`}>
    <stop offset="0" stop-color=${color} stop-opacity=".5" /><stop offset=".5" stop-color=${color} stop-opacity=".16" /><stop offset="1" stop-color=${color} stop-opacity="0" />
  </radialGradient>`
  return html`
    <defs>
      <radialGradient id=${`${uid}-floor`} cx="50%" cy="42%" r="78%">
        <stop offset="0" stop-color="#0e1240" /><stop offset=".7" stop-color="#050720" /><stop offset="1" stop-color="#020310" />
      </radialGradient>
      <linearGradient id=${`${uid}-wall`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#1a2170" /><stop offset=".55" stop-color="#0c1040" /><stop offset="1" stop-color="#070926" />
      </linearGradient>
      <radialGradient id=${`${uid}-pel`}>
        <stop offset="0" stop-color="#fffaf0" /><stop offset=".34" stop-color="#ffd9a8" /><stop offset=".5" stop-color="#ffc486" stop-opacity=".42" /><stop offset="1" stop-color="#ffb870" stop-opacity="0" />
      </radialGradient>
      <radialGradient id=${`${uid}-pow`}>
        <stop offset="0" stop-color="#ffffff" /><stop offset=".42" stop-color="#ffe2b8" /><stop offset=".56" stop-color="#ffc486" stop-opacity=".45" /><stop offset="1" stop-color="#ffb870" stop-opacity="0" />
      </radialGradient>
      <radialGradient id=${`${uid}-pac`} class="gm-grad-pac" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="13">
        <stop offset="0" /><stop offset=".62" /><stop offset="1" />
      </radialGradient>
      <radialGradient id=${`${uid}-halo`} class="gm-grad-halo">
        <stop offset="0" /><stop offset=".5" /><stop offset=".62" /><stop offset="1" />
      </radialGradient>
      ${Object.entries(GHOST_HUE).map(([name, color]) => halo(name, color))}
    </defs>
  `
}

/** The walls, double-lined neon over a bevelled fill, and the frame: drawn
 *  once per layout. The glow is a wide faint stroke, not a filter. */
function wallsOf(L, W, H, uid) {
  const rects = wallRects(L)
  const inner = rects.filter((r) => r.w > 9 && r.h > 9).map((r) => ({ x: r.x + 3.5, y: r.y + 3.5, w: r.w - 7, h: r.h - 7 }))
  const box = (r, rx) => html`<rect key=${`${r.x},${r.y}`} x=${r.x} y=${r.y} width=${r.w} height=${r.h} rx=${rx} />`
  return html`
    <g class="gm-walls" aria-hidden="true">
      <rect class="gm-floor" x="0" y="0" width=${W} height=${H} rx="12" fill=${`url(#${uid}-floor)`} />
      <g class="gm-walls__glow">
        <rect x="1.5" y="1.5" width=${W - 3} height=${H - 3} rx="11" />
        ${rects.map((r) => box(r, 6))}
      </g>
      <g class="gm-walls__out">
        <rect class="gm-walls__frame" x="1.5" y="1.5" width=${W - 3} height=${H - 3} rx="11" />
        <g fill=${`url(#${uid}-wall)`}>${rects.map((r) => box(r, 6))}</g>
      </g>
      <g class="gm-walls__in">
        <rect x="5" y="5" width=${W - 10} height=${H - 10} rx="8" />
        ${inner.map((r) => box(r, 3))}
      </g>
    </g>
  `
}

/** The pellets still there: small and warm, the power pellets big and
 *  blinking. */
function pelletsOf(L, eaten, uid) {
  const dot = (c, r, fill) => {
    const [x, y] = cellXY(c, L.cols)
    return html`<circle key=${c} cx=${x} cy=${y} r=${r} fill=${fill} />`
  }
  return html`
    <g class="gm-pellets" aria-hidden="true">${L.pellets.filter((c) => !eaten.has(c)).map((c) => dot(c, 4.8, `url(#${uid}-pel)`))}</g>
    <g class="gm-power" aria-hidden="true">${L.power.filter((c) => !eaten.has(c)).map((c) => dot(c, 10.5, `url(#${uid}-pow)`))}</g>
  `
}

/**
 * What just happened on a lane's maze, found by comparing each tick's view
 * with the last one this page saw: a life lost (where the player was), a
 * ghost eaten (its points, where the player ate it), the maze cleared. Kept
 * for as many ticks as their animations last; sounds and a small burst of
 * confetti follow the render. Only what is watched happening: a finished run
 * opened later replays none of it.
 */
function useMazeFx(lane, w, L, tickMs, still, box) {
  const seen = useRef(null)
  const fx = useRef({ death: null, pops: [], sound: null, burst: null })
  const f = fx.current
  if (!still) {
    const s = seen.current
    if (s && w.tick > s.tick) {
      if (w.player.gen !== s.gen) {
        const at = (s.heading && stepOf(L, s.cell, s.heading)) ?? s.cell
        f.death = { cell: at, heading: s.heading ?? 'right', key: `d${s.gen}`, until: w.tick + 14 }
        f.sound = 'down'
      } else if (w.ended === 'caught' && !s.ended) f.sound = 'down'
      const pts = ghostsEaten(s.ghosts, lane.ghosts).length ? ghostPoints(w.score - s.score) : null
      if (pts) {
        const [x, y] = cellXY(w.player.cell, L.cols)
        f.pops = [...f.pops, { key: `g${w.tick}`, x, y, pts, until: w.tick + Math.max(4, Math.ceil(1200 / tickMs)) }]
        f.sound = 'coin'
        f.burst = { x, y, colors: ['#3ef4ff', '#ffffff', '#8b7bff'], count: 16, power: 0.45 }
      }
      if (w.ended === 'cleared' && !s.ended) {
        f.sound = 'up'
        f.burst = { x: mazeSize(L).w / 2, y: mazeSize(L).h / 2, count: 60, power: 0.8 }
      }
    }
    if (f.death && w.tick > f.death.until) f.death = null
    if (f.pops.length) f.pops = f.pops.filter((p) => w.tick <= p.until)
    if (!s || w.tick !== s.tick) {
      seen.current = { tick: w.tick, gen: w.player.gen, cell: w.player.cell, heading: w.player.heading, ghosts: lane.ghosts, score: w.score, ended: w.ended }
    }
  }
  useEffect(() => {
    if (f.sound) {
      sfx[f.sound]?.()
      f.sound = null
    }
    const b = f.burst
    const el = box.current
    if (b && el) {
      f.burst = null
      const r = el.getBoundingClientRect()
      const { w: W, h: H } = mazeSize(L)
      burst({ x: r.left + (r.width * b.x) / W, y: r.top + (r.height * b.y) / H, colors: b.colors, count: b.count, power: b.power })
    }
  })
  return f
}

/** A lane's maze: walls, pellets, ghosts, the player, and what just happened. */
function Maze({ L, lane, tickMs = 100, flashAt = 20, still = false }) {
  const uid = useMemo(() => `gm${++UID}`, [])
  const box = useRef(null)
  const { w: W, h: H } = mazeSize(L)
  const defs = useMemo(() => defsOf(uid), [uid])
  const walls = useMemo(() => wallsOf(L, W, H, uid), [L, uid])
  const eatenList = lane.eaten
  const eaten = useMemo(() => new Set(eatenList ?? []), [eatenList])
  const pellets = useMemo(() => pelletsOf(L, eaten, uid), [L, eaten, uid])
  const w = laneWorld(lane)
  const fx = useMazeFx(lane, w, L, tickMs, still, box)
  const hint = !still && isFresh(lane) && !w.pause && !w.ended ? lane.last : null
  const [px, py] = cellXY(w.player.cell, L.cols)
  const moving = !w.pause && !w.ended && w.player.heading && isOpen(L, w.player.cell, w.player.heading)
  const pac = still ? 'chomp' : w.ended === 'caught' ? 'dead' : w.pause > 0 || !w.tick ? 'ready' : moving ? 'chomp' : 'rest'
  const say = screenText(lane, still)
  const sparks = still ? [] : recentlyEaten(L, lane.eaten, 3)
  // READY! sits where the arcade puts it: between the ghosts' starts and the player's.
  const homes = Object.values(L.homes)
  const sayY = homes.length ? (cellXY(L.player, L.cols)[1] + homes.reduce((a, c) => a + cellXY(c, L.cols)[1], 0) / homes.length) / 2 : H / 2
  const move = (x, y) => ({ transform: `translate(${x}px, ${y}px)` })
  const cls = `gm-screen g-l${(lane.index % 4) + 1}${w.ended === 'cleared' ? ' gm-screen--cleared' : ''}${w.fright > 0 && !w.ended ? ' gm-screen--power' : ''}${still ? ' gm-screen--still' : ''}`
  return html`
    <div class=${cls} ref=${box} style=${{ '--gm-tick': `${tickMs}ms` }}>
      <svg class="gm-maze" viewBox=${`0 0 ${W} ${H}`} role="img" aria-label=${still ? `The ${L.name} maze: ${L.blurb}` : mazeLabel(lane, L)}>
        ${defs}
        ${walls}
        ${pellets}
        ${sparks.length > 0 && html`<g class="gm-sparks" aria-hidden="true">
          ${sparks.map((s) => {
            const [x, y] = cellXY(s.cell, L.cols)
            return html`<circle key=${`s${s.cell}`} class=${`gm-spark${s.power ? ' gm-spark--power' : ''}`} cx=${x} cy=${y} r=${s.power ? 8 : 4} />`
          })}
        </g>`}
        ${hint && html`<g key=${`h${w.player.gen}`} class="gm-mover gm-hint" style=${move(px, py)} aria-hidden="true">
          ${stickArms(hint).filter((a) => a.offered && (a.p >= 0.05 || a.chosen)).map((a) => {
            const [dx, dy] = STEP[a.way]
            const r0 = CELL * 0.55
            const r1 = r0 + 4 + a.len * 0.45
            return html`<path key=${a.way} d=${`M${dx * r0} ${dy * r0} L${dx * r1} ${dy * r1}`}
              style=${{ strokeWidth: `${Math.max(2, a.width * 0.55)}px`, opacity: a.opacity * 0.8 }} />`
          })}
        </g>`}
        ${fx.death && html`<${Death} key=${fx.death.key} at=${cellXY(fx.death.cell, L.cols)} heading=${fx.death.heading} uid=${uid} />`}
        ${w.ghosts.map((g) => html`<${Ghost} key=${`${g.name}-${g.gen}`} g=${g} L=${L} uid=${uid} flash=${w.fright > 0 && w.fright <= flashAt} />`)}
        <${Pac} key=${`p${w.player.gen}`} x=${px} y=${py} heading=${w.player.heading ?? 'right'} state=${pac} uid=${uid} />
      </svg>
      ${!still && w.caughtAt != null && html`<span key=${`hit${w.caughtAt}`} class="gm-screen__hit" aria-hidden="true" />`}
      <div class="gm-screen__over" aria-hidden="true">
        ${say && html`<div key=${say.text} class=${`gm-say gm-say--${say.tone}`} style=${{ top: pct(sayY, H) }}>
          <${PixelText} text=${say.text} />${say.sub && html`<span class="gm-say__sub">${say.sub}</span>`}
        </div>`}
        ${fx.pops.map((p) => html`<span key=${p.key} class="gm-pts" style=${{ left: pct(p.x, W), top: pct(p.y, H) }}><${PixelText} text=${String(p.pts)} /></span>`)}
      </div>
    </div>
  `
}

/** The player: two halves in the lane's colour, turned to its heading, that
 *  chomp while it runs, rest half open against a wall, close for READY!, and
 *  fold away when its last life goes. */
function Pac({ x, y, heading, state, uid }) {
  return html`
    <g class=${`gm-mover gm-pac gm-pac--${state}`} style=${{ transform: `translate(${x}px, ${y}px)` }}>
      <circle class="gm-pac__halo" r="22" fill=${`url(#${uid}-halo)`} />
      <g class="gm-pac__face" style=${{ transform: `rotate(${ANGLE[heading] ?? 0}deg)` }}>
        <path class="gm-pac__half gm-pac__half--top" d=${PAC.top} fill=${`url(#${uid}-pac)`} />
        <path class="gm-pac__half gm-pac__half--bot" d=${PAC.bottom} fill=${`url(#${uid}-pac)`} />
      </g>
    </g>
  `
}

/** Where a life was lost: the player folds up and pops, once. */
function Death({ at: [x, y], heading, uid }) {
  return html`
    <g class="gm-death" transform=${`translate(${x} ${y})`} aria-hidden="true">
      <g transform=${`rotate(${ANGLE[heading] ?? 0})`}>
        <path class="gm-death__half gm-death__half--top" d=${PAC.top} fill=${`url(#${uid}-pac)`} />
        <path class="gm-death__half gm-death__half--bot" d=${PAC.bottom} fill=${`url(#${uid}-pac)`} />
      </g>
      <g class="gm-death__pop">
        ${[0, 45, 90, 135, 180, 225, 270, 315].map((a) => html`<path key=${a} transform=${`rotate(${a})`} d="M7 0 H13" />`)}
      </g>
    </g>
  `
}

function Ghost({ g, L, uid, flash }) {
  const [x, y] = cellXY(g.cell, L.cols)
  const name = g.name.toLowerCase()
  const scared = g.mode === 'f'
  const mode = scared ? ` gm-ghost--scared${flash ? ' gm-ghost--flash' : ''}` : g.mode === 'e' ? ' gm-ghost--eyes' : ''
  return html`
    <g class=${`gm-mover gm-ghost gm-ghost--${name}${mode}`} style=${{ transform: `translate(${x}px, ${y}px)` }}>
      <${GhostIcon} name=${scared ? 'scared' : name} look=${g.heading} eyes=${g.mode === 'e'} halo=${`url(#${uid}-h${scared ? 'scared' : name})`} />
    </g>
  `
}

/** A ghost's drawing, centred on 0 0: a halo, the body in two skirt frames
 *  (shown in turn, so the hem ripples), the shine on its dome, and eyes that
 *  look the way it goes; frightened, a blue body and a wobbly mouth; eaten,
 *  only the eyes. */
function GhostIcon({ name, look, eyes = false, halo }) {
  const [wx, wy] = pupil(look, 1)
  const [px, py] = pupil(look, 2.2)
  return html`
    ${halo && !eyes && html`<circle class="gm-ghost__halo" r="21" fill=${halo} />`}
    ${!eyes && html`<g class="gm-ghost__skin" style=${{ '--gm-ghost': GHOST_HUE[name] ?? GHOST_HUE.blinky }}>
      <path class="gm-ghost__frame gm-ghost__frame--a" d=${SKIRT[0]} />
      <path class="gm-ghost__frame gm-ghost__frame--b" d=${SKIRT[1]} />
      <path class="gm-ghost__sheen" d=${SHEEN} />
    </g>`}
    ${name === 'scared'
      ? html`<g class="gm-ghost__face">
          <rect class="gm-ghost__dot" x="-6" y="-4.4" width="3.4" height="3.4" rx=".8" /><rect class="gm-ghost__dot" x="2.6" y="-4.4" width="3.4" height="3.4" rx=".8" />
          <path class="gm-ghost__mouth" d=${scaredMouth(0, 0)} />
        </g>`
      : html`<g class="gm-ghost__eyes">
          <ellipse class="gm-ghost__white" cx=${-4.6 + wx} cy=${-2 + wy} rx="3.3" ry="4" /><ellipse class="gm-ghost__white" cx=${4.6 + wx} cy=${-2 + wy} rx="3.3" ry="4" />
          <circle class="gm-ghost__pupil" cx=${-4.6 + px} cy=${-1.6 + py} r="1.8" /><circle class="gm-ghost__pupil" cx=${4.6 + px} cy=${-1.6 + py} r="1.8" />
        </g>`}
  `
}

/* ── One lane's decisions ──────────────────────────────────────────────────── */

/** The world as the lane's model last read it: words, never coordinates. */
function Words({ lane }) {
  const rows = wordsRows(lane.words)
  const options = Object.entries(lane.words?.options ?? {})
  const jev = lane.kind === 'judgment'
  const chosen = lane.last && lane.words && lane.last.tick === lane.words.tick ? lane.last.dir : null
  return html`
    <${Box} lane=${lane.index} class="gm-words">
      <${Label} note=${lane.words ? `asked on tick ${lane.words.tick}` : null}>
        ${jev ? 'WHAT JEV GETS' : `WHAT ${lane.label} READS`} · IN WORDS, NOT COORDINATES
      <//>
      ${!rows.length && html`<p class="g-muted">No decision asked yet.</p>`}
      ${rows.length > 0 && html`
        <div class="gm-words__screen" key=${lane.words.tick}>
          <dl class="gm-words__state">
            ${rows.map(([k, v], i) => html`<div key=${i} class="gm-words__row" style=${{ '--gm-i': i }}><dt>${k}</dt><dd>${v}</dd></div>`)}
          </dl>
        </div>
        <${Label}>${jev ? 'THE CHOICE: ONE OPTION PER OPEN WAY' : 'OPEN DIRECTIONS'}<//>
        <ul class="gm-words__opts">
          ${options.map(([way, m]) => {
            const cut = m.indexOf(': ')
            const on = way === chosen
            return html`<li key=${way} class=${`gm-words__opt${on ? ' is-chosen' : ''}`}>
              <span class="gm-words__way" aria-hidden="true">${WAY_GLYPH[way] ?? '•'}</span>
              <span class="gm-words__m">${cut > 0 ? html`<b>${m.slice(0, cut)}</b>${m.slice(cut)}` : m}</span>
              ${on ? html`<span class="gm-words__pick">✓ chosen</span>` : null}
            </li>`
          })}
        </ul>`}
      <p class="gm-words__note">
        Code builds these sentences from the game state each time it asks. jev-1.13 is weak with raw coordinates,
        so no player ever sees one.
      </p>
    <//>
  `
}

/* The stick's centre, where its arms start, how long the longest is, and
 * where their labels sit. */
const SX = 120
const SY = 100
const ARM0 = 22
const ARM_MAX = 40
const TAG = { up: 88, down: 92, left: 100, right: 100 }
/** The lane's latest decision as an arcade stick seen from above: an arm per
 *  way, sized by its probability; the ball leans the way it chose; a ring
 *  pings on every new decision. */
function Stick({ lane }) {
  const uid = useMemo(() => `gms${++UID}`, [])
  const last = lane.last
  const arms = stickArms(last)
  const top = arms.reduce((a, b) => (b.p > a.p ? b : a), arms[0])
  const jev = !!last?.p
  const lateBy = last ? last.at - last.tick : 0
  const [lx, ly] = last?.dir && STEP[last.dir] ? STEP[last.dir] : [0, 0]
  return html`
    <${Box} lane=${lane.index} class="gm-stick">
      <${Label}>${jev ? 'JEV’S STICK' : 'ITS STICK'} · LATEST DECISION<//>
      <svg viewBox="0 0 240 200" role="img" aria-label=${stickLabel(lane)} class=${`gm-stick__svg g-l${(lane.index % 4) + 1}`}>
        <defs>
          <linearGradient id=${`${uid}-plate`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#23275e" /><stop offset="1" stop-color="#0a0b24" />
          </linearGradient>
          <radialGradient id=${`${uid}-gate`} cx="50%" cy="45%" r="55%">
            <stop offset="0" stop-color="#05061a" /><stop offset=".8" stop-color="#0b0d2c" /><stop offset="1" stop-color="#1b1f52" />
          </radialGradient>
          <radialGradient id=${`${uid}-ball`} class="gm-grad-ball" cx="38%" cy="34%" r="70%">
            <stop offset="0" /><stop offset=".35" /><stop offset="1" />
          </radialGradient>
        </defs>
        <rect class="gm-stick__plate" x="36" y="16" width="168" height="168" rx="24" fill=${`url(#${uid}-plate)`} />
        <circle class="gm-stick__gate" cx=${SX} cy=${SY} r="72" fill=${`url(#${uid}-gate)`} />
        ${arms.map((a) => {
          const [dx, dy] = STEP[a.way]
          const tx = SX + dx * TAG[a.way]
          const ty = SY + dy * TAG[a.way] + 4
          const turn = `translate(${SX} ${SY}) rotate(${ANGLE[a.way]})`
          if (!a.offered)
            return html`<g key=${a.way} class="gm-stick__wall">
              <g transform=${turn}><rect x=${ARM0} y="-6" width="22" height="12" rx="3" /><path d=${`M${ARM0 + 4} -6 l8 12 M${ARM0 + 12} -6 l8 12`} /></g>
              <text x=${tx} y=${ty}>wall</text>
            </g>`
          const head = a === top && a.p > 0
          return html`<g key=${a.way} class=${`gm-stick__arm${head ? ' gm-stick__arm--top' : ''}`}>
            <g transform=${turn}>
              <rect class="gm-stick__slot" x=${ARM0 - 2} y="-8" width=${ARM_MAX + 4} height="16" rx="8" />
              <rect class="gm-stick__bar" x=${ARM0} y="-6" width=${ARM_MAX} height="12" rx="6"
                style=${{ transform: `scale(${(a.len / ARM_MAX).toFixed(3)}, ${(a.width / 12).toFixed(3)})`, opacity: a.opacity }} />
              ${head && html`<path class="gm-stick__head" d="M0 -9 L12 0 L0 9 Z" style=${{ transform: `translateX(${ARM0 + a.len + 1}px)` }} />`}
            </g>
            <text x=${tx} y=${ty}>${jev ? a.p.toFixed(2) : a.chosen ? 'MOVE' : 'open'}</text>
          </g>`
        })}
        <g class="gm-stick__knob" style=${{ transform: `translate(${SX + lx * 8}px, ${SY + ly * 8}px)` }}>
          <circle class="gm-stick__shaft" r="9" />
          ${last && html`<circle key=${`${last.tick}-${last.at}`} class="gm-stick__ping" r="18" />`}
          <circle class="gm-stick__ball" r="17" fill=${`url(#${uid}-ball)`} />
          <ellipse class="gm-stick__shine" cx="-5" cy="-6" rx="6" ry="4" />
        </g>
        ${last?.foul && html`<text x=${SX} y=${SY + 6} class="gm-stick__foul">✕</text>`}
      </svg>
      ${!last && html`<p class="g-muted">No decision yet.</p>`}
      ${last && jev && html`<${Bars} lane=${lane.index} compact max=${4}
        items=${arms.filter((a) => a.offered).sort((a, b) => b.p - a.p).map((a) => ({ label: a.way, p: a.p }))} />`}
      ${last && !jev && html`<p class=${`gm-stick__said g-mono${last.foul ? ' g-t-err' : ''}`}>
        ${last.foul ? `✕ foul: ${last.foul}` : `MOVE: ${last.dir}`}${last.said && last.foul ? html`<span class="g-muted"> · said “${last.said}”</span>` : null}
      </p>`}
      ${last && html`<p class="g-mono g-muted gm-stick__when">
        asked on tick ${last.tick} · landed on tick ${last.at}${lateBy ? ` (${lateBy} late)` : ''} · ${fmtMs(last.ms)}
        ${last.late ? html`<span class="g-t-warn"> · too late: a life was lost since</span>` : null}
      </p>`}
    <//>
  `
}

/** What an hour of play would cost each lane, at its own pace. */
function HourCost({ run }) {
  const rows = run.lanes.map((ln) => ({ ln, c: hourCost(ln, run.tick_ms) }))
  const jev = rows.find((r) => r.ln.kind === 'judgment' && r.ln.calls)
  const dearest = rows.filter((r) => r.ln.kind !== 'judgment' && r.c.atTen != null).sort((a, b) => b.c.atTen - a.c.atTen)[0]
  const rate = `$${(run.jev_per_mtok ?? 0.042).toFixed(3)}`
  const jevNote = jev ? `: ten decisions a second is ≈ ${fmtMoney(jev.c.atTen)} an hour` : ''
  const textNote = dearest ? ` ${dearest.ln.label} at ten a second would be ≈ ${fmtMoney(dearest.c.atTen)} an hour, if it could keep up.` : ''
  return html`
    <${Box} class="gm-cost">
      <${Label}>WHAT AN HOUR COSTS<//>
      <div class="scroll-x"><table class="g-table gm-cost__table">
        <thead><tr><th>player</th><th class="num">tokens a decision</th><th class="num">decisions an hour</th><th class="num">an hour</th></tr></thead>
        <tbody>
          ${rows.map(
            ({ ln, c }) => html`<tr key=${ln.index} class=${ln.kind === 'judgment' ? 'gm-cost__jev' : ''}>
              <td><span class="gm-cost__who"><${LaneNum} i=${ln.index} /> ${ln.label}</span></td>
              <td class="num">${Number.isFinite(c.tokens) ? `~${fmtInt(c.tokens)}` : '—'}</td>
              <td class="num">${fmtInt(c.perHour)}</td>
              <td class=${`num gm-cost__usd${ln.kind === 'judgment' && c.dollars != null ? ' g-t-ok' : ''}`}>
                ${c.dollars == null ? (ln.provider === 'ollama' && ln.calls ? '$0 · local' : '—') : `≈ ${fmtMoney(c.dollars)}`}</td>
            </tr>`,
          )}
        </tbody>
      </table></div>
      <p class="gm-cost__note">
        At each player's own pace, one decision a tick at most. Jev reads at ${rate} per million input tokens and
        writes nothing${jevNote}.${textNote}
      </p>
      <p class="gm-cost__note">
        TypeSafe's own Doom demo runs Jev at about ten decisions a second. This is that idea, in a game the page can draw.
      </p>
    <//>
  `
}
