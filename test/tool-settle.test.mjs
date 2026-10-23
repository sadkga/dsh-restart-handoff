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
      if (event !== 'system-prompt/change' && event !== 'tools/change') return
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    off(event, handler) {
      if (event !== 'system-prompt/change' && event !== 'tools/change') return
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

test('a tool registered late is waited for too', async () => {
  // The missing tools arrived through the tool REGISTRY, not the prompt
  // layers: waiting on `system-prompt/change` alone let the wait end while a
  // client's `registerTool` was still pending, and the resumed session came
  // up 18 tools short.
  const listeners = new Map()
  let fired = 0
  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  }
  // The late registrations arrive and then stop — the shape of a Host coming
  // up, not a registry that changes forever.
  const timer = setInterval(() => {
    fired += 1
    if (fired > 3) return
    const handler = listeners.get('tools/change')
    if (handler !== undefined) handler()
  }, 80)
  timer.unref?.()

  const observed = await waitForToolProviders(ctx, 3000)
  clearInterval(timer)

  assert.equal(observed.settled, true)
  assert.ok(observed.changes >= 3, `the tool-registry announcements must be seen, saw ${observed.changes}`)
})

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

test('the wait never throws when the Host refuses to be unsubscribed', async () => {
  // `ctx.off` needs an inject context and throws "cannot get property off
  // without inject" — and that exception, thrown from the wait, took the
  // whole recovery down with it: one restart resumed nothing at all. The
  // wait must survive a Host that will not let it unsubscribe.
  const ctx = {
    get: () => undefined,
    on() {
      throw new Error('cannot get property "off" without inject')
    },
  }
  const observed = await waitForToolProviders(ctx, 200)
  assert.equal(observed.settled, false, 'a Host that refuses the subscription cannot be watched')
  assert.ok(observed.waitedMs >= 150, 'the budget must still be waited out')
})
