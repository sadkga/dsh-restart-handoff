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

/**
 * A user message for `agent.followup`.
 *
 * The shape is the host's `UserMessage`: an identity, a role, the content
 * blocks and the source. The identity is not optional — the inbox's durable
 * projection rejects a second message without a distinct id ("message
 * "undefined" is already pending"), so two follow-ups into the same agent
 * would fail without it.
 * @param {string} text - the message text.
 * @returns {Record<string, any>} the user message.
 */
function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  }
}
function handoffDir(settings) {
  return settings?.handoffDir ?? pathJoin(process.env.DSH_HOME ?? process.cwd(), 'restart')
}
/** Plugin name the loader and the inventory show. */
export const name = 'restart-handoff'

/**
 * The services this half needs. `subagents` and `agentTeams` are optional and
 * resolved at call time: a profile without delegation still restarts and
 * resumes its sessions.
 */
export const inject = ['tools', 'agents', 'sessionPersistence', 'sessionQuery', 'systemPrompt', 'agentDefaultModel']

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
  /** Recover the sessions an unplanned exit left behind. */
  recoverInterruptedSessions: true,
  /** Write the handoff record but never signal this process. */
  dryRun: false,
}

/** File name of the handoff record inside the handoff directory. */
const HANDOFF_FILE = 'handoff.json'

/** File name of the pending-confirmation record inside the handoff directory. */
const PENDING_FILE = 'pending.json'

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
 * The reason a shell restart is denied.
 *
 * The denial has to name the way out, otherwise the model just tries the next
 * spelling of the same suicide.
 */
const RESTART_DENIAL = 'Restarting the Harness through a shell command is blocked: the command would kill the running turn, the tool result and the session. Use the restart_dsh tool instead — it warns first, records the handoff and resumes every session after the restart.'

/**
 * Tools whose arguments are EXECUTED rather than stored.
 *
 * The scope matters: a `write`/`edit` payload that mentions
 * `systemctl --user restart dsh.service` is documentation, not an execution,
 * and denying it would stop the agent from writing its own tests and notes.
 * A shell tool's command IS an execution, so that is what the command kernel
 * judges. The name list is deliberately generous — a code-execution channel
 * (`run_code`) kills the Host just as well as a shell does.
 */
const COMMAND_TOOL_NAMES = /(?:^|[^a-z0-9])(?:bash|pwsh|sh|zsh|ksh|shell|terminal|exec|execute|command|cmd|code)(?:[^a-z0-9]|$)/i

/**
 * The code-shaped subset of TEXT_RESTART_PATTERNS: the four patterns that
 * cannot occur in prose.
 *
 * They are denied in EVERY tool, including the ones whose arguments are data
 * rather than commands: a sentence never contains `process.kill(process.ppid,
 * 15)`, so treating these as prose-mentions would only lose the defence.
 */
const SELF_HARM_PATTERNS = TEXT_RESTART_PATTERNS.slice(0, 4)

/**
 * Calls whose argument is CODE THAT RUNS.
 *
 * A shell interpreter is the obvious case, but a code channel has its own
 * equivalents: `execSync('pkill -f node')`, `subprocess.run(['kill','-1'])`,
 * `os.system('reboot')` and `tools.bash({ command: 'pkill -f node' })` all run
 * exactly what a shell segment would. Their payload is therefore parsed
 * recursively, like an interpreter's.
 */
