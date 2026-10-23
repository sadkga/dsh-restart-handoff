import { join as pathJoin } from 'node:path'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, rename as fsRename, rm as fsRm } from 'node:fs/promises'
/**
 * Host half of the restart-handoff bundle.
 *
 * The model restarts the Harness through ONE tool — `restart_dsh` — and never
 * through a shell command. The tool takes two steps: the first call only
 * warns and hands back a confirmation token, the second call with that token
 * performs the restart. The restart itself writes a handoff record, lets the
 * current turn finish, and signals this process; the unit's `Restart=always`
 * brings a fresh process up, and the fresh process replays the handoff:
 * every session that was running is resumed and woken, the continuable
 * subagents are woken again, and the pending instruction is handed to the
 * agent that asked for the restart.
 *
 * ## Why the model never touches systemctl
 *
 * `systemctl --user restart dsh.service` from inside the service is a bad idea:
 * the command would be killed mid-flight by the very stop it asks for, and it
 * needs the user D-Bus session, which the Host process is not guaranteed to
 * have. Signalling this process with SIGTERM is equivalent — the CLI drains
 * in-flight work and exits 0, and the supervisor relaunches the unit, so no
 * process can be left orphaned if the relaunch fails. The handoff record is
 * what turns "the process died" into "the work continued".
 *
 * The `bash`/`pwsh` guard below closes the other door: a model that shells out
 * to restart the Harness directly loses its turn, its tool result, and its
 * session. The tool exists so that path is impossible.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Plugin name the loader and the inventory show. */







function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text: String(text) }] }
}
function handoffDir(settings) {
  return settings?.handoffDir ?? pathJoin(process.env.DSH_HOME ?? process.cwd(), 'restart')
}
export const name = 'restart-handoff'

/**
 * The services this half needs. `subagents` and `agentTeams` are optional and
 * resolved at call time: a profile without delegation still restarts and
 * resumes its sessions.
 */
export const inject = ['tools', 'agents', 'sessions', 'sessionPersistence', 'sessionQuery', 'systemPrompt', 'agentDefaultModel']

/** Default settings; the profile's patch row overrides any of them. */
const DEFAULTS = {
  /** systemd user unit that supervises this process. */
  serviceUnit: 'dsh.service',
  /** Where the handoff record lives. Defaults to `$DSH_HOME/restart`. */
  handoffDir: undefined,
  /** Resume the sessions automatically after a restart. */
  autoResume: true,
  /** Wake the continuable subagents again after the resume. */
  resumeSubagents: true,
  /** Also resume the other sessions that were running when the restart started. */
  resumeRunningSessions: true,
  /** How long the tool waits for the current turn to go idle before signalling. */
  idleTimeoutMs: 30_000,
  /** A handoff record older than this is stale and is not replayed. */
  handoffTtlMs: 30 * 60 * 1000,
  /** A confirmation token older than this is refused. */
  pendingTtlMs: 5 * 60 * 1000,
  /** How old an interrupted session may be and still be recovered. */
  recoverMaxAgeMs: 2 * 60 * 60 * 1000,
  /** How many interrupted sessions one start may recover. */
  recoverMaxSessions: 50,
  /** Write the handoff record but never signal this process. */
  dryRun: false,
}

/** File name of the handoff record inside the handoff directory. */
const HANDOFF_FILE = 'handoff.json'

/** File name of the pending-confirmation record inside the handoff directory. */
const PENDING_FILE = 'pending.json'

/**
 * Shell commands that would restart the Harness behind the tool's back. The
 * guard turns them into a denial that names the tool to use instead.
 */
/**
 * Patterns that match a kill written inside a script, wherever it sits.
 * These are not commands of their own, so they are matched as text.
 */
