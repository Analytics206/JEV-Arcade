/* WikiRace — language models race each other across Wikipedia, link by link.
 *
 * Pick a start and a target (or roll for them), put up to four racers on the line
 * — any model the server's providers offer, a model id typed in, or TypeSafe's Jev
 * — and watch: every racer's hops, thinking time, tokens and cost tick live, each
 * move shows the model's own reason (Jev's shows the links it weighed), and every
 * foul lands in the cheat log: a link that is not on the page, or a jump straight
 * to the target.
 *
 * The race runs on the server, not in this page: it keeps going if the page
 * closes, and a page opened later attaches to it. `?race=<id>` in the address IS
 * the race, so a reload mid-race reattaches. The page only reads the event stream,
 * through one pure reducer (state.js). History replays finished races.
 */
import { h, render } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { ApiError, api, useEndpoint, useRaceStream } from './api.js'
import { RaceTrace } from './trace.js'
import { Badge, Button, EmptyState, Panel, Spacer, StatDot, Tabs, Toolbar } from './ui.js'
import {
  DEFAULT_RULES,
  MAX_LANES,
  POOLS,
  STATUS_LABEL,
  VERDICT,
  ago,
  cheatCount,
  clampRule,
  costTitle,
  customKey,
  fmtDuration,
  fmtInt,
  fmtLaneCost,
  fmtP,
  fmtTokens,
  foulsOf,
  groupModels,
  isCustomLane,
  isLive,
  judgmentSummary,
  laneElapsed,
  laneModel,
  laneSub,
  loadSaved,
  modelHint,
  normalizeTitle,
  optionLabel,
  paramsSearch,
  parseParams,
  providerState,
  raceBody,
  raceElapsed,
  rematchLanes,
  reconcileLanes,
  sanitizeRules,
  saveSaved,
  setupProblem,
  splitKey,
  statusTone,
  stepNotes,
  takesCustom,
  thinkingOptions,
  topOptions,
  turnElapsed,
  wikiUrl,
  withValue,
} from './state.js'

const html = htm.bind(h)

const TABS = [
  ['race', 'Race'],
  ['history', 'History'],
]

const TIME_LIMITS = [120, 300, 600, 1200, 1800, 3600]
const LINK_CAPS = [0, 1000, 500, 250, 100]
const MEDALS = ['🥇', '🥈', '🥉']
const POOL_HINT = {
  classic: 'Well-known subjects — far apart, still winnable.',
  trending: 'Yesterday’s most-read articles on Wikipedia.',
  wild: 'Truly random articles. Expect obscure, hard targets.',
}
/** The racer picker's value for "Custom model id…": no model key can start with
 *  it, because every key starts with a provider id. */
const CUSTOM = '*custom:'

const errText = (e) => (e instanceof Error ? e.message : String(e))
const timeLabel = (s) => (s % 60 === 0 ? `${s / 60} min` : fmtDuration(s * 1000))

/* ── Hooks ─────────────────────────────────────────────────────────────────── */

/** A clock that ticks only while something is live. */
function useNow(active, ms = 250) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active, ms])
  return now
}

/** Where the page is — `?race=<id>`, `?tab=history` — as state that follows the
 *  back and forward buttons. `go` pushes a history entry, so Back leaves a race
 *  for the setup (or the history) it was opened from. */
function useUrlParams() {
  const [params, setParams] = useState(() => parseParams(location.search))
  useEffect(() => {
    const onPop = () => setParams(parseParams(location.search))
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next) => {
    const search = paramsSearch(next)
    if (search !== location.search) history.pushState(null, '', `${location.pathname}${search}${location.hash}`)
    setParams(parseParams(search))
  }, [])
  return [params, go]
}

/* ── Small pieces ──────────────────────────────────────────────────────────── */

function LaneNum({ i, out = false }) {
  return html`<b class=${`wr-num wr-f${i + 1}${out ? ' wr-num--out' : ''}`}>${i + 1}</b>`
}

