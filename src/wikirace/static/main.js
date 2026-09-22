/* The page's root: WikiRace, or the Arcade beside it.
 *
 * The address decides (games/route.js): the bare address, `?race=` and
 * `?tab=history` are WikiRace, exactly as before; `?tab=arcade` and `?game=`
 * are the Arcade. Both listen to the browser's history, so Back walks through
 * races and games alike.
 */
import { h, render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { WikiRace } from './app.js'
import { parseRoute } from './games/route.js'
import { Arcade } from './games/shell.js'

const html = htm.bind(h)

function Root() {
  const [search, setSearch] = useState(location.search)
  useEffect(() => {
    const onPop = () => setSearch(location.search)
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  const route = parseRoute(search)
  return route.view === 'wikirace' ? html`<${WikiRace} />` : html`<${Arcade} route=${route} />`
}

render(html`<${Root} />`, document.getElementById('app'))
