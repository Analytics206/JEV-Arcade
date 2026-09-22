// node tests/js/mock_server.mjs   → http://127.0.0.1:8001/   (MOCK_PORT, MOCK_SPEED, MOCK_OLLAMA_DOWN=1)
/*
 * A stand-in for the WikiRace server, for work on the page without API keys or a
 * network: it serves src/wikirace/static/ as the real server does and fakes /api/*
 * to docs/design.md's shapes. No dependencies — Node's own http module.
 *
 * - /api/models: all five providers — Anthropic, OpenRouter, Ollama and TypeSafe
 *   ready, OpenAI not set up — with a warning to show. Prices are placeholders.
 * - /api/resolve and /api/random: a few canned subjects. "mercury" has
 *   alternatives; "zzz" (or "404") is not an article.
 * - History: the Jev fixture race (whole, so its replay has every step) and three
 *   summaries from the list fixture (their replays have no steps to show).
 * - POST /api/races plays a race live: each racer replays one of the fixture's
 *   racers (Jev for TypeSafe, the two text racers in turn for the rest) on the new
 *   course, MOCK_SPEED times slower (default 3), with a rate-limit wait on the
 *   second racer. Stop, the hop limit, the foul limit and two-at-once all apply.
 *
 * The mock keeps each race with the page's own reducer (applyEvent), so what it
 * stores and what a page attached to it shows cannot disagree.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEvent, isLive, normalizeTitle, splitKey } from '../../src/wikirace/static/state.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.MOCK_PORT ?? 8001)
const SPEED = Number(process.env.MOCK_SPEED ?? 3)
const LATENCY = 150 // ms on lookups, so "looking it up…" is seen
const MAX_RACES = 2
const ROOT = fileURLToPath(new URL('../../src/wikirace/static/', import.meta.url))
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

/* ── Who can race ──────────────────────────────────────────────────────────── */

const LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
const OLLAMA_DOWN = process.env.MOCK_OLLAMA_DOWN === '1'

const provider = (id, label, over = {}) => ({
  id, label, kind: 'text', configured: true, available: true, reason: null, thinking: null,
  custom_models: true, url: null, key_source: '.env', ...over,
})
const model = (p, id, over = {}) => ({
  key: `${p}:${id}`, provider: p, model_id: id, label: id, kind: 'text', thinking: null,
  available: true, reason: null, price: null, thinks: null, context: null, note: '', ...over,
})
const OPENAI_OFF = { available: false, reason: 'set OPENAI_API_KEY in .env' }
const OLLAMA_OFF = { available: false, reason: 'no answer at http://localhost:11434 — is Ollama running?' }

const MODELS = {
  providers: [
    provider('anthropic', 'Anthropic', { thinking: 'low' }),
    provider('openai', 'OpenAI', { configured: false, key_source: null, ...OPENAI_OFF }),
    provider('openrouter', 'OpenRouter', { key_source: 'environment' }),
    provider('ollama', 'Ollama', { url: 'http://localhost:11434', key_source: null, ...(OLLAMA_DOWN ? OLLAMA_OFF : {}) }),
    provider('typesafe', 'TypeSafe', { kind: 'judgment', custom_models: false }),
  ],
  models: [
    model('anthropic', 'claude-haiku-4-5', { thinking: 'low', price: { input: 1, output: 5 } }),
    model('anthropic', 'claude-sonnet-5', { thinking: 'low', price: { input: 3, output: 15 } }),
    model('anthropic', 'claude-opus-5', { thinking: 'high', price: { input: 5, output: 25 } }),
    model('openai', 'gpt-4.1-mini', { ...OPENAI_OFF, price: { input: 0.4, output: 1.6 } }),
    model('openai', 'o4-mini', { ...OPENAI_OFF, price: { input: 1.1, output: 4.4 } }),
    model('openrouter', 'deepseek/deepseek-v4-flash'),
    model('openrouter', 'minimax/minimax-m3'),
    ...(OLLAMA_DOWN
      ? []
      : [
          model('ollama', 'qwen3.5:9b', { price: { input: 0, output: 0 }, thinks: true, context: 262_144 }),
          model('ollama', 'llama3.2:3b', { price: { input: 0, output: 0 }, thinks: false, context: 131_072 }),
        ]),
    model('typesafe', 'jev-1.13.0', { kind: 'judgment', price: { input: 0.042, output: 0 } }),
  ],
  thinking_levels: LEVELS,
  thinking: null,
  warnings: ['OPENAI_THINKING: “hgih” is not a thinking level (none, low, medium, high, xhigh, max), so it was ignored'],
}