const TEXT_RESTART_PATTERNS = [
  /\bos\.kill\s*\(\s*os\.getppid/i,
  /\bos\.killpg\b/,
  /\bprocess\.kill\s*\(\s*process\.p{1,2}id/i,
  /\bprocess\.kill\s*\(\s*-1\b/,
  /\bkill\b[^\n]*\$\(\s*cat\b[^)]*pid/i,
]

/** Verbs that kill processes; what they aim at only matters inside them. */
const KILL_VERBS = new Set(['kill', 'pkill', 'killall', 'killall5'])

/** Verbs that are dangerous whatever they are aimed at. */
/** Verbs that are dangerous whatever they are aimed at. */
const ALWAYS_DANGEROUS = new Set(['halt', 'init', 'telinit', 'reboot', 'shutdown', 'poweroff', 'taskkill', 'stop-process'])

/** Verbs that can take the Host down when they start a command. */
const DANGEROUS_VERBS = new Set([
  'kill', 'pkill', 'killall', 'killall5', 'systemctl', 'service', 'supervisorctl', 'docker', 'fuser',
])

/** Words that may sit in front of the real command. */
const COMMAND_PREFIXES = new Set(['sudo', 'nohup', 'env', 'time', 'nice', 'doas', 'exec', 'command', 'xargs'])

/** Wrapper options that take a value. */
const VALUE_OPTIONS = new Set(['-u', '-g', '-U', '--user', '--group', '-p', '-n', '-i', '-c', '--chdir'])

/** Interpreters: their payload is code, so it is parsed recursively. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'python', 'python3', 'perl', 'node', 'ruby', 'eval'])

/** Details that make a dangerous verb dangerous on this machine. */
const DANGEROUS_DETAILS = [
  /dsh|bin\.ts|deepseek-harness/i,
  /\b(node|electron|java|bun|deno)\b/i,
  /(--\s*)?-1\b/,
  /\s-9\s+1\b/,
  /\$\{?PPID\}?/,
  /\bDSH_(SESSION_ID|HOME|PROFILE)\b/,
  /\$\(/,
]

/** Actions that make a service manager dangerous. */
const SERVICE_ACTIONS = /\b(restart|stop|kill|reload|disable|halt)\b/i

/**
 * The command a segment runs, with the wrappers peeled off.
 * @param {string} segment - one segment of a command line.
 * @returns {{ word: string, viaXargs: boolean }} the verb and whether xargs carried it.
 */
function headVerb(segment) {
  const tokens = segment.split(/\s+/)
  let index = 0
  let viaXargs = false
  while (index < tokens.length) {
    const token = tokens[index]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue }
    const lower = token.toLowerCase()
    if (lower === 'xargs') { viaXargs = true; index += 1; continue }
    if (COMMAND_PREFIXES.has(lower)) { index += 1; continue }
    if (token.startsWith('-')) {
      index += 1
      if (VALUE_OPTIONS.has(token) && index < tokens.length) index += 1
      continue
    }
    break
  }
  const word = (tokens[index] ?? '').split('/').pop().toLowerCase()
  return { word, viaXargs }
}

/**
 * The dangerous commands in a command line.
 *
 * A command line is split at the shell separators. A segment counts only when
 * it actually STARTS a dangerous verb and that verb is aimed at this machine:
 * a commit message mentioning "kill -1" is not a kill. An interpreter segment
 * is parsed recursively, because its payload is the real command.
 * @param {string} command - the command text.
 * @param {number} depth - recursion depth for interpreter payloads.
 * @returns {string[]} the dangerous segments.
 */
function dangerousSegments(command, depth = 0) {
  const found = []
  for (const raw of String(command).split(/[;&|\n]+/)) {
    const segment = raw.trim()
    if (segment === '') continue
    const { word, viaXargs } = headVerb(segment)
    if (viaXargs && /\b(kill|pkill|killall5?)\b/.test(segment)) { found.push(segment); continue }
    if (ALWAYS_DANGEROUS.has(word)) { found.push(segment); continue }
    if (INTERPRETERS.has(word) && depth < 2) {
      for (const quoted of segment.matchAll(/'([^']*)'|"([^"]*)"/g)) {
        const payload = quoted[1] ?? quoted[2] ?? ''
        if (payload !== '') found.push(...dangerousSegments(payload, depth + 1))
      }
      continue
    }
    if (!DANGEROUS_VERBS.has(word)) continue
    if (word === 'fuser') {
      if (/\s-k\s/.test(segment)) found.push(segment)
      continue
    }
    if ((word === 'systemctl' || word === 'service' || word === 'supervisorctl' || word === 'docker')
      && !SERVICE_ACTIONS.test(segment)) continue
    if (DANGEROUS_DETAILS.some(detail => detail.test(segment))) found.push(segment)
  }
  return found
}

/**
 * Every string inside an argument tree.
 * @param {unknown} value - the parsed tool arguments.
 * @returns {string[]} the strings found.
 */
function collectStrings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(collectStrings)
  return []
}

/**
 * The guard that keeps shell restarts out of the model's hands.
 *
 * It scans the arguments of EVERY tool, not only the shell ones: a tool that
 * can run code can also kill the Host, and the model's way in is not the point
 * — the restart has to go through the tool that records the handoff.
 * @returns {(execution: Readonly<{ name: string, arguments?: unknown }>) => string | undefined} the guard.
 */
function createRestartGuard() {
  return (execution) => {
    if (execution?.name === 'restart_dsh') return undefined
    for (const text of collectStrings(execution?.arguments)) {
      if (isSelfKill(text)) return RESTART_DENIAL
      if (TEXT_RESTART_PATTERNS.some(pattern => pattern.test(text))) return RESTART_DENIAL
      if (dangerousSegments(text).length > 0) return RESTART_DENIAL
    return undefined
  }
}


}



function isSelfKill(command) {
  for (const raw of splitSegments(String(command))) {
    const segment = raw.trim()
    if (segment === '') continue
    const words = tokenize(segment)
    if (words.length === 0) continue
    const { word } = headVerb(words)
    if (!KILL_VERBS.has(word)) continue
    if (isHostPidIn(words)) return true
    if (/\$\{?PPID\}?/i.test(segment)) return true
  }
  return false
}

/**
 * The command text a shell-like tool carries.
 * @param {unknown} args - the tool's arguments.
 * @returns {string | undefined} the command, when there is one.
 */
function commandOf(args) {
  if (args === null || typeof args !== 'object') return undefined
  const record = /** @type {Record<string, unknown>} */ (args)
  for (const key of ['command', 'script', 'input', 'text', 'cmd']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Every string inside a tool's arguments.
 *
 * The arguments of a tool call are a losslessly JSON-serializable tree, so
 * walking it finds a command that was smuggled through any channel: a shell
 * tool's command, a `run_code` program, a plugin tool's own payload.
 * @param {unknown} value - the arguments.
 * @param {number} depth - how deep the walk already went.
 * @returns {string[]} the strings.
 */
function argumentStrings(value, depth = 0) {
  if (depth > MAX_ARGUMENT_DEPTH) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    const found = []
    for (const item of value) {
      if (found.length >= MAX_ARGUMENT_STRINGS) break
      found.push(...argumentStrings(item, depth + 1))
    }
    return found
  }
  if (value !== null && typeof value === 'object') {
    const found = []
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const item of Object.values(record)) {
      if (found.length >= MAX_ARGUMENT_STRINGS) break
      found.push(...argumentStrings(item, depth + 1))
    }
    return found
  }
  return []
}


/**
 * Resume one session, retrying while the fresh process is still composing.
 *
 * A resumed session must come back as it was: the preset the user picked and
 * the model the conversation was actually running on. Both live in the
 * session's own log, so they are read from the observation instead of from
 * the deployment defaults.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the session to resume.
 * @returns {Promise<object | undefined>} the resumed agent, when it could be resumed.
 */
async function resumeSession(ctx, sessionId) {
  const deadline = Date.now() + 30_000
  let lastError
  while (Date.now() < deadline) {
    let observation
    try {
      observation = await ctx.get('sessionQuery').observeSession(sessionId)
      const header = lastRequestHeader(observation.events)
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      const fallback = selection === undefined
        ? undefined
        : {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        }
      const agentOptions = routeFor(header, fallback)

      const presets = ctx.get('agentPresets')
      const presetId = observation.projections?.values?.agentPreset
      const resolved = presets !== undefined && typeof presetId === 'string' && presetId !== ''
        ? await presets.resolve(presetId).catch(() => undefined)
        : undefined

      const agents = ctx.get('agents')
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(resolved === undefined ? {} : {
          // A preset that cannot be mounted must not cost the session: the
          // agent still comes back, with the deployment default instead.
          setup: async (agentCtx) => {
            try {
              await presets.mount(agentCtx, resolved.id ?? presetId)
            } catch (error) {
              console.error('[restart-handoff] could not mount the preset:', error)
            }
          },
        }),
      })
      return handle.agent
    } catch (error) {
      lastError = error
      // Another owner already resumed this session — the agent loop's own
      // config, or the user opening it. Use the live agent instead of
      // spinning until the deadline and then giving up on the session.
      if (error instanceof Error && error.name === 'SessionAlreadyOwnedError') {
        const live = ctx.get('agents')?.get?.(sessionId)
        if (live !== undefined) return live
      }
      await new Promise(resolve => { setTimeout(resolve, 500) })
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  }
  console.error(`[restart-handoff] could not resume ${sessionId}:`, lastError)
  return undefined
}

