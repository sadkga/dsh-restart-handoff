import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { waitForToolProviders } = internals

/**
 * A context that announces prompt-registry changes the way the Host does.
 * @param {{ emitAfterMs?: number, times?: number }} plan - when to announce.
 * @returns {{ ctx: object, changes: () => number, stop: () => void }} the context, a counter and a stopper.
 */
function announceCtx(plan = {}) {
  const listeners = new Set()
  let changes = 0
  const ctx = {
    on(event, handler) {
      if (event !== 'system-prompt/change') return
      listeners.add(handler)
    },
    off(event, handler) {
      if (event !== 'system-prompt/change') return
      listeners.delete(handler)
    },
  }
  const times = plan.times ?? 3
  let fired = 0
  const timer = setInterval(() => {
    if (fired >= times) return
    fired += 1
    changes += 1
    for (const handler of listeners) handler()
  }, plan.emitAfterMs ?? 60)
  timer.unref?.()
  return { ctx, changes: () => changes, stop: () => clearInterval(timer) }
}

test('the recovery waits for the prompt registry to go quiet', async () => {
  // A session is handed the tool set that exists when it is resumed. Plugins
  // and MCP servers that register a moment later are missing from that first
  // turn, and the session's own transcript records them as removed.
  //
  // The Host announces every change with `system-prompt/change`; the wait
  // listens and resumes once the announcements stop.
  const { ctx, changes, stop } = announceCtx({ times: 3, emitAfterMs: 60 })
  const observed = await waitForToolProviders(ctx, 3000)
  stop()

  assert.equal(observed.settled, true, 'the wait must notice the registry settled')
  assert.ok(observed.changes >= 3, `the announcements must be seen, saw ${observed.changes}`)
  assert.ok(observed.waitedMs < 1500, `the wait must end as soon as it settles, took ${observed.waitedMs}ms`)
})

test('a registry that never changes is not waited out', async () => {
  const { ctx, stop } = announceCtx({ times: 0 })
  const startedAt = Date.now()
  const observed = await waitForToolProviders(ctx, 5000)
  stop()
  assert.equal(observed.settled, true)
  assert.equal(observed.changes, 0)
  assert.ok(Date.now() - startedAt < 4000, 'a quiet registry must not cost the whole budget')
})

test('a Host that announces nothing is waited out, and says so', async () => {
  // No `system-prompt/change` at all: the wait cannot see anything, so it
  // must run out its budget and report that it did not settle — rather than
  // pretending the registry was quiet.
  const ctx = { get: () => undefined }
  const startedAt = Date.now()
  const observed = await waitForToolProviders(ctx, 300)
  assert.equal(observed.settled, false, 'without announcements nothing can be seen as settled')
  assert.ok(Date.now() - startedAt >= 250, 'the budget must still be waited out')
})
