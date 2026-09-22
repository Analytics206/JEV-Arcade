// Blind Tasting: the measurement geometry and the winning rule, on the page.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  axis,
  band,
  barWidth,
  fateOf,
  fmtWeight,
  nearestLevel,
  parseGuess,
  scatter,
  winners,
} from '../../src/wikirace/static/games/tasting.logic.js'

describe('a measurement on its track', () => {
  it('puts the tick at the mean and the band a spread either side', () => {
    assert.deepEqual(band(2, 0.5, 200), { x: 75, w: 50, tick: 100 })
    assert.deepEqual(band(0, 0, 200), { x: 0, w: 0, tick: 0 })
  })
  it('clips the band to the track', () => {
    assert.deepEqual(band(3.8, 0.6, 200), { x: 160, w: 40, tick: 190 })
    assert.deepEqual(band(0.2, 0.5, 100), { x: 0, w: 17.5, tick: 5 })
    assert.deepEqual(band(NaN, NaN, 200), { x: 0, w: 0, tick: 0 })
  })
  it('draws a yes/no as a bar of its probability', () => {
    assert.equal(barWidth(0.91, 200), 182)
    assert.equal(barWidth(1.4, 200), 200)
    assert.equal(barWidth(undefined, 200), 0)
  })
  it('names the nearest level', () => {
    assert.equal(nearestLevel(2.6, ['a', 'b', 'c', 'd', 'e']), 'd')
    assert.equal(nearestLevel(9, ['a', 'b']), 'b')
  })
})

describe('closest without going over', () => {
  const guesses = [
    { key: 'you', guess: 89 },
    { key: 0, guess: 92 },
    { key: 1, guess: 95 },
    { key: 2, guess: null },
  ]
  it('picks the highest guess at or under the critic', () => {
    assert.deepEqual(winners(guesses, 93), [0])
    assert.deepEqual(winners(guesses, 92), [0])
    assert.deepEqual(winners(guesses, 90), ['you'])
  })
  it('lets ties share, and nobody win when everyone went over', () => {
    assert.deepEqual(winners([{ key: 'a', guess: 90 }, { key: 'b', guess: 90 }], 91), ['a', 'b'])
    assert.deepEqual(winners(guesses, 85), [])
    assert.deepEqual(winners(guesses, null), [])
  })
  it('says how each guess fared', () => {
    assert.equal(fateOf(95, 93, false), 'over')
    assert.equal(fateOf(92, 93, true), 'won')
    assert.equal(fateOf(89, 93, false), 'under')
    assert.equal(fateOf(null, 93, false), 'none')
    assert.equal(fateOf(90, null, false), 'sealed')
  })
})

describe('your guess and the model', () => {
  it('reads a whole number from 80 to 100', () => {
    assert.equal(parseGuess(' 91 '), 91)
    assert.equal(parseGuess('100'), 100)
    assert.equal(parseGuess('79'), null)
    assert.equal(parseGuess('91.5'), null)
    assert.equal(parseGuess(''), null)
    assert.equal(parseGuess('ninety'), null)
  })
  it('writes weights with their sign and lays out the scatter', () => {
    assert.equal(fmtWeight(1.84), '+1.8')
    assert.equal(fmtWeight(-0.6), '−0.6')
    assert.equal(axis(90, 220, 10), 110)
    assert.equal(axis(70, 220, 10), 10)
    assert.deepEqual(scatter([{ n: 1, pred: 80, critic: 100 }], 100), [{ n: 1, x: 0, y: 0 }])
  })
})
