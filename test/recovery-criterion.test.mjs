/**
 * The recovery criterion — what counts as "this session was interrupted".
 *
 * This is the one judgement that decides whether a crashed session comes back
 * or stays dead, so it gets its own matrix instead of a single happy-path
 * case. The rule: the LAST turn/end of the session log decides.
 *
 *   interrupted              → recover  (the writer crashed; the session layer
 *                                       closed the turn after the fact)
 *   aborted + disposed       → recover  (the process was torn down mid-turn)
 *   aborted + user           → no       (the human stopped it on purpose)
 *   completed                → no       (it finished; nothing was in flight)
 *   error                    → no       (it failed; nothing was in flight)
 *
 * The `openTurnStartSeq` projection is deliberately NOT part of the rule: a
 * cold read balances the log before the caller sees it, so that field is
 * always null and a rule built on it would be dead code.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { DEFAULTS, recoverUnplannedSessions } = internals

/**
 * A host double for the unplanned-recovery scan.
 * @param {object[]} observations - one observation per session id.
 * @returns {{ ctx: Record<string, any>, calls: Record<string, any[]> }} the fake context and the recorded calls.
 */
function scanCtx(observations) {
  const calls = { resumed: [], followups: [] }
  const byId = new Map(observations.map(observation => [observation.id, observation]))
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => observations.map(observation => ({
            id: observation.id,
            header: { id: observation.id },
            live: false,
          })),
          observeSession: async (id) => byId.get(id)?.observation,
          // The judgement reads the COMPLETE log, not the seed view. The double
          // returns the same events, which is what the real `readSession` does
          // for a balanced log; `cutOffReason` balances locally either way.
          readSession: async (id) => ({ session: { id }, events: byId.get(id)?.observation?.events ?? [] }),
        }
      }
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (options) => {
            calls.resumed.push(options)
            return {
              agent: {
                id: options.resumeSessionId,
                status: 'idle',
                inbox: { nextTurn: [], nextStep: [] },
                session: { header: { id: options.resumeSessionId } },
                followup: (message) => calls.followups.push(message),
              },
            }
          },
        }
      }
      return undefined
    },
    sessionPersistence: { flush: async () => {} },
  }
  return { ctx, calls }
}

/**
 * An observation whose last turn ended with a given reason.
 * @param {string} id - the session id.
 * @param {any} reason - the turn/end reason.
 * @param {object} [projections] - the projection values.
 * @returns {object} the observation.
 */
function observation(id, reason, projections = {}) {
  return {
    id,
    observation: {
      events: [{ type: 'turn/end', data: { turn: 1, reason } }],
      projections: { values: projections },
    },
  }
}

test('criterion: an interrupted turn is recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s1'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: an aborted turn with a disposed cause is recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'aborted', reason: { kind: 'disposed' } })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s1'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: a turn the human stopped is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'aborted', reason: { kind: 'user' } })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a completed turn is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a failed turn is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'error', error: { message: 'boom' } })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a turn that hit the token ceiling is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'max-tokens' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: the LAST turn/end decides, not an earlier one', async () => {
  const interrupted = { kind: 'interrupted' }
  const completed = { kind: 'completed' }
  const { ctx, calls } = scanCtx([{
    id: 's1',
    observation: {
      events: [
        { type: 'turn/end', data: { turn: 1, reason: interrupted } },
        { type: 'turn/end', data: { turn: 2, reason: completed } },
      ],
      projections: { values: {} },
    },
  }])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: an open turn boundary does NOT make a finished session recoverable', async () => {
  // The cold read balances the log, so `openTurnStartSeq` is null in
  // practice; a rule built on it would resurrect every session that ever
  // finished normally.
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' }, { turnBoundary: { openTurnStartSeq: 7 } })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a turn that finished but still has a queued prompt is recovered', async () => {
  // The turn ended on its own, but the inbox still holds a prompt that never
  // started — that is work in flight, and it must not be lost.
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' }, {
    inbox: { 'next-turn': [{ id: 'm1' }], 'next-step': [] },
  })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s1'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: a queued step counts as work in flight too', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' }, {
    inbox: { 'next-turn': [], 'next-step': [{ id: 'm1' }] },
  })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s1'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: a finished turn with an empty inbox is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' }, {
    inbox: { 'next-turn': [], 'next-step': [] },
  })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a finished turn with no inbox projection is not recovered', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'completed' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: an interrupted turn is recovered even without any projection', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s1'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: a session already resumed by the handoff is skipped', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, ['s1'])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a live session is not touched', async () => {
  const { ctx, calls } = scanCtx([{
    id: 's1',
    observation: { events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }], projections: { values: {} } },
  }])
  const liveCtx = {
    ...ctx,
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ id: 's1', header: { id: 's1' }, live: true }],
          observeSession: async () => ({ events: [], projections: { values: {} } }),
          readSession: async () => ({ events: [] }),
        }
      }
      return ctx.get(name)
    },
  }
  const recovered = await recoverUnplannedSessions(liveCtx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a child session is not scanned', async () => {
  const { ctx, calls } = scanCtx([{
    id: 's1',
    observation: { events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } }], projections: { values: {} } },
  }])
  const childCtx = {
    ...ctx,
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ id: 's1', header: { id: 's1', parentSession: 'root' }, live: false }],
          observeSession: async () => ({ events: [], projections: { values: {} } }),
          readSession: async () => ({ events: [] }),
        }
      }
      return ctx.get(name)
    },
  }
  const recovered = await recoverUnplannedSessions(childCtx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: the recovery can be switched off', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS, recoverInterruptedSessions: false }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: the recovered session is told what happened', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.match(calls.followups[0].content[0].text, /went down unexpectedly/)
})

