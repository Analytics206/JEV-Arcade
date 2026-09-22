/* Blind Tasting — guess the critic's score: closest without going over.
 *
 * The server (games/tasting.py) pours one note and has Jev measure every note
 * in the set (seven 0 to 4 Scores, three yes/no), then fits a ridge regression
 * in code on the other notes and predicts this one; a text model reads the
 * note and names a number. Here you read the note and Jev's measurements, type
 * your guess and lock it in (kept in this browser only). Only then do the
 * other price tags open, and once the round is over the critic's card turns.
 */
import { useEffect, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  GameFrame,
  Label,
  LaneCard,
  LaneNum,
  Meter,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  againOf,
  html,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { Button } from '../ui.js'
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import { HIGH, LOW, axis, band, barWidth, fateOf, fmtWeight, nearestLevel, parseGuess, scatter, winners } from './tasting.logic.js'

const ANCHORS = '80 flawed · 85 simple · 90 excellent · 95 outstanding · 98+ rare'

export default function BlindTasting({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [note, setNote] = useState(0)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 3 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const count = game.params?.properties?.note?.anyOf?.find((s) => s.type === 'integer')?.maximum ?? 40
  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="bt-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <label class="g-field"><span>The glass</span>
            <select class="wr-sel" value=${note} onChange=${(e) => setNote(Number(e.currentTarget.value))}>
              <option value="0">poured at random</option>
              ${[...Array(count).keys()].map((k) => html`<option key=${k} value=${k + 1}>note ${k + 1} of ${count}</option>`)}
            </select>
          </label>
          <${StartButton} onStart=${() => start(lanes, note ? { note } : {})} problem=${problem} busy=${busy} error=${error} label="Pour a glass" />
        <//>
        <div class="bt-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              A critic tasted forty wines and scored each from ${LOW} to ${HIGH}. You get one tasting note and guess
              the score. The guess <b>closest without going over</b> wins; a guess above the critic's score loses,
              however close.
            </p>
            <p class="g-explain">
              <b>Jev</b> doesn't guess the number. It measures qualities in every note of the set: seven Scores (fruit,
              oak, structure, acidity, complexity, finish, balance) and three yes/no questions (will it age? a flaw?
              drink now?). A small ridge regression in code, fitted on the other notes and never on this one, turns
              those seventeen features into a score. A <b>text model</b> reads the note and names a number; one
              outside ${LOW} to ${HIGH} is a foul.
            </p>
            <div class="bt-rules">
              <${Chip} tone="ok">closest, not over: wins<//><${Chip} tone="err">over: loses<//><${Chip} tone="cy">Jev: features, not answers<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.wine?.style ?? ''}</span>`} />
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
        ${run.wine && html`<span class="g-mono g-muted">note ${run.wine.n} of ${run.set_size} · ${run.wine.style}</span>`}
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      ${run.wine ? html`<${Tasting} key=${run.id} run=${run} />` : html`<p class="g-muted">This round poured nothing.</p>`}
    <//>
  `
}

/** Your guess, kept in this browser for this round only. */
function useMine(runId) {
  const key = `bt:${runId}`
  const [mine, setMine] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (v && typeof v.locked === 'boolean') return v
    } catch {
      /* no storage: play without it */
    }
    return { text: '', guess: null, locked: false }
  })
  const save = (next) => {
    setMine(next)
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      /* no storage */
    }
  }
  return [mine, save]
}

function Tasting({ run }) {
  const [mine, setMine] = useMine(run.id)
  const jevLanes = run.lanes.filter((l) => l.kind === 'judgment')
  const [jx, setJx] = useState(0)
  const jev = jevLanes[Math.min(jx, jevLanes.length - 1)] ?? null
  const critic = Number.isFinite(run.critic) ? run.critic : null
  const open = mine.locked
  const revealed = open && critic != null
  const won = revealed ? winners([{ key: 'you', guess: mine.guess }, ...run.lanes.map((ln) => ({ key: ln.index, guess: ln.guess }))], critic) : []
  const typed = parseGuess(mine.text)
  const lock = () => typed != null && setMine({ ...mine, guess: typed, locked: true })
  const pass = () => setMine({ ...mine, guess: null, locked: true })
  const fate = (g, key) => (revealed ? fateOf(g, critic, won.includes(key)) : Number.isFinite(g) ? 'sealed' : 'none')

  return html`
    <div class="bt-stage">
      <div class="bt-left">
        <${Box} class="bt-note">
          <${Label}>THE NOTE<//>
          <p class="bt-note__text">${run.wine.text}</p>
          <span class="g-mono g-muted bt-note__meta">${run.wine.style} · score ${revealed ? critic : 'hidden'} · ${LOW} to ${HIGH}</span>
        <//>
        ${open
          ? html`<p class="bt-locked g-mono">${Number.isFinite(mine.guess) ? `locked in: ${mine.guess}` : 'you are watching this one'}</p>`
          : html`
              <label for="bt-guess" class="bt-guess__k">YOUR GUESS</label>
              <div class="bt-guess">
                <input id="bt-guess" class="bt-guess__in tnum" type="number" inputmode="numeric" min=${LOW} max=${HIGH} step="1"
                  value=${mine.text} aria-describedby="bt-guess-help"
                  onInput=${(e) => setMine({ ...mine, text: e.currentTarget.value })}
                  onKeyDown=${(e) => e.key === 'Enter' && lock()} />
                <${Button} variant="primary" class="bt-guess__go" disabled=${typed == null} onClick=${lock}>Lock it in<//>
              </div>
              <p id="bt-guess-help" class=${`g-mono bt-guess__help${mine.text && typed == null ? ' g-t-warn' : ' g-muted'}`}>
                ${mine.text && typed == null ? `a whole number from ${LOW} to ${HIGH}` : 'the other guesses stay sealed until you lock in'}
              </p>
              <button type="button" class="bt-pass" onClick=${pass}>I'll just watch</button>
            `}
        <p class="g-mono g-muted bt-anchors">${ANCHORS}</p>
      </div>
      <div class="bt-mid">
        <${Measures} run=${run} lane=${jev} lanes=${jevLanes} onPick=${setJx} open=${open} />
        ${open && jev?.model && html`<${Scatter} model=${jev.model} lane=${jev.index} critic=${revealed ? critic : null} />`}
      </div>
      <div class="bt-right">
        <${Label}>THE GUESSES<//>
        <${Tag} who="You" value=${open ? mine.guess : typed} fate=${revealed ? fate(mine.guess, 'you') : (open ? mine.guess : typed) != null ? 'mine' : 'none'}
          note=${!open ? (typed != null ? 'not locked in yet' : 'type a guess') : noteOf(revealed ? fate(mine.guess, 'you') : 'mine', mine.guess, critic, false)} />
        ${run.lanes.map((ln) => {
          const f = open ? fate(ln.guess, ln.index) : 'sealed'
          return html`<${Tag} key=${ln.index} lane=${ln.index} who=${ln.kind === 'judgment' ? `${ln.label} + model` : ln.label}
            value=${open ? ln.guess : null} fate=${f} note=${laneNote(ln, f, critic, open)} />`
        })}
        <${Critic} value=${critic} shown=${revealed} locked=${open} />
      </div>
    </div>
    <div class="g-lanes">
      ${run.lanes.map(
        (ln) => html`<${LaneCard} key=${ln.index} lane=${ln}>
          <div class="bt-lanebody">
            ${ln.kind === 'judgment'
              ? html`<span class="g-mono">${ln.measured ?? 0}/${ln.todo ?? run.set_size} notes measured${ln.model ? ` · model error ±${ln.model.rmse.toFixed(1)}` : ''}</span>`
              : html`<span class="bt-lanebody__said">${open ? ln.said ?? '…' : 'its reason stays sealed until you lock in'}</span>`}
          </div>
        <//>`,
      )}
    </div>
  `
}

function noteOf(fate, guess, critic, foul) {
  if (fate === 'won') return 'closest · wins'
  if (fate === 'over') return 'went over'
  if (fate === 'under') return `${Math.round((critic - guess) * 10) / 10} under`
  if (fate === 'none') return foul ? 'no guess · foul' : 'no guess'
  return 'locked in'
}

function laneNote(ln, fate, critic, open) {
  if (!open) {
    if (ln.status === 'error') return 'could not play'
    if (ln.guess == null && ln.status !== 'done') return ln.kind === 'judgment' ? `measuring ${ln.measured ?? 0}/${ln.todo ?? '?'}` : 'tasting…'
    return 'sealed'
  }
  if (fate === 'none' && ln.status !== 'done') return ln.status === 'error' ? 'could not play' : 'still tasting…'
  return noteOf(fate === 'sealed' ? 'locked' : fate, ln.guess, critic, ln.fouls > 0)
}

/** A guess as a price tag: struck through when it went over, lit when it won. */
function Tag({ who, lane, value, fate, note }) {
  const shown = Number.isFinite(value) ? value : fate === 'sealed' ? '?' : '—'
  return html`
    <div class=${`bt-tag bt-tag--${fate}`}>
      <svg class="bt-tag__shape" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden="true">
        <path d="M20 1 H199 V63 H20 L1 32 Z" />
      </svg>
      <span class="bt-tag__hole" aria-hidden="true" />
      <span class="bt-tag__who">
        <span class="bt-tag__name">${lane != null && html`<${LaneNum} i=${lane} />`}${who}</span>
        <small class="bt-tag__note g-mono">${note}</small>
      </span>
      <span class="bt-tag__v tnum">${shown}${fate === 'over' && html`<span class="sr-only"> (over)</span>`}</span>
    </div>
  `
}

/** The critic's card: face down until you have locked in and the round is over. */
function Critic({ value, shown, locked }) {
  return html`
    <div class=${`bt-critic${shown ? ' bt-critic--up' : ''}`} aria-live="polite">
      <div class="bt-critic__inner">
        <div class="bt-critic__face bt-critic__back" aria-hidden=${shown}>
          <span class="bt-critic__k">THE CRITIC SAID</span>
          <span class="bt-critic__seal g-mono">${locked ? 'waiting for the round to end…' : 'sealed until you lock in'}</span>
        </div>
        <div class="bt-critic__face bt-critic__front" aria-hidden=${!shown}>
          <span class="bt-critic__k">THE CRITIC SAID</span>
          <span class="bt-critic__v tnum">${shown ? value : ''}</span>
        </div>
      </div>
    </div>
  `
}

/* What Jev measured in this note: each Score as a tick at its mean with a band
 * for its spread, each yes/no as a bar; then the line where code takes over. */
function Measures({ run, lane, lanes, onPick, open }) {
  if (!lane)
    return html`<${Box} class="bt-measures"><${Label}>WHAT JEV MEASURES<//>
      <p class="g-muted">No Jev at this tasting: nothing is measured, and the text models guess from the words alone.</p><//>`
  const f = lane.features
  const m = lane.model
  const defs = run.measures
  const W = 200
  return html`
    <${Box} lane=${lane.index} class="bt-measures">
      <${Label} note=${`${lane.measured ?? 0}/${lane.todo ?? run.set_size} notes measured · ${lane.calls} requests`}>WHAT JEV MEASURES<//>
      ${lanes.length > 1 &&
      html`<div class="bt-pick" role="group" aria-label="Whose measurements">
        ${lanes.map(
          (ln, k) => html`<button type="button" key=${ln.index} class=${`bt-pick__b${ln.index === lane.index ? ' bt-pick__b--on' : ''}`}
            aria-pressed=${ln.index === lane.index} onClick=${() => onPick(k)}><${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
        )}
      </div>`}
      <div class="bt-rows">
        ${defs.scores.map((d) => {
          const s = f?.scores?.find((x) => x.id === d.id)
          const g = s ? band(s.score, s.spread, W) : null
          return html`<div class="bt-row" key=${d.id} title=${s ? `${d.label}: ${nearestLevel(s.score, d.levels)}` : d.label}>
            <span class="bt-row__k">${d.label}</span>
            <svg class=${`bt-track g-l${(lane.index % 4) + 1}`} viewBox=${`0 0 ${W} 14`} preserveAspectRatio="none" role="img"
              aria-label=${s ? `${d.label}: ${s.score.toFixed(1)} of 4, give or take ${s.spread.toFixed(1)}` : `${d.label}: not measured yet`}>
              <rect class="bt-track__bg" width=${W} height="14" />
              ${[1, 2, 3].map((l) => html`<line key=${l} class="bt-track__grid" x1=${(l * W) / 4} x2=${(l * W) / 4} y1="0" y2="14" />`)}
              ${g && html`<rect class="bt-track__band" x=${g.x} y="2" width=${Math.max(1, g.w)} height="10" />`}
              ${g && html`<rect class="bt-track__tick" x=${g.tick - 2} y="0" width="4" height="14" />`}
            </svg>
            <span class="bt-row__v tnum">${s ? `${s.score.toFixed(1)} ±${s.spread.toFixed(1)}` : '…'}</span>
          </div>`
        })}
        ${defs.nouls.map((d) => {
          const p = f?.nouls?.find((x) => x.id === d.id)?.p
          return html`<div class="bt-row" key=${d.id}>
            <span class="bt-row__k">${d.label}</span>
            <svg class="bt-track bt-track--yes" viewBox=${`0 0 ${W} 14`} preserveAspectRatio="none" role="img"
              aria-label=${p != null ? `${d.label}: probability of yes ${p.toFixed(2)}` : `${d.label}: not measured yet`}>
              <rect class="bt-track__bg" width=${W} height="14" />
              ${p != null && html`<rect class="bt-track__bar" width=${barWidth(p, W)} height="14" />`}
            </svg>
            <span class="bt-row__v tnum">${p != null ? p.toFixed(2) : '…'}</span>
          </div>`
        })}
      </div>
      <p class="g-mono g-muted bt-key">scales 0 to 4: the tick is the average level, the band its spread · yes/no: the bar is p(yes)</p>
      <div class="bt-code">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10 H15 M11 6 L15 10 L11 14" /></svg>
        <div class="bt-code__body">
          <p>
            ${`Jev doesn't guess the number. A ridge regression, fitted in code on the other ${m?.trained_on ?? run.set_size - 1} scored notes and never on this one, turns these ${m?.features ?? 17} measurements into one`}${open && m
              ? html`: <b class="tnum">${m.prediction.toFixed(1)}</b>, bid as <b class="tnum">${m.guess}</b>.`
              : m ? ', sealed until you lock in.' : '.'}${m ? ` Across the set it is off by about ${m.rmse.toFixed(1)} points.` : ''}
          </p>
          ${!m && lane.status !== 'error' &&
          html`<${Meter} value=${(lane.measured ?? 0) / (lane.todo || run.set_size)} tone="lane" label=${`measuring every note: ${lane.measured ?? 0} of ${lane.todo ?? run.set_size}`} />`}
          ${m &&
          html`<div class="bt-weights" aria-label="The model's heaviest weights, in score points per spread of the set">
            ${m.top.map((t) => html`<${Chip} key=${t.id} tone=${t.w >= 0 ? 'ok' : 'err'}>${fmtWeight(t.w)} ${t.label}<//>`)}
          </div>`}
        </div>
      </div>
    <//>
  `
}

/* The model's own report card: each other note's leave-one-out prediction
 * against what the critic gave it, the diagonal where they agree, this note's
 * prediction as a line and, once revealed, this note as a ringed dot. */
function Scatter({ model, lane, critic }) {
  const S = 220
  const P = 24
  const pts = scatter(model.loo, S, P)
  const px = axis(model.prediction, S, P)
  const ticks = [80, 90, 100]
  return html`
    <${Box} class="bt-scatter">
      <${Label} note=${`off by ±${model.rmse.toFixed(1)} on average`}>THE MODEL ON THE OTHER ${model.loo.length} NOTES<//>
      <div class="bt-scatter__row">
        <svg class=${`bt-scatter__svg g-l${(lane % 4) + 1}`} viewBox=${`0 0 ${S} ${S}`} role="img"
          aria-label=${`The model's predictions for the other ${model.loo.length} notes against the critic's scores: off by ${model.rmse.toFixed(1)} points on average`}>
          <rect class="bt-sc__frame" x=${P} y=${P} width=${S - 2 * P} height=${S - 2 * P} />
          ${ticks.map(
            (t) => html`<g key=${t}>
              <text class="bt-sc__k" x=${axis(t, S, P)} y=${S - 8}>${t}</text>
              <text class="bt-sc__k" x="12" y=${S - axis(t, S, P) + 3}>${t}</text>
            </g>`,
          )}
          <line class="bt-sc__diag" x1=${P} y1=${S - P} x2=${S - P} y2=${P} />
          <line class="bt-sc__pred" x1=${px} y1=${P} x2=${px} y2=${S - P} />
          ${pts.map((p) => html`<circle key=${p.n} class="bt-sc__dot" cx=${p.x} cy=${p.y} r="3.2" />`)}
          ${critic != null && html`<circle class="bt-sc__this" cx=${px} cy=${S - axis(critic, S, P)} r="6" />`}
        </svg>
        <p class="g-mono g-muted bt-scatter__key">
          each dot: a note the model did not see, its prediction (across) against the critic's score (up) ·
          the diagonal: exactly right · the line: this note's prediction${critic != null ? ' · the ring: this note' : ''}
        </p>
      </div>
    <//>
  `
}
