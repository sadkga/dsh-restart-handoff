/**
 * Tests for the replay path — the half that only runs inside a fresh Host
 * process: resumeSession() and runHandoff(). They are the riskiest code in
 * the bundle, because every failure mode there costs the user a session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals } from '../index.js'

const { DEFAULTS, HANDOFF_FILE, PENDING_FILE, readRecord, resumeSession, runHandoff } = internals

/**
 * A host double for the replay path.
 * @param {{ events?: object[], projections?: object, sessions?: object[], resumeError?: Error, live?: object, mountFails?: boolean }} options - the doubles' behaviour.
 * @returns {{ ctx: Record<string, any>, calls: Record<string, any[]> }} the fake context and the recorded calls.
 */
function replayCtx(options = {}) {
  const calls = { resumed: [], mounted: [], followups: [] }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          // The scan walks the whole roster; without this it has nothing to
          // look at and every assertion below would pass vacuously.
          listSessions: async () => options.sessions ?? [],
          observeSession: async () => ({
            events: options.events ?? [],
            projections: { values: options.projections ?? {} },
          }),
          // The cut-off criterion reads the FULL log; `observeSession` only
          // ever returns a seed view. Without this the criterion sees nothing
          // and a test can pass while the behaviour it claims to check never
          // happened.
          readSession: async () => ({ events: options.events ?? [] }),
        }
      }
      if (name === 'agents') {
        return {
          roots: () => [],
          get: (id) => options.live,
          resume: async (opts) => {
            calls.resumed.push(opts)
            if (options.resumeError !== undefined) throw options.resumeError
            // The real registry runs the setup hook on the agent's context.
            if (opts.setup !== undefined) await opts.setup({}, { id: opts.resumeSessionId })
            // A live agent and the one the resume returns are the SAME agent in
            // the real Host: the resume hands back the resident one. The scan
            // later looks the session up with `get`, so a double here would
            // hide a duplicate delivery.
            if (options.live !== undefined) return { agent: options.live }
            return {
              agent: {
                id: opts.resumeSessionId,
                status: 'idle',
                inbox: { nextTurn: [], nextStep: [] },
                session: { header: { id: opts.resumeSessionId, cwd: '/tmp' } },
                followup: (message) => calls.followups.push(message),
              },
            }
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default', model: 'default' }) }
      if (name === 'agentPresets') {
        return {
          resolve: async (id) => ({ id }),
          mount: async (_ctx, id) => {
            calls.mounted.push(id)
            if (options.mountFails === true) throw new Error('mount failed')
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
 * A temporary handoff directory plus the settings that point at it.
 * @returns {Promise<{ dir: string, settings: Record<string, any> }>} the fixture.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'restart-replay-'))
  return { dir, settings: { ...DEFAULTS, handoffDir: dir } }
}

test('a session another owner already resumed falls back to the live agent', async () => {
  const live = { id: 's1', followup: () => {} }
  const owned = new Error('already owned')
  owned.name = 'SessionAlreadyOwnedError'
  const { ctx } = replayCtx({ resumeError: owned, live })
  const agent = await resumeSession(ctx, 's1')
  assert.equal(agent, live)
})

test('a preset that cannot be mounted still returns the agent', async () => {
  const { ctx, calls } = replayCtx({ projections: { agentPreset: 'standard' }, mountFails: true })
  const agent = await resumeSession(ctx, 's1')
  assert.ok(agent !== undefined)
  assert.deepEqual(calls.mounted, ['standard'])
})

test('the session route comes from the session log', async () => {
  const events = [{ type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } }]
  const { ctx, calls } = replayCtx({ events })
  await resumeSession(ctx, 's1')
  assert.deepEqual(calls.resumed[0].agentOptions, { provider: 'p', model: 'm' })
})

test('without a handoff record nothing is resumed', async () => {
  const { dir, settings } = await fixture()
  const { ctx, calls } = replayCtx()
  await runHandoff(ctx, settings)
  assert.equal(calls.resumed.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('a stale handoff record is dropped, not replayed', async () => {
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's1',
    createdAt: Date.now() - (DEFAULTS.handoffTtlMs + 1000),
    createdByPid: 1,
  }), 'utf8')
  const { ctx, calls } = replayCtx()
  await runHandoff(ctx, settings)
  assert.equal(calls.resumed.length, 0)
  assert.equal(await readRecord(settings, HANDOFF_FILE), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a handoff record written by this very process is not replayed', async () => {
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's1',
    createdAt: Date.now(),
    createdByPid: process.pid,
  }), 'utf8')
  const { ctx, calls } = replayCtx()
  await runHandoff(ctx, settings)
  assert.equal(calls.resumed.length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('a pending confirmation never survives the restart', async () => {
  const { dir, settings } = await fixture()
  await writeFile(join(dir, PENDING_FILE), JSON.stringify({ createdAt: Date.now(), confirmation: 'x' }), 'utf8')
  const { ctx } = replayCtx()
  await runHandoff(ctx, settings)
  assert.equal(await readRecord(settings, PENDING_FILE), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('every session in the handoff is resumed and woken', async () => {
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's-init',
    sessions: [
      { id: 's-init', kind: 'initiator' },
      { id: 's-peer', kind: 'peer' },
    ],
    reason: 'because',
    continuePrompt: 'do the thing',
    resumeSubagents: false,
    createdAt: Date.now(),
    createdByPid: 1,
  }), 'utf8')
  const { ctx, calls } = replayCtx()
  await runHandoff(ctx, settings)
  assert.deepEqual(calls.resumed.map(call => call.resumeSessionId), ['s-init', 's-peer'])
  assert.equal(calls.followups.length, 2)
  assert.match(calls.followups[0].content[0].text, /do the thing/)
  const peerText = calls.followups[1].content[0].text
  assert.match(peerText, /continue the work that was in flight/)
  // The peer is told about ITSELF. A fact about the other conversations
  // belongs in the initiator's message, not in this session's transcript,
  // where it reads like a broadcast instead of an instruction.
  assert.doesNotMatch(peerText, /other running sessions/)
  assert.equal(await readRecord(settings, HANDOFF_FILE), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('the reason is not put into the model\'s message', async () => {
  // The reason is an operator's detail. It belongs in the log, not in the
  // instruction the model has to read — a parenthesis full of a sentence
  // like "the OneDrive manifest cache was widened from 64 to 256 entries"
  // tells the model nothing it can act on and crowds out what it can.
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's-init',
    sessions: [
      { id: 's-init', kind: 'initiator' },
      { id: 's-peer', kind: 'peer' },
    ],
    reason: 'because the manifest cache was widened from 64 to 256 entries',
    continuePrompt: 'do the thing',
    resumeSubagents: false,
    createdAt: Date.now(),
    createdByPid: 1,
  }), 'utf8')
  const { ctx, calls } = replayCtx()
  await runHandoff(ctx, settings)

  for (const followup of calls.followups) {
    const text = followup.content[0].text
    assert.match(text, /The Harness restarted\./, 'the message must still say what happened')
    assert.doesNotMatch(text, /because the manifest cache/, 'the reason must not reach the model')
    assert.doesNotMatch(text, /64 to 256/, 'not even a fragment of the reason')
  }
  await rm(dir, { recursive: true, force: true })
})

test('a teammate is woken once, by the Team path', async () => {
  const calls = { prompted: [], messaged: [] }
  const member = { id: 'm1', name: 'cap-models', role: 'teammate', status: 'inactive', diagnostics: [] }
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => ({ id: 's1' }) }
      // The teammate is genuinely cut off, so the generic path has every
      // reason to wake it: the ONLY thing that must keep it out is the Team
      // roster filter, not a read that happened to fail.
      if (name === 'sessionQuery') {
        return {
          readSession: async () => ({ events: [{ type: 'turn/start', data: { turn: 1 } }] }),
        }
      }
      if (name === 'subagents') {
        return {
          listDescendants: async () => [{ id: 'm1', mode: 'continuable', depth: 1, parentId: 's1', activity: 'running' }],
          prompt: async (request) => { calls.prompted.push(request) },
        }
      }
      if (name === 'agentTeams') {
        return {
          tryMembership: () => ({ role: 'lead' }),
          listMembers: () => [member],
          sendMessage: async (_lead, request) => { calls.messaged.push(request) },
        }
      }
      return undefined
    },
  }
  const record = { reason: 'because' }
  const { wakeSubagents, wakeTeamMembers } = internals
  await wakeSubagents(ctx, 's1', record)
  await wakeTeamMembers(ctx, { id: 's1' }, record)
  assert.equal(calls.prompted.length, 0, 'the generic path must skip a teammate')
  assert.equal(calls.messaged.length, 1, 'the Team path wakes the teammate exactly once')
  assert.equal(calls.messaged[0].target, 'cap-models')
})

