/* WikiGuessr — where on Earth is this article? Say only as much as you're sure of.
 *
 * TypeSafe's hierarchical classification with confidence rollup. The server
 * (games/wikiguessr.py) deals a Wikipedia article with every place name blacked
 * out, asks every lane, and reveals the answer once all have claimed. This
 * page draws a round: the redacted article; Jev's continent bar; a tile map of
 * the countries lit by Jev's belief, with a ring for each lane's claim and a
 * pin for the answer; the regions against the stop line; each lane's claim
 * and points; the scoreboard.
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
  Meter,
  PlayerPicker,
  RecentRuns,
  RunBar,
  RunLoading,
  StartButton,
  Stat,
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
  LEVELS,
  MAP_PAD,
  articleRuns,
  claimText,
  claimsFor,
  continentLayout,
  depthWord,
  focusContinent,
  inkOn,
  mapSummary,
  pinPath,
  resultFor,
  ringRect,
  scoreboard,
  stackSegments,
  tileAlpha,
  verdict,
} from './wikiguessr.logic.js'

const ROUNDS = [1, 2, 3, 4, 5]
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0')
const tone = (n) => (n > 0 ? 'g-t-ok' : n < 0 ? 'g-t-err' : '')

export default function WikiGuessr({ game, runId }) {
  return runId ? html`<${Live} game=${game} runId=${runId} />` : html`<${Setup} game=${game} />`
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
          <${Box}>
            <${Label}>HOW IT'S PLAYED<//>
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

function HowAsked({ threshold }) {
  return html`
    <${Box} class="wg-how">
      <${Label}>HOW JEV IS ASKED<//>
      <pre class="wg-how__pre">${`level 1  choice · 7 continents
level 2  choice · countries of the
         3 best continents (beam 3)
level 3  choice · regions of the
         3 best countries
stop     where confidence < ${threshold.toFixed(2)}`}</pre>
    <//>
  `
}

function Scoring() {
  return html`
    <${Box} class="wg-scoring">
      <${Label}>SCORING<//>
      <dl class="wg-scoring__grid">
        <dt>right continent</dt><dd class="g-t-ok">+1</dd>
        <dt>right country</dt><dd class="g-t-ok">+3</dd>
        <dt>right region</dt><dd class="g-t-ok">+6</dd>
        <dt>first wrong claim</dt><dd class="g-t-err">−6</dd>
      </dl>
      <p class="wg-scoring__note">Going deeper pays, but a wrong claim costs more than a region earns.</p>
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
  if (!run) return html`<${GameFrame} game=${game}><${RunLoading} error=${error} /><//>`

  const rounds = run.rounds ?? []
  const k = picked ?? (rounds.length ? rounds.length - 1 : null)
  const round = k != null ? rounds[k] : null
  const claims = claimsFor(run, k)
  const jevLanes = run.lanes.filter((ln) => ln.kind === 'judgment')
  const jev = jevLanes.find((ln) => ln.index === focus) ?? jevLanes[0] ?? null
  const jc = jev ? claims[jev.index] : null
  const continent = shown?.round === k && shown.continent ? shown.continent : focusContinent(round, claims, jev?.index)
  const revealed = rounds.filter((rd) => rd.answer).length

  return html`
    <${GameFrame} game=${game}>
      <${RunBar} run=${run} now=${now} onAgain=${againOf(run)}>
        <span class="g-mono g-muted">round ${k != null ? k + 1 : '–'} of ${run.total} · Jev stops under ${run.threshold.toFixed(2)}</span>
        ${error && html`<span class="g-t-warn">${error}</span>`}
      <//>
      <div class="wg-bar">
        ${rounds.length > 1 &&
        html`<div class="wg-tabs" role="group" aria-label="Which round">
          ${rounds.map(
            (rd, i) => html`<button key=${i} type="button" class=${`wg-tab${i === k ? ' wg-tab--on' : ''}`}
              aria-pressed=${i === k} onClick=${() => setPicked(i === rounds.length - 1 ? null : i)}>
              Round ${i + 1}${rd.answer ? '' : ' · live'}</button>`,
          )}
        </div>`}
        ${jevLanes.length > 1 &&
        html`<div class="wg-tabs" role="group" aria-label="Whose numbers">
          ${jevLanes.map(
            (ln) => html`<button key=${ln.index} type="button" class=${`wg-tab${ln.index === jev.index ? ' wg-tab--on' : ''}`}
              aria-pressed=${ln.index === jev.index} onClick=${() => setFocus(ln.index)}>
              <${LaneNum} i=${ln.index} /> ${ln.label}</button>`,
          )}
        </div>`}
      </div>
      <div class="wg-stage">
        <div class="wg-col wg-col--article">
          <${Article} run=${run} round=${round} k=${k} />
          <${HowAsked} threshold=${run.threshold} />
          <${Scoring} />
        </div>
        <div class="wg-col wg-col--map">
          <${ContinentBar} level=${jc?.levels?.[0]} threshold=${run.threshold} hasJev=${!!jev} waiting=${!!round && !jc} />
          <${CountryMap} run=${run} round=${round} claims=${claims} level=${jc?.levels?.[1]} continent=${continent}
            onContinent=${(c) => setShown({ round: k, continent: c })} jevTop=${jc?.levels?.[0]?.top} />
        </div>
        <div class="wg-col wg-col--claims">
          <${Regions} level=${jc?.levels?.[2]} claim=${jc} threshold=${run.threshold} lane=${jev?.index ?? 0} hasJev=${!!jev} />
          <${Reveal} round=${round} />
          <div class="wg-claims">
            ${run.lanes.map((ln) => html`<${ClaimRow} key=${ln.index} lane=${ln} claim=${claims[ln.index]} result=${resultFor(round, ln.index)} />`)}
          </div>
          <${Scoreboard} run=${run} revealed=${revealed} />
        </div>
      </div>
      <div class="g-lanes">
        ${run.lanes.map(
          (ln) => html`
            <${Box} key=${ln.index} lane=${ln.index} class="wg-lane">
              <${LaneHead} lane=${ln} />
              <div class="wg-lane__row">
                <div class="wg-lane__score"><span class="tnum">${ln.score ?? 0}</span><small>points</small></div>
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

/** The redacted article: the text, with each hidden name a solid block of its length. */
function Article({ run, round, k }) {
  const paras = articleRuns(round?.article)
  return html`
    <${Box} class="wg-article">
      <${Label} note=${round ? `${round.blocks} names hidden` : null}>${round ? `ROUND ${k + 1} OF ${run.total}` : 'DEALING'}<//>
      ${!round && html`<p class="g-muted">The first article is on its way…</p>`}
      ${round &&
      html`<div class="wg-article__text">
        ${paras.map(
          (parts, i) => html`<p key=${i}>
            ${parts.map((part, j) =>
              part.hidden
                ? html`<span key=${j} class="wg-redact" title="a hidden name"><span aria-hidden="true">${'█'.repeat(part.hidden)}</span><span class="sr-only">(hidden name)</span></span>`
                : html`<span key=${j}>${part.text}</span>`,
            )}
          </p>`,
        )}
      </div>`}
      <span class="wg-note g-mono">code blanks the title and every place name</span>
    <//>
  `
}