const EXECUTION_CALLS = /(?:\w+\.)*(?:exec|execsync|execfile|execfilesync|spawn|spawnsync|fork|system|popen|check_output|check_call|getoutput|run|call|eval|bash|zsh|pwsh|powershell)(?:\s*\.\s*\w+)*\s*\(/i

/**
 * A segment that hands a `-c` payload to something: that payload is code, so
 * it is parsed recursively. This covers the wrappers around an interpreter
 * (`busybox sh -c '…'`, `env -c '…'`), where the head verb is not the
 * interpreter itself.
 */
const CODE_PAYLOAD_OPTION = /(?:^|\s)-c(?:\s|$)/

/**
 * The quoted strings inside a segment.
 * @param {string} segment - one segment of a command line.
 * @returns {string[]} the quoted payloads.
 */
function quotedPayloads(segment) {
  const payloads = []
  for (const quoted of segment.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    const payload = quoted[1] ?? quoted[2] ?? ''
    if (payload !== '') payloads.push(payload)
  }
  return payloads
}

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
 * a commit message mentioning "kill -1" is not a kill. A segment whose head is
 * an interpreter — or that CALLS an executor — is parsed recursively, because
 * its payload is the real command.
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
    if (depth < 2) {
      const payloads = quotedPayloads(segment)
      const isCodeCarrier = INTERPRETERS.has(word)
        || EXECUTION_CALLS.test(segment)
        || (CODE_PAYLOAD_OPTION.test(segment) && payloads.length > 0)
      if (isCodeCarrier) {
        for (const payload of payloads) found.push(...dangerousSegments(payload, depth + 1))
        // The payload of an array-style call is split across its items
        // (`subprocess.run(['kill', '-1'])`), so the items are judged together
        // as well as one by one.
        if (payloads.length > 1) found.push(...dangerousSegments(payloads.join(' '), depth + 1))
        // An interpreter or an executor with no quoted payload ends the
        // segment: its head verb is the whole story. A `-c` carrier falls
        // through instead, so its head verb is judged as well.
        if (INTERPRETERS.has(word) || EXECUTION_CALLS.test(segment)) continue
      }
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
 *
 * Two scopes, one kernel. The command kernel (`headVerb` →
 * `dangerousSegments`) judges a string only when it could be EXECUTED: the
 * tool is a shell or a code runner. The code-shaped self-harm patterns are
 * denied everywhere, because prose never contains them.
 * @returns {(execution: Readonly<{ name: string, arguments?: unknown }>) => string | undefined} the guard.
 */
function createRestartGuard() {
  return (execution) => {
    if (execution?.name === 'restart_dsh') return undefined
    const executes = isCommandTool(execution?.name)
    for (const text of collectStrings(execution?.arguments)) {
      if (SELF_HARM_PATTERNS.some(pattern => pattern.test(text))) return RESTART_DENIAL
      if (!executes) continue
      if (TEXT_RESTART_PATTERNS.some(pattern => pattern.test(text))) return RESTART_DENIAL
      if (dangerousSegments(text).length > 0) return RESTART_DENIAL
      if (selfKillSegments(text).length > 0) return RESTART_DENIAL
    }
    return undefined
  }
}

/**
 * Whether a tool's arguments are executed rather than stored.
 * @param {unknown} name - the tool name.
 * @returns {boolean} true for shell-like and code-execution tools.
 */
function isCommandTool(name) {
  return typeof name === 'string' && COMMAND_TOOL_NAMES.test(name)
}



/**
 * Whether a segment kills THIS very process.
 *
 * The plugin runs inside the Host process, so `process.pid` IS the Host's pid.
 * That closes the most realistic suicide path, the two-step one: look the pid
 * up with a harmless `pgrep`, then kill it in the next command. A text guard
 * cannot read the process table, so the pid has to be matched literally.
 * @param {string} segment - one segment of a command line.
 * @returns {boolean} true when the segment targets this very process.
 */
function killsSelf(segment) {
  if (!/\b(kill|killall5?|pkill|taskkill)\b/i.test(segment)) return false
  // `kill -9 31337`, `kill 31337`, `kill -TERM 31337`
  if (new RegExp(`\\b${process.pid}\\b`).test(segment)) return true
  // `kill $PPID` — the parent of the Host's child shell is the Host itself.
  if (/\$\{?PPID\}?/.test(segment)) return true
  return false
}

/**
 * The segments of a command line that kill THIS very process.
 * @param {string} command - the command text.
 * @returns {string[]} the self-killing segments.
 */
function selfKillSegments(command) {
  const found = []
  for (const raw of String(command).split(/[;&|\n]+/)) {
    const segment = raw.trim()
    if (segment === '') continue
    const { word } = headVerb(segment)
    if (!KILL_VERBS.has(word)) continue
    if (killsSelf(segment)) found.push(segment)
  }
  return found
}

/**
 * The descendants of a session, when the profile has the delegation runtime.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the root session.
 * @returns {Promise<object[]>} the descendants, empty when there are none.
 */
async function listSubagents(ctx, sessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return []
  try {
    const descendants = await subagents.listDescendants(sessionId)
    return Array.isArray(descendants) ? descendants : []
  } catch (error) {
    console.error('[restart-handoff] could not list the subagents:', error)
    return []
  }
}

/**
 * Whether an agent has work queued that never started.
 *
 * A queued prompt is work in flight: it was accepted by the agent, so it is
 * lost when the process dies unless the session comes back.
 * @param {object | undefined} agent - the agent.
 * @returns {boolean} true when a prompt is waiting for a turn or a step.
 */
function hasPendingWork(agent) {
  return (agent?.inbox?.nextTurn?.length ?? 0) > 0 || (agent?.inbox?.nextStep?.length ?? 0) > 0
}

/**
 * Whether a session is a top-level one.
 *
 * Only a root may restart the Harness: a subagent restarting it would take
 * its own parent down with it, and the handoff would have no initiator to
 * hand the instruction back to.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the session id.
 * @returns {boolean} true for a top-level session.
 */
function isRootSession(ctx, sessionId) {
  const roots = ctx.get('agents')?.roots?.() ?? []
  return roots.some(root => root?.id === sessionId)
}

/**
 * Whether a root session is worth resuming after a restart.
 *
 * Three ways to be worth it: it is running right now, it has a prompt queued
 * that never started, or one of its subagents is alive.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} root - the root agent.
 * @returns {Promise<boolean>} true when the session must come back.
 */
async function isResumableRoot(ctx, root) {
  if (root?.status === 'running') return true
  if (hasPendingWork(root)) return true
  const descendants = await listSubagents(ctx, root?.id)
  return descendants.some(child => child?.activity === 'running')
}

/**
 * The sessions that must come back after a restart, without the caller.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} callerId - the session that asked for the restart.
 * @returns {Promise<string[]>} the session ids.
 */
async function listResumableSessions(ctx, callerId) {
  const roots = ctx.get('agents')?.roots?.() ?? []
  const ids = []
  for (const root of roots) {
    const id = root?.id
    if (typeof id !== 'string' || id === '') continue
    if (id === callerId) continue
    if (await isResumableRoot(ctx, root)) ids.push(id)
  }
  return ids
}

/**
 * The sessions a restart must bring back: the caller plus every other
 * session that is running, queued or has a live subagent.
 *
 * `resumeRunningSessions: false` narrows it to the caller alone — the other
 * sessions are then left exactly as they were.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} callerId - the session that asked for the restart.
 * @param {Record<string, any>} [settings] - effective plugin settings.
 * @returns {Promise<string[]>} the session ids, in registration order.
 */
async function collectRestartTargets(ctx, callerId, settings = {}) {
  const roots = ctx.get('agents')?.roots?.() ?? []
  const ids = []
  for (const root of roots) {
    const id = root?.id
    if (typeof id !== 'string' || id === '') continue
    if (id === callerId) { ids.push(id); continue }
    if (settings.resumeRunningSessions === false) continue
    if (await isResumableRoot(ctx, root)) ids.push(id)
  }
  return ids
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
      // The observation is a lease and is released when it goes out of scope.
      // Baseline implementation, carried over unchanged: the exact disposal
      // contract was not re-verified line by line against the Host source.
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
  // WHO to wake is decided by the child's own log, never by its mode: a
  // one-shot child that was cut off mid-turn has work in flight just like a
  // continuable one, and a child that finished must not be woken at all.
  const candidates = descendants
    .filter(child => typeof child?.id === 'string' && child.id !== '' && !teamMembers.has(child.id))
    .sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0))
  const woken = []
  for (const child of candidates) {
    const cutOff = await wasSessionCutOff(ctx, child.id)
    if (!cutOff.cutOff) {
      console.error(`[restart-handoff] subagent ${child.id} left asleep (${cutOff.reason}, mode=${child.mode})`)
      continue
    }
    try {
      await subagents.prompt({
        requestId: randomUUID(),
        parentSessionId: child.parentId,
        childSessionId: child.id,
        // The runtime's delivery protocol is continuable-addressed: `mode` is
        // the address discriminator, not the child's creation mode. A one-shot
        // child has no continuation state and its cold resume is refused by
        // the runtime itself, which is reported as a skipped wake below.
        mode: 'continuable',
        delivery: 'queue',
        content: [{
          type: 'text',
          text: `The Harness restarted (${record.reason ?? 'no reason recorded'}). The parent session was resumed and the pending work continues. Pick the work back up and finish it.`,
        }],
      }, AbortSignal.timeout(30_000))
      woken.push(child.id)
      console.error(`[restart-handoff] subagent ${child.id} WOKEN (${cutOff.reason}, mode=${child.mode}, depth=${child.depth})`)
    } catch (error) {
      // One child that cannot be woken must never cost the others.
      const code = error instanceof Error && typeof error.code === 'string' ? ` ${error.code}` : ''
      console.error(`[restart-handoff] subagent ${child.id} NOT WOKEN (${cutOff.reason}, mode=${child.mode})${code}: ${error instanceof Error ? error.message : String(error)}`)
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
 * Balanced view of a session log: no open turn at the tail.
 *
 * The Host balances a log before handing it to a reader — `cold-read` runs the
 * same repair as an agent-loop resume — but the judgement must not depend on
 * which reader it came through. A log whose last `turn/start` has no
 * `turn/end` after it is closed here with a synthetic `interrupted` closer,
 * exactly as `packages/core/session/src/repair.ts` does. The operation is
 * idempotent: a log that is already balanced comes back unchanged.
 * @param {object[]} events - the events of one session log, in order.
 * @returns {object[]} the events, with the open tail turn closed.
 */
function balanceLog(events) {
  const list = Array.isArray(events) ? events : []
  const open = new Map()
  for (const event of list) {
    if (event?.type === 'turn/start') {
      const turn = event?.data?.turn
      if (turn !== undefined) open.set(turn, true)
    } else if (event?.type === 'turn/end') {
      const turn = event?.data?.turn
      if (turn !== undefined) open.delete(turn)
    }
  }
  if (open.size === 0) return list
  const last = list.at(-1)
  const time = typeof last?.time === 'number' ? last.time : Date.now()
  let seq = typeof last?.seq === 'number' ? last.seq : -1
  const closers = []
  for (const turn of open.keys()) {
    closers.push({ type: 'turn/end', seq: seq += 1, time, data: { turn, reason: { kind: 'interrupted' } } })
  }
  return [...list, ...closers]
}

/**
 * Whether a session log was cut off mid-turn, and why.
 *
 * Four durable fingerprints, any one of which means the session was lost with
 * work in flight:
 *  - an unclosed turn (the last `turn/start` has no `turn/end`) — the writer
 *    never got to close it;
 *  - the last `turn/end` is `interrupted` — the session layer closed an
 *    orphaned turn after the fact;
 *  - the last `turn/end` is `aborted` with a `disposed` cause — the process
 *    was torn down mid-turn;
 *  - a committed `assistant/message` carrying `interrupted: true` — the model
 *    was cut off mid-stream and the partial message is in the log.
 *
 * A turn the human stopped (`aborted` + `user`), one that finished
 * (`completed`), one that failed (`error`) and one that hit the token ceiling
 * (`max-tokens`) had nothing in flight and must stay dead.
 * @param {object[]} events - the events of one session log.
 * @returns {{ cutOff: boolean, reason: string }} the verdict and its cause.
 */
function cutOffReason(events) {
  const list = balanceLog(events)
  const starts = list.filter(event => event?.type === 'turn/start')
  const ends = list.filter(event => event?.type === 'turn/end')
  if (starts.length > ends.length) return { cutOff: true, reason: 'unclosed-turn' }
  const endReason = ends.at(-1)?.data?.reason
  if (endReason?.kind === 'interrupted') return { cutOff: true, reason: 'interrupted' }
  if (endReason?.kind === 'aborted' && endReason.reason?.kind === 'disposed') {
    return { cutOff: true, reason: 'aborted+disposed' }
  }
  const interruptedMessage = list.some(event => event?.type === 'assistant/message' && event?.data?.interrupted === true)
  if (interruptedMessage) return { cutOff: true, reason: 'interrupted-message' }
  return { cutOff: false, reason: endReason?.kind === undefined ? 'no-turn-end' : String(endReason.kind) }
}

/**
 * Whether a subagent session was cut off, by its durable log.
 *
 * The log is read with `readSession`, which returns the complete event stream:
 * `observeSession` hands back a SEED view (a handful of events ending in
 * `session/end-seed`), so a judgement built on it would be watching a
 * different conversation. The read is balanced locally as well, which makes
 * the verdict independent of whether the Host already balanced it.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {string} sessionId - the child session.
 * @returns {Promise<{ cutOff: boolean, reason: string }>} the verdict and its cause.
 */
async function wasSessionCutOff(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return { cutOff: false, reason: 'no-session-query' }
  try {
    const snapshot = await query.readSession(sessionId)
    const events = snapshot?.events
    if (!Array.isArray(events)) return { cutOff: false, reason: 'unreadable' }
    return cutOffReason(events)
  } catch (error) {
    console.error(`[restart-handoff] could not read the session ${sessionId}:`, error)
    return { cutOff: false, reason: 'read-failed' }
  }
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
 * own, had nothing in flight — UNLESS its inbox still holds a prompt that
 * never started, which is work in flight as well.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @param {string[]} [alreadyResumed] - the sessions the handoff already resumed.
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
    // The log is read with `readSession`, not `observeSession`: the latter
    // returns a SEED view (a few events ending in `session/end-seed`), so a
    // judgement built on it inspects the wrong conversation. The cause is
    // balanced locally too, which keeps the verdict independent of the reader.
    let events
    try {
      const snapshot = await query.readSession(id)
      events = Array.isArray(snapshot?.events) ? snapshot.events : []
    } catch (error) {
      console.error(`[restart-handoff] could not read the session ${id}:`, error)
      continue
    }
    const cutOff = cutOffReason(events)
    const wasCutOff = cutOff.cutOff
    // The inbox projection is the one thing the observation is still good
    // for: it is the durable record of accepted-but-unstarted work.
    let inboxState
    try {
      const observation = await query.observeSession(id)
      inboxState = observation?.projections?.values?.inbox
      observation?.[Symbol.dispose]?.()
    } catch {
      inboxState = undefined
    }
    // A queued prompt that never started is work in flight too: the turn it
    // belonged to may have finished, but the accepted work is still waiting
    // and would be lost with the process.
    const queued = (inboxState?.['next-turn']?.length ?? 0) > 0
      || (inboxState?.['next-step']?.length ?? 0) > 0
    const lastEvent = events.at(-1)
    if (typeof lastEvent?.time === 'number' && Date.now() - lastEvent.time > maxAgeMs) {
      console.error(`[restart-handoff] scan: ${id} skipped (older than the window)`)
      continue
    }
    if (!wasCutOff && !queued) {
      console.error(`[restart-handoff] scan: ${id} skipped (finished: ${cutOff.reason})`)
      continue
    }
    if (recovered.length >= maxSessions) break
    const agent = await resumeSession(ctx, id)
    if (agent === undefined) {
      console.error(`[restart-handoff] scan: ${id} NOT RESTORED (resume failed)`)
      continue
    }
    agent.followup(userMessage('The Harness process went down unexpectedly and your session was resumed. Continue the work that was in flight.'))
    const woken = await wakeSubagents(ctx, id, { reason: 'unexpected restart' })
    recovered.push(id)
    console.error(`[restart-handoff] scan: ${id} restored (${cutOff.cutOff ? cutOff.reason : 'queued-work'}) woken=${woken.length}`)
  }
  console.error(`[restart-handoff] scan: candidates=${records.length} restored=${recovered.length}`)
  return recovered
}

/**
 * The restart tool.
 *
 * Two steps, on purpose. The FIRST call only warns: it names what the restart
 * would do, which sessions would come back and what the fresh process would
 * replay, and it hands back a confirmation token. The SECOND call carries that
 * token, and it executes THE PLAN IN THE WARNING — the reason and the
 * instruction come from the pending record, never from the second call's
 * arguments. A model that rewrites the plan between the two calls would be
 * confirming a plan nobody ever saw, and the confirmation would mean nothing.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @returns {Record<string, any>} the tool definition.
 */
function createRestartTool(ctx, settings) {
  // One restart per tool instance: the second confirmation must not schedule
  // a second exit.
  let exiting = false

  return {
    name: 'restart_dsh',
    description: [
      'Restart the DeepSeek Harness and come back with the work intact.',
      'Call it TWICE: the first call only warns — it lists the sessions that would be resumed and the instruction the fresh process would replay — and returns a confirmation token; the second call passes that token back and performs the restart.',
      'Never restart the Harness through a shell command: that kills the running turn, the tool result and the session.',
      'The second call runs the plan from the FIRST call, so reason and continuePrompt are only read on the first one.',
      'continuePrompt must be self-contained: it is handed to the resumed session after the restart, with no conversation context.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the Harness should restart. Shown in the warning; ignored on the confirming call.' },
        continuePrompt: { type: 'string', description: 'The self-contained instruction the resumed session receives after the restart. Shown in the warning; ignored on the confirming call.' },
        resumeSubagents: { type: 'boolean', description: 'Wake the continuable subagents again after the resume. Defaults to the plugin setting.' },
        confirmToken: { type: 'string', description: 'The token from the warning. Present only on the second, confirming call.' },
      },
      required: ['reason', 'continuePrompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          scheduled: { type: 'boolean' },
          message: { type: 'string' },
          confirmToken: { type: 'string' },
          reason: { type: 'string' },
          sessions: { type: 'array', items: { type: 'string' } },
        },
        required: ['scheduled', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value?.message ?? JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const callerId = exec?.agent?.id
      if (typeof callerId !== 'string' || callerId === '') {
        throw new Error('restart_dsh needs a session to restart from')
      }
      if (!isRootSession(ctx, callerId)) {
        throw new Error('restart_dsh: only a top-level session may restart the Harness — a subagent must ask its parent to do it')
      }

      const confirmToken = typeof args?.confirmToken === 'string' ? args.confirmToken.trim() : ''

      // ------------------------------------------------------------------
      // FIRST CALL — warn, hand out the token, change nothing.
      // ------------------------------------------------------------------
      if (confirmToken === '') {
        const reason = String(args?.reason ?? '').trim()
        const continuePrompt = String(args?.continuePrompt ?? '').trim()
        if (reason === '') throw new Error('restart_dsh needs a reason')
        if (continuePrompt === '') throw new Error('restart_dsh needs a continuePrompt')
        const sessions = await collectRestartTargets(ctx, callerId, settings)
        const token = randomUUID()
        await writeRecord(settings, PENDING_FILE, {
          createdAt: Date.now(),
          token,
          reason,
          continuePrompt,
          resumeSubagents: args?.resumeSubagents === undefined
            ? settings.resumeSubagents !== false
            : args.resumeSubagents === true,
          sessions,
          callerId,
        })
        return {
          scheduled: false,
          message: [
            'NOT restarted anything yet.',
            `Reason: ${reason}`,
            `The instruction the fresh process will replay: ${continuePrompt}`,
            `Sessions that will be resumed: ${sessions.length > 0 ? sessions.join(', ') : 'none'}`,
            'Call restart_dsh again with confirmToken to perform exactly this restart.',
          ].join('\n'),
          confirmToken: token,
          reason,
          sessions,
        }
      }

      // ------------------------------------------------------------------
      // SECOND CALL — execute the plan the warning showed.
      // ------------------------------------------------------------------
      const pending = await readRecord(settings, PENDING_FILE)
      if (pending === undefined) {
        throw new Error('there is no pending restart to confirm; call restart_dsh without a confirmToken to get a new warning')
      }
      if (pending.token !== confirmToken) {
        throw new Error('the confirmation token does not match a pending restart; call restart_dsh again to get a new warning')
      }
      const age = Date.now() - Number(pending.createdAt ?? 0)
      if (!Number.isFinite(age) || age < 0 || age > Number(settings.pendingTtlMs ?? DEFAULTS.pendingTtlMs)) {
        await clearRecord(settings, PENDING_FILE)
        throw new Error('the confirmation has expired; call restart_dsh again to get a new warning')
      }

      // The plan comes from the warning, not from this call's arguments.
      const reason = String(pending.reason ?? '')
      const continuePrompt = String(pending.continuePrompt ?? '')
      const resumeSubagents = pending.resumeSubagents !== false
      const planned = Array.isArray(pending.sessions) ? pending.sessions.map(String) : []
      const sessions = planned.includes(callerId) ? planned : [callerId, ...planned]

      await writeRecord(settings, HANDOFF_FILE, {
        phase: 'prepared',
        sessionId: callerId,
        sessions: sessions.map(id => ({ id, kind: id === callerId ? 'initiator' : 'peer' })),
        reason,
        continuePrompt,
        resumeSubagents,
        createdAt: Date.now(),
        createdByPid: process.pid,
      })
      // The confirmation is spent: it must not survive into the next process.
      await clearRecord(settings, PENDING_FILE)

      if (settings.dryRun === true) {
        return {
          scheduled: false,
          message: `Dry run: the handoff record for "${reason}" was written, but this process was not signalled.`,
          reason,
          sessions,
        }
      }

      scheduleRestart(ctx, settings, callerId, () => { exiting = true })
      return {
        scheduled: true,
        message: `The Harness will restart now ("${reason}"). ${sessions.length} session(s) will be resumed and the instruction will be replayed.`,
        reason,
        sessions,
      }
    },
  }
}

/**
 * Arrange the exit: the current turn has to finish first.
 *
 * The tool must return its result BEFORE the process goes away, otherwise the
 * model never learns that the restart happened. So the exit waits for the
 * calling session to go idle — the turn is over, the tool result is in — and
 * only then does the handoff record get its final word and the process get
 * the signal.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @param {string} callerId - the session that asked for the restart.
 * @param {() => void} onExit - called once, right before the signal.
 * @returns {void} nothing.
 */
function scheduleRestart(ctx, settings, callerId, onExit) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    void completeRestart(ctx, settings, callerId, onExit)
  }
  try {
    ctx.on('agent/status', (payload) => {
      if (payload?.agent?.id !== callerId) return
      if (payload?.status !== 'idle') return
      finish()
    })
  } catch (error) {
    console.error('[restart-handoff] could not watch the agent status:', error)
  }
  const timeoutMs = Number(settings.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs)
  const timer = setTimeout(finish, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.idleTimeoutMs)
  // The timer must not hold the process open on its own.
  if (typeof timer?.unref === 'function') timer.unref()
}

