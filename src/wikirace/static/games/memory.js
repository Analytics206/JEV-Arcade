/* Memory Match — two shops, one product each: the same thing or not?
 *
 * The server (games/memory.py) deals the board and has Jev compare every shop
 * A card with every shop B card (one Score over different / related / same,
 * three yes/no companions), and the text models match one A card at a time.
 * You play here, on the page: cards lie face down on the table, you flip one
 * on each side and say what they are; a pair you call stays face up, slides
 * into one row and is joined by a lit beam (= same, ≈ close). While you play,
 * the others' progress shows without their answers: Jev's grid of comparisons
 * lighting up, the text models' cards asked. When you lock in and the round is
 * over, the answers come out: every call is judged row by row, the scores count
 * up, and the board can show anyone's matches: yours, Jev's, a text model's,
 * or the truth. Your claims are kept in this browser only (memory.logic.js
 * scores them by the server's own rules).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import {
  Box,
  Chip,
  Counter,
  GameFrame,
  LANE_COLORS,
  Label,
  LaneCard,
  LaneNum,
  NEON,
  PixelText,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  againOf,
  html,
  sfx,
  useModels,
  useNow,
  useRun,
  useStarter,
} from './kit.js'
import { Button } from '../ui.js'
import { Finale } from '../fx.js'
import { defaultPlayers, isRunLive, playersProblem } from './runstate.js'
import {
  LEVEL,
  LEVEL_MARK,
  VERDICT,
  alignB,
  bestOf,
  cardName,
  cellOf,
  checks,
  goldChecks,
  goldOf,
  perfectBoard,
  perfectClaim,
  podium,
  standings,
  tally,
} from './memory.logic.js'

const PAIRS = [4, 6, 8, 10]
/** The setup's sample table: made-up listings, one of each kind of pair. */
const DEMO = [
  { a: 'Kestrel K2 kettle, 1.7 L, steel', b: 'KESTREL K-2 Electric Kettle 1.7L Stainless', level: 2, say: 'twins: merge them' },
  { a: 'Pollux 40 backpack, slate', b: 'POLLUX 40L Daypack, Forest Green', level: 1, say: 'cousins: a curator decides' },
  { a: 'Nimbo 5 desk lamp, white', b: 'NIMBO 6 LED Desk Lamp (White)', level: 0, say: 'look-alikes: leave them' },
]

export default function MemoryMatch({ game, runId }) {
  return runId ? html`<${Live} key=${runId} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
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
          <${Box} class="mm-how">
            <${Label}>HOW IT'S PLAYED<//>
            <p class="g-explain">
              Two shops sell overlapping stock and title it their own way. Their listings are dealt face down, shop A on
              the left, shop B on the right. Some cards have a <b>twin</b> across the board (the same product), some a <b>cousin</b> (the same model
              in another colour, size or pack: a curator's call), and some only a look-alike.
            </p>
            <${Demo} />
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

/** A small table dealing itself: three pairs flip over and are joined, one of
 *  each kind. Decoration beside the words, which say the same. */
function Demo() {
  return html`
    <div class="mm-demo" aria-hidden="true">
      ${DEMO.map((d, k) => {
        const lv = LEVEL[d.level]
        return html`
          <div key=${k} class=${`mm-demo__row mm-t-${lv.tone}`} style=${{ '--d': `${k * 0.45}s` }}>
            <span class="mm-demo__card mm-demo__card--a">
              <span class="mm-demo__in">
                <span class="mm-demo__face mm-demo__back"><${PixelText} text=${`A${k + 1}`} /></span>
                <span class="mm-demo__face mm-demo__front">${d.a}</span>
              </span>
            </span>
            <span class="mm-demo__link">
              <span class="mm-demo__wire"><span class="mm-demo__beam" /><span class="mm-demo__chip">${LEVEL_MARK[d.level]} ${lv.word}</span></span>
              <span class="mm-demo__say">${d.say}</span>
            </span>
            <span class="mm-demo__card mm-demo__card--b">
              <span class="mm-demo__in">
                <span class="mm-demo__face mm-demo__back"><${PixelText} text=${`B${k + 1}`} /></span>
                <span class="mm-demo__face mm-demo__front">${d.b}</span>
              </span>
            </span>
          </div>
        `
      })}
    </div>
  `
}

/* ── A round ───────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const live = isRunLive(run)
  const now = useNow(live)
  const [mine, setMine] = useMine(runId)
  const revealed = !!run && mine.done && Array.isArray(run.gold)
  const fin = run ? finaleOf(run, mine, revealed) : {}
  // The reveal when you lock in after the round is over (a round that ends in
  // front of you has the run bar's own finale).
  const [late, setLate] = useState(false)
  const was = useRef(null)
  useEffect(() => {
    if (!run) return
    if (was.current && revealed && !was.current.revealed && !was.current.live) setLate(true)
    was.current = { revealed, live }
  }, [!!run, revealed, live])
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`
  const n = run.cards_a?.length ?? 0
  return html`
    <${GameFrame} game=${game} class="mm-page">
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub} win=${!fin.quiet} winLabel=${fin.winLabel}>
        <span class="g-mono g-muted">${n} pairs · Jev compares ${n * n}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      ${n ? html`<${Table} run=${run} mine=${mine} setMine=${setMine} revealed=${revealed} />` : html`<p class="g-muted">This round has no board.</p>`}
    <//>
    <${Finale} show=${late} headline=${fin.headline} sub=${fin.sub} colors=${fin.colors} win=${!fin.quiet} onClose=${() => setLate(false)} />
  `
}