/**
 * Replay a handoff record: resume every session that was running, wake the
 * subagents, and hand the pending instruction to the session that asked.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @returns {Promise<void>} resolves when the handoff is done or skipped.
 */
async function runHandoff(ctx, settings) {
  // A confirmation never survives the restart it was meant to authorize: the
  // fresh process has no pending warning for the model to confirm against.
  await clearRecord(settings, PENDING_FILE)

  const record = await readRecord(settings, HANDOFF_FILE)
  if (record === undefined) return
  if (record.phase === 'resumed') {
    await clearRecord(settings, HANDOFF_FILE)
    return
  }
  const age = Date.now() - Number(record.createdAt ?? 0)
  if (!Number.isFinite(age) || age < 0 || age > Number(settings.handoffTtlMs ?? DEFAULTS.handoffTtlMs)) {
    console.error('[restart-handoff] stale handoff record, not replaying it')
    await clearRecord(settings, HANDOFF_FILE)
    return
  }
  if (record.createdByPid === process.pid) {
    // The same process wrote it and never went away: the restart did not happen.
    console.error('[restart-handoff] handoff record belongs to this process, not replaying it')
    return
  }

  const entries = Array.isArray(record.sessions) && record.sessions.length > 0
    ? record.sessions
    : [{ id: String(record.sessionId ?? ''), kind: 'initiator' }]
  const reason = record.reason ?? 'no reason recorded'
  const intro = `The Harness restarted (${reason}).`

  const resumed = []
  for (const entry of entries) {
    const sessionId = String(entry.id ?? '')
    if (sessionId === '') continue
    const agent = await resumeSession(ctx, sessionId)
    if (agent === undefined) {
      console.error(`[restart-handoff] session ${sessionId} could not be resumed`)
      continue
    }
    resumed.push({ agent, kind: entry.kind === 'peer' ? 'peer' : 'initiator' })
    console.error(`[restart-handoff] session ${sessionId} resumed as ${entry.kind}`)

    if (record.resumeSubagents === true) {
      await wakeSubagents(ctx, sessionId, record)
    }

    const text = entry.kind === 'peer'
      ? `${intro} Your session was resumed and the other running sessions were resumed too. Continue the work you had in flight.`
      : `${intro} Continue the work below.\n\n${record.continuePrompt}`
    agent.followup(userMessage(text))
  }

  for (const entry of resumed) {
    await wakeTeamMembers(ctx, entry.agent, record)
  }
  console.error(`[restart-handoff] replayed the handoff: ${resumed.length} session(s) resumed`)

  await writeRecord(settings, HANDOFF_FILE, { ...record, phase: 'resumed', resumedAt: Date.now() })
  await clearRecord(settings, HANDOFF_FILE)
  return resumed.map(entry => entry.agent.id)
}

