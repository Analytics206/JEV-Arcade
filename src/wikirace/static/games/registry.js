/* The Arcade's cabinets as the floor shows them, in the floor's order: WikiRace
 * first (the flagship), the main floor, then the quick hits. The server's
 * listing (GET /api/games) says which games are built and who may play; this
 * says how each cabinet looks: its neon (`accent`, the page's --acc), its pitch,
 * the use case on its plate, and its attract-mode screen (attract.js). A game's
 * page is `./<id>.js`, loaded when opened.
 *
 * section: feature | main | quick
 */
import { SCENES } from './attract.js'

export const CARDS = [
  { id: 'wikirace', section: 'feature', accent: '#3ef4ff', title: 'WikiRace', tagline: 'Language models race across Wikipedia, link by link', pitch: 'Up to four models race from one article to another using only the links on the page. Text models can name links that aren’t there; Jev scores the real ones, so it can’t foul.', chip: 'the original · Choice over 255 links' },
  { id: 'chess', section: 'main', accent: '#b18cff', pitch: 'Chess puzzles, mate in one. Jev picks from the real legal moves; a text model can write an impossible one.', chip: 'typed actions' },
  { id: 'switchboard', section: 'main', accent: '#3ef5a0', pitch: 'Calls pour in on a clock; each is patched to one of 150 lines, or to a human operator when unsure.', chip: 'intent routing' },
  { id: 'customs', section: 'main', accent: '#ffb545', pitch: 'Messages ride an X-ray belt; hazard gauges send each to pass, inspect or block.', chip: 'LLM guardrails' },
  { id: 'wikiguessr', section: 'main', accent: '#2ee6c5', pitch: 'Where on Earth is this redacted article? Claim deeper for more points; a wrong claim costs.', chip: 'hierarchical classification' },
  { id: 'railyard', section: 'main', accent: '#ff8a3d', pitch: 'Every prompt is a train. Jev throws the switch that sends it to the model that should answer.', chip: 'model routing' },
  { id: 'twotruths', section: 'main', accent: '#ff4fd8', pitch: 'A text model writes three claims about an article; Jev checks each against the source. Find the lie first.', chip: 'verification' },
  { id: 'judges', section: 'main', accent: '#ffd84d', pitch: 'Every contestant scored once on five rubrics; drag the weights and the podium reorders, no new request.', chip: 'composite scoring' },
  { id: 'ghostmaze', section: 'main', accent: '#5b7cff', pitch: 'Two mazes, one clock, ten ticks a second. The ghosts don’t wait for a model that’s still thinking.', chip: 'real-time decisions' },
  { id: 'needle', section: 'quick', accent: '#b6ff3e', pitch: 'Find the line of the document that answers the question, or say it isn’t there.', chip: 'line-by-line search' },
  { id: 'slots', section: 'quick', accent: '#ff4d7a', pitch: 'One borderline post, fifteen pulls of the lever. Does the verdict hold still?', chip: 'self-consistency' },
  { id: 'drivethru', section: 'quick', accent: '#ff6a3d', pitch: 'Spoken orders in, typed function calls out, with a read-back when unsure.', chip: 'function calling' },
  { id: 'memory', section: 'quick', accent: '#f0abfc', pitch: 'Two shops’ listings: the same product, a close variant, or not the same at all?', chip: 'entity alignment' },
  { id: 'bigsort', section: 'quick', accent: '#4fa3ff', pitch: 'Hundreds of random Wikipedia articles sorted into topics while you watch.', chip: 'map-reduce at scale' },
  { id: 'tasting', section: 'quick', accent: '#ff7eb6', pitch: 'Guess the critic’s score, closest without going over: Jev measures the note, code does the maths.', chip: 'features for ML' },
]

export const cardOf = (id) => CARDS.find((c) => c.id === id)

/** A cabinet's neon, for its page (--acc). */
export const accentOf = (id) => cardOf(id)?.accent ?? '#3ef4ff'

/** Each cabinet's attract-mode screen: `SCENES[id](uniqueSuffix)`. */
export { SCENES }

/** A game's page module. */
export const loadGame = (id) => import(`./${id}.js`)
