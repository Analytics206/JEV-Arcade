/* Drive-Thru's pure half: the customer's words with their change marked, the
 * ticket a window printed as receipt rows, the function calls code makes from
 * it, and each window's queue of cars. Plain data in, plain data out, so
 * `node --test tests/js` imports it as the browser does. */

/** The customer's words in parts, the mid-order change marked: [{text, change}]. */
export function splitChange(said, change) {
  const s = String(said ?? '')
  const at = change ? s.indexOf(change) : -1
  if (at < 0) return [{ text: s, change: false }]
  return [
    { text: s.slice(0, at), change: false },
    { text: change, change: true },
    { text: s.slice(at + change.length), change: false },
  ].filter((p) => p.text)
}

const itemName = (id) => String(id).replace(/_/g, ' ')
const modName = (run, m) => run?.mods?.[m] ?? itemName(m)

/** Whether the least sure argument is about this row. */
function isLeast(least, kind, item, mod) {
  if (!least) return false
  if (least.kind !== kind) return false
  if (kind === 'off_menu') return true
  return least.item === item && (mod == null || least.mod === mod)
}

/**
 * A ticket as the receipt prints it, one row per item and a sub-row per
 * modifier or part, each with how sure Jev was (text windows have none), the
 * least sure row marked. Row: {kind: 'item'|'sub'|'none'|'clarify'|'foul', text, conf, least, why}.
 */
export function receiptRows(ticket, run) {
  if (!ticket || ticket.status !== 'served') return []
  const least = ticket.least ?? null
  const rows = []
  const byItem = new Map()
  for (const ln of ticket.lines ?? []) {
    if (!byItem.has(ln.item)) byItem.set(ln.item, [])
    byItem.get(ln.item).push(ln)
  }
  for (const [item, lines] of byItem) {
    const total = lines.reduce((a, l) => a + l.qty, 0)
    const conf = lines[0].conf ?? null
    const size = lines[0].size
    const sameSize = lines.every((l) => l.size === size)
    const qtyConf = conf?.qty ?? null
    const sizeConf = conf?.size ?? null
    const head = `${total} × ${itemName(item)}${size && sameSize ? ` · ${size}` : ''}`
    rows.push({
      kind: 'item', text: head, item,
      conf: qtyConf != null && sizeConf != null ? Math.min(qtyConf, sizeConf) : qtyConf,
      least: isLeast(least, 'qty', item) || isLeast(least, 'size', item),
      title: qtyConf != null ? `how many ${qtyConf.toFixed(2)}${sizeConf != null ? ` · size ${sizeConf.toFixed(2)}` : ''}` : undefined,
    })
    if (lines.length === 1) {
      for (const m of lines[0].mods ?? []) {
        rows.push({ kind: 'sub', text: modName(run, m), item, conf: conf?.mods?.[m] ?? null, least: isLeast(least, 'mod', item, m) })
      }
      if (least?.kind === 'mod' && least.item === item && !least.value) {
        rows.push({ kind: 'sub', text: `as it comes (not ${modName(run, least.mod)})`, item, conf: least.conf, least: true })
      }
    } else {
      let unit = 1
      lines.forEach((l) => {
        const mods = (l.mods ?? []).map((m) => modName(run, m)).join(', ')
        const sz = !sameSize && l.size ? `${l.size} · ` : ''
        const splitConf = conf?.split ?? null
        const modConf = (l.mods ?? []).length ? Math.min(...l.mods.map((m) => conf?.mods?.[m] ?? 1)) : null
        const units = l.qty === 1 ? `#${unit}` : `#${unit}–${unit + l.qty - 1}`
        unit += l.qty
        rows.push({
          kind: 'sub', item,
          text: `${units} ${sz}${mods || 'as it comes'}`,
          conf: splitConf != null ? Math.min(splitConf, modConf ?? 1) : modConf,
          least: isLeast(least, 'split', item) || (!!mods && (l.mods ?? []).some((m) => isLeast(least, 'mod', item, m))),
        })
      })
    }
  }
  // An item Jev was least sure it did NOT hear, still worth a row.
  if (least?.kind === 'qty' && least.value === 0) {
    rows.push({ kind: 'none', text: `0 × ${itemName(least.item)}`, item: least.item, conf: least.conf, least: true })
  }
  if (ticket.off_menu) {
    rows.push({
      kind: 'clarify', text: ticket.clarify ? `asks about: ${ticket.clarify}` : 'asks about something not on the menu',
      conf: least?.kind === 'off_menu' ? least.conf : null, least: isLeast(least, 'off_menu'),
    })
  } else if (least?.kind === 'off_menu') {
    rows.push({ kind: 'none', text: 'nothing off the menu', conf: least.conf, least: true })
  }
  for (const f of ticket.fouls ?? []) rows.push({ kind: 'foul', text: f.line, why: f.why, conf: null, least: false })
  return rows
}

