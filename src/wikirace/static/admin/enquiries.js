/* Enquiries: the copies the Contact page keeps, as a panel at the top of the
 * admin's first page. Newest first; waiting, handled or all; each with its
 * whole message, a reply by email, mark handled, and delete. */
import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { api } from '../api.js'
import { countryName, fmtWhen, query, replyHref } from './format.js'
import { Pager, useAdmin } from './kit.js'

const html = htm.bind(h)
const LONG = 600

function Enquiry({ e, onChange, onError }) {
  const [open, setOpen] = useState(e.message.length <= LONG)
  const [busy, setBusy] = useState(false)
  const act = async (fn) => {
    setBusy(true)
    try {
      await fn()
      onChange()
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }
  const handled = e.status === 'handled'
  const toggle = () => act(() => api.post(`/admin/enquiries/${e.id}/handled`, { handled: !handled }))
  const remove = () => {
    if (!confirm(`Delete the enquiry from ${e.email}? This cannot be undone.`)) return
    act(() => api.del(`/admin/enquiries/${e.id}`))
  }
  return html`
    <li class=${`ad-enq${handled ? ' is-handled' : ''}`}>
      <div class="ad-enq__hd">
        <b class="ad-enq__name">${e.name || '(no name)'}</b>
        <span class="ad-enq__email">${e.email}</span>
        <span class="spacer" />
        <span class=${`badge${handled ? ' badge--ok' : ' badge--warn'}`}>${handled ? 'handled' : 'waiting'}</span>
        <time class="ad-enq__when" datetime=${e.created_at}>${fmtWhen(e.created_at)}</time>
      </div>
      <p class=${`ad-enq__msg${open ? '' : ' is-cut'}`}>${open ? e.message : `${e.message.slice(0, LONG)}…`}</p>
      ${e.message.length > LONG &&
      html`<button type="button" class="ad-linkish" onClick=${() => setOpen(!open)}>${open ? 'Show less' : 'Show the whole message'}</button>`}
      <div class="ad-enq__ft">
        <span class="ad-enq__meta">
          ${[e.country && countryName(e.country), e.ip].filter(Boolean).join(' · ')}
          ${handled && e.handled_at ? ` · handled ${fmtWhen(e.handled_at)}` : ''}
        </span>
        <span class="spacer" />
        <a class="btn btn--sm btn--secondary" href=${replyHref(e.email, e.name)}>Reply by email</a>
        <button type="button" class="btn btn--sm btn--ghost" disabled=${busy} onClick=${toggle}>
          ${handled ? 'Mark waiting' : 'Mark handled'}
        </button>
        <button type="button" class="btn btn--sm btn--danger" disabled=${busy} onClick=${remove}>Delete</button>
      </div>
    </li>
  `
}

export function EnquiriesPanel() {
  const [status, setStatus] = useState('waiting')
  const [page, setPage] = useState(1)
  const [actionError, setActionError] = useState(null)
  const { data, error, reload } = useAdmin(`/admin/enquiries${query({ status, page, per: 10 })}`)
  const counts = data?.counts ?? { waiting: 0, handled: 0, all: 0 }
  const pick = (s) => {
    setStatus(s)
    setPage(1)
  }
  return html`
    <section class="panel ad-panel" aria-labelledby="ad-enq-title">
      <div class="panel__hd">
        <h2 class="panel__title" id="ad-enq-title">Enquiries</h2>
        <span class="ad-count tnum">${counts.waiting} waiting</span>
        <span class="panel__gap" />
        <div class="ad-seg" role="group" aria-label="Which enquiries">
          ${[['waiting', 'Waiting'], ['handled', 'Handled'], ['all', 'All']].map(
            ([k, label]) => html`
              <button type="button" key=${k} class=${`ad-seg__b${status === k ? ' is-on' : ''}`} aria-pressed=${status === k}
                onClick=${() => pick(k)}>${label} <span class="tnum">${counts[k]}</span></button>
            `,
          )}
        </div>
      </div>
      <div class="panel__bd">
        <p class="ad-note">
          Copies of what visitors sent from the Contact page. The visitor's own email is what reaches you: a copy here
          may never have been sent as an email.
        </p>
        ${(error || actionError) && html`<p class="ad-error" role="alert">${(actionError ?? error).message}</p>`}
        ${data && !data.rows.length && html`<p class="ad-none">${status === 'waiting' ? 'Nothing waiting.' : 'No enquiries here.'}</p>`}
        ${data?.rows?.length > 0 &&
        html`<ul class="ad-enqs">
          ${data.rows.map((e) => html`<${Enquiry} key=${e.id} e=${e} onChange=${() => { setActionError(null); reload() }} onError=${setActionError} />`)}
        </ul>`}
        ${data && html`<${Pager} page=${page} per=${data.per} total=${data.total} onPage=${setPage} />`}
      </div>
    </section>
  `
}
