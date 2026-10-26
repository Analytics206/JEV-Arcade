/* The page-view beacon: what only the browser knows about this visit, sent
 * once per page load to POST /api/beacon (docs/traffic.md).
 *
 * Screen and window size, pixel ratio, time zone, how long the page took to
 * load, the colour scheme the visitor prefers, the connection type the browser
 * estimates (where it says), and whether the screen takes touch: the same
 * fields every other site's beacon sends. No cookie and no identifier: the
 * server adds these to the beacon's own row in the traffic log, which already
 * has the address. A beacon describes a page view the log has already counted,
 * so no total counts it again.
 */

/** The beacon's fields, read from *w* (a window). */
export function beaconPayload(w) {
  const s = w.screen ?? {}
  let tz = ''
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    tz = ''
  }
  const nav = w.performance?.getEntriesByType?.('navigation')?.[0]
  const load = nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.duration : 0
  const int = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  let cs = ''
  try {
    const dark = w.matchMedia?.('(prefers-color-scheme: dark)')
    cs = dark ? (dark.matches ? 'dark' : 'light') : ''
  } catch {
    cs = ''
  }
  const net = w.navigator?.connection?.effectiveType
  const touch = w.navigator?.maxTouchPoints > 0 || 'ontouchstart' in w ? '1' : '0'
  return {
    sw: int(s.width),
    sh: int(s.height),
    vw: int(w.innerWidth),
    vh: int(w.innerHeight),
    dpr: Number.isFinite(w.devicePixelRatio) ? Math.round(w.devicePixelRatio * 100) / 100 : 0,
    tz: tz.slice(0, 64),
    load_ms: load > 0 ? Math.min(Math.round(load), 600000) : null,
    view: (w.location?.search ?? '').slice(0, 300),
    cs,
    net: typeof net === 'string' ? net.slice(0, 16) : '',
    touch,
  }
}

/** Send the beacon once the page has loaded. */
export function reportView(w = window) {
  const send = () =>
    setTimeout(() => {
      const body = JSON.stringify(beaconPayload(w))
      try {
        if (w.navigator?.sendBeacon?.('/api/beacon', body)) return
      } catch {
        /* fall through to fetch */
      }
      w.fetch?.('/api/beacon', { method: 'POST', body, keepalive: true }).catch(() => {})
    }, 0)
  if (w.document?.readyState === 'complete') send()
  else w.addEventListener('load', send, { once: true })
}
