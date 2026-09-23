/* WikiGuessr — where on Earth is this article? Say only as much as you're sure of.
 *
 * TypeSafe's hierarchical classification with confidence rollup. The server
 * (games/wikiguessr.py) deals a Wikipedia article with every place name blacked
 * out, asks every lane, and reveals the answer once all have claimed. This
 * page is the map room: the redacted article as a classified dossier; Jev's
 * continent beam; a lit tile map of the countries by Jev's belief, a ring for
 * each lane's claim and a pin that drops on the answer; the regions against
 * the stop line; each lane's claim as a ladder (continent → country → region)
 * whose tiers lock in, then pay out or bust; the scoreboard.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { SCENES } from './attract.js'
import {
  Bars,
  Box,
  Counter,
  GameFrame,
  LANE_COLORS,
  Label,
  LaneHead,
  LaneNum,
  LaneStats,
  Meter,
  PixelText,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  Stat,
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
  MAP_PAD,
  POINTS,
  articleRuns,
  bullseye,
  claimText,
  claimsFor,
  continentLayout,
  focusContinent,
  inkOn,
  mapSummary,
  pinPath,
  resultFor,
  ringRect,
  scoreboard,
  stackSegments,
  tileAlpha,
  tiersOf,
  verdict,
  winnersOf,
} from './wikiguessr.logic.js'

const ROUNDS = [1, 2, 3, 4, 5]
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')
const tone = (n) => (n > 0 ? 'g-t-ok' : n < 0 ? 'g-t-err' : '')
/** A whole number as the scoreboard writes it (Counter adds its own sign to the change). */
const num = (x) => {
  const r = Math.round(x)
  return r < 0 ? `−${-r}` : String(r)
}
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function WikiGuessr({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
}

/** Calls `onFresh(added)` when keys appear that were not there before: what
 *  just happened in front of you, never what a replay opened with. */
function useOnFresh(keys, onFresh, ready = true) {
  const seen = useRef(null)
  const sig = keys.join('|')
  useEffect(() => {
    if (!ready) return
    const prev = seen.current
    seen.current = new Set(keys)
    if (!prev) return
    const added = keys.filter((k) => !prev.has(k))
    if (added.length) onFresh(added)
  }, [sig, ready])
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function Setup({ game }) {
  const models = useModels()
  const [lanes, setLanes] = useState([])
  const [rounds, setRounds] = useState(3)
  const [threshold, setThreshold] = useState(0.5)
  const { busy, error, start } = useStarter(game.id)
  useEffect(() => {
    if (models.data && !lanes.length) setLanes(defaultPlayers(models.data.models, { count: 3 }))
  }, [models.data])
  const problem = models.error ? models.error.message : playersProblem(lanes, game, models.data?.models)
  const go = () => start(lanes, { rounds, threshold })

  return html`
    <${GameFrame} game=${game}>
      <div class="g-setup">
        <${Box} class="wg-setup">
          <${PlayerPicker} info=${models.data} value=${lanes} onChange=${setLanes} max=${game.lanes.max} />
          <div class="wg-params">
            <label class="g-field"><span>Rounds</span>
              <select class="wr-sel" value=${rounds} onChange=${(e) => setRounds(Number(e.currentTarget.value))}>
                ${ROUNDS.map((n) => html`<option key=${n} value=${n}>${n} ${n === 1 ? 'article' : 'articles'}</option>`)}
              </select>
            </label>
            <label class="g-field wg-thr"><span>Jev stops under</span>
              <input type="range" min="0.2" max="0.9" step="0.05" value=${threshold}
                onInput=${(e) => setThreshold(Number(e.currentTarget.value))} aria-label="Confidence threshold" />
              <b class="tnum">${threshold.toFixed(2)}</b>
            </label>
          </div>
          <${StartButton} onStart=${go} problem=${problem} busy=${busy} error=${error} label="Deal the articles" />
        <//>
        <div class="wg-side">
          <${Box} class="wg-howto">
            <${Label}>HOW IT'S PLAYED<//>
            <div class="wg-howto__grid">
              <${Screen} />
              <div class="wg-howto__text">
                <p class="g-explain">
                  Each round is a real Wikipedia article about a place, with every place name blacked out. Every lane
                  says where it is, <b>as deep as it is sure of</b>: continent, then country, then region. Going deeper
                  pays, but the first wrong claim costs more than a region earns. Knowing where to stop is the game.
                </p>
                <p class="g-explain">
                  <b>Jev</b> answers one Choice a level and keeps the three likeliest paths (a beam), ranked by the
                  geometric mean of their probabilities. Code claims down the best path and stops at the first level
                  whose <b>confidence</b> is under the threshold.
                  A <b>text model</b> writes <code>CONTINENT</code>, <code>COUNTRY</code> and <code>REGION</code> lines; a name that isn't on the lists is a foul.
                </p>
              </div>
            </div>
          <//>
          <div class="wg-side__row">
            <${HowAsked} threshold=${threshold} />
            <${Scoring} />
          </div>
          <${RecentRuns} gameId=${game.id} render=${(r) => html`<span class="g-mono g-muted">${r.total ?? ''} rounds</span>`} />
        </div>
      </div>
    <//>
  `
}

/** The cabinet's own attract loop, as a little screen (still under reduced motion). */
function Screen() {
  const ref = useRef(null)
  useEffect(() => {
    const svg = ref.current?.querySelector('svg')
    if (svg?.pauseAnimations && calm()) svg.pauseAnimations()
  }, [])
  return html`<div class="wg-screen" ref=${ref}>${SCENES.wikiguessr('wgsetup')}</div>`
}

/** How Jev is asked: three Choices down a beam, and the stop line. */
function HowAsked({ threshold }) {
  const steps = [
    ['continent', 'a Choice over the 7 continents', 'keeps the 3 likeliest'],
    ['country', 'over the countries of those 3', 'keeps the 3 likeliest paths'],
    ['region', 'over the regions of the 3 best countries', 'the best path is the claim'],
  ]
  return html`
    <${Box} class="wg-how">
      <${Label}>HOW JEV IS ASKED<//>
      <ol class="wg-steps">
        ${steps.map(([k, what, keep], i) => html`
          <li key=${k} class="wg-step" style=${{ '--i': i }}>
            <span class="wg-step__n" aria-hidden="true">${i + 1}</span>
            <span class="wg-step__k">level ${i + 1} · ${k}</span>
            <span class="wg-step__v">${what} · <i>${keep}</i></span>
          </li>`)}
        <li class="wg-step wg-step--stop">
          <span class="wg-step__n" aria-hidden="true">■</span>
          <span class="wg-step__k">stop</span>
          <span class="wg-step__v">at the first level whose confidence is under <b class="tnum">${threshold.toFixed(2)}</b></span>
        </li>
      </ol>
    <//>
  `
}

/** The pay table: deeper pays more, and a bust costs more than a region earns. */
function Scoring({ points = POINTS }) {
  const tiers = [
    ['region', points.region, 3],
    ['country', points.country, 2],
    ['continent', points.continent, 1],
  ]
  return html`
    <${Box} class="wg-scoring">
      <${Label}>PAY TABLE<//>
      <ol class="wg-pay" aria-label="Points per round">
        ${tiers.map(([k, v, n]) => html`
          <li key=${k} class="wg-pay__row">
            <span class="wg-pay__lamps" aria-hidden="true">${[1, 2, 3].map((j) => html`<i key=${j} class=${j <= n ? 'is-on' : ''} />`)}</span>
            <span class="wg-pay__k">right ${k}</span>
            <b class="wg-pay__v g-t-ok tnum">+${v}</b>
          </li>`)}
        <li class="wg-pay__row wg-pay__row--bust">
          <span class="wg-pay__lamps" aria-hidden="true"><i class="is-bust">✕</i></span>
          <span class="wg-pay__k">first wrong claim</span>
          <b class="wg-pay__v g-t-err tnum">${signed(points.wrong)}</b>
        </li>
      </ol>
      <p class="wg-scoring__note">Nothing after a bust counts. A wrong claim costs more than a region earns.</p>
    <//>
  `
}

/* ── A game ────────────────────────────────────────────────────────────────── */

function Live({ game, runId }) {
  const { run, error } = useRun(runId)
  const now = useNow(isRunLive(run))
  const [picked, setPicked] = useState(null) // the round shown; null follows the game
  const [focus, setFocus] = useState(null) // the Jev lane whose numbers are drawn
  const [shown, setShown] = useState(null) // {round, continent} the map was switched to

  const rounds = run?.rounds ?? []
  // A round revealed in front of you: a bullseye (right to the region) earns
  // its lane a little confetti from its ladder.
  useOnFresh(rounds.filter((rd) => rd.answer).map((rd) => rd.n), (added) => {
    for (const n of added) {
      const rd = rounds.find((x) => x.n === n)
      for (const r of rd?.results ?? []) {
        if (!bullseye(r)) continue
        const el = document.getElementById(`wg-ladder-${r.lane}`)
        if (el) setTimeout(() => burstFrom(el, { colors: [LANE_COLORS[r.lane % 4], '#2ee6c5', '#ffffff'], count: 36, power: 0.6 }), 700)
      }
    }
  }, !!run)

  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`

  const k = picked ?? (rounds.length ? rounds.length - 1 : null)
  const round = k != null ? rounds[k] : null
  const claims = claimsFor(run, k)
  const jevLanes = run.lanes.filter((ln) => ln.kind === 'judgment')
  const jev = jevLanes.find((ln) => ln.index === focus) ?? jevLanes[0] ?? null
  const jc = jev ? claims[jev.index] : null
  const continent = shown?.round === k && shown.continent ? shown.continent : focusContinent(round, claims, jev?.index)
  const revealed = rounds.filter((rd) => rd.answer).length
  const points = { ...POINTS, ...(run.points ?? {}) }
  const fin = finaleOf(run)

  return html`
    <${GameFrame} game=${game} class="wg-page">
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)} winners=${fin.winners} headline=${fin.headline} sub=${fin.sub}>
        <span class="g-mono g-muted">round ${k != null ? k + 1 : '–'} of ${run.total} · Jev stops under ${run.threshold.toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="wg-bar">
        ${run.total > 1 && html`<${RoundTrack} run=${run} k=${k} onPick=${(i) => setPicked(i === rounds.length - 1 ? null : i)} />`}
        ${jevLanes.length > 1 &&
        html`<div class="wg-tabs" role="group" aria-label="Whose numbers">
          ${jevLanes.map(
            (ln) => html`<button key=${ln.index} type="button" class=${`wg-tab g-l${(ln.index % 4) + 1}${ln.index === jev.index ? ' wg-tab--on' : ''}`}
              aria-pressed=${ln.index === jev.index} onClick=${() => setFocus(ln.index)}>
              <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
          )}
        </div>`}
      </div>
      <div class="wg-stage">
        <div class="wg-col wg-col--article">
          <${Dossier} run=${run} round=${round} k=${k} />
          <${HowAsked} threshold=${run.threshold} />
          <${Scoring} points=${points} />
        </div>
        <div class="wg-col wg-col--map">
          <${Box} class="wg-room">
            <${ContinentBar} level=${jc?.levels?.[0]} threshold=${run.threshold} hasJev=${!!jev} waiting=${!!round && !!jev && !jc} />
            <${CountryMap} run=${run} round=${round} claims=${claims} level=${jc?.levels?.[1]} continent=${continent}
              onContinent=${(c) => setShown({ round: k, continent: c })} jevTop=${jc?.levels?.[0]?.top} />
          <//>
        </div>
        <div class="wg-col wg-col--claims">
          <${Reveal} round=${round} />
          <${Box} class="wg-ladders">
            <${Label} note="continent → country → region">CLAIMS<//>
            ${run.lanes.map((ln) => html`<${Ladder} key=${ln.index} lane=${ln} claim=${claims[ln.index]} result=${resultFor(round, ln.index)}
              threshold=${run.threshold} points=${points} k=${k} />`)}
          <//>
          <${Regions} level=${jc?.levels?.[2]} claim=${jc} threshold=${run.threshold} lane=${jev?.index ?? 0} hasJev=${!!jev} />
          <${Scoreboard} run=${run} revealed=${revealed} winners=${fin.winners ?? []} points=${points} />
        </div>
      </div>
      <div class="g-lanes">
        ${run.lanes.map(
          (ln) => html`
            <${Box} key=${ln.index} lane=${ln.index} class="wg-lane">
              <${LaneHead} lane=${ln} />
              <div class="wg-lane__row">
                <div class="wg-lane__score"><${Counter} value=${ln.score ?? 0} format=${num} class="g-score" /><small>points</small></div>
                <${LaneStats} lane=${ln} extra=${html`
                  <${Stat} label="rounds" value=${ln.played ?? 0} />
                  <${Stat} label="busts" value=${ln.busts ?? 0} tone=${ln.busts ? 'err' : undefined} />`} />
              </div>
            <//>
          `,
        )}
      </div>
    <//>
  `
}

