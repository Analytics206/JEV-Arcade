/* The race trace — hops over time, one step line per racer.
 *
 * Built to the dataviz method rather than by eye: 2px lines with round joins,
 * hairline recessive grid, categorical lane colours from the --lane-N tokens
 * (validated for this surface), a legend always present, identity never carried
 * by colour alone (every line ends in its lane NUMBER, the same number the lane
 * card wears), text in text tokens only, and a crosshair whose tooltip lists every
 * racer at that moment — values first. Fouls sit on their racer's line as ✕ (a
 * cheat) or ? (no pick) in the semantic colours; the tooltip, the cheat log and
 * the lane cards carry the same facts in words, so nothing here is reachable only
 * by hovering.
 *
 * Each line is run by a horse — a carnival derby horse, in its lane's colour, with
 * the lane number on its saddle cloth. It stands on the head of its line, rocks
 * while its racer thinks, stands still while it waits, and goes hollow when its
 * racer is out. Horses on the same hop at the same moment fall in behind one
 * another as a bunched field (`packHorses`) rather than stack.
 *
 * The geometry — scales, lines, where each horse stands — is `traceLayout` in
 * state.js, where it is tested; this file only draws it.
 *
 * The arcade dressing costs no filters: each line is a neon tube drawn as three
 * strokes (a wide faint glow, the lane colour, a pale core), the hops are
 * banded like the lanes of a track, a galloping horse kicks up dust, a new hop
 * rings out from its horse and a new foul pops — CSS animations that play once,
 * when the mark appears, and only while the race is live.
 */
import { h } from 'preact'
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { HORSE_HALF, HORSE_SCALE, STATUS_LABEL, fmtDuration, hopsAt, timeAt, tipLeft, traceLayout } from './state.js'

const html = htm.bind(h)

/** The parts that take the lane's colour (and, drawn first, the halo). */
const horseParts = () => html`
  <path class="wr-horse__leg" d="M13.2 20.4 L10.2 24.6 L6 26.8" />
  <path class="wr-horse__leg" d="M11.4 19.8 L7.4 22.6 L2.6 23.6" />
  <path class="wr-horse__leg" d="M27.2 20.2 L30.4 24.4 L34.6 26.6" />
  <path class="wr-horse__leg" d="M28.6 19.6 L32.6 22.4 L37.4 23.4" />
  <path class="wr-horse__fill" d="M8.6 13.6 C4.8 11.4 1.6 12.6 0.4 16.4 C2.6 15 4.6 15.4 5.8 17.4 C6.2 15.6 7.2 14.6 8.8 14.8 Z" />
  <rect class="wr-horse__fill" x="8" y="12" width="22" height="9.5" rx="4.75" />
  <path class="wr-horse__fill" d="M23.6 15.6 C24.6 11 25.8 7.6 27.6 5.4 L33.2 6.6 C31.8 9.4 31 12.6 30.6 16 Z" />
  <path class="wr-horse__fill" d="M26.4 4.4 C28 1.6 33.6 1.2 38.4 4.4 C40.6 5.9 41.2 8.4 39.6 9.8 C38.2 11 35.8 10.6 34 9.6 L28.6 7.8 C26.8 7.2 25.8 5.8 26.4 4.4 Z" />
  <path class="wr-horse__fill" d="M28.2 3.4 L29 -0.6 L31 2.6 Z" />
  <path class="wr-horse__fill" d="M30.6 2.6 L32 -0.2 L33.2 2.8 Z" />
`
// The legs above: the flying gallop of every carnival and rocking horse — the
// forelegs reaching ahead, the hind legs stretched out behind.

/** The finisher's chequered flag, flying beyond its horse's nose. Drawn
 *  from rects so it stays crisp at any size. */
function FinishFlag({ x, y }) {
  const checks = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) if ((r + c) % 2 === 0) checks.push([c * 2.4, r * 2.2])
  return html`
    <g class="wr-end__flag" transform=${`translate(${x} ${y})`}>
      <rect class="wr-end__pole" x="-0.7" y="0" width="1.4" height="19" rx=".7" />
      <g class="wr-end__cloth">
        <rect class="wr-end__bg" x="0.7" y="0.4" width="9.6" height="6.6" />
        ${checks.map(([cx, cy]) => html`<rect x=${0.7 + cx} y=${0.4 + cy} width="2.4" height="2.2" />`)}
      </g>
    </g>
  `
}

