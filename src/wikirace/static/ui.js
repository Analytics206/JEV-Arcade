/* The small component kit the page is assembled from: state dots and badges,
 * buttons, tabs, the toolbar, panels and the empty state. Only what the WikiRace
 * view uses; their styles are in styles.css. */
import { h } from 'preact'
import htm from 'htm'

const html = htm.bind(h)

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