/** Who won, as the run bar and the finale say it: the most points, by the
 *  game's rule. One lane plays for its score, not to win. */
function finaleOf(run) {
  if (isRunLive(run) || run.status !== 'finished') return {}
  const pts = (ln) => ln.score ?? 0
  const pixel = (n) => (n < 0 ? `-${-n}` : String(n))
  if (run.lanes.length === 1) {
    const ln = run.lanes[0]
    const n = pts(ln)
    return { headline: `${pixel(n)} POINT${Math.abs(n) === 1 ? '' : 'S'}`, sub: `${ln.label} · ${ln.played ?? 0} of ${run.total} article${run.total === 1 ? '' : 's'}` }
  }
  const winners = winnersOf(run)
  const won = winners.map((i) => run.lanes[i]).filter(Boolean)
  if (!won.length) return {}
  const each = won.length > 1 ? ' each' : ''
  const best = pts(won[0])
  return { winners, sub: `${won.map((l) => l.label).join(' · ')} · ${best} point${Math.abs(best) === 1 ? '' : 's'}${each}` }
}

/** The rounds as a strip of lit cartridges: played, live, still to come. */
function RoundTrack({ run, k, onPick }) {
  const rounds = run.rounds ?? []
  return html`
    <div class="wg-track" role="group" aria-label="Which round">
      ${Array.from({ length: run.total }, (_, i) => {
        const rd = rounds[i]
        const state = !rd ? 'todo' : rd.answer ? 'done' : 'live'
        const what = state === 'todo' ? 'to come' : state === 'live' ? 'live' : rd.answer.country ?? rd.answer.continent
        return html`<button key=${i} type="button" class=${`wg-rtab wg-rtab--${state}${i === k ? ' wg-rtab--on' : ''}`}
          disabled=${!rd} aria-pressed=${i === k} onClick=${() => onPick(i)} aria-label=${`Round ${i + 1}: ${what}`}>
          <span class="wg-rtab__n"><${PixelText} text=${`R${i + 1}`} /></span>
          <span class="wg-rtab__s">${state === 'live' && html`<i class="wg-rtab__dot" aria-hidden="true" />`}${what}</span>
        </button>`
      })}
    </div>
  `
}

