/* The Arcade's shell: the floor every visit opens on, and the view that loads
 * one game's page.
 *
 * The floor is an arcade at night: a big attract-mode screen cycling through
 * the cabinets, an LED ticker of the latest plays, then the cabinets
 * themselves, each playing its own little loop (attract.js). Arrow keys walk
 * the floor, Enter starts a cabinet. What this browser has played is counted
 * (profile.js) and shown as a plate on each cabinet and a meter at the top.
 */
import { h } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { useEndpoint } from '../api.js'
import { GitHubMark, PixelText, REPO_NAME, REPO_URL, SiteFooter, SiteHeader, Wordmark } from '../brand.js'
import { usePlays } from '../profile.js'
import { sfx } from '../sfx.js'
import { GameFrame, useGames } from './kit.js'
import { CARDS, SCENES, accentOf, cardOf, loadGame } from './registry.js'
import { navigate, toGame } from './route.js'

const html = htm.bind(h)

const ATTRACT_MS = 7000
const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
const hrefOf = (id) => (id === 'wikirace' ? '?tab=race' : `?game=${id}`)
const openCab = (id) => (id === 'wikirace' ? navigate('?tab=race') : toGame(id))

/* ── Screens that play only while seen ─────────────────────────────────────── */

const seen = new WeakMap()
let observer = null
function watch(el, f) {
  if (typeof IntersectionObserver !== 'function') return () => {}
  observer ??= new IntersectionObserver((entries) => entries.forEach((e) => seen.get(e.target)?.(e.isIntersecting)), { rootMargin: '80px' })
  seen.set(el, f)
  observer.observe(el)
  return () => {
    observer.unobserve(el)
    seen.delete(el)
  }
}

/** One cabinet's attract-mode screen, paused while it is out of sight (and
 *  always, for a visitor who asked for less motion). */
function Scene({ id, u }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const set = (on) => {
      const svg = el.querySelector('svg')
      el.classList.toggle('is-off', !on)
      if (!svg?.pauseAnimations) return
      if (on && !calm()) svg.unpauseAnimations()
      else svg.pauseAnimations()
    }
    if (calm()) set(false)
    return watch(el, set)
  }, [id])
  const draw = SCENES[id]
  return html`<span class="scene" ref=${ref}>${draw ? draw(u) : null}</span>`
}

/* ── The big screen ────────────────────────────────────────────────────────── */

function Attract({ cards, titleOf }) {
  const [i, setI] = useState(0)
  const [held, setHeld] = useState(false)
  const card = cards[i % cards.length]
  useEffect(() => {
    if (held || calm()) return
    const t = setTimeout(() => setI((n) => (n + 1) % cards.length), ATTRACT_MS)
    return () => clearTimeout(t)
  }, [i, held, cards.length])
  const go = (n) => {
    sfx.hover()
    setI((n + cards.length) % cards.length)
  }
  const title = titleOf(card)
  return html`
    <div class="attract" style=${{ '--acc': card.accent }} onMouseEnter=${() => setHeld(true)} onMouseLeave=${() => setHeld(false)}
      onfocusin=${() => setHeld(true)} onfocusout=${() => setHeld(false)}>
      <div class="crt">
        <a class="crt__screen" href=${hrefOf(card.id)} key=${card.id} aria-label=${`Play ${title}`}
          onClick=${(e) => {
            if (!plainClick(e)) return
            e.preventDefault()
            sfx.start()
            openCab(card.id)
          }}>
          <${Scene} id=${card.id} u="hero" />
          <span class="crt__hud">
            <span class="crt__title"><${PixelText} text=${title} /></span>
            <span class="crt__pitch">${card.pitch}</span>
            <span class="crt__press"><${PixelText} text="PRESS START" /></span>
          </span>
          <span class="crt__glass" aria-hidden="true" />
        </a>
        <span class=${`crt__timer${held ? ' is-held' : ''}`} key=${`t${i}-${held}`} style=${{ animationDuration: `${ATTRACT_MS}ms` }} aria-hidden="true" />
      </div>
      <div class="attract__ctl">
        <button type="button" class="attract__step" onClick=${() => go(i - 1)} aria-label="Previous cabinet">◂</button>
        <div class="attract__lamps" role="group" aria-label="Cabinets on the big screen">
          ${cards.map(
            (c, n) => html`<button key=${c.id} type="button" class=${`attract__lamp${n === i ? ' is-on' : ''}`} style=${{ '--acc': c.accent }}
              aria-label=${titleOf(c)} aria-pressed=${n === i} onClick=${() => go(n)} />`,
          )}
        </div>
        <button type="button" class="attract__step" onClick=${() => go(i + 1)} aria-label="Next cabinet">▸</button>
      </div>
    </div>
  `
}

