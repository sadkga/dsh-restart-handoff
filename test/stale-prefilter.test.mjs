/**
 * The mtime pre-filter — the cheap "is this log even worth reading?" question.
 *
 * Reading a session log costs a full decompress-and-parse; a `stat` costs
 * nothing. Most candidates in a real store are long dead, so the scan decides
 * the stale window from the filesystem BEFORE it reads anything.
 *
 * The risk this file guards is silent: a pre-filter that skips a session the
 * durable rule would have kept is a lost conversation, and it fails without
 * an error. So the three things it depends on are each pinned here — the path
 * encoding finds the real file, the margin is conservative, and an unprovable
 * path falls through to the log instead of skipping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { internals } from '../index.js'

const { STALE_PRE_FILTER_SLACK_MS, encodeSegment, projectKey, staleByLogMtime } = internals

/**
 * A temporary session store, with DSH_HOME pointed at it.
 * @returns {Promise<{ dir: string, restore: () => void }>} the fixture.
 */
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'prefilter-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    },
  }
}

test('prefilter: the slack is a whole minute', () => {
  assert.equal(STALE_PRE_FILTER_SLACK_MS, 60 * 1000)
})

test('prefilter: an id passes through unchanged when it is already safe', () => {
  assert.equal(encodeSegment('session-70a1f6be'), 'session-70a1f6be')
})

test('prefilter: a space is escaped the way the persistence layer does it', () => {
  // The live store really has a project key with `~0020` for its space.
  assert.equal(encodeSegment('a b'), 'a~0020b')
})

test('prefilter: a tilde is escaped so it cannot be confused with an escape', () => {
  assert.equal(encodeSegment('a~b'), 'a~007Eb')
})

test('prefilter: dot segments are escaped rather than traversing', () => {
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('prefilter: a project key collapses the whole separator run', () => {
  assert.equal(projectKey('/home/user/project'), '--home-user-project--')
})

test('prefilter: a trailing separator does not add a second dash', () => {
  assert.equal(projectKey('/home/user/'), '--home-user--')
})

test('prefilter: the drive colon does not become its own dash', () => {
  assert.equal(projectKey('C:\\\\work'), '--C-work--')
})

test('prefilter: a space in the project path uses the ~0020 escape', () => {
  // "/home/sadkga/AI/Deepseek Harness" is the live shape.
  assert.equal(projectKey('/home/sadkga/AI/Deepseek Harness'), '--home-sadkga-AI-Deepseek~0020Harness--')
})

test('prefilter: an empty cwd still produces a usable key', () => {
  assert.equal(projectKey(''), '--root--')
})

test('prefilter: a fresh log is NOT stale', async () => {
  const { dir, restore } = await store()
  try {
    const sessionDir = join(dir, 'sessions', projectKey('/work'), encodeSegment('s1'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
    const verdict = await staleByLogMtime('s1', '/work', Date.now(), 60 * 60 * 1000)
    assert.equal(verdict.stale, false)
    assert.equal(typeof verdict.mtime, 'number')
  } finally { restore(); await rm(dir, { recursive: true, force: true }) }
})

test('prefilter: a log far outside the window IS stale', async () => {
  const { dir, restore } = await store()
  try {
    const sessionDir = join(dir, 'sessions', projectKey('/work'), encodeSegment('s1'))
    await mkdir(sessionDir, { recursive: true })
    const file = join(sessionDir, 'session.v4.jsonl.zstd')
    await writeFile(file, 'x')
    const old = (Date.now() - 10 * 60 * 60 * 1000) / 1000
    await utimes(file, old, old)
    const verdict = await staleByLogMtime('s1', '/work', Date.now(), 60 * 60 * 1000)
    assert.equal(verdict.stale, true)
  } finally { restore(); await rm(dir, { recursive: true, force: true }) }
})

test('prefilter: a log just inside the slack is NOT stale', async () => {
  // The margin is what keeps the filter conservative: a log whose mtime sits
  // a few seconds inside the boundary must still be read.
  const { dir, restore } = await store()
  try {
    const sessionDir = join(dir, 'sessions', projectKey('/work'), encodeSegment('s1'))
    await mkdir(sessionDir, { recursive: true })
    const file = join(sessionDir, 'session.v4.jsonl.zstd')
    await writeFile(file, 'x')
    const maxAgeMs = 60 * 60 * 1000
    // Just beyond the window, but within the slack: must NOT be skipped.
    const at = (Date.now() - maxAgeMs - 1000) / 1000
    await utimes(file, at, at)
    const verdict = await staleByLogMtime('s1', '/work', Date.now(), maxAgeMs)
    assert.equal(verdict.stale, false, 'the slack must absorb a boundary-adjacent log')
  } finally { restore(); await rm(dir, { recursive: true, force: true }) }
})

test('prefilter: an unknown path is never stale, so the log still decides', async () => {
  const { dir, restore } = await store()
  try {
    const verdict = await staleByLogMtime('does-not-exist', '/work', Date.now(), 1)
    assert.equal(verdict.stale, false, 'no proof must never mean skip')
    assert.equal(verdict.mtime, undefined)
  } finally { restore(); await rm(dir, { recursive: true, force: true }) }
})

test('prefilter: the uncompressed log name is found too', async () => {
  const { dir, restore } = await store()
  try {
    const sessionDir = join(dir, 'sessions', projectKey('/work'), encodeSegment('s1'))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl'), 'x')
    const verdict = await staleByLogMtime('s1', '/work', Date.now(), 60 * 60 * 1000)
    assert.equal(verdict.stale, false)
    assert.equal(typeof verdict.mtime, 'number')
  } finally { restore(); await rm(dir, { recursive: true, force: true }) }
})