/** A level's heading: its name, and how its confidence fell against the threshold. */
function LevelHead({ n, name, level, threshold, note }) {
  const v = level ? verdict(level, threshold) : null
  return html`
    <div class="wg-levelhd">
      <span class="wg-levelhd__k">LEVEL ${n} · ${name}</span>
      ${note && html`<span class="g-mono g-muted wg-levelhd__note">${note}</span>`}
      <span class="spacer" />
      ${level &&
      html`<span class=${`g-mono wg-conf wg-conf--${v}`}>
        ${v === 'claim' ? '✓' : '■'} conf ${level.confidence.toFixed(2)}${v === 'claim' ? '' : ': stop'}</span>`}
    </div>
  `
}

/** Level 1: Jev's belief over the continents, one bar. */
function ContinentBar({ level, threshold, hasJev, waiting }) {
  if (!level) {
    return html`<div class="wg-level">
      <${LevelHead} n=${1} name="CONTINENT" />
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
            style=${{ width: `${s.w}%`, opacity: i === 0 ? 1 : Math.max(0.12, 0.42 - i * 0.07) }} title=${`${s.option} ${s.p.toFixed(2)}`}>
            ${i === 0 && inside ? `${s.option} ${s.p.toFixed(2)}` : ''}</span>`,
        )}
      </div>
      <span class="wg-then g-mono">${inside ? 'then ' : ''}${rest.map((s) => `${s.option} ${s.p.toFixed(2)}`).join(' · ')}</span>
    </div>
  `
}

/** Level 2: the countries of one continent as a tile map, lit by Jev's belief,
 *  a ring for each lane's claim and a pin for the answer. */
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
  const vb = `${-pad} ${-pad} ${layout.width + 2 * pad} ${layout.height + 2 * pad}`
  const pCont = Object.fromEntries((jevTop ?? []).map((t) => [t.option, t.p]))
  return html`
    <div class="wg-level">
      <${LevelHead} n=${2} name="COUNTRY" level=${level} threshold=${run.threshold} note="brighter = likelier" />
      <div class="wg-conts" role="group" aria-label="Which continent the map shows">
        ${(run.continents ?? []).map((c) => {
          const lanes = Object.entries(claims).filter(([, x]) => x.claim?.[0] === c.name).map(([li]) => Number(li))
          return html`<button key=${c.name} type="button" class=${`wg-cont${c.name === continent ? ' wg-cont--on' : ''}`}
            aria-pressed=${c.name === continent} onClick=${() => onContinent(c.name)}>
            <span>${c.name}</span>
            ${pCont[c.name] != null && html`<span class="g-mono wg-cont__p">${pCont[c.name].toFixed(2)}</span>`}
            ${lanes.map((li) => html`<${LaneNum} key=${li} i=${li} />`)}
            ${answer?.continent === c.name && html`<span class="wg-cont__pin" title="the answer">▼<span class="sr-only"> (the answer)</span></span>`}
          </button>`
        })}
      </div>
      ${continent === 'Antarctica' || !layout.tiles.length
        ? html`<p class="g-muted wg-empty">No country governs Antarctica: a claim there stops at the continent.</p>`
        : html`
          <svg class="wg-map" viewBox=${vb} role="img" aria-label=${mapSummary(continent, layout.tiles, probs)}>
            ${layout.tiles.map((t) => {
              const p = probs[t.name] ?? 0
              const a = tileAlpha(p, maxP)
              const shows = p >= 0.01
              return html`
                <g key=${t.code} class=${`wg-tile wg-tile--${inkOn(a)}${a ? ' wg-tile--lit' : ''}`}>
                  <title>${t.name}${p ? ` · ${p.toFixed(2)}` : ''}</title>
                  <rect x=${t.x} y=${t.y} width=${t.w} height=${t.h} rx="3" class="wg-tile__bg" />
                  ${a > 0 && html`<rect x=${t.x} y=${t.y} width=${t.w} height=${t.h} rx="3" class="wg-tile__lit" fill-opacity=${a.toFixed(3)} />`}
                  <text x=${t.cx} y=${shows ? t.cy - 1 : t.cy + 4} class="wg-tile__code">${t.code}</text>
                  ${shows && html`<text x=${t.cx} y=${t.cy + 14} class="wg-tile__p">${p.toFixed(2)}</text>`}
                </g>
              `
            })}
            ${layout.tiles
              .filter((t) => ringed.has(t.name))
              .map((t) =>
                ringed.get(t.name).map((li, j) => {
                  const r = ringRect(t, j)
                  return html`<g key=${`${t.code}-${li}`} class=${`wg-ring g-l${(li % 4) + 1}`}>
                    <rect x=${r.x} y=${r.y} width=${r.w} height=${r.h} rx="5" class="wg-ring__line" />
                    <rect x=${r.tag.x} y=${r.tag.y} width=${r.tag.w} height=${r.tag.h} rx="1.5" class="wg-ring__tag" />
                    <text x=${r.tag.x + r.tag.w / 2} y=${r.tag.y + 9} class="wg-ring__num">${li + 1}</text>
                  </g>`
                }),
              )}
            ${pinned && html`<path class="wg-pin" d=${pinPath(pinned.x + pinned.w - 7, pinned.y + pinned.h - 2, 6)}><title>the answer: ${pinned.name}</title></path>`}
          </svg>
        `}
      <div class="wg-legend g-mono">
        <span><span class="wg-key wg-key--lit" aria-hidden="true" /> Jev's belief</span>
        <span><span class="wg-key wg-key--ring" aria-hidden="true" /> a lane's claim</span>
        <span><span class="wg-key wg-key--pin" aria-hidden="true">▼</span> the answer</span>
      </div>
      ${level?.paths?.length > 0 &&
      html`<div class="wg-beam g-mono">
        <span class="g-muted">beam kept ${level.paths.length} paths:</span>
        ${level.paths.map((p, i) => html`<span key=${i}>${p.path.join(' › ')} <b class="tnum">${p.score.toFixed(2)}</b></span>`)}
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
      <p class="wg-why">${v === 'claim' ? 'Sure enough: Jev claims the region.' : 'Spread too thin to claim, so Jev answers at country level.'}</p>
    `
  }
  return html`
    <${Box} class="wg-regions">
      <${LevelHead} n=${3} name=${`REGION${of}`} level=${level} threshold=${threshold} />
      ${body}
    <//>
  `
}