/* ── The ticker ────────────────────────────────────────────────────────────── */

const IDLE = ['INSERT COIN', 'FREE PLAY', 'PICK A CABINET', 'JEV CANNOT FOUL', 'EVERY MOVE LIVE, SCORED AND PRICED']

function scoreText(v) {
  if (!Number.isFinite(v)) return null
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

/** The latest plays, as the ticker spells them: a game and its lanes' scores,
 *  or a race and its winner. Newest first. */
function tickerLines(runs, races, titleOf) {
  const out = []
  for (const r of runs) {
    const t = titleOf({ id: r.game })
    if (r.status === 'running') {
      out.push({ at: r.created_at, text: `NOW PLAYING: ${t}` })
      continue
    }
    if (r.status !== 'finished') continue
    const lanes = (r.lanes ?? []).filter((l) => scoreText(l.score) != null).slice(0, 3)
    if (!lanes.length) continue
    out.push({ at: r.created_at, text: `${t}: ${lanes.map((l) => `${l.label} ${scoreText(l.score)}`).join('  ·  ')}` })
  }
  for (const r of races) {
    const w = r.lanes?.find((l) => l.index === r.winner)
    if (r.status === 'running') out.push({ at: r.created_at, text: `NOW RACING: ${r.start?.title} → ${r.target?.title}` })
    else if (w) out.push({ at: r.created_at, text: `WIKIRACE: ${w.label} FIRST TO ${r.target?.title}${Number.isFinite(w.elapsed_ms) ? ` IN ${(w.elapsed_ms / 1000).toFixed(1)}S` : ''}` })
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return out.slice(0, 10).map((x) => x.text)
}

function Ticker({ titleOf }) {
  const runs = useEndpoint('/games/runs?limit=30', 30_000)
  const races = useEndpoint('/races?limit=8', 30_000)
  const lines = useMemo(
    () => tickerLines(runs.data?.runs ?? [], races.data?.races ?? [], titleOf),
    [runs.data, races.data, titleOf],
  )
  const text = `${(lines.length ? lines : IDLE).join('   ★   ')}   ★   `
  const secs = Math.max(20, [...text].length * 0.22)
  return html`
    <section class="ticker" aria-label="Latest plays">
      <span class="ticker__label">${lines.length ? 'LATEST PLAYS' : 'ATTRACT MODE'}</span>
      <div class="ticker__win">
        <div class="ticker__track" style=${{ animationDuration: `${secs}s` }}>
          <${PixelText} text=${text} dots /><${PixelText} text=${text} dots />
        </div>
        <p class="sr-only">${(lines.length ? lines : IDLE).join('. ')}</p>
      </div>
    </section>
  `
}

/* ── Cabinets ──────────────────────────────────────────────────────────────── */

function Cabinet({ card, game, title, plays, kind }) {
  const ready = card.id === 'wikirace' || !!game?.ready
  const n = plays[card.id] ?? 0
  const open = (e) => {
    if (!plainClick(e)) return
    e.preventDefault()
    sfx.start()
    openCab(card.id)
  }
  const warm = () => {
    sfx.hover()
    if (card.id !== 'wikirace' && ready) loadGame(card.id).catch(() => {})
  }
  return html`
    <a class=${`cab cab--${kind}${ready ? '' : ' cab--soon'}${n ? ' cab--played' : ''}`} href=${hrefOf(card.id)} style=${{ '--acc': card.accent }}
      onClick=${open} onMouseEnter=${warm} onFocus=${warm} data-cab>
      <span class="cab__marquee" aria-hidden="true"><${PixelText} text=${title} /></span>
      <span class="cab__screen">
        <${Scene} id=${card.id} u=${card.id} />
        <span class="cab__glass" aria-hidden="true" />
        <span class="cab__go" aria-hidden="true"><${PixelText} text="PRESS START" /></span>
      </span>
      <span class="cab__deck">
        <span class="cab__name">${title}</span>
        ${kind !== 'quick' && html`<span class="cab__pitch">${card.pitch}</span>`}
        <span class="cab__foot">
          <span class="cab__use">${card.chip}</span>
          ${n
            ? html`<span class="cab__played" title=${`You've played this ${n} time${n === 1 ? '' : 's'} in this browser`}>★ ${n}</span>`
            : ready
              ? html`<span class="cab__new">NEW</span>`
              : html`<span class="cab__new cab__new--soon">SOON</span>`}
        </span>
      </span>
    </a>
  `
}

/** Tilt the cabinet under the pointer toward it, and light the spot it's on. */
function useTilt() {
  const last = useRef(null)
  const reset = () => {
    const el = last.current
    if (el) {
      el.style.removeProperty('--rx')
      el.style.removeProperty('--ry')
    }
    last.current = null
  }
  const move = (e) => {
    if (e.pointerType === 'touch' || calm()) return
    const el = e.target.closest?.('[data-cab]')
    if (el !== last.current) reset()
    if (!el) return
    last.current = el
    const r = el.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    el.style.setProperty('--rx', `${((0.5 - y) * 7).toFixed(2)}deg`)
    el.style.setProperty('--ry', `${((x - 0.5) * 9).toFixed(2)}deg`)
    el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`)
    el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`)
  }
  return { onPointerMove: move, onPointerLeave: reset }
}

/** Arrow keys walk the floor: to the nearest cabinet that way. */
function walk(e) {
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  const d = dirs[e.key]
  const here = document.activeElement?.closest?.('[data-cab]')
  if (!d || !here) return
  const all = [...e.currentTarget.querySelectorAll('[data-cab]')]
  const c = (el) => {
    const r = el.getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2]
  }
  const [hx, hy] = c(here)
  let best = null
  let bestScore = Infinity
  for (const el of all) {
    if (el === here) continue
    const [x, y] = c(el)
    const dx = x - hx
    const dy = y - hy
    const along = dx * d[0] + dy * d[1]
    if (along <= 4) continue
    const across = Math.abs(dx * d[1]) + Math.abs(dy * d[0])
    const score = along + across * 2.5
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  if (!best) return
  e.preventDefault()
  best.focus()
  best.scrollIntoView?.({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' })
}

/* ── Open source ───────────────────────────────────────────────────────────── */

const CLONE = `git clone ${REPO_URL}.git`

/** Below the cabinets: the arcade is open source, and the next cabinet is yours. */
function OpenSource() {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CLONE)
      sfx.coin()
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* no clipboard: the command is on screen to select */
    }
  }
  return html`
    <section class="oss" aria-labelledby="oss-hd">
      <a class="oss__badge" href=${REPO_URL} target="_blank" rel="noopener noreferrer" onMouseEnter=${sfx.hover}
        aria-label=${`${REPO_NAME} on GitHub (opens in a new tab)`}>
        <${GitHubMark} />
      </a>
      <div class="oss__body">
        <h2 class="oss__hd" id="oss-hd"><${PixelText} text="OPEN SOURCE" /><span>Build the next cabinet</span></h2>
        <p class="oss__txt">
          The games you're playing here run live on <b>Jev</b> and a free model from OpenRouter. The whole arcade is
          free and open source under the MIT license, in one repository: the server, every game, the shared kit,
          the pixel font and these attract screens.
        </p>
        <p class="oss__txt">
          Clone it and run your own on your machine: bring your keys for Claude, GPT, OpenRouter's catalogue or a
          local Ollama, add a TypeSafe key to seat Jev, and pit whichever models you like against each other. A
          new game is a Python module, a page and a test on the shared kit, and <a href=${`${REPO_URL}/blob/main/docs/arcade.md`} target="_blank" rel="noopener noreferrer">docs/arcade.md</a> walks through one.
        </p>
        <div class="oss__clone">
          <code class="oss__cmd"><span class="oss__prompt" aria-hidden="true">$</span> ${CLONE}</code>
          <button type="button" class="oss__copy" onClick=${copy} aria-live="polite">${copied ? '✓ Copied' : 'Copy'}</button>
        </div>
        <div class="oss__cta">
          <a class="btn btn--primary oss__go" href=${REPO_URL} target="_blank" rel="noopener noreferrer">
            <${GitHubMark} /> View ${REPO_NAME} on GitHub<span class="sr-only"> (opens in a new tab)</span>
          </a>
          <a class="btn btn--ghost" href=${`${REPO_URL}/blob/main/docs/arcade.md`} target="_blank" rel="noopener noreferrer">How a game is built</a>
        </div>
      </div>
    </section>
  `
}