function ArticleLink({ title, children }) {
  return html`
    <a href=${wikiUrl(title)} target="_blank" rel="noopener noreferrer" title=${`${title} on Wikipedia`}>
      ${children ?? title}
    </a>
  `
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function SubjectField({ label, value, state, onChange, onResolve, onPick, onRandom }) {
  const id = `wr-${label.toLowerCase()}`
  const what = `Draw a random ${label.toLowerCase()}`
  return html`
    <div class="wr-subject">
      <label class="wr-lbl" for=${id}>${label}</label>
      <div class="wr-subject__row">
        <input
          id=${id}
          class="wr-in"
          value=${value}
          placeholder="Any Wikipedia article"
          onInput=${(e) => onChange(e.currentTarget.value)}
          onBlur=${onResolve}
          onKeyDown=${(e) => e.key === 'Enter' && onResolve()}
          spellcheck=${false}
          autocomplete="off"
          enterkeyhint="search"
        />
        <button type="button" class="wr-die" onClick=${onRandom} title=${what} aria-label=${what}>🎲</button>
      </div>
      <div class="wr-subject__state" aria-live="polite">
        ${state.status === 'pending' && html`<span class="wr-muted">looking it up…</span>`}
        ${state.status === 'error' && html`<span class="wr-bad">${state.message}</span>`}
        ${state.status === 'idle' && value.trim() && html`<span class="wr-muted">press Enter to look it up</span>`}
        ${state.status === 'ok' && html`<${Resolved} res=${state.res} onPick=${onPick} />`}
      </div>
    </div>
  `
}

/** A subject that is an article: its title and description, the lookup's note
 *  ("drawn from Classic", or how a typed name was read), and the other articles
 *  the name could have meant. */
function Resolved({ res, onPick }) {
  const others = (res.candidates ?? []).filter((c) => c.title !== res.title).slice(0, 4)
  return html`
    <span class="wr-ok">✓</span> <${ArticleLink} title=${res.title} />
    ${res.description && html`<span class="wr-muted"> — ${res.description}</span>`}
    ${res.note && html`<div class="wr-note">${res.note}</div>`}
    ${others.length > 0 &&
    html`
      <div class="wr-cands">
        ${others.map(
          (c) => html`
            <button
              key=${c.title}
              type="button"
              class="wr-cand"
              title=${c.description}
              onClick=${() => onPick(c.title, c.description, res.candidates)}
            >
              ${c.title}
            </button>
          `,
        )}
      </div>
    `}
  `
}

function LaneRow({ i, lane, info, onChange, onRemove }) {
  const m = laneModel(lane, info)
  const custom = isCustomLane(lane, info)
  const [pid, typed] = splitKey(lane.key)
  const provider = (info?.providers ?? []).find((p) => p.id === pid)
  const judge = m?.kind === 'judgment'
  const groups = groupModels(info?.models ?? [], info?.providers ?? [])
  const value = custom ? CUSTOM + pid : lane.key
  // A racer whose model cannot be offered right now (a typed id whose provider is
  // down, a saved key before the models load) still shows as itself, not as the
  // first option in the list — setupProblem says why it cannot race.
  const offered =
    value === '' || groups.some((g) => g.models.some((x) => x.key === value) || (g.custom && CUSTOM + g.provider === value))
  const levels = info?.thinking_levels ?? []
  const choices = thinkingOptions(levels, m?.thinking)
  if (lane.thinking && !levels.includes(lane.thinking)) choices.push([lane.thinking, `thinking: ${lane.thinking}`])

  const pick = (v) =>
    onChange(v.startsWith(CUSTOM) ? { key: customKey(v.slice(CUSTOM.length), ''), thinking: '', custom: true } : { key: v, thinking: '' })

  return html`
    <div class="wr-lanerow">
      <${LaneNum} i=${i} />
      <div class="wr-lanerow__pick">
        <select
          class="wr-sel"
          value=${value}
          onChange=${(e) => pick(e.currentTarget.value)}
          aria-label=${`Racer ${i + 1} model`}
          title=${m ? modelHint(m) : undefined}
        >
          <option value="">— pick a model —</option>
          ${!offered &&
          html`<option value=${value} disabled>${custom ? `Custom model id… (${provider?.label ?? pid})` : lane.key}</option>`}
          ${groups.map(
            (g) => html`
              <optgroup key=${g.provider} label=${g.label}>
                ${g.models.map(
                  (x) => html`<option key=${x.key} value=${x.key} disabled=${!x.available}>${optionLabel(x)}</option>`,
                )}
                ${g.custom && html`<option value=${CUSTOM + g.provider}>Custom model id…</option>`}
              </optgroup>
            `,
          )}
        </select>
        ${custom &&
        html`
          <input
            class="wr-in wr-custom"
            value=${typed}
            placeholder=${`${provider?.label ?? pid} model id`}
            onInput=${(e) => onChange({ ...lane, key: customKey(pid, e.currentTarget.value), custom: true })}
            aria-label=${`Racer ${i + 1}: the ${provider?.label ?? pid} model id`}
            title="Any model id this provider serves, exactly as it names it"
            spellcheck=${false}
            autocomplete="off"
            autocapitalize="off"
          />
        `}
        ${judge
          ? html`<span class="wr-lanerow__note">scores every link on the page · can't foul</span>`
          : html`
              <select
                class="wr-sel wr-sel--thinking"
                value=${lane.thinking}
                onChange=${(e) => onChange({ ...lane, thinking: e.currentTarget.value })}
                title="How much this racer thinks before it answers"
                aria-label=${`Racer ${i + 1} thinking`}
              >
                ${choices.map(([v, label]) => html`<option key=${v} value=${v}>${label}</option>`)}
              </select>
            `}
      </div>
      <button type="button" class="wr-x" onClick=${onRemove} title="Take this racer off the line" aria-label=${`Remove racer ${i + 1}`}>
        ✕
      </button>
    </div>
  `
}

/** Who can race right now: a dot per provider (hover for the reason, or where
 *  Ollama answers), the count of models that can race, and a re-read. */
function ProviderStrip({ info, onReload }) {
  const ready = info.models.filter((m) => m.available).length
  return html`
    <div class="wr-provs">
      ${info.providers.map((p) => {
        const s = providerState(p)
        return html`
          <span key=${p.id} class=${`wr-prov wr-prov--${s.tone}`} title=${s.title}>
            <${StatDot} tone=${s.tone} />${p.label}<span class="sr-only">${p.available ? ': ready' : `: ${p.reason ?? 'unavailable'}`}</span>
          </span>
        `
      })}
      <span class="wr-provs__meta">
        <span class="wr-count" title="Models that can race right now">${ready} of ${info.models.length} can race</span>
        <button type="button" class="wr-x wr-reload" onClick=${onReload} title="Re-read the providers and their models" aria-label="Re-read the providers and their models">
          ↻
        </button>
      </span>
    </div>
    ${info.warnings?.length > 0 &&
    html`
      <ul class="wr-warns" aria-label="Configuration warnings">
        ${info.warnings.map((w, k) => html`<li key=${k}>${w}</li>`)}
      </ul>
    `}
  `
}

function SetupPanel(p) {
  const info = p.models
  const models = info?.models ?? []
  const problem = setupProblem({ start: p.start, target: p.target, lanes: p.lanes, rules: p.rules }, info)
  const hasJudge = models.some((m) => m.kind === 'judgment')
  const canAdd = models.length > 0 || (info?.providers ?? []).some(takesCustom)

  // A number is clamped as it is typed, and written back when the clamp changed
  // it — but an emptied box is left empty until it loses focus, so a number can
  // be retyped without the lowest one appearing mid-edit.
  const onRule = (k) => (e) => {
    const el = e.currentTarget
    if (el.value.trim() === '') return
    const v = clampRule(k, el.value)
    if (String(v) !== el.value) el.value = String(v)
    p.setRules({ ...p.rules, [k]: v })
  }
  const settle = (k) => (e) => {
    e.currentTarget.value = String(p.rules[k])
  }
  const setRule = (k, v) => p.setRules({ ...p.rules, [k]: clampRule(k, v) })

  return html`
    <div class="wr-setup">
      <h3 class="wr-h">Course</h3>
      <${SubjectField}
        label="Start"
        value=${p.start}
        state=${p.startState}
        onChange=${(v) => p.setText('start', v)}
        onResolve=${() => p.resolve('start')}
        onPick=${(t, d, c) => p.pick('start', t, d, null, c)}
        onRandom=${() => p.randomOne('start')}
      />
      <div class="wr-swaprow">
        <button type="button" class="wr-swap" onClick=${p.swap} title="Swap start and target">⇅ swap</button>
      </div>
      <${SubjectField}
        label="Target"
        value=${p.target}
        state=${p.targetState}
        onChange=${(v) => p.setText('target', v)}
        onResolve=${() => p.resolve('target')}
        onPick=${(t, d, c) => p.pick('target', t, d, null, c)}
        onRandom=${() => p.randomOne('target')}
      />
      <div class="wr-dice">
        <select class="wr-sel" value=${p.pool} onChange=${(e) => p.setPool(e.currentTarget.value)} aria-label="Random pool">
          ${POOLS.map(([id, label]) => html`<option key=${id} value=${id}>${label}</option>`)}
        </select>
        <${Button} size="sm" onClick=${p.randomPair}>🎲 Random pair<//>
      </div>
      <p class="wr-hint">${POOL_HINT[p.pool]}</p>

      <h3 class="wr-h">Racers <span class="wr-count">${p.lanes.length}/${MAX_LANES}</span></h3>
      ${info && html`<${ProviderStrip} info=${info} onReload=${p.reloadModels} />`}
      ${p.modelsError && html`<p class="wr-bad">Could not load the models: ${p.modelsError.message}</p>`}
      ${p.lanes.map(
        (ln, i) => html`
          <${LaneRow}
            key=${i}
            i=${i}
            lane=${ln}
            info=${info}
            onChange=${(l) => p.setLanes(p.lanes.map((x, j) => (j === i ? l : x)))}
            onRemove=${() => p.setLanes(p.lanes.filter((_, j) => j !== i))}
          />
        `,
      )}
      <${Button}
        size="sm"
        variant="ghost"
        disabled=${p.lanes.length >= MAX_LANES || !canAdd}
        onClick=${() => p.setLanes([...p.lanes, { key: '', thinking: '' }])}
      >
        + Add racer
      <//>
      <p class="wr-hint">
        Text models answer with a link title, so they can foul. ${hasJudge ? 'Jev' : 'A judgment model'} scores every
        link on the page against the target instead — it cannot name one that is not there, and it never doubles back.
      </p>

      <h3 class="wr-h">Rules</h3>
      <div class="wr-rulesgrid">
        <label class="wr-lbl">
          Hop limit
          <input class="wr-in" type="number" min="1" max="40" value=${p.rules.max_hops} onInput=${onRule('max_hops')} onBlur=${settle('max_hops')} />
        </label>
        <label class="wr-lbl">
          Fouls to DQ
          <input class="wr-in" type="number" min="1" max="10" value=${p.rules.strikes} onInput=${onRule('strikes')} onBlur=${settle('strikes')} />
        </label>
        <label class="wr-lbl">
          Time limit
          <select class="wr-sel" value=${p.rules.time_limit_s} onChange=${(e) => setRule('time_limit_s', e.currentTarget.value)}>
            ${withValue(TIME_LIMITS, p.rules.time_limit_s).map((s) => html`<option key=${s} value=${s}>${timeLabel(s)}</option>`)}
          </select>
        </label>
        <label class="wr-lbl">
          Links shown
          <select class="wr-sel" value=${p.rules.max_links} onChange=${(e) => setRule('max_links', e.currentTarget.value)}>
            ${withValue(LINK_CAPS, p.rules.max_links).map(
              (n) => html`<option key=${n} value=${n}>${n ? `first ${fmtInt(n)}` : 'all'}</option>`,
            )}
          </select>
        </label>
      </div>

      <${Button} variant="primary" class="wr-go" disabled=${!!problem || p.starting} onClick=${p.onStart}>
        ${p.starting ? 'Starting…' : '🏁 Start race'}
      <//>
      ${problem && html`<p class="wr-hint">${problem}</p>`}
      ${p.startError && html`<p class="wr-bad">${p.startError}</p>`}
      <p class="wr-hint">
        Every turn sends each text racer the whole list of links on its article — about 6k input tokens for a 1,000-link
        page. Cost shows as billed where the provider reports it, as ≈ list price where it does not, and as $0 for a
        model on your own Ollama.
      </p>
    </div>
  `
}

/* ── The track ─────────────────────────────────────────────────────────────── */

/** Hop 0 heads every racer's log: they all set off from the same article, and
 *  without it each log would open on that racer's own first move. */
function StartRow({ start }) {
  return html`
    <li class="wr-step wr-step--start">
      <span class="wr-step__n tnum">0</span>
      <div class="wr-step__body">
        <div class="wr-step__line">
          <span class="wr-step__glyph" aria-hidden="true">⚐</span>
          <${ArticleLink} title=${start.title} />
          <span class="wr-step__tag">start</span>
        </div>
        ${start.links ? html`<div class="wr-step__meta tnum">${fmtInt(start.links)} links</div>` : null}
      </div>
    </li>
  `
}

/** Jev's evidence for a move: its top options as bars whose length is the
 *  probability itself, the one it followed in bold, then how sure it was and
 *  what the choice took. Where a text model has a reason, Jev has these. */
function JevBars({ step }) {
  const opts = topOptions(step)
  const summary = judgmentSummary(step.detail)
  return html`
    <ol class="wr-jev" title=${step.reason || undefined} aria-label="Jev's top options">
      ${opts.map(
        (o, k) => html`
          <li key=${k} class=${`wr-jev__opt${o.chosen ? ' is-chosen' : ''}`} style=${{ '--p': o.p }}>
            <span class="wr-jev__title">${o.title}${o.chosen && html`<span class="sr-only"> (followed)</span>`}</span>
            <span class="wr-jev__p tnum">${fmtP(o.p)}</span>
          </li>
        `,
      )}
    </ol>
    ${summary && html`<div class="wr-step__meta tnum">${summary}</div>`}
  `
}

function StepRow({ step: s }) {
  const v = VERDICT[s.verdict] ?? VERDICT.dead_link
  const judged = topOptions(s).length > 0
  // The numbers, then what a text step adds: why it stopped when that was not a
  // normal stop, the thinking actually sent, and how many links a local model saw.
  const meta = [fmtDuration(s.latency_ms), `${fmtTokens(s.tokens_in + s.tokens_out)} tok`, ...stepNotes(s)]
  if (s.verdict === 'ok' && s.to) {
    return html`
      <li class="wr-step">
        <span class="wr-step__n tnum">${s.turn}</span>
        <div class="wr-step__body">
          <div class="wr-step__line">
            <span class="wr-step__glyph">→</span>
            <${ArticleLink} title=${s.to} />
            ${s.link &&
            s.link !== s.to &&
            html`<span class="wr-step__via" title="The link’s own title — it redirects here">via ${s.link}</span>`}
            ${s.revisit && html`<${Badge} tone="warn" title="Already visited — a wasted hop">back<//>`}
          </div>
          ${judged ? html`<${JevBars} step=${s} />` : s.reason && html`<div class="wr-step__why">${s.reason}</div>`}
          <div class="wr-step__meta tnum">${[`${fmtInt(s.links)} links`, ...meta].join(' · ')}</div>
        </div>
      </li>
    `
  }
  return html`
    <li class=${`wr-step wr-step--${v.tone}`}>
      <span class="wr-step__n tnum">${s.turn}</span>
      <div class="wr-step__body">
        <div class="wr-step__line">
          <span class="wr-step__glyph">${v.glyph}</span> <b>${v.label}</b>
          ${s.claimed && html`<span class="wr-step__claim"> “${s.claimed}”</span>`}
        </div>
        ${s.note && html`<div class="wr-step__why">${s.note}</div>`}
        ${judged
          ? html`<${JevBars} step=${s} />`
          : s.reason && html`<div class="wr-step__meta">its reason: ${s.reason}</div>`}
        <div class="wr-step__meta tnum">${meta.join(' · ')}</div>
      </div>
    </li>
  `
}

function LaneCard({ lane, race, now }) {
  const steps = lane.steps ?? []
  const thinking = turnElapsed(lane, now)
  const listRef = useRef(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length, lane.status])
  const medal = lane.rank ? (MEDALS[lane.rank - 1] ?? `#${lane.rank}`) : null
  const live = isLive(lane)
  const f = lane.fouls

  return html`
    <article
      class=${`wr-lane wr-b${lane.index + 1}${live ? '' : ' is-done'}`}
      aria-label=${`Racer ${lane.index + 1}: ${lane.label}`}
    >
      <header class="wr-lane__hd">
        <${LaneNum} i=${lane.index} />
        <div class="wr-lane__who">
          <div class="wr-lane__name" title=${lane.model_id}>${lane.label}</div>
          <div class="wr-lane__sub">${laneSub(lane)}</div>
        </div>
        ${medal && html`<span class="wr-lane__medal" title=${`Rank ${lane.rank}`}>${medal}</span>`}
        <${Badge} tone=${statusTone(lane.status)}>
          ${live && lane.status !== 'waiting' && html`<${StatDot} tone="live" />`}${STATUS_LABEL[lane.status] ?? lane.status}
        <//>
      </header>

      <dl class="wr-kpis">
        <div>
          <dt>Hops</dt>
          <dd class="tnum">${lane.hops}<small>/${race.rules.max_hops}</small></dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd class="tnum">${fmtDuration(laneElapsed(lane, race, now))}</dd>
        </div>
        <div>
          <dt>Thinking</dt>
          <dd class="tnum">${fmtDuration(lane.think_ms + (thinking ?? 0))}</dd>
        </div>
        <div>
          <dt>Tokens in / out</dt>
          <dd class="tnum" title=${`${fmtInt(lane.tokens_in)} in, ${fmtInt(lane.tokens_out)} out`}>
            ${fmtTokens(lane.tokens_in)}<small> / </small>${fmtTokens(lane.tokens_out)}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd class="tnum" title=${costTitle(lane)}>${fmtLaneCost(lane)}</dd>
        </div>
        <div class=${lane.strikes ? 'is-foul' : undefined}>
          <dt>Fouls</dt>
          <dd class="tnum" title=${`${f.off_page} off-page, ${f.teleport} jumps to the target, ${f.no_pick} no pick`}>
            ${lane.strikes ? '⚠ ' : ''}${lane.strikes}<small>/${race.rules.strikes}</small>
          </dd>
        </div>
      </dl>

      <div class="wr-lane__at">
        <span class="wr-lane__pin" aria-hidden="true">◉</span>
        <${ArticleLink} title=${lane.page} />
        ${thinking != null && html`<span class="wr-lane__timer tnum">thinking ${fmtDuration(thinking)}</span>`}
        ${lane.status === 'moving' && html`<span class="wr-lane__timer">loading the next article…</span>`}
      </div>

      <ol ref=${listRef} class="wr-steps scroll-y">
        <${StartRow} start=${race.start} />
        ${steps.map((s) => html`<${StepRow} key=${s.turn} step=${s} />`)}
        ${!steps.length && html`<li class="wr-step wr-step--hint">${live ? 'First move coming…' : 'No moves.'}</li>`}
      </ol>
      ${lane.note &&
      html`<footer class=${`wr-lane__note wr-lane__note--${statusTone(lane.status)}`}>${lane.note}</footer>`}
    </article>
  `
}