/** The redacted article as a classified dossier: every hidden name a black
 *  bar of its length, struck on as the file opens; declassified at the reveal. */
function Dossier({ run, round, k }) {
  const paras = useMemo(() => articleRuns(round?.article), [round?.article])
  const open = !!round?.answer
  let bar = 0
  return html`
    <${Box} class=${`wg-dossier${open ? ' wg-dossier--open' : ''}`}>
      <div class="wg-dossier__hd">
        <span class="wg-dossier__file">
          <span class="wg-dossier__k">FILE</span>
          <${PixelText} text=${round ? `${String(k + 1).padStart(2, '0')}/${String(run.total).padStart(2, '0')}` : '--/--'}
            label=${round ? `Round ${k + 1} of ${run.total}` : 'Dealing'} />
        </span>
        <span class="spacer" />
        ${round && html`<span key=${open ? 'open' : 'shut'} class=${`wg-stamp wg-stamp--${open ? 'open' : 'shut'}`}>
          <${PixelText} text=${open ? 'DECLASSIFIED' : 'CLASSIFIED'} label=${open ? 'Declassified' : 'Classified'} /></span>`}
      </div>
      <div class="wg-dossier__meta g-mono">
        ${round ? html`<span><b class="tnum">${round.blocks}</b> names redacted</span><span>code blanks the title and every place name</span>` : html`<span>the first article is on its way…</span>`}
      </div>
      ${open && html`
        <p class="wg-dossier__subject"><span class="g-mono">SUBJECT</span> <a href=${round.answer.url} target="_blank" rel="noopener noreferrer">${round.answer.title}</a></p>`}
      ${!round && html`<div class="wg-dossier__wait" aria-hidden="true">${[92, 78, 88, 60, 84].map((w, i) => html`<i key=${i} style=${{ width: `${w}%` }} />`)}</div>`}
      ${round &&
      html`<div class="wg-dossier__text" key=${k}>
        ${paras.map(
          (parts, i) => html`<p key=${i}>
            ${parts.map((part, j) =>
              part.hidden
                ? html`<span key=${j} class="wg-redact" style=${{ '--i': Math.min(bar++, 24) }} title="a hidden name"><span aria-hidden="true">${'█'.repeat(part.hidden)}</span><span class="sr-only">(hidden name)</span></span>`
                : html`<span key=${j}>${part.text}</span>`,
            )}
          </p>`,
        )}
      </div>`}
    <//>
  `
}

