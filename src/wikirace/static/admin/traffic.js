/* The traffic report: a period and an audience, the totals, page views and
 * visitors over time, the top lists, then the request log itself, with
 * filters, each row's every field, pages, and a CSV of what is filtered.
 *
 * A visitor is an address that loaded a page: there is no cookie, so two
 * people behind one address are one visitor, and one person on two networks
 * is two. Beacon rows are in no total (traffic.py says why).
 */
import { h } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'
import { API } from '../api.js'
import { BarList, Series } from './chart.js'
import { countryName, fmtBytes, fmtInt, fmtMs, fmtWhen, query, statusTone } from './format.js'
import { Pager, Seg, Stat, useAdmin } from './kit.js'

const html = htm.bind(h)

const PERIODS = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['90d', '90 days'], ['365d', 'Year'], ['all', 'All']]
const WHO = [['people', 'People'], ['bots', 'Bots'], ['all', 'Everyone']]
const KINDS = [['', 'Every kind'], ['page', 'Page loads'], ['api', 'API'], ['asset', 'Files'], ['beacon', 'Beacons'], ['admin', 'Admin'], ['other', 'Other']]
const STATUSES = [['', 'Any status'], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['404', '404'], ['5xx', '5xx']]

function List({ title, children, wide }) {
  return html`
    <section class=${`panel ad-list${wide ? ' ad-list--wide' : ''}`}>
      <div class="panel__hd"><h3 class="panel__title">${title}</h3></div>
      <div class="panel__bd panel__bd--flush scroll-x">${children}</div>
    </section>
  `
}