/**
 * Wake the continuable subagents of a resumed session.
 *
 * A child session cannot be resumed through the generic session API: the
 * subagent runtime owns it, a cold resume requires the child's exact durable
 * parent to be live, and only a `continuable` child can be continued at all.
 * So the wake-up IS the delivery: `ctx.subagents.prompt` cold-resumes the
 * child when it is not resident and then queues the instruction.
 *
 * The tree is walked top-down, because a child can only be delivered to while
 * its own parent is live — a grandchild waits for its parent to be woken.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the resumed root session.
 * @param {Record<string, any>} record - the handoff record.
 * @returns {Promise<string[]>} the ids of the woken subagents.
 */
async function wakeSubagents(ctx, sessionId, record) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return []
  const descendants = await listSubagents(ctx, sessionId)
  // A teammate belongs to the Team roster: the Team path wakes it, with the
  // Team's own wording. Waking it here as well would tell the same child to
  // continue twice, once queued and once steered.
  const teamMembers = await teamMemberIds(ctx, ctx.get('agents')?.get?.(sessionId))
  const continuable = descendants
    .filter(child => child.mode === 'continuable' && !teamMembers.has(child.id))
    .sort((left, right) => left.depth - right.depth)
  const woken = []
  for (const child of continuable) {
    try {
      await subagents.prompt({
        requestId: randomUUID(),
        parentSessionId: child.parentId,
        childSessionId: child.id,
        mode: 'continuable',
        delivery: 'queue',
        content: [{
          type: 'text',
          text: `The Harness restarted (${record.reason ?? 'no reason recorded'}). The parent session was resumed and the pending work continues. Pick the work back up and finish it.`,
        }],
      }, AbortSignal.timeout(30_000))
      woken.push(child.id)
    } catch (error) {
      console.error(`[restart-handoff] could not wake subagent ${child.id}:`, error)
    }
  }
  return woken
}