/** A level's heading: its number lit, its name, and its confidence against the
 *  stop line as a little gauge (✓ claim, ■ stop). */
function LevelHead({ n, name, level, threshold, note }) {
  const v = level ? verdict(level, threshold) : null
  return html`
    <div class="wg-levelhd">
      <span class=${`wg-levelhd__n${level ? ` wg-levelhd__n--${v}` : ''}`} aria-hidden="true">${n}</span>
      <span class="wg-levelhd__k">LEVEL ${n} · ${name}</span>
      ${note && html`<span class="g-mono g-muted wg-levelhd__note">${note}</span>`}
      <span class="spacer" />
      ${level &&
      html`<span class=${`wg-conf wg-conf--${v}`} title=${`confidence ${level.confidence.toFixed(2)} against the stop line ${threshold.toFixed(2)}`}>
        <span class="wg-conf__track" aria-hidden="true"><i style=${{ width: `${Math.min(1, level.confidence) * 100}%` }} /><b style=${{ left: `${threshold * 100}%` }} /></span>
        <span class="g-mono">${v === 'claim' ? '✓' : '■'} conf ${level.confidence.toFixed(2)}${v === 'claim' ? '' : ': stop'}</span>
      </span>`}
    </div>
  `
}

/** Level 1: Jev's belief over the continents, one lit beam. */
function ContinentBar({ level, threshold, hasJev, waiting }) {
  if (!level) {
    return html`<div class="wg-level">
      <${LevelHead} n=${1} name="CONTINENT" />
      ${waiting ? html`<div class="wg-stack wg-stack--scan" aria-hidden="true" />` : null}
      <p class="g-muted wg-empty">${!hasJev ? 'No Jev in this game: the text models claim in words.' : waiting ? 'Jev is reading the article…' : '—'}</p>
    </div>`
  }
  const segs = stackSegments(level.top)
  const top = segs[0]
  const inside = top && top.w >= 22
  const rest = segs.slice(inside ? 1 : 0, 4)
  const summary = level.top.slice(0, 4).map((t) => `${t.option} ${t.p.toFixed(2)}`).join(', ')
  return html`
    <div class="wg-level">
      <${LevelHead} n=${1} name="CONTINENT" level=${level} threshold=${threshold} />
      <div class="wg-stack" role="img" aria-label=${`Jev on the continent: ${summary}`}>
        ${segs.map(
          (s, i) => html`<span key=${s.option} class=${`wg-stack__seg${i === 0 ? ' wg-stack__seg--top' : ''}`}
            style=${{ width: `${s.w}%`, opacity: i === 0 ? 1 : Math.max(0.16, 0.5 - i * 0.08) }} title=${`${s.option} ${s.p.toFixed(2)}`}>
            ${i === 0 && inside ? html`<b>${s.option}</b> <span class="tnum">${s.p.toFixed(2)}</span>` : ''}</span>`,
        )}
      </div>
      <span class="wg-then g-mono">${inside ? 'then ' : ''}${rest.map((s) => `${s.option} ${s.p.toFixed(2)}`).join(' · ')}</span>
    </div>
  `
}

