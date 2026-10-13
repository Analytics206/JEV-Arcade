/* The page's root: WikiRace, or the Arcade beside it.
 *
 * The address decides (games/route.js): the bare address, `?race=` and
 * `?tab=history` are WikiRace, exactly as before; `?tab=arcade` and `?game=`
 * are the Arcade; `?tab=contact` is the Contact page. All listen to the
 * browser's history, so Back walks through races and games alike.
 *
 * Once the page has loaded, the beacon (beacon.js) tells the traffic log what
 * only the browser knows: screen size, time zone, load time.
 */
import { h, render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { WikiRace } from './app.js'
import { reportView } from './beacon.js'
import { Contact } from './contact.js'
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
  if (route.view === 'wikirace') return html`<${WikiRace} />`
  if (route.view === 'contact') return html`<${Contact} />`
  return html`<${Arcade} route=${route} />`
}

render(html`<${Root} />`, document.getElementById('app'))
reportView()
