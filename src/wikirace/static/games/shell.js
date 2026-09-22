/* The Arcade's shell: the page header every view shares, the hub of games, and
 * the view that loads one game's page.
 *
 * The header is WikiRace's own (brand, tagline, tabs), with a third tab: Race and
 * History go back to WikiRace; Arcade is here. WikiRace itself is untouched — it
 * renders its own header, with the same third tab.
 */
import { h } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { Badge, Spacer, Tabs, Toolbar } from '../ui.js'
import { Chip, GameFrame, Label, useGames } from './kit.js'
import { CARDS, THUMBS, cardOf, loadGame } from './registry.js'
import { navigate, toGame } from './route.js'

const html = htm.bind(h)

export const TABS = [
  ['race', 'Race'],
  ['history', 'History'],
  ['arcade', 'Arcade'],
]

/** Where each tab goes. */
export function goTab(tab) {
  if (tab === 'arcade') navigate('?tab=arcade')
  else if (tab === 'history') navigate('?tab=history')
  else navigate('')
}

function Header({ crumb }) {
  const home = (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate('')
  }
  return html`
    <header class="app-hd">
      <${Toolbar} class="app-hd__bar">
        <a class="app-brand" href="./" onClick=${home}><span aria-hidden="true">🏁</span> WikiRace</a>
        <p class="app-tag">${crumb ?? 'The Arcade: one judgment model, many games'}</p>
        <${Tabs} tabs=${TABS} value="arcade" onChange=${goTab} />
        <${Spacer} />
      <//>
    </header>
  `
}

/* ── The hub ───────────────────────────────────────────────────────────────── */

function WikiRaceCard() {
  return html`
    <a class="g-hero" href="./" onClick=${(e) => { e.preventDefault(); navigate('') }}>
      <svg class="g-hero__art" viewBox="0 0 420 150" aria-hidden="true">
        <g stroke="rgba(125,139,166,0.14)"><line x1="30" y1="20" x2="410" y2="20" /><line x1="30" y1="55" x2="410" y2="55" /><line x1="30" y1="90" x2="410" y2="90" /><line x1="30" y1="125" x2="410" y2="125" /></g>
        <path d="M30 125 H60 V112 H110 V98 H150 V84 H190 V70 H236 V56 H262" fill="none" stroke="var(--lane-1)" stroke-width="2.5" />
        <path d="M30 125 H90 V112 H170 V98 H260 V84 H320 V70 H350" fill="none" stroke="var(--lane-2)" stroke-width="2.5" />
        <path d="M30 125 H130 V112 H240 V98 H390" fill="none" stroke="var(--lane-3)" stroke-width="2.5" />
        <path d="M30 125 H200 V112 H300 V98" fill="none" stroke="var(--lane-4)" stroke-width="2.5" />
        <g transform="translate(250 38) scale(0.62)" fill="var(--lane-1)">
          <rect x="8" y="12" width="22" height="9.5" rx="4.75" />
          <path d="M23.6 15.6 C24.6 11 25.8 7.6 27.6 5.4 L33.2 6.6 C31.8 9.4 31 12.6 30.6 16 Z" />
          <path d="M26.4 4.4 C28 1.6 33.6 1.2 38.4 4.4 C40.6 5.9 41.2 8.4 39.6 9.8 C38.2 11 35.8 10.6 34 9.6 L28.6 7.8 C26.8 7.2 25.8 5.8 26.4 4.4 Z" />
          <path d="M8.6 13.6 C4.8 11.4 1.6 12.6 0.4 16.4 C2.6 15 4.6 15.4 5.8 17.4 C6.2 15.6 7.2 14.6 8.8 14.8 Z" />
          <path d="M13.2 20.4 L10.2 24.6 L6 26.8 M11.4 19.8 L7.4 22.6 L2.6 23.6 M27.2 20.2 L30.4 24.4 L34.6 26.6 M28.6 19.6 L32.6 22.4 L37.4 23.4" stroke="var(--lane-1)" stroke-width="2" fill="none" stroke-linecap="round" />
        </g>
      </svg>
      <div class="g-hero__body">
        <div class="g-hero__title">WikiRace <${Badge} tone="ok">the original<//></div>
        <p>Language models race across Wikipedia, link by link. Text models can name links that aren't on the page; Jev scores the real ones, so it can't foul.</p>
        <div class="g-hero__chips"><${Chip}>Choice over up to 255 links<//><${Chip}>5 providers on one track<//></div>
      </div>
      <span class="btn btn--primary g-hero__go">Race</span>
    </a>
  `
}