function Reveal({ round }) {
  const a = round?.answer
  if (!a) {
    return html`<${Box} class="wg-reveal wg-reveal--hidden">
      <${Label}>REVEAL<//>
      <p class="g-muted">The answer shows once every lane has claimed.</p>
    <//>`
  }
  return html`
    <${Box} class="wg-reveal">
      <${Label}>REVEAL<//>
      <a class="wg-reveal__title" href=${a.url} target="_blank" rel="noopener noreferrer">${a.title}</a>
      <span class="g-mono wg-reveal__path">${[a.region, a.country, a.continent].filter(Boolean).join(' · ')}</span>
    <//>
  `
}

/** One lane's claim this round, and what it scored once revealed. */
function ClaimRow({ lane, claim, result }) {
  let sub
  if (!claim) sub = lane.status === 'error' || lane.status === 'stopped' ? 'out of the game' : 'thinking…'
  else if (result) {
    const last = result.marks[result.marks.length - 1]
    sub = !result.marks.length ? 'no claim'
      : last === 'wrong' ? `wrong ${LEVELS[result.marks.length - 1]}`
        : `${LEVELS[result.marks.length - 1]} right`
  } else if (claim.fouls?.length) sub = `foul at ${claim.fouls[0]}`
  else sub = claim.claim.length ? `claims to the ${depthWord(claim.claim.length)}` : 'no claim'
  if (claim && !result && claim.kind === 'jev' && claim.stopped_at) sub += ` · stopped at level ${claim.stopped_at}`
  const marks = result?.marks ?? []
  return html`
    <div class=${`wg-claim g-l${(lane.index % 4) + 1}`}>
      <${LaneNum} i=${lane.index} />
      <div class="wg-claim__body">
        <span class="wg-claim__who">${lane.label} · <b>${claim ? `“${claimText(claim.claim)}”` : '…'}</b></span>
        <span class="g-mono wg-claim__sub">
          ${marks.map((m, i) => html`<span key=${i} class=${m === 'right' ? 'g-t-ok' : 'g-t-err'} title=${`${LEVELS[i]} ${m}`}>${m === 'right' ? '✓' : '✕'}</span>`)}
          ${sub}${claim?.fouls?.length && result ? ` · foul at ${claim.fouls[0]}` : ''}${claim ? ` · ${fmtMs(claim.ms)}` : ''}
        </span>
        ${claim?.reason && html`<span class="wg-claim__why" title=${claim.reason}>${claim.reason}</span>`}
      </div>
      <span class=${`wg-claim__pts tnum ${result ? tone(result.points) : 'g-muted'}`}>${result ? signed(result.points) : '·'}</span>
    </div>
  `
}

function Scoreboard({ run, revealed }) {
  const rows = scoreboard(run)
  const n = (run.rounds ?? []).length
  return html`
    <${Box} class="wg-board">
      <${Label} note=${`after ${revealed} of ${run.total}`}>SCOREBOARD<//>
      <table class="g-table wg-board__t">
        <thead>
          <tr>
            <th>lane</th>
            ${Array.from({ length: n }, (_, i) => html`<th key=${i} class="num">R${i + 1}</th>`)}
            <th class="num">points</th>
            <th class="num">busts</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr key=${r.lane}>
              <td class="wg-board__who"><${LaneNum} i=${r.lane} /> ${r.label}</td>
              ${r.per.map((v, i) => html`<td key=${i} class=${`num ${v == null ? 'g-muted' : tone(v)}`}>${v == null ? '·' : signed(v)}</td>`)}
              <td class="num"><b>${r.total}</b></td>
              <td class=${`num${r.busts ? ' g-t-err' : ''}`}>${r.busts}</td>
            </tr>`,
          )}
        </tbody>
      </table>
      ${rows.some((r) => r.busts) && html`<div class="wg-board__chips"><${Chip} tone="err">a bust: a round's first wrong claim, −6<//></div>`}
    <//>
  `
}
