/**
 * The session collection: which sessions a restart has to bring back.
 *
 * The rule is deliberately narrow. A session that is merely OPEN is not
 * resumed: resuming it would put a silent, idle agent into the registry and
 * spend the recovery budget on it. A session comes back when it was running,
 * when it had a prompt queued that never started, or when one of its
 * subagents was alive.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const {
  DEFAULTS,
  collectRestartTargets,
  hasPendingWork,
  isResumableRoot,
  isRootSession,
  listResumableSessions,
} = internals

/**
 * A live agent double.
 * @param {string} id - the session id.
 * @param {{ status?: string, nextTurn?: number, nextStep?: number }} [options] - its state.
 * @returns {Record<string, any>} the fake agent.
 */
function agent(id, options = {}) {
  return {
    id,
    status: options.status ?? 'idle',
    inbox: {
      nextTurn: new Array(options.nextTurn ?? 0).fill({}),
      nextStep: new Array(options.nextStep ?? 0).fill({}),
    },
    session: { header: { id } },
  }
}

/**
 * A host double with a fixed set of roots and subagents.
 * @param {object[]} roots - the live root agents.
 * @param {Record<string, object[]>} [descendants] - the descendants per root id.
 * @returns {Record<string, any>} the fake context.
 */
function ctxWith(roots, descendants = {}) {
  return {
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'subagents') {
        return { listDescendants: async (id) => descendants[id] ?? [] }
      }
      return undefined
    },
  }
}

test('a queued prompt counts as work in flight', () => {
  assert.equal(hasPendingWork(agent('a', { nextTurn: 1 })), true)
})

test('a queued step counts as work in flight', () => {
  assert.equal(hasPendingWork(agent('a', { nextStep: 1 })), true)
})

test('an idle agent without a queue has no work in flight', () => {
  assert.equal(hasPendingWork(agent('a')), false)
})

test('an agent without an inbox has no work in flight', () => {
  assert.equal(hasPendingWork(undefined), false)
})

test('only a top-level session is a root session', () => {
  const ctx = ctxWith([agent('root-1'), agent('root-2')])
  assert.equal(isRootSession(ctx, 'root-1'), true)
  assert.equal(isRootSession(ctx, 'root-2'), true)
})

test('a subagent is not a root session', () => {
  const ctx = ctxWith([agent('root-1')])
  assert.equal(isRootSession(ctx, 'child-1'), false)
})

test('a running session is resumable', async () => {
  const ctx = ctxWith([agent('busy', { status: 'running' })])
  assert.equal(await isResumableRoot(ctx, agent('busy', { status: 'running' })), true)
})

test('a queued session is resumable', async () => {
  const ctx = ctxWith([agent('queued', { nextTurn: 1 })])
  assert.equal(await isResumableRoot(ctx, agent('queued', { nextTurn: 1 })), true)
})

test('an idle session with a live subagent is resumable', async () => {
  const child = { id: 'child-1', activity: 'running' }
  const ctx = ctxWith([agent('parent')], { parent: [child] })
  assert.equal(await isResumableRoot(ctx, agent('parent')), true)
})

test('an idle session with a dead subagent is not resumable', async () => {
  const child = { id: 'child-1', activity: 'idle' }
  const ctx = ctxWith([agent('parent')], { parent: [child] })
  assert.equal(await isResumableRoot(ctx, agent('parent')), false)
})

test('an idle session with nothing pending is not resumable', async () => {
  const ctx = ctxWith([agent('idle')])
  assert.equal(await isResumableRoot(ctx, agent('idle')), false)
})

test('the resumable sessions exclude the caller', async () => {
  const ctx = ctxWith([
    agent('caller', { status: 'running' }),
    agent('busy', { status: 'running' }),
    agent('queued', { nextTurn: 1 }),
    agent('idle'),
  ])
  assert.deepEqual((await listResumableSessions(ctx, 'caller')).sort(), ['busy', 'queued'])
})

test('the resumable sessions are empty when the caller is the only one', async () => {
  const ctx = ctxWith([agent('caller', { status: 'running' })])
  assert.deepEqual(await listResumableSessions(ctx, 'caller'), [])
})

test('the restart targets include the caller itself', async () => {
  const ctx = ctxWith([
    agent('caller'),
    agent('busy', { status: 'running' }),
    agent('idle'),
  ])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller', 'busy'])
})

test('the restart targets of a lone caller are the caller alone', async () => {
  const ctx = ctxWith([agent('caller')])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('a profile without the delegation runtime still collects sessions', async () => {
  const ctx = ctxWith([agent('busy', { status: 'running' })])
  assert.deepEqual(await listResumableSessions(ctx, 'other'), ['busy'])
})

test('the recovery defaults are all present', () => {
  assert.equal(typeof DEFAULTS.recoverMaxAgeMs, 'number')
  assert.equal(typeof DEFAULTS.recoverMaxSessions, 'number')
  assert.equal(typeof DEFAULTS.pendingTtlMs, 'number')
  assert.equal(typeof DEFAULTS.handoffTtlMs, 'number')
  assert.equal(typeof DEFAULTS.idleTimeoutMs, 'number')
  assert.equal(DEFAULTS.recoverInterruptedSessions, true)
})
