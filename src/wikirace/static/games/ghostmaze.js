/* Ghost Maze — same maze, same seed, one clock. The ghosts don't wait.
 *
 * The server (games/ghostmaze.py, ghostmaze_sim.py) owns every world and the
 * clock; this page draws them: one maze per lane, side by side, its player a
 * wedge in the lane's colour gliding tile to tile (a CSS transition as long as
 * a tick), three ghosts, the pellets as they go, a CAUGHT flash; each lane's
 * score, ticks answered, time per decision and lives; then, for one lane at a
 * time, the world in the words its model was given, Jev's stick (an arm per
 * way, sized by probability, walls not offered), and what an hour of play
 * costs. The geometry is ghostmaze.logic.js, where it is tested.
 */
import { useEffect, useMemo, useState } from 'preact/hooks'
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
  fmtMs,
  html,
  perCall,
  startGame,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import {
  CELL,
  STEP,
  banner,
  bestScore,
  cellXY,
  fmtInt,
  fmtMoney,
  ghostPath,
  hourCost,
  isFresh,
  isOpen,
  laneMood,
  laneWorld,
  mazeLabel,
  mazeSize,
  meanLag,
  parseLayout,
  pupil,
  scaredMouth,
  startView,
  stickArms,
  stickLabel,
  thinkingText,
  ticksAnswered,
  wallRects,
  wedgePath,
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
          <${Box}>
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
              ${L && html`<div class="gm-how__maze"><${Maze} L=${L} lane=${{ index: 0, label: L.name, ...startView(L) }} tickMs=${tickMs} still /></div>`}
            </div>
            <div class="gm-rules">
              <${Chip}>pellet 10<//><${Chip}>power pellet 50<//><${Chip} tone="cy">ghost 200 · 400 · 800<//>
              <${Chip} tone="ok">maze cleared +500<//><${Chip} tone="err">3 lives<//>
            </div>
            <ul class="gm-ghostkey">
              ${Object.entries(GHOST_RULE).map(
                ([name, rule]) => html`<li key=${name}>
                  <svg viewBox="-14 -14 28 28" class=${`gm-ghost gm-ghost--${name.toLowerCase()}`} aria-hidden="true">
                    <path class="gm-ghost__body" d=${ghostPath(0, 0)} />
                    <circle class="gm-ghost__eye" cx="-4.5" cy="-1" r="3" /><circle class="gm-ghost__eye" cx="4.5" cy="-1" r="3" />
                  </svg>
                  <b>${name}</b> <span class="g-muted">${rule}</span>
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
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${again}>
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
        <span class="gm-top__tick tnum">tick ${fmtInt(tick)}</span>
        <span class="g-mono g-muted">of ${fmtInt(run.total_ticks)}</span>
      </div>
      <div class=${`gm-lanes${run.lanes.length === 1 ? ' gm-lanes--one' : ''}`}>
        ${run.lanes.map((ln) => html`<${LaneMaze} key=${ln.index} run=${run} lane=${ln} L=${L} />`)}
      </div>
      ${run.lanes.length > 1 &&
      html`<div class="gm-tabs" role="group" aria-label="Whose decisions to show">
        <span class="g-label"><span>DECISIONS OF</span></span>
        ${run.lanes.map(
          (ln) => html`<button type="button" key=${ln.index} class=${`gm-tab${ln.index === lane.index ? ' gm-tab--on' : ''}`}
            aria-pressed=${ln.index === lane.index} onClick=${() => setFocus(ln.index)}>
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

/** One lane: its heading, its maze, its numbers. */
function LaneMaze({ run, lane, L }) {
  const mood = laneMood(lane)
  // Jev answers inside a tick or two: only a call out a while is worth a word.
  const thinking = lane.status === 'playing' ? thinkingText(lane, run.tick_ms, run.mode === 'turns' ? 0 : 3) : null
  const answered = ticksAnswered(lane)
  const livesLeft = lane.lives ?? 0
  const badge = mood
    ? html`<span class="gm-badge">${thinking && html`<span class="gm-think">${thinking}</span>`}<${Chip} tone=${mood.tone}>${mood.text}<//></span>`
    : undefined
  const lag = meanLag(lane)
  return html`
    <${Box} lane=${lane.index} class="gm-lane">
      <${LaneHead} lane=${lane} badge=${badge} />
      <div class="gm-lane__row">
        <${Maze} L=${L} lane=${lane} tickMs=${run.tick_ms} flashAt=${run.fright_ending} />
        <div class="g-stats gm-big">
          <${Stat} label="score" value=${fmtInt(lane.score ?? 0)} />
          ${run.mode === 'turns'
            ? html`<${Stat} label="decisions" value=${fmtInt(lane.answered ?? 0)} title="decisions made: the world waited for each" />`
            : html`<${Stat} label="ticks answered" value=${`${fmtInt(answered.answered)}/${fmtInt(answered.ticks)}`}
                tone=${answered.ticks ? answered.tone : undefined} title="ticks that got a fresh decision, of the ticks the world ran" />`}
          <${Stat} label="per decision" value=${fmtMs(perCall(lane))} />
          <${Stat} label="lives" value=${livesLeft} tone=${livesLeft >= 3 ? 'ok' : livesLeft === 2 ? 'warn' : 'err'} />
        </div>
      </div>
      <${LaneStats} lane=${lane} extra=${html`
        <${Stat} label="lands late by" value=${Number.isFinite(lag) ? `${lag.toFixed(1)} ticks` : '—'} title="ticks between the state asked about and the answer landing" />
        ${lane.late ? html`<${Stat} label="too late" value=${lane.late} tone="warn" title="answers about a life already lost" />` : null}
      `} />
    <//>
  `
}

/* ── The maze ──────────────────────────────────────────────────────────────── */

/** A lane's maze: walls, pellets, ghosts, the player, and what just happened. */
function Maze({ L, lane, tickMs = 100, flashAt = 20, still = false }) {
  const { w: W, h: H } = mazeSize(L)
  const walls = useMemo(() => wallRects(L), [L])
  const eaten = useMemo(() => new Set(lane.eaten ?? []), [lane.eaten])
  const w = laneWorld(lane)
  const b = still ? null : banner(lane)
  const hint = !still && isFresh(lane) && !w.pause && !w.ended ? lane.last : null
  const [px, py] = cellXY(w.player.cell, L.cols)
  const moving = !w.pause && !w.ended && w.player.heading && isOpen(L, w.player.cell, w.player.heading)
  const mouth = still ? 30 : moving ? (w.tick % 2 ? 38 : 10) : 26
  const out = w.ended === 'caught' || w.pause > 0
  const move = (x, y) => ({ transform: `translate(${x}px, ${y}px)` })
  return html`
    <svg class=${`gm-maze g-l${(lane.index % 4) + 1}`} viewBox=${`0 0 ${W} ${H}`} role="img"
      aria-label=${still ? `The ${L.name} maze: ${L.blurb}` : mazeLabel(lane, L)} style=${{ '--gm-tick': `${tickMs}ms` }}>
      <rect x="2" y="2" width=${W - 4} height=${H - 4} rx="10" class="gm-frame" />
      <g class="gm-walls">
        ${walls.map((r) => html`<rect key=${`${r.x},${r.y}`} x=${r.x} y=${r.y} width=${r.w} height=${r.h} rx="6" />`)}
      </g>
      <g class="gm-pellets">
        ${L.pellets.filter((c) => !eaten.has(c)).map((c) => {
          const [x, y] = cellXY(c, L.cols)
          return html`<circle key=${c} cx=${x} cy=${y} r="2.6" />`
        })}
      </g>
      <g class="gm-power">
        ${L.power.filter((c) => !eaten.has(c)).map((c) => {
          const [x, y] = cellXY(c, L.cols)
          return html`<circle key=${c} cx=${x} cy=${y} r="6.5" />`
        })}
      </g>
      ${hint && html`<g key=${`h${w.player.gen}`} class="gm-mover gm-hint" style=${move(px, py)} aria-hidden="true">
        ${stickArms(hint).filter((a) => a.offered && (a.p >= 0.05 || a.chosen)).map((a) => {
          const [dx, dy] = STEP[a.way]
          const r0 = CELL * 0.55
          const r1 = r0 + 4 + a.len * 0.45
          return html`<path key=${a.way} d=${`M${dx * r0} ${dy * r0} L${dx * r1} ${dy * r1}`}
            style=${{ strokeWidth: `${Math.max(2, a.width * 0.55)}px`, opacity: a.opacity * 0.8 }} />`
        })}
      </g>`}
      ${w.ghosts.map((g) => html`<${Ghost} key=${`${g.name}-${g.gen}`} g=${g} L=${L} flash=${w.fright > 0 && w.fright <= flashAt} />`)}
      <g key=${`p${w.player.gen}`} class=${`gm-mover gm-player${out ? ' gm-player--out' : ''}`} style=${move(px, py)}>
        <path d=${wedgePath(0, 0, 13, w.player.heading ?? 'right', mouth)} />
      </g>
      ${b && html`<g class=${`gm-banner gm-banner--${b.tone}`}>
        <rect x=${W / 2 - 100} y="12" width="200" height="26" rx="3" />
        <text x=${W / 2} y="30">${b.text}</text>
      </g>`}
    </svg>
  `
}

function Ghost({ g, L, flash }) {
  const [x, y] = cellXY(g.cell, L.cols)
  const [dx, dy] = pupil(g.heading)
  const mode = g.mode === 'f' ? ` gm-ghost--scared${flash ? ' gm-ghost--flash' : ''}` : g.mode === 'e' ? ' gm-ghost--eyes' : ''
  return html`
    <g class=${`gm-mover gm-ghost gm-ghost--${g.name.toLowerCase()}${mode}`} style=${{ transform: `translate(${x}px, ${y}px)` }}>
      ${g.mode !== 'e' && html`<path class="gm-ghost__body" d=${ghostPath(0, 0)} />`}
      ${g.mode === 'f'
        ? html`<circle class="gm-ghost__dot" cx="-4" cy="-2" r="1.6" /><circle class="gm-ghost__dot" cx="4" cy="-2" r="1.6" />
            <path class="gm-ghost__mouth" d=${scaredMouth(0, 0)} />`
        : html`<circle class="gm-ghost__eye" cx="-4.5" cy="-1" r="3" /><circle class="gm-ghost__eye" cx="4.5" cy="-1" r="3" />
            <circle class="gm-ghost__pupil" cx=${-4.5 + dx} cy=${-1 + dy} r="1.4" /><circle class="gm-ghost__pupil" cx=${4.5 + dx} cy=${-1 + dy} r="1.4" />`}
    </g>
  `
}

/* ── One lane's decisions ──────────────────────────────────────────────────── */

/** The world as the lane's model last read it: words, never coordinates. */
function Words({ lane }) {
  const rows = wordsRows(lane.words)
  const options = Object.values(lane.words?.options ?? {})
  const jev = lane.kind === 'judgment'
  return html`
    <${Box} lane=${lane.index} class="gm-words">
      <${Label} note=${lane.words ? `asked on tick ${lane.words.tick}` : null}>
        ${jev ? 'WHAT JEV GETS' : `WHAT ${lane.label} READS`} · IN WORDS, NOT COORDINATES
      <//>
      ${!rows.length && html`<p class="g-muted">No decision asked yet.</p>`}
      ${rows.length > 0 && html`
        <dl class="gm-words__state">
          ${rows.map(([k, v], i) => html`<div key=${i} class="gm-words__row"><dt>${k}</dt><dd>${v}</dd></div>`)}
        </dl>
        <${Label}>${jev ? 'THE CHOICE: ONE OPTION PER OPEN WAY' : 'OPEN DIRECTIONS'}<//>
        <ul class="gm-words__opts">
          ${options.map((m, i) => {
            const cut = m.indexOf(': ')
            return html`<li key=${i}><b>${m.slice(0, cut)}</b>${m.slice(cut)}</li>`
          })}
        </ul>`}
      <p class="gm-words__note">
        Code builds these sentences from the game state each time it asks. jev-1.13 is weak with raw coordinates,
        so no player ever sees one.
      </p>
    <//>
  `
}

/* The stick's centre, where its arms start, and where their labels sit. */
const SX = 110
const SY = 85
const ARM0 = 22
const TAG = { up: 76, down: 76, left: 88, right: 88 }
/** The lane's latest decision as a stick: an arm per way sized by its probability. */
function Stick({ lane }) {
  const last = lane.last
  const arms = stickArms(last)
  const top = arms.reduce((a, b) => (b.p > a.p ? b : a), arms[0])
  const jev = !!last?.p
  const lateBy = last ? last.at - last.tick : 0
  return html`
    <${Box} lane=${lane.index} class="gm-stick">
      <${Label}>${jev ? 'JEV’S STICK' : 'ITS STICK'} · LATEST DECISION<//>
      <svg viewBox="0 0 220 170" role="img" aria-label=${stickLabel(lane)} class=${`gm-stick__svg g-l${(lane.index % 4) + 1}`}>
        <circle cx=${SX} cy=${SY} r="18" class="gm-stick__knob" />
        ${arms.map((a) => {
          const [dx, dy] = STEP[a.way]
          const x0 = SX + dx * ARM0
          const y0 = SY + dy * ARM0
          const tx = SX + dx * TAG[a.way]
          const ty = SY + dy * TAG[a.way] + 4
          if (!a.offered)
            return html`<g key=${a.way} class="gm-stick__wall">
              <path d=${`M${x0} ${y0} L${SX + dx * (ARM0 + 18)} ${SY + dy * (ARM0 + 18)}`} />
              <text x=${tx} y=${ty}>wall</text>
            </g>`
          const x1 = SX + dx * (ARM0 + a.len)
          const y1 = SY + dy * (ARM0 + a.len)
          const head = a === top && a.p > 0
          const hx = x1 + dx * 6
          const hy = y1 + dy * 6
          const side = 9 + a.width * 0.3
          return html`<g key=${a.way} class=${`gm-stick__arm${head ? ' gm-stick__arm--top' : ''}`}>
            <path d=${`M${x0} ${y0} L${x1} ${y1}`} style=${{ strokeWidth: `${a.width}px`, opacity: a.opacity }} />
            ${head && html`<path class="gm-stick__head"
              d=${`M${hx - dx * 12 + dy * side} ${hy - dy * 12 + dx * side} L${hx} ${hy} L${hx - dx * 12 - dy * side} ${hy - dy * 12 - dx * side}`} />`}
            <text x=${tx} y=${ty}>${jev ? a.p.toFixed(2) : a.chosen ? 'MOVE' : 'open'}</text>
          </g>`
        })}
        ${last?.foul && html`<text x=${SX} y=${SY + 5} class="gm-stick__foul">✕</text>`}
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
      <table class="g-table gm-cost__table">
        <thead><tr><th>player</th><th class="num">tokens a decision</th><th class="num">decisions an hour</th><th class="num">an hour</th></tr></thead>
        <tbody>
          ${rows.map(
            ({ ln, c }) => html`<tr key=${ln.index}>
              <td><span class="gm-cost__who"><${LaneNum} i=${ln.index} /> ${ln.label}</span></td>
              <td class="num">${Number.isFinite(c.tokens) ? `~${fmtInt(c.tokens)}` : '—'}</td>
              <td class="num">${fmtInt(c.perHour)}</td>
              <td class=${`num${ln.kind === 'judgment' && c.dollars != null ? ' g-t-ok' : ''}`}>
                ${c.dollars == null ? (ln.provider === 'ollama' && ln.calls ? '$0 · local' : '—') : `≈ ${fmtMoney(c.dollars)}`}</td>
            </tr>`,
          )}
        </tbody>
      </table>
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
