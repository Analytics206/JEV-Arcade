/* WikiGuessr's pure half: the tile map's geometry and the readings the page
 * draws from a run. No DOM, no Preact: `node --test tests/js` imports it as the
 * browser does.
 *
 * The run carries the map as rows `[name, code, continent, col, row]` (from
 * games/data/wikiguessr.json): a square per country on its continent's own
 * grid, laid out by hand to be roughly geographic.
 */

export const LEVELS = ['continent', 'country', 'region']
export const TILE = 50
export const GAP = 2
export const STEP = TILE + GAP
/** Tiles fainter than this still show their colour as a hint, not as a claim. */
const MIN_ALPHA = 0.12

/** One continent's tiles, in pixels, and the box they fill. */
export function continentLayout(map, continent, { tile = TILE, gap = GAP } = {}) {
  const step = tile + gap
  const tiles = (map ?? [])
    .filter((row) => row[2] === continent)
    .map(([name, code, , col, row]) => {
      const x = col * step
      const y = row * step
      return { name, code, col, row, x, y, w: tile, h: tile, cx: x + tile / 2, cy: y + tile / 2 }
    })
  const cols = tiles.reduce((m, t) => Math.max(m, t.col + 1), 0)
  const rows = tiles.reduce((m, t) => Math.max(m, t.row + 1), 0)
  return { tiles, cols, rows, width: cols ? cols * step - gap : 0, height: rows ? rows * step - gap : 0 }
}

/** How bright a tile is for its probability: nothing for none, the likeliest
 *  country full, the rest by the square root of their share of it (so a 0.04
 *  still shows beside a 0.71). */
export function tileAlpha(p, maxP) {
  if (!(p > 0) || !(maxP > 0)) return 0
  return Math.min(1, MIN_ALPHA + (1 - MIN_ALPHA) * Math.sqrt(Math.min(1, p / maxP)))
}

/** Dark ink on a bright tile, light ink on a dim one. */
export const inkOn = (alpha) => (alpha > 0.55 ? 'dark' : 'light')

/** A lane's ring around a tile: the k-th ring on the same tile sits further
 *  out, and its number tag sits on its top edge, clear of the others' tags. */
export function ringRect(t, k = 0) {
  const pad = 2 + 3.5 * k
  const x = t.x - pad
  const y = t.y - pad
  return { x, y, w: t.w + 2 * pad, h: t.h + 2 * pad, tag: { x: t.x + 1 + 15 * k, y: y - 6, w: 12, h: 12 } }
}

/** Room a map needs around its tiles for four rings and their tags. */
export const MAP_PAD = 20

/** A map pin whose point touches (x, y): the answer's marker. */
export function pinPath(x, y, r = 7) {
  const top = y - 3 * r
  return `M${x} ${y} C${x} ${y - r} ${x - r} ${top + r * 1.2} ${x - r} ${top} A${r} ${r} 0 0 1 ${x + r} ${top} C${x + r} ${top + r * 1.2} ${x} ${y - r} ${x} ${y} Z`
}

/** The continent bar: every continent's share, widest first, as percentages. */
export function stackSegments(top) {
  let at = 0
  return (top ?? []).map((t) => {
    const w = Math.max(0, t.p) * 100
    const seg = { option: t.option, p: t.p, x: at, w }
    at += w
    return seg
  })
}

/** How a claim reads: `Occitania, France`, `France`, `Europe`, or `no claim`. */
export function claimText(claim) {
  if (!claim?.length) return 'no claim'
  if (claim.length === 1) return claim[0]
  return [...claim.slice(1)].reverse().join(', ')
}

/** The level a claim reached, in words. */
export const depthWord = (n) => ['no claim', 'continent', 'country', 'region'][n] ?? 'region'

/** Every lane's claim for round *k*: {lane index: claim item}. */
export function claimsFor(run, k) {
  const out = {}
  for (const ln of run?.lanes ?? []) {
    const c = (ln.claims ?? []).find((x) => x.round === k)
    if (c) out[ln.index] = c
  }
  return out
}

/** Round *k*'s result for a lane, once revealed. */
export const resultFor = (round, lane) => round?.results?.find((r) => r.lane === lane) ?? null

/** Which continent the map opens on: the answer's once revealed, else where
 *  Jev's best path goes, else the first lane's claim, else Europe. */
export function focusContinent(round, claims, jevLane) {
  if (round?.answer?.continent && round.answer.continent !== 'Antarctica') return round.answer.continent
  const jev = jevLane != null ? claims[jevLane] : null
  const best = jev?.levels?.[1]?.paths?.[0]?.path?.[0] ?? jev?.levels?.[0]?.top?.[0]?.option
  if (best && best !== 'Antarctica') return best
  const any = Object.values(claims).find((c) => c.claim?.length && c.claim[0] !== 'Antarctica')
  return any?.claim?.[0] ?? 'Europe'
}

