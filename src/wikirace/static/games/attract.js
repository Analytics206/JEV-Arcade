/* Attract mode: each cabinet's screen, a small looping scene of its game, as
 * an arcade machine plays to itself on the floor.
 *
 * Every scene is one SVG, 320×200, animated with SMIL (so the floor can pause
 * one with `svg.pauseAnimations()` when it scrolls out of sight) and a few CSS
 * loops (hub.css, `at-*`). A scene is drawn by `SCENES[id](u)`: *u* makes its
 * pattern and clip ids unique, because the same scene can be on the page twice
 * (the big screen and its cabinet). Decoration only: aria-hidden throughout.
 */
import { h } from 'preact'
import htm from 'htm'

const html = htm.bind(h)

const L1 = '#3987e5'
const L2 = '#c98500'
const L3 = '#9085e9'
const L4 = '#199e70'
const OK = '#3ef5a0'
const ERR = '#ff4d6a'
const WARN = '#ffb545'
const TXT = '#e8eeff'
const DIM = '#555c86'
const INK = '#07051a'

const svg = (id, body) => html`<svg class=${`at at--${id}`} viewBox="0 0 320 200" aria-hidden="true" focusable="false">${body}</svg>`
const loop = { repeatCount: 'indefinite' }

/* WikiRace: four racers climb article by article; blue takes the flag. */
function wikirace(u) {
  const lanes = [
    [L1, 'M24 170 H58 V140 H96 V110 H132 V80 H170 V50 H232', 0.46],
    [L2, 'M24 170 H78 V140 H126 V110 H176 V80 H222 V50 H262', 0.6],
    [L3, 'M24 170 H104 V140 H168 V110 H236 V80 H290', 0.72],
    [L4, 'M24 170 H136 V140 H200 V110 H214', 0.4],
  ]
  return svg('wikirace', html`
    <defs>
      <pattern id=${`wrChk${u}`} width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill=${TXT} /><rect width="3" height="3" fill=${INK} /><rect x="3" y="3" width="3" height="3" fill=${INK} />
      </pattern>
    </defs>
    <g stroke="rgba(140,150,210,0.16)" stroke-width="1">
      ${[50, 80, 110, 140, 170].map((y) => html`<line x1="20" x2="300" y1=${y} y2=${y} />`)}
    </g>
    <g font-family="ui-monospace, monospace" font-size="8" fill=${DIM}>
      <text x="22" y="190">START</text><text x="236" y="30">TARGET</text>
    </g>
    <line x1="238" y1="36" x2="238" y2="56" stroke=${TXT} stroke-width="1.5" />
    <rect x="238" y="36" width="18" height="12" fill=${`url(#wrChk${u})`} class="at-wave" />
    <circle cx="238" cy="50" r="0" fill="none" stroke="#ffe14d" stroke-width="2">
      <animate attributeName="r" values="0;0;26;26" keyTimes="0;0.46;0.6;1" dur="7s" ...${loop} />
      <animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.46;0.47;0.62;1" dur="7s" ...${loop} />
    </circle>
    <g>
      <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.88;0.96;1" dur="7s" ...${loop} />
      ${lanes.map(
        ([c, d, t]) => html`
          <path d=${d} pathLength="100" fill="none" stroke=${c} stroke-width="3" stroke-linejoin="round" stroke-dasharray="100" class="at-glow" style=${{ color: c }}>
            <animate attributeName="stroke-dashoffset" values="100;0;0" keyTimes=${`0;${t};1`} dur="7s" ...${loop} />
          </path>
          <circle r="5" fill=${c} stroke=${INK} stroke-width="2">
            <animateMotion path=${d} dur="7s" calcMode="linear" keyPoints="0;1;1" keyTimes=${`0;${t};1`} ...${loop} />
          </circle>
        `,
      )}
      <g transform="translate(214 110)" stroke=${ERR} stroke-width="3" stroke-linecap="round" opacity="0">
        <animate attributeName="opacity" values="0;0;1;1" keyTimes="0;0.4;0.41;1" dur="7s" ...${loop} />
        <path d="M-6 -16 L6 -4 M6 -16 L-6 -4" />
      </g>
    </g>
  `)
}

/* Legal Moves Only: Jev's queen slides to a real square; a text model's knight
 * tries one it can't reach. */
function chess(u) {
  const x0 = 96
  const y0 = 28
  const sq = (c, r) => [x0 + c * 18 + 9, y0 + r * 18 + 9]
  const [qx, qy] = sq(2, 6)
  const [tx, ty] = sq(6, 2)
  const [kx, ky] = sq(6, 0)
  const [nx, ny] = sq(1, 7)
  const [bx, by] = sq(4, 3)
  const piece = (x, y, g, white) => html`<text x=${x} y=${y + 6} text-anchor="middle" font-size="17" fill=${white ? '#f3f0ff' : '#150f2e'} stroke=${white ? 'none' : '#b8adff'} stroke-width="0.6">${g + '\uFE0E'}</text>`
  return svg('chess', html`
    <defs>
      <pattern id=${`chB${u}`} x=${x0} y=${y0} width="36" height="36" patternUnits="userSpaceOnUse">
        <rect width="36" height="36" fill="#2a2256" /><rect width="18" height="18" fill="#5d4fa8" /><rect x="18" y="18" width="18" height="18" fill="#5d4fa8" />
      </pattern>
    </defs>
    <rect x=${x0 - 4} y=${y0 - 4} width="152" height="152" rx="4" fill="#120d2c" stroke="rgba(177,140,255,0.55)" />
    <rect x=${x0} y=${y0} width="144" height="144" fill=${`url(#chB${u})`} />
    <rect x=${kx - 9} y=${ky - 9} width="18" height="18" fill=${ERR} opacity="0">
      <animate attributeName="opacity" values="0;0;0.8;0.2;0.8;0.2;0.8;0" keyTimes="0;0.5;0.56;0.62;0.68;0.74;0.8;0.9" dur="6s" ...${loop} />
    </rect>
    ${piece(kx, ky, '♚', false)}${piece(...sq(5, 1), '♟', false)}${piece(...sq(7, 1), '♟', false)}${piece(...sq(6, 1), '♟', false)}
    ${piece(...sq(4, 7), '♔', true)}${piece(nx, ny, '♘', true)}
    <line x1=${nx} y1=${ny} x2=${bx} y2=${by} stroke=${ERR} stroke-width="2.5" stroke-dasharray="4 3" opacity="0">
      <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.06;0.1;0.3;0.36;1" dur="6s" ...${loop} />
    </line>
    <g transform=${`translate(${bx} ${by})`} opacity="0" stroke=${ERR} stroke-width="3" stroke-linecap="round">
      <animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;0.1;0.12;0.3;0.36;1" dur="6s" ...${loop} />
      <path d="M-6 -6 L6 6 M6 -6 L-6 6" />
    </g>
    <line x1=${qx} y1=${qy} x2=${tx} y2=${ty} stroke="#3ef4ff" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="100" class="at-glow" style=${{ color: '#3ef4ff' }}>
      <animate attributeName="stroke-dashoffset" values="100;100;0;0" keyTimes="0;0.36;0.48;1" dur="6s" ...${loop} />
      <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" dur="6s" ...${loop} />
    </line>
    <g>
      <animateMotion path=${`M0 0 L${tx - qx} ${ty - qy}`} dur="6s" calcMode="linear" keyPoints="0;0;1;1" keyTimes="0;0.36;0.48;1" ...${loop} />
      ${piece(qx, qy, '♕', true)}
    </g>
    <g font-family="ui-monospace, monospace" font-size="9" font-weight="700">
      <rect x="10" y="58" width="74" height="20" rx="10" fill="rgba(62,245,160,0.12)" stroke=${OK} />
      <text x="47" y="71" text-anchor="middle" fill=${OK}>✓ LEGAL</text>
      <rect x="10" y="88" width="74" height="20" rx="10" fill="rgba(255,77,106,0.12)" stroke=${ERR} />
      <text x="47" y="101" text-anchor="middle" fill=${ERR}>✕ ILLEGAL</text>
      <text x="274" y="42" text-anchor="middle" fill="#ffe14d" font-size="13" opacity="0">MATE!
        <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.52;0.88;0.9" dur="6s" ...${loop} />
      </text>
    </g>
  `)
}

/* Switchboard: callers ring, cords snake up to the right jacks. */
function switchboard(u) {
  const cords = [
    ['M92 198 C92 132 152 126 152 62', '#3ef5a0', [152, 58], 0],
    ['M160 198 C160 146 232 150 232 94', '#8b7bff', [232, 90], 0.28],
    ['M228 198 C228 128 88 120 88 46', '#3ef5a0', [88, 42], 0.56],
  ]
  return svg('switchboard', html`
    <defs>
      <pattern id=${`sbJ${u}`} x="40" y="26" width="16" height="16" patternUnits="userSpaceOnUse">
        <circle cx="8" cy="8" r="3.4" fill="#060412" stroke="#4a4f80" stroke-width="1.3" />
      </pattern>
    </defs>
    <rect x="32" y="16" width="262" height="120" rx="8" fill="#110c2a" stroke="rgba(62,245,160,0.35)" />
    <rect x="40" y="26" width="240" height="96" fill=${`url(#sbJ${u})`} />
    <g>
      ${[0, 1, 2, 3, 4].map((i) => html`<circle cx="16" cy=${30 + i * 20} r="4" fill=${i % 2 ? '#ffb545' : '#3ef5a0'} class="at-blink" style=${{ animationDelay: `${i * 0.37}s` }} />`)}
    </g>
    ${cords.map(
      ([d, c, [jx, jy], t]) => html`
        <circle cx=${jx} cy=${jy} r="5" fill=${c} opacity="0" class="at-glow" style=${{ color: c }}>
          <animate attributeName="opacity" values=${`0;0;1;1;0`} keyTimes=${`0;${t + 0.16};${t + 0.17};0.9;1`} dur="6s" ...${loop} />
        </circle>
        <path d=${d} fill="none" stroke=${c} stroke-width="3.5" stroke-linecap="round" pathLength="100" stroke-dasharray="100" opacity="0.95">
          <animate attributeName="stroke-dashoffset" values=${`100;100;0;0`} keyTimes=${`0;${t};${t + 0.16};1`} dur="6s" ...${loop} />
          <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.9;1" dur="6s" ...${loop} />
        </path>
      `,
    )}
    <g fill="#2a2a55" stroke="#8a93bd">
      <rect x="84" y="186" width="16" height="14" rx="2" /><rect x="152" y="186" width="16" height="14" rx="2" /><rect x="220" y="186" width="16" height="14" rx="2" />
    </g>
    <text x="300" y="150" text-anchor="end" font-family="ui-monospace, monospace" font-size="8" fill=${DIM}>150 LINES</text>
  `)
}

/* Customs: parcels ride the belt through the X-ray; each leaves by its chute. */
function customs(u) {
  const parcels = [
    ['M-40 0 H236 L300 -52', OK, '✓', 0],
    ['M-40 0 H236 L310 0', WARN, '!', 2],
    ['M-40 0 H236 L300 50', ERR, '✕', 4],
  ]
  return svg('customs', html`
    <defs>
      <linearGradient id=${`cuB${u}`} x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="#3ef4ff" stop-opacity="0" /><stop offset="0.5" stop-color="#3ef4ff" stop-opacity="0.45" /><stop offset="1" stop-color="#3ef4ff" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path d="M236 150 L306 96" stroke=${OK} stroke-width="6" stroke-linecap="round" opacity="0.5" />
    <path d="M236 150 L316 150" stroke=${WARN} stroke-width="6" stroke-linecap="round" opacity="0.5" />
    <path d="M236 150 L306 198" stroke=${ERR} stroke-width="6" stroke-linecap="round" opacity="0.5" />
    <rect x="4" y="150" width="236" height="12" rx="6" fill="#1a1540" stroke="#3a3470" />
    <line x1="10" y1="156" x2="234" y2="156" stroke="#6b64b0" stroke-width="2" stroke-dasharray="6 8">
      <animate attributeName="stroke-dashoffset" values="14;0" dur="0.5s" ...${loop} />
    </line>
    ${parcels.map(
      ([d, c, g, b]) => html`
        <g transform="translate(0 134)" opacity="0">
          <animate attributeName="opacity" values="1;1;0" keyTimes="0;0.96;1" dur="6s" begin=${`${b}s`} ...${loop} />
          <animateMotion path=${d} dur="6s" begin=${`${b}s`} ...${loop} />
          <rect x="-15" y="-11" width="30" height="22" rx="4" fill="#241d52" stroke="#8a93bd" stroke-width="1.5">
            <animate attributeName="stroke" values=${`#8a93bd;#8a93bd;${c}`} keyTimes="0;0.52;1" calcMode="discrete" dur="6s" begin=${`${b}s`} ...${loop} />
          </rect>
          <path d="M-9 -4 H9 M-9 1 H5 M-9 6 H7" stroke="#8a93bd" stroke-width="1.5" />
          <g opacity="0">
            <animate attributeName="opacity" values="0;0;1" keyTimes="0;0.52;1" calcMode="discrete" dur="6s" begin=${`${b}s`} ...${loop} />
            <circle cx="14" cy="-12" r="7" fill=${c} />
            <text x="14" y="-8.5" text-anchor="middle" font-size="10" font-weight="700" fill=${INK} font-family="system-ui, sans-serif">${g}</text>
          </g>
        </g>
      `,
    )}
    <path d="M100 150 V74 Q140 44 180 74 V150" fill="none" stroke="#3ef4ff" stroke-width="4" class="at-glow" style=${{ color: '#3ef4ff' }} />
    <rect x="104" y="74" width="72" height="74" fill=${`url(#cuB${u})`} class="at-scan" />
    <g font-family="ui-monospace, monospace" font-size="8" fill=${DIM}><text x="140" y="36" text-anchor="middle">X-RAY</text></g>
  `)
}

/* WikiGuessr: a spinning globe, a pin drops, the claim goes only as deep as it's sure. */
function wikiguessr(u) {
  const rows = [
    ['CONTINENT', 'EUROPE', OK, '✓', 0.2],
    ['COUNTRY', 'FRANCE', OK, '✓', 0.35],
    ['REGION', 'NOT SURE', WARN, '?', 0.5],
  ]
  return svg('wikiguessr', html`
    <defs>
      <clipPath id=${`wgC${u}`}><circle cx="96" cy="104" r="68" /></clipPath>
      <radialGradient id=${`wgG${u}`} cx="0.35" cy="0.3" r="0.8">
        <stop offset="0" stop-color="#1b4d6b" /><stop offset="1" stop-color="#08162a" />
      </radialGradient>
    </defs>
    <circle cx="96" cy="104" r="68" fill=${`url(#wgG${u})`} stroke="#2ee6c5" stroke-width="2" class="at-glow" style=${{ color: '#2ee6c5' }} />
    <g clip-path=${`url(#wgC${u})`}>
      <g fill="#2ee6c5" opacity="0.55">
        <animateTransform attributeName="transform" type="translate" values="-150 0;0 0" dur="12s" ...${loop} />
        ${[0, 150].map((dx) => html`
          <path transform=${`translate(${dx} 0)`} d="M40 70 q14 -14 34 -8 q10 10 -2 20 q-14 4 -12 18 q-10 8 -20 -4 q-8 -14 0 -26z M96 60 q20 -8 30 6 q-4 14 -18 12 q-14 -6 -12 -18z M70 120 q16 -6 26 8 q6 22 -8 34 q-14 -4 -18 -20 q-6 -12 0 -22z M112 104 q18 -4 28 10 q-4 14 -20 14 q-12 -10 -8 -24z" />
        `)}
      </g>
      <g fill="none" stroke="rgba(46,230,197,0.35)" stroke-width="1">
        <ellipse cx="96" cy="104" rx="68" ry="20" /><ellipse cx="96" cy="104" rx="68" ry="46" /><line x1="28" y1="104" x2="164" y2="104" />
        ${[0, -2, -4].map((b) => html`<ellipse cx="96" cy="104" rx="68" ry="68"><animate attributeName="rx" values="68;0;68" dur="6s" begin=${`${b}s`} ...${loop} /></ellipse>`)}
      </g>
    </g>
    <g>
      <animateTransform attributeName="transform" type="translate" values="0 -70;0 -70;0 0;0 -8;0 0;0 0" keyTimes="0;0.05;0.14;0.18;0.22;1" dur="6s" ...${loop} />
      <path d="M110 84 C110 76 102 72 102 64 A8 8 0 0 1 118 64 C118 72 110 76 110 84 Z" fill="#ff4d6a" stroke=${INK} stroke-width="1.5" />
      <circle cx="110" cy="64" r="3" fill=${INK} />
    </g>
    <circle cx="110" cy="84" r="0" fill="none" stroke="#ff4d6a" stroke-width="2">
      <animate attributeName="r" values="0;0;22" keyTimes="0;0.14;0.4" dur="6s" ...${loop} />
      <animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;0.14;0.15;0.4;1" dur="6s" ...${loop} />
    </circle>
    <g font-family="ui-monospace, monospace">
      ${rows.map(
        ([k, v, c, g, t], i) => html`
          <g transform=${`translate(184 ${58 + i * 34})`} opacity="0.25">
            <animate attributeName="opacity" values="0.25;0.25;1;1;0.25" keyTimes=${`0;${t};${t + 0.02};0.92;1`} dur="6s" ...${loop} />
            <rect width="124" height="26" rx="6" fill="rgba(255,255,255,0.03)" stroke=${c} />
            <text x="8" y="11" font-size="7" fill=${DIM}>${k}</text>
            <text x="8" y="21" font-size="9" font-weight="700" fill=${TXT}>${v}</text>
            <circle cx="110" cy="13" r="7" fill=${c} /><text x="110" y="16.5" text-anchor="middle" font-size="10" font-weight="700" fill=${INK} font-family="system-ui, sans-serif">${g}</text>
          </g>
        `,
      )}
    </g>
  `)
}

/* Rail Yard: each prompt is a train; Jev throws the switch to the model that should answer. */
function railyard() {
  const routes = [
    ['M-70 100 H112 C150 100 170 44 210 44 H400', 0, 44],
    ['M-70 100 H400', 2, 100],
    ['M-70 100 H112 C150 100 170 156 210 156 H400', 4, 156],
  ]
  const tracks = ['M0 100 H112 C150 100 170 44 210 44 H290', 'M112 100 H290', 'M112 100 C150 100 170 156 210 156 H290']
  return svg('railyard', html`
    <g fill="none" stroke-linecap="round">
      ${tracks.map((d) => html`<path d=${d} stroke="#2b2658" stroke-width="12" stroke-dasharray="3 7" />`)}
      ${tracks.map((d) => html`<path d=${d} stroke="#6b64b0" stroke-width="2.5" />`)}
    </g>
    ${routes.map(
      ([, b, y]) => html`
        <path d=${y === 100 ? 'M112 100 H146' : `M112 100 C124 100 130 ${y < 100 ? 92 : 108} 138 ${y < 100 ? 84 : 116}`} stroke="#ff8a3d" stroke-width="4" stroke-linecap="round" opacity="0" class="at-glow" style=${{ color: '#ff8a3d' }}>
          <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.33;0.34;1" dur="6s" begin=${`${b}s`} ...${loop} />
        </path>
      `,
    )}
    <circle cx="112" cy="100" r="6" fill="#ff8a3d" class="at-glow" style=${{ color: '#ff8a3d' }} />
    <g font-family="ui-monospace, monospace" font-size="9" font-weight="700" text-anchor="middle">
      ${[['SMALL', 44, 2], ['MID', 100, 0], ['LARGE', 156, 4]].map(
        ([t, y, b]) => html`
          <rect x="292" y=${y - 11} width="24" height="22" rx="4" fill="#150f33" stroke="#6b64b0" />
          <circle cx="304" cy=${y} r="5" fill=${DIM}>
            <animate attributeName="fill" values=${`${DIM};${DIM};${OK};${OK};${DIM}`} keyTimes="0;0.24;0.25;0.33;0.34" calcMode="discrete" dur="6s" begin=${`${b}s`} ...${loop} />
          </circle>
          <text x="262" y=${y - 14} fill=${DIM} font-size="8">${t}</text>
        `,
      )}
    </g>
    ${routes.map(
      ([d, b]) => html`
        <g opacity="0">
          <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.33;0.34;1" dur="6s" begin=${`${b}s`} ...${loop} />
          <animateMotion path=${d} rotate="auto" dur="6s" calcMode="linear" keyPoints="0;1;1" keyTimes="0;0.33;1" begin=${`${b}s`} ...${loop} />
          <rect x="-50" y="-6" width="22" height="12" rx="2" fill="#8a5a00" stroke="#ffb545" />
          <rect x="-25" y="-8" width="30" height="16" rx="3" fill="#ff8a3d" />
          <rect x="-19" y="-5" width="8" height="5" fill=${INK} /><rect x="-7" y="-5" width="8" height="5" fill=${INK} />
          <circle cx="6" cy="0" r="2.5" fill="#ffe14d" class="at-glow" style=${{ color: '#ffe14d' }} />
        </g>
      `,
    )}
  `)
}

/* Two Truths and a Lie: the lens checks each claim against the article. */
function twotruths() {
  const card = (x, lie) => html`
    <rect x=${x} y="36" width="80" height="112" rx="8" fill="#151036" stroke="rgba(255,79,216,0.35)" />
    <g stroke="#3a3470" stroke-width="3" stroke-linecap="round"><path d=${`M${x + 10} 52 H${x + 70} M${x + 10} 62 H${x + 58} M${x + 10} 72 H${x + 64}`} /></g>
    <polyline fill="none" stroke=${lie ? ERR : OK} stroke-width="2" stroke-linejoin="round"
      points=${lie ? `${x + 8},112 ${x + 18},110 ${x + 24},92 ${x + 30},130 ${x + 36},96 ${x + 42},124 ${x + 48},104 ${x + 56},116 ${x + 72},112` : `${x + 8},112 ${x + 20},110 ${x + 32},114 ${x + 44},109 ${x + 56},113 ${x + 72},111`}
      class=${lie ? 'at-jitter' : ''} />
  `
  const stamp = (x, ok, t) => html`
    <g transform=${`translate(${x + 40} 136)`} opacity="0">
      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes=${`0;${t};${t + 0.02};0.92;1`} dur="7s" repeatCount="indefinite" />
      <g transform="rotate(-10)">
        <rect x="-26" y="-11" width="52" height="22" rx="4" fill="none" stroke=${ok ? OK : ERR} stroke-width="2.5" />
        <text y="5" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" font-weight="800" fill=${ok ? OK : ERR}>${ok ? 'TRUE' : 'LIE'}</text>
      </g>
    </g>
  `
  return svg('twotruths', html`
    ${card(22, false)}${card(120, false)}${card(218, true)}
    ${stamp(22, true, 0.2)}${stamp(120, true, 0.46)}${stamp(218, false, 0.72)}
    <g>
      <animateMotion path="M62 96 L62 96 L160 96 L160 96 L258 96 L258 96" dur="7s" calcMode="linear" keyPoints="0;0.2;0.4;0.6;0.8;1" keyTimes="0;0.2;0.32;0.46;0.6;1" repeatCount="indefinite" />
      <circle r="20" fill="rgba(255,79,216,0.10)" stroke="#ff4fd8" stroke-width="3" class="at-glow" style=${{ color: '#ff4fd8' }} />
      <line x1="14" y1="14" x2="30" y2="30" stroke="#ff4fd8" stroke-width="5" stroke-linecap="round" />
    </g>
  `)
}

/* Judges' Panel: the paddles go up; slide the weights and the podium reorders. */
function judges() {
  const paddles = [
    [70, '8', 0.05],
    [130, '6', 0.12],
    [190, '9', 0.19],
    [250, '7', 0.26],
  ]
  const bars = [
    [L1, '150;90;150', 'A'],
    [L2, '100;160;100', 'B'],
    [L3, '124;122;124', 'C'],
  ]
  return svg('judges', html`
    ${paddles.map(
      ([x, n, t]) => html`
        <g>
          <animateTransform attributeName="transform" type="translate" values="0 60;0 60;0 -4;0 0;0 0;0 60" keyTimes=${`0;${t};${t + 0.06};${t + 0.09};0.9;1`} dur="7s" repeatCount="indefinite" />
          <line x1=${x} y1="62" x2=${x} y2="98" stroke="#6b64b0" stroke-width="3" />
          <rect x=${x - 20} y="16" width="40" height="46" rx="5" fill=${TXT} />
          <text x=${x} y="52" text-anchor="middle" font-family="system-ui, sans-serif" font-size="30" font-weight="800" fill=${INK}>${n}</text>
        </g>
      `,
    )}
    <rect x="0" y="96" width="320" height="104" fill="#07051a" />
    <line x1="40" y1="112" x2="280" y2="112" stroke="#3a3470" stroke-width="4" stroke-linecap="round" />
    <circle cx="100" cy="112" r="7" fill="#ffd84d" class="at-glow" style=${{ color: '#ffd84d' }}>
      <animate attributeName="cx" values="100;220;100" dur="7s" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1" repeatCount="indefinite" />
    </circle>
    ${bars.map(
      ([c, w, k], i) => html`
        <text x="36" y=${138 + i * 20} text-anchor="end" font-family="ui-monospace, monospace" font-size="9" fill=${DIM}>${k}</text>
        <rect x="42" y=${130 + i * 20} height="11" rx="3" fill=${c} width="120">
          <animate attributeName="width" values=${w} dur="7s" calcMode="spline" keySplines=".5 0 .5 1;.5 0 .5 1" repeatCount="indefinite" />
        </rect>
      `,
    )}
  `)
}

/* Ghost Maze: the chomper laps the maze; the ghosts don't wait. */
function ghostmaze() {
  const lap = 'M52 44 H268 V156 H52 Z'
  const pellets = []
  for (let x = 72; x < 268; x += 20) pellets.push([x, 44], [x, 156])
  for (let y = 64; y < 156; y += 20) pellets.push([52, y], [268, y])
  const ghost = (c, b) => html`
    <g>
      <animateMotion path=${lap} dur="9s" begin=${b} repeatCount="indefinite" />
      <path d="M-9 9 V-1 A9 9 0 0 1 9 -1 V9 L6 6 L3 9 L0 6 L-3 9 L-6 6 Z" fill=${c} />
      <circle cx="-3.5" cy="-1" r="2.6" fill="#fff" /><circle cx="3.5" cy="-1" r="2.6" fill="#fff" />
      <circle cx="-2.8" cy="-0.6" r="1.2" fill="#1d3cff" /><circle cx="4.2" cy="-0.6" r="1.2" fill="#1d3cff" />
    </g>
  `
  return svg('ghostmaze', html`
    <g fill="none" stroke="#5b7cff" stroke-width="3" stroke-linejoin="round" class="at-glow" style=${{ color: '#5b7cff' }}>
      <rect x="30" y="22" width="260" height="156" rx="12" />
      <rect x="74" y="66" width="70" height="68" rx="6" />
      <rect x="176" y="66" width="70" height="68" rx="6" />
      <path d="M160 22 V32 M160 168 V178" />
    </g>
    <g fill="#ffd6a0">${pellets.map(([x, y]) => html`<circle cx=${x} cy=${y} r="2.2" />`)}</g>
    <g fill="#ffd6a0" class="at-blink">
      <circle cx="52" cy="44" r="5" /><circle cx="268" cy="156" r="5" />
    </g>
    <text x="160" y="106" text-anchor="middle" font-family="ui-monospace, monospace" font-size="11" font-weight="700" fill="#ffe14d" class="at-blink">READY!</text>
    ${ghost('#ff4d6a', '-2.2s')}${ghost('#ff9ce6', '-3.1s')}${ghost('#3ef4ff', '-4s')}
    <g>
      <animateMotion path=${lap} dur="9s" rotate="auto" repeatCount="indefinite" />
      <path fill="#ffe14d" class="at-glow" style=${{ color: '#ffe14d' }} d="M0 0 L10 -7 A12 12 0 1 0 10 7 Z">
        <animate attributeName="d" values="M0 0 L10 -7 A12 12 0 1 0 10 7 Z;M0 0 L12 -1 A12 12 0 1 0 12 1 Z;M0 0 L10 -7 A12 12 0 1 0 10 7 Z" dur="0.32s" repeatCount="indefinite" />
      </path>
    </g>
  `)
}

/* Needle Hunt: the scan runs down the page and locks on the one line that answers. */
function needle(u) {
  const widths = [118, 96, 124, 88, 110, 120, 70, 104, 116, 92, 122, 84]
  return svg('needle', html`
    <defs><clipPath id=${`ndC${u}`}><rect x="84" y="16" width="152" height="168" rx="6" /></clipPath></defs>
    <rect x="84" y="16" width="152" height="168" rx="6" fill="#120d2c" stroke="rgba(182,255,62,0.35)" />
    <g clip-path=${`url(#ndC${u})`}>
      ${widths.map((w, i) => html`<rect x="98" y=${28 + i * 13} width=${w} height="5" rx="2.5" fill=${i === 8 ? '#b6ff3e' : '#3a3470'} opacity=${i === 8 ? 0.35 : 1}>
        ${i === 8 && html`<animate attributeName="opacity" values="0.35;0.35;1;1;0.35" keyTimes="0;0.62;0.64;0.92;1" dur="6s" repeatCount="indefinite" />`}
      </rect>`)}
      <rect x="84" y="20" width="152" height="15" fill="rgba(182,255,62,0.16)" stroke="#b6ff3e" stroke-width="1">
        <animate attributeName="y" values="20;150;128;128;20" keyTimes="0;0.5;0.62;0.92;1" dur="6s" repeatCount="indefinite" />
      </rect>
    </g>
    <g opacity="0">
      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.64;0.66;0.92;1" dur="6s" repeatCount="indefinite" />
      <path d="M240 135 H262" stroke="#b6ff3e" stroke-width="2" />
      <rect x="262" y="124" width="50" height="22" rx="5" fill="#b6ff3e" />
      <text x="287" y="139" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="800" fill=${INK}>FOUND</text>
    </g>
    <g font-family="ui-monospace, monospace">
      <rect x="10" y="30" width="62" height="40" rx="8" fill="rgba(182,255,62,0.08)" stroke="rgba(182,255,62,0.5)" />
      <text x="41" y="56" text-anchor="middle" font-size="20" font-weight="800" fill="#b6ff3e">?</text>
      <text x="41" y="86" text-anchor="middle" font-size="8" fill=${DIM}>QUESTION</text>
    </g>
  `)
}

/* Slot Machine: the same post, pulled again and again; does the verdict hold still? */
function slots(u) {
  const strip = ['✓', '✕', '?', '✓', '✕', '?', '✓']
  const colour = { '✓': OK, '✕': ERR, '?': WARN }
  const reel = (x, stop) => html`
    <g clip-path=${`url(#slR${u}${x})`}>
      <rect x=${x} y="66" width="52" height="64" fill="#f5f2ff" />
      <g>
        <animateTransform attributeName="transform" type="translate" values="0 0;0 -216;0 -216" keyTimes=${`0;${stop};1`} dur="5s" calcMode="spline" keySplines=".2 .1 .3 1;0 0 1 1" repeatCount="indefinite" />
        ${strip.map((g, i) => html`<text x=${x + 26} y=${110 + i * 36} text-anchor="middle" font-family="system-ui, sans-serif" font-size="30" font-weight="800" fill=${colour[g]}>${g}</text>`)}
      </g>
    </g>
  `
  return svg('slots', html`
    <defs>
      ${[80, 134, 188].map((x) => html`<clipPath id=${`slR${u}${x}`}><rect x=${x} y="66" width="52" height="64" rx="4" /></clipPath>`)}
      <linearGradient id=${`slB${u}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ff4d7a" /><stop offset="1" stop-color="#7a1238" /></linearGradient>
    </defs>
    <rect x="64" y="22" width="192" height="160" rx="16" fill=${`url(#slB${u})`} stroke="#ffc2d3" stroke-width="2" />
    <rect x="72" y="30" width="176" height="22" rx="8" fill="#2a0a1e" />
    <g>
      ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => html`<circle cx=${86 + i * 21} cy="41" r="4" fill=${i % 2 ? '#ffe14d' : '#fff'} class="at-blink" style=${{ animationDelay: `${(i % 2) * 0.4}s` }} />`)}
    </g>
    ${reel(80, 0.32)}${reel(134, 0.44)}${reel(188, 0.56)}
    <rect x="76" y="94" width="168" height="4" rx="2" fill="#ffe14d" opacity="0">
      <animate attributeName="opacity" values="0;0;1;0;1;0;1;0" keyTimes="0;0.58;0.62;0.68;0.74;0.8;0.86;0.92" dur="5s" repeatCount="indefinite" />
    </rect>
    <rect x="96" y="146" width="128" height="22" rx="6" fill="#2a0a1e" />
    <text x="160" y="161" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="700" fill="#ffe14d">15 PULLS</text>
    <g>
      <animateTransform attributeName="transform" type="rotate" values="0 262 120;0 262 120;28 262 120;0 262 120;0 262 120" keyTimes="0;0.02;0.08;0.16;1" dur="5s" repeatCount="indefinite" />
      <line x1="262" y1="120" x2="286" y2="56" stroke="#c8c3e8" stroke-width="5" stroke-linecap="round" />
      <circle cx="287" cy="52" r="9" fill="#ff4d7a" stroke="#fff" stroke-width="2" />
    </g>
    <rect x="256" y="112" width="12" height="18" rx="3" fill="#5a1030" />
  `)
}

/* Drive-Thru: an order spoken into the box comes out as a typed call. */
function drivethru() {
  const lines = ['add_item(', '  item="burger",', '  qty=2,', '  no="pickles")']
  return svg('drivethru', html`
    <rect x="24" y="44" width="68" height="104" rx="10" fill="#2a1030" stroke="#ff6a3d" stroke-width="2" />
    <g stroke="#ff6a3d" stroke-width="2" opacity="0.8">${[0, 1, 2, 3, 4, 5].map((i) => html`<line x1="38" x2="78" y1=${64 + i * 8} y2=${64 + i * 8} />`)}</g>
    <rect x="52" y="148" width="12" height="44" fill="#2a1030" />
    ${[0, 1, 2].map(
      (i) => html`<path d=${`M${104 + i * 12} ${76 - i * 8} q${10 + i * 4} ${20 + i * 8} 0 ${40 + i * 16}`} fill="none" stroke="#ffe14d" stroke-width="2.5" stroke-linecap="round" class="at-wave" style=${{ animationDelay: `${i * 0.18}s` }} />`,
    )}
    <path d="M150 96 H176 M168 88 L176 96 L168 104" fill="none" stroke=${DIM} stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <rect x="184" y="22" width="120" height="12" rx="4" fill="#3a3470" />
    <g>
      <rect x="192" y="30" width="104" height="0" fill="#f3efe6">
        <animate attributeName="height" values="0;0;120;120;0" keyTimes="0;0.1;0.5;0.9;1" dur="6s" repeatCount="indefinite" />
      </rect>
      <g font-family="ui-monospace, monospace" font-size="9.5" font-weight="700">
        ${lines.map((t, i) => html`<text x="198" y=${54 + i * 22} fill=${i === 0 || i === 3 ? '#b8321a' : '#1c1840'} opacity="0">${t}
          <animate attributeName="opacity" values="0;0;1;1;0" keyTimes=${`0;${0.18 + i * 0.08};${0.2 + i * 0.08};0.9;0.92`} dur="6s" repeatCount="indefinite" />
        </text>`)}
      </g>
    </g>
  `)
}

/* Memory Match: cards flip in pairs; same product, a close variant, or not. */
function memory() {
  const cards = [
    [26, 30, '#3ef5a0', 'A', 0.1],
    [96, 30, '#ffb545', 'B', 0.3],
    [166, 30, '#8b7bff', 'C', 0.5],
    [236, 30, '#ff4d6a', 'D', 0.7],
    [26, 110, '#ffb545', 'B', 0.3],
    [96, 110, '#3ef5a0', 'A', 0.1],
    [166, 110, '#ff4d6a', 'E', 0.7],
    [236, 110, '#8b7bff', 'C', 0.5],
  ]
  const links = [
    ['M52 90 L122 110', OK, '0', 0.2],
    ['M122 90 L52 110', WARN, '4 3', 0.4],
    ['M192 90 L262 110', OK, '0', 0.6],
  ]
  return svg('memory', html`
    ${links.map(
      ([d, c, dash, t]) => html`<path d=${d} stroke=${c} stroke-width="3" stroke-dasharray=${dash} opacity="0">
        <animate attributeName="opacity" values="0;0;1;1;0" keyTimes=${`0;${t};${t + 0.02};0.92;1`} dur="7s" repeatCount="indefinite" />
      </path>`,
    )}
    ${cards.map(
      ([x, y, c, k, t]) => html`
        <g transform=${`translate(${x + 26} ${y + 30})`}>
          <g>
            <animateTransform attributeName="transform" type="scale" values="1 1;1 1;0 1;1 1;1 1;0 1;1 1" keyTimes=${`0;${t - 0.04};${t - 0.02};${t};0.9;0.93;0.96`} dur="7s" repeatCount="indefinite" />
            <rect x="-26" y="-30" width="52" height="60" rx="6" fill="#231a4d" stroke="#f0abfc" stroke-width="1.5" />
            <path d="M-12 -12 L12 12 M12 -12 L-12 12" stroke="rgba(240,171,252,0.35)" stroke-width="3" />
            <g opacity="0">
              <animate attributeName="opacity" values="0;0;1;1;0" keyTimes=${`0;${t - 0.02};${t - 0.019};0.93;0.931`} dur="7s" calcMode="discrete" repeatCount="indefinite" />
              <rect x="-26" y="-30" width="52" height="60" rx="6" fill="#f5f2ff" />
              <rect x="-14" y="-18" width="28" height="22" rx="4" fill=${c} />
              <text y="22" text-anchor="middle" font-family="ui-monospace, monospace" font-size="10" font-weight="800" fill=${INK}>${k}</text>
            </g>
          </g>
        </g>
      `,
    )}
  `)
}

/* The Big Sort: a flood of articles pours from the hopper into topic bins. */
function bigsort() {
  const bins = [
    [52, '#4fa3ff', 'SCIENCE'],
    [124, '#ffb545', 'PEOPLE'],
    [196, '#3ef5a0', 'PLACES'],
    [268, '#ff4fd8', 'ARTS'],
  ]
  const bits = Array.from({ length: 20 }, (_, i) => i)
  return svg('bigsort', html`
    <path d="M122 8 H198 L174 40 H146 Z" fill="#1a1540" stroke="#4fa3ff" stroke-width="2" class="at-glow" style=${{ color: '#4fa3ff' }} />
    ${bits.map((i) => {
      const [bx, c] = bins[(i * 7) % 4]
      const b = (i * 0.17).toFixed(2)
      return html`<rect x="-3" y="-3" width="6" height="6" rx="1" fill=${c} opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="2.4s" begin=${`${b}s`} repeatCount="indefinite" />
        <animateMotion path=${`M160 40 Q${(160 + bx) / 2 + (i % 3) * 8 - 8} ${70 + (i % 4) * 6} ${bx + (i % 3) * 10 - 10} 164`} dur="2.4s" begin=${`${b}s`} repeatCount="indefinite" />
      </rect>`
    })}
    ${bins.map(
      ([x, c, t], i) => html`
        <rect x=${x - 30} y="140" width="60" height="44" rx="5" fill="rgba(255,255,255,0.03)" stroke=${c} stroke-width="2" />
        <rect x=${x - 27} width="54" rx="3" fill=${c} opacity="0.55">
          <animate attributeName="height" values="2;36;36;2" keyTimes="0;0.85;0.95;1" dur="12s" begin=${`${-i * 1.3}s`} repeatCount="indefinite" />
          <animate attributeName="y" values="180;146;146;180" keyTimes="0;0.85;0.95;1" dur="12s" begin=${`${-i * 1.3}s`} repeatCount="indefinite" />
        </rect>
        <text x=${x} y="196" text-anchor="middle" font-family="ui-monospace, monospace" font-size="7.5" fill=${DIM}>${t}</text>
      `,
    )}
  `)
}

/* Blind Tasting: the note is measured, the model does the maths, the needle lands just under the critic. */
function tasting(u) {
  return svg('tasting', html`
    <defs>
      <clipPath id=${`tsC${u}`}><path d="M58 36 H122 C122 80 110 100 90 100 C70 100 58 80 58 36 Z" /></clipPath>
    </defs>
    <g clip-path=${`url(#tsC${u})`}>
      <path fill="#b0164e">
        <animate attributeName="d" values="M50 64 Q70 56 90 64 T130 64 V110 H50 Z;M50 64 Q70 72 90 64 T130 64 V110 H50 Z;M50 64 Q70 56 90 64 T130 64 V110 H50 Z" dur="2.6s" repeatCount="indefinite" />
      </path>
    </g>
    <path d="M58 36 H122 C122 80 110 100 90 100 C70 100 58 80 58 36 Z" fill="none" stroke="#ffd1e3" stroke-width="2.5" />
    <path d="M90 100 V150 M70 154 H110" stroke="#ffd1e3" stroke-width="3" stroke-linecap="round" />
    <path d="M160 150 A80 80 0 0 1 300 150" fill="none" stroke="#2b2658" stroke-width="14" stroke-linecap="round" transform="translate(-10 0)" />
    <path d="M150 150 A70 70 0 0 1 290 150" fill="none" stroke="#ff7eb6" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="100" class="at-glow" style=${{ color: '#ff7eb6' }}>
      <animate attributeName="stroke-dashoffset" values="100;100;22;22;100" keyTimes="0;0.1;0.5;0.9;1" dur="6s" repeatCount="indefinite" />
    </path>
    <line x1="266" y1="98" x2="276" y2="88" stroke="#ffe14d" stroke-width="3" stroke-linecap="round" />
    <text x="284" y="84" font-family="ui-monospace, monospace" font-size="8" fill="#ffe14d">CRITIC</text>
    <g>
      <animateTransform attributeName="transform" type="rotate" values="-90 220 150;-90 220 150;46 220 150;42 220 150;42 220 150;-90 220 150" keyTimes="0;0.1;0.46;0.52;0.9;1" dur="6s" calcMode="spline" keySplines=".4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1;.4 0 .2 1" repeatCount="indefinite" />
      <line x1="220" y1="150" x2="220" y2="92" stroke=${TXT} stroke-width="3" stroke-linecap="round" />
    </g>
    <circle cx="220" cy="150" r="7" fill="#ff7eb6" />
    <text x="220" y="184" text-anchor="middle" font-family="ui-monospace, monospace" font-size="20" font-weight="800" fill=${TXT} opacity="0">91
      <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;0.5;0.52;0.9;0.92" dur="6s" repeatCount="indefinite" />
    </text>
  `)
}

export const SCENES = {
  wikirace,
  chess,
  switchboard,
  customs,
  wikiguessr,
  railyard,
  twotruths,
  judges,
  ghostmaze,
  needle,
  slots,
  drivethru,
  memory,
  bigsort,
  tasting,
}