test('an interrupted session is recovered on an unplanned exit', async () => {  const calls = { resumed: [], followups: [] }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ id: 's-crashed', header: { id: 's-crashed' }, live: false }],
          observeSession: async () => ({ events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }], projections: { values: {} } }),
          readSession: async () => ({ events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }] }),
        }
      }
      if (name === 'agents') {
        return {
          get: () => undefined,
          resume: async (opts) => {
            calls.resumed.push(opts)
            return { agent: { id: opts.resumeSessionId, followup: (m) => calls.followups.push(m), inbox: { nextTurn: [], nextStep: [] }, status: 'idle', session: { header: { id: opts.resumeSessionId } } } }
          },
        }
      }
      return undefined
    },
    sessionPersistence: { flush: async () => {} },
  }
  const { recoverUnplannedSessions } = internals
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, [])
  assert.deepEqual(recovered, ['s-crashed'])
  assert.equal(calls.resumed.length, 1)
  assert.match(calls.followups[0].content[0].text, /went down unexpectedly/)
})

test('a session the handoff already resumed is not recovered twice', async () => {
  const calls = { resumed: [] }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ id: 's-done', header: { id: 's-done' }, live: false }],
          observeSession: async () => ({ events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }], projections: { values: {} } }),
          readSession: async () => ({ events: [{ type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }] }),
        }
      }
      if (name === 'agents') return { get: () => undefined, resume: async (o) => { calls.resumed.push(o); return { agent: {} } } }
      return undefined
    },
  }
  const { recoverUnplannedSessions } = internals
  const recovered = await recoverUnplannedSessions(ctx, { ...DEFAULTS }, ['s-done'])
  assert.deepEqual(recovered, [])
  assert.equal(calls.resumed.length, 0)
})