/* ── Subjects ──────────────────────────────────────────────────────────────── */

const s = (title, description) => ({ title, description })
const POOLS = {
  classic: [
    s('Abraham Lincoln', 'President of the United States from 1861 to 1865'),
    s('Amazon rainforest', 'Tropical rainforest in South America'),
    s('Albert Einstein', 'German-born physicist (1879–1955)'),
    s('Great Wall of China', 'Series of fortifications in China'),
    s('Jazz', 'Musical genre'),
    s('Photosynthesis', 'Biological process to convert light into chemical energy'),
    s('Mount Everest', "Earth's highest mountain above sea level"),
    s('Ancient Rome', 'Civilisation from the 8th century BC to the 5th century AD'),
  ],
  trending: [
    s('UFC 331', 'Mixed martial arts event in 2026'),
    s('Zach Cregger', 'American actor, comedian, and filmmaker (born 1981)'),
    s('Hayley Williams', 'American singer (born 1988)'),
    s("Anna's Archive", 'Shadow library search engine'),
    s('Lioness (American TV series)', 'American spy thriller television series'),
  ],
  wild: [
    s('Neatsville, Kentucky', 'Unincorporated community in Kentucky, US'),
    s('Classical fencing', 'Style of fencing'),
    s('XXXXX (album)', '2026 studio album by Arca'),
    s('Purple Noon', '1960 film by René Clément'),
  ],
}
const KNOWN = new Map(Object.values(POOLS).flat().map((x) => [x.title, x.description]))

function resolve(q) {
  if (/^(z+|404)$/i.test(q)) return null
  if (q.toLowerCase() === 'mercury') {
    const candidates = [
      s('Mercury (planet)', 'Smallest and closest planet to the Sun'),
      s('Mercury (element)', 'Chemical element with atomic number 80'),
      s('Mercury (mythology)', 'Roman god of commerce'),
      s('Freddie Mercury', 'British singer (1946–1991)'),
    ]
    return { input: q, ...candidates[0], note: '“mercury” could mean several articles; this is the most-read one', candidates }
  }
  const title = normalizeTitle(q)
  const description = KNOWN.get(title) ?? 'An article in the mock'
  const note = title !== q ? `read “${q}” as “${title}”` : null
  return { input: q, title, description, note, candidates: [s(title, description), s(`${title} (disambiguation)`, 'Topics referred to by the same term')] }
}

function draw(pool, count, exclude) {
  const left = (POOLS[pool] ?? POOLS.classic).filter((x) => !exclude.includes(x.title))
  const out = []
  while (out.length < count && left.length) out.push(left.splice(Math.floor(Math.random() * left.length), 1)[0])
  return out
}

/* ── History ───────────────────────────────────────────────────────────────── */

/** @type {Map<string, object>} every race, whole, by id */
const races = new Map()
/** @type {Map<string, Live>} the races still being played */
const lives = new Map()

const JEV_RACE = fixture('race-jev.json')
for (const r of [JEV_RACE, ...fixture('race-list.json').races]) races.set(r.id, r)

const summary = ({ lanes, ...r }) => ({ ...r, lanes: lanes.map(({ steps, ...ln }) => ln) })
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, '+00:00')