const COUNT_WORDS = ['none', 'one', 'two', 'three', 'four']

/** The other options of the least sure choice, as the receipt notes them:
 *  "large 0.12 · small 0.04", "one 0.11 · three 0.03"; `changed` adds that the order changed mid-way. */
export function altsText(least, changed = false) {
  if (!least?.alts) return ''
  const name = (o) => (least.kind === 'size' ? (o === 'none' ? 'no size said' : o) : (COUNT_WORDS[Number(o)] ?? o))
  const alts = least.alts
    .slice(1)
    .filter((a) => a.p >= 0.005)
    .map((a) => `${name(a.option)} ${a.p.toFixed(2)}`)
    .join(' · ')
  return alts && changed ? `${alts}: changed mid-order` : alts
}

const q = (s) => JSON.stringify(String(s))

/** The function calls code makes from a ticket (and, for a text window, its fouls as comments). */
export function callsOf(ticket) {
  if (!ticket) return []
  if (ticket.status === 'dropped') return ['# drove off before ordering']
  const out = (ticket.lines ?? []).map((l) => {
    const args = [`item=${q(l.item)}`, `qty=${l.qty}`]
    if (l.size) args.push(`size=${q(l.size)}`)
    if ((l.mods ?? []).length) args.push(`mods=[${l.mods.map(q).join(', ')}]`)
    return `add_item(${args.join(', ')})`
  })
  if (ticket.off_menu) out.push(ticket.clarify ? `ask_about_off_menu(what=${q(ticket.clarify)})` : 'ask_about_off_menu()')
  if (ticket.readback) out.push(`read_back(${q(ticket.readback)})`)
  for (const f of ticket.fouls ?? []) out.push(`# foul: ${f.why}`)
  if (!out.length) out.push('# nothing rung up')
  return out
}

/** A gold ticket in a line: "2 × cheeseburger (1 no pickles) · large fries · medium cola · asks: onion rings". */
export function goldText(gold, run) {
  if (!gold) return ''
  const byItem = new Map()
  for (const l of gold.lines ?? []) {
    if (!byItem.has(l.item)) byItem.set(l.item, [])
    byItem.get(l.item).push(l)
  }
  const parts = [...byItem].map(([item, lines]) => {
    const total = lines.reduce((a, l) => a + l.qty, 0)
    const size = lines[0].size ? `${lines[0].size} ` : ''
    const mods = lines
      .filter((l) => l.mods.length)
      .map((l) => `${lines.length > 1 ? `${l.qty} ` : ''}${l.mods.map((m) => modName(run, m)).join(', ')}`)
    return `${total} × ${size}${itemName(item)}${mods.length ? ` (${mods.join('; ')})` : ''}`
  })
  if (gold.off_menu) parts.push(`asks: ${gold.off_menu}`)
  return parts.join(' · ')
}

/** Whether each of a ticket's lines is on the gold ticket (alike lines merged, as the server scores). */
export function lineMarks(lines, gold) {
  const key = (l) => `${l.item}|${l.size ?? ''}|${[...(l.mods ?? [])].sort().join(',')}`
  const sum = (ls) => ls.reduce((m, l) => m.set(key(l), (m.get(key(l)) ?? 0) + l.qty), new Map())
  const want = sum(gold?.lines ?? [])
  const got = sum(lines ?? [])
  return (lines ?? []).map((l) => want.get(key(l)) === got.get(key(l)))
}

/* ── A window's queue ──────────────────────────────────────────────────────── */

/**
 * Every arrived car as one window saw it: served (exact or not), drove off,
 * at the window, or waiting in line. cars: run.cars; lane: its lane.
 * @returns {[{i, status: 'exact'|'served'|'dropped'|'busy'|'waiting', ticket}]}
 */
export function windowCars(cars, lane) {
  const byCar = new Map((lane?.tickets ?? []).map((t) => [t.car, t]))
  return (cars ?? []).map((c) => {
    const t = byCar.get(c.i)
    if (t) return { i: c.i, status: t.status === 'dropped' ? 'dropped' : t.exact ? 'exact' : 'served', ticket: t }
    return { i: c.i, status: lane?.busy === c.i ? 'busy' : 'waiting', ticket: null }
  })
}

