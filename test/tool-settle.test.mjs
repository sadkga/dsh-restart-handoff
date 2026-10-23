import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { waitForToolProviders } = internals

test('the recovery waits for the tool providers to stop changing', async () => {
  // A session is handed the tool set that exists when it is resumed. Plugins
  // and MCP servers that register a moment later are missing from that first
  // turn, and the session's own transcript records them as removed.
  //
  // The wait watches the registry until it holds still. A registry that grows
  // and then settles is waited for; one that never settles is given up on
  // within the budget, and says so.
  let size = 3
  let registrations = 0
  const ctx = {
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { toolProviders: { get size() { return size } } }
    },
  }

  // Plugins register one after another and then stop — the shape of a Host
  // coming up, not a registry that grows forever.
  const growing = setInterval(() => {
    if (registrations >= 6) return
    size += 1
    registrations += 1
  }, 40)
  const observed = await waitForToolProviders(ctx, 2000)
  clearInterval(growing)

  assert.equal(observed.settled, true, 'the wait must notice the registry settled')
  assert.ok(observed.providers >= 9, `the growing registry must be seen, saw ${observed.providers}`)
  assert.ok(observed.waitedMs < 1500, `the wait must end as soon as it settles, took ${observed.waitedMs}ms`)
})

test('a Host that does not publish its registry is waited out, and says so', async () => {
  const ctx = { get: () => undefined }
  const observed = await waitForToolProviders(ctx, 120)
  assert.equal(observed.settled, false, 'without a registry nothing can be observed as settled')
  assert.ok(observed.waitedMs >= 100, 'the budget must still be waited out')
})

test('a registry that never changes is not waited out', async () => {
  const ctx = {
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return { toolProviders: { size: 7 } }
    },
  }
  const startedAt = Date.now()
  const observed = await waitForToolProviders(ctx, 5000)
  assert.equal(observed.settled, true)
  assert.equal(observed.providers, 7)
  assert.ok(Date.now() - startedAt < 4000, 'a stable registry must not cost the whole budget')
})
