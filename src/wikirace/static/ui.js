/* The small component kit the page is assembled from: state dots and badges,
 * buttons, tabs, the toolbar, panels and the empty state. Only what the WikiRace
 * view uses; their styles are in styles.css. */
import { h } from 'preact'
import htm from 'htm'
import { PixelText } from './brand.js'
import { ordinal } from './state.js'

const html = htm.bind(h)

/* ── Drawn marks ───────────────────────────────────────────────────────────── */
/* The arcade's rule: no emoji on a game page. These are the flags, dice, crown
 * and signs WikiRace used to borrow from the emoji font, drawn in its own
 * style instead: flat, lit, 1em square, the colour of the text around them.
 * All decorative (aria-hidden) — the words beside them carry the meaning. */

/** A chequered finish flag on a pole; `wave` lets the cloth flutter. */
export function CheckeredFlag({ class: cls, wave = false }) {
  const checks = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) checks.push([4 + c * 2.75, 2 + r * 2.6])
  return html`
    <svg class=${`ico ico--flag${wave ? ' ico--wave' : ''}${cls ? ` ${cls}` : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="1" width="1.6" height="14" rx=".8" class="ico__pole" />
      <g class="ico__cloth">
        <rect x="4" y="2" width="11" height="7.8" class="ico__cloth-bg" />
        ${checks.map(([x, y]) => html`<rect x=${x} y=${y} width="2.75" height="2.6" />`)}
      </g>
    </svg>
  `
}

/** The start's pennant: a plain flag, where the target's is chequered. */
export function Pennant({ class: cls }) {
  return html`
    <svg class=${`ico ico--pennant${cls ? ` ${cls}` : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="1" width="1.6" height="14" rx=".8" class="ico__pole" />
      <path d="M4 2 L14.5 5.6 L4 9.4 Z" />
    </svg>
  `
}

const PIPS = {
  1: [[10, 10]],
  2: [[6, 6], [14, 14]],
  3: [[6, 6], [10, 10], [14, 14]],
  4: [[6, 6], [14, 6], [6, 14], [14, 14]],
  5: [[6, 6], [14, 6], [10, 10], [6, 14], [14, 14]],
  6: [[6, 6], [14, 6], [6, 10], [14, 10], [6, 14], [14, 14]],
}

/** A die showing *face* (1–6). */
export function Die({ face = 5, class: cls }) {
  const pips = PIPS[face] ?? PIPS[5]
  return html`
    <svg class=${`ico ico--die${cls ? ` ${cls}` : ''}`} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="17" height="17" rx="4.5" class="ico__die" />
      ${pips.map(([x, y]) => html`<circle cx=${x} cy=${y} r="1.7" class="ico__pip" />`)}
    </svg>
  `
}

/** Rows of a pixel picture ('#' lit) as one path of 1×1 runs. */
function pixelPath(rows) {
  let d = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      if (row[x] !== '#') {
        x++
        continue
      }
      let w = 1
      while (row[x + w] === '#') w++
      d += `M${x} ${y}h${w}v1h-${w}z`
      x += w
    }
  })
  return d
}

// prettier-ignore
const CROWN = pixelPath([
  '#....#....#',
  '##..###..##',
  '###.###.###',
  '###########',
  '###########',
  '...........',
  '###########',
])
const CROWN_GEMS = pixelPath(['', '', '', '', '..#..#..#..'])

/** The winner's crown, in pixels. */
export function Crown({ class: cls }) {
  return html`
    <svg class=${`ico ico--crown${cls ? ` ${cls}` : ''}`} viewBox="0 0 11 7" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
      <path d=${CROWN} class="ico__gold" />
      <path d=${CROWN_GEMS} class="ico__gem" />
    </svg>
  `
}

