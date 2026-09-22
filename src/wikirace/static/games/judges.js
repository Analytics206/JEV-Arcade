/* Judges' Panel — Jev scores each quality once; you decide what matters.
 *
 * The server (games/judges.py) asks Jev once per contestant: five Score
 * questions, one per judge, over the contestant's Wikipedia introduction. The
 * page does the rest in code: the weights under the judges make a composite
 * (judges.logic.js), and the leaderboard re-ranks as they move, with no new
 * request. Five judges hold up the spotlighted contestant's cards; a card
 * tilts more the less sure Jev was. A text-model panel, when one plays, holds
 * up whole numbers, and the board can rank by its scores instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  GameFrame,
  Label,
  LaneCard,
  LaneNum,
  Levels,
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
import { cardOf, dotOf, formula, lede, matrixOf, orderOf, presetOf, presetWeights, pts, rank, tilt } from './judges.logic.js'

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
                  aria-pressed=${topic === o.id} onClick=${() => setTopic(o.id)}>${o.title}</button>`,
              )}
            </div>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Seat the judges" />
        <//>
        <div class="jp-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
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

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        ${run.topic &&
        html`<span class="g-mono g-muted">${run.contestants.length} ${run.topic.plural} × ${run.topic.judges.length} judges</span>`}
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      ${run.topic ? html`<${Panel} key=${run.id} run=${run} />` : html`<p class="g-muted">This round has no panel.</p>`}
    <//>
  `
}

function Panel({ run }) {
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

  const setWeight = (j, v) => {
    if (weights[j] === v) return
    setWeights(weights.map((w, i) => (i === j ? v : w)))
    setMoves((m) => m + 1)
  }
  const applyPreset = (p) => {
    setWeights(presetWeights(p, judges))
    setMoves((m) => m + 1)
  }

  return html`
    <div class="jp-stage">
      <div class="jp-main">
        <div class="jp-head">
          <div class="jp-head__title">
            <span class="jp-kicker">${topic.heading}</span>
            <span class="jp-for">${total ? (preset ? preset.for : 'your own mix of what matters') : 'nothing: every weight is zero'}</span>
          </div>
          <div class="jp-presets" role="group" aria-label="Weight presets">
            ${topic.presets.map(
              (p) => html`<button type="button" key=${p.id} class=${`jp-preset${preset?.id === p.id ? ' jp-preset--on' : ''}`}
                aria-pressed=${preset?.id === p.id} onClick=${() => applyPreset(p)}>${p.label}</button>`,
            )}
          </div>
        </div>
        ${run.lanes.length > 1 &&
        html`<div class="jp-rankby" role="group" aria-label="Whose scores rank the board">
          <span class="jp-rankby__k">RANK BY</span>
          ${run.lanes.map(
            (ln) => html`<button type="button" key=${ln.index} class=${`jp-rankby__b${ln.index === byLane.index ? ' jp-rankby__b--on' : ''}`}
              aria-pressed=${ln.index === byLane.index} onClick=${() => setBy(ln.index)}>
              <${LaneNum} i=${ln.index} /> ${ln.label}
              <span class="g-muted">${ln.kind === 'judgment' ? '· distributions' : '· whole numbers'}</span>
            </button>`,
          )}
        </div>`}
        <div class="jp-bench">
          ${judges.map(
            (j, i) => html`<${Seat} key=${j.id} judge=${j} i=${i} cell=${cells?.[i]} name=${c?.name} ended=${ended}
              weight=${weights[i]} onWeight=${(v) => setWeight(i, v)} shown=${rubric === i} onRubric=${() => setRubric(i)} />`,
          )}
        </div>
        <div class="jp-boardhd">
          <${Label}>LEADERBOARD · click a ${topic.kind} to put it in front of the judges<//>
          <span class="jp-formula g-mono">${formula(judges, weights)}</span>
        </div>
        <${Board} rows=${rows} judges=${judges} spotK=${spotK} onPick=${setSpot} lane=${byLane.index} />
      </div>
      <div class="jp-aside">
        ${c && html`<${Spotlight} c=${c} judges=${judges} cells=${cells} lane=${byLane} lanes=${run.lanes} matrices=${matrices} />`}
        ${c && html`<${Rubric} judge=${judges[rubric]} cell=${cells?.[rubric]} name=${c.name} lane=${byLane.index} />`}
        <${Counter} run=${run} lane=${byLane} judges=${judges} moves=${moves} />
      </div>
    </div>
    <div class="g-lanes">
      ${run.lanes.map(
        (ln) => html`<${LaneCard} key=${ln.index} lane=${ln}>
          <div class="jp-lanebody">
            <span class="jp-lanebody__n tnum">${ln.score ?? 0}<small>/${contestants.length * judges.length}</small></span>
            <span class="g-muted">${ln.kind === 'judgment'
              ? 'cards held up · one request per contestant, a distribution per judge'
              : 'cards held up · JUDGE lines; a bad one is a foul'}</span>
          </div>
        <//>`,
      )}
    </div>
  `
}

/* A judge's seat: the judge, holding the card up for the contestant in front
 * of the panel, then the weight slider. The card and arms turn together around
 * the neck; the wider Jev's distribution, the more the card wobbles. */
