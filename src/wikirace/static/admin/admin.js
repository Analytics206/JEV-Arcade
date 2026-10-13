/* The admin pages (/admin): sign in, then the traffic report (with the
 * enquiries above it) or the sign-in log. Nothing on the public site links
 * here; the server checks the session on every request either way.
 *
 *   /admin                 enquiries, then the traffic report
 *   /admin?view=signins    the sign-in log, and what the admin did
 */
import { h, render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { api } from '../api.js'
import { Wordmark } from '../brand.js'
import { EnquiriesPanel } from './enquiries.js'
import { fmtWhen } from './format.js'
import { onSignedOut } from './kit.js'
import { SignIns } from './signins.js'
import { TrafficReport } from './traffic.js'

const html = htm.bind(h)

const VIEWS = [['traffic', 'Traffic'], ['signins', 'Sign-ins']]
const viewOf = (search) => (new URLSearchParams(search).get('view') === 'signins' ? 'signins' : 'traffic')

function SignIn({ onIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onIn(await api.post('/admin/login', { email, password }))
    } catch (err) {
      setError(err.message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }
  return html`
    <main class="ad-main scroll-y">
      <form class="panel ad-signin" onSubmit=${submit}>
        <div class="panel__hd"><h1 class="panel__title">Admin sign-in</h1></div>
        <div class="panel__bd ad-signin__bd">
          <label class="ad-f"><span>Email</span>
            <input class="wr-in" type="email" autocomplete="username" required value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} />
          </label>
          <label class="ad-f"><span>Password</span>
            <input class="wr-in" type="password" autocomplete="current-password" required value=${password}
              onInput=${(e) => setPassword(e.currentTarget.value)} />
          </label>
          ${error && html`<p class="ad-error" role="alert">${error}</p>`}
          <button type="submit" class="btn btn--primary" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
        </div>
      </form>
    </main>
  `
}

function Header({ me, view, go, onOut }) {
  return html`
    <header class="hd">
      <div class="hd__bar">
        <a class="hd__brand" href="/" title="The public site"><${Wordmark} /></a>
        <p class="hd__crumb"><span class="hd__sep" aria-hidden="true">/</span>Admin</p>
        <span class="spacer" />
        ${me &&
        html`
          <nav class="hd__nav" aria-label="Admin">
            ${VIEWS.map(
              ([id, label]) => html`
                <a key=${id} href=${id === 'traffic' ? '/admin' : `/admin?view=${id}`}
                  class=${`hd__link${view === id ? ' hd__link--on' : ''}`} aria-current=${view === id ? 'page' : undefined}
                  onClick=${(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return
                    e.preventDefault()
                    go(id)
                  }}>${label}</a>
              `,
            )}
          </nav>
          <span class="ad-me" title=${`Signed in until ${fmtWhen(me.expires_at)}`}>${me.email}</span>
          <button type="button" class="btn btn--sm btn--ghost" onClick=${onOut}>Sign out</button>
        `}
      </div>
    </header>
  `
}

function Admin() {
  const [me, setMe] = useState(undefined) // undefined: asking; null: signed out
  const [view, setView] = useState(viewOf(location.search))
  useEffect(() => {
    onSignedOut(() => setMe(null))
    api.get('/admin/me').then(setMe, () => setMe(null))
    const onPop = () => setView(viewOf(location.search))
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  useEffect(() => {
    document.title = `${view === 'signins' ? 'Sign-ins' : 'Traffic'} · Admin · JEV-Arcade`
  }, [view])
  const go = (id) => {
    history.pushState(null, '', id === 'traffic' ? '/admin' : `/admin?view=${id}`)
    setView(id)
  }
  const signOut = async () => {
    await api.post('/admin/logout').catch(() => {})
    setMe(null)
  }
  const signedIn = async () => setMe(await api.get('/admin/me').catch(() => null))
  return html`
    <div class="app">
      <${Header} me=${me} view=${view} go=${go} onOut=${signOut} />
      ${me === undefined && html`<main class="ad-main"><p class="ad-none">Checking…</p></main>`}
      ${me === null && html`<${SignIn} onIn=${signedIn} />`}
      ${me &&
      html`
        <main class="ad-main scroll-y">
          <div class="ad-in">
            ${view === 'signins'
              ? html`<${SignIns} />`
              : html`<${EnquiriesPanel} /><${TrafficReport} />`}
            <p class="ad-foot">
              The traffic and sign-in logs keep ${me.retention_days} days (WIKIRACE_LOG_RETENTION_DAYS); enquiries are
              kept until you delete them.${me.traffic_log ? '' : me.traffic_problem
                ? ` The traffic log is off: it could not open ${me.traffic_problem}.`
                : ' The traffic log is off (WIKIRACE_TRAFFIC_LOG).'}
            </p>
          </div>
        </main>
      `}
    </div>
  `
}

render(html`<${Admin} />`, document.getElementById('app'))