/** Level 2: the countries of one continent as a lit tile map, a ring for each
 *  lane's claim, and a pin that drops on the answer. */
function CountryMap({ run, round, claims, level, continent, onContinent, jevTop }) {
  const layout = useMemo(() => continentLayout(run.map, continent), [run.map, continent])
  const probs = level?.map ?? {}
  const maxP = layout.tiles.reduce((m, t) => Math.max(m, probs[t.name] ?? 0), 0)
  const ringed = new Map()
  for (const [li, c] of Object.entries(claims)) {
    const country = c.claim?.[1]
    if (country) ringed.set(country, [...(ringed.get(country) ?? []), Number(li)])
  }
  const answer = round?.answer
  const pinned = answer?.continent === continent ? layout.tiles.find((t) => t.name === answer.country) : null
  const pad = MAP_PAD
  const W = layout.width + 2 * pad
  const H = layout.height + 2 * pad
  const vb = `${-pad} ${-pad} ${W} ${H}`
  const pCont = Object.fromEntries((jevTop ?? []).map((t) => [t.option, t.p]))
  const topTile = maxP > 0 ? layout.tiles.find((t) => (probs[t.name] ?? 0) === maxP) : null
  return html`
    <div class="wg-level">
      <${LevelHead} n=${2} name="COUNTRY" level=${level} threshold=${run.threshold} note="brighter = likelier" />
      <div class="wg-conts" role="group" aria-label="Which continent the map shows">
        ${(run.continents ?? []).map((c) => {
          const lanes = Object.entries(claims).filter(([, x]) => x.claim?.[0] === c.name).map(([li]) => Number(li))
          const p = pCont[c.name]
          return html`<button key=${c.name} type="button" class=${`wg-cont${c.name === continent ? ' wg-cont--on' : ''}${answer?.continent === c.name ? ' wg-cont--ans' : ''}`}
            aria-pressed=${c.name === continent} onClick=${() => { sfx.select(); onContinent(c.name) }} style=${{ '--p': p ?? 0 }}>
            <span>${c.name}</span>
            ${p != null && html`<span class="g-mono wg-cont__p">${p.toFixed(2)}</span>`}
            ${lanes.map((li) => html`<${LaneNum} key=${li} i=${li} />`)}
            ${answer?.continent === c.name && html`<span class="wg-cont__pin" title="the answer">▼<span class="sr-only"> (the answer)</span></span>`}
          </button>`
        })}
      </div>
      ${continent === 'Antarctica' || !layout.tiles.length
        ? html`<p class="g-muted wg-empty">No country governs Antarctica: a claim there stops at the continent.</p>`
        : html`
          <div class="wg-mapwrap">
            <svg class="wg-map" viewBox=${vb} role="img" aria-label=${mapSummary(continent, layout.tiles, probs)}>
              <defs>
                <radialGradient id="wgSea" cx="50%" cy="42%" r="70%">
                  <stop offset="0" stop-color="#2ee6c5" stop-opacity="0.16" />
                  <stop offset="0.6" stop-color="#2ee6c5" stop-opacity="0.04" />
                  <stop offset="1" stop-color="#2ee6c5" stop-opacity="0" />
                </radialGradient>
                <pattern id="wgGrid" x="0" y="0" width="26" height="26" patternUnits="userSpaceOnUse">
                  <path d="M26 0H0V26" fill="none" stroke="#2ee6c5" stroke-opacity="0.07" stroke-width="1" />
                </pattern>
                <linearGradient id="wgTile" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#231d4d" /><stop offset="1" stop-color="#120e2c" />
                </linearGradient>
                <linearGradient id="wgLit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="#9dfff0" /><stop offset="0.45" stop-color="#2ee6c5" /><stop offset="1" stop-color="#119a82" />
                </linearGradient>
              </defs>
              <rect x=${-pad} y=${-pad} width=${W} height=${H} fill="url(#wgSea)" />
              <rect x=${-pad} y=${-pad} width=${W} height=${H} fill="url(#wgGrid)" />
              ${layout.tiles.map((t) => {
                const p = probs[t.name] ?? 0
                const a = tileAlpha(p, maxP)
                const shows = p >= 0.01
                const isAns = pinned === t
                return html`
                  <g key=${t.code} class=${`wg-tile wg-tile--${inkOn(a)}${a ? ' wg-tile--lit' : ''}${isAns ? ' wg-tile--ans' : ''}`}>
                    <title>${t.name}${p ? ` · ${p.toFixed(2)}` : ''}</title>
                    <rect x=${t.x} y=${t.y} width=${t.w} height=${t.h} rx="4" class="wg-tile__bg" />
                    ${a > 0 && html`<rect key=${`lit-${continent}`} x=${t.x} y=${t.y} width=${t.w} height=${t.h} rx="4" class="wg-tile__lit"
                      fill-opacity=${a.toFixed(3)} style=${{ animationDelay: `${(t.col + t.row) * 45}ms` }} />`}
                    <path d=${`M${t.x + 4} ${t.y + 1.5}H${t.x + t.w - 4}`} class="wg-tile__bevel" />
                    <text x=${t.cx} y=${shows ? t.cy - 1 : t.cy + 4} class="wg-tile__code">${t.code}</text>
                    ${shows && html`<text x=${t.cx} y=${t.cy + 14} class="wg-tile__p">${p.toFixed(2)}</text>`}
                  </g>
                `
              })}
              ${topTile && html`<rect key=${`top-${topTile.code}`} x=${topTile.x - 1.5} y=${topTile.y - 1.5} width=${topTile.w + 3} height=${topTile.h + 3} rx="5" class="wg-tile__hot" />`}
              ${layout.tiles
                .filter((t) => ringed.has(t.name))
                .map((t) => {
                  const lanes = ringed.get(t.name)
                  const outer = ringRect(t, lanes.length - 1)
                  const mark = answer ? (t.name === answer.country ? 'ok' : 'err') : null
                  return html`<g key=${`r-${t.code}`}>
                    ${lanes.map((li, j) => {
                      const r = ringRect(t, j)
                      return html`<g key=${`${t.code}-${li}`} class=${`wg-ring g-l${(li % 4) + 1}${mark === 'err' ? ' wg-ring--off' : ''}`} style=${{ animationDelay: `${j * 90}ms` }}>
                        <rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} rx="6" class="wg-ring__line" />
                        <rect x=${r.tag.x} y=${r.tag.y} width=${r.tag.w} height=${r.tag.h} rx="2" class="wg-ring__tag" />
                        <text x=${r.tag.x + r.tag.w / 2} y=${r.tag.y + 9} class="wg-ring__num">${li + 1}</text>
                      </g>`
                    })}
                    ${mark && html`<g key=${`m-${mark}`} class=${`wg-ringmark wg-ringmark--${mark}`} transform=${`translate(${outer.x + 1} ${outer.y + outer.h - 1})`}>
                      <g class="wg-ringmark__in"><circle r="7" /><text y="3.6">${mark === 'ok' ? '✓' : '✕'}</text></g>
                    </g>`}
                  </g>`
                })}
              ${pinned && html`
                <g key=${`pin-${pinned.code}`} transform=${`translate(${pinned.x + pinned.w - 8} ${pinned.y + 15})`} class="wg-pinmark">
                  <circle r="14" class="wg-ripple" />
                  <circle r="14" class="wg-ripple wg-ripple--2" />
                  <ellipse rx="5" ry="1.8" class="wg-pin__shadow" />
                  <g class="wg-pin"><path d=${pinPath(0, 0, 7)} class="wg-pin__body" /><circle cy="-21" r="2.6" class="wg-pin__hole" /></g>
                  <title>the answer: ${pinned.name}</title>
                </g>`}
            </svg>
          </div>
        `}
      <div class="wg-legend g-mono">
        <span><span class="wg-key wg-key--lit" aria-hidden="true" /> Jev's belief</span>
        <span><span class="wg-key wg-key--ring" aria-hidden="true" /> a lane's claim</span>
        <span><span class="wg-key wg-key--pin" aria-hidden="true">▼</span> the answer</span>
      </div>
      ${level?.paths?.length > 0 &&
      html`<div class="wg-beam g-mono">
        <span class="g-muted">beam kept ${level.paths.length} paths:</span>
        ${level.paths.map((p, i) => html`<span key=${i} class=${i === 0 ? 'wg-beam__best' : ''}><i style=${{ width: `${Math.max(4, p.score * 100)}%` }} aria-hidden="true" />${p.path.join(' › ')} <b class="tnum">${p.score.toFixed(2)}</b></span>`)}
      </div>`}
    </div>
  `
}

