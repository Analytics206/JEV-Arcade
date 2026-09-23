/* Judges' Panel — Jev scores each quality once; you decide what matters.
 *
 * The server (games/judges.py) asks Jev once per contestant: five Score
 * questions, one per judge, over the contestant's Wikipedia introduction. The
 * page does the rest in code: the weights under the judges make a composite
 * (judges.logic.js), and the leaderboard re-ranks as they move, with no new
 * request.
 *
 * It is drawn as a talent show at night: five judges on a stage, each in a
 * spotlight that burns as bright as their weight, holding up a score paddle
 * for the contestant in front of them (it pops up as the score lands, and
 * tilts more the less sure Jev was). Under each judge is a mixing-desk fader,
 * its weight. The leaderboard slides rows to their new places as a fader
 * moves (FLIP, CSS transforms), says who moved and how far, and rolls every
 * contestant's points; a podium stands the top three. A text-model panel,
 * when one plays, holds up whole numbers, and the board can rank by its
 * scores instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  Counter,
  GameFrame,
  Label,
  LaneCard,
  LaneNum,
  Levels,
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
  beamOf,
  cardOf,
  dotOf,
  finaleOf,
  formula,
  lede,
  matrixOf,
  orderOf,
  podiumOf,
  presetOf,
  presetWeights,
  pts,
  rank,
  rankMoves,
  ranksOf,
  tilt,
} from './judges.logic.js'

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function JudgesPanel({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [topic, setTopic] = useState(null)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const options = [{ id: null, title: 'Draw one' }, ...(game.params?.properties?.topic?.options ?? [])]
  const go = () => start(lanes, topic ? { topic } : {})
  const pick = (id) => {
    sfx.select()
    setTopic(id)
  }

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="jp-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="g-field">
            <span>What the panel judges</span>
            <div class="jp-topics" role="group" aria-label="Topic">
              ${options.map(
                (o) => html`<button type="button" key=${o.id ?? 'any'} class=${`jp-topic${topic === o.id ? ' jp-topic--on' : ''}`}
                  aria-pressed=${topic === o.id} onClick=${() => pick(o.id)}><span class="jp-topic__lamp" aria-hidden="true" />${o.title}</button>`,
              )}
            </div>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Seat the judges" />
        <//>
        <div class="jp-side">
          <${Box} class="jp-howbox">
            <${Label}>HOW IT'S PLAYED<//>
            <${HowShow} />
            <p class="g-explain">
              A topic brings six to eight contestants, each a Wikipedia article, and five judges, each one quality
              with a rubric from 0 to 4: good with kids, fits an apartment, easy to train…
            </p>
            <p class="g-explain">
              <b>Jev</b> reads each contestant's introduction once: one request, five Score questions, every
              contestant at the same time. Each judge holds up the average of Jev's levels, and the card tilts more
              the less sure Jev was.
            </p>
            <p class="g-explain">
              <b>You</b> decide what matters. Drag the weights under the judges, or pick a preset, and the
              leaderboard re-ranks at once: the weights are applied in code, so a new ranking needs no new request.
              A <b>text model</b> can sit on a second panel and write its scores as <code>JUDGE 1: 3</code>; a
              missing or impossible score is a foul.
            </p>
            <div class="jp-rules">
              <${Chip} tone="cy">composite = Σ w·(score/4) / Σ w<//>
              <${Chip} tone="ok">re-ranking: 0 requests<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.topic?.title ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/* The setup's little show, on a loop: one request raises five paddles, the
 * faders move, the board re-ranks. Decoration beside the words that say it. */
