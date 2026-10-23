/**
 * Which subagents a restore wakes — and, just as important, which it leaves
 * asleep.
 *
 * The question is never "what mode was this child created in". It is "does
 * this child's log show work in flight", asked of the complete event stream
 * through `readSession`. A one-shot child that was cut off mid-turn must come
 * back; a child that finished must not be touched; a continuable child keeps
 * behaving exactly as before.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { wakeSubagents } = internals

/**
 * A log whose tail turn never ended.
 * @returns {object[]} the events.
 */
function unclosedLog() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 1001, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 2, time: 1002, data: { turn: 1, step: 1, callId: 'c1', name: 'read' } },
  ]
}

/**
 * A log that finished cleanly.
 * @returns {object[]} the events.
 */
function completedLog() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 1001, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * A log the human stopped on purpose.
 * @returns {object[]} the events.
 */
function userStoppedLog() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 1001, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
  ]
}

/**
 * A host double with a fixed descendant list and per-child logs.
 * @param {object[]} descendants - the children.
 * @param {Record<string, object[]>} logs - the log per child id.
 * @returns {{ ctx: Record<string, any>, calls: Record<string, any[]> }} the fake context and the recorded calls.
 */
function wakeCtx(descendants, logs) {
  const calls = { prompted: [], read: [] }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionQuery') {
        return {
          readSession: async (id) => {
            calls.read.push(id)
            if (logs[id] === undefined) throw new Error('no log')
            return { events: logs[id] }
          },
        }
      }
      if (name === 'subagents') {
        return {
          listDescendants: async () => descendants,
          prompt: async (request) => { calls.prompted.push(request) },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('wake: a one-shot child that was cut off is woken', async () => {
  const child = { id: 'c-shot', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-shot': unclosedLog() })
  const woken = await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.deepEqual(woken, ['c-shot'])
  assert.equal(calls.prompted.length, 1)
})

test('wake: a one-shot child that finished is left asleep', async () => {
  const child = { id: 'c-shot', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-shot': completedLog() })
  const woken = await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.deepEqual(woken, [])
  assert.equal(calls.prompted.length, 0, 'a finished child must not be told to continue')
})

test('wake: a one-shot child the human stopped is left asleep', async () => {
  const child = { id: 'c-shot', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-shot': userStoppedLog() })
  assert.deepEqual(await wakeSubagents(ctx, 'p', { reason: 'because' }), [])
  assert.equal(calls.prompted.length, 0)
})

test('wake: a continuable child that was cut off is still woken', async () => {
  const child = { id: 'c-cont', parentId: 'p', depth: 1, mode: 'continuable', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-cont': unclosedLog() })
  const woken = await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.deepEqual(woken, ['c-cont'])
  assert.equal(calls.prompted.length, 1)
})

test('wake: a continuable child that finished is left asleep', async () => {
  const child = { id: 'c-cont', parentId: 'p', depth: 1, mode: 'continuable', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-cont': completedLog() })
  assert.deepEqual(await wakeSubagents(ctx, 'p', { reason: 'because' }), [])
  assert.equal(calls.prompted.length, 0)
})

test('wake: the delivery keeps the continuable-addressed protocol', async () => {
  // `mode` is the runtime's address discriminator, not the child's creation
  // mode: the request must still be well-formed for the transport.
  const child = { id: 'c-shot', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], { 'c-shot': unclosedLog() })
  await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.equal(calls.prompted[0].mode, 'continuable')
  assert.equal(calls.prompted[0].delivery, 'queue')
  assert.equal(calls.prompted[0].parentSessionId, 'p')
  assert.equal(calls.prompted[0].childSessionId, 'c-shot')
  assert.equal(typeof calls.prompted[0].requestId, 'string')
})

test('wake: one child failing never costs the others', async () => {
  const kids = [
    { id: 'c-1', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' },
    { id: 'c-2', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' },
    { id: 'c-3', parentId: 'p', depth: 1, mode: 'one-shot', activity: 'inactive' },
  ]
  const calls = { prompted: [] }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: unclosedLog() }) }
      if (name === 'subagents') {
        return {
          listDescendants: async () => kids,
          prompt: async (request) => {
            if (request.childSessionId === 'c-2') throw new Error('subagent/not-resumable')
            calls.prompted.push(request.childSessionId)
          },
        }
      }
      return undefined
    },
  }
  const woken = await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.deepEqual(woken, ['c-1', 'c-3'])
  assert.deepEqual(calls.prompted, ['c-1', 'c-3'])
})

test('wake: a child whose log cannot be read is left asleep', async () => {
  const child = { id: 'c-gone', parentId: 'p', depth: 1, mode: 'continuable', activity: 'inactive' }
  const { ctx, calls } = wakeCtx([child], {})
  assert.deepEqual(await wakeSubagents(ctx, 'p', { reason: 'because' }), [])
  assert.equal(calls.prompted.length, 0)
})

test('wake: the tree is walked top-down, parent first', async () => {
  const kids = [
    { id: 'grandchild', parentId: 'child', depth: 2, mode: 'continuable', activity: 'inactive' },
    { id: 'child', parentId: 'p', depth: 1, mode: 'continuable', activity: 'inactive' },
  ]
  const { ctx, calls } = wakeCtx(kids, { grandchild: unclosedLog(), child: unclosedLog() })
  await wakeSubagents(ctx, 'p', { reason: 'because' })
  assert.deepEqual(calls.prompted.map(request => request.childSessionId), ['child', 'grandchild'])
})

test('wake: without the delegation runtime nothing is woken', async () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(await wakeSubagents(ctx, 'p', { reason: 'because' }), [])
})