function Horse({ lane, x, y, status, hops, live }) {
  const out = status === 'dnf' || status === 'dq' || status === 'error' || status === 'stopped'
  const running = status === 'thinking' || status === 'moving'
  return html`
    <g
      class=${`wr-horse wr-f${lane + 1}${out ? ' wr-horse--out' : ''}${running ? ' wr-horse--run' : ''}`}
      style=${{ transform: `translateX(${x}px)` }}
    >
      <g class="wr-horse__hop" style=${{ transform: `translateY(${y}px)` }}>
        ${live &&
        hops > 0 &&
        html`<circle key=${`p${hops}`} class="wr-horse__pulse" cx="0" cy="-10" r="15" />`}
        ${running &&
        html`
          <g class="wr-horse__dust">
            <circle cx="-19" cy="-3" r="2.2" />
            <circle cx="-22" cy="-6" r="1.6" />
            <circle cx="-24" cy="-2" r="1.9" />
          </g>
        `}
        <g class="wr-horse__rock" style=${{ animationDelay: `${-lane * 0.13}s` }}>
          <g transform=${`scale(${HORSE_SCALE}) translate(-22 -29)`}>
            <g class="wr-horse__halo">${horseParts()}</g>
            <g class="wr-horse__coat">${horseParts()}</g>
            <path class="wr-horse__mane" d="M26.8 6.6 C25.4 9.4 24.6 12.2 24.4 15" />
            <circle class="wr-horse__eye" cx="34.4" cy="5.2" r="0.9" />
            <rect class="wr-horse__cloth" x="11.4" y="10.2" width="12.6" height="11" rx="2" />
            <text class="wr-horse__n" x="17.7" y="15.7" dy="0.36em" text-anchor="middle">${lane + 1}</text>
          </g>
        </g>
        ${status === 'finished' && html`<${FinishFlag} x=${HORSE_HALF + 4} y=${-24} />`}
        ${status === 'dq' && html`<text x=${HORSE_HALF + 3} y=${-12} dy="0.34em" class="wr-end__dq">✕</text>`}
      </g>
    </g>
  `
}

/** The width of an element, kept current as it resizes. */
function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

