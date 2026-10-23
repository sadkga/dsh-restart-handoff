/**
 * The tail read: decide "was the LAST turn cut off?" from the end of the log.
 *
 * Reading a whole log costs a decompress, a parse and a replay validation of
 * every event — seconds for a 20k-event session. The question only concerns the
 * final turn boundary, which sits in the last few kilobytes, so the scan reads
 * the tail and falls back to the full read when the tail cannot be trusted.
 *
 * The invariant these tests pin: for every shape of log, the tail verdict equals
 * the whole-log verdict. That is what makes the optimisation a performance
 * change rather than a behaviour change.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { cutOffReason, tailCutOffReason, tailWindowComplete } = internals

const start = (turn) => ({ type: 'turn/start', data: { turn } })
const end = (turn, reason) => ({ type: 'turn/end', data: { turn, reason } })

test('tail criterion: an open last turn is a cut-off', () => {
  assert.deepEqual(tailCutOffReason([start(1), end(1, { kind: 'completed' }), start(2)]),
    { cutOff: true, reason: 'unclosed-turn' })
})

test('tail criterion: the last turn ENDING interrupted is a cut-off', () => {
  assert.deepEqual(tailCutOffReason([start(1), end(1, { kind: 'interrupted' })]),
    { cutOff: true, reason: 'interrupted' })
})

test('tail criterion: aborted + disposed is a cut-off', () => {
  assert.deepEqual(
    tailCutOffReason([start(1), end(1, { kind: 'aborted', reason: { kind: 'disposed' } })]),
    { cutOff: true, reason: 'aborted+disposed' },
  )
})

test('tail criterion: a turn the human stopped is NOT a cut-off', () => {
  assert.deepEqual(tailCutOffReason([start(1), end(1, { kind: 'aborted', reason: { kind: 'user' } })]),
    { cutOff: false, reason: 'aborted' })
})

test('tail criterion: a finished turn is NOT a cut-off', () => {
  assert.deepEqual(tailCutOffReason([start(1), end(1, { kind: 'completed' })]),
    { cutOff: false, reason: 'completed' })
})

test('tail criterion: an empty or seed-only log has nothing in flight', () => {
  assert.deepEqual(tailCutOffReason([]), { cutOff: false, reason: 'no-turn-end' })
  assert.deepEqual(tailCutOffReason([{ type: 'session/start' }, { type: 'user/message' }]),
    { cutOff: false, reason: 'no-turn-end' })
})

test('tail criterion: a LAST turn start older than a turn/end still defers to the end', () => {
  // The window happens to hold an earlier turn's start plus a later turn's end:
  // the end is the newest boundary, so its reason decides.
  assert.deepEqual(tailCutOffReason([start(1), end(1, { kind: 'completed' }), start(2), end(2, { kind: 'error' })]),
    { cutOff: false, reason: 'error' })
})

test('tail criterion agrees with the whole-log criterion on every shape', () => {
  const shapes = {
    'unclosed': [start(1), end(1, { kind: 'completed' }), start(2)],
    'interrupted': [start(1), end(1, { kind: 'interrupted' })],
    'disposed': [start(1), end(1, { kind: 'aborted', reason: { kind: 'disposed' } })],
    'user-abort': [start(1), end(1, { kind: 'aborted', reason: { kind: 'user' } })],
    'completed': [start(1), end(1, { kind: 'completed' })],
    'error': [start(1), end(1, { kind: 'error' })],
    'max-tokens': [start(1), end(1, { kind: 'max-tokens' })],
    'empty': [],
    'multi-then-interrupted': [
      start(1), end(1, { kind: 'completed' }),
      start(2), end(2, { kind: 'completed' }),
      start(3), end(3, { kind: 'interrupted' }),
    ],
    'interrupted-message-at-tail': [
      start(1),
      { type: 'assistant/message', data: { turn: 1, interrupted: true } },
    ],
  }
  for (const [name, events] of Object.entries(shapes)) {
    const full = cutOffReason(events)
    const tail = tailCutOffReason(events)
    assert.equal(tail.cutOff, full.cutOff, `${name}: cutOff differs (full ${JSON.stringify(full)} / tail ${JSON.stringify(tail)})`)
    assert.equal(tail.reason, full.reason, `${name}: reason differs (full ${JSON.stringify(full)} / tail ${JSON.stringify(tail)})`)
  }
})

test('window completeness: a window with a turn boundary can decide', () => {
  assert.equal(tailWindowComplete([start(1), end(1, { kind: 'completed' })], false), true)
  assert.equal(tailWindowComplete([end(1, { kind: 'completed' }), start(2)], false), true)
})

test('window completeness: a window with no turn boundary must widen', () => {
  assert.equal(tailWindowComplete([{ type: 'tool/result' }, { type: 'step/end' }], false), false)
  assert.equal(tailWindowComplete([], false), false)
})

test('window completeness: reaching the file start always decides', () => {
  // With the whole file in hand the window is the log, whatever it holds.
  assert.equal(tailWindowComplete([{ type: 'user/message' }], true), true)
  assert.equal(tailWindowComplete([], true), true)
})