/* ── A race, played ────────────────────────────────────────────────────────── */

class Live {
  constructor(race) {
    this.race = race
    this.subs = new Set()
    this.wakers = new Set()
    this.over = false
    this.left = race.lanes.length
    this.finishers = 0
  }

  emit(ev) {
    this.race = applyEvent(this.race, ev)
    races.set(this.race.id, this.race)
    for (const send of this.subs) send(ev)
  }

  patch(i, patch) {
    this.emit({ type: 'lane', lane: i, patch })
  }

  /** Sleep until *ms* into the race — or until it is stopped. */
  until(ms) {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(t)
        this.wakers.delete(wake)
        resolve()
      }
      const t = setTimeout(wake, Math.max(0, this.race.started_ms + ms - Date.now()))
      this.wakers.add(wake)
      if (this.over) wake()
    })
  }

  laneDone() {
    if (--this.left <= 0) this.finish('finished')
  }

  finish(status) {
    if (this.over) return
    this.over = true
    const elapsed = Date.now() - this.race.started_ms
    for (const ln of this.race.lanes) {
      if (isLive(ln)) this.patch(ln.index, { status: 'stopped', note: 'stopped', elapsed_ms: elapsed, turn_started_ms: null })
    }
    // Fewest hops, then least thinking time, then who crossed first.
    const ranking = this.race.lanes
      .filter((ln) => ln.status === 'finished')
      .sort((a, b) => a.hops - b.hops || a.think_ms - b.think_ms || a.finish_order - b.finish_order)
      .map((ln) => ln.index)
    ranking.forEach((i, k) => this.patch(i, { rank: k + 1 }))
    this.emit({ type: 'race', patch: { status, ranking, winner: ranking[0] ?? null, finished_at: stamp() } })
    this.emit({ type: 'end' })
    lives.delete(this.race.id)
    for (const wake of [...this.wakers]) wake()
  }
}

const THINKING_SENT = {
  anthropic: (l) => `output_config.effort=${l}`,
  openai: (l) => `reasoning_effort=${l}`,
  openrouter: (l) => `reasoning.effort=${l}`,
  ollama: (l) => `think=${l}`,
}

/** One fixture racer's steps, moved onto this course, slowed down, and dressed
 *  for this lane's provider. */
function script(from, lane, start, target) {
  const swap = (text) =>
    text
      .replaceAll(JSON.stringify(JEV_RACE.start.title).slice(1, -1), JSON.stringify(start).slice(1, -1))
      .replaceAll(JSON.stringify(JEV_RACE.target.title).slice(1, -1), JSON.stringify(target).slice(1, -1))
  const steps = JSON.parse(swap(JSON.stringify(from.steps)))
  return steps.map((st) => {
    const out = { ...st, at_ms: st.at_ms * SPEED, latency_ms: st.latency_ms * SPEED }
    if (lane.provider === 'ollama') out.cost = 0
    if (lane.kind === 'text') {
      const detail = { ...(st.detail ?? {}) }
      if (lane.thinking && THINKING_SENT[lane.provider]) detail.thinking_sent = THINKING_SENT[lane.provider](lane.thinking)
      if (lane.provider === 'ollama' && st.links > 400) detail.links_shown = 400
      out.detail = Object.keys(detail).length ? detail : null
    }
    return out
  })
}