/** A level against the threshold: `claim` or `stop`. */
export const verdict = (level, threshold) => (level && level.confidence >= threshold ? 'claim' : 'stop')

/** The scoreboard: per lane, points in each round and the total so far. */
export function scoreboard(run) {
  const rounds = run?.rounds ?? []
  return (run?.lanes ?? []).map((ln) => {
    const per = rounds.map((rd) => resultFor(rd, ln.index)?.points ?? null)
    return {
      lane: ln.index, label: ln.label, per,
      total: per.reduce((s, v) => s + (v ?? 0), 0),
      busts: rounds.filter((rd) => resultFor(rd, ln.index)?.marks?.includes('wrong')).length,
    }
  })
}

/** What the map shows, in words, for its aria-label. */
export function mapSummary(continent, tiles, probs, n = 5) {
  const lit = tiles
    .filter((t) => probs?.[t.name] > 0)
    .sort((a, b) => probs[b.name] - probs[a.name])
    .slice(0, n)
    .map((t) => `${t.name} ${probs[t.name].toFixed(2)}`)
  return lit.length
    ? `Tile map of ${continent} coloured by Jev's belief: ${lit.join(', ')}.`
    : `Tile map of ${continent}: ${tiles.length} countries.`
}

/** The article's text as runs of words and hidden names, a paragraph a line. */
export function articleRuns(text) {
  return (text ?? '').split('\n').map((para) =>
    para.split(/(█+)/).filter(Boolean).map((s) => (s[0] === '█' ? { hidden: s.length } : { text: s })),
  )
}

/* ── The claim ladder ──────────────────────────────────────────────────────── */

/** The game's points (games/wikiguessr.py POINTS), for a run that lacks them. */
export const POINTS = { continent: 1, country: 3, region: 6, wrong: -6 }

/**
 * A lane's claim for a round as the ladder draws it: one tier per level,
 * continent → country → region, each with a state:
 *
 *   wait    no claim yet (the lane is thinking)
 *   claim   claimed, not yet revealed
 *   right   claimed and right (pts: what it earned)
 *   bust    the first wrong claim (pts: the bust)
 *   void    claimed after a bust: it doesn't count
 *   stop    Jev's confidence here was under the threshold, so it stopped
 *   foul    a text model named something not on the lists (name: what it said)
 *   unsure  a text model left this level out, or said it was unsure
 *   end     nothing deeper to claim (no country in Antarctica, no regions listed)
 *   none    below where the claim stopped
 *
 * `conf` is Jev's confidence at that level, when it was asked it.
 */
export function tiersOf(claim, result, points = POINTS) {
  const pts = { ...POINTS, ...(points ?? {}) }
  return LEVELS.map((level, i) => {
    const t = { level, i, state: 'none', name: null, conf: null, pts: null }
    if (!claim) return { ...t, state: 'wait' }
    const lv = claim.kind === 'jev' ? claim.levels?.[i] : null
    if (lv && Number.isFinite(lv.confidence)) t.conf = lv.confidence
    const said = claim.claim ?? []
    const name = said[i]
    if (name) {
      t.name = name
      if (!result) return { ...t, state: 'claim' }
      const m = result.marks?.[i]
      if (m === 'right') return { ...t, state: 'right', pts: pts[level] }
      if (m === 'wrong') return { ...t, state: 'bust', pts: pts.wrong }
      return { ...t, state: 'void' }
    }
    if (i !== said.length) return t
    if (claim.kind === 'jev') return { ...t, state: claim.stopped_at === i + 1 ? 'stop' : 'end' }
    if (claim.fouls?.includes(level)) return { ...t, state: 'foul', name: claim.said?.[level] ?? null }
    return { ...t, state: 'unsure' }
  })
}

/** Right all the way down: continent, country and region. */
export const bullseye = (result) => result?.marks?.length === 3 && result.marks.every((m) => m === 'right')

/**
 * Who won, by the game's rule: the most points over the articles. Lanes that
 * dropped out (an error, a stop) are out of it when another lane played to
 * the end. Ties are several lanes; no lanes, none.
 */
export function winnersOf(run) {
  const lanes = run?.lanes ?? []
  const done = lanes.filter((ln) => ln.status === 'done')
  const field = done.length ? done : lanes
  if (!field.length) return []
  const score = (ln) => (Number.isFinite(ln.score) ? ln.score : 0)
  const best = Math.max(...field.map(score))
  return field.filter((ln) => score(ln) === best).map((ln) => ln.index)
}