/**
 * The teammates of a Lead agent, by their durable member id.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object | undefined} agent - the live agent.
 * @returns {Promise<Set<string>>} the member ids, empty when it is not a Lead.
 */
async function teamMemberIds(ctx, agent) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined || agent === undefined) return new Set()
  try {
    const membership = teams.tryMembership?.(agent)
    if (membership?.role !== 'lead') return new Set()
    return new Set(teams.listMembers(agent).map(member => member.id))
  } catch {
    return new Set()
  }
}

/**
 * Wake the teammates of a resumed Agent Team.
 *
 * A Team keeps its roster in the Lead's own session log, and the runtime
 * reconciles a freshly resumed Lead asynchronously: members still marked
 * `provisioning` become `inactive` (recoverable) or `failed`. Only a
 * reconciled member can be addressed, so the roster is polled until no member
 * is provisioning any more.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} lead - the resumed Lead agent.
 * @param {Record<string, any>} record - the handoff record.
 * @returns {Promise<string[]>} the names of the woken teammates.
 */
async function wakeTeamMembers(ctx, lead, record) {
  const teams = ctx.get('agentTeams')
  if (teams === undefined) return []
  let members = []
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      members = teams.listMembers(lead)
    } catch {
      return []
    }
    if (!members.some(member => member.status === 'provisioning')) break
    await new Promise(resolve => { setTimeout(resolve, 250) })
  }
  const woken = []
  for (const member of members) {
    if (member.role !== 'teammate') continue
    if (member.status === 'failed' || member.status === 'provisioning') continue
    try {
      await teams.sendMessage(lead, {
        target: member.name,
        content: [{
          type: 'text',
          text: `The Harness restarted (${record.reason ?? 'no reason recorded'}). The Lead session was resumed. Pick your work back up and finish it.`,
        }],
        signal: AbortSignal.timeout(30_000),
      })
      woken.push(member.name)
    } catch (error) {
      console.error(`[restart-handoff] could not wake team member ${member.name}:`, error)
    }
  }
  return woken
}

