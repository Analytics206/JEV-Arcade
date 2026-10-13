// The Contact page's pure half, the page-view beacon, and the admin pages'
// formatting (src/wikirace/static/contact.logic.js, beacon.js, admin/format.js).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONTACT_EMAIL, mailtoHref, problems, saveCopy } from '../../src/wikirace/static/contact.logic.js'
import { beaconPayload } from '../../src/wikirace/static/beacon.js'
import { parseRoute, routeSearch } from '../../src/wikirace/static/games/route.js'
import { bucketLabel, fmtBytes, fmtMs, query, replyHref, statusTone } from '../../src/wikirace/static/admin/format.js'

describe('the Contact page', () => {
  it('has its own address', () => {
    assert.deepEqual(parseRoute('?tab=contact'), { view: 'contact' })
    assert.equal(routeSearch({ view: 'contact' }), '?tab=contact')
  })

  it('says what is missing before it opens anything', () => {
    assert.deepEqual(Object.keys(problems({ name: '', email: '', message: '' })).sort(), ['email', 'message'])
    assert.ok(problems({ email: 'nope', message: 'hi' }).email)
    assert.deepEqual(problems({ name: 'Ada', email: 'ada@example.com', message: 'hi' }), {})
    assert.ok(problems({ email: 'ada@example.com', message: 'x'.repeat(5001) }).message)
  })

  it('writes the whole message into a mailto: link to us', () => {
    const href = mailtoHref({ name: 'Ada & co', email: 'ada@example.com', message: 'Two + two\nis four?' })
    assert.ok(href.startsWith(`mailto:${CONTACT_EMAIL}?subject=`))
    const q = new URLSearchParams(href.split('?')[1].replace(/\+/g, '%2B'))
    assert.equal(q.get('subject'), 'JEV-Arcade: a message from Ada & co')
    assert.equal(q.get('body'), 'Two + two\nis four?\n\n— Ada & co <ada@example.com>')
    // A plus is a plus, not a space, and a newline survives.
    assert.ok(href.includes('%2B') && href.includes('%0A') && !href.includes('+'))
  })

  it('posts a copy, then carries on whatever the server did', async () => {
    const sent = []
    await saveCopy({ name: ' Ada ', email: 'ada@example.com ', message: 'hi' }, {
      fetchImpl: async (url, init) => {
        sent.push([url, init])
        return { ok: true }
      },
    })
    assert.equal(sent[0][0], '/api/contact')
    assert.equal(sent[0][1].method, 'POST')
    assert.equal(sent[0][1].keepalive, true)
    assert.deepEqual(JSON.parse(sent[0][1].body), { name: 'Ada', email: 'ada@example.com', message: 'hi', cabinet_code: '' })
    // A failure, a throw and a server that never answers all resolve.
    await saveCopy({}, { fetchImpl: () => Promise.reject(new Error('offline')) })
    await saveCopy({}, { fetchImpl: () => { throw new Error('no fetch') } })
    const t0 = Date.now()
    await saveCopy({}, { fetchImpl: () => new Promise(() => {}), timeoutMs: 50 })
    assert.ok(Date.now() - t0 < 1000)
  })
})

describe('the beacon', () => {
  it('reads what only the browser knows, and nothing that names the visitor', () => {
    const w = {
      screen: { width: 1920, height: 1080 }, innerWidth: 1280.4, innerHeight: 720, devicePixelRatio: 1.25,
      location: { search: '?tab=race' },
      performance: { getEntriesByType: () => [{ loadEventEnd: 812.6 }] },
    }
    const b = beaconPayload(w)
    assert.deepEqual({ ...b, tz: '' }, { sw: 1920, sh: 1080, vw: 1280, vh: 720, dpr: 1.25, tz: '', load_ms: 813, view: '?tab=race' })
    assert.equal(typeof b.tz, 'string')
    assert.deepEqual(Object.keys(b).sort(), ['dpr', 'load_ms', 'sh', 'sw', 'tz', 'vh', 'view', 'vw'])
    assert.equal(beaconPayload({}).load_ms, null)
  })
})

describe('the admin pages', () => {
  it('encode a reply address, whatever was typed', () => {
    const href = replyHref('x@example.com?bcc=all@example.com', 'Eve')
    assert.ok(href.startsWith('mailto:x%40example.com%3Fbcc%3Dall%40example.com?subject='))
    assert.ok(replyHref('javascript:alert(1)').startsWith('mailto:javascript%3Aalert(1)?'))
  })

  it('build a query from what is set', () => {
    assert.equal(query({ period: '7d', ip: '', page: 1, q: null }), '?period=7d&page=1')
    assert.equal(query({}), '')
  })

  it('format numbers, sizes, times and statuses', () => {
    assert.equal(fmtBytes(999), '999 B')
    assert.equal(fmtBytes(1500), '1.5 KB')
    assert.equal(fmtMs(0.4), '<1 ms')
    assert.equal(fmtMs(1500), '1.50 s')
    assert.equal(bucketLabel('2026-10-13', false), 'Oct 13')
    assert.equal(bucketLabel('2026-10-13T09', true), '9 AM UTC')
    assert.deepEqual([200, 301, 404, 503].map(statusTone), ['ok', '', 'warn', 'err'])
  })
})