/**
 * Where a window's cars are drawn in a strip *width* wide: the one being
 * served at the window, the rest of the line queued back from it, and how
 * many do not fit. {window: {x, w}, atWindow: {i, x} | null, waiting: [{i, x}], more}
 */
export function queueLayout(statuses, { width = 380, car = 36, gap = 6 } = {}) {
  const win = { x: width - 30, w: 24 }
  const busy = statuses.find((s) => s.status === 'busy') ?? null
  const atX = win.x - car - 6
  const line = statuses.filter((s) => s.status === 'waiting')
  const room = Math.max(0, Math.floor((atX - gap) / (car + gap)))
  const shown = line.slice(0, room)
  return {
    window: win,
    atWindow: busy ? { i: busy.i, x: atX } : null,
    waiting: shown.map((s, j) => ({ i: s.i, x: atX - (j + 1) * (car + gap) })),
    more: line.length - shown.length,
    car,
  }
}

/** A window's counts: served, waiting (including the one at the window), drove off, exact. */
export function windowCounts(statuses) {
  const n = (f) => statuses.filter(f).length
  return {
    served: n((s) => s.status === 'exact' || s.status === 'served'),
    exact: n((s) => s.status === 'exact'),
    waiting: n((s) => s.status === 'waiting' || s.status === 'busy'),
    dropped: n((s) => s.status === 'dropped'),
  }
}

/** The car in view by default: the newest any window has a ticket for, else the newest to arrive. */
export function latestCar(run) {
  let best = -1
  for (const ln of run?.lanes ?? []) for (const t of ln.tickets ?? []) best = Math.max(best, t.car)
  if (best >= 0) return best
  const cars = run?.cars ?? []
  return cars.length ? cars[cars.length - 1].i : null
}

/* ── What the page lights up ───────────────────────────────────────────────── */

const TOKEN = /("(?:[^"\\]|\\.)*")|([A-Za-z_]\w*)(?=\()|([A-Za-z_]\w*)(?==)|(-?\d+(?:\.\d+)?)|([()[\],=])|(\s+)|([^\s"()[\],=]+)/g

/** A call line as tokens to colour: [{t, k}], k one of fn, key, str, num,
 *  punct, space, word, or comment for a whole `# …` line. Joined, the tokens
 *  are the line. */
export function callTokens(line) {
  const s = String(line ?? '')
  if (/^\s*#/.test(s)) return [{ t: s, k: 'comment' }]
  const out = []
  for (const m of s.matchAll(TOKEN)) {
    const k = m[1] ? 'str' : m[2] ? 'fn' : m[3] ? 'key' : m[4] ? 'num' : m[5] ? 'punct' : m[6] ? 'space' : 'word'
    out.push({ t: m[0], k })
  }
  return out
}

/** Who is ahead by the game's own rule: a window's score is its points (they
 *  can go below nought), so the windows with the most, all of them on a tie. */
export function leadersOf(run) {
  const lanes = run?.lanes ?? []
  if (!lanes.length) return []
  const best = Math.max(...lanes.map((ln) => ln.score ?? 0))
  return lanes.filter((ln) => (ln.score ?? 0) === best).map((ln) => ln.index)
}

/** How many exact orders in a row a window has just rung up (its latest
 *  tickets; cars still in line don't break it). statuses: windowCars(…). */
export function streakOf(statuses) {
  const done = (statuses ?? []).filter((s) => s.ticket)
  let n = 0
  for (let j = done.length - 1; j >= 0 && done[j].status === 'exact'; j--) n++
  return n
}

/** A line's length over time as a sparkline path in a w×h box, the longest
 *  line at the top ({d, max}; d is '' with fewer than two samples). */
export function sparkPath(values, { width = 110, height = 24, pad = 2 } = {}) {
  const v = (values ?? []).filter(Number.isFinite)
  const max = Math.max(1, ...v)
  if (v.length < 2) return { d: '', max }
  const step = (width - 2 * pad) / (v.length - 1)
  const y = (n) => Math.round((height - pad - (n / max) * (height - 2 * pad)) * 10) / 10
  const d = v.map((n, j) => `${j ? 'L' : 'M'}${Math.round((pad + j * step) * 10) / 10} ${y(n)}`).join(' ')
  return { d, max }
}