/**
 * Recover the sessions a crashed process left behind.
 *
 * A planned restart leaves a handoff record. A crash, a kill, or any other
 * unplanned exit leaves none — and the work in flight would simply be lost.
 * The sessions the process left behind are still on disk. A cold read
 * balances the log first, so an orphaned turn never shows up as an open
 * boundary: the durable fingerprint is the last turn's ENDING - `interrupted`
 * (the writer crashed) or `aborted` with a `disposed` cause (the process was
 * torn down mid-turn). A turn the human stopped, or one that finished on its
 * own, had nothing in flight.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @returns {Promise<string[]>} the ids of the recovered sessions.
 */
async function recoverUnplannedSessions(ctx, settings, alreadyResumed = []) {
  if (settings.recoverInterruptedSessions === false) return []
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  let records = []
  try {
    records = await query.listSessions()
  } catch (error) {
    console.error('[restart-handoff] could not list the sessions:', error)
    return []
  }
  const recovered = []
  const maxAgeMs = Number(settings.recoverMaxAgeMs ?? DEFAULTS.recoverMaxAgeMs)
  const maxSessions = Number(settings.recoverMaxSessions ?? DEFAULTS.recoverMaxSessions)
  // Newest first: the cap must keep the sessions the user actually has open.
  records = [...records].sort((a, b) => (b?.header?.createdAt ?? 0) - (a?.header?.createdAt ?? 0))
  for (const record of records) {
    const id = record?.id ?? record?.header?.id
    if (typeof id !== 'string' || id === '') continue
    if (record?.header?.parentSession !== undefined) continue
    if (record?.live === true) continue
    if (alreadyResumed.includes(id)) continue
    let observation
    try {
      observation = await query.observeSession(id)
    } catch {
      continue
    }
    const ends = observation?.events?.filter(event => event.type === 'turn/end') ?? []
    const endReason = ends.at(-1)?.data?.reason
    const wasCutOff = endReason?.kind === 'interrupted'
      || (endReason?.kind === 'aborted' && endReason.reason?.kind === 'disposed')
    const openTurn = observation?.projections?.values?.turnBoundary?.openTurnStartSeq != null
    const inboxState = observation?.projections?.values?.inbox
    const queued = (inboxState?.['next-turn']?.length ?? 0) > 0 || (inboxState?.['next-step']?.length ?? 0) > 0
    const cutOff = wasCutOff || openTurn || queued
    const lastEvent = observation?.events?.[observation.events.length - 1]
    if (typeof lastEvent?.time === 'number' && Date.now() - lastEvent.time > maxAgeMs) continue
    if (recovered.length >= maxSessions) break
    const agent = await resumeSession(ctx, id)
    if (agent === undefined) continue
    if (cutOff) agent.followup(userMessage('The Harness process went down unexpectedly and your session was resumed. Continue the work that was in flight.'))
    if (cutOff) await wakeSubagents(ctx, id, { reason: 'unexpected restart' })
    recovered.push(id)
    console.error(`[restart-handoff] recovered the interrupted session ${id}`)
  }
  console.error(`[restart-handoff] scan: candidates=${records.length} restored=${recovered.length}`)
  return recovered
}