async function runLane(live, i, steps, { rateLimit = false } = {}) {
  const lane = () => live.race.lanes[i]
  const rules = live.race.rules
  await live.until(300)
  if (live.over) return
  live.patch(i, { status: 'thinking', turn_started_ms: Date.now() })
  for (const [k, st] of steps.entries()) {
    await live.until(st.at_ms)
    if (live.over || !isLive(lane())) return
    live.emit({ type: 'step', lane: i, step: st })
    const ln = lane()
    const moved = st.verdict === 'ok' && !!st.to
    const patch = {
      tokens_in: ln.tokens_in + st.tokens_in,
      tokens_out: ln.tokens_out + st.tokens_out,
      cost: ln.cost == null ? null : ln.cost + (st.cost ?? 0),
      think_ms: ln.think_ms + st.latency_ms,
      turn_started_ms: null,
    }
    if (moved) Object.assign(patch, { status: 'moving', hops: ln.hops + 1, page: st.to, revisits: ln.revisits + (st.revisit ? 1 : 0) })
    if (st.verdict in ln.fouls) Object.assign(patch, { strikes: ln.strikes + 1, fouls: { ...ln.fouls, [st.verdict]: ln.fouls[st.verdict] + 1 } })
    live.patch(i, patch)
    const now = lane()
    if (moved && st.to === live.race.target.title) {
      live.patch(i, { status: 'finished', elapsed_ms: st.at_ms, finish_order: ++live.finishers })
      break
    }
    if (now.strikes >= rules.strikes) {
      live.patch(i, { status: 'dq', note: `disqualified — ${now.strikes} foul${now.strikes === 1 ? '' : 's'}`, elapsed_ms: st.at_ms })
      break
    }
    if (moved && now.hops >= rules.max_hops) {
      live.patch(i, { status: 'dnf', note: `out of hops — all ${rules.max_hops} used`, elapsed_ms: st.at_ms })
      break
    }
    if (moved) await live.until(st.at_ms + 350) // loading the next article
    if (live.over) return
    const next = steps[k + 1]
    if (rateLimit && k === 0 && next && next.at_ms - st.at_ms > 3000) {
      // A 429, waited out in plain sight — and not counted as thinking.
      live.patch(i, { status: 'rate_limited', note: `${now.provider} rate limit — trying again in 2s (try 1 of 5)` })
      await live.until(next.at_ms - 1200)
      if (live.over) return
      live.patch(i, { note: null })
    }
    live.patch(i, { status: 'thinking', turn_started_ms: Date.now() })
  }
  if (!live.over && isLive(lane())) {
    live.patch(i, { status: 'dnf', note: 'the mock ran out of moves', elapsed_ms: Date.now() - live.race.started_ms, turn_started_ms: null })
  }
  live.laneDone()
}