function GameCard({ card, game, big }) {
  const ready = game?.ready
  const Thumb = THUMBS[card.id]
  return html`
    <a class=${`g-card${big ? ' g-card--big' : ''}${ready ? '' : ' g-card--soon'}`} href=${`?game=${card.id}`}
      onClick=${(e) => { e.preventDefault(); toGame(card.id) }}>
      <span class=${big ? 'g-card__art' : 'g-card__icon'}>${Thumb && html`<${Thumb} />`}</span>
      <span class="g-card__title">${game?.title ?? card.id}</span>
      ${big && html`<span class="g-card__pitch">${card.pitch ?? game?.tagline}</span>`}
      <span class="g-card__foot">
        <span class="g-card__chip">${card.chip}</span>
        ${game && !ready && html`<${Badge} tone="warn">soon<//>`}
      </span>
    </a>
  `
}

export function Hub() {
  const games = useGames()
  useEffect(() => {
    document.title = 'Arcade · WikiRace'
  }, [])
  const main = CARDS.filter((c) => c.section === 'main')
  const quick = CARDS.filter((c) => c.section === 'quick')
  return html`
    <main class="g-main scroll-y">
      <div class="g-hub">
        <${Label} note="unchanged: it's still the front door">THE ORIGINAL<//>
        <${WikiRaceCard} />
        <${Label} note="each shows a different thing Jev does well">THE ARCADE<//>
        ${games.error && html`<p class="g-t-err">${games.error.message}</p>`}
        <div class="g-grid g-grid--main">
          ${main.map((c) => html`<${GameCard} key=${c.id} card=${c} game=${games.byId.get(c.id)} big />`)}
        </div>
        <${Label} note="small side games, one pattern each">QUICK HITS<//>
        <div class="g-grid g-grid--quick">
          ${quick.map((c) => html`<${GameCard} key=${c.id} card=${c} game=${games.byId.get(c.id)} />`)}
        </div>
      </div>
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
        <p class="g-muted">This game is still being built.</p>
      </div>
    <//>
  `
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
    if (game) document.title = `${game.title} · Arcade · WikiRace`
  }, [game?.title])

  let body
  if (games.error) body = html`<p class="g-t-err g-pad">${games.error.message}</p>`
  else if (!games.data) body = html`<p class="g-muted g-pad">Loading…</p>`
  else if (!game) body = html`<p class="g-pad">There is no game called “${route.game}”. <a href="?tab=arcade">Back to the Arcade</a></p>`
  else if (!game.ready) body = html`<${Soon} game=${game} />`
  else if (err) body = html`<p class="g-t-err g-pad">${err}</p>`
  else if (!mod) body = html`<p class="g-muted g-pad">Loading ${game.title}…</p>`
  else {
    const Page = mod
    body = html`<${Page} game=${game} runId=${route.run} />`
  }
  return html`<main class="g-main scroll-y">${body}</main>`
}

/** The Arcade: header, then the hub or a game. */
export function Arcade({ route }) {
  const games = useGames()
  const crumb = route.view === 'game' ? games.byId.get(route.game)?.title : null
  return html`
    <div class="app">
      <${Header} crumb=${crumb && `The Arcade · ${crumb}`} />
      ${route.view === 'game' ? html`<${GameView} route=${route} />` : html`<${Hub} />`}
    </div>
  `
}
