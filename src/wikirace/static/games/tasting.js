/* Blind Tasting — guess the critic's score: closest without going over.
 *
 * The server (games/tasting.py) pours one note and has Jev measure every note
 * in the set (seven 0 to 4 Scores, three yes/no), then fits a ridge regression
 * in code on the other notes and predicts this one; a text model reads the
 * note and names a number. Here you read the note (a glass of the style beside
 * it) and Jev's measurements, filling in gauge by gauge, type your guess (your
 * needle swings to it on the dial) and lock it in (kept in this browser only).
 * Only then do the other needles and price tags open, and once the round is
 * over the critic's card turns: the critic's mark drops onto the dial, every
 * guess above it busts in red, and the closest under it lights gold.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  Counter,
  GameFrame,
  Label,
  LaneCard,
  LaneNum,
  PixelText,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  againOf,
  burstFrom,
  html,
  sfx,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { Button } from '../ui.js'
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import {
  HIGH,
  LOW,
  arcPath,
  axis,
  band,
  barWidth,
  dialAngle,
  fateOf,
  fmtWeight,
  nearestLevel,
  parseGuess,
  polar,
  scatter,
  wineKind,
  winners,
} from './tasting.logic.js'

const ANCHORS = '80 flawed · 85 simple · 90 excellent · 95 outstanding · 98+ rare'
const GOLD = ['#ffe14d', '#fff3a8', '#ff7eb6', '#ffffff']
const fmtInt = (v) => String(Math.round(v))
const fmt1 = (v) => (Math.round(v * 10) / 10).toFixed(1)

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
          <${Box} class="bt-how">
            <${Label}>HOW IT'S PLAYED<//>
            <div class="bt-how__top">
              <${DemoDial} />
              <p class="g-explain">
                A critic tasted forty wines and scored each from ${LOW} to ${HIGH}. You get one tasting note and guess
                the score. The guess <b>closest without going over</b> wins; a guess above the critic's score loses,
                however close.
              </p>
            </div>
            <p class="g-explain">
              <b>Jev</b> doesn't guess the number. It measures qualities in every note of the set: seven Scores (fruit,
              oak, structure, acidity, complexity, finish, balance) and three yes/no questions (will it age? a flaw?
              drink now?). A small ridge regression in code, fitted on the other notes and never on this one, turns
              those seventeen features into a score. A <b>text model</b> reads the note and names a number; one
              outside ${LOW} to ${HIGH} is a foul.
            </p>
            <div class="bt-rules">
              <${Chip} tone="ok">✓ closest, not over: wins<//><${Chip} tone="err">✕ over: loses<//><${Chip} tone="cy">Jev: features, not answers<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.wine?.style ?? ''}</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The rule in miniature, on a loop: two needles swing, the critic's mark
 *  drops between them, the one past it busts and the one under it wins. */
