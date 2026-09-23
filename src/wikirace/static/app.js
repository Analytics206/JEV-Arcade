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
import { h } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { ApiError, api, useEndpoint, useRaceStream } from './api.js'
import { navigate } from './games/route.js'
import { SCENES } from './games/attract.js'
import { RaceTrace } from './trace.js'
import { PixelText, SiteHeader } from './brand.js'
import { Counter, Finale, LANE_COLORS, burstFrom, useJustEnded } from './fx.js'
import { recordPlay } from './profile.js'
import { sfx } from './sfx.js'
import {
  Badge,
  Button,
  CheckeredFlag,
  Crown,
  Die,
  EmptyState,
  Panel,
  Pennant,
  RankBadge,
  StatDot,
  WarnSign,
} from './ui.js'
import {
  DEFAULT_RULES,
  MAX_LANES,
  POOLS,
  RULE_RANGE,
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
  raceFinale,
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

const TIME_LIMITS = [120, 300, 600, 1200, 1800, 3600]
const LINK_CAPS = [0, 1000, 500, 250, 100]
const POOL_HINT = {
  classic: 'Well-known subjects — far apart, still winnable.',
  trending: 'Yesterday’s most-read articles on Wikipedia.',
  wild: 'Truly random articles. Expect obscure, hard targets.',
}
/** The racer picker's value for "Custom model id…": no model key can start with
 *  it, because every key starts with a provider id. */
const CUSTOM = '*custom:'

const errText = (e) => (e instanceof Error ? e.message : String(e))
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
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

/** A racer's slot, as the arcade's player select lights it: P1…P4 in the
 *  lane's colour. Decorative — the words around it name the racer. */
function Slot({ i, big = false }) {
  return html`<span class=${`wr-slot wr-f${i + 1}${big ? ' wr-slot--lg' : ''}`} aria-hidden="true">P${i + 1}</span>`
}

function ArticleLink({ title, children }) {
  return html`
    <a href=${wikiUrl(title)} target="_blank" rel="noopener noreferrer" title=${`${title} on Wikipedia`}>
      ${children ?? title}
    </a>
  `
}

/** A die's face for a subject: the same article always rolls the same number. */
const dieFace = (text) => (text ? 1 + ([...text].reduce((n, c) => n + c.codePointAt(0), 0) % 6) : 5)

/** A clock on a lit LED matrix, as the arcade's scoreboards show time; the
 *  digits are a picture, so the time is also there as text. */
function LedClock({ ms, title }) {
  const t = fmtDuration(ms)
  return html`
    <span class="wr-clock" title=${title}>
      <span class="sr-only">${t}</span>
      <span class="wr-clock__led"><${PixelText} text=${t} dots /></span>
    </span>
  `
}

/* ── Setup ─────────────────────────────────────────────────────────────────── */

function SubjectField({ label, value, state, onChange, onResolve, onPick, onRandom }) {
  const id = `wr-${label.toLowerCase()}`
  const what = `Draw a random ${label.toLowerCase()}`
  const end = label === 'Target' ? 'target' : 'start'
  const lit = state.status === 'ok' ? ' is-set' : state.status === 'error' ? ' is-bad' : ''
  return html`
    <div class=${`wr-subject wr-subject--${end}${lit}`}>
      <label class="wr-lbl" for=${id}>${end === 'target' ? html`<${CheckeredFlag} />` : html`<${Pennant} />`}${label}</label>
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
        <button
          type="button"
          class=${`wr-die${state.status === 'pending' ? ' is-rolling' : ''}`}
          onClick=${onRandom}
          title=${what}
          aria-label=${what}
        >
          <${Die} face=${dieFace(value)} />
        </button>
      </div>
      <div class="wr-subject__state" aria-live="polite">
        ${state.status === 'pending' && html`<span class="wr-muted wr-looking">looking it up…</span>`}
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
  // The slot lights once a racer that can race is in it.
  const lit = m && m.model_id ? (m.available ? ' is-in' : ' is-off') : ''

  const pick = (v) => {
    sfx.select()
    onChange(v.startsWith(CUSTOM) ? { key: customKey(v.slice(CUSTOM.length), ''), thinking: '', custom: true } : { key: v, thinking: '' })
  }

  return html`
    <div class=${`wr-lanerow wr-b${i + 1}${lit}${judge ? ' is-judge' : ''}`}>
      <${Slot} i=${i} />
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
          ? html`<span class="wr-lanerow__note"><span class="wr-lanerow__shield" aria-hidden="true">✓</span>scores every link on the page · can't foul</span>`
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
  const rollingPair = p.startState.status === 'pending' && p.targetState.status === 'pending'

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

  /** A number rule as a control-panel dial: − the value +, the value typed or
   *  nudged, clamped the same way either way. */
  const numberRule = (k, id, label, min, max) => {
    const v = p.rules[k]
    const [lo, hi] = RULE_RANGE[k]
    const nudge = (d) => {
      sfx.hover()
      setRule(k, v + d)
    }
    return html`
      <div class="wr-rule">
        <label class="wr-rule__k" for=${id}>${label}</label>
        <div class="wr-dial">
          <button type="button" class="wr-nudge" onClick=${() => nudge(-1)} disabled=${v <= lo} aria-label=${`${label}: one fewer`}>−</button>
          <input id=${id} class="wr-in wr-dial__n tnum" type="number" min=${min} max=${max} value=${v} onInput=${onRule(k)} onBlur=${settle(k)} />
          <button type="button" class="wr-nudge" onClick=${() => nudge(1)} disabled=${v >= hi} aria-label=${`${label}: one more`}>+</button>
        </div>
      </div>
    `
  }

  return html`
    <div class="wr-setup">
      <header class="wr-sign">
        <h2 class="wr-sign__title"><span class="sr-only">WikiRace</span><${PixelText} text="WIKIRACE" /></h2>
        <p class="wr-sign__tag">Models race across Wikipedia, link by link</p>
      </header>

      <section class="wr-sec">
        <h3 class="wr-h">Course</h3>
        <div class="wr-course">
          <${SubjectField}
            label="Start"
            value=${p.start}
            state=${p.startState}
            onChange=${(v) => p.setText('start', v)}
            onResolve=${() => p.resolve('start')}
            onPick=${(t, d, c) => p.pick('start', t, d, null, c)}
            onRandom=${() => {
              sfx.select()
              p.randomOne('start')
            }}
          />
          <div class="wr-swaprow">
            <button
              type="button"
              class="wr-swap"
              onClick=${() => {
                sfx.select()
                p.swap()
              }}
              title="Swap start and target"
            >
              <span class="wr-swap__ico" aria-hidden="true">⇅</span> swap
            </button>
          </div>
          <${SubjectField}
            label="Target"
            value=${p.target}
            state=${p.targetState}
            onChange=${(v) => p.setText('target', v)}
            onResolve=${() => p.resolve('target')}
            onPick=${(t, d, c) => p.pick('target', t, d, null, c)}
            onRandom=${() => {
              sfx.select()
              p.randomOne('target')
            }}
          />
        </div>
        <div class="wr-dice">
          <select class="wr-sel" value=${p.pool} onChange=${(e) => p.setPool(e.currentTarget.value)} aria-label="Random pool">
            ${POOLS.map(([id, label]) => html`<option key=${id} value=${id}>${label}</option>`)}
          </select>
          <button
            type="button"
            class=${`wr-roll${rollingPair ? ' is-rolling' : ''}`}
            onClick=${() => {
              sfx.coin()
              p.randomPair()
            }}
          >
            <span class="wr-roll__dice" aria-hidden="true"><${Die} face=${dieFace(p.start)} /><${Die} face=${dieFace(p.target)} /></span>
            Random pair
          </button>
        </div>
        <p class="wr-hint">${POOL_HINT[p.pool]}</p>
      </section>

      <section class="wr-sec">
        <h3 class="wr-h">Racers <span class="wr-count">${p.lanes.length}/${MAX_LANES}</span></h3>
        ${info && html`<${ProviderStrip} info=${info} onReload=${p.reloadModels} />`}
        ${p.modelsError && html`<p class="wr-bad">Could not load the models: ${p.modelsError.message}</p>`}
        <div class="wr-players">
          ${p.lanes.map(
            (ln, i) => html`
              <${LaneRow}
                key=${i}
                i=${i}
                lane=${ln}
                info=${info}
                onChange=${(l) => p.setLanes(p.lanes.map((x, j) => (j === i ? l : x)))}
                onRemove=${() => {
                  sfx.hover()
                  p.setLanes(p.lanes.filter((_, j) => j !== i))
                }}
              />
            `,
          )}
          <button
            type="button"
            class="wr-join"
            disabled=${p.lanes.length >= MAX_LANES || !canAdd}
            onClick=${() => {
              sfx.coin()
              p.setLanes([...p.lanes, { key: '', thinking: '' }])
            }}
          >
            <span class="wr-join__plus" aria-hidden="true">+</span> Add racer
            ${p.lanes.length < MAX_LANES && html`<span class="wr-join__sub" aria-hidden="true">P${p.lanes.length + 1} · press to join</span>`}
          </button>
        </div>
        <p class="wr-hint">
          Text models answer with a link title, so they can foul. ${hasJudge ? 'Jev' : 'A judgment model'} scores every
          link on the page against the target instead — it cannot name one that is not there, and it never doubles back.
        </p>
      </section>

      <section class="wr-sec">
        <h3 class="wr-h">Rules</h3>
        <div class="wr-rulesgrid">
          ${numberRule('max_hops', 'wr-rule-hops', 'Hop limit', 1, 40)}
          ${numberRule('strikes', 'wr-rule-strikes', 'Fouls to DQ', 1, 10)}
          <div class="wr-rule">
            <label class="wr-rule__k" for="wr-rule-time">Time limit</label>
            <select id="wr-rule-time" class="wr-sel" value=${p.rules.time_limit_s} onChange=${(e) => setRule('time_limit_s', e.currentTarget.value)}>
              ${withValue(TIME_LIMITS, p.rules.time_limit_s).map((s) => html`<option key=${s} value=${s}>${timeLabel(s)}</option>`)}
            </select>
          </div>
          <div class="wr-rule">
            <label class="wr-rule__k" for="wr-rule-links">Links shown</label>
            <select id="wr-rule-links" class="wr-sel" value=${p.rules.max_links} onChange=${(e) => setRule('max_links', e.currentTarget.value)}>
              ${withValue(LINK_CAPS, p.rules.max_links).map(
                (n) => html`<option key=${n} value=${n}>${n ? `first ${fmtInt(n)}` : 'all'}</option>`,
              )}
            </select>
          </div>
        </div>
      </section>

      <div class="wr-start">
        <button type="button" class="wr-go" disabled=${!!problem || p.starting} onClick=${p.onStart}>
          <span class="sr-only">${p.starting ? 'Starting…' : 'Start race'}</span>
          <${CheckeredFlag} class="wr-go__flag" /><${PixelText} text=${p.starting ? 'STARTING' : 'START RACE'} /><${CheckeredFlag} class="wr-go__flag" />
        </button>
        ${problem
          ? html`<p class="wr-hint wr-start__why">${problem}</p>`
          : !p.starting && html`<p class="wr-start__ready" aria-hidden="true"><${PixelText} text="READY · PRESS START" /></p>`}
        ${p.startError && html`<p class="wr-bad">${p.startError}</p>`}
      </div>
      <p class="wr-hint">
        Every turn sends each text racer the whole list of links on its article — about 6k input tokens for a 1,000-link
        page. Cost shows as billed where the provider reports it, as ≈ list price where it does not, and as $0 for a
        model on your own Ollama.
      </p>
    </div>
  `
}

/* ── The empty track: attract mode ─────────────────────────────────────────── */

/** No race on the track: the cabinet plays to itself, as it does on the floor
 *  (the same loop, games/attract.js) — held still for a visitor who asked for
 *  less motion. */
function TrackAttract() {
  const ref = useRef(null)
  useEffect(() => {
    const svg = ref.current?.querySelector('svg')
    if (!svg?.pauseAnimations || !calm()) return
    svg.setCurrentTime?.(3.2)
    svg.pauseAnimations()
  }, [])
  const scene = SCENES.wikirace
  return html`
    <div class="wr-attract">
      <div class="wr-crt">
        <span class="wr-crt__screen" ref=${ref}>
          ${scene ? scene('-track') : null}
          <span class="wr-crt__glass" aria-hidden="true" />
        </span>
      </div>
      <p class="wr-attract__press" aria-hidden="true"><${PixelText} text="INSERT COIN" /></p>
      <h2 class="wr-attract__title">No race on the track</h2>
      <p class="wr-attract__desc">
        Pick a start and a target — or roll the dice — put up to four models on the line, and press Start. Each
        racer may only follow links on the article it is on; naming a link that is not there, or jumping
        straight to the target, is a foul.
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
          <span class="wr-step__glyph" aria-hidden="true"><${Pennant} /></span>
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
      <li class=${`wr-step wr-step--move${s.revisit ? ' is-back' : ''}`}>
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

/** Hops as a row of lamps, one per hop the rules allow: lit in the lane's
 *  colour as the racer moves. Decoration beside the number. */
function HopMeter({ hops, max }) {
  return html`
    <span class="wr-meter" aria-hidden="true">
      ${Array.from({ length: max }, (_, k) => html`<i key=${k} class=${k < hops ? 'is-on' : undefined} />`)}
    </span>
  `
}

/** Fouls as warning lamps, one per foul the rules allow before a DQ. */
function StrikeLamps({ strikes, max }) {
  return html`
    <span class="wr-lamps" aria-hidden="true">
      ${Array.from({ length: max }, (_, k) => html`<i key=${k} class=${k < strikes ? 'is-on' : undefined} />`)}
    </span>
  `
}

const OUT = new Set(['dnf', 'dq', 'error', 'stopped'])

function LaneCard({ lane, race, now }) {
  const steps = lane.steps ?? []
  const thinking = turnElapsed(lane, now)
  const listRef = useRef(null)
  const cardRef = useRef(null)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length, lane.status])
  const live = isLive(lane)
  const raceLive = race.status === 'running'
  const f = lane.fouls
  const winner = lane.rank === 1 && !raceLive

  // Crossing the line in front of you: confetti in the lane's own colour. Going
  // out (a DQ, an error): a thud. A replay opened later does neither.
  const [crossed] = useJustEnded(live)
  useEffect(() => {
    if (!crossed) return
    if (lane.status === 'finished') {
      sfx.coin()
      burstFrom(cardRef.current, { colors: [LANE_COLORS[lane.index % 4], '#ffffff'], count: 46, power: 0.7 })
    } else if (OUT.has(lane.status)) sfx.down()
  }, [crossed])

  // A foul seen landing flashes the card red; fouls already there when the page
  // attached do not.
  const firstStrikes = useRef(lane.strikes)
  const lastStrikes = useRef(lane.strikes)
  useEffect(() => {
    if (lane.strikes > lastStrikes.current) sfx.down()
    lastStrikes.current = lane.strikes
  }, [lane.strikes])

  const cls = [
    'wr-lane',
    `wr-b${lane.index + 1}`,
    live ? 'is-live' : 'is-done',
    lane.status === 'finished' && 'is-finished',
    OUT.has(lane.status) && 'is-out',
    thinking != null && 'is-thinking',
    winner && 'is-winner',
    crossed && (lane.status === 'finished' ? 'just-finished' : 'just-out'),
  ]
    .filter(Boolean)
    .join(' ')

  return html`
    <article ref=${cardRef} class=${cls} aria-label=${`Racer ${lane.index + 1}: ${lane.label}`}>
      ${winner && html`<span class="wr-lane__crown"><${Crown} /></span>`}
      ${lane.strikes > firstStrikes.current && html`<span key=${`foul${lane.strikes}`} class="wr-lane__flash" aria-hidden="true" />`}
      <header class="wr-lane__hd">
        <${Slot} i=${lane.index} big />
        <div class="wr-lane__who">
          <div class="wr-lane__name" title=${lane.model_id}>${lane.label}</div>
          <div class="wr-lane__sub">${laneSub(lane)}</div>
        </div>
        ${lane.rank && html`<${RankBadge} rank=${lane.rank} />`}
        <${Badge} tone=${statusTone(lane.status)}>
          ${live && lane.status !== 'waiting' && html`<${StatDot} tone="live" />`}${STATUS_LABEL[lane.status] ?? lane.status}
        <//>
      </header>

      <dl class="wr-kpis">
        <div class="wr-kpi wr-kpi--hops">
          <dt>Hops</dt>
          <dd class="tnum">
            <span class="wr-kpi__big"><${Counter} value=${lane.hops} sound=${raceLive} /><small>/${race.rules.max_hops}</small></span>
            <${HopMeter} hops=${lane.hops} max=${race.rules.max_hops} />
          </dd>
        </div>
        <div class=${`wr-kpi wr-kpi--fouls${lane.strikes ? ' is-foul' : ''}`}>
          <dt>Fouls</dt>
          <dd class="tnum" title=${`${f.off_page} off-page, ${f.teleport} jumps to the target, ${f.no_pick} no pick`}>
            <span class="wr-kpi__big">${lane.strikes ? html`<${WarnSign} />` : ''}<${Counter} value=${lane.strikes} /><small>/${race.rules.strikes}</small></span>
            <${StrikeLamps} strikes=${lane.strikes} max=${race.rules.strikes} />
          </dd>
        </div>
        <div class="wr-kpi">
          <dt>Time</dt>
          <dd class="tnum">${fmtDuration(laneElapsed(lane, race, now))}</dd>
        </div>
        <div class="wr-kpi">
          <dt>Thinking</dt>
          <dd class="tnum">${fmtDuration(lane.think_ms + (thinking ?? 0))}</dd>
        </div>
        <div class="wr-kpi">
          <dt>Tokens in / out</dt>
          <dd class="tnum" title=${`${fmtInt(lane.tokens_in)} in, ${fmtInt(lane.tokens_out)} out`}>
            ${fmtTokens(lane.tokens_in)}<small> / </small>${fmtTokens(lane.tokens_out)}
          </dd>
        </div>
        <div class="wr-kpi">
          <dt>Cost</dt>
          <dd class="tnum" title=${costTitle(lane)}>${fmtLaneCost(lane)}</dd>
        </div>
      </dl>

      <div class="wr-lane__at">
        ${lane.status === 'finished'
          ? html`<span class="wr-lane__pin wr-lane__pin--flag" aria-hidden="true"><${CheckeredFlag} wave /></span>`
          : html`<span class="wr-lane__pin" aria-hidden="true">◉</span>`}
        <${ArticleLink} title=${lane.page} />
        ${thinking != null && html`<span class="wr-lane__timer tnum"><${StatDot} tone="live" />thinking ${fmtDuration(thinking)}</span>`}
        ${lane.status === 'moving' && html`<span class="wr-lane__timer">loading the next article…</span>`}
      </div>

      <ol ref=${listRef} class=${`wr-steps scroll-y${raceLive ? ' is-live' : ''}`}>
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
      class=${`wr-cheatlog${cheats ? ' has-cheats' : ''}`}
      title="Cheat log"
      actions=${html`<span class="wr-count">${cheats} cheat${cheats === 1 ? '' : 's'} · ${fouls.length - cheats} no-pick</span>`}
    >
      ${fouls.length === 0
        ? html`<p class="wr-clean">
            <span class="wr-clean__ok" aria-hidden="true">✓</span> No fouls${race.status === 'running' ? ' yet' : ''} — every pick was a real link on its page.
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
                <tbody class=${race.status === 'running' ? 'is-live' : undefined}>
                  ${fouls.map(
                    (f) => html`
                      <tr key=${`${f.lane}-${f.turn}`} title=${f.note}>
                        <td class="tnum">${fmtDuration(f.at_ms)}</td>
                        <td><${LaneNum} i=${f.lane} /> ${f.label}</td>
                        <td class=${`wr-kind wr-kind--${VERDICT[f.kind].tone}`}><span class="wr-kind__g">${VERDICT[f.kind].glyph}</span> ${VERDICT[f.kind].label}</td>
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
    <${Panel} class="wr-results" title=${race.status === 'running' ? 'Standings' : 'Results'}>
      ${race.status !== 'running' &&
      html`
        <p class=${winner ? `wr-verdict wr-b${winner.index + 1}` : 'wr-verdict wr-verdict--none'}>
          ${winner
            ? html`<${CheckeredFlag} wave /><span><${LaneNum} i=${winner.index} /> <b>${winner.label}</b> wins — ${winner.hops} hop${winner.hops === 1 ? '' : 's'}, ${fmtDuration(winner.think_ms)} thinking</span>`
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
                <tr key=${ln.index} class=${ln.rank === 1 ? 'is-winner' : undefined}>
                  <td>${ln.rank ? html`<${RankBadge} rank=${ln.rank} />` : '—'}</td>
                  <td><${LaneNum} i=${ln.index} /> ${ln.label}</td>
                  <td><${Badge} tone=${statusTone(ln.status)}>${STATUS_LABEL[ln.status] ?? ln.status}<//></td>
                  <td class="num tnum">${ln.hops}</td>
                  <td class="num tnum">${fmtDuration(ln.think_ms + (turnElapsed(ln, now) ?? 0))}</td>
                  <td class="num tnum">${fmtDuration(laneElapsed(ln, race, now))}</td>
                  <td class="num tnum">${fmtTokens(ln.tokens_in + ln.tokens_out)}</td>
                  <td class="num tnum" title=${costTitle(ln)}>${fmtLaneCost(ln)}</td>
                  <td class=${`num tnum${ln.strikes ? ' wr-t-err' : ''}`}>${ln.strikes}</td>
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

/** The sign over the page when a race ends in front of you — the winner in
 *  lights and confetti in their lane's colour, or GAME OVER. Mounted per race
 *  (the track is keyed by it), so a replay opened later never plays it. */
function RaceFinale({ race }) {
  const [ended, close] = useJustEnded(race.status === 'running')
  const f = raceFinale(race)
  return html`
    <${Finale}
      show=${ended && race.status === 'finished'}
      headline=${f.headline}
      sub=${f.sub}
      win=${f.win}
      colors=${f.lane != null ? [LANE_COLORS[f.lane % 4]] : undefined}
      onClose=${close}
    />
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
          <${EmptyState} icon=${html`<${WarnSign} />`} title="Could not attach to this race">
            ${error}
            <div class="wr-actions">
              <${Button} size="sm" onClick=${onReconnect}>Try again<//>
              <${Button} size="sm" variant="ghost" onClick=${onClose}>Close<//>
            </div>
          <//>
        `
      : html`<${EmptyState} icon=${html`<${CheckeredFlag} wave />`} title="Attaching to the race…" />`
  }

  const statusBadge =
    race.status === 'running' ? 'live' : race.status === 'finished' ? 'ok' : race.status === 'stopped' ? 'warn' : 'err'
  const linksRule = race.rules.max_links ? `first ${fmtInt(race.rules.max_links)} links shown` : 'every link shown'
  const stop = () => {
    setStopping(true)
    void onStop().then((ok) => ok || setStopping(false))
  }

  // The finale sits beside the track, not in it: the track is a size container,
  // which would pin the finale's fixed overlay to it instead of to the screen.
  return html`
    <div class="wr-track">
      <header class="wr-marquee">
        <div class="wr-route">
          <div class="wr-route__end wr-route__end--start">
            <span class="wr-route__k"><${Pennant} />Start</span>
            <span class="wr-route__t"><${ArticleLink} title=${race.start.title} /></span>
            ${race.start.description && html`<span class="wr-route__desc">${race.start.description}</span>`}
          </div>
          <span class="wr-route__arrow" aria-hidden="true">
            <svg viewBox="0 0 100 20" preserveAspectRatio="none" focusable="false">
              <path class="wr-route__dash" d="M2 10 H90" />
              <path class="wr-route__head" d="M84 3 L96 10 L84 17" />
            </svg>
          </span>
          <div class="wr-route__end wr-route__end--target">
            <span class="wr-route__k"><${CheckeredFlag} wave=${running} />Target</span>
            <span class="wr-route__t"><${ArticleLink} title=${race.target.title} /></span>
            ${race.target.description && html`<span class="wr-route__desc">${race.target.description}</span>`}
          </div>
        </div>
      </header>

      <div class=${`wr-runbar${running ? ' is-live' : ''}`}>
        <${Badge} tone=${statusBadge}>${running && html`<${StatDot} tone="live" />`}${race.status}<//>
        <${LedClock} ms=${raceElapsed(race, now)} title="Race clock" />
        <p class="wr-rulesline">
          ${race.rules.max_hops} hops · ${race.rules.strikes} foul${race.rules.strikes === 1 ? '' : 's'} disqualify ·
          ${' '}${fmtDuration(race.rules.time_limit_s * 1000)} limit · ${linksRule}${race.start.links
            ? ` · the start has ${fmtInt(race.start.links)} links`
            : ''}
        </p>
        <span class="spacer" />
        <div class="wr-track__ctl">
          ${running
            ? html`<${Button} size="sm" variant="danger" disabled=${stopping} onClick=${stop}>
                ${stopping ? 'Stopping…' : 'Stop race'}
              <//>`
            : html`<${Button} size="sm" variant="primary" onClick=${() => onRematch(race)} title="Put the same course and racers back in the setup">
                Race again
              <//>`}
          <${Button} size="sm" variant="ghost" onClick=${onClose}>Close<//>
        </div>
      </div>
      ${error &&
      html`
        <div class="wr-banner" role="status">
          ${error} <${Button} size="sm" variant="ghost" onClick=${onReconnect}>Reconnect<//>
        </div>
      `}

      <${Panel} class="wr-tracepanel" title="Race trace" actions=${html`<span class="wr-count">hops over time</span>`}>
        <${RaceTrace} race=${race} now=${now} />
      <//>

      <div class=${`wr-lanes wr-lanes--${race.lanes.length}`}>
        ${race.lanes.map((ln) => html`<${LaneCard} key=${ln.index} lane=${ln} race=${race} now=${now} />`)}
      </div>

      <div class="wr-track__foot">
        <${Results} race=${race} now=${now} />
        <${CheatLog} race=${race} />
      </div>
    </div>
    <${RaceFinale} race=${race} />
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

  if (loading && !data) return html`<${EmptyState} icon=${html`<${CheckeredFlag} wave />`} title="Loading races…" />`
  if (error) return html`<${EmptyState} icon=${html`<${WarnSign} />`} title="Could not load the history">${error.message}<//>`
  if (!races.length) {
    return html`
      <${EmptyState} icon=${html`<${CheckeredFlag} />`} title="No races yet">
        Races land here when they start, and stay for replay after they end.
      <//>
    `
  }
  return html`
    <div class="wr-history">
      <header class="wr-hof">
        <h2 class="wr-hof__title"><span class="sr-only">Hall of fame</span><${PixelText} text="HALL OF FAME" /></h2>
        <p class="wr-hof__note">${races.length} race${races.length === 1 ? '' : 's'}, newest first — pick one to watch or replay it</p>
      </header>
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
              <tr key=${r.id} class=${`wr-hrow wr-hrow--${r.status}`} onClick=${() => onOpen(r.id)}>
                <td class="wr-h-when tnum" title=${r.created_at}>${ago(r.created_at)} ago</td>
                <td class="wr-h-course">
                  <b>${r.start.title}</b> <span class="wr-h-arrow" aria-hidden="true">⟶</span><span class="sr-only">to</span> <b>${r.target.title}</b>
                </td>
                <td class="wr-h-status">
                  <${Badge} tone=${r.status === 'finished' ? 'ok' : r.status === 'running' ? 'live' : 'warn'}>
                    ${r.status === 'running' && html`<${StatDot} tone="live" />`}${r.status}
                  <//>
                </td>
                <td class="wr-h-racers">
                  <div class="wr-hracers">
                    ${r.lanes.map(
                      (ln) => html`
                        <span
                          key=${ln.index}
                          class=${`wr-hracer${ln.rank === 1 ? ' is-winner' : ''}`}
                          title=${`${ln.label}: ${STATUS_LABEL[ln.status] ?? ln.status}${ln.note ? ` — ${ln.note}` : ''}`}
                        >
                          <${LaneNum} i=${ln.index} out=${ln.status !== 'finished'} />
                          ${ln.label}
                          ${ln.rank === 1 && html`<${RankBadge} rank=${1} class="wr-rank--sm" />`}
                          <span class="wr-muted tnum">
                            ${ln.hops}h${cheatCount(ln) ? html` · <span class="wr-t-err">${cheatCount(ln)}✕</span>` : ''}
                          </span>
                        </span>
                      `,
                    )}
                  </div>
                </td>
                <td class="wr-hactions" onClick=${(e) => e.stopPropagation()}>
                  <${Button} size="sm" variant=${r.status === 'running' ? 'secondary' : 'ghost'} onClick=${() => onOpen(r.id)}>
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
    document.title = race && tab === 'race' ? `${race.start.title} ⟶ ${race.target.title} · WikiRace · JEV-Arcade` : 'WikiRace · JEV-Arcade'
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
      recordPlay('wikirace')
      sfx.start()
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
                key=${raceId}
                race=${race}
                error=${stream.error}
                onReconnect=${stream.reconnect}
                onStop=${stop}
                onRematch=${rematch}
                onClose=${() => go({})}
              />
            `
          : html`<${TrackAttract} />`}
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
  return html`
    <div class="app">
      <${SiteHeader}
        active=${tab}
        crumb="WikiRace"
        onNav=${(t) => (t === 'race' ? go({ race: lastRace.current }) : t === 'history' ? go({ tab: 'history' }) : navigate(''))}
      >
        ${runningRace &&
        tab === 'race' &&
        html`
          <button type="button" class="wr-live" onClick=${() => go({ race: runningRace.id })}>
            <${StatDot} tone="live" /> racing: ${runningRace.start.title} ⟶ ${runningRace.target.title} — watch
          </button>
        `}
      <//>
      <${WikiRace} tab=${tab} raceId=${raceId} go=${go} reloadList=${list.reload} />
    </div>
  `
}

/** The page's WikiRace view; main.js mounts it, or the Arcade beside it. */
export { App as WikiRace }
