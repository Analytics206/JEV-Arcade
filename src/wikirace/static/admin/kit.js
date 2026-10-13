/* The admin pages' shared parts: reading an admin endpoint, a pager, a
 * segmented choice, a stat tile. */
import { h } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { api } from '../api.js'
import { fmtInt } from './format.js'

const html = htm.bind(h)

/* A 401 from any admin endpoint means the session ended (expired, signed out
 * elsewhere, a new password): the shell goes back to the sign-in form. */
let signedOut = () => {}
export const onSignedOut = (f) => {
  signedOut = f
}

/** Read *path* (under /api), again whenever it changes or on reload(). */
export function useAdmin(path) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    const ac = new AbortController()
    setLoading(true)
    api.get(path, ac.signal).then(
      (r) => {
        setData(r)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (ac.signal.aborted) return
        if (e.status === 401) signedOut()
        setError(e)
        setLoading(false)
      },
    )
    return () => ac.abort()
  }, [path, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

export function Pager({ page, per, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / per))
  if (pages <= 1) return null
  return html`
    <nav class="ad-pager" aria-label="Pages">
      <button type="button" class="btn btn--sm btn--ghost" disabled=${page <= 1} onClick=${() => onPage(page - 1)}>Newer</button>
      <span class="ad-pager__at tnum">Page ${fmtInt(page)} of ${fmtInt(pages)} · ${fmtInt(total)} rows</span>
      <button type="button" class="btn btn--sm btn--ghost" disabled=${page >= pages} onClick=${() => onPage(page + 1)}>Older</button>
    </nav>
  `
}

/** One choice of a few, as pressed buttons. */
export function Seg({ label, value, options, onChange }) {
  return html`
    <div class="ad-seg" role="group" aria-label=${label}>
      ${options.map(
        ([k, text]) => html`
          <button type="button" key=${k} class=${`ad-seg__b${value === k ? ' is-on' : ''}`} aria-pressed=${value === k}
            onClick=${() => onChange(k)}>${text}</button>
        `,
      )}
    </div>
  `
}

export function Stat({ label, value, sub }) {
  return html`
    <div class="ad-stat">
      <span class="ad-stat__k">${label}</span>
      <span class="ad-stat__v tnum">${value}</span>
      ${sub && html`<span class="ad-stat__sub">${sub}</span>`}
    </div>
  `
}
