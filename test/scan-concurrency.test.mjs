/**
 * The scan reads session logs through a bounded pool. Reading is pure, so
 * running several reads at once must not change a single verdict — that is the
 * whole contract of `mapBounded`, and it is what lets `recoverUnplannedSessions`
 * keep its serial decision loop while only the reads overlap.
 *
 * These tests pin the two properties the caller relies on:
 *   1. POSITIONAL STABILITY — `results[i]` is the outcome of `items[i]`, no
 *      matter how the tasks interleave in time.
 *   2. FAILURE ISOLATION — one rejected read is reported at its own index and
 *      does not cancel or reorder the rest.
 * Both are asserted against a serial reference run, so a future change that
 * makes the pool faster but order-unsafe fails here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { mapBounded, SESSION_READ_CONCURRENCY } = internals

/**
 * Run the same items strictly one at a time, as the serial reference.
 * @param {unknown[]} items - the work items.
 * @param {(item: unknown, index: number) => Promise<unknown>} task - the work.
 * @returns {Promise<unknown[]>} the outcomes, in order.
 */
async function serial(items, task) {
  const out = []
  for (let index = 0; index < items.length; index += 1) out.push(await task(items[index], index))
  return out
}

test('mapBounded: results are positionally stable under jittered concurrency', async () => {
  const items = Array.from({ length: 40 }, (_, index) => index)
  // Descending, jittered delays: the LAST item finishes FIRST, which is exactly
  // the interleaving that would shuffle a position-unsafe pool.
  const task = async (value) => {
    await new Promise(resolve => setTimeout(resolve, (items.length - value) % 7))
    return `s-${value}`
  }
  const pool = await mapBounded(items, SESSION_READ_CONCURRENCY, task)
  const reference = await serial(items, task)
  assert.deepEqual(pool.map((outcome) => outcome.value), reference)
  assert.ok(pool.every((outcome) => outcome.ok === true))
})

test('mapBounded: a rejected task is reported at its own index and does not cancel the rest', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f']
  const task = async (value, index) => {
    if (index === 2 || index === 4) throw new Error(`boom-${value}`)
    return `ok-${value}`
  }
  const results = await mapBounded(items, 3, task)
  assert.equal(results.length, items.length)
  assert.deepEqual(
    results.map((outcome) => (outcome.ok === true ? outcome.value : `threw:${outcome.error.message}`)),
    ['ok-a', 'ok-b', 'threw:boom-c', 'ok-d', 'threw:boom-e', 'ok-f'],
  )
})

test('mapBounded: never runs more tasks at once than the cap', async () => {
  let inFlight = 0
  let peak = 0
  const items = Array.from({ length: 24 }, (_, index) => index)
  const task = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise(resolve => setTimeout(resolve, 1))
    inFlight -= 1
    return true
  }
  await mapBounded(items, 4, task)
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded the cap of 4`)
  assert.ok(peak > 1, `the pool never overlapped work (peak ${peak})`)
})

test('mapBounded: an empty batch resolves to an empty list', async () => {
  const results = await mapBounded([], 4, async () => 'never')
  assert.deepEqual(results, [])
})

test('mapBounded: a cap larger than the batch still runs everything exactly once', async () => {
  const items = ['only', 'two']
  const seen = []
  const results = await mapBounded(items, 16, async (value) => {
    seen.push(value)
    return value.toUpperCase()
  })
  assert.deepEqual(results.map((outcome) => outcome.value), ['ONLY', 'TWO'])
  assert.deepEqual(seen.sort(), ['only', 'two'])
})

test('the scan reads logs with a small pool, not all at once', () => {
  // A 20k-event log costs seconds to decompress and clone; the cap is what
  // keeps peak memory at a few logs instead of the whole corpus.
  assert.ok(SESSION_READ_CONCURRENCY >= 4 && SESSION_READ_CONCURRENCY <= 8,
    `concurrency ${SESSION_READ_CONCURRENCY} outside the 4..8 band`)
})
