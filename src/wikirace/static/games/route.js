/* Where the page is: which view the address names.
 *
 *   (no query), ?tab=arcade                the Arcade's floor: every cabinet
 *   ?tab=race, ?race=<id>, ?tab=history    WikiRace: the setup, a race, its history
 *   ?game=<id>                             one game, set up to play
 *   ?game=<id>&run=<run id>                one game's run, live or replayed
 *
 * The floor keeps the bare address: JEV-Arcade opens on its cabinets.
 * `?tab=arcade` still names it, and every WikiRace link that carries a race or
 * the history still lands on WikiRace. `navigate` pushes an entry and tells the
 * page, so the back button walks through games the way it walks through races.
 */

const GAME_ID = /^[a-z][a-z0-9]{1,23}$/
const RUN_ID = /^[a-f0-9]{6,32}$/

/** @returns {{view: 'wikirace'} | {view: 'hub'} | {view: 'game', game: string, run: string|null}} */
export function parseRoute(search) {
  const q = new URLSearchParams(search)
  const game = q.get('game')
  if (game && GAME_ID.test(game)) {
    const run = q.get('run')
    return { view: 'game', game, run: run && RUN_ID.test(run) ? run : null }
  }
  const tab = q.get('tab')
  if (q.get('race') || tab === 'race' || tab === 'history') return { view: 'wikirace' }
  return { view: 'hub' }
}

/** …and back: the query string for a place. */
export function routeSearch(route) {
  if (route.view === 'wikirace') return '?tab=race'
  if (route.view === 'game') {
    const q = new URLSearchParams({ game: route.game })
    if (route.run) q.set('run', route.run)
    return `?${q}`
  }
  return ''
}

/** Go to *search* (a query string), as a new history entry. */
export function navigate(search) {
  if (search !== location.search) history.pushState(null, '', `${location.pathname}${search}`)
  dispatchEvent(new PopStateEvent('popstate'))
  window.scrollTo?.(0, 0)
}

export const toHub = () => navigate('')
export const toGame = (game, run = null) => navigate(routeSearch({ view: 'game', game, run }))