test('a non-Lead session costs NO Team reconcile poll', async () => {
  // The recovery runs this for every live session. Polling the Team roster
  // first and asking who the agent is afterwards cost up to 5s per session:
  // measured, 20 live sessions never finished the scan within 60s.
  let polls = 0
  const ctx = {
    get(name) {
      if (name !== 'agentTeams') return undefined
      return {
        tryMembership: () => ({ role: 'teammate' }),
        listMembers: () => { polls += 1; return [{ role: 'teammate', status: 'provisioning', name: 't' }] },
        sendMessage: async () => {},
      }
    },
  }
  const { wakeTeamMembers } = internals
  const woken = await wakeTeamMembers(ctx, { id: 'not-a-lead' }, { reason: 'because' })
  assert.deepEqual(woken, [])
  assert.equal(polls, 0, 'a session that is not a Lead must not poll the roster at all')
})

test('a Lead with no surface roster still wakes its teammates', async () => {
  const sent = []
  let polls = 0
  const ctx = {
    get(name) {
      if (name !== 'agentTeams') return undefined
      return {
        tryMembership: () => ({ role: 'lead' }),
        listMembers: () => { polls += 1; return [{ role: 'teammate', status: 'inactive', name: 'tm1' }] },
        sendMessage: async (_lead, request) => { sent.push(request.target) },
      }
    },
  }
  const { wakeTeamMembers } = internals
  const woken = await wakeTeamMembers(ctx, { id: 'lead' }, { reason: 'because' })
  assert.deepEqual(woken, ['tm1'])
  assert.equal(polls, 1)
  assert.deepEqual(sent, ['tm1'])
})

test('wakeTeamMembers survives a missing lead handle', async () => {
  const ctx = { get: (name) => name === 'agentTeams' ? { tryMembership: () => ({ role: 'lead' }), listMembers: () => [] } : undefined }
  const { wakeTeamMembers } = internals
  assert.deepEqual(await wakeTeamMembers(ctx, undefined, { reason: 'because' }), [])
})

test('a handoff record naming no real session is dropped, not retried forever', async () => {
  // Observed in production: a record carrying the literal id "caller" was
  // re-attempted on every boot, throwing "session caller not found" and
  // replaying nothing. An unhonourable record must not survive.
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 'caller',
    sessions: [{ id: 'caller', kind: 'initiator' }],
    reason: 'because',
    continuePrompt: 'carry on',
    resumeSubagents: true,
    createdAt: Date.now(),
    createdByPid: 1,
  }), 'utf8')
  const ctx = {
    get(name) {
      if (name !== 'sessionQuery') return undefined
      return { observeSession: async () => { throw new Error('session "caller" not found') } }
    },
  }
  const resumed = await runHandoff(ctx, settings)
  assert.deepEqual(resumed.resumed, [])
  assert.deepEqual(resumed.nudged, [])
  assert.equal(await readRecord(settings, HANDOFF_FILE), undefined, 'the record must be gone')
  await rm(dir, { recursive: true, force: true })
})