/** Level 3: the regions of Jev's best countries, and the confidence against the stop line. */
function Regions({ level, claim, threshold, lane, hasJev }) {
  const countries = [...new Set((level?.top ?? []).map((t) => t.country))]
  const of = countries.length === 1 ? ` OF ${countries[0].toUpperCase()}` : ''
  let body
  if (!hasJev) body = html`<p class="g-muted">Only text models play this game.</p>`
  else if (!claim) body = html`<p class="g-muted">Waiting for Jev…</p>`
  else if (!level) {
    const why = claim.stopped_at === 1 ? 'Jev was unsure of the continent, so it claims nothing.'
      : claim.stopped_at === 2 ? 'Jev was unsure of the country, so it answers at continent level.'
        : claim.claim.length === 1 ? 'A place with no country: the claim stops at the continent.'
          : 'None of its likeliest countries has regions to choose from: it answers at country level.'
    body = html`<p class="wg-why">${why}</p>`
  } else {
    const v = verdict(level, threshold)
    body = html`
      <${Bars} lane=${lane} compact max=${5}
        items=${level.top.map((t) => ({ label: countries.length > 1 ? `${t.option} · ${t.country}` : t.option, p: t.p, title: `${t.option}, ${t.country}` }))} />
      <${Meter} label="confidence" value=${level.confidence} tone=${v === 'claim' ? 'ok' : 'warn'}
        marks=${[{ at: threshold, label: `stop line ${threshold.toFixed(2)}` }]} />
      <p class=${`wg-why wg-why--${v}`}>${v === 'claim' ? '✓ Sure enough: Jev claims the region.' : '■ Spread too thin to claim, so Jev answers at country level.'}</p>
    `
  }
  return html`
    <${Box} class="wg-regions">
      <${LevelHead} n=${3} name=${`REGION${of}`} level=${level} threshold=${threshold} />
      ${body}
    <//>
  `
}

