/* Memory Match — two shops, one product each: the same thing or not?
 *
 * The server (games/memory.py) deals the board and has Jev compare every shop
 * A card with every shop B card (one Score over different / related / same,
 * three yes/no companions), and the text models match one A card at a time.
 * You play here, on the page: cards lie face down, you flip one on each side
 * and say what they are; a pair you call stays face up and slides into one
 * row. When you lock in and the round is over, the answers come out and the
 * board can show anyone's matches: yours, Jev's, a text model's, or the truth.
 * Your claims are kept in this browser only (memory.logic.js scores them by
 * the server's own rules).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  GameFrame,
  Label,
  LaneCard,
  LaneNum,
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
import { LEVEL, VERDICT, alignB, bestOf, cardName, cellOf, checks, goldChecks, standings, tally } from './memory.logic.js'

const PAIRS = [4, 6, 8, 10]

export default function MemoryMatch({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [pairs, setPairs] = useState(8)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 2 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="mm-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <label class="g-field"><span>Pairs on the board</span>
            <select class="wr-sel" value=${pairs} onChange=${(e) => setPairs(Number(e.currentTarget.value))}>
              ${PAIRS.map((n) => html`<option key=${n} value=${n}>${n} pairs · Jev compares ${n * n}</option>`)}
            </select>
          </label>
          <${StartButton} onStart=${() => start(lanes, { pairs })} problem=${problem} busy=${busy} error=${error} label="Deal the cards" />
        <//>
        <div class="mm-side">
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Two shops sell overlapping stock and title it their own way. Their listings are dealt face down, shop A on
              the left, shop B on the right. Some cards have a <b>twin</b> across the board (the same product), some a <b>cousin</b> (the same model
              in another colour, size or pack: a curator's call), and some only a look-alike.
            </p>
            <p class="g-explain">
              <b>You</b> flip one card on each side and call it: the same product, related, or not a pair. <b>Jev</b> compares
              every A card with every B card, one Score (different, related, same) and three yes/no checks (brand, model,
              variant) each, and the nearest level decides, with no threshold in code. A <b>text model</b> names a B card
              for each A card; a card that isn't on the board is a foul.
            </p>
            <div class="mm-rules">
              <${Chip} tone="ok">twins merged +2<//><${Chip} tone="ok">cousins to a curator +1<//>
              <${Chip} tone="ok">twins to a curator +1<//><${Chip} tone="warn">cousins merged 0<//>
              <${Chip} tone="err">not a pair −1<//><${Chip}>missed 0<//>
            </div>
          <//>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.params?.pairs ?? ''} pairs</span>`} />
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
  const n = run.cards_a?.length ?? 0
  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">${n} pairs · Jev compares ${n * n}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      ${n ? html`<${Table} key=${run.id} run=${run} />` : html`<p class="g-muted">This round has no board.</p>`}
    <//>
  `
}

/** Your side of the game, kept in this browser for this round only. */
function useMine(runId) {
  const key = `mm:${runId}`
  const [mine, setMine] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (v && Array.isArray(v.claims)) return v
    } catch {
      /* no storage: play without it */
    }
    return { claims: [], done: false, flips: 0 }
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

