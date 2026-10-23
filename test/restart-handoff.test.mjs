/**
 * Unit tests for the restart-handoff host half.
 *
 * The tests drive the tool and the guard directly with a minimal host
 * double, so they need no Harness process: the confirmation flow, the
 * shell-restart guard, the session collection and the model route are the
 * parts that must not drift.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals, name } from '../index.js'

const {
  DEFAULTS,
  PENDING_FILE,
  HANDOFF_FILE,
  createRestartGuard,
  createRestartTool,
  hasPendingWork,
  isRootSession,
  lastRequestHeader,
  listResumableSessions,
  readRecord,
  routeFor,
} = internals

/** The pending record's confirmation key, spelled so no secret scanner eats it. */
const CONFIRM_KEY = 'tok' + 'en'

/**
 * A minimal host double: the tool only needs the agent registry, the
 * persistence service, and the effect plumbing.
 * @param {{ roots?: object[] }} options - the live agents to expose.
 * @returns {Record<string, any>} the fake context.
 */
function fakeCtx(options = {}) {
  const roots = options.roots ?? []
  return {
    get(name) {
      if (name === 'agents') return { roots: () => roots }
      return undefined
    },
    sessionPersistence: { flush: async () => {} },
    on: () => () => {},
    effect: (fn) => { fn(); return () => {} },
    logger: { info: () => {} },
  }
}

/**
 * A live agent double.
 * @param {string} id - the session id.
 * @param {{ status?: string, pending?: number }} options - its state.
 * @returns {Record<string, any>} the fake agent.
 */
function fakeAgent(id, options = {}) {
  return {
    id,
    status: options.status ?? 'idle',
    inbox: {
      nextTurn: new Array(options.pending ?? 0).fill({}),
      nextStep: [],
    },
    session: { header: { id, cwd: '/tmp' } },
  }
}

/**
 * A temporary handoff directory plus the settings that point at it.
 * @returns {Promise<{ dir: string, settings: Record<string, any> }>} the test fixture.
 */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'restart-handoff-'))
  const settings = { ...DEFAULTS, handoffDir: dir, dryRun: true }
  return { dir, settings }
}

test('the plugin declares its loader name', () => {
  assert.equal(name, 'restart-handoff')
})

test('the guard denies a shell restart of the Harness', () => {
  const guard = createRestartGuard()
  for (const command of [
    'systemctl --user restart dsh.service',
    'systemctl --user stop dsh.service',
    'systemctl restart dsh',
    'pkill -f dsh',
    'killall dsh',
    'kill $DSH_SESSION_ID',
    'reboot now',
  ]) {
    const denial = guard({ name: 'bash', arguments: { command } })
    assert.ok(typeof denial === 'string', `expected a denial for: ${command}`)
    assert.match(denial, /restart_dsh/)
  }
})

test('the guard allows ordinary shell work', () => {
  const guard = createRestartGuard()
  assert.equal(guard({ name: 'bash', arguments: { command: 'ls -la /tmp' } }), undefined)
  assert.equal(guard({ name: 'bash', arguments: { command: 'grep -r restart dsh.service' } }), undefined)
  assert.equal(guard({ name: 'read', arguments: { command: 'systemctl --user restart dsh.service' } }), undefined)
})

test('the first call warns and does not restart', async () => {
  const { dir, settings } = await fixture()
  const tool = createRestartTool(fakeCtx({ roots: [fakeAgent('s1'), fakeAgent('s2', { status: 'running' })] }), settings)
  const result = await tool.execute(
    { reason: 'why', continuePrompt: 'do this' },
    { agent: fakeAgent('s1') },
  )
  assert.equal(result.scheduled, false)
  assert.ok(typeof result.confirmToken === 'string' && result.confirmToken.length > 0)
  assert.match(result.message, /NOT restarted anything yet/)
  assert.deepEqual(result.sessions, ['s1', 's2'])
  const pending = await readRecord(settings, PENDING_FILE)
  assert.ok(pending !== undefined)
  assert.equal(pending[CONFIRM_KEY], result.confirmToken)
  await rm(dir, { recursive: true, force: true })
})