/** The answer: sealed until every lane has claimed, then found. */
function Reveal({ round }) {
  const a = round?.answer
  if (!a) {
    return html`<${Box} class="wg-reveal wg-reveal--hidden">
      <${Label}>REVEAL<//>
      <p class="wg-reveal__sealed"><span aria-hidden="true">■</span> Sealed until every lane has claimed.</p>
      <span class="wg-reveal__scan" aria-hidden="true" />
    <//>`
  }
  const path = [a.continent, a.country, a.region].filter(Boolean)
  return html`
    <${Box} class="wg-reveal" key=${a.title}>
      <div class="wg-reveal__hd">
        <span class="wg-reveal__pin" aria-hidden="true">▼</span>
        <${Label}>LOCATION FOUND<//>
      </div>
      <a class="wg-reveal__title" href=${a.url} target="_blank" rel="noopener noreferrer">${a.title}</a>
      <ol class="wg-crumbs" aria-label="continent, country, region">
        ${path.map((p, i) => html`<li key=${i} style=${{ '--i': i }}>${p}</li>`)}
      </ol>
    <//>
  `
}

const TIER_WORD = { continent: 'CONTINENT', country: 'COUNTRY', region: 'REGION' }

/** One tier of a ladder: what was claimed there and how it went. */
function Tier({ t, threshold, out }) {
  let v = t.name
  let g = null
  let title = t.name ?? undefined
  const conf = t.conf != null ? t.conf.toFixed(2) : null
  switch (t.state) {
    case 'wait': v = out ? 'out' : ''; g = out ? '' : html`<span class="wg-dots" aria-label="thinking"><i /><i /><i /></span>`; break
    case 'claim': g = conf ? `conf ${conf}` : 'claimed'; break
    case 'right': g = `✓ ${signed(t.pts)}`; break
    case 'bust': g = `✕ bust ${signed(t.pts)}`; break
    case 'void': g = 'after a bust'; title = `${t.name}: claimed after a bust, so it doesn't count`; break
    case 'stop': v = 'stop'; g = `■ ${conf ?? '—'} < ${threshold.toFixed(2)}`; title = `Jev's confidence here was under the stop line`; break
    case 'foul': v = t.name ?? 'foul'; g = '✕ foul'; title = `${t.name ?? 'the name'} is not on the lists: a foul`; break
    case 'unsure': v = '—'; g = 'no claim'; break
    case 'end': v = '—'; g = 'nothing deeper'; title = 'No deeper level to claim here'; break
    default: v = ''; g = ''
  }
  return html`
    <li class=${`wg-tier wg-tier--${t.state}`} style=${{ '--i': t.i }} title=${title}>
      <span class="wg-tier__k">${TIER_WORD[t.level]}</span>
      <span class="wg-tier__v">${v}</span>
      <span class="wg-tier__g g-mono">${g}</span>
    </li>
  `
}

