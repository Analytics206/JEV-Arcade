/* The page-view beacon: what only the browser knows about this visit, sent
 * once per page load to POST /api/beacon (docs/traffic.md).
 *
 * Screen and window size, pixel ratio, time zone and how long the page took to
 * load. No cookie and no identifier: the server adds these to the beacon's own
 * row in the traffic log, which already has the address. A beacon describes a
 * page view the log has already counted, so no total counts it again.
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
  return {
    sw: int(s.width),
    sh: int(s.height),
    vw: int(w.innerWidth),
    vh: int(w.innerHeight),
    dpr: Number.isFinite(w.devicePixelRatio) ? Math.round(w.devicePixelRatio * 100) / 100 : 0,
    tz: tz.slice(0, 64),
    load_ms: load > 0 ? Math.min(Math.round(load), 600000) : null,
    view: (w.location?.search ?? '').slice(0, 300),
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