test('criterion: the wake-up message is a complete user message', async () => {
  const { ctx, calls } = scanCtx([observation('s1', { kind: 'interrupted' })])
  await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  const message = calls.followups[0]
  // The inbox's durable projection rejects a second message without a
  // distinct id, so the identity is part of the contract, not a detail.
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
})

test('criterion: the number of recovered sessions is capped', async () => {
  const observations = [
    observation('s1', { kind: 'interrupted' }),
    observation('s2', { kind: 'interrupted' }),
    observation('s3', { kind: 'interrupted' }),
  ]
  const { ctx } = scanCtx(observations)
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS, recoverMaxSessions: 2 }, [])
  assert.equal(recovered.length, 2)
})

test('criterion: an old interrupted session is left alone', async () => {
  const { ctx, calls } = scanCtx([{
    id: 's1',
    observation: {
      events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } }, time: Date.now() - 10 * 60 * 60 * 1000 }],
      projections: { values: {} },
    },
  }])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS, recoverMaxAgeMs: 60 * 60 * 1000 }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('criterion: a corpus of finished sessions restores NOTHING', async () => {
  // The regression that must never come back: an archive view that is not
  // available must not degrade into "resume everything". Measured on the
  // live store this list is 51 root sessions; only a genuinely cut-off one
  // may come back.
  const observations = [
    observation('finished-a', { kind: 'completed' }),
    observation('finished-b', { kind: 'error', error: { message: 'boom' } }),
    observation('stopped-by-user', { kind: 'aborted', reason: { kind: 'user' } }),
    observation('ceiling', { kind: 'max-tokens' }),
    observation('cut-off', { kind: 'interrupted' }),
  ]
  const { ctx, calls } = scanCtx(observations)
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['cut-off'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: an unclosed turn is recovered on the durable log alone', async () => {
  // No turn/end at all: the writer never closed the turn. The recovery must
  // not need the Host to have balanced the log first.
  const { ctx, calls } = scanCtx([{
    id: 'open-tail',
    observation: {
      events: [
        { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
        { type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'read' } },
      ],
      projections: { values: {} },
    },
  }])
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['open-tail'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: a seed-only view is not mistaken for a finished session', async () => {
  // observeSession returns a seed view; the judgement must come from
  // readSession, which the double serves separately. Here the observation is
  // empty on purpose, and the complete log still shows the cut-off.
  const { ctx, calls } = scanCtx([{
    id: 'seed',
    observation: {
      events: [{ type: 'session/end-seed' }],
      projections: { values: {} },
    },
  }])
  const read = []
  const realGet = ctx.get
  ctx.get = (name) => {
    const service = realGet(name)
    if (name !== 'sessionQuery') return service
    return {
      ...service,
      readSession: async (id) => {
        read.push(id)
        return { events: [{ type: 'turn/start', time: Date.now(), data: { turn: 1 } }] }
      },
    }
  }
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['seed'])
  assert.deepEqual(read, ['seed'])
  assert.equal(calls.resumed.length, 1)
})

test('criterion: an archived session is not restored by the scan either', async () => {
  // Archiving is a user decision, and the Host gates every step of an
  // archived session (archived-session-gate). Resuming one would create an
  // agent that can never take a step — a phantom in the registry.
  const { ctx, calls } = scanCtx([observation('archived-cut-off', { kind: 'interrupted' })])
  const realGet = ctx.get
  ctx.get = (name) => {
    if (name === 'workspaceRegistry') return { get archivedSessionIds() { return ['archived-cut-off'] } }
    return realGet(name)
  }
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})