/**
 * Apply the plugin: register the tool, close the shell-restart door, and
 * replay a handoff record left by the previous process.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} [config] - the profile row's configuration.
 * @returns {void} nothing.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const log = (...args) => { ctx.logger?.info?.('[restart-handoff]', ...args) }

  // The handoff replay comes first and must never take the process down: a
  // broken registration must not cost the user the sessions they were waiting
  // for, and a failed resume must not stop the Harness from starting.
  if (settings.autoResume !== false) {
    ctx.effect(() => {
      void runHandoff(ctx, settings)
        .catch((error) => {
          console.error('[restart-handoff] handoff failed:', error)
        })
      void recoverUnplannedSessions(ctx, settings).catch((error) => {
        console.error('[restart-handoff] unplanned recovery failed:', error)
      })
        .catch((error) => {
          console.error('[restart-handoff] handoff failed:', error)
        })
    })
  }

  try {
    if (typeof createRestartTool === 'function') ctx.tools.register(createRestartTool(ctx, settings))
  } catch (error) {
    console.error('[restart-handoff] could not register restart_dsh:', error)
  }

  try {
    ctx.effect(() => ctx.tools.guard(createRestartGuard()))
  } catch (error) {
    console.error('[restart-handoff] could not register the shell-restart guard:', error)
  }

  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'restart-handoff',
      order: 90,
      text: 'Restarting the Harness: use the restart_dsh tool, never a shell command. A shell restart kills the turn, the tool result and the session. restart_dsh warns first and asks for a confirmation token; with that token it records the handoff, restarts the service, and the fresh process resumes every running session, wakes the subagents again and replays the confirmed plan, so continuePrompt must be self-contained.',
    }))
  } catch (error) {
    console.error('[restart-handoff] could not add the system prompt section:', error)
  }

  log('ready; handoff directory', handoffDir(settings))
}

/**
 * Internals exported for the unit tests; not part of the plugin's contract.
 */
export const internals = {
  createRestartGuard,
  recoverUnplannedSessions,
  resumeSession,
  runHandoff,
  teamMemberIds,
  wakeSubagents,
  wakeTeamMembers,
}

/**
 * Read a handoff record.
 * @param {Record<string, any>} settings - plugin settings.
 * @param {string} file - the record file name.
 * @returns {Promise<any | undefined>} the record, when there is one.
 */
async function readRecord(settings, file) {
  try {
    return JSON.parse(await fsReadFile(pathJoin(handoffDir(settings), file), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write a handoff record atomically.
 * @param {Record<string, any>} settings - plugin settings.
 * @param {string} file - the record file name.
 * @param {unknown} data - the record.
 * @returns {Promise<void>} resolves once the record is on disk.
 */
async function writeRecord(settings, file, data) {
  const dir = handoffDir(settings)
  await fsMkdir(dir, { recursive: true })
  const target = pathJoin(dir, file)
  const temp = target + '.tmp'
  await fsWriteFile(temp, JSON.stringify(data, null, 2))
  await fsRename(temp, target)
}

/**
 * Remove a handoff record.
 * @param {Record<string, any>} settings - plugin settings.
 * @param {string} file - the record file name.
 * @returns {Promise<void>} resolves once the record is gone.
 */
async function clearRecord(settings, file) {
  try {
    await fsRm(pathJoin(handoffDir(settings), file), { force: true })
  } catch {
    // a record that is already gone is the wanted state
  }
}

/**
 * The header of the last request in a session's events.
 * @param {unknown[]} events - the session events.
 * @returns {any | undefined} the header, when there is one.
 */
function lastRequestHeader(events) {
  const list = Array.isArray(events) ? events : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const event = list[index]
    if (event?.type !== 'request') continue
    const header = event?.data?.header ?? event?.data
    if (header !== undefined && header !== null) return header
  }
  return undefined
}

/**
 * The agent options a session should come back with.
 *
 * The provider and the model are the session's own. The reasoning effort is the
 * conversation's choice, unless the adapter supplied it — an adapter default
 * is not something the conversation asked for, so it does not carry over.
 * @param {any} header - the last request header.
 * @param {any} fallback - the options to start from.
 * @returns {any} the options for the resumed agent.
 */
function routeFor(header, fallback) {
  const options = { ...(fallback ?? {}) }
  if (header?.provider !== undefined) options.provider = header.provider
  if (header?.model !== undefined) options.model = header.model
  if (header?.reasoningEffort !== undefined && fallback?.adapterDefaults?.reasoningEffort !== true) {
    options.reasoningEffort = header.reasoningEffort
  }
  return options
}
