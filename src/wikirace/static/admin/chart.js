/* The traffic report's two charts, in SVG and the page's tokens.
 *
 * `Series`: page views as columns and visitors as a line, over time, on one
 * axis (both are counts). The two series wear the first two lane colours
 * (styles.css: validated for this dark surface), carry a legend, and every
 * bucket answers a hover with its numbers. `BarList`: one ranked list (top
 * pages, countries…) as a table with a bar in each row, so the numbers are
 * always there to read.
 */
import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { bucketLabel, fmtInt, maxOf } from './format.js'

const html = htm.bind(h)

const H = 220
const PAD = { l: 44, r: 12, t: 12, b: 26 }

/** Round numbers for the axis: 0 and up to four steps of 1, 2 or 5 × 10ⁿ. */
function ticks(max) {
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10
  const top = Math.max(step, Math.ceil(max / step) * step)
  const out = []
  for (let v = 0; v <= top + 1e-9; v += step) out.push(v)
  return { top, out }
}

/** The width of *ref*'s element, kept current: the chart is drawn at the size
 *  it is shown, so its text is never stretched. */
function useWidth(ref, fallback = 800) {
  const [w, setW] = useState(fallback)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Measured now, then on every change: a ResizeObserver only reports while
    // the page is being painted, and a window resize catches the rest.
    const measure = () => setW(Math.max(280, Math.round(el.clientWidth) || fallback))
    measure()
    addEventListener('resize', measure)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      removeEventListener('resize', measure)
      ro?.disconnect()
    }
  }, [])
  return w
}

export function Series({ series, hourly }) {
  const [hover, setHover] = useState(null)
  const box = useRef(null)
  const W = useWidth(box)
  if (!series.length) return html`<div class="ad-series" ref=${box}><p class="ad-none">No traffic in this period.</p></div>`
  const { top, out } = ticks(maxOf(series.flatMap((d) => [d.page_views, d.visitors])))
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b
  const bw = iw / series.length
  const x = (i) => PAD.l + i * bw
  const y = (v) => PAD.t + ih - (v / top) * ih
  const gap = bw > 6 ? 2 : 0
  const line = series.map((d, i) => `${i ? 'L' : 'M'}${(x(i) + bw / 2).toFixed(1)} ${y(d.visitors).toFixed(1)}`).join(' ')
  const every = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(iw / 90))))
  const shown = hover == null ? null : series[hover]
  return html`
    <div class="ad-series" ref=${box}>
      <div class="ad-legend">
        <span class="ad-key"><i class="ad-key__sw ad-key__sw--bar" />Page views</span>
        <span class="ad-key"><i class="ad-key__sw ad-key__sw--line" />Visitors</span>
        <span class="spacer" />
        <span class="ad-readout tnum" aria-live="polite">
          ${shown
            ? `${bucketLabel(shown.t, hourly)}: ${fmtInt(shown.page_views)} page views, ${fmtInt(shown.visitors)} visitors, ${fmtInt(shown.requests)} requests`
            : 'Point at a column for its numbers'}
        </span>
      </div>
      <svg class="ad-chart" width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} role="img"
        aria-label="Page views and visitors over time; the table below each list has the numbers"
        onMouseLeave=${() => setHover(null)}>
        ${out.map(
          (v) => html`
            <g key=${v}>
              <line class="ad-grid" x1=${PAD.l} x2=${W - PAD.r} y1=${y(v)} y2=${y(v)} />
              <text class="ad-tick" x=${PAD.l - 6} y=${y(v) + 3.5} text-anchor="end">${fmtInt(v)}</text>
            </g>
          `,
        )}
        ${series.map((d, i) => {
          const bh = PAD.t + ih - y(d.page_views)
          const r = Math.min(4, (bw - gap) / 2, bh)
          const x0 = x(i) + gap / 2
          const w = Math.max(1, bw - gap)
          const yt = y(d.page_views)
          // Rounded at the data end only; square on the baseline.
          const path = bh > 0
            ? `M${x0} ${PAD.t + ih} V${yt + r} Q${x0} ${yt} ${x0 + r} ${yt} H${x0 + w - r} Q${x0 + w} ${yt} ${x0 + w} ${yt + r} V${PAD.t + ih} Z`
            : ''
          return html`
            <g key=${d.t}>
              ${path && html`<path class=${`ad-bar${hover === i ? ' is-on' : ''}`} d=${path} />`}
              ${i % every === 0 &&
              html`<text class="ad-tick" x=${x(i) + bw / 2} y=${H - 8} text-anchor="middle">${bucketLabel(d.t, hourly)}</text>`}
            </g>
          `
        })}
        <path class="ad-line" d=${line} />
        ${series.length <= 60 &&
        series.map((d, i) => html`<circle key=${`c${d.t}`} class="ad-dot" cx=${x(i) + bw / 2} cy=${y(d.visitors)} r="3" />`)}
        <line class="ad-axis" x1=${PAD.l} x2=${W - PAD.r} y1=${PAD.t + ih} y2=${PAD.t + ih} />
        ${series.map(
          (d, i) => html`<rect key=${`h${d.t}`} class="ad-hit" x=${x(i)} y=${PAD.t} width=${bw} height=${ih}
            onMouseEnter=${() => setHover(i)} onFocus=${() => setHover(i)} />`,
        )}
      </svg>
    </div>
  `
}

/**
 * A ranked list as a table: label, a bar, the count, and (with `visitors`)
 * how many addresses. `format` turns a label into what is shown; `onPick`
 * makes each label a button.
 */
export function BarList({ rows, unit = 'Requests', visitors = true, format = (l) => l || '(none)', onPick, empty }) {
  if (!rows?.length) return html`<p class="ad-none">${empty ?? 'Nothing in this period.'}</p>`
  const max = maxOf(rows.map((r) => r.n))
  return html`
    <table class="ad-bars">
      <thead>
        <tr><th scope="col">Name</th><th scope="col" class="num">${unit}</th>${visitors && html`<th scope="col" class="num">Visitors</th>`}</tr>
      </thead>
      <tbody>
        ${rows.map(
          (r) => html`
            <tr key=${r.label}>
              <td class="ad-bars__label">
                <span class="ad-bars__fill" style=${{ width: `${(r.n / max) * 100}%` }} aria-hidden="true" />
                ${onPick
                  ? html`<button type="button" class="ad-linkish" onClick=${() => onPick(r.label)} title=${r.label}>${format(r.label)}</button>`
                  : html`<span title=${r.label}>${format(r.label)}</span>`}
              </td>
              <td class="num tnum">${fmtInt(r.n)}</td>
              ${visitors && html`<td class="num tnum">${fmtInt(r.visitors)}</td>`}
            </tr>
          `,
        )}
      </tbody>
    </table>
  `
}