const HOW_PADDLES = ['3.2', '3.8', '3.9', '1.7', '1.9']
const HOW_ROWS = [['a'], ['b'], ['c']]
function HowShow() {
  return html`
    <div class="jp-how" aria-hidden="true">
      <div class="jp-how__step">
        <div class="jp-how__art jp-how__art--paddles">
          ${HOW_PADDLES.map((n, i) => html`<span key=${i} class="jp-how__paddle" style=${{ '--jp-i': i }}><b>${n}</b></span>`)}
        </div>
        <span class="jp-how__k"><${PixelText} text="1 REQUEST" /></span>
        <span class="jp-how__t">five scores per contestant</span>
      </div>
      <span class="jp-how__arrow">▸</span>
      <div class="jp-how__step">
        <div class="jp-how__art jp-how__art--faders">
          ${[0, 1, 2, 3, 4].map((i) => html`<span key=${i} class="jp-how__slot" style=${{ '--jp-i': i }}><span class="jp-how__cap" /></span>`)}
        </div>
        <span class="jp-how__k"><${PixelText} text="YOUR WEIGHTS" /></span>
        <span class="jp-how__t">what matters, to you</span>
      </div>
      <span class="jp-how__arrow">▸</span>
      <div class="jp-how__step">
        <div class="jp-how__art jp-how__art--board">
          <span class="jp-how__ranks">${HOW_ROWS.map((_, i) => html`<i key=${i}>${i + 1}</i>`)}</span>
          <span class="jp-how__bars">${HOW_ROWS.map(([k]) => html`<span key=${k} class=${`jp-how__row jp-how__row--${k}`}><span /></span>`)}</span>
        </div>
        <span class="jp-how__k"><${PixelText} text="0 REQUESTS" /></span>
        <span class="jp-how__t">the board re-ranks in code</span>
      </div>
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  return html`
    <${GameFrame} game=${game}>
      ${run.topic
        ? html`<${Panel} key=${run.id} run=${run} now=${now} error=${error} />`
        : html`
            <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>${error && html`<span class="g-t-warn">${error}</span>`}<//>
            <p class="g-muted">This round has no panel.</p>
          `}
    <//>
  `
}

/** The shared gradients every seat's drawing uses, once on the page. */
function Defs() {
  return html`
    <svg class="jp-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="jp-g-paddle" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffffff" /><stop offset=".55" stop-color="#fff6d8" /><stop offset="1" stop-color="#f1dca0" />
        </linearGradient>
        <linearGradient id="jp-g-wait" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#1b1848" /><stop offset="1" stop-color="#0c0a26" />
        </linearGradient>
        <linearGradient id="jp-g-foul" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#3a0f24" /><stop offset="1" stop-color="#1c0714" />
        </linearGradient>
        <linearGradient id="jp-g-body" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#2a2560" /><stop offset="1" stop-color="#0b0922" />
        </linearGradient>
      </defs>
    </svg>
  `
}

function Panel({ run, now, error }) {
  const { topic, contestants } = run
  const judges = topic.judges
  const [weights, setWeights] = useState(() => presetWeights(topic.presets[0], judges))
  const [moves, setMoves] = useState(0)
  const [spot, setSpot] = useState(null)
  const [rubric, setRubric] = useState(0)
  const [by, setBy] = useState(() => run.lanes.find((l) => l.kind === 'judgment')?.index ?? 0)
  const matrices = useMemo(
    () => run.lanes.map((ln) => matrixOf(ln, contestants.length, judges.length)),
    [run.lanes, contestants.length, judges.length],
  )
  const byLane = run.lanes[by] ?? run.lanes[0]
  const rows = rank(contestants, matrices[byLane.index], weights)
  const spotK = spot ?? rows[0]?.k ?? 0
  const c = contestants[spotK]
  const cells = matrices[byLane.index][spotK]
  const preset = presetOf(topic.presets, judges, weights)
  const ended = ['done', 'error', 'stopped'].includes(byLane.status)
  const total = weights.reduce((a, w) => a + w, 0)
  const settled = rows.every((r) => r.done)

  const setWeight = (j, v) => {
    if (weights[j] === v) return
    sfx.hover()
    setWeights(weights.map((w, i) => (i === j ? v : w)))
    setMoves((m) => m + 1)
  }
  const applyPreset = (p) => {
    sfx.select()
    setWeights(presetWeights(p, judges))
    setMoves((m) => m + 1)
  }
  const pick = (k) => {
    sfx.select()
    setSpot(k)
  }
  // The finale names who tops the board as it is weighted: the ranking is the
  // game here, not a contest between the lanes.
  const fin = finaleOf(topic, rows, preset)

  return html`
    <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} headline=${fin?.headline} sub=${fin?.sub}>
      <span class="g-mono g-muted">${contestants.length} ${topic.plural} × ${judges.length} judges</span>
      ${error && html`<span class="g-t-warn">${error}</span>`}
    <//>
    <${Defs} />
    <div class="jp-stage">
      <div class="jp-main">
        <div class="jp-head">
          <div class="jp-head__title">
            <span class="jp-kicker" aria-hidden="true"><${PixelText} text=${topic.heading} /></span>
            <span class="sr-only">${topic.heading}</span>
            <span class="jp-for" key=${total ? (preset ? preset.id : 'own') : 'none'}>${total ? (preset ? preset.for : 'your own mix of what matters') : 'nothing: every weight is zero'}</span>
          </div>
          <div class="jp-presets" role="group" aria-label="Weight presets">
            ${topic.presets.map(
              (p) => html`<button type="button" key=${p.id} class=${`jp-preset${preset?.id === p.id ? ' jp-preset--on' : ''}`}
                aria-pressed=${preset?.id === p.id} onClick=${() => applyPreset(p)}><span class="jp-preset__lamp" aria-hidden="true" />${p.label}</button>`,
            )}
          </div>
        </div>
        ${run.lanes.length > 1 &&
        html`<div class="jp-rankby" role="group" aria-label="Whose scores rank the board">
          <span class="jp-rankby__k">RANK BY</span>
          ${run.lanes.map(
            (ln) => html`<button type="button" key=${ln.index} class=${`jp-rankby__b g-l${(ln.index % 4) + 1}${ln.index === byLane.index ? ' jp-rankby__b--on' : ''}`}
              aria-pressed=${ln.index === byLane.index} onClick=${() => { sfx.select(); setBy(ln.index) }}>
              <${LaneNum} i=${ln.index} /> ${ln.label}
              <span class="g-muted">${ln.kind === 'judgment' ? '· distributions' : '· whole numbers'}</span>
            </button>`,
          )}
        </div>`}
        <div class="jp-bench">
          ${judges.map(
            (j, i) => html`<${Seat} key=${j.id} judge=${j} i=${i} cell=${cells?.[i]} name=${c?.name} spotK=${spotK} ended=${ended}
              weight=${weights[i]} onWeight=${(v) => setWeight(i, v)} shown=${rubric === i} onRubric=${() => { sfx.select(); setRubric(i) }} />`,
          )}
        </div>
        <div class="jp-boardhd">
          <${Label}>LEADERBOARD · click a ${topic.kind} to put it in front of the judges<//>
          <span class="jp-formula g-mono">${formula(judges, weights)}</span>
        </div>
        <${Board} rows=${rows} judges=${judges} weights=${weights} spotK=${spotK} onPick=${pick} lane=${byLane.index} settled=${settled} />
      </div>
      <div class="jp-aside">
        <${Podium} rows=${rows} spotK=${spotK} onPick=${pick} settled=${settled} />
        ${c && html`<${Spotlight} c=${c} judges=${judges} cells=${cells} lane=${byLane} lanes=${run.lanes} matrices=${matrices} weights=${weights} />`}
        ${c && html`<${Rubric} judge=${judges[rubric]} cell=${cells?.[rubric]} name=${c.name} lane=${byLane.index} />`}
        <${Tally} run=${run} lane=${byLane} judges=${judges} moves=${moves} />
      </div>
    </div>
    <div class="g-lanes">
      ${run.lanes.map(
        (ln) => html`<${LaneCard} key=${ln.index} lane=${ln}>
          <div class="jp-lanebody">
            <span class="jp-lanebody__n"><${Counter} value=${ln.score ?? 0} class="g-score" /><small>/${contestants.length * judges.length}</small></span>
            <${Cards} m=${matrices[ln.index]} />
            <span class="g-muted jp-lanebody__t">${ln.kind === 'judgment'
              ? 'cards held up · one request per contestant, a distribution per judge'
              : 'cards held up · JUDGE lines; a bad one is a foul'}</span>
          </div>
        <//>`,
      )}
    </div>
  `
}

/** A lane's contestants as small cards: lit once its judges held theirs up,
 *  red with a cross where one of them gave no score. */
function Cards({ m }) {
  return html`
    <span class="jp-minis" aria-hidden="true">
      ${m.map((row, k) => {
        const state = row.some((x) => x === undefined) ? 'wait' : row.some((x) => x === null) ? 'foul' : 'up'
        return html`<span key=${`${k}-${state}`} class=${`jp-mini jp-mini--${state}`}>${state === 'foul' ? '✕' : ''}</span>`
      })}
    </span>
  `
}

/* A judge's seat: the judge in a spotlight as bright as its weight, holding
 * the paddle up for the contestant in front of the panel; then its nameplate
 * (its rubric) and its fader (its weight). The paddle pops up whenever a new
 * score is on it; the wider Jev's distribution, the more it tilts. */
function Seat({ judge, i, cell, name, spotK, ended, weight, onWeight, shown, onRubric }) {
  const card = cell === undefined && ended ? { state: 'foul', big: '–', small: 'not judged' } : cardOf(cell)
  const deg = cell ? tilt(cell.spread, i) : tilt(0, i)
  const id = `jp-w-${judge.id}`
  const lv = dotOf(cell)
  const said =
    cell === undefined ? (ended ? 'did not judge' : 'is still judging') : cell === null ? 'gave no score' : `holds up ${card.big}${cell.probabilities ? `, give or take ${cell.spread.toFixed(1)}` : ''}`
  return html`
    <div class=${`jp-seat${weight ? '' : ' jp-seat--mute'}`} style=${{ '--jp-beam': beamOf(weight), '--jp-w': weight / 5 }}>
      <div class="jp-seat__stage">
        <svg class="jp-seat__art" viewBox="0 0 120 136" role="img" aria-label=${`Judge ${i + 1}, ${judge.label}, ${said}${name ? ` for ${name}` : ''}`}>
          <path class="jp-body" d="M18 136 Q20 106 60 104 Q100 106 102 136 Z" />
          <circle class="jp-body" cx="60" cy="88" r="13" />
          <g class="jp-raise" key=${`${spotK}:${card.state}:${card.big}`} style=${{ '--jp-i': i }}>
            <g class="jp-hold" style=${{ transform: `rotate(${deg}deg)` }}>
              <line class="jp-arm" x1="40" y1="112" x2="33" y2="62" />
              <line class="jp-arm" x1="80" y1="112" x2="87" y2="62" />
              <rect class=${`jp-card jp-card--${card.state}`} x="10" y="2" width="100" height="64" rx="9" />
              <text class="jp-card__big" x="60" y="37">${card.big}</text>
              <text class="jp-card__small" x="60" y="51">${card.small}</text>
              ${card.state === 'up' && html`<g class="jp-pips">
                ${[0, 1, 2, 3].map((p) => html`<rect key=${p} class=${`jp-pip${lv != null && p < lv ? ' jp-pip--on' : ''}`} x=${42.5 + p * 9.5} y="56" width="6.5" height="4" rx="1.5" />`)}
              </g>`}
              <circle class="jp-hand" cx="33" cy="62" r="5" />
              <circle class="jp-hand" cx="87" cy="62" r="5" />
            </g>
          </g>
        </svg>
      </div>
      <button type="button" class=${`jp-plate${shown ? ' jp-plate--on' : ''}`} aria-pressed=${shown} onClick=${onRubric}
        title="Show this judge's rubric">
        <span class="jp-plate__n" aria-hidden="true"><${PixelText} text=${`JUDGE ${i + 1}`} /></span>
        <span class="jp-plate__label">${judge.label}</span>
      </button>
      <div class="jp-strip">
        <div class="jp-strip__top">
          <label class="jp-strip__k" for=${id}>weight<span class="sr-only"> for ${judge.label}</span></label>
          <span class="jp-strip__v" key=${weight} aria-hidden="true"><${PixelText} text=${weight ? `×${weight}` : 'OFF'} /></span>
        </div>
        <div class="jp-strip__body">
          <span class="jp-strip__scale" aria-hidden="true">${[5, 4, 3, 2, 1, 0].map((n) => html`<span key=${n} class=${n === weight ? 'is-on' : ''}>${n}</span>`)}</span>
          <span class="jp-strip__slot">
            <input id=${id} class="jp-fader" type="range" min="0" max="5" step="1" value=${weight}
              aria-valuetext=${`${weight} of 5`} onInput=${(e) => onWeight(Number(e.currentTarget.value))} />
          </span>
          <span class="jp-leds" aria-hidden="true">
            ${[5, 4, 3, 2, 1].map((n) => html`<span key=${n} class=${`jp-led${weight >= n ? ' is-on' : ''}${n === 5 ? ' jp-led--peak' : ''}`} />`)}
          </span>
        </div>
      </div>
    </div>
  `
}

/** Moves the rows it marks with `data-flip` from where they were to where they
 *  are now whenever `key` changes (First, Last, Invert, Play), unless the
 *  reader asked for less motion. A candidate for the kit. */
function useFlip(ref, key) {
  const last = useRef(new Map())
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const still = calm()
    const next = new Map()
    for (const el of box.querySelectorAll('[data-flip]')) {
      const id = el.getAttribute('data-flip')
      const top = el.offsetTop
      next.set(id, top)
      const was = last.current.get(id)
      if (still || was == null || was === top) continue
      el.style.transition = 'none'
      el.style.transform = `translateY(${was - top}px)`
      void el.offsetWidth
      el.style.transition = ''
      el.style.transform = ''
    }
    last.current = next
  }, [key])
}

/** Who moved at the latest re-ranking and how far ({id, by: {k: places}}),
 *  for as long as the arrows show; and a small burst when a new leader takes
 *  the top once every contestant is scored. */
function useMoves(rows, settled, top) {
  const last = useRef(null)
  const lead = useRef(null)
  const timer = useRef(0)
  const [moves, setMoves] = useState({ id: 0, by: {} })
  const order = orderOf(rows)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    const was = last.current
    last.current = ranksOf(rows)
    const by = rankMoves(was, rows)
    const leader = rows[0]?.done ? rows[0].k : null
    const newLeader = settled && lead.current != null && leader != null && leader !== lead.current
    lead.current = settled ? leader : null
    if (newLeader) {
      sfx.up()
      const el = top.current?.querySelector('.jp-row')
      if (el && !calm()) burstFrom(el, { colors: ['#ffd84d', '#fff6c2', '#ff9d3d'], count: 26, power: 0.55 })
    }
    if (!Object.keys(by).length) return
    setMoves((m) => ({ id: m.id + 1, by }))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMoves((m) => ({ ...m, by: {} })), 1700)
  }, [order, settled])
  return moves
}

function Board({ rows, judges, weights, spotK, onPick, lane, settled }) {
  const ref = useRef(null)
  useFlip(ref, orderOf(rows))
  const moves = useMoves(rows, settled, ref)
  return html`
    <div class=${`jp-board g-l${(lane % 4) + 1}`} ref=${ref}>
      ${rows.map((r) => {
        const mv = moves.by[r.k]
        const medal = r.done && r.composite != null && r.rank <= 3 ? r.rank : 0
        return html`
          <button type="button" key=${r.k} data-flip=${r.k}
            class=${`jp-row${r.k === spotK ? ' jp-row--on' : ''}${medal ? ` jp-row--m${medal}` : ''}${r.done ? '' : ' jp-row--wait'}${mv ? (mv > 0 ? ' jp-row--rise' : ' jp-row--fall') : ''}`}
            aria-pressed=${r.k === spotK} onClick=${() => onPick(r.k)}>
            ${r.done && html`<span class="jp-row__flash" aria-hidden="true" />`}
            <span class="jp-row__rank tnum">${medal === 1 ? html`<span class="jp-row__crown" aria-hidden="true">★</span>` : null}${r.rank}</span>
            <span class="jp-row__name">${r.c.name}</span>
            <span class="jp-row__track" aria-hidden="true"><span class="jp-row__fill" style=${{ transform: `scaleX(${r.composite ?? 0})` }} /></span>
            <span class="jp-row__pts">${r.done ? html`<${Counter} value=${pts(r.composite) ?? NaN} />` : html`<span class="jp-row__wait">…</span>`}</span>
            <span class="jp-row__dots" aria-hidden="true">
              ${judges.map((j, jx) => {
                const lv = dotOf(r.cells[jx])
                return html`<span key=${j.id} class=${`jp-dot jp-dot--${lv ?? 'x'}${weights[jx] ? '' : ' jp-dot--mute'}`} title=${`${j.label}: ${lv ?? 'no score'}`}>${lv ?? '·'}</span>`
              })}
            </span>
            <span class="jp-row__move">
              ${mv ? html`<span key=${moves.id} class=${`jp-move jp-move--${mv > 0 ? 'up' : 'down'}`}><span aria-hidden="true">${mv > 0 ? '▲' : '▼'}</span>${Math.abs(mv)}<span class="sr-only">${mv > 0 ? ' up' : ' down'}</span></span>` : null}
            </span>
          </button>
        `
      })}
    </div>
  `
}

/** The top three as a podium stands them: second, first, third. A new name on
 *  a step drops onto it. */
function Podium({ rows, spotK, onPick, settled }) {
  const places = podiumOf(rows)
  return html`
    <${Box} class="jp-podium">
      <${Label} note=${settled ? 'as you weight it' : 'as the scores land'}>THE PODIUM<//>
      <div class="jp-podium__stage">
        ${[2, 1, 3].map((place) => {
          const p = places.find((x) => x.place === place)
          return html`<div class=${`jp-step jp-step--${place}`} key=${place}>
            ${p
              ? html`<button type="button" key=${p.row.k} class=${`jp-step__who${p.row.k === spotK ? ' is-on' : ''}`}
                  aria-pressed=${p.row.k === spotK} onClick=${() => onPick(p.row.k)}>
                  ${place === 1 && html`<span class="jp-step__crown" aria-hidden="true">★</span>`}
                  <span class="jp-step__name">${p.row.c.name}</span>
                  <span class="jp-step__pts"><${Counter} value=${pts(p.row.composite) ?? NaN} /><small> pts</small></span>
                </button>`
              : html`<span class="jp-step__who jp-step__who--empty" aria-hidden="true">…</span>`}
            <span class="jp-step__block" aria-hidden="true"><${PixelText} text=${String(place)} /></span>
            <span class="sr-only">place ${place}</span>
          </div>`
        })}
      </div>
    <//>
  `
}

/** The contestant in front of the judges: Jev's level probabilities per judge,
 *  and what any other panel said. */
function Spotlight({ c, judges, cells, lane, lanes, matrices, weights }) {
  const others = lanes.filter((l) => l.index !== lane.index)
  return html`
    <${Box} lane=${lane.index} class="jp-spot">
      <${Label}>IN FRONT OF THE JUDGES<//>
      <div class="jp-spot__in" key=${c.i}>
        <a class="jp-spot__name" href=${c.url} target="_blank" rel="noopener noreferrer">${c.name}</a>
        <p class="jp-spot__lede">${lede(c.article)}</p>
      </div>
      <div class="jp-dist">
        ${judges.map((j, jx) => {
          const cell = cells?.[jx]
          const card = cardOf(cell)
          return html`
            <div class=${`jp-dist__row${weights[jx] ? '' : ' jp-dist__row--mute'}`} key=${j.id}>
              <span class="jp-dist__k">${j.label}<small class="tnum">×${weights[jx]}</small></span>
              ${cell?.probabilities
                ? html`<${Levels} probabilities=${cell.probabilities} labels=${j.levels} lane=${lane.index} height=${30} />`
                : html`<span class=${`jp-dist__none${cell === null ? ' g-t-err' : ''}`}>${cell === undefined ? 'judging…' : cell === null ? '✕ no score (foul)' : 'one number, no distribution'}</span>`}
              <span class="jp-dist__v tnum">${cell ? html`<b>${card.big}</b>${cell.probabilities ? html`<small> ±${cell.spread.toFixed(1)}</small>` : null}` : '—'}</span>
            </div>
          `
        })}
      </div>
      <p class="jp-note">${lane.kind === 'judgment'
        ? "bars: Jev's probability for levels 0 to 4 · the card shows their average and spread"
        : 'a text model writes one number per judge: no spread to show'}</p>
      ${others.length > 0 &&
      html`<div class="jp-others">
        ${others.map((ln) => {
          const row = matrices[ln.index][c.i] ?? []
          return html`<div class="jp-others__row" key=${ln.index}>
            <${LaneNum} i=${ln.index} /><span class="jp-others__who">${ln.label}</span>
            <span class="jp-others__v tnum">${judges.map((j, jx) => {
              const x = row[jx]
              return html`<span key=${j.id} class=${`jp-others__card${x === null ? ' jp-others__card--foul' : x === undefined ? ' jp-others__card--wait' : ''}`} title=${j.label}>${x === undefined ? '…' : x === null ? '✕' : cardOf(x).big}</span>`
            })}</span>
          </div>`
        })}
      </div>`}
    <//>
  `
}

/** One judge's rubric, with the spotlighted contestant's probability on each level. */
function Rubric({ judge, cell, name, lane }) {
  const probs = cell?.probabilities
  const on = dotOf(cell)
  const q = judge.question.includes(' in `name`')
    ? judge.question.replace(' in `name`', ` “${name}”`)
    : judge.question.replace('`name`', name)
  return html`
    <${Box} class="jp-rubric">
      <${Label} note=${judge.label}>ONE JUDGE'S RUBRIC<//>
      <p class="jp-rubric__q">“${q}”</p>
      <ol class=${`jp-levels g-l${(lane % 4) + 1}`}>
        ${judge.levels.map(
          (text, lv) => html`<li key=${lv} class=${`jp-lv${lv === on ? ' jp-lv--on' : ''}`}>
            <span class="jp-lv__n tnum">${lv}</span>
            <span class="jp-lv__t">${text}${lv === on ? html`<span class="jp-lv__mark"> ◂ the card</span>` : null}</span>
            ${probs &&
            html`<span class="jp-lv__p" title=${`Jev: ${probs[lv].toFixed(2)}`}>
              <span class="jp-lv__track"><span class="jp-lv__bar" style=${{ transform: `scaleX(${probs[lv]})` }} /></span>
              <span class="tnum">${probs[lv].toFixed(2)}</span>
            </span>`}
          </li>`,
        )}
      </ol>
      <p class="jp-note">click a judge's nameplate to read another rubric</p>
    <//>
  `
}

/** What the ranking cost: the requests once, then none per re-ranking. */
function Tally({ run, lane, judges, moves }) {
  const n = run.contestants.length
  const scored = lane.scored ?? []
  const slowest = scored.reduce((m, s) => Math.max(m, s.ms ?? 0), 0)
  return html`
    <div class="jp-tally">
      <div><span>requests to score them all</span><b class="tnum">${lane.calls} of ${n}</b></div>
      <div><span>questions in them</span><b class="tnum">${n} × ${judges.length} = ${n * judges.length}</b></div>
      <div><span>all at once, the slowest took</span><b class="tnum">${scored.length ? fmtMs(slowest) : '—'}</b></div>
      <div class="jp-tally__hot"><span>re-rankings so far</span><b><${Counter} value=${moves} /></b></div>
      <div class="jp-tally__hot"><span>requests they needed</span><b class="tnum jp-tally__zero">0</b></div>
      <div><span>the board is ranked by</span><b class="jp-tally__who">${lane.label}</b></div>
    </div>
  `
}
