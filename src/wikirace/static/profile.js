/* What this browser has played: a count per cabinet, kept in localStorage.
 * The Arcade's floor shows it (a cabinet's "played" plate, the floor's
 * progress); nothing leaves the browser, and a browser that refuses storage
 * simply starts at zero every time.
 */
import { useEffect, useState } from 'preact/hooks'

const KEY = 'jev-arcade.plays'
const listeners = new Set()

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** Plays per game id: {chess: 3, …}. */
export const plays = () => read()

/** One more play of *id* (a game id, or `wikirace`). */
export function recordPlay(id) {
  const p = read()
  p[id] = (Number(p[id]) || 0) + 1
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    /* storage refused: nothing to remember */
  }
  listeners.forEach((f) => f(p))
}

/** Plays per game, as state that follows every new play. */
export function usePlays() {
  const [p, setP] = useState(read)
  useEffect(() => {
    listeners.add(setP)
    return () => listeners.delete(setP)
  }, [])
  return p
}
