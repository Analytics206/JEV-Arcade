/* The sign-in log: every admin sign-in, sign-out and failed attempt, and below
 * it what the admin did. Verified and unverified rows are kept apart: a
 * failed attempt's email is only what someone typed. */
import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { countryName, fmtInt, fmtWhen, query } from './format.js'
import { Pager, Seg, useAdmin } from './kit.js'

const html = htm.bind(h)

const EVENTS = { signed_in: 'Signed in', signed_out: 'Signed out', sign_in_failed: 'Sign-in failed' }
const ACTIONS = { enquiry_handled: 'Marked an enquiry handled', enquiry_reopened: 'Marked an enquiry waiting', enquiry_deleted: 'Deleted an enquiry' }

function Audit() {
  const { data, error } = useAdmin('/admin/audit?limit=50')
  return html`
    <section class="panel ad-panel" aria-labelledby="ad-audit-title">
      <div class="panel__hd"><h2 class="panel__title" id="ad-audit-title">What the admin did</h2></div>
      <div class="panel__bd panel__bd--flush">
        ${error && html`<p class="ad-error" role="alert">${error.message}</p>`}
        ${data && !data.rows.length && html`<p class="ad-none">Nothing yet.</p>`}
        ${data?.rows?.length > 0 &&
        html`
          <div class="scroll-x">
            <table class="ad-table">
              <thead><tr><th scope="col">Time</th><th scope="col">Who</th><th scope="col">What</th><th scope="col">Which</th><th scope="col">Detail</th></tr></thead>
              <tbody>
                ${data.rows.map(
                  (r) => html`
                    <tr key=${r.id}>
                      <td class="ad-nowrap">${fmtWhen(r.ts, { seconds: true })}</td>
                      <td>${r.email}</td>
                      <td>${ACTIONS[r.action] ?? r.action}</td>
                      <td>${r.subject}</td>
                      <td>${r.detail}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `}
      </div>
    </section>
  `
}

export function SignIns() {
  const [verified, setVerified] = useState('all')
  const [page, setPage] = useState(1)
  const { data, error } = useAdmin(`/admin/signins${query({ verified, page, per: 50 })}`)
  const c = data?.counts
  return html`
    <div class="ad-report">
      <section class="panel ad-panel" aria-labelledby="ad-si-title">
        <div class="panel__hd">
          <h2 class="panel__title" id="ad-si-title">Sign-ins</h2>
          ${c && html`<span class="ad-count tnum">${fmtInt(c.sign_ins)} sign-ins · ${fmtInt(c.unverified)} failed</span>`}
          <span class="panel__gap" />
          <${Seg} label="Which rows" value=${verified} onChange=${(v) => { setVerified(v); setPage(1) }}
            options=${[['all', `All ${c ? fmtInt(c.all) : ''}`], ['yes', `Verified ${c ? fmtInt(c.verified) : ''}`], ['no', `Unverified ${c ? fmtInt(c.unverified) : ''}`]]} />
        </div>
        <div class="panel__bd">
          <p class="ad-note">
            <b>Verified</b> rows are ones the server checked: a sign-in with the right email and password, or a sign-out
            of a live session. <b>Unverified</b> rows are failed attempts: the email is only what someone typed. It says
            someone is trying that address, not that its owner did. Attempts refused by the rate limit are not here; they
            are in the traffic log as 429s on <code>/api/admin/login</code>.
          </p>
          ${error && html`<p class="ad-error" role="alert">${error.message}</p>`}
          ${data && !data.rows.length && html`<p class="ad-none">No sign-ins yet.</p>`}
        </div>
        ${data?.rows?.length > 0 &&
        html`
          <div class="scroll-x">
            <table class="ad-table">
              <thead>
                <tr>
                  <th scope="col">Time</th><th scope="col">Event</th><th scope="col">Checked</th><th scope="col">Email</th>
                  <th scope="col">Address</th><th scope="col">Where</th><th scope="col">Browser · system · device</th>
                  <th scope="col">Session</th><th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                ${data.rows.map(
                  (r) => html`
                    <tr key=${r.id} class=${r.verified ? '' : 'is-unverified'}>
                      <td class="ad-nowrap">${fmtWhen(r.ts, { seconds: true })}</td>
                      <td class="ad-nowrap">${EVENTS[r.event] ?? r.event}</td>
                      <td>${r.verified ? html`<span class="badge badge--ok">verified</span>` : html`<span class="badge badge--warn">unverified</span>`}</td>
                      <td class="ad-email">${r.verified ? r.email : html`<span class="ad-typed" title="What was typed; not checked">${r.email || '(empty)'}</span>`}</td>
                      <td class="ad-mono">${r.ip}</td>
                      <td>${[r.city, r.country && countryName(r.country)].filter(Boolean).join(', ')}</td>
                      <td title=${r.user_agent}>${[r.browser, r.os, r.device].filter(Boolean).join(' · ')}</td>
                      <td class="ad-mono">${r.session}</td>
                      <td>${r.reason}${r.expires_at ? `${r.reason ? ' · ' : ''}until ${fmtWhen(r.expires_at)}` : ''}</td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          </div>
        `}
        ${data && html`<div class="panel__bd"><${Pager} page=${page} per=${data.per} total=${data.total} onPage=${setPage} /></div>`}
      </section>
      <${Audit} />
    </div>
  `
}