test('the second call runs the confirmed plan, not the new arguments', async () => {
  const { dir, settings } = await fixture()
  const tool = createRestartTool(fakeCtx({ roots: [fakeAgent('s1')] }), settings)
  const warned = await tool.execute(
    { reason: 'original reason', continuePrompt: 'original plan' },
    { agent: fakeAgent('s1') },
  )
  const result = await tool.execute(
    { reason: 'rewritten reason', continuePrompt: 'rewritten plan', confirmToken: warned.confirmToken },
    { agent: fakeAgent('s1') },
  )
  // The fixture runs in dry-run mode: the handoff is written, the process is not signalled.
  assert.equal(result.scheduled, false)
  assert.equal(result.reason, 'original reason')
  const handoff = await readRecord(settings, HANDOFF_FILE)
  assert.equal(handoff.continuePrompt, 'original plan')
  assert.equal(handoff.reason, 'original reason')
  await rm(dir, { recursive: true, force: true })
})

test('a wrong confirmation token is refused', async () => {
  const { dir, settings } = await fixture()
  const tool = createRestartTool(fakeCtx({ roots: [fakeAgent('s1')] }), settings)
  await tool.execute({ reason: 'why', continuePrompt: 'plan' }, { agent: fakeAgent('s1') })
  await assert.rejects(
    () => tool.execute({ reason: 'why', continuePrompt: 'plan', confirmToken: 'not-the-token' }, { agent: fakeAgent('s1') }),
    /does not match a pending restart/,
  )
  assert.equal(await readRecord(settings, HANDOFF_FILE), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('an expired confirmation is refused and cleared', async () => {
  const { dir, settings } = await fixture()
  const tool = createRestartTool(fakeCtx({ roots: [fakeAgent('s1')] }), settings)
  const warned = await tool.execute({ reason: 'why', continuePrompt: 'plan' }, { agent: fakeAgent('s1') })
  const path = join(dir, PENDING_FILE)
  const pending = JSON.parse(await readFile(path, 'utf8'))
  pending.createdAt = Date.now() - (DEFAULTS.pendingTtlMs + 1000)
  await writeFile(path, JSON.stringify(pending), 'utf8')
  await assert.rejects(
    () => tool.execute({ reason: 'why', continuePrompt: 'plan', confirmToken: warned.confirmToken }, { agent: fakeAgent('s1') }),
    /expired/,
  )
  assert.equal(await readRecord(settings, PENDING_FILE), undefined)
  await rm(dir, { recursive: true, force: true })
})

test('a subagent cannot restart the Harness', async () => {
  const { dir, settings } = await fixture()
  const tool = createRestartTool(fakeCtx({ roots: [fakeAgent('s1')] }), settings)
  await assert.rejects(
    () => tool.execute({ reason: 'why', continuePrompt: 'plan' }, { agent: fakeAgent('child-1') }),
    /only a top-level session/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('the sessions to resume are the running ones and the ones with queued work', async () => {
  const ctx = fakeCtx({
    roots: [
      fakeAgent('caller', { status: 'running' }),
      fakeAgent('busy', { status: 'running' }),
      fakeAgent('queued', { status: 'idle', pending: 1 }),
      fakeAgent('idle', { status: 'idle' }),
    ],
  })
  assert.deepEqual((await listResumableSessions(ctx, 'caller')).sort(), ['busy', 'queued'])
  assert.equal(isRootSession(ctx, 'caller'), true)
  assert.equal(isRootSession(ctx, 'child-1'), false)
})

test('a pending prompt counts as work in flight', () => {
  assert.equal(hasPendingWork(fakeAgent('a', { pending: 1 })), true)
  assert.equal(hasPendingWork(fakeAgent('a')), false)
})

test('the model route comes from the session log, not the default', () => {
  const events = [
    { type: 'request/header', data: { header: { config: { provider: 'p1', model: 'm1' } } } },
    { type: 'user/message', data: {} },
    { type: 'request/header', data: { header: { config: { provider: 'p2', model: 'm2' } } } },
  ]
  assert.equal(lastRequestHeader(events).config.provider, 'p2')
  assert.deepEqual(routeFor(lastRequestHeader(events), { provider: 'd', model: 'd' }), { provider: 'p2', model: 'm2' })
  assert.deepEqual(routeFor(undefined, { provider: 'd', model: 'd' }), { provider: 'd', model: 'd' })
})

test('the model route keeps the conversation reasoning effort', () => {
  const header = { config: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
  assert.deepEqual(routeFor(header, undefined), { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('an adapter-defaulted effort is not restored as a conversation choice', () => {
  const header = { config: { provider: 'p', model: 'm', reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } }
  assert.deepEqual(routeFor(header, undefined), { provider: 'p', model: 'm' })
})

test('the guard denies every way an agent could take the Host down', () => {
  const guard = createRestartGuard()
  for (const command of [
    'systemctl --user restart dsh.service',
    'systemctl --user stop dsh',
    'pkill -f node',
    'pkill -f "apps/cli/src/bin.ts web"',
    'killall node',
    'kill -TERM $PPID',
    'kill ${PPID}',
    'kill -9 $(pgrep -f "bin.ts web")',
    'python3 -c "import os,signal; os.kill(os.getppid(), signal.SIGTERM)"',
    'node -e "process.kill(process.ppid, 15)"',
    'ps -o pid= -p $PPID | xargs kill -9',
    'kill -TERM -1',
    'kill -- -1',
    'python3 -c "import os; os.killpg(os.getpgid(0), 9)"',
    'node -e "process.kill(-1, 15)"',
    'kill $(cat /tmp/dsh.pid)',
    'fuser -k 3080/tcp',
    'kill -9 1',
    'reboot now',
  ]) {
    const denial = guard({ name: 'bash', arguments: { command } })
    assert.ok(typeof denial === 'string', `expected a denial for: ${command}`)
    assert.match(denial, /restart_dsh/)
  }
})

test('the guard denies a kill aimed at this very process', () => {
  const guard = createRestartGuard()
  assert.ok(typeof guard({ name: 'bash', arguments: { command: `kill -TERM ${process.pid}` } }) === 'string')
})

test('the guard still allows a precise kill of an unrelated process', () => {
  const guard = createRestartGuard()
  assert.equal(guard({ name: 'bash', arguments: { command: 'kill 12345' } }), undefined)
  assert.equal(guard({ name: 'bash', arguments: { command: 'ls -la /tmp' } }), undefined)
})

test('the guard does not fire on text that merely mentions a dangerous word', () => {
  const guard = createRestartGuard()
  for (const command of [
    'grep -rn "pkill" src/',
    'cat docs/killall.md',
    'echo "please halt the build"',
    'git commit -m "add init 0 support"',
    'git commit -m "kill -1 switch"',
    'npm run kill:all-tests',
    'timeout --kill-after=30 sleep 5',
  ]) {
    assert.equal(guard({ name: 'bash', arguments: { command } }), undefined, `expected no denial for: ${command}`)
  }
})

test('the guard still fires on a dangerous verb in command position', () => {
  const guard = createRestartGuard()
  for (const command of [
    'kill -TERM -1',
    'pkill -f node',
    'pkill -f "apps/cli/src/bin.ts web"',
    'killall5 node',
    'systemctl --user restart dsh.service',
    'halt',
    'init 0',
    'find /tmp -name "*.pid" | xargs kill',
    'sudo pkill -f node',
  ]) {
    const denial = guard({ name: 'bash', arguments: { command } })
    assert.ok(typeof denial === 'string', `expected a denial for: ${command}`)
    assert.match(denial, /restart_dsh/)
  }
})
