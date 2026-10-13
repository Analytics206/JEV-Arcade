/* The admin pages' formatting, apart from their look, so Node can test it.
 *
 * Everything the admin pages show was written by strangers (paths, user
 * agents, emails, messages). It is rendered as text by Preact, never as
 * markup, and the only links built from it are mailto: replies, whose address
 * is encoded here.
 */

export const nf = new Intl.NumberFormat('en-US')

export const fmtInt = (n) => (n == null ? '–' : nf.format(n))

export function fmtBytes(n) {
  if (n == null) return '–'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i += 1
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[i]}`
}

export function fmtMs(ms) {
  if (ms == null) return '–'
  if (ms < 1) return '<1 ms'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`
}

/** An ISO time from the server, in the reader's own time zone. */
export function fmtWhen(iso, { seconds = false } = {}) {
  if (!iso) return '–'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
  })
}

/** A chart bucket (`2026-10-13T09` or `2026-10-13`, UTC) as a short label. */
export function bucketLabel(t, hourly) {
  const d = new Date(hourly ? `${t}:00:00Z` : `${t}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return t
  return hourly
    ? d.toLocaleString('en-US', { hour: 'numeric', timeZone: 'UTC' }) + ' UTC'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

let regions = null
/** A country's name from its two-letter code; the code when it has none. */
export function countryName(code) {
  if (!code) return 'Unknown'
  if (code === 'XX') return 'Unknown'
  if (code === 'T1') return 'Tor'
  try {
    regions ??= new Intl.DisplayNames(['en'], { type: 'region' })
    return regions.of(code) ?? code
  } catch {
    return code
  }
}

/** A query string from *params*, leaving out what is empty. */
export function query(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== '' && v != null) q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** A reply to an enquiry: the sender's address encoded, so whatever they typed
 *  can only ever be an address in a mailto: link. */
export function replyHref(email, name = '') {
  const subject = 'Re: your message to JEV-Arcade'
  const greet = name.trim() ? `Hi ${name.trim()},\n\n` : ''
  return `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(greet)}`
}

/** A status code's class, for its badge. */
export function statusTone(status) {
  if (status >= 500) return 'err'
  if (status >= 400) return 'warn'
  if (status >= 300) return ''
  return 'ok'
}

/** The longest of *values*, at least 1, for scaling bars. */
export const maxOf = (values) => Math.max(1, ...values)
