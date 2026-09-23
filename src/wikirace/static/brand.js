/* JEV-Arcade's brand: the pixel font, the wordmark and the header every view
 * shares (the Arcade's floor, each game, and WikiRace).
 *
 * The pixel font is drawn here, 5×7 on a 6-wide cell, as SVG: nothing is
 * downloaded, so the marquee reads the same on every machine. `PixelText`
 * draws any string in it (lower case is drawn as upper; an unknown character
 * as a gap); `dots` draws it as a lit LED matrix instead of solid blocks.
 */
import { h } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { navigate } from './games/route.js'
import { sfx, soundOn, setSound, onSound } from './sfx.js'

const html = htm.bind(h)

/* ── The font ──────────────────────────────────────────────────────────────── */

// prettier-ignore
const GLYPHS = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  "'": ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '’': ['..#..', '..#..', '.#...', '.....', '.....', '.....', '.....'],
  '"': ['.#.#.', '.#.#.', '.....', '.....', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '=': ['.....', '.....', '#####', '.....', '#####', '.....', '.....'],
  '·': ['.....', '.....', '.....', '..#..', '.....', '.....', '.....'],
  '•': ['.....', '.....', '.###.', '.###.', '.###.', '.....', '.....'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '<': ['...#.', '..#..', '.#...', '#....', '.#...', '..#..', '...#.'],
  '>': ['.#...', '..#..', '...#.', '....#', '...#.', '..#..', '.#...'],
  '$': ['..#..', '.####', '#.#..', '.###.', '..#.#', '####.', '..#..'],
  '%': ['##..#', '##..#', '...#.', '..#..', '.#...', '#..##', '#..##'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '*': ['.....', '#.#.#', '.###.', '#####', '.###.', '#.#.#', '.....'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '×': ['.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....'],
  '→': ['.....', '..#..', '...#.', '#####', '...#.', '..#..', '.....'],
  '←': ['.....', '..#..', '.#...', '#####', '.#...', '..#..', '.....'],
  '▸': ['.#...', '.##..', '.###.', '.####', '.###.', '.##..', '.#...'],
  '◂': ['...#.', '..##.', '.###.', '####.', '.###.', '..##.', '...#.'],
  '♥': ['.....', '.#.#.', '#####', '#####', '.###.', '..#..', '.....'],
  '★': ['..#..', '..#..', '#####', '.###.', '.###.', '##.##', '#...#'],
  '✓': ['.....', '....#', '...##', '#.##.', '###..', '.#...', '.....'],
}

/** A character as the font draws it: accents dropped, lower case raised. */
function glyphOf(ch) {
  const up = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
  return GLYPHS[up] ?? GLYPHS[ch] ?? null
}

/** The lit runs of a string: [x, y, width] per horizontal run of pixels. */
const RUNS = new Map()
function runsOf(text) {
  let runs = RUNS.get(text)
  if (runs) return runs
  runs = []
  ;[...text].forEach((ch, i) => {
    const g = glyphOf(ch)
    if (!g) return
    g.forEach((row, y) => {
      let x = 0
      while (x < 5) {
        if (row[x] !== '#') {
          x++
          continue
        }
        let w = 1
        while (x + w < 5 && row[x + w] === '#') w++
        runs.push([i * 6 + x, y, w])
        x += w
      }
    })
  })
  if (RUNS.size > 400) RUNS.clear()
  RUNS.set(text, runs)
  return runs
}

/** The pixels of a string as round LEDs, one path for the lot (a long ticker
 *  is thousands of them). */
function dotPath(text) {
  let d = ''
  for (const [x, y, w] of runsOf(text)) {
    for (let k = 0; k < w; k++) d += `M${x + k + 0.08} ${y + 0.5}a.42 .42 0 1 0 .84 0a.42 .42 0 1 0 -.84 0`
  }
  return d
}

/**
 * A string in the pixel font, 1em tall (set the size with font-size). The
 * colour is the text colour. It is a picture of the words: give it `label` to
 * name them to a screen reader, or leave it hidden beside real text.
 */
export function PixelText({ text, dots = false, label, class: cls, style }) {
  const s = String(text ?? '')
  const n = [...s].length
  const w = Math.max(1, n * 6 - 1)
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' }
  return html`
    <svg class=${`px${dots ? ' px--dots' : ''}${cls ? ` ${cls}` : ''}`} style=${style} viewBox=${`0 0 ${w} 7`}
      width=${`${(w / 7).toFixed(3)}em`} height="1em" shape-rendering=${dots ? 'auto' : 'crispEdges'} ...${a11y}>
      <path d=${dots ? dotPath(s) : runsOf(s).map(([x, y, rw]) => `M${x} ${y}h${rw}v1h-${rw}z`).join('')} />
    </svg>
  `
}

/** The name, lit: JEV in cyan, ARCADE in hot pink. */
export function Wordmark({ class: cls }) {
  return html`
    <span class=${`wm${cls ? ` ${cls}` : ''}`} role="img" aria-label="JEV-Arcade">
      <${PixelText} text="JEV" class="wm__a" /><${PixelText} text="-" class="wm__dash" /><${PixelText} text="ARCADE" class="wm__b" />
    </span>
  `
}

/* ── Sound ─────────────────────────────────────────────────────────────────── */

/** Whether the arcade makes noise, as state that follows the toggle. */
export function useSoundOn() {
  const [on, setOn] = useState(soundOn())
  useEffect(() => onSound(setOn), [])
  return on
}

function SoundToggle() {
  const on = useSoundOn()
  const flip = () => {
    setSound(!on)
    if (!on) sfx.coin()
  }
  return html`
    <button type="button" class=${`hd-sound${on ? ' hd-sound--on' : ''}`} onClick=${flip} aria-pressed=${on}
      title=${on ? 'Sound on: click to mute' : 'Sound off: click to turn the arcade sounds back on'}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2 6h3l4-3v10l-4-3H2z" />
        ${on
          ? html`<path class="hd-sound__wave" d="M11 5.5q1.6 2.5 0 5M12.8 3.8q3 4.2 0 8.4" />`
          : html`<path class="hd-sound__wave" d="M11 6l4 4M15 6l-4 4" />`}
      </svg>
      <span class="sr-only">${on ? 'Sound on' : 'Sound off'}</span>
    </button>
  `
}

/* ── The header ────────────────────────────────────────────────────────────── */

export const NAV = [
  ['arcade', 'Arcade'],
  ['race', 'WikiRace'],
  ['history', 'Race history'],
]

/** Where each part of the site lives. */
export function goNav(id) {
  if (id === 'race') navigate('?tab=race')
  else if (id === 'history') navigate('?tab=history')
  else navigate('')
}

const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/**
 * The header every view shares: the wordmark (home, the Arcade's floor), where
 * you are, the site's three places, sound, and the arcade's own promise.
 * `onNav` overrides where a place goes (WikiRace keeps its last race open);
 * `children` sit after the crumb (a race running elsewhere).
 */
export function SiteHeader({ active, crumb, onNav = goNav, children }) {
  const home = (e) => {
    if (!plainClick(e)) return
    e.preventDefault()
    sfx.select()
    navigate('')
  }
  const hrefOf = (id) => (id === 'arcade' ? './' : `?tab=${id}`)
  return html`
    <header class="hd">
      <div class="hd__bar">
        <a class="hd__brand" href="./" onClick=${home} title="JEV-Arcade: every cabinet">
          <${Wordmark} />
        </a>
        ${crumb && html`<p class="hd__crumb"><span class="hd__sep" aria-hidden="true">/</span>${crumb}</p>`}
        ${children}
        <span class="spacer" />
        <nav class="hd__nav" aria-label="JEV-Arcade">
          ${NAV.map(
            ([id, label]) => html`
              <a key=${id} href=${hrefOf(id)} class=${`hd__link${active === id ? ' hd__link--on' : ''}`}
                aria-current=${active === id ? 'page' : undefined} onMouseEnter=${sfx.hover}
                onClick=${(e) => {
                  if (!plainClick(e)) return
                  e.preventDefault()
                  sfx.select()
                  onNav(id)
                }}>${label}</a>
            `,
          )}
        </nav>
        <${SoundToggle} />
        <span class="hd__free" aria-hidden="true"><${PixelText} text="FREE PLAY" /></span>
      </div>
    </header>
  `
}
