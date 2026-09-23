/* The arcade's effects, shared by every view: a burst of pixel confetti, a
 * number that counts up to its new value (with a "+2" that floats off it), and
 * the finale that says a game is over.
 *
 * All of it is decoration over the real numbers, never instead of them: a
 * counter lands on the exact value, and the finale repeats what the page
 * already shows. Reduced motion turns the movement off.
 */
import { h, render } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { PixelText } from './brand.js'
import { sfx } from './sfx.js'

const html = htm.bind(h)

export const LANE_COLORS = ['#3987e5', '#c98500', '#9085e9', '#199e70']
export const NEON = ['#3ef4ff', '#ff4fd8', '#ffe14d', '#3ef5a0', '#8b7bff']

const calm = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* ── Confetti ──────────────────────────────────────────────────────────────── */

let canvas = null
let parts = []
let raf = 0

function frame() {
  const c = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  c.clearRect(0, 0, canvas.width, canvas.height)
  parts = parts.filter((p) => p.life > 0)
  for (const p of parts) {
    p.vx *= 0.985
    p.vy = p.vy * 0.985 + 0.22
    p.x += p.vx
    p.y += p.vy
    p.life -= 1
    c.globalAlpha = Math.min(1, p.life / 30)
    c.fillStyle = p.color
    const s = p.size * dpr
    c.fillRect(Math.round(p.x * dpr), Math.round(p.y * dpr), s, s)
  }
  if (parts.length) raf = requestAnimationFrame(frame)
  else {
    canvas.remove()
    canvas = null
    raf = 0
  }
}

/** Pixel confetti from (x, y) in the viewport; the whole screen's middle when
 *  no point is given. */
export function burst({ x, y, colors = NEON, count = 90, power = 1 } = {}) {
  if (calm() || typeof document === 'undefined') return
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.className = 'fx-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    document.body.appendChild(canvas)
  }
  const dpr = window.devicePixelRatio || 1
  canvas.width = innerWidth * dpr
  canvas.height = innerHeight * dpr
  const cx = x ?? innerWidth / 2
  const cy = y ?? innerHeight * 0.42
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6
    const v = (4 + Math.random() * 9) * power
    parts.push({
      x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      size: 3 + Math.floor(Math.random() * 4), life: 70 + Math.random() * 70,
      color: colors[i % colors.length],
    })
  }
  if (!raf) raf = requestAnimationFrame(frame)
}

/** Confetti from an element's middle. */
export function burstFrom(el, opts = {}) {
  if (!el?.getBoundingClientRect) return burst(opts)
  const r = el.getBoundingClientRect()
  burst({ x: r.left + r.width / 2, y: r.top + r.height / 2, ...opts })
}

/* ── A number that counts ──────────────────────────────────────────────────── */

const fmtInt = (n) => String(Math.round(n))
const fmtDelta = (d, fmt) => (d > 0 ? `+${fmt(d)}` : `−${fmt(-d)}`)

/**
 * A number that rolls to each new value and floats the change off it.
 * `format` writes a value (default: a whole number); `sound` blips on a change.
 * A value that is not a number is shown as it comes (use `blank` for its text).
 */
export function Counter({ value, format = fmtInt, blank = '—', sound = false, class: cls }) {
  const [shown, setShown] = useState(value)
  const [pops, setPops] = useState([])
  const cur = useRef(value)
  const ids = useRef(0)
  useEffect(() => {
    const a = cur.current
    const b = value
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || calm()) {
      cur.current = b
      setShown(b)
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) addPop(b - a)
      return
    }
    addPop(b - a)
    const t0 = performance.now()
    let id = 0
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 480)
      const v = a + (b - a) * (1 - (1 - k) ** 3)
      cur.current = k < 1 ? v : b
      setShown(cur.current)
      if (k < 1) id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [value])

  function addPop(d) {
    if (!d || Math.abs(d) < 1e-9) return
    if (sound) (d > 0 ? sfx.up : sfx.down)()
    const id = ++ids.current
    setPops((p) => [...p.slice(-3), { id, d }])
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1100)
  }

  return html`
    <span class=${`fx-count${cls ? ` ${cls}` : ''}`}>
      <span class="fx-count__v tnum">${Number.isFinite(shown) ? format(shown) : blank}</span>
      ${pops.map(
        (p) => html`<span key=${p.id} class=${`fx-pop ${p.d > 0 ? 'fx-pop--up' : 'fx-pop--down'}`} aria-hidden="true">${fmtDelta(p.d, format)}</span>`,
      )}
    </span>
  `
}

/* ── The finale ────────────────────────────────────────────────────────────── */

/** True once, when *live* turns false after this page watched it be true: a
 *  game that ended in front of you, not a replay opened later. */
export function useJustEnded(live) {
  const was = useRef(false)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    if (live) was.current = true
    else if (was.current) {
      was.current = false
      setEnded(true)
    }
  }, [live])
  return [ended, () => setEnded(false)]
}

/**
 * The end of a game, over the page for a few seconds: a pixel headline
 * ("PLAYER 1 WINS", "GAME OVER"), a line under it, confetti in the winners'
 * colours and a fanfare. `show` opens it; `onClose` is called when it goes.
 *
 * It is drawn straight into <body>, not where it is mounted: a fixed overlay
 * inside an ancestor with a transform or containment would be pinned to that
 * ancestor instead of the screen. `win={false}` plays it without the fanfare.
 */
export function Finale({ show, headline = 'GAME OVER', sub, colors, win = true, onClose }) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!show || typeof document === 'undefined') return
    const host = document.createElement('div')
    document.body.appendChild(host)
    const done = () => close.current?.()
    render(html`
      <div class=${`fin${win ? ' fin--win' : ''}`} role="status" onClick=${done}>
        <div class="fin__card">
          <div class="fin__head"><${PixelText} text=${headline} label=${headline} /></div>
          ${sub && html`<p class="fin__sub">${sub}</p>`}
          <span class="fin__hint">click anywhere to close</span>
        </div>
      </div>
    `, host)
    ;(win ? sfx.win : sfx.over)()
    const later = []
    if (win) {
      burst({ colors: colors?.length ? [...colors, '#ffffff', '#ffe14d'] : NEON, count: 140, power: 1.15 })
      later.push(setTimeout(() => burst({ x: innerWidth * 0.25, y: innerHeight * 0.55, colors: colors ?? NEON, count: 50 }), 260))
      later.push(setTimeout(() => burst({ x: innerWidth * 0.75, y: innerHeight * 0.55, colors: colors ?? NEON, count: 50 }), 420))
    }
    later.push(setTimeout(done, win ? 4200 : 2600))
    return () => {
      later.forEach(clearTimeout)
      render(null, host)
      host.remove()
    }
  }, [show])
  return null
}