/* ── The floor ─────────────────────────────────────────────────────────────── */

function Collection({ cards, plays, titleOf }) {
  const got = cards.filter((c) => plays[c.id]).length
  const all = got === cards.length
  return html`
    <div class="collect" title="Cabinets you've played in this browser">
      <span class="collect__k">${all ? 'EVERY CABINET PLAYED' : 'CABINETS PLAYED'}</span>
      <span class="collect__cells" role="img" aria-label=${`${got} of ${cards.length} cabinets played`}>
        ${cards.map((c) => html`<span key=${c.id} class=${`collect__cell${plays[c.id] ? ' is-lit' : ''}`} style=${{ '--acc': c.accent }} title=${titleOf(c)} />`)}
      </span>
      <b class="collect__n tnum">${got}<small>/${cards.length}</small></b>
    </div>
  `
}

export function Hub() {
  const games = useGames()
  const plays = usePlays()
  const tilt = useTilt()
  useEffect(() => {
    // As the server titles this view for search engines (site.py).
    document.title = 'JEV-Arcade · AI games: Jev vs. text models, live'
  }, [])
  const titleOf = useMemo(() => (c) => c.title ?? games.byId.get(c.id)?.title ?? cardOf(c.id)?.title ?? c.id, [games.data])
  const ready = (c) => c.id === 'wikirace' || games.byId.get(c.id)?.ready
  const cards = CARDS.filter(ready)
  const feature = CARDS.filter((c) => c.section === 'feature')
  const main = CARDS.filter((c) => c.section === 'main')
  const quick = CARDS.filter((c) => c.section === 'quick')
  const random = () => {
    const pool = cards.filter((c) => !plays[c.id])
    const pick = (pool.length ? pool : cards)[Math.floor(Math.random() * (pool.length || cards.length))]
    if (!pick) return
    sfx.coin()
    openCab(pick.id)
  }
  const cab = (c, kind) => html`<${Cabinet} key=${c.id} card=${c} game=${games.byId.get(c.id)} title=${titleOf(c)} plays=${plays} kind=${kind} />`
  return html`
    <main class="g-main scroll-y hub">
      <div class="floor" aria-hidden="true"><div class="floor__grid" /></div>
      <div class="hub__in">
        <section class="hero">
          <div class="hero__copy">
            <p class="hero__eyebrow"><span class="hero__coin" aria-hidden="true" />${CARDS.length} cabinets · one judgment model · free play</p>
            <h1 class="hero__title"><${Wordmark} class="wm--hero" /></h1>
            <p class="hero__lede">
              Fifteen games that pit <b>Jev</b>, a judgment model that answers with probabilities instead of words,
              against conventional text models. Every move streams live, scored and priced, and every cheat is caught.
            </p>
            <div class="hero__cta">
              <button type="button" class="press" onClick=${() => {
                sfx.start()
                openCab('wikirace')
              }}>
                <${PixelText} text="PLAY WIKIRACE" />
              </button>
              <button type="button" class="btn btn--secondary hero__dice" onClick=${random} title="Open a cabinet you haven't played yet">
                <span aria-hidden="true">⚄</span> Random cabinet
              </button>
            </div>
            <${Collection} cards=${cards.length ? cards : CARDS} plays=${plays} titleOf=${titleOf} />
          </div>
          <${Attract} cards=${cards.length ? cards : CARDS} titleOf=${titleOf} />
        </section>

        <${Ticker} titleOf=${titleOf} />
        ${games.error && html`<p class="g-t-err">${games.error.message}</p>`}

        <div class="floorplan" ...${tilt} onKeyDown=${walk}>
          <section class="aisle" aria-labelledby="aisle-main">
            <h2 class="aisle__hd" id="aisle-main"><${PixelText} text="MAIN FLOOR" /><span class="aisle__note">each cabinet highlights JEV use cases</span></h2>
            <div class="cabs cabs--main">
              ${feature.map((c) => cab(c, 'feature'))}
              ${main.map((c) => cab(c, 'main'))}
            </div>
          </section>
          <section class="aisle" aria-labelledby="aisle-quick">
            <h2 class="aisle__hd" id="aisle-quick"><${PixelText} text="QUICK HITS" /><span class="aisle__note">small side games, one pattern each</span></h2>
            <div class="cabs cabs--quick">${quick.map((c) => cab(c, 'quick'))}</div>
          </section>
        </div>

        <${OpenSource} />

        <p class="hub__foot">
          <span><${PixelText} text="GAME ON" /></span>
          <span>Arrow keys walk the floor, Enter plays. Every game runs on the server and keeps its history; the players are Jev and the text models this arcade runs.</span>
        </p>
      </div>
      <${SiteFooter} />
    </main>
  `
}

