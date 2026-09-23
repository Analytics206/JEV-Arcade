/* The arcade's sounds: square-wave blips synthesised on the spot with Web Audio,
 * so nothing is downloaded. On unless the visitor mutes them (the header's
 * speaker); the choice is remembered in this browser only.
 *
 * Browsers keep a page silent until its first click or key press, so the audio
 * wakes on that first gesture; sounds asked for before it are simply skipped.
 * Every call is safe to make anywhere: with sound off, or no Web Audio, or a
 * browser that has not had a click yet, it does nothing.
 */

const KEY = 'jev-arcade.sound'
let on = read()
let ctx = null
let last = 0
const listeners = new Set()

function read() {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export const soundOn = () => on

export function setSound(v) {
  on = !!v
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* private mode: the choice lasts this page */
  }
  listeners.forEach((f) => f(on))
}

/** Call *f* with the new setting whenever it changes; returns the unsubscribe. */
export function onSound(f) {
  listeners.add(f)
  return () => listeners.delete(f)
}

function audio() {
  if (!on) return null
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/* The first click or key press is the browser's permission to play: make the
 * context then (resuming it if it was made earlier), and stop listening. */
function wake() {
  removeEventListener('pointerdown', wake, true)
  removeEventListener('keydown', wake, true)
  audio()
}
if (typeof addEventListener === 'function') {
  addEventListener('pointerdown', wake, true)
  addEventListener('keydown', wake, true)
}

/** One note: *freq* Hz (sliding to *to*), starting *at* s from now, for *dur* s. */
function note(a, { freq, to, at = 0, dur = 0.08, type = 'square', vol = 0.05 }) {
  const t = a.currentTime + at
  const o = a.createOscillator()
  const g = a.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  o.connect(g).connect(a.destination)
  o.start(t)
  o.stop(t + dur + 0.02)
}

function play(notes, { throttle = 0 } = {}) {
  const a = audio()
  if (!a) return
  const now = performance.now()
  if (throttle && now - last < throttle) return
  last = now
  notes.forEach((n) => note(a, n))
}

export const sfx = {
  /** A cabinet under the pointer. */
  hover: () => play([{ freq: 1320, dur: 0.03, vol: 0.02 }], { throttle: 45 }),
  /** A choice made. */
  select: () => play([{ freq: 660, dur: 0.05 }, { freq: 990, at: 0.05, dur: 0.07 }]),
  /** A coin in the slot. */
  coin: () => play([{ freq: 988, dur: 0.07 }, { freq: 1319, at: 0.07, dur: 0.22 }]),
  /** Press start. */
  start: () =>
    play([
      { freq: 523, dur: 0.07 },
      { freq: 659, at: 0.07, dur: 0.07 },
      { freq: 784, at: 0.14, dur: 0.07 },
      { freq: 1047, at: 0.21, dur: 0.18 },
    ]),
  /** A point scored. */
  up: () => play([{ freq: 880, to: 1760, dur: 0.09, vol: 0.03 }], { throttle: 60 }),
  /** A point lost. */
  down: () => play([{ freq: 330, to: 165, dur: 0.14, type: 'sawtooth', vol: 0.03 }], { throttle: 60 }),
  /** The end: a little fanfare. */
  win: () =>
    play([
      { freq: 523, dur: 0.1 },
      { freq: 659, at: 0.1, dur: 0.1 },
      { freq: 784, at: 0.2, dur: 0.1 },
      { freq: 1047, at: 0.3, dur: 0.14 },
      { freq: 784, at: 0.44, dur: 0.08 },
      { freq: 1047, at: 0.52, dur: 0.36, type: 'triangle', vol: 0.07 },
    ]),
  /** Game over, nobody won. */
  over: () =>
    play([
      { freq: 392, dur: 0.14, type: 'triangle', vol: 0.06 },
      { freq: 330, at: 0.15, dur: 0.14, type: 'triangle', vol: 0.06 },
      { freq: 262, at: 0.3, dur: 0.34, type: 'triangle', vol: 0.06 },
    ]),
}