/**
 * The last step before the exit: re-sample the sessions, flush the logs and
 * signal this process.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Record<string, any>} settings - effective plugin settings.
 * @param {string} callerId - the session that asked for the restart.
 * @param {() => void} onExit - called once, right before the signal.
 * @returns {Promise<void>} resolves after the signal was sent.
 */
async function completeRestart(ctx, settings, callerId, onExit) {
  try {
    // The session list is re-sampled at the last moment: a session that
    // started while the model was talking must come back too.
    const record = await readRecord(settings, HANDOFF_FILE)
    if (record !== undefined) {
      const sessions = await collectRestartTargets(ctx, callerId, settings)
      const ids = sessions.length > 0 ? sessions : [callerId]
      await writeRecord(settings, HANDOFF_FILE, {
        ...record,
        sessions: ids.map(id => ({ id, kind: id === callerId ? 'initiator' : 'peer' })),
      })
    }
    // Services are reached through `ctx.get('name')` ONLY: a direct property
    // access throws when the service is absent, and `?.` does not protect it.
    const persistence = ctx.get('sessionPersistence')
    await persistence?.flush?.()
  } catch (error) {
    console.error('[restart-handoff] could not prepare the restart:', error)
  }
  try {
    onExit()
  } catch (error) {
    console.error('[restart-handoff] could not mark the exit:', error)
  }
  // SIGTERM is a supervisor's ordinary stop request: the CLI drains in-flight
  // work and exits 0, and `Restart=always` brings a fresh process up.
  console.error(`[restart-handoff] signalling this process for restart (unit: ${settings.serviceUnit ?? DEFAULTS.serviceUnit})`)
  process.kill(process.pid, 'SIGTERM')
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

  // A confirmation never survives the restart it was meant to authorise: the
  // fresh process has no pending warning for the model to confirm against.
  // The cleanup is UNCONDITIONAL — it happens even when the replay is off,
  // otherwise a token could outlive the restart it was issued for.
  ctx.effect(() => {
    void clearRecord(settings, PENDING_FILE).catch((error) => {
      console.error('[restart-handoff] could not clear the pending confirmation:', error)
    })
  })

  // The handoff replay comes first and must never take the process down: a
  // broken registration must not cost the user the sessions they were waiting
  // for, and a failed resume must not stop the Harness from starting.
  //
  // The two recovery paths are CHAINED, not parallel: the handoff path
  // resumes the sessions the planned restart recorded, and the unplanned path
  // then scans for the sessions a crash left behind. The handoff's ids are
  // handed over, so a session the handoff already resumed is never resumed
  // twice — that would fight over the same write lease and deliver the same
  // instruction twice.
  if (settings.autoResume !== false) {
    ctx.effect(() => {
      void runHandoff(ctx, settings)
        .then((ids) => recoverUnplannedSessions(ctx, settings, ids ?? []))
        .catch((error) => {
          console.error('[restart-handoff] handoff or unplanned recovery failed:', error)
        })
    })
  }

  try {
    // `typeof` guards the registration: a missing tool body must not take the
    // whole plugin — and with it the guard and the replay — down.
    if (typeof createRestartTool === 'function') {
      ctx.effect(() => ctx.tools.register(createRestartTool(ctx, settings)))
    }
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
  DEFAULTS,
  HANDOFF_FILE,
  PENDING_FILE,
  collectRestartTargets,
  collectStrings,
  createRestartGuard,
  createRestartTool,
  dangerousSegments,
  hasPendingWork,
  headVerb,
  isCommandTool,
  isResumableRoot,
  isRootSession,
  killsSelf,
  lastRequestHeader,
  listResumableSessions,
  listSubagents,
  readRecord,
  recoverUnplannedSessions,
  resumeSession,
  routeFor,
  runHandoff,
  selfKillSegments,
  teamMemberIds,
  wakeSubagents,
  wakeTeamMembers,
  writeRecord,
  clearRecord,
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
    if (event?.type !== 'request/header') continue
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
  const config = header?.config
  if (config?.provider !== undefined) options.provider = config.provider
  if (config?.model !== undefined) options.model = config.model
  if (config?.reasoningEffort !== undefined && header?.adapterDefaults?.reasoningEffort !== true) {
    options.reasoningEffort = config.reasoningEffort
  }
  return options
}