function Seat({ judge, i, cell, name, ended, weight, onWeight, shown, onRubric }) {
  const card = cell === undefined && ended ? { state: 'foul', big: '–', small: 'not judged' } : cardOf(cell)
  const deg = cell ? tilt(cell.spread, i) : tilt(0, i)
  const id = `jp-w-${judge.id}`
  const said =
    cell === undefined ? (ended ? 'did not judge' : 'is still judging') : cell === null ? 'gave no score' : `holds up ${card.big}${cell.probabilities ? `, give or take ${cell.spread.toFixed(1)}` : ''}`
  return html`
    <div class="jp-seat">
      <svg class="jp-seat__art" viewBox="0 0 120 166" role="img" aria-label=${`Judge ${i + 1}, ${judge.label}, ${said}${name ? ` for ${name}` : ''}`}>
        <path class="jp-body" d="M24 166 Q24 134 60 134 Q96 134 96 166 Z" />
        <circle class="jp-body" cx="60" cy="116" r="13" />
        <g class="jp-hold" style=${{ transform: `rotate(${deg}deg)` }}>
          <line class="jp-arm" x1="42" y1="140" x2="33" y2="72" />
          <line class="jp-arm" x1="78" y1="140" x2="87" y2="72" />
          <rect class=${`jp-card jp-card--${card.state}`} x="16" y="4" width="88" height="70" rx="4" />
          <text class="jp-card__big" x="60" y="46">${card.big}</text>
          <text class="jp-card__small" x="60" y="65">${card.small}</text>
          <circle class="jp-hand" cx="33" cy="72" r="5" />
          <circle class="jp-hand" cx="87" cy="72" r="5" />
        </g>
        <rect class="jp-desk" x="0" y="150" width="120" height="16" />
        <text class="jp-desk__n" x="60" y="162">JUDGE ${i + 1}</text>
      </svg>
      <button type="button" class=${`jp-seat__name${shown ? ' jp-seat__name--on' : ''}`} aria-pressed=${shown} onClick=${onRubric}
        title="Show this judge's rubric">${judge.label}</button>
      <label class="jp-seat__w" for=${id}>weight <b class="tnum">${weight}</b></label>
      <input id=${id} class="jp-seat__range" type="range" min="0" max="5" step="1" value=${weight}
        aria-valuetext=${`${weight} of 5`} onInput=${(e) => onWeight(Number(e.currentTarget.value))} />
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
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
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

function Board({ rows, judges, spotK, onPick, lane }) {
  const ref = useRef(null)
  useFlip(ref, orderOf(rows))
  return html`
    <div class=${`jp-board g-l${(lane % 4) + 1}`} ref=${ref}>
      ${rows.map(
        (r) => html`
          <button type="button" key=${r.k} data-flip=${r.k} class=${`jp-row${r.k === spotK ? ' jp-row--on' : ''}`}
            aria-pressed=${r.k === spotK} onClick=${() => onPick(r.k)}>
            <span class=${`jp-row__rank tnum${r.rank === 1 && r.composite != null ? ' jp-row__rank--top' : ''}`}>${r.rank}</span>
            <span class="jp-row__name">${r.c.name}</span>
            <span class="jp-row__track" aria-hidden="true"><span class="jp-row__fill" style=${{ width: `${(r.composite ?? 0) * 100}%` }} /></span>
            <span class="jp-row__pts tnum">${r.done ? pts(r.composite) ?? '—' : '…'}</span>
            <span class="jp-row__dots" aria-hidden="true">
              ${judges.map((j, jx) => {
                const lv = dotOf(r.cells[jx])
                return html`<span key=${j.id} class=${`jp-dot jp-dot--${lv ?? 'x'}`} title=${`${j.label}: ${lv ?? 'no score'}`}>${lv ?? '·'}</span>`
              })}
            </span>
          </button>
        `,
      )}
    </div>
  `
}

/** The contestant in front of the judges: Jev's level probabilities per judge,
 *  and what any other panel said. */
function Spotlight({ c, judges, cells, lane, lanes, matrices }) {
  const others = lanes.filter((l) => l.index !== lane.index)
  return html`
    <${Box} lane=${lane.index} class="jp-spot">
      <${Label}>IN FRONT OF THE JUDGES<//>
      <a class="jp-spot__name" href=${c.url} target="_blank" rel="noopener noreferrer">${c.name}</a>
      <p class="jp-spot__lede">${lede(c.article)}</p>
      <div class="jp-dist">
        ${judges.map((j, jx) => {
          const cell = cells?.[jx]
          const card = cardOf(cell)
          return html`
            <div class="jp-dist__row" key=${j.id}>
              <span class="jp-dist__k">${j.label}</span>
              ${cell?.probabilities
                ? html`<${Levels} probabilities=${cell.probabilities} labels=${j.levels} lane=${lane.index} height=${30} />`
                : html`<span class="jp-dist__none">${cell === undefined ? 'judging…' : cell === null ? '✕ no score (foul)' : 'one number, no distribution'}</span>`}
              <span class="jp-dist__v tnum">${cell ? `${card.big}${cell.probabilities ? ` ±${cell.spread.toFixed(1)}` : ''}` : '—'}</span>
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
              return html`<span key=${j.id} class=${x === null ? 'g-t-err' : ''} title=${j.label}>${x === undefined ? '…' : x === null ? '✕' : cardOf(x).big}</span>`
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
            <span class="jp-lv__t">${text}</span>
            ${probs &&
            html`<span class="jp-lv__p" title=${`Jev: ${probs[lv].toFixed(2)}`}>
              <span class="jp-lv__track"><span class="jp-lv__bar" style=${{ width: `${Math.round(probs[lv] * 100)}%` }} /></span>
              <span class="tnum">${probs[lv].toFixed(2)}</span>
            </span>`}
          </li>`,
        )}
      </ol>
      <p class="jp-note">click a judge's name to read another rubric</p>
    <//>
  `
}

/** What the ranking cost: the requests once, then none per re-ranking. */
function Counter({ run, lane, judges, moves }) {
  const n = run.contestants.length
  const scored = lane.scored ?? []
  const slowest = scored.reduce((m, s) => Math.max(m, s.ms ?? 0), 0)
  return html`
    <div class="jp-counter">
      <div><span>requests to score them all</span><b class="tnum">${lane.calls} of ${n}</b></div>
      <div><span>questions in them</span><b class="tnum">${n} × ${judges.length} = ${n * judges.length}</b></div>
      <div><span>all at once, the slowest took</span><b class="tnum">${scored.length ? fmtMs(slowest) : '—'}</b></div>
      <div><span>re-rankings so far</span><b class="tnum">${moves}</b></div>
      <div><span>requests they needed</span><b class="tnum g-t-ok">0</b></div>
      <div><span>the board is ranked by</span><b class="jp-counter__who">${lane.label}</b></div>
    </div>
  `
}
