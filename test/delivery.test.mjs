/**
 * Delivery — the half of the fix that decides whether a continue instruction
 * actually RUNS, not merely whether `followup()` returned without throwing.
 *
 * The failure this file guards is silent. `followup()` splices the message
 * into the inbox and calls `wakeDriver()`; a wake issued while the phase is
 * `running` and past that driver's last `hasPending` check is claimed by
 * nobody, and nothing throws. The log then reports a successful nudge while
 * the conversation never moves.
 *
 * So `deliverContinue` waits for quiescence, delivers, and then watches the
 * message LEAVE the inbox. These cases pin all three outcomes: claimed,
 * claimed only after a retry, and honestly reported as unclaimed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { DELIVERY_CLAIM_TIMEOUT_MS, IDLE_WAIT_TIMEOUT_MS, deliverContinue, stillQueued } = internals

/**
 * A fake agent whose driver behaviour is scripted.
 * @param {{ idle?: boolean, claim?: boolean, claimOnAttempt?: number, throwOnFollowup?: boolean }} [options] - the script.
 * @returns {{ agent: Record<string, any>, seen: Record<string, any[]> }} the agent double and its record.
 */
function fakeAgent(options = {}) {
  const seen = { delivered: [], cancels: 0, idleWaits: 0 }
  let attempt = 0
  const agent = {
    id: 'a1',
    status: options.idle === false ? 'running' : 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    whenIdle: async () => {
      seen.idleWaits += 1
      // `idle: false` models an agent that is still busy when we arrive.
      return options.idle === false ? Promise.resolve() : Promise.resolve()
    },
    followup: (message) => {
      if (options.throwOnFollowup === true) throw new Error('inbox closed')
      attempt += 1
      seen.delivered.push(message)
      const shouldClaim = options.claim ?? true
      if (options.claimOnAttempt !== undefined) {
        // Claim only from the given attempt onwards.
        if (attempt >= options.claimOnAttempt) return
        agent.inbox.nextTurn.push(message)
        return
      }
      if (!shouldClaim) agent.inbox.nextTurn.push(message)
    },
    cancel: () => { seen.cancels += 1 },
  }
  return { agent, seen }
}

test('delivery: a claimable instruction is reported as claimed', async () => {
  const { agent, seen } = fakeAgent()
  const result = await deliverContinue(agent, 'carry on', { claimTimeoutMs: 200, idleTimeoutMs: 200 })
  assert.equal(result.claimed, true)
  assert.equal(seen.delivered.length, 1)
})

test('delivery: a message left in the inbox is detected, not called a success', async () => {
  // The exact production failure: the splice worked, the driver never woke.
  const { agent } = fakeAgent({ claim: false })
  const result = await deliverContinue(agent, 'carry on', { claimTimeoutMs: 120, idleTimeoutMs: 120 })
  assert.equal(result.delivered, true, 'the message did land')
  assert.equal(result.claimed, false, 'but it was never claimed')
  assert.match(result.reason, /NOT CLAIMED/)
})

test('delivery: the unclaimed path cancels the stuck activity and retries', async () => {
  const { agent, seen } = fakeAgent({ claimOnAttempt: 2 })
  const result = await deliverContinue(agent, 'carry on', { claimTimeoutMs: 120, idleTimeoutMs: 120 })
  assert.equal(seen.cancels, 1, 'it must cancel the live phase that held the wake')
  assert.equal(result.attempts, 2, 'it must re-deliver once')
  assert.equal(result.claimed, true, 'the retry claims it')
})

test('delivery: a throwing followup is reported, never swallowed', async () => {
  const { agent } = fakeAgent({ throwOnFollowup: true })
  const result = await deliverContinue(agent, 'carry on', { claimTimeoutMs: 120, idleTimeoutMs: 120 })
  assert.equal(result.delivered, false)
  assert.equal(result.claimed, false)
  assert.match(result.reason, /followup-failed/)
})

test('delivery: it waits for quiescence BEFORE delivering', async () => {
  const { agent, seen } = fakeAgent()
  await deliverContinue(agent, 'carry on', { claimTimeoutMs: 200, idleTimeoutMs: 200 })
  assert.equal(seen.idleWaits >= 1, true, 'the wait must happen before the splice')
})

