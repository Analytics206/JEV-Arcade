/* The page's client for the WikiRace server (docs/design.md, "HTTP API").
 *
 * Everything is under /api and nothing is authenticated — the server binds to
 * localhost — so there is no token handling here and none should be added. A
 * failed request throws an ApiError carrying the server's own `detail`, which is
 * written to be read by a person, so the page shows it as it came.
 */
import { useCallback, useEffect, useState } from 'preact/hooks'
import { applyEvent, detailOf } from './state.js'

export const API = '/api'

export class ApiError extends Error {
  constructor(status, url, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.url = url
  }
}

async function request(path, init = {}) {
  const url = API + path
  let resp
  try {
    resp = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } })
  } catch {
    // A dead server and a refused connection look identical here; say so plainly
    // rather than surfacing "Failed to fetch".
    throw new ApiError(0, url, `Could not reach the WikiRace server at ${url}`)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new ApiError(resp.status, url, detailOf(body, `${resp.status} ${resp.statusText}`))
  }
  if (resp.status === 204) return undefined
  return resp.json()
}

const json = (method, body, signal) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
  signal,
})

export const api = {
  get: (path, signal) => request(path, { method: 'GET', signal }),
  post: (path, body, signal) => request(path, json('POST', body, signal)),
  del: (path, signal) => request(path, { method: 'DELETE', signal }),
}

/**
 * Poll one endpoint. `refreshMs` 0 reads it once (and on reload()).
 *
 * Every part of the page owns its own request rather than sharing a store, so a
 * slow or failing endpoint degrades one part — the history, say — and not the page.
 * @returns {{data: any, error: Error|null, loading: boolean, reload: () => void}}
 */
export function useEndpoint(path, refreshMs = 20_000) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)
  // Bumped by reload(). A view that CHANGES the thing it is polling — deleting a
  // race, say — must not show the stale list until the next tick.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ac = new AbortController()
    let alive = true

    const load = async () => {
      try {
        const r = await api.get(path, ac.signal)
        if (!alive) return
        setData(r)
        setError(null)
      } catch (e) {
        if (!alive || ac.signal.aborted) return
        setError(e instanceof Error ? e : new Error(String(e)))
      } finally {
        if (alive) setLoading(false)
      }
    }

    void load()
    const t = refreshMs > 0 ? setInterval(load, refreshMs) : undefined
    return () => {
      alive = false
      ac.abort()
      if (t) clearInterval(t)
    }
  }, [path, refreshMs, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, reload }
}

/** The frame types a race stream carries. The server sends them as plain `data:`
 *  frames with the type inside; they are also listened for by name, so a server
 *  that names its events (`event: step`) is read the same way. */
const FRAME_TYPES = ['snapshot', 'lane', 'step', 'race', 'end']

/**
 * Attach to a race: its snapshot, then every change, through the reducer — until
 * the `end` frame, when the stream is closed here, before the server's close could
 * make EventSource reconnect and replay the whole race again.
 *
 * A dropped connection heals by itself: EventSource reconnects, and every
 * connection opens with a snapshot, so nothing is lost in the gap. A refused one
 * (an unknown race, a server error) is asked about with a plain GET, which says
 * why — and when the race is there and over, is the whole replay anyway.
 * @returns {{race: object|null, error: string|null, reconnect: () => void}}
 */
export function useRaceStream(raceId) {
  const [race, setRace] = useState(null)
  const [error, setError] = useState(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setRace(null)
    setError(null)
    if (!raceId) return
    const path = `/races/${encodeURIComponent(raceId)}`
    const es = new EventSource(`${API}${path}/events`)
    let current = null
    let over = false // `end` was read, or the server refused: the stream is done with
    let gone = false // this effect was cleaned up: set no more state

    const onFrame = (e) => {
      if (over || gone) return
      let ev
      try {
        ev = JSON.parse(e.data)
      } catch {
        return
      }
      if (!ev || typeof ev !== 'object') return
      current = applyEvent(current, ev)
      setRace(current)
      setError(null)
      if (ev.type === 'end') {
        over = true
        es.close()
      }
    }

    es.onmessage = onFrame
    for (const t of FRAME_TYPES) es.addEventListener(t, onFrame)
    es.onerror = () => {
      if (over || gone) return
      if (es.readyState !== EventSource.CLOSED) {
        setError('Lost the race stream — reconnecting…')
        return
      }
      over = true
      api.get(path).then(
        (r) => {
          if (gone) return
          if (r && r.status !== 'running') {
            setRace(r)
            setError(null)
          } else {
            setError('The race stream closed before the race ended.')
          }
        },
        (err) => {
          if (!gone) setError(err.message)
        },
      )
    }

    return () => {
      gone = true
      es.close()
    }
  }, [raceId, nonce])

  const reconnect = useCallback(() => setNonce((n) => n + 1), [])
  return { race, error, reconnect }
}