/** One lane's claim this round as a ladder: continent → country → region,
 *  each tier locking in, then paying out or busting at the reveal. */
function Ladder({ lane, claim, result, threshold, points, k }) {
  const out = !claim && (lane.status === 'error' || lane.status === 'stopped')
  const tiers = tiersOf(claim, result, points)
  const bust = tiers.some((t) => t.state === 'bust')
  const ace = bullseye(result)
  let sub
  if (!claim) sub = out ? 'out of the game' : 'thinking…'
  else sub = `${claim.kind === 'jev' ? 'Jev' : 'text'} · ${fmtMs(claim.ms)}${claim.kind === 'jev' && claim.stopped_at ? ` · stopped at level ${claim.stopped_at}` : ''}`
  return html`
    <div id=${`wg-ladder-${lane.index}`} class=${`wg-ladder g-l${(lane.index % 4) + 1}${bust ? ' wg-ladder--bust' : ''}${ace ? ' wg-ladder--ace' : ''}${claim ? '' : ' wg-ladder--wait'}`}>
      <div class="wg-ladder__hd">
        <${LaneNum} i=${lane.index} out=${out} />
        <span class="wg-ladder__who">${lane.label}</span>
        <span class="wg-ladder__sub g-mono">${sub}</span>
        <span class="spacer" />
        <span key=${`${k}-${result ? 'r' : 'w'}`} class=${`wg-pts ${result ? `wg-pts--in ${tone(result.points)}` : 'g-muted'}`}
          title=${result ? `${signed(result.points)} points this round` : 'not revealed yet'}>${result ? signed(result.points) : '?'}</span>
      </div>
      <ol class="wg-tiers" aria-label=${`${lane.label}: ${claim ? `“${claimText(claim.claim)}”` : sub}`}>
        ${tiers.map((t) => html`<${Tier} key=${`${k}-${t.level}-${t.state}`} t=${t} threshold=${threshold} out=${out} />`)}
      </ol>
      ${claim?.reason && html`<span class="wg-ladder__why" title=${claim.reason}>${claim.reason}</span>`}
    </div>
  `
}

function Scoreboard({ run, revealed, winners, points = POINTS }) {
  const rows = scoreboard(run)
  const n = run.total ?? (run.rounds ?? []).length
  const done = !isRunLive(run) && run.status === 'finished'
  return html`
    <${Box} class="wg-board">
      <${Label} note=${`after ${revealed} of ${run.total}`}>SCOREBOARD<//>
      <table class="wg-board__t">
        <thead>
          <tr>
            <th>lane</th>
            ${Array.from({ length: n }, (_, i) => html`<th key=${i} class="num">R${i + 1}</th>`)}
            <th class="num">points</th>
            <th class="num">busts</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const win = done && winners.includes(r.lane)
            return html`<tr key=${r.lane} class=${`g-l${(r.lane % 4) + 1}${win ? ' wg-board__win' : ''}`}>
              <td class="wg-board__who"><${LaneNum} i=${r.lane} /> <span>${r.label}</span>${win && html`<span class="wg-board__star" title="winner">★</span>`}</td>
              ${Array.from({ length: n }, (_, i) => {
                const v = r.per[i]
                return html`<td key=${i} class=${`num wg-cell${v == null ? ' wg-cell--none' : v > 0 ? ' wg-cell--pos' : v < 0 ? ' wg-cell--neg' : ''}`}>
                  <span key=${v == null ? 'n' : 'v'}>${v == null ? '·' : v < 0 ? `✕ ${signed(v)}` : signed(v)}</span></td>`
              })}
              <td class="num wg-board__total"><${Counter} value=${r.total} format=${num} sound /></td>
              <td class=${`num${r.busts ? ' g-t-err' : ' g-muted'}`}>${r.busts}</td>
            </tr>`
          })}
        </tbody>
      </table>
      ${rows.some((r) => r.busts) && html`<p class="wg-board__note g-mono"><span class="g-t-err">✕</span> a bust: a round's first wrong claim, ${signed(points.wrong)}</p>`}
    <//>
  `
}