test('a handoff record that resumes at least one session is kept to completion', async () => {
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's-good',
    sessions: [{ id: 's-good', kind: 'initiator' }],
    reason: 'because',
    continuePrompt: 'carry on',
    resumeSubagents: false,
    createdAt: Date.now(),
    createdByPid: 1,
  }), 'utf8')
  const { ctx, calls } = replayCtx()
  const resumed = await runHandoff(ctx, settings)
  // The result is the ledger the scan consults: which sessions were resumed,
  // which of them actually received their continue instruction, and which
  // children were woken with them.
  assert.deepEqual(resumed.resumed, ['s-good'])
  assert.deepEqual(resumed.nudged, ['s-good'])
  assert.deepEqual(resumed.children, [])
  assert.equal(calls.resumed.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('a planned restart delivers ONE continue instruction, not two', async () => {
  // The bug this covers: the replay resumes a session, which makes it LIVE,
  // and its log still shows the turn the replay is answering — the fresh turn
  // is not finished yet. The scan that runs afterwards therefore sees a live
  // session with an unclosed turn and wakes it AGAIN, so the user gets two
  // "continue" prompts for one restart. Observed in production.
  const { dir, settings } = await fixture()
  await writeFile(join(dir, HANDOFF_FILE), JSON.stringify({
    phase: 'prepared',
    sessionId: 's-planned',
    sessions: [{ id: 's-planned', kind: 'initiator' }],
    reason: 'because',
    continuePrompt: 'carry on',
    resumeSubagents: false,
    createdAt: Date.now(),
    createdByPid: 1,
  }), 'utf8')

  // One agent that serves both paths: the replay resumes it, and the scan
  // then finds it live. Its log keeps an unclosed turn the whole time, which
  // is what made the scan wake it a second time.
  const followups = []
  const agent = {
    id: 's-planned',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: { id: 's-planned', cwd: '/tmp' } },
    followup: (message) => followups.push(message),
  }
  const unclosed = [{
    type: 'turn/start',
    data: { turn: 1 },
  }]
  const { ctx, calls } = replayCtx({
    live: agent,
    events: unclosed,
    sessions: [{ id: 's-planned', header: { id: 's-planned' }, live: true }],
    projections: { values: {} },
  })

  // 1. the replay resumes it and delivers its instruction
  const ledger = await runHandoff(ctx, settings)
  assert.deepEqual(ledger.resumed, ['s-planned'])
  assert.deepEqual(ledger.nudged, ['s-planned'])
  const afterReplay = followups.length
  assert.equal(afterReplay, 1, 'the replay delivers the continue instruction once')

  // 2. the scan runs over the same session, now live, with the unclosed turn
  //    still in its log
  const { recoverUnplannedSessions } = internals
  const recovered = await recoverUnplannedSessions(ctx, { ...settings }, ledger)
  assert.deepEqual(recovered, [], 'the session is not recovered a second time')
  assert.equal(followups.length, afterReplay, 'the session is NOT told to continue twice')
  assert.equal(calls.resumed.length, 1, 'the session is not resumed twice')

  await rm(dir, { recursive: true, force: true })
})

test('a live session the handoff did NOT resume is still told to continue', async () => {
  // The other side of the same rule: a human who opened the conversation
  // right after the crash makes it live, and it was never nudged by the
  // replay. That one MUST get the instruction, or the work stays parked.
  const followups = []
  const agent = {
    id: 's-human',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: { id: 's-human', cwd: '/tmp' } },
    followup: (message) => followups.push(message),
  }
  const unclosed = [{ type: 'turn/start', data: { turn: 1 } }]
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => [{ id: 's-human', header: { id: 's-human' }, live: true }],
          observeSession: async () => ({ events: unclosed, projections: { values: {} } }),
          readSession: async () => ({ events: unclosed }),
        }
      }
      if (name === 'agents') return { get: (id) => (id === 's-human' ? agent : undefined), resume: async () => ({ agent }) }
      return undefined
    },
    sessionPersistence: { flush: async () => {} },
  }
  const { recoverUnplannedSessions } = internals
  await recoverUnplannedSessions(ctx, { ...DEFAULTS }, { resumed: [], nudged: [], children: [] })
  assert.equal(followups.length, 1, 'a live session nobody nudged must still be told to continue')
})
