/**
 * The plugin's own lifecycle: `apply` must load, register and wire.
 *
 * This file exists because of the accident it guards against: the plugin's
 * module evaluated fine and every tool call still exploded, because a symbol
 * the body referenced was not defined anywhere. `apply` is the one function
 * that touches every other one, so it is the right place to prove that the
 * whole bundle hangs together.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, internals, name } from '../index.js'

/**
 * A host double that records what the plugin registers.
 * @param {{ registerThrows?: boolean }} [options] - the doubles' behaviour.
 * @returns {{ ctx: Record<string, any>, recorded: Record<string, any> }} the fake context and what it recorded.
 */
function hostDouble(options = {}) {
  const recorded = { tools: [], guards: [], sections: [] }
  const ctx = {
    tools: {
      register(definition) {
        if (options.registerThrows === true) throw new Error('registration refused')
        recorded.tools.push(definition)
        return () => {}
      },
      guard(guard) {
        recorded.guards.push(guard)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        recorded.sections.push(section)
        return () => {}
      },
    },
    get() {
      return undefined
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { info: () => {} },
    sessionPersistence: { flush: async () => {} },
  }
  return { ctx, recorded }
}

/**
 * A temporary handoff directory.
 * @returns {Promise<string>} the directory.
 */
async function tempDir() {
  return await mkdtemp(join(tmpdir(), 'restart-lifecycle-'))
}

test('the plugin declares the name and the services it needs', () => {
  assert.equal(name, 'restart-handoff')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('agents'))
})

test('apply registers the restart tool', async () => {
  const dir = await tempDir()
  const { ctx, recorded } = hostDouble()
  apply(ctx, { handoffDir: dir })
  assert.equal(recorded.tools.length, 1)
  assert.equal(recorded.tools[0].name, 'restart_dsh')
  await rm(dir, { recursive: true, force: true })
})

test('the registered tool is a complete tool definition', async () => {
  const dir = await tempDir()
  const { ctx, recorded } = hostDouble()
  apply(ctx, { handoffDir: dir })
  const tool = recorded.tools[0]
  assert.equal(typeof tool.description, 'string')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['confirmToken', 'continuePrompt', 'reason', 'resumeSubagents'])
  // The registry rejects a tool without an output schema and a renderer.
  assert.equal(typeof tool.output.schema, 'object')
  assert.equal(typeof tool.output.render, 'function')
  await rm(dir, { recursive: true, force: true })
})

test('apply installs the shell-restart guard', async () => {
  const dir = await tempDir()
  const { ctx, recorded } = hostDouble()
  apply(ctx, { handoffDir: dir })
  assert.equal(recorded.guards.length, 1)
  const denial = recorded.guards[0]({ name: 'bash', arguments: { command: 'systemctl --user restart dsh.service' } })
  assert.equal(typeof denial, 'string')
  await rm(dir, { recursive: true, force: true })
})

test('apply adds the system prompt section', async () => {
  const dir = await tempDir()
  const { ctx, recorded } = hostDouble()
  apply(ctx, { handoffDir: dir })
  assert.equal(recorded.sections.length, 1)
  assert.equal(recorded.sections[0].name, 'restart-handoff')
  assert.match(recorded.sections[0].text, /restart_dsh/)
  await rm(dir, { recursive: true, force: true })
})

test('apply does not throw when the tool registration is refused', async () => {
  const dir = await tempDir()
  const { ctx, recorded } = hostDouble({ registerThrows: true })
  // The guard and the prompt section must survive a refused registration:
  // the plugin is more than its tool.
  apply(ctx, { handoffDir: dir })
  assert.equal(recorded.tools.length, 0)
  assert.equal(recorded.guards.length, 1)
  assert.equal(recorded.sections.length, 1)
  await rm(dir, { recursive: true, force: true })
})

test('the plugin loads without a configuration row', async () => {
  const { ctx, recorded } = hostDouble()
  apply(ctx)
  assert.equal(recorded.tools.length, 1)
  assert.equal(recorded.guards.length, 1)
})

test('every symbol the internals export is defined', () => {
  for (const [key, value] of Object.entries(internals)) {
    assert.notEqual(value, undefined, `internals.${key} is undefined`)
  }
})

test('the internals export the whole contract', () => {
  for (const key of [
    'createRestartGuard', 'createRestartTool', 'hasPendingWork', 'isRootSession',
    'listResumableSessions', 'lastRequestHeader', 'routeFor', 'readRecord',
    'writeRecord', 'clearRecord', 'runHandoff', 'resumeSession',
    'recoverUnplannedSessions', 'wakeSubagents', 'wakeTeamMembers', 'teamMemberIds',
  ]) {
    assert.equal(typeof internals[key], 'function', `internals.${key} must be a function`)
  }
})