/**
 * Who the finale names, by the game's own rule (the most points), with you in
 * it: your claims are scored on the page exactly as the server scores the
 * lanes. Until you lock in the scores stay hidden, so it names nobody. The
 * run bar's pill names lanes only, so a round you won or shared shows none.
 */
function finaleOf(run, mine, revealed) {
  if (!revealed) return { headline: 'YOUR MOVE', sub: 'The players have made their matches. Lock in yours to see who won.', quiet: true }
  const best = bestOf(run.gold)
  const you = { key: 'you', who: 'You', points: tally(mine.claims, run.gold).points }
  const lanes = run.lanes.map((ln) => ({ key: `l${ln.index}`, who: ln.label, lane: ln.index, points: ln.score }))
  const top = podium([you, ...lanes])
  if (!top.length) return { headline: 'GAME OVER' }
  const pts = top[0].points
  const won = top.filter((e) => e.lane != null)
  const colors = won.length ? won.map((e) => LANE_COLORS[e.lane % 4]) : NEON
  const tail = `${pts} ${Math.abs(pts) === 1 ? 'point' : 'points'} of ${best}${pts === best && best > 0 ? ' · a perfect board' : ''}`
  if (top.some((e) => e.key === 'you')) {
    if (!won.length) return { winners: [], headline: 'YOU WIN!', sub: tail, colors: NEON, winLabel: 'You' }
    return { winners: [], headline: 'TIE GAME!', sub: `You · ${won.map((e) => e.who).join(' · ')} · ${tail}`, colors, winLabel: `You · ${won.map((e) => e.who).join(' · ')}` }
  }
  if (won.length === 1) return { winners: [won[0].lane], headline: `PLAYER ${won[0].lane + 1} WINS!`, sub: `${won[0].who} · ${tail}`, colors }
  return { winners: won.map((e) => e.lane), headline: 'TIE GAME!', sub: `${won.map((e) => e.who).join(' · ')} · ${tail}`, colors }
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

function Table({ run, mine, setMine, revealed }) {
  const n = run.cards_a.length
  const [selA, setSelA] = useState(null)
  const [selB, setSelB] = useState(null)
  const [view, setView] = useState('you')
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
  const ready = selA != null && selB != null

  const flip = (side, i) => {
    if (mine.done) return
    const [sel, setSel, taken] = side === 'a' ? [selA, setSelA, takenA] : [selB, setSelB, takenB]
    if (taken.has(i)) return
    if (sel === i) {
      sfx.hover()
      setSel(null)
      return
    }
    sfx.select()
    setSel(i)
    setMine({ ...mine, flips: mine.flips + 1 })
  }
  const decide = (level) => {
    if (selA == null || selB == null) return
    if (level > 0) {
      sfx.coin()
      setMine({ ...mine, claims: [...mine.claims, { a: selA, b: selB, level }] })
    } else sfx.hover()
    setSelA(null)
    setSelB(null)
  }
  const undo = (a) => {
    sfx.down()
    setMine({ ...mine, claims: mine.claims.filter((c) => c.a !== a) })
  }
  const finish = () => {
    sfx.start()
    setSelA(null)
    setSelB(null)
    setMine({ ...mine, done: true })
  }
  const pick = (v) => {
    sfx.select()
    setView(v)
  }

  return html`
    <div class="mm-stage">
      <${Box} class="mm-table">
        <div class="mm-heads">
          <span class="mm-shop mm-shop--a"><span class="mm-shop__badge" aria-hidden="true">A</span><span class="mm-shop__k">SHOP A</span> <b>${run.shops?.a}</b></span>
          <span class="mm-caption">${revealed ? viewCaption(shown, run) : 'Same product, or not? Flip one card on each side.'}</span>
          <span class="mm-shop mm-shop--b"><b>${run.shops?.b}</b> <span class="mm-shop__k">SHOP B</span><span class="mm-shop__badge" aria-hidden="true">B</span></span>
        </div>
        ${!mine.done &&
        html`<div class=${`mm-decide${ready ? ' mm-decide--ready' : ''}`} role="group" aria-label="Your call on the two cards you flipped">
          <span class="mm-decide__who">
            ${selA == null && selB == null
              ? html`<span class="g-mono g-muted">your turn: flip one card on each side</span>`
              : html`<span class=${`mm-pick mm-pick--a${selA == null ? ' mm-pick--empty' : ''}`}>${selA == null ? 'A?' : cardName('a', selA)}</span><span class="mm-pick__and" aria-hidden="true">+</span><span class=${`mm-pick mm-pick--b${selB == null ? ' mm-pick--empty' : ''}`}>${selB == null ? 'B?' : cardName('b', selB)}</span>`}
          </span>
          <button type="button" class="mm-decide__b mm-decide__b--ok" disabled=${!ready} onClick=${() => decide(2)}><span aria-hidden="true">=</span> Same product · merge</button>
          <button type="button" class="mm-decide__b mm-decide__b--warn" disabled=${!ready} onClick=${() => decide(1)}><span aria-hidden="true">≈</span> Related · to a curator</button>
          <button type="button" class="mm-decide__b mm-decide__b--no" disabled=${!ready} onClick=${() => decide(0)}><span aria-hidden="true">≠</span> Not a pair</button>
        </div>`}
        <div class=${`mm-board${mine.done ? ' mm-board--done' : ''}`} ref=${ref} style=${{ gridTemplateRows: `repeat(${n}, auto)` }}>
          ${run.cards_a.map((text, a) => {
            const f = faceOf(judgedOf.get(a), shown, byA.get(a))
            return html`<${Card} key=${`a${a}`} side="a" i=${a} text=${text} row=${a}
              up=${mine.done || takenA.has(a) || selA === a} picked=${selA === a} locked=${mine.done || takenA.has(a)}
              tone=${f.tone} mark=${f.mark} onFlip=${() => flip('a', a)} />`
          })}
          ${rows.map((b, r) => {
            const claim = byA.get(r)
            const gold = revealed ? run.gold.find((g) => g.a === r) : null
            return html`<div key=${`l${r}`} class="mm-linkcell" style=${{ gridRow: r + 1 }}>
              <${Link} claim=${claim} aligned=${!!claim && claim.b === b} shown=${shown} judged=${judgedOf.get(r)} row=${r}
                truth=${revealed && shown !== 'gold' && claim ? goldOf(run.gold, claim.a, claim.b) : null}
                gold=${gold} cell=${jevLane && claim ? cellOf(jevLane.grid, claim.a, claim.b) : null}
                revealed=${revealed} onUndo=${!mine.done && claim ? () => undo(r) : null} />
            </div>`
          })}
          ${run.cards_b.map((text, b) => {
            const claim = claims.find((c) => c.b === b)
            const f = faceOf(judgedOf.get(claim?.a), shown, claim)
            return html`<${Card} key=${`b${b}`} side="b" i=${b} text=${text} row=${rowOf.get(b)}
              up=${mine.done || takenB.has(b) || selB === b} picked=${selB === b} locked=${mine.done || takenB.has(b)}
              tone=${f.tone} mark=${f.mark} onFlip=${() => flip('b', b)} />`
          })}
        </div>
        <div class="mm-foot">
          ${!mine.done &&
          html`<span class="mm-tally g-mono"><b>${mine.claims.length}</b> called · <b>${mine.flips}</b> flips</span>
            <span class="spacer" />
            <${Button} variant="primary" size="sm" onClick=${finish}>Lock in my ${mine.claims.length} ${mine.claims.length === 1 ? 'pair' : 'pairs'}<//>`}
          ${mine.done && !revealed && html`<span class="mm-wait g-mono"><span class="mm-wait__dot" aria-hidden="true" />Locked in. Waiting for the others to finish comparing…</span>`}
          ${revealed &&
          html`<div class="mm-views" role="group" aria-label="Whose matches the board shows">
            <button type="button" class=${`mm-view mm-view--you${shown === 'you' ? ' mm-view--on' : ''}`} aria-pressed=${shown === 'you'}
              onClick=${() => pick('you')}>You · ${judged.points}</button>
            ${run.lanes.map(
              (ln) => html`<button type="button" key=${ln.index} class=${`mm-view g-l${(ln.index % 4) + 1}${shown === ln.index ? ' mm-view--on' : ''}`}
                aria-pressed=${shown === ln.index} onClick=${() => pick(ln.index)}>
                <${LaneNum} i=${ln.index} /> ${ln.label} · ${ln.score ?? '—'}</button>`,
            )}
            <button type="button" class=${`mm-view mm-view--gold${shown === 'gold' ? ' mm-view--on' : ''}`} aria-pressed=${shown === 'gold'}
              onClick=${() => pick('gold')}>The answers</button>
          </div>`}
          <span class="spacer" />
          <span class="g-mono g-muted mm-nothr">no threshold in code: the nearest level decides</span>
        </div>
      <//>
      <div class="mm-aside">
        <${Scores} run=${run} mine=${mine} judged=${judged} revealed=${revealed} n=${n} />
        ${mine.done && run.lanes.filter((l) => l.kind === 'judgment').map((ln) => html`<${Grid} key=${ln.index} lane=${ln} n=${n} gold=${revealed ? run.gold : null} />`)}
      </div>
    </div>
    <div class="g-lanes">
      ${run.lanes.map((ln) => {
        const todo = ln.todo_n ?? (ln.kind === 'judgment' ? n * n : n)
        const done = ln.done_n ?? 0
        return html`<${LaneCard} key=${ln.index} lane=${ln}>
          <div class="mm-lanebody">
            <span class="mm-prog" aria-hidden="true"><span class="mm-prog__fill" style=${{ width: `${todo ? (100 * done) / todo : 0}%` }} /></span>
            <span class="g-mono">${ln.kind === 'judgment' ? `${done}/${todo} compared` : `${done}/${todo} cards asked`}</span>
            ${ln.claims && html`<span class="g-mono g-muted">${ln.claims.length} matched</span>`}
            ${ln.kind === 'text' && (ln.said ?? []).filter((s) => s.kind === 'foul').slice(0, 3).map(
              (s) => html`<span key=${s.a} class="g-mono g-t-err">✕ ${cardName('a', s.a)}: ${s.why}</span>`,
            )}
          </div>
        <//>`
      })}
    </div>
  `
}

function viewCaption(shown, run) {
  if (shown === 'you') return 'Your matches, against the answers'
  if (shown === 'gold') return 'The answers: every dealt pair, twins, cousins and look-alikes'
  const ln = run.lanes[shown]
  return ln?.kind === 'judgment' ? `${ln.label}'s matches: its nearest levels, paired by code` : `${ln?.label}'s matches, as it named them`
}

/** A card's face once the answers are out: how the claim on it fared, as a
 *  tone and a glyph (the answers themselves wear the level's glyph). */
function faceOf(judged, shown, claim) {
  if (shown === 'gold') return claim ? { tone: LEVEL[claim.level]?.tone, mark: LEVEL_MARK[claim.level] } : {}
  if (judged) {
    const v = VERDICT[judged.verdict]
    return v ? { tone: v.tone, mark: v.mark } : {}
  }
  return claim ? { tone: 'claimed' } : {}
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

/** One listing: a face-down back with its shop's pattern and its name in
 *  lights, flipping over to its title. */
function Card({ side, i, text, row, up, picked, locked, tone, mark, onFlip }) {
  const name = cardName(side, i)
  const cls =
    `mm-card mm-card--${side}${up ? ' mm-card--up' : ''}${picked ? ' mm-card--picked' : ''}` +
    `${locked ? ' mm-card--locked' : ''}${tone ? ` mm-card--${tone}` : ''}`
  return html`
    <button type="button" class=${cls} style=${{ gridRow: (row ?? 0) + 1, gridColumn: side === 'a' ? 1 : 3 }}
      data-flip=${side === 'b' ? `b${i}` : undefined} aria-pressed=${picked} aria-disabled=${locked}
      aria-label=${up ? `${name}: ${text}` : `${name}, face down: flip it`} onClick=${onFlip}>
      <span class="mm-card__inner">
        <span class="mm-card__face mm-card__back" aria-hidden="true">
          <span class="mm-card__emblem"><${PixelText} text=${name} /></span>
          <span class="mm-card__shop g-mono">SHOP ${side.toUpperCase()}</span>
        </span>
        <span class="mm-card__face mm-card__front" aria-hidden="true">
          <span class="mm-card__no g-mono">${name}</span>
          <span class="mm-card__text">${text}</span>
          ${mark && html`<span key=${mark} class="mm-card__mark">${mark}</span>`}
        </span>
      </span>
    </button>
  `
}

/** What a beam's colour says once the answers are out: what the two cards
 *  really are (green the same product, amber a close variant, red not the same). */
const TRUTH_TONE = ['err', 'warn', 'ok']

/** The beam between the cards in one row: what was called on its chip, the
 *  checks, the verdict. Until the answers are out the beam wears the call's
 *  colour; after, the truth's (`truth`, the pair's real level). */
function Link({ claim, aligned, shown, judged, gold, cell, revealed, onUndo, row, truth }) {
  const delay = { animationDelay: `${Math.min(row, 12) * 70}ms` }
  if (!claim) {
    if (revealed && shown !== 'gold' && gold?.level > 0)
      return html`<div class="mm-ghost" style=${delay}>
        <span class="mm-ghost__line" /><span class="mm-miss g-mono">missed its ${gold.level === 2 ? 'twin' : 'cousin'}, ${cardName('b', gold.b)}</span><span class="mm-ghost__line" />
      </div>`
    return null
  }
  const lv = LEVEL[claim.level] ?? LEVEL[0]
  const v = judged ? VERDICT[judged.verdict] : null
  const perfect = !!judged && perfectClaim(judged.verdict)
  if (!aligned)
    // Its B card sits in another row: a text model named one card twice.
    return html`<span class="mm-miss g-mono">→ ${cardName('b', claim.b)} · ${lv.word}, a card it named twice</span>
      ${v && html`<span class=${`mm-verdict mm-verdict--${v.tone} g-mono`} style=${delay}>${v.mark} ${v.label}</span>`}`
  const ticks = shown === 'gold' ? goldChecks(gold) : cell ? checks(cell) : []
  const tone = Number.isInteger(truth) ? TRUTH_TONE[truth] : lv.tone
  return html`
    <div key=${`${claim.a}:${claim.b}`} class=${`mm-link mm-link--${tone}${perfect ? ' mm-link--perfect' : ''}`}
      title=${Number.isInteger(truth) ? `called ${lv.word.toLowerCase()}; really ${['not the same product', 'a close variant', 'the same product'][truth]}` : undefined}>
      <span class="mm-link__line mm-link__line--a" />
      <span class=${`mm-link__chip mm-t-${lv.tone}`}>${LEVEL_MARK[lv.n]} ${lv.word}<small> · ${lv.act}</small></span>
      <span class="mm-link__line mm-link__line--b" />
    </div>
    ${ticks.length > 0 &&
    html`<span class="mm-ticks g-mono">
      ${ticks.map(
        (t) => html`<span key=${t.k} class=${t.yes ? 'mm-tick--yes' : 'mm-tick--no'}>${t.k} ${t.yes ? '✓' : '✕'}</span>`,
      )}
      ${cell && html`<span>score ${cell.score.toFixed(1)}</span>`}
      ${shown === 'gold' && gold?.differs && html`<span>(${gold.differs})</span>`}
    </span>`}
    ${v && html`<span key=${`v${judged.verdict}`} class=${`mm-verdict mm-verdict--${v.tone} g-mono`} style=${delay}>${v.mark} ${v.label}${perfect ? html` <b class="mm-perfect">★ PERFECT</b>` : ''}</span>`}
    ${!revealed && !onUndo && html`<span class="g-mono g-muted mm-sub">your call</span>`}
    ${onUndo && html`<button type="button" class="mm-undo g-mono" onClick=${onUndo}>take back</button>`}
  `
}

/** Everyone at the table: progress while the round is on (never the answers),
 *  then the scores, counting up, best first. */
function Scores({ run, mine, judged, revealed, n }) {
  const best = revealed ? bestOf(run.gold) : null
  const entries = [
    { key: 'you', who: 'You', lane: null, points: revealed ? judged.points : null, right: judged?.right, wrong: judged?.wrong, missed: judged?.missed },
    ...run.lanes.map((ln) => ({ key: `l${ln.index}`, who: ln.label, lane: ln.index, points: ln.score, right: ln.right, wrong: ln.wrong, missed: ln.missed, ln })),
  ]
  const rows = revealed ? standings(entries) : entries
  const [roll, setRoll] = useState(false)
  useEffect(() => {
    if (!revealed) return
    const t = setTimeout(() => setRoll(true), 250)
    return () => clearTimeout(t)
  }, [revealed])
  const perfect = revealed && perfectBoard(judged.points, run.gold)
  return html`
    <${Box} class=${`mm-scores${revealed ? ' mm-scores--out' : ''}`}>
      <${Label} note=${revealed ? `best possible ${best}` : null}>${revealed ? 'THE SCORES' : 'AT THE TABLE'}<//>
      ${!revealed && html`<p class="mm-scores__hint">Everyone's matches and scores stay hidden until you lock in yours.</p>`}
      ${perfect && html`<div class="mm-perfectbar"><${PixelText} text="PERFECT MATCH!" label="Perfect match: your board scored the best it allows" /></div>`}
      <ol class="mm-scores__list">
        ${rows.map(
          (e) => html`<li key=${e.key} class=${`mm-score${e.lane == null ? ' mm-score--you' : ` g-l${(e.lane % 4) + 1}`}${revealed && e.place === 1 ? ' mm-score--top' : ''}`}>
            <div class="mm-score__hd">
              ${revealed && html`<span class="mm-score__place"><span aria-hidden="true">${e.place === 1 ? '★' : e.place}</span><span class="sr-only">${`place ${e.place}:`}</span></span>`}
              ${e.lane == null ? html`<span class="mm-score__you">YOU</span>` : html`<${LaneNum} i=${e.lane} />`}
              <span class="mm-score__who">${e.who}</span>
              <span class="spacer" />
              ${revealed && html`<span class="mm-score__pts">${Number.isFinite(e.points) ? html`<${Counter} value=${roll ? e.points : 0} class="g-score mm-score__n" />` : '—'}</span>`}
            </div>
            <span class="mm-score__line g-mono g-muted">${revealed
              ? `${e.right ?? 0} right · ${e.wrong ?? 0} wrong · ${e.missed ?? 0} missed`
              : e.lane == null
                ? mine.done ? 'locked in' : `${mine.claims.length} of ${n} called`
                : e.ln.claims ? `${e.ln.claims.length} matched · hidden` : `${e.ln.done_n ?? 0}/${e.ln.todo_n ?? '?'} ${e.ln.kind === 'judgment' ? 'compared' : 'asked'}`}</span>
            ${!revealed && html`<${Progress} e=${e} mine=${mine} n=${n} />`}
          </li>`,
        )}
      </ol>
      ${revealed && html`<p class="g-mono g-muted mm-scores__rule">twins merged +2 · cousins to a curator +1 · not a pair −1</p>`}
    <//>
  `
}

/** How far a player has got, without a hint of its answers: Jev's grid of
 *  comparisons lighting up, the cards a text model has been asked, yours called. */
function Progress({ e, mine, n }) {
  if (e.lane == null) return html`<${Pips} n=${n} lit=${mine.claims.length} label=${`${mine.claims.length} of ${n} pairs called`} />`
  const ln = e.ln
  if (ln.kind === 'judgment') return html`<${MiniGrid} lane=${ln} n=${n} />`
  const said = ln.said ?? []
  const asked = new Set(said.map((s) => s.a))
  const bad = new Set(said.filter((s) => s.kind === 'foul').map((s) => s.a))
  return html`<${Pips} n=${n} asked=${asked} bad=${bad} label=${`${asked.size} of ${n} cards asked${bad.size ? `, ${bad.size} fouls` : ''}`} />`
}

function Pips({ n, lit, asked, bad, label }) {
  return html`
    <span class="mm-pips" role="img" aria-label=${label}>
      ${[...Array(n).keys()].map((k) => {
        const on = asked ? asked.has(k) : k < lit
        const foul = bad?.has(k)
        return html`<span key=${k} class=${`mm-pip${foul ? ' mm-pip--bad' : on ? ' mm-pip--on' : ''}`}>${foul ? '✕' : ''}</span>`
      })}
    </span>
  `
}

/** Jev's comparisons as they land, one lit cell each: which are done, not what they said. */
function MiniGrid({ lane, n }) {
  const C = 10
  const grid = lane.grid ?? []
  const id = `mmp${lane.index}`
  return html`
    <svg class=${`mm-mini g-l${(lane.index % 4) + 1}`} viewBox=${`0 0 ${n * C} ${n * C}`} role="img"
      aria-label=${`${grid.length} of ${n * n} comparisons made`}>
      <defs>
        <pattern id=${id} width=${C} height=${C} patternUnits="userSpaceOnUse">
          <rect x="1" y="1" width=${C - 2} height=${C - 2} rx="1.5" class="mm-mini__off" />
        </pattern>
      </defs>
      <rect width=${n * C} height=${n * C} fill=${`url(#${id})`} />
      ${grid.map((c) => html`<rect key=${`${c.a}:${c.b}`} x=${c.b * C + 1} y=${c.a * C + 1} width=${C - 2} height=${C - 2} rx="1.5" class="mm-mini__on" />`)}
    </svg>
  `
}

/* Jev's whole grid: every A card against every B card, lit by its score
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
        aria-label=${`${lane.label} compared every shop A card with every shop B card: the brighter a square, the closer to the same product; a dot marks each pair code made`}>
        <rect x=${P - 3} y=${P - 3} width=${n * C + 6} height=${n * C + 6} rx="7" class="mm-grid__bg" />
        ${[...Array(n).keys()].map(
          (k) => html`<g key=${`h${k}`}>
            <text class="mm-grid__k mm-grid__k--b" x=${P + k * C + C / 2} y="16">${cardName('b', k)}</text>
            <text class="mm-grid__k mm-grid__k--a" x="12" y=${P + k * C + C / 2 + 4}>${cardName('a', k)}</text>
          </g>`,
        )}
        ${grid.map(
          (c) => html`<rect key=${`${c.a}:${c.b}`} class=${`mm-grid__cell${c.level >= 1 ? ' mm-grid__cell--hot' : ''}`} x=${P + c.b * C + 1.5} y=${P + c.a * C + 1.5}
            width=${C - 3} height=${C - 3} rx="4"
            style=${{ fillOpacity: 0.08 + 0.92 * Math.max(0, Math.min(1, c.score / 2)), animationDelay: `${(c.a + c.b) * 22}ms` }}>
            <title>${`${cardName('a', c.a)} × ${cardName('b', c.b)}: score ${c.score.toFixed(2)}`}</title>
          </rect>`,
        )}
        ${grid.filter((c) => paired.has(`${c.a}:${c.b}`)).map(
          (c) => html`<circle key=${`d${c.a}:${c.b}`} class="mm-grid__dot" cx=${P + c.b * C + C / 2} cy=${P + c.a * C + C / 2} r="5" />`,
        )}
        ${(gold ?? []).filter((g) => g.level > 0).map(
          (g) => html`<rect key=${`g${g.a}`} class=${`mm-grid__gold mm-grid__gold--${g.level}`} x=${P + g.b * C} y=${P + g.a * C} width=${C} height=${C} rx="5" />`,
        )}
      </svg>
      <p class="g-mono g-muted mm-grid__key">brighter: closer to the same product · dot: paired by code${gold ? ' · ring: a real pair (solid twin, dashed cousin)' : ''}</p>
    <//>
  `
}