function Addresses({ rows, onPick }) {
  if (!rows.length) return html`<p class="ad-none">Nothing in this period.</p>`
  return html`
    <table class="ad-bars">
      <thead><tr><th scope="col">Address</th><th scope="col">Country</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Page views</th><th scope="col">Last seen</th></tr></thead>
      <tbody>
        ${rows.map(
          (r) => html`
            <tr key=${r.ip}>
              <td><button type="button" class="ad-linkish ad-mono" onClick=${() => onPick(r.ip)}>${r.ip || '(none)'}</button>${r.bot && html` <span class="badge">bot</span>`}</td>
              <td>${countryName(r.country)}</td>
              <td class="num tnum">${fmtInt(r.n)}</td>
              <td class="num tnum">${fmtInt(r.page_views)}</td>
              <td class="ad-nowrap">${fmtWhen(r.last)}</td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  `
}

const DETAIL = [
  ['ts', 'Time (UTC)'], ['kind', 'Kind'], ['method', 'Method'], ['host', 'Host'], ['path', 'Path'], ['query', 'Query'],
  ['protocol', 'Protocol'], ['status', 'Status'], ['bytes', 'Bytes'], ['duration_ms', 'Time to answer (ms)'],
  ['ip', 'Address'], ['peer', 'Connected from'], ['forwarded_for', 'X-Forwarded-For'], ['country', 'Country'],
  ['continent', 'Continent'], ['region', 'Region'], ['region_code', 'Region code'], ['city', 'City'],
  ['postal_code', 'Postcode'], ['latitude', 'Latitude'], ['longitude', 'Longitude'], ['geo_timezone', 'Time zone (Cloudflare)'],
  ['colo', 'Cloudflare data centre'], ['ray', 'Ray ID'], ['referrer', 'Referrer'], ['user_agent', 'User agent'],
  ['browser', 'Browser'], ['browser_version', 'Browser version'], ['os', 'System'], ['device', 'Device'],
  ['bot_name', 'Bot'], ['language', 'Languages'], ['ch_ua', 'Sec-CH-UA'], ['ch_mobile', 'Sec-CH-UA-Mobile'],
  ['ch_platform', 'Sec-CH-UA-Platform'], ['fetch_site', 'Sec-Fetch-Site'], ['fetch_mode', 'Sec-Fetch-Mode'],
  ['fetch_dest', 'Sec-Fetch-Dest'], ['view', 'View (beacon)'], ['screen', 'Screen (beacon)'], ['viewport', 'Window (beacon)'],
  ['pixel_ratio', 'Pixel ratio (beacon)'], ['timezone', 'Time zone (beacon)'], ['load_ms', 'Load time, ms (beacon)'],
]

function Row({ r, open, onToggle }) {
  const who = r.is_bot ? r.bot_name || 'bot' : [r.browser, r.os, r.device].filter(Boolean).join(' · ')
  // Where a visitor came from: another site, not a page of this one.
  const from = r.ref_host && r.host.split(':')[0] !== r.ref_host ? r.ref_host : ''
  return html`
    <tr class=${`ad-req${open ? ' is-open' : ''}`} onClick=${onToggle}>
      <td class="ad-nowrap tnum">${fmtWhen(r.ts, { seconds: true })}</td>
      <td class="ad-mono">${r.ip}</td>
      <td>${r.country}</td>
      <td class="ad-mono">${r.method}</td>
      <td class="ad-path"><span class="ad-mono">${r.path}${r.query ? `?${r.query}` : ''}</span></td>
      <td><span class=${`badge${statusTone(r.status) ? ` badge--${statusTone(r.status)}` : ''}`}>${r.status}</span></td>
      <td class="num tnum">${fmtMs(r.duration_ms)}</td>
      <td class="ad-who">${r.is_bot ? html`<span class="badge">bot</span> ` : ''}${who}</td>
      <td class="ad-ref">${from}</td>
      <td class="ad-nowrap"><button type="button" class="ad-linkish" aria-expanded=${open} onClick=${(e) => { e.stopPropagation(); onToggle() }}>${open ? 'Less' : 'More'}</button></td>
    </tr>
    ${open &&
    html`
      <tr class="ad-req__detail">
        <td colspan="10">
          <dl class="ad-kv">
            ${DETAIL.filter(([k]) => r[k] !== '' && r[k] != null).map(
              ([k, label]) => html`<div key=${k}><dt>${label}</dt><dd class="ad-mono">${String(r[k])}</dd></div>`,
            )}
          </dl>
        </td>
      </tr>
    `}
  `
}

function RequestLog({ period, who, filters, setFilters }) {
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(null)
  const params = { period, who, ...filters }
  const { data, error, loading } = useAdmin(`/admin/traffic/requests${query({ ...params, page, per: 50 })}`)
  const set = (k) => (e) => {
    setFilters({ ...filters, [k]: e.currentTarget.value })
    setPage(1)
  }
  const clear = () => {
    setFilters({ kind: '', status: '', ip: '', path: '', country: '', q: '' })
    setPage(1)
  }
  return html`
    <section class="panel ad-panel" id="ad-log" aria-labelledby="ad-log-title">
      <div class="panel__hd">
        <h2 class="panel__title" id="ad-log-title">Request log</h2>
        ${data && html`<span class="ad-count tnum">${fmtInt(data.total)} rows</span>`}
        <span class="panel__gap" />
        <a class="btn btn--sm btn--secondary" href=${`${API}/admin/traffic/requests.csv${query(params)}`} download>Download CSV</a>
      </div>
      <div class="ad-filters">
        <label class="ad-f"><span>Kind</span>
          <select class="wr-sel" value=${filters.kind} onChange=${set('kind')}>${KINDS.map(([k, t]) => html`<option value=${k}>${t}</option>`)}</select>
        </label>
        <label class="ad-f"><span>Status</span>
          <select class="wr-sel" value=${filters.status} onChange=${set('status')}>${STATUSES.map(([k, t]) => html`<option value=${k}>${t}</option>`)}</select>
        </label>
        <label class="ad-f"><span>Address</span><input class="wr-in" value=${filters.ip} onChange=${set('ip')} placeholder="203.0.113.9" /></label>
        <label class="ad-f"><span>Path has</span><input class="wr-in" value=${filters.path} onChange=${set('path')} placeholder="/api/" /></label>
        <label class="ad-f ad-f--sm"><span>Country</span><input class="wr-in" value=${filters.country} onChange=${set('country')} placeholder="US" maxLength="8" /></label>
        <label class="ad-f ad-f--grow"><span>Search</span><input class="wr-in" type="search" value=${filters.q} onChange=${set('q')} placeholder="in path, query, user agent, referrer" /></label>
        <button type="button" class="btn btn--sm btn--ghost" onClick=${clear}>Clear</button>
      </div>
      <div class="panel__bd panel__bd--flush">
        ${error && html`<p class="ad-error" role="alert">${error.message}</p>`}
        ${data && !data.rows.length && html`<p class="ad-none">No requests match.</p>`}
        ${data?.rows?.length > 0 &&
        html`
          <div class="scroll-x">
            <table class=${`ad-table${loading ? ' is-loading' : ''}`}>
              <thead>
                <tr>
                  <th scope="col">Time</th><th scope="col">Address</th><th scope="col">Ctry</th><th scope="col">Method</th>
                  <th scope="col">Path</th><th scope="col">Status</th><th scope="col" class="num">Took</th>
                  <th scope="col">Browser · system · device</th><th scope="col">From</th><th scope="col"><span class="sr-only">Detail</span></th>
                </tr>
              </thead>
              <tbody>
                ${data.rows.map((r) => html`<${Row} key=${r.id} r=${r} open=${open === r.id} onToggle=${() => setOpen(open === r.id ? null : r.id)} />`)}
              </tbody>
            </table>
          </div>
          <${Pager} page=${page} per=${data.per} total=${data.total} onPage=${(p) => { setPage(p); setOpen(null) }} />
        `}
      </div>
    </section>
  `
}

export function TrafficReport() {
  const [period, setPeriod] = useState('7d')
  const [who, setWho] = useState('people')
  const [filters, setFilters] = useState({ kind: '', status: '', ip: '', path: '', country: '', q: '' })
  const { data, error, loading, reload } = useAdmin(`/admin/traffic${query({ period, who })}`)
  const t = data?.totals
  const bs = data?.browser_side
  const toLog = (patch) => {
    setFilters({ kind: '', status: '', ip: '', path: '', country: '', q: '', ...patch })
    document.getElementById('ad-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  return html`
    <div class="ad-report">
      <div class="ad-bar">
        <${Seg} label="Period" value=${period} options=${PERIODS} onChange=${setPeriod} />
        <${Seg} label="Who" value=${who} options=${WHO} onChange=${setWho} />
        <span class="spacer" />
        <button type="button" class="btn btn--sm btn--ghost" onClick=${reload} disabled=${loading}>${loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      ${error && html`<p class="ad-error" role="alert">${error.message}</p>`}
      ${t &&
      html`
        <div class="ad-stats">
          <${Stat} label="Page views" value=${fmtInt(t.page_views)} sub="loads of the page" />
          <${Stat} label="Visitors" value=${fmtInt(t.visitors)} sub="addresses that loaded it" />
          <${Stat} label="Requests" value=${fmtInt(t.requests)} sub=${`${fmtInt(t.addresses)} addresses`} />
          <${Stat} label="Bot requests" value=${fmtInt(t.bot_requests)} sub=${who === 'people' ? 'hidden: showing people' : 'of these requests'} />
          <${Stat} label="Errors" value=${`${fmtInt(t.client_errors)} · ${fmtInt(t.server_errors)}`} sub="4xx · 5xx" />
          <${Stat} label="Median answer" value=${fmtMs(t.median_ms)} sub=${`${fmtBytes(t.bytes)} sent`} />
          <${Stat} label="Median load" value=${fmtMs(bs?.median_load_ms)} sub=${`from ${fmtInt(bs?.beacons)} beacons`} />
        </div>
        <section class="panel ad-panel">
          <div class="panel__hd"><h2 class="panel__title">Over time</h2><span class="ad-count">${data.hourly ? 'by hour, UTC' : 'by day, UTC'}</span></div>
          <div class="panel__bd"><${Series} series=${data.series} hourly=${data.hourly} /></div>
        </section>
        <div class="ad-lists">
          <${List} title="Pages" wide><${BarList} rows=${data.pages} unit="Views" onPick=${(p) => toLog({ path: p.split('?')[0], kind: 'page' })} /><//>
          <${List} title="Referrers"><${BarList} rows=${data.referrers} unit="Views" empty="No other site sent anyone." /><//>
          <${List} title="Countries"><${BarList} rows=${data.countries} unit="Views" format=${countryName} onPick=${(c) => toLog({ country: c })} empty="No country: Cloudflare adds it." /><//>
          <${List} title="Browsers"><${BarList} rows=${data.browsers} unit="Views" /><//>
          <${List} title="Systems"><${BarList} rows=${data.systems} unit="Views" /><//>
          <${List} title="Devices"><${BarList} rows=${data.devices} unit="Views" /><//>
          <${List} title="Bots"><${BarList} rows=${data.bots} empty=${who === 'people' ? 'Showing people: pick Bots or Everyone.' : 'No bots in this period.'} onPick=${(b) => toLog({ q: b })} /><//>
          <${List} title="Not found (404)"><${BarList} rows=${data.not_found} onPick=${(p) => toLog({ path: p, status: '404' })} empty="No 404s." /><//>
          <${List} title="Screens (beacon)"><${BarList} rows=${bs.screens} unit="Views" /><//>
          <${List} title="Windows (beacon)"><${BarList} rows=${bs.viewports} unit="Views" /><//>
          <${List} title="Time zones (beacon)"><${BarList} rows=${bs.timezones} unit="Views" /><//>
          <${List} title="Busiest addresses" wide><${Addresses} rows=${data.addresses} onPick=${(ip) => toLog({ ip })} /><//>
        </div>
      `}
      <${RequestLog} period=${period} who=${who} filters=${filters} setFilters=${setFilters} />
    </div>
  `
}