test('delivery: an agent without whenIdle still delivers and still verifies', async () => {
  const { agent } = fakeAgent()
  delete agent.whenIdle
  const result = await deliverContinue(agent, 'carry on', { claimTimeoutMs: 200, idleTimeoutMs: 200 })
  assert.equal(result.claimed, true)
  assert.match(result.reason, /no-when-idle/)
})

test('stillQueued: a message is found in either pending list', () => {
  const message = { id: 'm1' }
  assert.equal(stillQueued({ inbox: { nextTurn: [message], nextStep: [] } }, 'm1'), true)
  assert.equal(stillQueued({ inbox: { nextTurn: [], nextStep: [message] } }, 'm1'), true)
  assert.equal(stillQueued({ inbox: { nextTurn: [], nextStep: [] } }, 'm1'), false)
})

test('stillQueued: a missing inbox is not pending', () => {
  assert.equal(stillQueued({}, 'm1'), false)
  assert.equal(stillQueued(undefined, 'm1'), false)
})

test('the delivery windows are bounded', () => {
  assert.equal(typeof DELIVERY_CLAIM_TIMEOUT_MS, 'number')
  assert.equal(typeof IDLE_WAIT_TIMEOUT_MS, 'number')
  assert.ok(DELIVERY_CLAIM_TIMEOUT_MS > 0)
  assert.ok(IDLE_WAIT_TIMEOUT_MS > 0)
})

/**
 * A running agent that never becomes idle: the state that cost 110s.
 * @returns {{ agent: Record<string, any>, seen: Record<string, any> }} the double.
 */
function busyAgent() {
  const seen = { idleWaits: 0, cancels: 0, delivered: 0 }
  const agent = {
    id: 'busy',
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    whenIdle: () => { seen.idleWaits += 1; return new Promise(() => {}) },
    followup(message) { seen.delivered += 1; agent.inbox.nextTurn.push(message) },
    cancel() { seen.cancels += 1 },
  }
  return { agent, seen }
}

test('strategy: a RUNNING agent is delivered to without waiting for idle', async () => {
  // The parked message is normal: the live driver re-checks hasPending at its
  // own turn boundary (agent.ts:392). Waiting for idle here was the bug.
  const { agent, seen } = busyAgent()
  const started = Date.now()
  const result = await deliverContinue(agent, 'carry on', { queueSettleMs: 120, claimTimeoutMs: 200, idleTimeoutMs: 200 })
  const elapsed = Date.now() - started
  assert.equal(result.claimed, true, 'a queued message on a live driver is a delivery')
  assert.equal(result.queued, true)
  assert.equal(seen.idleWaits, 0, 'a running agent must NOT be waited on')
  assert.equal(seen.cancels, 0, 'and must NOT be cancelled')
  assert.ok(elapsed < 1000, `it must return promptly, took ${elapsed}ms`)
})

test('strategy: the running path stays bounded even with a long claim window', async () => {
  // Guards the regression directly: a running session must never cost the
  // 60s claim window, let alone a 30s idle wait, per session.
  const { agent } = busyAgent()
  const started = Date.now()
  await deliverContinue(agent, 'carry on', { idleTimeoutMs: 30_000, claimTimeoutMs: 60_000, queueSettleMs: 100 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 2000, `a busy session must not stall the scan, took ${elapsed}ms`)
})

test('strategy: an IDLE agent still verifies the claim', async () => {
  const { agent, seen } = fakeAgent()
  const result = await deliverContinue(agent, 'carry on', { queueSettleMs: 200, claimTimeoutMs: 200, idleTimeoutMs: 200 })
  assert.equal(result.claimed, true)
  assert.equal(result.queued, false, 'an idle delivery is claimed, not queued')
  assert.equal(seen.idleWaits >= 1, true, 'an idle agent is still waited on first')
})

test('strategy: an idle agent whose message is never claimed is still detected', async () => {
  // The genuine drop: nothing is running, nothing claims it, nothing will.
  const { agent, seen } = fakeAgent({ claim: false })
  const result = await deliverContinue(agent, 'carry on', { queueSettleMs: 100, claimTimeoutMs: 120, idleTimeoutMs: 120 })
  assert.equal(result.claimed, false)
  assert.match(result.reason, /NOT CLAIMED/)
  assert.equal(seen.cancels, 1, 'the drop path still cancels and retries')
})
