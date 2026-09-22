/* Where the page is, for the Arcade: which view the address names.
 *
 *   (no query), ?race=<id>, ?tab=history   WikiRace, exactly as before
 *   ?tab=arcade                            the Arcade: every game
 *   ?game=<id>                             one game, set up to play
 *   ?game=<id>&run=<run id>                one game's run, live or replayed
 *
 * WikiRace keeps the bare address, so every link to it that already exists
 * still lands where it did. `navigate` pushes an entry and tells the page, so
 * the back button walks through games the way it walks through races.
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
  if (q.get('tab') === 'arcade') return { view: 'hub' }
  return { view: 'wikirace' }
}

/** …and back: the query string for a place. */
export function routeSearch(route) {
  if (route.view === 'hub') return '?tab=arcade'
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

export const toHub = () => navigate('?tab=arcade')
export const toGame = (game, run = null) => navigate(routeSearch({ view: 'game', game, run }))