/** A warning sign: a triangle with a bang. */
export function WarnSign({ class: cls }) {
  return html`
    <svg class=${`ico ico--warn${cls ? ` ${cls}` : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.6 L15 14 H1 Z" class="ico__tri" />
      <rect x="7.1" y="5.6" width="1.8" height="4.6" rx=".6" class="ico__bang" />
      <rect x="7.1" y="11.3" width="1.8" height="1.7" rx=".6" class="ico__bang" />
    </svg>
  `
}

/** A finishing position as the podium prints it: 1ST in gold, 2ND silver,
 *  3RD bronze, the rest plain — in the pixel font, named for a screen reader. */
export function RankBadge({ rank, class: cls }) {
  const tier = rank >= 1 && rank <= 3 ? rank : 'n'
  const words = `Rank ${rank}`
  return html`
    <span class=${`wr-rank wr-rank--${tier}${cls ? ` ${cls}` : ''}`} role="img" aria-label=${words} title=${words}>
      <${PixelText} text=${ordinal(rank)} />
    </span>
  `
}

/* ── Semantic state ────────────────────────────────────────────────────────── */

/** A status dot. `live` pulses, because it means work is happening right now;
 *  `off` is hollow, so "not set up" reads in the shape and not only the colour. */
export function StatDot({ tone = 'neutral', title }) {
  return html`<i class=${`dot dot--${tone}`} title=${title} aria-hidden=${!title} />`
}

/** A labelled state pill. Encodes state in form as well as colour. `title` is the
 *  hover text — a badge is often an abbreviation of something worth reading. */
export function Badge({ tone = 'neutral', title, children }) {
  return html`<span class=${`badge badge--${tone}`} title=${title}>${children}</span>`
}

/* ── Controls ──────────────────────────────────────────────────────────────── */

/** variant: primary | secondary | danger | ghost · size: sm | md */
export function Button({ variant = 'secondary', size = 'md', class: cls, type = 'button', ...rest }) {
  return html`<button type=${type} class=${`btn btn--${variant} btn--${size}${cls ? ` ${cls}` : ''}`} ...${rest} />`
}

/**
 * A row of in-view tabs. The selection is the caller's state — here the page's
 * query string — so a tab is linkable and the back button walks through them.
 * @param {{tabs: [string, string][], value: string, onChange: (id: string) => void}} p
 */
export function Tabs({ tabs, value, onChange }) {
  return html`
    <nav class="tabs" aria-label="Views">
      ${tabs.map(
        ([id, label]) => html`
          <button
            key=${id}
            type="button"
            class=${`tabs__tab${value === id ? ' tabs__tab--on' : ''}`}
            aria-pressed=${value === id}
            onClick=${() => onChange(id)}
          >
            ${label}
          </button>
        `,
      )}
    </nav>
  `
}

/* ── Layout ────────────────────────────────────────────────────────────────── */

export function Toolbar({ class: cls, children }) {
  return html`<div class=${`toolbar${cls ? ` ${cls}` : ''}`}>${children}</div>`
}

export function Spacer() {
  return html`<span class="spacer" />`
}

/**
 * Empty state. Copy is written from the reader's side of the screen: say what is
 * missing and what to do about it, never just "no data".
 */
export function EmptyState({ icon, title, children }) {
  return html`
    <div class="empty">
      ${icon && html`<div class="empty__icon" aria-hidden="true">${icon}</div>`}
      <div class="empty__title">${title}</div>
      ${children && html`<div class="empty__desc">${children}</div>`}
    </div>
  `
}

/** A titled surface. `actions` is right-aligned header content — counts, a note;
 *  `flush` drops the body padding for a child that owns its own layout. */
export function Panel({ title, actions, flush = false, class: cls, children }) {
  return html`
    <section class=${`panel${cls ? ` ${cls}` : ''}`}>
      ${(title || actions) &&
      html`
        <header class="panel__hd">
          ${title && html`<h2 class="panel__title">${title}</h2>`}
          <span class="panel__gap" />
          ${actions}
        </header>
      `}
      <div class=${flush ? 'panel__bd panel__bd--flush' : 'panel__bd'}>${children}</div>
    </section>
  `
}