export function RaceTrace({ race, now }) {
  const [box, width] = useWidth()
  const [hoverX, setHoverX] = useState(null)
  const L = useMemo(() => traceLayout(race, now, width), [race, now, width])
  const lanes = race.lanes
  const live = race.status === 'running'
  const tAt = hoverX == null ? null : timeAt(L, hoverX)

  // A pointer anywhere on the plot finds the time; a tap does too, where there
  // is no hover — and a vertical swipe over the chart still scrolls the page.
  const onPoint = (e) => {
    const r = e.currentTarget.ownerSVGElement.getBoundingClientRect()
    setHoverX(e.clientX - r.left)
  }

  const summary = lanes.map((ln) => `${ln.index + 1} ${ln.label}: ${ln.hops} hops, ${STATUS_LABEL[ln.status]}`).join('; ')

  return html`
    <div class=${`wr-trace${live ? ' is-live' : ''}`}>
      <div class="wr-trace__legend" aria-hidden="true">
        ${lanes.map(
          (ln) => html`
            <span key=${ln.index} class=${`wr-trace__key wr-c${ln.index + 1}`}>
              <i class=${`wr-linekey wr-c${ln.index + 1}`} />
              <b class="wr-num">${ln.index + 1}</b>
              ${ln.label}
            </span>
          `,
        )}
        <span class="wr-trace__marks">
          <span class="wr-trace__key wr-trace__key--mark"><i class="wr-foulkey">✕</i> foul</span>
          <span class="wr-trace__key wr-trace__key--mark"><i class="wr-foulkey wr-foulkey--warn">?</i> no pick</span>
        </span>
      </div>
      <div ref=${box} class="wr-trace__plot">
        ${width > 0 &&
        html`
          <svg width=${width} height=${L.H} role="img" aria-label=${`Hops over time. ${summary}`}>
            <rect class="wr-plotbg" x=${L.M.left} y=${L.M.top} width=${L.plotW} height=${L.plotH} rx="6" />
            ${
              /* The hops, banded like the lanes of a track. */
              L.yTicks.slice(1).map(({ y }, k) =>
                k % 2 === 0
                  ? html`<rect key=${`b${k}`} class="wr-band" x=${L.M.left} y=${y} width=${L.plotW} height=${Math.max(0, L.yTicks[k].y - y)} />`
                  : null,
              )
            }
            ${L.yTicks.map(
              ({ h: hop, y }) => html`
                <g key=${`y${hop}`}>
                  <line class="wr-grid" x1=${L.M.left} x2=${L.M.left + L.plotW} y1=${y} y2=${y} />
                  <text class="wr-axis" x=${L.M.left - 8} y=${y} dy="0.32em" text-anchor="end">${hop}</text>
                </g>
              `,
            )}
            ${L.xTicks.map(
              ({ t, x }) => html`
                <text key=${`x${t}`} class="wr-axis" x=${x} y=${L.H - 8} text-anchor="middle">
                  ${t === 0 ? '0' : fmtDuration(t)}
                </text>
              `,
            )}
            <text class="wr-axis wr-axis--title" x=${L.M.left} y=${L.M.top - 4}>hops</text>

            ${
              /* Each line a neon tube: glow, colour, core — three strokes, no filter. */
              ['glow', 'line', 'core'].map(
                (part) => html`
                  <g key=${part} class=${`wr-lines wr-lines--${part}`}>
                    ${L.lines.map((ln) => html`<path key=${`${part}${ln.lane}`} class=${`wr-line wr-s${ln.lane + 1}`} d=${ln.d} />`)}
                  </g>
                `,
              )
            }

            ${L.horses.map(
              (hs) => html`<${Horse} key=${`h${hs.lane}`} lane=${hs.lane} x=${hs.x} y=${hs.y} status=${hs.status} hops=${hs.hops} live=${live} />`,
            )}

            ${
              /* Fouls, on their racer's line — over the horses, so a foul at the
                 head of a line is never hidden under the horse standing there. */
              L.fouls.map(
                (f) => html`
                  <g
                    key=${`f${f.lane}-${f.k}`}
                    class=${`wr-foul${f.kind === 'foul' ? '' : ' wr-foul--warn'}${live ? ' is-new' : ''}`}
                    style=${{ transformOrigin: `${f.cx}px ${f.cy}px` }}
                  >
                    <title>${`Racer ${f.lane + 1}: ${f.note}`}</title>
                    <circle cx=${f.cx} cy=${f.cy} r="6" class="wr-ring" />
                    ${f.kind === 'foul'
                      ? html`<path
                          d=${`M${f.cx - 3.5} ${f.cy - 3.5} L${f.cx + 3.5} ${f.cy + 3.5} M${f.cx + 3.5} ${f.cy - 3.5} L${f.cx - 3.5} ${f.cy + 3.5}`}
                        />`
                      : html`<circle cx=${f.cx} cy=${f.cy} r="3.5" class="wr-foul__dot" />`}
                  </g>
                `,
              )
            }

            ${tAt != null &&
            html`<line class="wr-cross" x1=${L.x(tAt)} x2=${L.x(tAt)} y1=${L.M.top} y2=${L.M.top + L.plotH} />`}
            <rect
              class="wr-trace__hit"
              x=${L.M.left}
              y=${L.M.top}
              width=${L.plotW}
              height=${L.plotH}
              fill="transparent"
              onPointerMove=${onPoint}
              onPointerDown=${onPoint}
              onPointerLeave=${() => setHoverX(null)}
            />
          </svg>
        `}
        ${tAt != null &&
        hoverX != null &&
        html`
          <div class="wr-tip" style=${{ left: tipLeft(hoverX, width) }} role="status">
            <div class="wr-tip__t">${fmtDuration(tAt)}</div>
            ${L.traces.map(
              (tr) => html`
                <div key=${tr.lane} class="wr-tip__row">
                  <i class=${`wr-linekey wr-c${tr.lane + 1}`} />
                  <b class="tnum">${hopsAt(tr, tAt)}</b>
                  <span>${tr.lane + 1} ${lanes[tr.lane].label}</span>
                </div>
              `,
            )}
          </div>
        `}
      </div>
    </div>
  `
}