/* ── One game ──────────────────────────────────────────────────────────────── */

function Soon({ game }) {
  const card = cardOf(game.id)
  return html`
    <${GameFrame} game=${game}>
      <div class="g-soon">
        <p>${card?.pitch ?? game.tagline}</p>
        <p class="g-muted">This cabinet is still being built.</p>
      </div>
    <//>
  `
}

function Loading({ what }) {
  return html`<div class="g-boot"><${PixelText} text="LOADING" /><span class="g-muted">${what}</span></div>`
}

export function GameView({ route }) {
  const games = useGames()
  const game = games.byId.get(route.game)
  const [mod, setMod] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    setMod(null)
    setErr(null)
    if (!game?.ready) return
    let alive = true
    loadGame(game.id).then(
      (m) => alive && setMod(() => m.default),
      (e) => alive && setErr(`Could not load ${game.title}: ${e.message}`),
    )
    return () => {
      alive = false
    }
  }, [game?.id, game?.ready])
  useEffect(() => {
    if (game) document.title = game.use_case ? `${game.title} · ${game.use_case} · JEV-Arcade` : `${game.title} · JEV-Arcade`
  }, [game?.title, game?.use_case])

  let body
  if (games.error) body = html`<p class="g-t-err g-pad">${games.error.message}</p>`
  else if (!games.data) body = html`<${Loading} what="Reading the floor…" />`
  else if (!game) body = html`<p class="g-pad">There is no cabinet called “${route.game}”. <a href="./">Back to the floor</a></p>`
  else if (!game.ready) body = html`<${Soon} game=${game} />`
  else if (err) body = html`<p class="g-t-err g-pad">${err}</p>`
  else if (!mod) body = html`<${Loading} what=${game.title} />`
  else {
    const Page = mod
    body = html`<${Page} game=${game} runId=${route.run} />`
  }
  return html`<main class="g-main scroll-y g-gameview" style=${{ '--acc': accentOf(route.game) }}>${body}<${SiteFooter} /></main>`
}

/** The Arcade: the header, then the floor or a game. */
export function Arcade({ route }) {
  const games = useGames()
  const crumb = route.view === 'game' ? games.byId.get(route.game)?.title : null
  return html`
    <div class="app">
      <${SiteHeader} active="arcade" crumb=${crumb} />
      ${route.view === 'game' ? html`<${GameView} route=${route} />` : html`<${Hub} />`}
    </div>
  `
}