/** POST /api/races: the checks the real server makes, then a race to play. */
function startRace(body) {
  const fail = (status, detail) => ({ status, body: { detail } })
  const start = String(body?.start ?? '').trim()
  const target = String(body?.target ?? '').trim()
  if (!start || !target) return fail(422, [{ loc: ['body', start ? 'target' : 'start'], msg: 'Field required' }])
  if (normalizeTitle(start) === normalizeTitle(target)) return fail(400, 'start and target are the same article')
  const reqLanes = Array.isArray(body.lanes) ? body.lanes : []
  if (reqLanes.length < 1 || reqLanes.length > 4) return fail(400, 'a race takes 1 to 4 racers')
  const rules = body.rules ?? {}
  const RANGE = { max_hops: [1, 40], strikes: [1, 10], time_limit_s: [30, 3600], max_links: [0, 10_000] }
  for (const [k, [lo, hi]] of Object.entries(RANGE)) {
    const v = rules[k]
    if (!Number.isInteger(v) || v < lo || v > hi) return fail(422, [{ loc: ['body', 'rules', k], msg: `Input should be a whole number from ${lo} to ${hi}` }])
  }
  if (lives.size >= MAX_RACES) return fail(409, `${MAX_RACES} races are already running; stop one or wait for it to finish`)

  const lanes = []
  for (const [i, req] of reqLanes.entries()) {
    const key = String(req?.key ?? '')
    const [pid, modelId] = splitKey(key)
    const listed = MODELS.models.find((m) => m.key === key)
    const p = MODELS.providers.find((x) => x.id === pid)
    if (!listed && !(p?.custom_models && modelId)) return fail(400, `racer ${i + 1}: no model “${key}”`)
    const available = listed ? listed.available : p.available
    if (!available) return fail(400, `racer ${i + 1}: ${key} cannot race: ${(listed ?? p).reason}`)
    if (req.thinking != null && !LEVELS.includes(req.thinking)) {
      return fail(422, [{ loc: ['body', 'lanes', i, 'thinking'], msg: `Input should be one of ${LEVELS.join(', ')}` }])
    }
    const kind = listed?.kind ?? p.kind
    lanes.push({
      index: i, key, label: listed?.label ?? modelId, provider: pid, model_id: modelId, kind,
      thinking: kind === 'judgment' ? null : (req.thinking ?? listed?.thinking ?? p.thinking ?? MODELS.thinking),
      thinking_request: req.thinking ?? null,
      status: 'waiting', note: null, page: start, hops: 0, strikes: 0, revisits: 0,
      fouls: { off_page: 0, teleport: 0, no_pick: 0 }, tokens_in: 0, tokens_out: 0,
      cost: 0, cost_estimated: ['anthropic', 'openai', 'typesafe'].includes(pid), think_ms: 0,
      elapsed_ms: null, turn_started_ms: null, finish_order: null, rank: null, steps: [],
    })
  }

  const race = {
    id: randomBytes(6).toString('hex'), status: 'running', created_at: stamp(), started_ms: Date.now(),
    finished_at: null,
    start: { title: start, description: KNOWN.get(start) ?? 'An article in the mock', input: start, links: JEV_RACE.start.links },
    target: { title: target, description: KNOWN.get(target) ?? 'An article in the mock', input: target },
    rules: { max_hops: rules.max_hops, strikes: rules.strikes, time_limit_s: rules.time_limit_s, max_links: rules.max_links },
    ranking: [], winner: null, lanes,
  }
  races.set(race.id, race)
  const live = new Live(race)
  lives.set(race.id, live)

  // Jev replays Jev; the text racers take the fixture's two text racers in turn.
  const jev = JEV_RACE.lanes.find((ln) => ln.kind === 'judgment')
  const texts = JEV_RACE.lanes.filter((ln) => ln.kind === 'text')
  let t = 0
  for (const ln of lanes) {
    const from = ln.kind === 'judgment' ? jev : texts[t++ % texts.length]
    void runLane(live, ln.index, script(from, ln, start, target), { rateLimit: ln.index === 1 && ln.kind === 'text' })
  }
  return { status: 201, body: race }
}

/* ── HTTP ──────────────────────────────────────────────────────────────────── */

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return JSON.parse(raw || 'null')
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stream(req, res, id) {
  const race = races.get(id)
  if (!race) return json(res, 404, { detail: `no race ${id}` })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
  const send = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  const live = lives.get(id)
  send({ type: 'snapshot', race: live?.race ?? race })
  if (!live) {
    send({ type: 'end' })
    return res.end()
  }
  const sub = (ev) => {
    send(ev)
    if (ev.type === 'end') res.end()
  }
  live.subs.add(sub)
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
  req.on('close', () => {
    live.subs.delete(sub)
    clearInterval(ping)
  })
}

