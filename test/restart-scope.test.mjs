/**
 * What a restart brings back, what it leaves alone, and what it shows the
 * caller.
 *
 * The scope is "work in flight", never "open". Three ways a root is in
 * flight: it is running right now, it has a prompt queued that never started,
 * or one of its subagents is running — the last case is the one where the
 * parent itself is idle and only its child is busy. A session with nothing in
 * flight is not a target, an archived session is not a target, and the caller
 * always is.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { archivedIds, collectRestartTargets, createRestartTool, isResumableRoot } = internals

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
  }
}

/**
 * A host double.
 * @param {object[]} roots - the live roots.
 * @param {{ descendants?: Record<string, object[]>, archived?: string[] }} [options] - the rest.
 * @returns {Record<string, any>} the fake context.
 */
function ctxWith(roots, options = {}) {
  return {
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      if (name === 'subagents') return { listDescendants: async (id) => options.descendants?.[id] ?? [] }
      if (name === 'workspaceRegistry') {
        if (options.archived === undefined) return undefined
        return { get archivedSessionIds() { return options.archived } }
      }
      return undefined
    },
  }
}

test('scope: a root that is running is a target', async () => {
  const ctx = ctxWith([agent('caller'), agent('busy', { status: 'running' })])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller', 'busy'])
})

test('scope: a root with a queued prompt is a target', async () => {
  const ctx = ctxWith([agent('caller'), agent('queued', { nextTurn: 1 })])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller', 'queued'])
})

test('scope: an IDLE root whose subagent is running is a target', async () => {
  // The Lead itself is not running, but the work it delegated is. The parent
  // has to come back: it is the child's exact durable parent, and the child
  // cannot be cold-resumed without it.
  const descendants = { lead: [{ id: 'kid', parentId: 'lead', depth: 1, mode: 'one-shot', activity: 'running' }] }
  const ctx = ctxWith([agent('caller'), agent('lead')], { descendants })
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller', 'lead'])
})

test('scope: an IDLE root with an idle child is not a target', async () => {
  const descendants = { lead: [{ id: 'kid', parentId: 'lead', depth: 1, mode: 'one-shot', activity: 'inactive' }] }
  const ctx = ctxWith([agent('caller'), agent('lead')], { descendants })
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: an idle open root with nothing in flight is not a target', async () => {
  const ctx = ctxWith([agent('caller'), agent('open-but-idle')])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: an archived session is neither collected nor reported', async () => {
  const ctx = ctxWith([agent('caller'), agent('gone', { status: 'running' })], { archived: ['gone'] })
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: an archived session with a running child is still excluded', async () => {
  const descendants = { gone: [{ id: 'kid', parentId: 'gone', depth: 1, mode: 'one-shot', activity: 'running' }] }
  const ctx = ctxWith([agent('caller'), agent('gone')], { descendants, archived: ['gone'] })
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: the caller comes back even when it is the only session', async () => {
  const ctx = ctxWith([agent('caller')])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: the caller is never dropped as archived', async () => {
  const ctx = ctxWith([agent('caller'), agent('other', { status: 'running' })], { archived: ['caller', 'other'] })
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller'])
})

test('scope: resumeRunningSessions: false still narrows to the caller', async () => {
  const ctx = ctxWith([agent('caller'), agent('busy', { status: 'running' })])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller', { resumeRunningSessions: false }), ['caller'])
})

test('scope: without a workspace view the live registry still decides', async () => {
  const ctx = ctxWith([agent('caller'), agent('busy', { status: 'running' }), agent('idle')])
  assert.deepEqual(await collectRestartTargets(ctx, 'caller'), ['caller', 'busy'])
})

test('scope: the third criterion is the subagent activity, nothing else', async () => {
  const descendant = { id: 'kid', parentId: 'lead', depth: 1, activity: 'running' }
  const ctx = ctxWith([agent('lead')], { descendants: { lead: [descendant] } })
  assert.equal(await isResumableRoot(ctx, agent('lead')), true)
})

test('archive: the archive set is read from the registry getter', () => {
  const ctx = ctxWith([], { archived: ['a', 'b'] })
  assert.deepEqual([...(archivedIds(ctx) ?? [])].sort(), ['a', 'b'])
})

test('archive: no registry means no archive knowledge, not an empty archive', () => {
  assert.equal(archivedIds(ctxWith([])), undefined)
})

test('archive: a throwing getter is reported, not guessed', () => {
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { get archivedSessionIds() { throw new Error('registry not ready') } }
    },
  }
  assert.equal(archivedIds(ctx), undefined)
})

test('token: the rendered warning carries the confirmation token', async () => {
  const ctx = ctxWith([agent('caller'), agent('busy', { status: 'running' })])
  const tool = createRestartTool(ctx, {})
  const value = await tool.execute({ reason: 'because', continuePrompt: 'carry on' }, { agent: { id: 'caller' } })
  const rendered = tool.output.render({}, value)
  const text = rendered.map(part => part.text).join('\n')
  assert.ok(value.confirmToken.length > 0)
  assert.ok(text.includes(value.confirmToken), 'the token must reach the caller')
})

test('token: the rendered warning still shows the plan', async () => {
  const ctx = ctxWith([agent('caller'), agent('busy', { status: 'running' })])
  const tool = createRestartTool(ctx, {})
  const value = await tool.execute({ reason: 'because', continuePrompt: 'carry on' }, { agent: { id: 'caller' } })
  const text = tool.output.render({}, value).map(part => part.text).join('\n')
  assert.match(text, /because/)
  assert.match(text, /caller/)
  assert.match(text, /busy/)
})

test('token: a confirming call renders without inventing a new token', async () => {
  const ctx = ctxWith([agent('caller')])
  const tool = createRestartTool(ctx, { dryRun: true })
  const warning = await tool.execute({ reason: 'because', continuePrompt: 'carry on' }, { agent: { id: 'caller' } })
  const confirmed = await tool.execute(
    { reason: 'because', continuePrompt: 'carry on', confirmToken: warning.confirmToken },
    { agent: { id: 'caller' } },
  )
  const text = tool.output.render({}, confirmed).map(part => part.text).join('\n')
  assert.equal(confirmed.confirmToken, undefined)
  assert.ok(!text.includes(warning.confirmToken), 'a spent token must not be echoed back')
})