function DemoDial() {
  const C = [150, 142]
  const R = 112
  const ticks = [80, 85, 90, 95, 100]
  return html`
    <svg class="bt-demo" viewBox="0 0 300 170" role="img"
      aria-label="A dial from 80 to 100: one needle stops at 91, another at 95; the critic's mark lands at 93, so 95 busts and 91 wins">
      <path class="bt-demo__face" d=${`${arcPath(C[0], C[1], R + 8, -90, 90)} Z`} />
      <path class="bt-demo__rim" d=${arcPath(C[0], C[1], R, -90, 90)} />
      <path class="bt-demo__bust" d=${arcPath(C[0], C[1], R, dialAngle(93), 90)} />
      ${ticks.map((t) => {
        const [x, y] = polar(C[0], C[1], R + 20, dialAngle(t))
        return html`<text key=${t} class="bt-demo__num" x=${x} y=${y + 3}>${t}</text>`
      })}
      <g class="bt-demo__critic">
        <path d=${`M${polar(C[0], C[1], R - 12, dialAngle(93)).join(' ')} L${polar(C[0], C[1], R + 12, dialAngle(93) - 4).join(' ')} L${polar(C[0], C[1], R + 12, dialAngle(93) + 4).join(' ')} Z`} />
      </g>
      <g class="bt-demo__hand bt-demo__hand--a" style=${{ '--to': `${dialAngle(91)}deg`, '--c': 'var(--lane-1)' }}>
        <line x1=${C[0]} y1=${C[1]} x2=${C[0]} y2=${C[1] - R + 16} />
        <circle cx=${C[0]} cy=${C[1] - R + 16} r="8" />
      </g>
      <g class="bt-demo__hand bt-demo__hand--b" style=${{ '--to': `${dialAngle(95)}deg`, '--c': 'var(--lane-2)' }}>
        <line x1=${C[0]} y1=${C[1]} x2=${C[0]} y2=${C[1] - R + 34} />
        <circle cx=${C[0]} cy=${C[1] - R + 34} r="8" />
      </g>
      <circle class="bt-demo__hub" cx=${C[0]} cy=${C[1]} r="9" />
      <text class="bt-demo__word bt-demo__word--win" x="46" y="166">91 WINS</text>
      <text class="bt-demo__word bt-demo__word--bust" x="254" y="166">95 BUSTS</text>
    </svg>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  return html`
    <${GameFrame} game=${game}>
      ${run.wine
        ? html`<${Tasting} key=${run.id} run=${run} now=${now} error=${error} />`
        : html`
            <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>${error && html`<span class="g-t-warn">${error}</span>`}<//>
            <p class="g-muted">This round poured nothing.</p>
          `}
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

/**
 * The finale's words, by the game's rule (the server's `run.winners`: the
 * guess closest to the critic's without going over; ties share). Until you
 * have locked in, the run's end names nobody — it would tell whose guess is
 * best — and asks for your guess instead.
 */
function finaleOf(run, open, critic) {
  if (!open) return { winners: [], headline: 'GUESSES ARE IN!', sub: 'Lock in your guess, or just watch, to turn the critic’s card.', quiet: true }
  const won = (run.winners ?? []).filter((i) => Number.isInteger(i) && run.lanes[i])
  if (critic == null) return { winners: won }
  if (!won.length) {
    const guessed = run.lanes.filter((l) => Number.isFinite(l.guess))
    const allOver = guessed.length > 0 && guessed.every((l) => l.guess > critic)
    return allOver
      ? { winners: [], headline: 'ALL BUST!', sub: `Every guess went over the critic’s ${critic}.`, quiet: true }
      : { winners: [], headline: 'NO WINNER', sub: `No guess came in at or under the critic’s ${critic}.`, quiet: true }
  }
  const sub = `${won.map((i) => run.lanes[i].label).join(' · ')}: ${run.lanes[won[0]].guess}, the critic said ${critic}`
  return won.length > 1 ? { winners: won, headline: 'TIE GAME!', sub } : { winners: won, headline: `PLAYER ${won[0] + 1} WINS!`, sub }
}

function Tasting({ run, now, error }) {
  const [mine, setMine] = useMine(run.id)
  const jevLanes = run.lanes.filter((l) => l.kind === 'judgment')
  const [jx, setJx] = useState(0)
  const jev = jevLanes[Math.min(jx, jevLanes.length - 1)] ?? null
  const critic = Number.isFinite(run.critic) ? run.critic : null
  const open = mine.locked
  const revealed = open && critic != null
  const won = revealed ? winners([{ key: 'you', guess: mine.guess }, ...run.lanes.map((ln) => ({ key: ln.index, guess: ln.guess }))], critic) : []
  const typed = parseGuess(mine.text)
  const lock = () => {
    if (typed == null) return
    sfx.coin()
    setMine({ ...mine, guess: typed, locked: true })
  }
  const pass = () => setMine({ ...mine, guess: null, locked: true })
  const fate = (g, key) => (revealed ? fateOf(g, critic, won.includes(key)) : Number.isFinite(g) ? 'sealed' : 'none')
  const youFate = revealed ? fate(mine.guess, 'you') : (open ? mine.guess : typed) != null ? 'mine' : 'none'
  const fin = finaleOf(run, open, critic)
  const board = useRef(null)
  useReveal(revealed, open, youFate, board)

  return html`
    <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub} win=${!fin.quiet}>
      <span class="g-mono g-muted">note ${run.wine.n} of ${run.set_size} · ${run.wine.style}</span>
      ${error && html`<span class="g-t-warn">${error}</span>`}
    <//>
    <div class=${`bt-stage${revealed ? ' is-revealed' : ''}`} ref=${board}>
      <div class="bt-left">
        <${Box} class="bt-note">
          <div class="bt-note__hd">
            <${Label}>THE NOTE<//>
            <span class="spacer" />
            <span class="bt-note__style">${run.wine.style}</span>
          </div>
          <div class="bt-note__body">
            <${Glass} kind=${wineKind(run.wine.style)} />
            <p class="bt-note__text">${run.wine.text}</p>
          </div>
          <span class="g-mono g-muted bt-note__meta">${run.wine.style} · score ${revealed ? critic : 'hidden'} · ${LOW} to ${HIGH}</span>
        <//>
        <${Box} class=${`bt-guessbox${open ? ' is-locked' : ''}`}>
          ${open
            ? html`<p class="bt-locked">
                <span class="bt-locked__k">${Number.isFinite(mine.guess) ? 'LOCKED IN' : 'WATCHING'}</span>
                <span class="bt-locked__v g-mono">${Number.isFinite(mine.guess) ? `locked in: ${mine.guess}` : 'you are watching this one'}</span>
              </p>`
            : html`
                <label for="bt-guess" class="bt-guess__k">YOUR GUESS</label>
                <div class="bt-guess">
                  <input id="bt-guess" class="bt-guess__in tnum" type="number" inputmode="numeric" min=${LOW} max=${HIGH} step="1"
                    value=${mine.text} aria-describedby="bt-guess-help" placeholder="—"
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
        <//>
      </div>
      <div class="bt-mid">
        <${Dial} run=${run} you=${open ? mine.guess : typed} youFate=${youFate} open=${open} revealed=${revealed} critic=${critic} won=${won} fate=${fate} />
      </div>
      <div class="bt-right">
        <${Label}>THE GUESSES<//>
        <${Tag} i=${0} you who="You" value=${open ? mine.guess : typed} fate=${youFate}
          note=${!open ? (typed != null ? 'not locked in yet' : 'type a guess') : noteOf(revealed ? fate(mine.guess, 'you') : 'mine', mine.guess, critic, false)} />
        ${run.lanes.map((ln, k) => {
          const f = open ? fate(ln.guess, ln.index) : 'sealed'
          return html`<${Tag} key=${ln.index} i=${k + 1} lane=${ln.index} who=${ln.kind === 'judgment' ? `${ln.label} + model` : ln.label}
            value=${open ? ln.guess : null} fate=${f} note=${laneNote(ln, f, critic, open)} />`
        })}
        <${Critic} value=${critic} shown=${revealed} locked=${open} />
      </div>
    </div>
    <div class="bt-lab">
      <${Measures} run=${run} lane=${jev} lanes=${jevLanes} onPick=${setJx} />
      <${Maths} run=${run} lane=${jev} open=${open} critic=${revealed ? critic : null} />
    </div>
    <div class="g-lanes">
      ${run.lanes.map((ln) => html`<${LaneCard} key=${ln.index} lane=${ln}><${LaneBody} ln=${ln} run=${run} open=${open} fate=${open ? fate(ln.guess, ln.index) : 'sealed'} /><//>`)}
    </div>
  `
}

/**
 * The reveal, when it happens in front of you: once the card has turned and
 * the needles settled, confetti off the winning tag, and a cheer or a groan
 * when your locking in is what turned it (at the run's own end the finale has
 * the fanfare). A round reopened after the fact just shows its result.
 */
function useReveal(revealed, open, youFate, board) {
  const seen = useRef(revealed)
  const wasOpen = useRef(open)
  useEffect(() => {
    const before = seen.current
    seen.current = revealed
    if (!revealed || before) return
    const byLock = !wasOpen.current
    const t = setTimeout(() => {
      const el = board.current
      const you = el?.querySelector('.bt-tag--you.bt-tag--won')
      const any = el?.querySelector('.bt-tag--won')
      if (any) burstFrom(you ?? any, { colors: GOLD, count: you ? 120 : 50, power: you ? 1 : 0.75 })
      if (!byLock) return
      if (you) sfx.win()
      else if (youFate === 'over') sfx.over()
      else sfx.coin()
    }, 1100)
    return () => clearTimeout(t)
  }, [revealed])
  useEffect(() => {
    wasOpen.current = open
  })
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

/* ── The glass ─────────────────────────────────────────────────────────────── */

const BOWL = 'M12 8 H60 C62 40 56 64 36 66 C16 64 10 40 12 8 Z'

/** A glass of the note's style: its colour, a slow swirl, bubbles if it sparkles. */
function Glass({ kind }) {
  return html`
    <svg class=${`bt-glass bt-glass--${kind}`} viewBox="0 0 72 120" aria-hidden="true">
      <defs>
        <clipPath id="bt-glass-bowl"><path d=${BOWL} /></clipPath>
        <linearGradient id="bt-glass-wine" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" class="bt-glass__hi" /><stop offset="1" class="bt-glass__lo" />
        </linearGradient>
      </defs>
      <g clip-path="url(#bt-glass-bowl)">
        <rect x="0" y="0" width="72" height="70" class="bt-glass__air" />
        <g class="bt-glass__swirl">
          <path d="M-60 30 Q-51 25 -42 30 T-24 30 T-6 30 T12 30 T30 30 T48 30 T66 30 T84 30 T102 30 T120 30 V80 H-60 Z" fill="url(#bt-glass-wine)" />
        </g>
        ${kind === 'sparkling' && html`
          <g class="bt-glass__fizz">
            <circle cx="26" cy="60" r="1.6" /><circle cx="36" cy="62" r="1.2" /><circle cx="46" cy="58" r="1.5" /><circle cx="31" cy="64" r="1" />
          </g>`}
        <path class="bt-glass__shine" d="M18 12 C16 30 18 46 24 56" />
      </g>
      <path class="bt-glass__edge" d=${BOWL} />
      <path class="bt-glass__stem" d="M36 66 V104 M20 110 C28 106 44 106 52 110" />
    </svg>
  `
}

/* ── The dial ──────────────────────────────────────────────────────────────── */

const CX = 220
const CY = 222
const RIM = 160
const PARK = -90

/**
 * Every guess as a needle on one dial from 80 to 100: yours follows what you
 * type; the others stay hidden until you lock in, then rise from 80 to theirs. At
 * the reveal the critic's mark drops onto the rim, the arc above it turns to
 * a red BUST zone, needles past it shake red, and the winner's glows gold.
 */
function Dial({ run, you, youFate, open, revealed, critic, won, fate }) {
  const ticks = []
  for (let v = LOW; v <= HIGH; v++) ticks.push(v)
  const hands = run.lanes.map((ln, k) => ({
    key: ln.index, i: k, value: open ? ln.guess : null, len: RIM - 46 - k * 20,
    color: `var(--lane-${(ln.index % 4) + 1})`, label: String(ln.index + 1),
    fate: open ? fate(ln.guess, ln.index) : 'sealed',
  }))
  const ac = critic != null ? dialAngle(critic) : null
  const under = revealed ? [...run.lanes.map((l) => l.guess), you].filter((g) => Number.isFinite(g) && g <= critic) : []
  const best = under.length ? Math.max(...under) : null
  const said = []
  if (Number.isFinite(you)) said.push(`you ${open ? 'locked in' : 'typed'} ${you}`)
  if (open) run.lanes.forEach((ln) => Number.isFinite(ln.guess) && said.push(`player ${ln.index + 1} ${ln.guess}`))
  if (revealed) said.push(`the critic said ${critic}`)
  return html`
    <${Box} class="bt-dialbox">
      <div class="bt-dial">
        <svg viewBox="0 0 440 262" role="img"
          aria-label=${`The dial from ${LOW} to ${HIGH}${said.length ? `: ${said.join(', ')}` : ''}${open ? '' : '; the other guesses are sealed until you lock in'}`}>
          <defs>
            <linearGradient id="bt-rim" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0" stop-color="#5b4bd6" /><stop offset=".55" stop-color="#ff7eb6" /><stop offset="1" stop-color="#ffe14d" />
            </linearGradient>
            <radialGradient id="bt-face" cx=".5" cy="1" r="1">
              <stop offset="0" stop-color="#2a1a4e" /><stop offset=".7" stop-color="#140c30" /><stop offset="1" stop-color="#0a0620" />
            </radialGradient>
            <pattern id="bt-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="7" height="7" fill="#5c1024" /><rect width="3.5" height="7" fill="#ff4d6a" />
            </pattern>
          </defs>
          <path class="bt-dial__bezel" d=${`${arcPath(CX, CY, RIM + 38, -90, 90)} Z`} />
          <path class="bt-dial__face" d=${`${arcPath(CX, CY, RIM + 22, -90, 90)} Z`} fill="url(#bt-face)" />
          <path class="bt-dial__glow" d=${arcPath(CX, CY, RIM, -90, 90)} stroke="url(#bt-rim)" />
          <path class="bt-dial__rim" d=${arcPath(CX, CY, RIM, -90, 90)} stroke="url(#bt-rim)" />
          ${ticks.map((v) => {
            const a = dialAngle(v)
            const major = v % 5 === 0
            const [x1, y1] = polar(CX, CY, RIM + 8, a)
            const [x2, y2] = polar(CX, CY, RIM + (major ? 20 : 14), a)
            return html`<line key=${v} class=${`bt-dial__tick${major ? ' is-major' : ''}`} x1=${x1} y1=${y1} x2=${x2} y2=${y2} />`
          })}
          ${[80, 85, 90, 95, 100].map((v) => {
            const [x, y] = polar(CX, CY, RIM + 31, dialAngle(v))
            return html`<text key=${`n${v}`} class="bt-dial__num" x=${x} y=${y + 4}>${v}</text>`
          })}
          ${revealed && html`
            <path key="bust" class="bt-dial__bust" d=${arcPath(CX, CY, RIM, ac, 90.01)} stroke="url(#bt-hatch)" pathLength="100" />
            ${best != null && ac - dialAngle(best) > 0.5 && html`<path key="gap" class="bt-dial__gap" d=${arcPath(CX, CY, RIM - 13, dialAngle(best), ac)} />`}
            ${90 - ac > 14 && html`<text key="bl" class="bt-dial__bustk" x=${polar(CX, CY, RIM - 26, Math.max(ac + 7, 80))[0]} y=${polar(CX, CY, RIM - 26, Math.max(ac + 7, 80))[1] + 4}>BUST</text>`}
          `}
          ${hands.map((hd) => html`<${Hand} ...${hd} />`)}
          <${Hand} key="you" i=${0} you value=${you} len=${RIM - 22} color="var(--txt)" label="YOU" fate=${youFate} />
          ${revealed && html`
            <g key="critic" class="bt-dial__critic">
              <path d=${`M${polar(CX, CY, RIM - 14, ac).join(' ')} L${polar(CX, CY, RIM + 16, ac - 3.4).join(' ')} L${polar(CX, CY, RIM + 16, ac + 3.4).join(' ')} Z`} />
              <text x=${polar(CX, CY, RIM + 48, ac)[0]} y=${polar(CX, CY, RIM + 48, ac)[1] + 5}>${critic}</text>
            </g>`}
          <circle class="bt-dial__hub" cx=${CX} cy=${CY} r="17" />
          <circle class="bt-dial__hubin" cx=${CX} cy=${CY} r="7" />
        </svg>
      </div>
      <${Readout} you=${you} youFate=${youFate} open=${open} revealed=${revealed} critic=${critic} run=${run} won=${won} />
    <//>
  `
}

/** One needle: a lane's (its number at the tip) or yours (YOU). It swings on a
 *  spring; the tip stays upright as it turns. */
function Hand({ i, value, len, color, label, fate, you }) {
  const set = Number.isFinite(value)
  const a = set ? dialAngle(value) : PARK
  return html`
    <g class=${`bt-hand bt-hand--${fate}${you ? ' bt-hand--you' : ''}${set ? '' : ' is-parked'}`}
      style=${{ '--c': color, '--i': i, transform: `rotate(${a}deg)` }} aria-hidden="true">
      <g class="bt-hand__shake">
        <line class="bt-hand__glow" x1=${CX} y1=${CY} x2=${CX} y2=${CY - len} />
        <line class="bt-hand__line" x1=${CX} y1=${CY} x2=${CX} y2=${CY - len} />
        <g class="bt-hand__tip" style=${{ transform: `translate(${CX}px, ${CY - len}px) rotate(${-a}deg)` }}>
          ${you
            ? html`<rect x="-19" y="-11" width="38" height="22" rx="7" /><text y="4.5">${label}</text>`
            : html`<circle r="12" /><text y="4.5">${label}</text>`}
        </g>
      </g>
    </g>
  `
}

/** Under the dial: your guess as you type it, then the verdict in lights. */
function Readout({ you, youFate, open, revealed, critic, run, won }) {
  const lanesWon = won.filter((k) => k !== 'you').map((k) => run.lanes[k]).filter(Boolean)
  const guessed = Number.isFinite(you)
  if (!open) {
    return html`<div class="bt-read">
      <span class="bt-read__k">YOUR GUESS</span>
      <span class=${`bt-read__big${guessed ? '' : ' is-empty'}`}><${PixelText} text=${guessed ? String(you) : '--'} label=${guessed ? `your guess ${you}` : 'no guess yet'} /></span>
      <span class="bt-read__sub">${guessed ? 'your needle is on the dial · lock it in when you are sure' : `type a whole number from ${LOW} to ${HIGH}`}</span>
    </div>`
  }
  if (!revealed) {
    return html`<div class="bt-read">
      <span class="bt-read__k">${guessed ? `LOCKED IN AT ${you}` : 'WATCHING'}</span>
      <span class="bt-read__big is-wait"><${PixelText} text="??" label="the critic's score, still sealed" /></span>
      <span class="bt-read__sub">${isRunLive(run) ? 'waiting for every player and the critic…' : 'the critic is turning the card…'}</span>
    </div>`
  }
  const [text, tone] = youFate === 'won'
    ? ['YOU WIN!', 'win']
    : youFate === 'over'
      ? ['BUST!', 'bust']
      : youFate === 'under'
        ? [`${Math.round((critic - you) * 10) / 10} UNDER`, 'under']
        : [`CRITIC: ${critic}`, 'watch']
  const who = lanesWon.length
    ? `${youFate === 'won' ? 'tied with ' : 'closest without going over: '}${lanesWon.map((l) => `${l.label} (${l.guess})`).join(', ')}`
    : youFate === 'won' ? 'you beat every player' : 'nobody came in under'
  return html`
    <div class=${`bt-read bt-read--${tone}`}>
      <span class="bt-read__k">THE CRITIC SAID ${critic}</span>
      <span class="bt-read__big" key=${text}><${PixelText} text=${text} label=${text} /></span>
      <span class="bt-read__sub">${who}</span>
    </div>
  `
}

/* ── The guesses ───────────────────────────────────────────────────────────── */

/** A guess as a price tag: stamped BUST when it went over, gold when it won. */
function Tag({ i, who, lane, value, fate, note, you }) {
  const blank = fate === 'sealed' ? '?' : '—'
  const whole = !Number.isFinite(value) || Number.isInteger(value)
  return html`
    <div class=${`bt-tag bt-tag--${fate}${you ? ' bt-tag--you' : ''}`} style=${{ '--i': i }}>
      <svg class="bt-tag__shape" viewBox="0 0 200 64" preserveAspectRatio="none" aria-hidden="true">
        <path d="M20 1 H199 V63 H20 L1 32 Z" />
      </svg>
      <span class="bt-tag__hole" aria-hidden="true" />
      <span class="bt-tag__who">
        <span class="bt-tag__name">${lane != null && html`<${LaneNum} i=${lane} />`}${who}</span>
        <small class="bt-tag__note g-mono">${note}</small>
      </span>
      <span class="bt-tag__v tnum"><${Counter} value=${Number.isFinite(value) ? value : NaN} blank=${blank} format=${whole ? fmtInt : fmt1} />${fate === 'over' && html`<span class="sr-only"> (over)</span>`}</span>
      ${fate === 'won' && html`<span class="bt-tag__ribbon" aria-hidden="true">★ WINNER</span>`}
      ${fate === 'over' && html`<span class="bt-tag__bust" aria-hidden="true">BUST</span>`}
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
          <span class="bt-critic__q" aria-hidden="true"><${PixelText} text="?" /></span>
          <span class="bt-critic__seal g-mono">${locked ? 'waiting for the round to end…' : 'sealed until you lock in'}</span>
        </div>
        <div class="bt-critic__face bt-critic__front" aria-hidden=${!shown}>
          <span class="bt-critic__k">THE CRITIC SAID</span>
          <span class="bt-critic__v tnum"><${Counter} value=${shown && Number.isFinite(value) ? value : LOW} /></span>
          <span class="bt-critic__rule g-mono">closest without going over wins</span>
        </div>
      </div>
    </div>
  `
}

/* ── What Jev measures ─────────────────────────────────────────────────────── */

/** A wine rack of the set's notes, one bottle lit as Jev measures each; this
 *  round's note is ringed. Decoration over the count beside it. */
function Rack({ size, measured, poured }) {
  return html`
    <div class="bt-rack" aria-hidden="true">
      ${Array.from({ length: size }, (_, k) => html`
        <span key=${k} class=${`bt-rack__b${k < measured ? ' is-lit' : ''}${k + 1 === poured ? ' is-poured' : ''}`} />`)}
    </div>
  `
}

/* What Jev measured in this note: each Score as a lit gauge filled to its mean
 * with a band for its spread, each yes/no as a bar; the notes measured so far
 * as a rack of bottles. */
function Measures({ run, lane, lanes, onPick }) {
  if (!lane)
    return html`<${Box} class="bt-measures"><${Label}>WHAT JEV MEASURES<//>
      <p class="g-muted">No Jev at this tasting: nothing is measured, and the text models guess from the words alone.</p><//>`
  const f = lane.features
  const defs = run.measures
  const todo = lane.todo ?? run.set_size
  const measured = lane.measured ?? 0
  return html`
    <${Box} lane=${lane.index} class="bt-measures">
      <${Label} note=${`${measured}/${todo} notes measured · ${lane.calls} requests`}>WHAT JEV MEASURES<//>
      ${lanes.length > 1 &&
      html`<div class="bt-pick" role="group" aria-label="Whose measurements">
        ${lanes.map(
          (ln, k) => html`<button type="button" key=${ln.index} class=${`bt-pick__b${ln.index === lane.index ? ' bt-pick__b--on' : ''}`}
            aria-pressed=${ln.index === lane.index} onClick=${() => onPick(k)}><${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
        )}
      </div>`}
      <div class="bt-cellar">
        <span class="bt-cellar__n"><${Counter} value=${measured} class="g-score" /><small>/${todo}</small></span>
        <div class="bt-cellar__rack">
          <${Rack} size=${todo} measured=${measured} poured=${run.wine.n} />
          <span class="bt-cellar__k g-mono">${measured >= todo ? 'every note in the set measured: the model can fit' : 'measuring every note in the set, sixteen at a time'}</span>
        </div>
      </div>
      <div class=${`bt-rows${f ? ' is-in' : ''}`}>
        ${defs.scores.map((d, k) => {
          const s = f?.scores?.find((x) => x.id === d.id)
          const g = s ? band(s.score, s.spread, 100) : null
          return html`<div class=${`bt-row${s ? ' is-in' : ''}`} key=${d.id} style=${{ '--i': k }} title=${s ? `${d.label}: ${nearestLevel(s.score, d.levels)}` : d.label}>
            <span class="bt-row__k">${d.label}${s && html`<small class="bt-row__lvl">${nearestLevel(s.score, d.levels)}</small>`}</span>
            <span class=${`bt-gauge g-l${(lane.index % 4) + 1}`} role="img"
              aria-label=${s ? `${d.label}: ${s.score.toFixed(1)} of 4, give or take ${s.spread.toFixed(1)}` : `${d.label}: not measured yet`}>
              ${g && html`
                <span class="bt-gauge__fill" style=${{ width: `${g.tick}%` }} />
                <span class="bt-gauge__band" style=${{ left: `${g.x}%`, width: `${Math.max(0.6, g.w)}%` }} />
                <span class="bt-gauge__tick" style=${{ left: `${g.tick}%` }} />`}
            </span>
            <span class="bt-row__v tnum">${s ? `${s.score.toFixed(1)} ±${s.spread.toFixed(1)}` : '…'}</span>
          </div>`
        })}
        ${defs.nouls.map((d, k) => {
          const p = f?.nouls?.find((x) => x.id === d.id)?.p
          return html`<div class=${`bt-row bt-row--yes${p != null ? ' is-in' : ''}`} key=${d.id} style=${{ '--i': defs.scores.length + k }}>
            <span class="bt-row__k">${d.label}${p != null && html`<small class="bt-row__lvl">${p >= 0.5 ? 'likely yes' : 'likely no'}</small>`}</span>
            <span class=${`bt-gauge bt-gauge--yes g-l${(lane.index % 4) + 1}`} role="img"
              aria-label=${p != null ? `${d.label}: probability of yes ${p.toFixed(2)}` : `${d.label}: not measured yet`}>
              ${p != null && html`<span class="bt-gauge__fill" style=${{ width: `${barWidth(p, 100)}%` }} />`}
              <span class="bt-gauge__half" aria-hidden="true" />
            </span>
            <span class="bt-row__v tnum">${p != null ? p.toFixed(2) : '…'}</span>
          </div>`
        })}
      </div>
      <p class="g-mono g-muted bt-key">scales 0 to 4: the fill and tick are the average level, the band its spread · yes/no: the bar is p(yes)</p>
    <//>
  `
}

/* Where code takes over: the features into a ridge regression into a number,
 * the heaviest weights, and the model's own report card. */
function Maths({ run, lane, open, critic }) {
  const m = lane?.model
  if (!lane) return null
  const ready = !!m
  return html`
    <${Box} class=${`bt-maths${ready ? ' is-ready' : ''}${open && m ? ' is-open' : ''}`}>
      <${Label} note="code, not Jev">THE MATHS<//>
      <ol class="bt-pipe" aria-label="Jev's measurements into a ridge regression into a score">
        <li class="bt-pipe__node"><b class="tnum">${m?.features ?? 17}</b><small>features</small></li>
        <li class="bt-pipe__wire" aria-hidden="true" />
        <li class="bt-pipe__node bt-pipe__node--fit"><b>RIDGE</b><small>fitted on ${m?.trained_on ?? run.set_size - 1} other notes</small></li>
        <li class="bt-pipe__wire" aria-hidden="true" />
        <li class="bt-pipe__node bt-pipe__node--out"><b class="tnum">${open && m ? m.prediction.toFixed(1) : '??.?'}</b><small>prediction</small></li>
        <li class="bt-pipe__wire" aria-hidden="true" />
        <li class=${`bt-pipe__node bt-pipe__node--bid g-l${(lane.index % 4) + 1}`}><b class="tnum">${open && m ? m.guess : '??'}</b><small>the bid</small></li>
      </ol>
      <div class="bt-code__body">
        <p>
          ${`Jev doesn't guess the number. A ridge regression, fitted in code on the other ${m?.trained_on ?? run.set_size - 1} scored notes and never on this one, turns these ${m?.features ?? 17} measurements into one`}${open && m
            ? html`: <b class="tnum">${m.prediction.toFixed(1)}</b>, bid as <b class="tnum">${m.guess}</b>.`
            : m ? ', sealed until you lock in.' : '.'}${m ? ` Across the set it is off by about ${m.rmse.toFixed(1)} points.` : ''}
        </p>
        ${!m && lane.status !== 'error' && html`<p class="bt-code__wait g-mono">waiting for every note to be measured…</p>`}
        ${m &&
        html`<div class="bt-weights" aria-label="The model's heaviest weights, in score points per spread of the set">
          ${m.top.map((t, k) => html`<span key=${t.id} class="bt-weight" style=${{ '--i': k }}><${Chip} tone=${t.w >= 0 ? 'ok' : 'err'}>${fmtWeight(t.w)} ${t.label}<//></span>`)}
        </div>`}
      </div>
      ${open && m && html`<${Scatter} model=${m} lane=${lane.index} critic=${critic} />`}
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
    <div class="bt-scatter">
      <${Label} note=${`off by ±${model.rmse.toFixed(1)} on average`}>THE MODEL ON THE OTHER ${model.loo.length} NOTES<//>
      <div class="bt-scatter__row">
        <svg class=${`bt-scatter__svg g-l${(lane % 4) + 1}`} viewBox=${`0 0 ${S} ${S}`} role="img"
          aria-label=${`The model's predictions for the other ${model.loo.length} notes against the critic's scores: off by ${model.rmse.toFixed(1)} points on average`}>
          <rect class="bt-sc__frame" x=${P} y=${P} width=${S - 2 * P} height=${S - 2 * P} rx="4" />
          ${ticks.map(
            (t) => html`<g key=${t}>
              <line class="bt-sc__grid" x1=${axis(t, S, P)} y1=${P} x2=${axis(t, S, P)} y2=${S - P} />
              <line class="bt-sc__grid" x1=${P} y1=${S - axis(t, S, P)} x2=${S - P} y2=${S - axis(t, S, P)} />
              <text class="bt-sc__k" x=${axis(t, S, P)} y=${S - 8}>${t}</text>
              <text class="bt-sc__k" x="12" y=${S - axis(t, S, P) + 3}>${t}</text>
            </g>`,
          )}
          <line class="bt-sc__diag" x1=${P} y1=${S - P} x2=${S - P} y2=${P} />
          <line class="bt-sc__pred" x1=${px} y1=${P} x2=${px} y2=${S - P} />
          ${pts.map((p, k) => html`<circle key=${p.n} class="bt-sc__dot" cx=${p.x} cy=${p.y} r="3.4" style=${{ '--i': k }} />`)}
          ${critic != null && html`
            <circle class="bt-sc__ping" cx=${px} cy=${S - axis(critic, S, P)} r="6" />
            <circle class="bt-sc__this" cx=${px} cy=${S - axis(critic, S, P)} r="6" />`}
        </svg>
        <p class="g-mono g-muted bt-scatter__key">
          each dot: a note the model did not see, its prediction (across) against the critic's score (up) ·
          the diagonal: exactly right · the line: this note's prediction${critic != null ? ' · the ring: this note' : ''}
        </p>
      </div>
    </div>
  `
}

/* ── A lane ────────────────────────────────────────────────────────────────── */

function LaneBody({ ln, run, open, fate }) {
  const glyph = { won: '★ closest, not over', over: '✕ went over', under: '✓ under', none: ln.fouls ? '✕ no guess · foul' : 'no guess' }[fate]
  const tone = { won: 'win', over: 'err', under: 'ok', none: 'dim' }[fate] ?? 'dim'
  return html`
    <div class=${`bt-lanebody bt-lanebody--${fate}`}>
      <div class="bt-lanebody__guess">
        <${Counter} value=${open && Number.isFinite(ln.guess) ? ln.guess : NaN} blank=${open ? '—' : '?'}
          format=${Number.isInteger(ln.guess) || !Number.isFinite(ln.guess) ? fmtInt : fmt1} class="g-score" />
        <small>${ln.kind === 'judgment' ? 'bid' : 'guess'}</small>
      </div>
      <div class="bt-lanebody__main">
        ${ln.kind === 'judgment'
          ? html`
              <span class="g-mono">${ln.measured ?? 0}/${ln.todo ?? run.set_size} notes measured${ln.model ? ` · model error ±${ln.model.rmse.toFixed(1)}` : ''}</span>
              <span class="bt-lanebody__bar"><span style=${{ width: `${Math.min(1, (ln.measured ?? 0) / (ln.todo || run.set_size)) * 100}%` }} /></span>`
          : html`<span class="bt-lanebody__said">${open ? ln.said ?? '…' : 'its reason stays sealed until you lock in'}</span>`}
        ${open && glyph && (fate !== 'none' || ['done', 'error', 'stopped'].includes(ln.status)) && html`<span class=${`bt-lanebody__fate bt-t-${tone}`}>${glyph}</span>`}
      </div>
    </div>
  `
}
