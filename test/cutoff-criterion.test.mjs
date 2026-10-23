/**
 * The cut-off criterion — "was this conversation interrupted?".
 *
 * It decides two separate things and must be right in both:
 *  - which subagents a restart wakes (`wasSessionCutOff`), and
 *  - which crashed sessions an unplanned exit recovers.
 *
 * Four durable fingerprints count, any one of them:
 *   unclosed turn            the tail turn/start has no turn/end
 *   interrupted              the last turn/end carries `interrupted`
 *   aborted + disposed       the process was torn down mid-turn
 *   interrupted message      a committed assistant/message with interrupted:true
 *
 * A turn the human stopped, a completed turn, a failed turn and a
 * token-ceiling turn had nothing in flight and must count as finished.
 *
 * The log is read with `readSession` (the complete event stream) and balanced
 * locally, because `observeSession` returns a seed view.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { balanceLog, cutOffReason, wasSessionCutOff } = internals

/**
 * A minimal event.
 * @param {string} type - the event type.
 * @param {Record<string, any>} data - its payload.
 * @param {number} [seq] - its sequence number.
 * @returns {object} the event.
 */
function event(type, data, seq = undefined) {
  return { type, data, ...(seq === undefined ? {} : { seq }), time: 1000 + (seq ?? 0) }
}

/**
 * A balanced log that ends with the given reason.
 * @param {any} reason - the last turn/end reason.
 * @returns {object[]} the events.
 */
function endsWith(reason) {
  return [
    event('turn/start', { turn: 1 }, 0),
    event('turn/end', { turn: 1, reason }, 1),
  ]
}

test('criterion2: an unclosed turn is cut off', () => {
  const events = [event('turn/start', { turn: 1 }, 0), event('step/start', { turn: 1, step: 1 }, 1)]
  assert.deepEqual(cutOffReason(events), { cutOff: true, reason: 'unclosed-turn' })
})

test('criterion2: a trailing turn/start after a closed turn is cut off', () => {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
    event('turn/start', { turn: 2 }, 2),
  ]
  assert.deepEqual(cutOffReason(events), { cutOff: true, reason: 'unclosed-turn' })
})

test('criterion2: an interrupted turn/end is cut off', () => {
  assert.deepEqual(cutOffReason(endsWith({ kind: 'interrupted' })), { cutOff: true, reason: 'interrupted' })
})

test('criterion2: an aborted turn with a disposed cause is cut off', () => {
  const events = endsWith({ kind: 'aborted', reason: { kind: 'disposed' } })
  assert.deepEqual(cutOffReason(events), { cutOff: true, reason: 'aborted+disposed' })
})

test('criterion2: an assistant message marked interrupted is cut off', () => {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event('assistant/message', { turn: 1, step: 1, message: {}, interrupted: true }, 1),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
  ]
  assert.deepEqual(cutOffReason(events), { cutOff: true, reason: 'interrupted-message' })
})

test('criterion2: a turn the human stopped is finished', () => {
  const events = endsWith({ kind: 'aborted', reason: { kind: 'user' } })
  assert.equal(cutOffReason(events).cutOff, false)
})

test('criterion2: a completed turn is finished', () => {
  assert.equal(cutOffReason(endsWith({ kind: 'completed' })).cutOff, false)
})

test('criterion2: a failed turn is finished', () => {
  const events = endsWith({ kind: 'error', error: { message: 'boom' } })
  assert.deepEqual(cutOffReason(events), { cutOff: false, reason: 'error' })
})

test('criterion2: a token-ceiling turn is finished', () => {
  assert.equal(cutOffReason(endsWith({ kind: 'max-tokens' })).cutOff, false)
})

test('criterion2: an empty log is not cut off', () => {
  assert.deepEqual(cutOffReason([]), { cutOff: false, reason: 'no-turn-end' })
})

test('criterion2: an assistant message without the marker does not count', () => {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event('assistant/message', { turn: 1, step: 1, message: {} }, 1),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2),
  ]
  assert.equal(cutOffReason(events).cutOff, false)
})

test('balance: an open tail turn is closed with an interrupted closer', () => {
  const events = [event('turn/start', { turn: 1 }, 0)]
  const balanced = balanceLog(events)
  assert.equal(balanced.length, 2)
  assert.equal(balanced.at(-1).type, 'turn/end')
  assert.deepEqual(balanced.at(-1).data, { turn: 1, reason: { kind: 'interrupted' } })
})

test('balance: a closed log is returned unchanged', () => {
  const events = endsWith({ kind: 'completed' })
  const balanced = balanceLog(events)
  assert.equal(balanced.length, events.length)
  assert.equal(balanced.at(-1).data.reason.kind, 'completed')
})

test('balance: it is idempotent', () => {
  const once = balanceLog([event('turn/start', { turn: 1 }, 0)])
  const twice = balanceLog(once)
  assert.equal(twice.length, once.length)
})

test('balance: every open turn is closed, not just the last', () => {
  const events = [
    event('turn/start', { turn: 1 }, 0),
    event('turn/start', { turn: 2 }, 1),
  ]
  const balanced = balanceLog(events)
  assert.equal(balanced.length, 4)
  assert.deepEqual(balanced.slice(2).map(e => e.data.turn).sort(), [1, 2])
})

test('wasSessionCutOff reads the complete log through readSession', async () => {
  const seen = []
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return {
        readSession: async (id) => {
          seen.push(id)
          return { events: [event('turn/start', { turn: 1 }, 0)] }
        },
        // A seed view would say "finished"; the complete log says otherwise.
        observeSession: async () => ({ events: [], projections: { values: {} } }),
      }
    },
  }
  assert.deepEqual(await wasSessionCutOff(ctx, 'child-1'), { cutOff: true, reason: 'unclosed-turn' })
  assert.deepEqual(seen, ['child-1'], 'readSession is the reader, not observeSession')
})

test('wasSessionCutOff reports a failure instead of claiming a wake', async () => {
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return { readSession: async () => { throw new Error('gone') } }
    },
  }
  assert.deepEqual(await wasSessionCutOff(ctx, 'child-1'), { cutOff: false, reason: 'read-failed' })
})

test('wasSessionCutOff without a session query never claims a wake', async () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(await wasSessionCutOff(ctx, 'child-1'), { cutOff: false, reason: 'no-session-query' })
})