function CheatLog({ race }) {
  const fouls = foulsOf(race)
  const cheats = race.lanes.reduce((n, ln) => n + cheatCount(ln), 0)
  return html`
    <${Panel}
      title="Cheat log"
      actions=${html`<span class="wr-count">${cheats} cheat${cheats === 1 ? '' : 's'} · ${fouls.length - cheats} no-pick</span>`}
    >
      ${fouls.length === 0
        ? html`<p class="wr-muted">
            No fouls${race.status === 'running' ? ' yet' : ''} — every pick was a real link on its page.
          </p>`
        : html`
            <div class="scroll-x">
              <table class="wr-table">
                <thead>
                  <tr>
                    <th>At</th>
                    <th>Racer</th>
                    <th>Foul</th>
                    <th>Named</th>
                    <th>While on</th>
                  </tr>
                </thead>
                <tbody>
                  ${fouls.map(
                    (f) => html`
                      <tr key=${`${f.lane}-${f.turn}`} title=${f.note}>
                        <td class="tnum">${fmtDuration(f.at_ms)}</td>
                        <td><${LaneNum} i=${f.lane} /> ${f.label}</td>
                        <td class=${`wr-kind wr-kind--${VERDICT[f.kind].tone}`}>${VERDICT[f.kind].glyph} ${VERDICT[f.kind].label}</td>
                        <td>${f.claimed ? `“${f.claimed}”` : '—'}</td>
                        <td>${f.from}</td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `}
    <//>
  `
}

function Results({ race, now }) {
  const ranked = race.ranking.map((i) => race.lanes[i]).filter(Boolean)
  const rest = race.lanes
    .filter((ln) => !race.ranking.includes(ln.index))
    .sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.hops - a.hops || a.think_ms - b.think_ms)
  const winner = race.winner != null ? race.lanes[race.winner] : null
  return html`
    <${Panel} title=${race.status === 'running' ? 'Standings' : 'Results'}>
      ${race.status !== 'running' &&
      html`
        <p class=${winner ? 'wr-verdict' : 'wr-verdict wr-verdict--none'}>
          ${winner
            ? html`🏁 <b>${winner.label}</b> wins — ${winner.hops} hop${winner.hops === 1 ? '' : 's'}, ${fmtDuration(winner.think_ms)} thinking`
            : `Nobody reached ${race.target.title}.`}
        </p>
      `}
      <div class="scroll-x">
        <table class="wr-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Racer</th>
              <th>Result</th>
              <th class="num">Hops</th>
              <th class="num">Thinking</th>
              <th class="num">Time</th>
              <th class="num">Tokens</th>
              <th class="num">Cost</th>
              <th class="num">Fouls</th>
            </tr>
          </thead>
          <tbody>
            ${[...ranked, ...rest].map(
              (ln) => html`
                <tr key=${ln.index}>
                  <td>${ln.rank ? (MEDALS[ln.rank - 1] ?? ln.rank) : '—'}</td>
                  <td><${LaneNum} i=${ln.index} /> ${ln.label}</td>
                  <td><${Badge} tone=${statusTone(ln.status)}>${STATUS_LABEL[ln.status] ?? ln.status}<//></td>
                  <td class="num tnum">${ln.hops}</td>
                  <td class="num tnum">${fmtDuration(ln.think_ms + (turnElapsed(ln, now) ?? 0))}</td>
                  <td class="num tnum">${fmtDuration(laneElapsed(ln, race, now))}</td>
                  <td class="num tnum">${fmtTokens(ln.tokens_in + ln.tokens_out)}</td>
                  <td class="num tnum" title=${costTitle(ln)}>${fmtLaneCost(ln)}</td>
                  <td class="num tnum">${ln.strikes}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      <p class="wr-hint">Ranked by fewest hops, then least thinking time; a racer that did not finish is unranked.</p>
    <//>
  `
}

function Track({ race, error, onReconnect, onStop, onRematch, onClose }) {
  const running = race?.status === 'running'
  const now = useNow(running)
  // "Stopping…" holds from the click until the stream says the race is over: the
  // server answers 202 at once, and the turns in flight take a moment to end.
  const [stopping, setStopping] = useState(false)
  useEffect(() => setStopping(false), [race?.id, race?.status])

  if (!race) {
    return error
      ? html`
          <${EmptyState} icon="⚠" title="Could not attach to this race">
            ${error}
            <div class="wr-actions">
              <${Button} size="sm" onClick=${onReconnect}>Try again<//>
              <${Button} size="sm" variant="ghost" onClick=${onClose}>Close<//>
            </div>
          <//>
        `
      : html`<${EmptyState} icon="🏁" title="Attaching to the race…" />`
  }

  const statusBadge =
    race.status === 'running' ? 'live' : race.status === 'finished' ? 'ok' : race.status === 'stopped' ? 'warn' : 'err'
  const linksRule = race.rules.max_links ? `first ${fmtInt(race.rules.max_links)} links shown` : 'every link shown'
  const stop = () => {
    setStopping(true)
    void onStop().then((ok) => ok || setStopping(false))
  }

  return html`
    <div class="wr-track">
      <header class="wr-track__hd">
        <div class="wr-route">
          <div class="wr-route__end">
            <span class="wr-lbl">Start</span>
            <${ArticleLink} title=${race.start.title} />
            ${race.start.description && html`<span class="wr-route__desc">${race.start.description}</span>`}
          </div>
          <span class="wr-route__arrow" aria-hidden="true">⟶</span>
          <div class="wr-route__end">
            <span class="wr-lbl">Target</span>
            <${ArticleLink} title=${race.target.title} />
            ${race.target.description && html`<span class="wr-route__desc">${race.target.description}</span>`}
          </div>
        </div>
        <${Spacer} />
        <div class="wr-track__ctl">
          <${Badge} tone=${statusBadge}>${running && html`<${StatDot} tone="live" />`}${race.status}<//>
          <span class="wr-clock tnum" title="Race clock">${fmtDuration(raceElapsed(race, now))}</span>
          ${running
            ? html`<${Button} size="sm" variant="danger" disabled=${stopping} onClick=${stop}>
                ${stopping ? 'Stopping…' : 'Stop race'}
              <//>`
            : html`<${Button} size="sm" onClick=${() => onRematch(race)} title="Put the same course and racers back in the setup">
                Race again
              <//>`}
          <${Button} size="sm" variant="ghost" onClick=${onClose}>Close<//>
        </div>
      </header>
      ${error &&
      html`
        <div class="wr-banner" role="status">
          ${error} <${Button} size="sm" variant="ghost" onClick=${onReconnect}>Reconnect<//>
        </div>
      `}
      <p class="wr-rulesline">
        ${race.rules.max_hops} hops · ${race.rules.strikes} foul${race.rules.strikes === 1 ? '' : 's'} disqualify ·
        ${' '}${fmtDuration(race.rules.time_limit_s * 1000)} limit · ${linksRule}${race.start.links
          ? ` · the start has ${fmtInt(race.start.links)} links`
          : ''}
      </p>

      <${Panel} title="Race trace" actions=${html`<span class="wr-count">hops over time</span>`}>
        <${RaceTrace} race=${race} now=${now} />
      <//>

      <div class="wr-lanes">
        ${race.lanes.map((ln) => html`<${LaneCard} key=${ln.index} lane=${ln} race=${race} now=${now} />`)}
      </div>

      <div class="wr-track__foot">
        <${Results} race=${race} now=${now} />
        <${CheatLog} race=${race} />
      </div>
    </div>
  `
}

/* ── History ───────────────────────────────────────────────────────────────── */

function History({ onOpen }) {
  const { data, error, loading, reload } = useEndpoint('/races?limit=100', 0)
  const [err, setErr] = useState(null)
  const races = data?.races ?? []

  const remove = async (id) => {
    setErr(null)
    try {
      await api.del(`/races/${encodeURIComponent(id)}`)
      reload()
    } catch (e) {
      setErr(errText(e))
    }
  }

  if (loading && !data) return html`<${EmptyState} icon="🏁" title="Loading races…" />`
  if (error) return html`<${EmptyState} icon="⚠" title="Could not load the history">${error.message}<//>`
  if (!races.length) {
    return html`
      <${EmptyState} icon="🏁" title="No races yet">
        Races land here when they start, and stay for replay after they end.
      <//>
    `
  }
  return html`
    <div class="wr-history">
      ${err && html`<p class="wr-bad">${err}</p>`}
      <table class="wr-table wr-table--history">
        <thead>
          <tr>
            <th>When</th>
            <th>Course</th>
            <th>Status</th>
            <th>Racers</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${races.map(
            (r) => html`
              <tr key=${r.id} class="wr-hrow" onClick=${() => onOpen(r.id)}>
                <td class="wr-h-when tnum" title=${r.created_at}>${ago(r.created_at)} ago</td>
                <td class="wr-h-course">
                  <b>${r.start.title}</b> <span class="wr-muted">⟶</span> <b>${r.target.title}</b>
                </td>
                <td class="wr-h-status">
                  <${Badge} tone=${r.status === 'finished' ? 'ok' : r.status === 'running' ? 'live' : 'warn'}>${r.status}<//>
                </td>
                <td class="wr-h-racers">
                  <div class="wr-hracers">
                    ${r.lanes.map(
                      (ln) => html`
                        <span
                          key=${ln.index}
                          class="wr-hracer"
                          title=${`${ln.label}: ${STATUS_LABEL[ln.status] ?? ln.status}${ln.note ? ` — ${ln.note}` : ''}`}
                        >
                          <${LaneNum} i=${ln.index} out=${ln.status !== 'finished'} />
                          ${ln.label}
                          <span class="wr-muted tnum">
                            ${ln.rank === 1 ? ' 🥇' : ''} ${ln.hops}h${cheatCount(ln) ? ` · ${cheatCount(ln)}✕` : ''}
                          </span>
                        </span>
                      `,
                    )}
                  </div>
                </td>
                <td class="wr-hactions" onClick=${(e) => e.stopPropagation()}>
                  <${Button} size="sm" variant="ghost" onClick=${() => onOpen(r.id)}>
                    ${r.status === 'running' ? 'Watch' : 'Replay'}
                  <//>
                  ${r.status !== 'running' &&
                  html`
                    <${Button}
                      size="sm"
                      variant="ghost"
                      class="wr-del"
                      onClick=${() => void remove(r.id)}
                      title="Delete this race from the history"
                      aria-label=${`Delete the race ${r.start.title} to ${r.target.title}`}
                    >
                      ✕
                    <//>
                  `}
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `
}

/* ── The view ──────────────────────────────────────────────────────────────── */

function WikiRace({ tab, raceId, go, reloadList }) {
  const models = useEndpoint('/models', 0)
  const stream = useRaceStream(tab === 'race' ? raceId : null)

  // ── setup state: subjects are per visit, the line-up is remembered ──
  const saved = useMemo(() => loadSaved(), [])
  const [start, setStart] = useState('')
  const [target, setTarget] = useState('')
  const [startState, setStartState] = useState({ status: 'idle' })
  const [targetState, setTargetState] = useState({ status: 'idle' })
  const [lanes, setLanes] = useState(saved?.lanes ?? [])
  const [rules, setRules] = useState(saved?.rules ?? DEFAULT_RULES)
  const [pool, setPool] = useState(saved?.pool ?? 'classic')
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState(null)
  const seq = useRef({ start: 0, target: 0 })

  // Once the models are known, drop racers whose model is gone; a first visit
  // (or one whose line-up vanished) gets a line-up that spans providers.
  const info = models.data
  useEffect(() => {
    if (info) setLanes((cur) => reconcileLanes(cur, info))
  }, [info])

  useEffect(() => saveSaved({ lanes, rules, pool }), [lanes, rules, pool])

  const race = stream.race
  useEffect(() => {
    document.title = race && tab === 'race' ? `${race.start.title} ⟶ ${race.target.title} · WikiRace` : 'WikiRace'
  }, [race?.start?.title, race?.target?.title, tab])

  const textOf = (w) => (w === 'start' ? start : target)
  const setTextOf = (w, v) => (w === 'start' ? setStart(v) : setTarget(v))
  const setStateOf = (w, s) => (w === 'start' ? setStartState(s) : setTargetState(s))
  const stateOf = (w) => (w === 'start' ? startState : targetState)

  const setText = (w, v) => {
    seq.current[w] += 1
    setTextOf(w, v)
    setStateOf(w, { status: 'idle' })
  }

  /** Set a subject that is already an article. Alternatives are only carried
   *  when the caller passes them — the candidate buttons do; a die roll or a
   *  rematch must not inherit the last lookup's alternatives. */
  const pick = (w, title, description, note = null, candidates = []) => {
    seq.current[w] += 1
    setTextOf(w, title)
    setStateOf(w, { status: 'ok', res: { title, description, note, candidates } })
  }

  /** Look the typed subject up; resolves to the article's title, or null. */
  const resolveNow = async (w) => {
    const text = textOf(w).trim()
    const cur = stateOf(w)
    if (cur.status === 'ok' && normalizeTitle(cur.res.title) === normalizeTitle(text)) return cur.res.title
    if (!text) {
      setStateOf(w, { status: 'idle' })
      return null
    }
    const mine = ++seq.current[w]
    setStateOf(w, { status: 'pending' })
    try {
      const res = await api.get(`/resolve?q=${encodeURIComponent(text)}`)
      if (seq.current[w] !== mine) return null
      setTextOf(w, res.title)
      setStateOf(w, { status: 'ok', res })
      return res.title
    } catch (e) {
      if (seq.current[w] === mine) {
        const message = e instanceof ApiError && e.status === 404 ? `No Wikipedia article matches “${text}”.` : errText(e)
        setStateOf(w, { status: 'error', message })
      }
      return null
    }
  }

  const poolNote = () => `drawn from ${POOLS.find(([id]) => id === pool)?.[1] ?? pool}`

  const randomOne = async (w) => {
    const other = w === 'start' ? target : start
    const mine = ++seq.current[w]
    setStateOf(w, { status: 'pending' })
    try {
      const q = new URLSearchParams({ pool, count: '1' })
      if (other.trim()) q.append('exclude', other.trim())
      const r = await api.get(`/random?${q}`)
      if (seq.current[w] !== mine) return
      const s = r.subjects[0]
      pick(w, s.title, s.description, poolNote())
    } catch (e) {
      if (seq.current[w] === mine) setStateOf(w, { status: 'error', message: errText(e) })
    }
  }

  const randomPair = async () => {
    const mine = { start: ++seq.current.start, target: ++seq.current.target }
    setStartState({ status: 'pending' })
    setTargetState({ status: 'pending' })
    try {
      const r = await api.get(`/random?${new URLSearchParams({ pool, count: '2' })}`)
      if (seq.current.start !== mine.start || seq.current.target !== mine.target) return
      pick('start', r.subjects[0].title, r.subjects[0].description, poolNote())
      pick('target', r.subjects[1].title, r.subjects[1].description, poolNote())
    } catch (e) {
      if (seq.current.start === mine.start) setStartState({ status: 'error', message: errText(e) })
      if (seq.current.target === mine.target) setTargetState({ status: 'idle' })
    }
  }

  const swap = () => {
    // Any lookup in flight is now answering for the wrong field, so it is
    // dropped (the seq bump) and a "looking it up…" is not carried across.
    seq.current.start += 1
    seq.current.target += 1
    const settle = (s) => (s.status === 'pending' ? { status: 'idle' } : s)
    setStart(target)
    setTarget(start)
    setStartState(settle(targetState))
    setTargetState(settle(startState))
  }

  const startRace = async () => {
    setStarting(true)
    setStartError(null)
    try {
      const s = await resolveNow('start')
      const t = await resolveNow('target')
      if (!s || !t) return
      const created = await api.post('/races', raceBody({ start: s, target: t, lanes, rules }))
      go({ race: created.id })
      reloadList()
    } catch (e) {
      setStartError(errText(e))
    } finally {
      setStarting(false)
    }
  }

  const rematch = (r) => {
    pick('start', r.start.title, r.start.description)
    pick('target', r.target.title, r.target.description)
    setLanes(rematchLanes(r))
    setRules(sanitizeRules(r.rules))
    go({})
  }

  /** Ask the server to stop the race; true when it took the request. */
  const stop = async () => {
    if (!raceId) return false
    try {
      await api.post(`/races/${encodeURIComponent(raceId)}/stop`)
      return true
    } catch {
      return false /* already over: the stream says so */
    }
  }

  // A race that just ended leaves the header's "racing" button.
  const ended = race?.status && race.status !== 'running'
  useEffect(() => {
    if (ended) reloadList()
  }, [ended, reloadList])

  // A race opened starts at its top — its route, its trace — wherever the last
  // one was scrolled to; stacked on a phone, the body is what scrolls.
  const bodyRef = useRef(null)
  const stageRef = useRef(null)
  useEffect(() => {
    if (!raceId) return
    if (stageRef.current) stageRef.current.scrollTop = 0
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [raceId])

  if (tab === 'history') {
    return html`
      <main class="wr__history scroll-y">
        <${History} onOpen=${(id) => go({ race: id })} />
      </main>
    `
  }
  return html`
    <main ref=${bodyRef} class=${`wr__body${raceId ? ' has-race' : ''}`}>
      <aside class="wr__setup scroll-y" aria-label="Race setup">
        <${SetupPanel}
          models=${info}
          modelsError=${models.error}
          reloadModels=${models.reload}
          start=${start}
          target=${target}
          startState=${startState}
          targetState=${targetState}
          lanes=${lanes}
          rules=${rules}
          pool=${pool}
          starting=${starting}
          startError=${startError}
          setText=${setText}
          resolve=${(w) => void resolveNow(w)}
          pick=${pick}
          randomOne=${(w) => void randomOne(w)}
          randomPair=${() => void randomPair()}
          swap=${swap}
          setLanes=${setLanes}
          setRules=${setRules}
          setPool=${setPool}
          onStart=${() => void startRace()}
        />
      </aside>
      <section ref=${stageRef} class="wr__stage scroll-y" aria-label="The track">
        ${raceId
          ? html`
              <${Track}
                race=${race}
                error=${stream.error}
                onReconnect=${stream.reconnect}
                onStop=${stop}
                onRematch=${rematch}
                onClose=${() => go({})}
              />
            `
          : html`
              <${EmptyState} icon="🏁" title="No race on the track">
                Pick a start and a target — or roll the dice — put up to four models on the line, and press Start. Each
                racer may only follow links on the article it is on; naming a link that is not there, or jumping
                straight to the target, is a foul.
              <//>
            `}
      </section>
    </main>
  `
}

/* ── The page ──────────────────────────────────────────────────────────────── */

/** The shell: one slim header — the name, what it is, the two tabs, and a way
 *  back to a race running elsewhere — then the view. */
function App() {
  const [{ tab, race: raceId }, go] = useUrlParams()
  const list = useEndpoint('/races?limit=10', 20_000)

  // The Race tab returns to the race that was open before History, rather than
  // to an empty track; Back does the same through the browser's own history.
  const lastRace = useRef(raceId)
  useEffect(() => {
    if (tab === 'race') lastRace.current = raceId
  }, [tab, raceId])

  const runningElsewhere = (list.data?.running ?? []).filter((id) => id !== raceId)
  const runningRace = list.data?.races?.find((r) => r.id === runningElsewhere[0])
  const home = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    go({})
  }

  return html`
    <div class="app">
      <header class="app-hd">
        <${Toolbar} class="app-hd__bar">
          <a class="app-brand" href="./" onClick=${home}><span aria-hidden="true">🏁</span> WikiRace</a>
          <p class="app-tag">Language models race across Wikipedia, link by link</p>
          <${Tabs}
            tabs=${TABS}
            value=${tab}
            onChange=${(t) => go(t === 'history' ? { tab: 'history' } : { race: lastRace.current })}
          />
          <${Spacer} />
          ${runningRace &&
          tab === 'race' &&
          html`
            <button type="button" class="wr-live" onClick=${() => go({ race: runningRace.id })}>
              <${StatDot} tone="live" /> racing: ${runningRace.start.title} ⟶ ${runningRace.target.title} — watch
            </button>
          `}
        <//>
      </header>
      <${WikiRace} tab=${tab} raceId=${raceId} go=${go} reloadList=${list.reload} />
    </div>
  `
}

render(html`<${App} />`, document.getElementById('app'))