function Table({ run }) {
  const n = run.cards_a.length
  const [mine, setMine] = useMine(run.id)
  const [selA, setSelA] = useState(null)
  const [selB, setSelB] = useState(null)
  const [view, setView] = useState('you')
  const revealed = mine.done && Array.isArray(run.gold)
  const shown = revealed ? view : 'you'
  const claims = shown === 'you' ? mine.claims : shown === 'gold' ? run.gold : run.lanes[shown]?.claims ?? []
  const rows = alignB(n, claims)
  const rowOf = new Map(rows.map((b, r) => [b, r]))
  const byA = new Map(claims.map((c) => [c.a, c]))
  const judged = revealed ? tally(mine.claims, run.gold) : null
  const judgedOf = revealed
    ? new Map((shown === 'you' ? judged.claims : shown === 'gold' ? [] : run.lanes[shown]?.claims ?? []).map((c) => [c.a, c]))
    : new Map()
  const takenA = new Set(mine.claims.map((c) => c.a))
  const takenB = new Set(mine.claims.map((c) => c.b))
  const jevLane = typeof shown === 'number' && run.lanes[shown]?.kind === 'judgment' ? run.lanes[shown] : null
  const ref = useRef(null)
  useFlip(ref, rows.join(','))

  const flip = (side, i) => {
    if (mine.done) return
    const [sel, setSel, taken] = side === 'a' ? [selA, setSelA, takenA] : [selB, setSelB, takenB]
    if (taken.has(i)) return
    if (sel === i) {
      setSel(null)
      return
    }
    setSel(i)
    setMine({ ...mine, flips: mine.flips + 1 })
  }
  const decide = (level) => {
    if (selA == null || selB == null) return
    if (level > 0) setMine({ ...mine, claims: [...mine.claims, { a: selA, b: selB, level }] })
    setSelA(null)
    setSelB(null)
  }
  const undo = (a) => setMine({ ...mine, claims: mine.claims.filter((c) => c.a !== a) })
  const finish = () => {
    setSelA(null)
    setSelB(null)
    setMine({ ...mine, done: true })
  }

  return html`
    <div class="mm-stage">
      <${Box} class="mm-table">
        <div class="mm-heads">
          <span class="mm-shop">SHOP A · ${run.shops?.a}</span>
          <span class="mm-caption">${revealed ? viewCaption(shown, run) : 'Same product, or not? Flip one card on each side.'}</span>
          <span class="mm-shop mm-shop--b">SHOP B · ${run.shops?.b}</span>
        </div>
        ${!mine.done &&
        html`<div class="mm-decide" role="group" aria-label="Your call on the two cards you flipped">
          <span class="mm-decide__who g-mono">${selA == null && selB == null
            ? 'your turn: flip one card on each side'
            : `${selA == null ? 'A?' : cardName('a', selA)} and ${selB == null ? 'B?' : cardName('b', selB)}`}</span>
          <button type="button" class="mm-decide__b mm-decide__b--ok" disabled=${selA == null || selB == null} onClick=${() => decide(2)}>Same product · merge</button>
          <button type="button" class="mm-decide__b mm-decide__b--warn" disabled=${selA == null || selB == null} onClick=${() => decide(1)}>Related · to a curator</button>
          <button type="button" class="mm-decide__b" disabled=${selA == null || selB == null} onClick=${() => decide(0)}>Not a pair</button>
        </div>`}
        <div class="mm-board" ref=${ref} style=${{ gridTemplateRows: `repeat(${n}, auto)` }}>
          ${run.cards_a.map(
            (text, a) => html`<${Card} key=${`a${a}`} side="a" i=${a} text=${text} row=${a}
              up=${mine.done || takenA.has(a) || selA === a} picked=${selA === a} locked=${mine.done || takenA.has(a)}
              tone=${toneOf(judgedOf.get(a), shown, byA.get(a))} onFlip=${() => flip('a', a)} />`,
          )}
          ${rows.map((b, r) => {
            const claim = byA.get(r)
            const gold = revealed ? run.gold.find((g) => g.a === r) : null
            return html`<div key=${`l${r}`} class="mm-linkcell" style=${{ gridRow: r + 1 }}>
              <${Link} claim=${claim} aligned=${!!claim && claim.b === b} shown=${shown} judged=${judgedOf.get(r)}
                gold=${gold} cell=${jevLane && claim ? cellOf(jevLane.grid, claim.a, claim.b) : null}
                revealed=${revealed} onUndo=${!mine.done && claim ? () => undo(r) : null} />
            </div>`
          })}
          ${run.cards_b.map(
            (text, b) => html`<${Card} key=${`b${b}`} side="b" i=${b} text=${text} row=${rowOf.get(b)}
              up=${mine.done || takenB.has(b) || selB === b} picked=${selB === b} locked=${mine.done || takenB.has(b)}
              tone=${toneOf(judgedOf.get(claims.find((c) => c.b === b)?.a), shown, claims.find((c) => c.b === b))}
              onFlip=${() => flip('b', b)} />`,
          )}
        </div>
        <div class="mm-foot">
          ${!mine.done &&
          html`<span class="g-mono g-muted">${mine.claims.length} called · ${mine.flips} flips</span>
            <span class="spacer" />
            <${Button} variant="primary" size="sm" onClick=${finish}>Lock in my ${mine.claims.length} ${mine.claims.length === 1 ? 'pair' : 'pairs'}<//>`}
          ${mine.done && !revealed && html`<span class="g-mono g-muted">Locked in. Waiting for the others to finish comparing…</span>`}
          ${revealed &&
          html`<div class="mm-views" role="group" aria-label="Whose matches the board shows">
            <button type="button" class=${`mm-view${shown === 'you' ? ' mm-view--on' : ''}`} aria-pressed=${shown === 'you'}
              onClick=${() => setView('you')}>You · ${judged.points}</button>
            ${run.lanes.map(
              (ln) => html`<button type="button" key=${ln.index} class=${`mm-view${shown === ln.index ? ' mm-view--on' : ''}`}
                aria-pressed=${shown === ln.index} onClick=${() => setView(ln.index)}>
                <${LaneNum} i=${ln.index} /> ${ln.label} · ${ln.score ?? '—'}</button>`,
            )}
            <button type="button" class=${`mm-view${shown === 'gold' ? ' mm-view--on' : ''}`} aria-pressed=${shown === 'gold'}
              onClick=${() => setView('gold')}>The answers</button>
          </div>`}
          <span class="spacer" />
          <span class="g-mono g-muted mm-nothr">no threshold in code: the nearest level decides</span>
        </div>
      <//>
      <div class="mm-aside">
        <${Scores} run=${run} mine=${mine} judged=${judged} revealed=${revealed} />
        ${mine.done && run.lanes.filter((l) => l.kind === 'judgment').map((ln) => html`<${Grid} key=${ln.index} lane=${ln} n=${n} gold=${revealed ? run.gold : null} />`)}
      </div>
    </div>
    <div class="g-lanes">
      ${run.lanes.map(
        (ln) => html`<${LaneCard} key=${ln.index} lane=${ln}>
          <div class="mm-lanebody">
            <span class="g-mono">${ln.kind === 'judgment' ? `${ln.done_n ?? 0}/${ln.todo_n ?? n * n} compared` : `${ln.done_n ?? 0}/${ln.todo_n ?? n} cards asked`}</span>
            ${ln.claims && html`<span class="g-mono g-muted">${ln.claims.length} matched</span>`}
            ${ln.kind === 'text' && (ln.said ?? []).filter((s) => s.kind === 'foul').slice(0, 3).map(
              (s) => html`<span key=${s.a} class="g-mono g-t-err">✕ ${cardName('a', s.a)}: ${s.why}</span>`,
            )}
          </div>
        <//>`,
      )}
    </div>
  `
}

function viewCaption(shown, run) {
  if (shown === 'you') return 'Your matches, against the answers'
  if (shown === 'gold') return 'The answers: every dealt pair, twins, cousins and look-alikes'
  const ln = run.lanes[shown]
  return ln?.kind === 'judgment' ? `${ln.label}'s matches: its nearest levels, paired by code` : `${ln?.label}'s matches, as it named them`
}

/** A card's border once the answers are out: how the claim on it fared. */
function toneOf(judged, shown, claim) {
  if (shown === 'gold') return claim ? LEVEL[claim.level]?.tone : undefined
  if (judged) return VERDICT[judged.verdict]?.tone
  return claim ? 'claimed' : undefined
}

/** Moves the cards it marks with `data-flip` from where they were to where
 *  they are now whenever `key` changes, unless the reader asked for less
 *  motion. A candidate for the kit. */
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

/** One listing: a face-down back with its shop's pattern, flipping to its title. */
function Card({ side, i, text, row, up, picked, locked, tone, onFlip }) {
  const name = cardName(side, i)
  const cls = `mm-card mm-card--${side}${up ? ' mm-card--up' : ''}${picked ? ' mm-card--picked' : ''}${tone ? ` mm-card--${tone}` : ''}`
  return html`
    <button type="button" class=${cls} style=${{ gridRow: (row ?? 0) + 1, gridColumn: side === 'a' ? 1 : 3 }}
      data-flip=${side === 'b' ? `b${i}` : undefined} aria-pressed=${picked} aria-disabled=${locked}
      aria-label=${up ? `${name}: ${text}` : `${name}, face down: flip it`} onClick=${onFlip}>
      <span class="mm-card__inner">
        <span class="mm-card__face mm-card__back" aria-hidden="true">
          <span class="mm-card__no g-mono">${name}</span>
          <svg class="mm-card__q" viewBox="0 0 28 28">
            <rect x="3" y="3" width="22" height="22" rx="4" />
            <path d="M10 11 C10 7 18 7 18 11 C18 14 14 14 14 17 M14 21 V21.5" />
          </svg>
        </span>
        <span class="mm-card__face mm-card__front" aria-hidden="true">
          <span class="mm-card__no g-mono">${name}</span>
          <span class="mm-card__text">${text}</span>
        </span>
      </span>
    </button>
  `
}

/** The connector between the cards in one row: the level, the checks, the verdict. */
function Link({ claim, aligned, shown, judged, gold, cell, revealed, onUndo }) {
  if (!claim) {
    if (revealed && shown !== 'gold' && gold?.level > 0)
      return html`<span class="mm-miss g-mono">missed its ${gold.level === 2 ? 'twin' : 'cousin'}, ${cardName('b', gold.b)}</span>`
    return null
  }
  const lv = LEVEL[claim.level] ?? LEVEL[0]
  const v = judged ? VERDICT[judged.verdict] : null
  if (!aligned)
    // Its B card sits in another row: a text model named one card twice.
    return html`<span class="mm-miss g-mono">→ ${cardName('b', claim.b)} · ${lv.word}, a card it named twice</span>
      ${v && html`<span class=${`mm-verdict mm-verdict--${v.tone} g-mono`}>${v.mark} ${v.label}</span>`}`
  const ticks = shown === 'gold' ? goldChecks(gold) : cell ? checks(cell) : []
  return html`
    <div class=${`mm-link mm-link--${lv.tone}`}>
      <span class="mm-link__line" />
      <span class="mm-link__chip">${lv.n} · ${lv.word} · ${lv.act}</span>
      <span class="mm-link__line" />
    </div>
    ${ticks.length > 0 &&
    html`<span class="mm-ticks g-mono">
      ${ticks.map(
        (t) => html`<span key=${t.k} class=${t.yes ? 'mm-tick--yes' : 'mm-tick--no'}>${t.k} ${t.yes ? '✓' : '✕'}</span>`,
      )}
      ${cell && html`<span>score ${cell.score.toFixed(1)}</span>`}
      ${shown === 'gold' && gold?.differs && html`<span>(${gold.differs})</span>`}
    </span>`}
    ${v && html`<span class=${`mm-verdict mm-verdict--${v.tone} g-mono`}>${v.mark} ${v.label}</span>`}
    ${!revealed && !onUndo && html`<span class="g-mono g-muted mm-sub">your call</span>`}
    ${onUndo && html`<button type="button" class="mm-undo g-mono" onClick=${onUndo}>take back</button>`}
  `
}

/** Everyone's score once the answers are out; progress until then. */
function Scores({ run, mine, judged, revealed }) {
  const best = revealed ? bestOf(run.gold) : null
  const entries = [
    { key: 'you', who: 'You', lane: null, points: revealed ? judged.points : null, right: judged?.right, wrong: judged?.wrong, missed: judged?.missed },
    ...run.lanes.map((ln) => ({ key: `l${ln.index}`, who: ln.label, lane: ln.index, points: ln.score, right: ln.right, wrong: ln.wrong, missed: ln.missed, ln })),
  ]
  const rows = revealed ? standings(entries) : entries
  return html`
    <${Box} class="mm-scores">
      <${Label} note=${revealed ? `best possible ${best}` : null}>${revealed ? 'THE SCORES' : 'AT THE TABLE'}<//>
      <ol class="mm-scores__list">
        ${rows.map(
          (e) => html`<li key=${e.key} class=${`mm-score${revealed && e.place === 1 ? ' mm-score--top' : ''}`}>
            ${e.lane == null ? html`<span class="mm-score__you" aria-hidden="true" />` : html`<${LaneNum} i=${e.lane} />`}
            <span class="mm-score__who">${e.who}</span>
            <span class="mm-score__line g-mono g-muted">${revealed
              ? `${e.right ?? 0} right · ${e.wrong ?? 0} wrong · ${e.missed ?? 0} missed`
              : e.lane == null
                ? mine.done ? 'locked in' : `${mine.claims.length} called`
                : e.ln.claims ? `${e.ln.claims.length} matched · hidden until you lock in` : `${e.ln.done_n ?? 0}/${e.ln.todo_n ?? '?'}`}</span>
            <span class="mm-score__pts tnum">${revealed ? e.points ?? '—' : ''}</span>
          </li>`,
        )}
      </ol>
      ${revealed && html`<p class="g-mono g-muted mm-scores__rule">twins merged +2 · cousins to a curator +1 · not a pair −1</p>`}
    <//>
  `
}

/* Jev's whole grid: every A card against every B card, shaded by its score
 * (0 different … 2 same), a dot where code paired them, and once the answers
 * are out a ring round every real pair. */
function Grid({ lane, n, gold }) {
  const C = 30
  const P = 26
  const size = P + n * C
  const grid = lane.grid ?? []
  const paired = new Set((lane.claims ?? []).map((c) => `${c.a}:${c.b}`))
  return html`
    <${Box} lane=${lane.index} class="mm-grid">
      <${Label} note=${`${grid.length}/${n * n}`}>${`${lane.label.toUpperCase()}'S GRID`}<//>
      <svg class=${`mm-grid__svg g-l${(lane.index % 4) + 1}`} viewBox=${`0 0 ${size + 2} ${size + 2}`} role="img"
        aria-label=${`${lane.label} compared every shop A card with every shop B card: the darker a square, the closer to the same product; a dot marks each pair code made`}>
        ${[...Array(n).keys()].map(
          (k) => html`<g key=${`h${k}`}>
            <text class="mm-grid__k" x=${P + k * C + C / 2} y="16">${cardName('b', k)}</text>
            <text class="mm-grid__k" x="12" y=${P + k * C + C / 2 + 4}>${cardName('a', k)}</text>
          </g>`,
        )}
        ${grid.map(
          (c) => html`<rect key=${`${c.a}:${c.b}`} class="mm-grid__cell" x=${P + c.b * C + 1} y=${P + c.a * C + 1}
            width=${C - 2} height=${C - 2} style=${{ fillOpacity: 0.08 + 0.92 * Math.max(0, Math.min(1, c.score / 2)) }}>
            <title>${`${cardName('a', c.a)} × ${cardName('b', c.b)}: score ${c.score.toFixed(2)}`}</title>
          </rect>`,
        )}
        ${grid.filter((c) => paired.has(`${c.a}:${c.b}`)).map(
          (c) => html`<circle key=${`d${c.a}:${c.b}`} class="mm-grid__dot" cx=${P + c.b * C + C / 2} cy=${P + c.a * C + C / 2} r="4.5" />`,
        )}
        ${(gold ?? []).filter((g) => g.level > 0).map(
          (g) => html`<rect key=${`g${g.a}`} class=${`mm-grid__gold mm-grid__gold--${g.level}`} x=${P + g.b * C} y=${P + g.a * C} width=${C} height=${C} />`,
        )}
      </svg>
      <p class="g-mono g-muted mm-grid__key">darker: closer to the same product · dot: paired by code${gold ? ' · ring: a real pair (solid twin, dashed cousin)' : ''}</p>
    <//>
  `
}