async function api(req, res, url) {
  const p = url.pathname
  const m = p.match(/^\/api\/races\/([^/]+)(\/events|\/stop)?$/)
  if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, version: '0.1.0-mock' })
  if (req.method === 'GET' && p === '/api/models') return json(res, 200, MODELS)
  if (req.method === 'GET' && p === '/api/resolve') {
    await sleep(LATENCY)
    const q = (url.searchParams.get('q') ?? '').trim()
    if (!q) return json(res, 422, { detail: [{ loc: ['query', 'q'], msg: 'Field required' }] })
    const r = resolve(q)
    return r ? json(res, 200, r) : json(res, 404, { detail: `no article matches “${q}”` })
  }
  if (req.method === 'GET' && p === '/api/random') {
    await sleep(LATENCY)
    const pool = url.searchParams.get('pool') ?? 'classic'
    const count = Math.min(2, Math.max(1, Number(url.searchParams.get('count') ?? 1)))
    return json(res, 200, { pool, subjects: draw(pool, count, url.searchParams.getAll('exclude')) })
  }
  if (req.method === 'GET' && p === '/api/races') {
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const list = [...races.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit)
    return json(res, 200, { races: list.map(summary), running: [...lives.keys()] })
  }
  if (req.method === 'POST' && p === '/api/races') {
    const body = await readJson(req)
    if (body === undefined) return json(res, 400, { detail: 'the body is not JSON' })
    const r = startRace(body)
    return json(res, r.status, r.body)
  }
  if (m) {
    const id = decodeURIComponent(m[1])
    if (req.method === 'GET' && m[2] === '/events') return stream(req, res, id)
    if (req.method === 'POST' && m[2] === '/stop') {
      const live = lives.get(id)
      if (!live) return json(res, races.has(id) ? 409 : 404, { detail: races.has(id) ? `race ${id} is not running` : `no race ${id}` })
      setTimeout(() => live.finish('stopped'), 400) // stopping takes a moment, as a real turn in flight would
      return json(res, 202, { id, stopping: true })
    }
    if (req.method === 'GET' && !m[2]) return races.has(id) ? json(res, 200, races.get(id)) : json(res, 404, { detail: `no race ${id}` })
    if (req.method === 'DELETE' && !m[2]) {
      if (!races.has(id)) return json(res, 404, { detail: `no race ${id}` })
      if (lives.has(id)) return json(res, 409, { detail: `race ${id} is still running; stop it first` })
      races.delete(id)
      return json(res, 200, { deleted: id })
    }
  }
  // The Arcade's games are played on the real server over stand-in players
  // (tests/games/demo_server.py); here they are listed, as not built, so the
  // Arcade tab draws its hub.
  if (req.method === 'GET' && p === '/api/games') return json(res, 200, { games: ARCADE })
  if (req.method === 'GET' && p === '/api/games/runs') return json(res, 200, { runs: [], running: [] })
  return json(res, 404, { detail: `no such endpoint: ${req.method} ${p}` })
}

const ARCADE = [
  ['chess', 'Legal Moves Only'], ['switchboard', 'Switchboard'], ['customs', 'Customs'], ['wikiguessr', 'WikiGuessr'],
  ['railyard', 'Rail Yard'], ['twotruths', 'Two Truths and a Lie'], ['judges', "Judges' Panel"], ['ghostmaze', 'Ghost Maze'],
  ['needle', 'Needle Hunt'], ['slots', 'Slot Machine'], ['drivethru', 'Drive-Thru'], ['memory', 'Memory Match'],
  ['bigsort', 'The Big Sort'], ['tasting', 'Blind Tasting'],
].map(([id, title]) => ({
  id, title, tagline: 'Played on the demo server: uv run python tests/games/demo_server.py', use_case: '',
  lanes: { min: 1, max: 4 }, kinds: ['judgment', 'text'], needs_jev: false, ready: false, params: {},
}))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
}

async function serveStatic(res, pathname) {
  let file = path.resolve(ROOT, decodeURIComponent(pathname).replace(/^\/+/, ''))
  if (file !== ROOT.replace(/[\\/]$/, '') && !file.startsWith(ROOT)) return json(res, 403, { detail: 'outside the page' })
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    json(res, 404, { detail: `no file ${pathname}` })
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`)
    const handle = url.pathname.startsWith('/api/') ? api(req, res, url) : serveStatic(res, url.pathname)
    handle.catch((e) => {
      if (!res.headersSent) json(res, 500, { detail: String(e?.message ?? e) })
      else res.end()
    })
  })
  .listen(PORT, HOST, () => {
    console.log(`WikiRace mock on http://${HOST}:${PORT}/ — ${races.size} races in the history, played at 1/${SPEED} speed`)
  })
