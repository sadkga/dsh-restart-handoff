import { join as pathJoin } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, rename as fsRename, rm as fsRm, stat as fsStat, open as fsOpen } from 'node:fs/promises'
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
  /**
   * How long the recovery waits for the Host's tool providers to settle.
   *
   * A resumed session is handed the tool set that exists at the moment it is
   * resumed. Plugins and MCP servers that finish registering a moment later
   * are therefore missing from that first turn — measured on this Host: a
   * resume carried 105 tools where the next turn carried 123, and the ones in
   * between belonged to a client plugin and an MCP server that were still
   * coming up. The recovery waits for the set to stop changing first.
   */
  resumeSettleMs: 3000,
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

/**
 * The verbs that LOOK a process up instead of signalling it.
 *
 * A lookup is harmless on its own. It matters when the pattern it searches
 * for would select the Host, and a signal follows in the same command line.
 */
const PROCESS_LOOKUPS = new Set(['pgrep', 'pidof', 'ps', 'grep'])

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
 * A literal pid is matched directly.
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
 * The Host's own command line, lower-cased.
 *
 * The guard runs inside the Host, so it knows what the Host looks like from
 * the outside. A lookup that matches this line is looking for the Host.
 * @returns {string} the Host's command line.
 */
function hostCommandLine() {
  return [process.execPath, ...process.argv.slice(1)].join(' ').toLowerCase()
}

/**
 * Whether a lookup pattern would select the Host.
 *
 * `pkill -f` and `grep -f` match against the full command line of every
 * process, so a pattern that occurs in the Host's own command line selects
 * the Host. This is the shell's own rule, not a guess: the guard asks what
 * the command would match, and answers from the process table it lives in.
 * @param {string} pattern - the pattern a lookup would use.
 * @returns {boolean} true when the pattern selects the Host.
 */
function patternSelectsHost(pattern) {
  const needle = String(pattern ?? '').trim().toLowerCase()
  if (needle === '') return false
  return hostCommandLine().includes(needle)
}

/**
 * The pattern a lookup segment looks for.
 * @param {string} segment - one segment of a command line.
 * @returns {string | undefined} the pattern, when the segment carries one.
 */
function lookupPattern(segment) {
  // `pgrep -f <pattern>` / `pidof -f <pattern>`
  const full = segment.match(/(?:^|\s)-f\s+["']?([^"'\s]+)/)
  if (full !== null) return full[1]
  // `ps aux | grep <pattern>` — the grep that filters the listing
  const grep = segment.match(/\bgrep\b(?:\s+-[a-zA-Z]+)*\s+["']?([^"'\s|]+)/)
  if (grep !== null) return grep[1]
  // `pgrep <name>` — the process name, matched against the executable name
  const name = segment.match(/^(?:pgrep|pidof)\s+["']?([^"'\s]+)/)
  if (name !== null) return name[1]
  return undefined
}

/**
 * The payloads a command substitution carries.
 *
 * A substitution is a command of its own: `P=$(pgrep -f "x" | head -1)` runs
 * `pgrep`, and the shell only then assigns its output. Splitting the line at
 * the separators leaves `P=$(pgrep -f "x"` as one piece, whose head verb is
 * neither `pgrep` nor anything else — the command inside the substitution has
 * to be looked at separately.
 * @param {string} segment - one segment of a command line.
 * @returns {string[]} the commands the substitutions run.
 */
function substitutionPayloads(segment) {
  const payloads = []
  const parens = /\$\(([^()]*)\)/g
  let match = parens.exec(segment)
  while (match !== null) {
    payloads.push(match[1])
    match = parens.exec(segment)
  }
  const ticks = /`([^`]*)`/g
  match = ticks.exec(segment)
  while (match !== null) {
    payloads.push(match[1])
    match = ticks.exec(segment)
  }
  return payloads
}

/**
 * The lookups in a command line that would select the Host.
 *
 * A lookup is only interesting when its pattern selects the Host: looking up
 * an unrelated process is ordinary work and must stay allowed.
 * @param {string} command - the command text.
 * @returns {string[]} the segments that look the Host up.
 */
function hostLookups(command) {
  const found = []
  // The substitutions are read from the WHOLE line: splitting at the
  // separators cuts a `$( … )` in half, so the closing bracket lands in the
  // next piece and the segment alone no longer holds a complete substitution.
  const candidates = []
  for (const raw of String(command).split(/[;&|\n]+/)) {
    const segment = raw.trim()
    if (segment !== '') candidates.push(segment)
  }
  for (const payload of substitutionPayloads(String(command))) {
    const trimmed = payload.trim()
    if (trimmed !== '') candidates.push(trimmed)
  }
  for (const candidate of candidates) {
    const { word } = headVerb(candidate)
    if (!PROCESS_LOOKUPS.has(word)) continue
    const pattern = lookupPattern(candidate)
    if (pattern !== undefined && patternSelectsHost(pattern)) found.push(candidate)
  }
  return found
}

/**
 * Whether a kill segment would take down more than the one process it names.
 *
 * `kill -1` signals every process the caller may signal, and `kill 0` signals
 * the caller's whole process group. The Host runs every agent in one process,
 * so either one takes the sessions and their subagents down with it.
 * @param {string} segment - one segment of a command line.
 * @returns {boolean} true when the segment signals a group or everything.
 */
function targetsEveryone(segment) {
  if (!/\b(kill|killall5?|pkill|taskkill)\b/i.test(segment)) return false
  for (const token of segment.split(/\s+/).slice(1)) {
    // `kill -9 12345` names one process and is left alone: `9` is a signal.
    if (token === '-1' || token === '0') return true
  }
  return false
}

/**
 * Whether a kill-by-name segment would select the Host.
 * @param {string} segment - one segment of a command line.
 * @returns {boolean} true when the name or pattern selects the Host.
 */
function killsHostByName(segment) {
  const { word } = headVerb(segment)
  if (word !== 'pkill' && word !== 'killall' && word !== 'killall5') return false
  const pattern = lookupPattern(segment)
  return pattern !== undefined && patternSelectsHost(pattern)
}

/**
 * The segments of a command line that kill THIS very process.
 * @param {string} command - the command text.
 * @returns {string[]} the self-killing segments.
 */
function selfKillSegments(command) {
  const found = []
  // A lookup that would select the Host, in the same command line as a
  // signal, is a self-kill however indirect the reference is:
  // `P=$(pgrep -f "bin.ts web") && kill $P` never puts the pid in the text.
  const lookup = hostLookups(command)
  for (const raw of String(command).split(/[;&|\n]+/)) {
    const segment = raw.trim()
    if (segment === '') continue
    const { word } = headVerb(segment)
    if (!KILL_VERBS.has(word)) continue
    if (killsSelf(segment)) { found.push(segment); continue }
    if (targetsEveryone(segment)) { found.push(segment); continue }
    if (killsHostByName(segment)) { found.push(segment); continue }
    if (lookup.length > 0) { found.push(segment); continue }
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
/**
 * Wait until the Host's tool providers stop changing.
 *
 * A session is handed the tool set that exists when it is resumed. A plugin
 * or an MCP server that registers a moment later is missing from that first
 * turn, and the session is told — in its own transcript — that 29 tools were
 * removed. Measured here: a resume carried 105 tools where the next turn
 * carried 123, the difference being a client plugin and an MCP server that
 * were still coming up.
 *
 * The Host announces every change to its prompt registry with
 * `system-prompt/change` — a documented public event, emitted when a section,
 * context, tool provider or variable is registered or disposed. The wait
 * listens for it and resumes only after the registry has been quiet for a
 * moment. Waiting for the set to be *complete* would need the Host to
 * publish what "complete" means; waiting for it to be *stable* needs only
 * the Host's own announcement, and stability is the property that matters —
 * a session resumed against a settled registry gets the tools a fresh one
 * would get.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {number} budgetMs - how long to wait at most.
 * @returns {Promise<{ settled: boolean, changes: number, waitedMs: number }>} what was observed.
 */
async function waitForToolProviders(ctx, budgetMs) {
  const startedAt = Date.now()
  const quietMs = 600
  let changes = 0
  let lastChangeAt = startedAt
  const onChange = () => {
    changes += 1
    lastChangeAt = Date.now()
  }
  // The event is documented as part of the service's surface; a Host that
  // does not publish it simply leaves the wait to its budget.
  //
  // The subscription is NOT undone with `ctx.off`: that call needs an inject
  // context and throws "cannot get property off without inject" — which is
  // how one restart ended up doing no recovery at all. `ctx.on` returns a
  // disposer, and the plugin's own fiber unsubscribes everything when the
  // bundle is unloaded, so leaving the listener in place is both safe and
  // correct.
  let dispose = null
  if (typeof ctx.on === 'function') {
    try {
      dispose = ctx.on('system-prompt/change', onChange)
    } catch {
      dispose = null
    }
  }
  try {
    while (Date.now() - startedAt < budgetMs) {
      await new Promise(resolve => { setTimeout(resolve, 150) })
      if (Date.now() - lastChangeAt >= quietMs) {
        return { settled: true, changes, waitedMs: Date.now() - startedAt }
      }
    }
  } finally {
    if (typeof dispose === 'function') {
      try { dispose() } catch { /* the fiber will drop it anyway */ }
    }
  }
  return { settled: false, changes, waitedMs: Date.now() - startedAt }
}
/**
 * The registry-global archive set, when the profile publishes the workspace
 * registry to this plugin context.
 *
 * The registry is a Service registered as `workspaceRegistry` and exposes
 * `archivedSessionIds` as a getter. It is reached through `ctx.get` like every
 * other service, because a direct property access throws when it is absent.
 * A profile without it returns `undefined`, and the caller must then say so in
 * its log instead of silently treating "no archive data" as "nothing is
 * archived".
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {Set<string> | undefined} the archived ids, or undefined when unseen.
 */
function archivedIds(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const ids = registry.archivedSessionIds
    if (ids === undefined || ids === null) return undefined
    return new Set(Array.from(ids, id => String(id)))
  } catch (error) {
    console.error('[restart-handoff] could not read the archived session ids:', error)
    return undefined
  }
}

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
  const archived = archivedIds(ctx)
  if (archived === undefined) {
    console.error('[restart-handoff] collecting: no workspace view available, relying on the live registry alone')
  }
  const ids = []
  for (const root of roots) {
    const id = root?.id
    if (typeof id !== 'string' || id === '') continue
    if (id === callerId) {
      // The caller is never dropped: it asked for the restart and must come
      // back even if it happens to be archived (it cannot be, or its own
      // step would have been gated — but the plan must not depend on that).
      ids.push(id)
      continue
    }
    if (settings.resumeRunningSessions === false) continue
    if (archived !== undefined && archived.has(id)) {
      console.error(`[restart-handoff] collecting: ${id} skipped (archived)`)
      continue
    }
    const busy = await isResumableRoot(ctx, root)
    if (!busy) {
      // Open but with nothing in flight: it is not a restart target. It stays
      // on disk and the user can reopen it; resuming it would put a silent
      // idle agent back into the registry.
      console.error(`[restart-handoff] collecting: ${id} skipped (nothing in flight)`)
      continue
    }
    ids.push(id)
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
  // Every path returns the same shape — the ledger the scan consults — so a
  // caller never has to guess whether it got an array or an object.
  const nothing = { resumed: [], nudged: [], children: [] }
  // A confirmation never survives the restart it was meant to authorize: the
  // fresh process has no pending warning for the model to confirm against.
  await clearRecord(settings, PENDING_FILE)

  const record = await readRecord(settings, HANDOFF_FILE)
  if (record === undefined) return nothing
  if (record.phase === 'resumed') {
    await clearRecord(settings, HANDOFF_FILE)
    return nothing
  }
  const age = Date.now() - Number(record.createdAt ?? 0)
  if (!Number.isFinite(age) || age < 0 || age > Number(settings.handoffTtlMs ?? DEFAULTS.handoffTtlMs)) {
    console.error('[restart-handoff] stale handoff record, not replaying it')
    await clearRecord(settings, HANDOFF_FILE)
    return nothing
  }
  if (record.createdByPid === process.pid) {
    // The same process wrote it and never went away: the restart did not happen.
    console.error('[restart-handoff] handoff record belongs to this process, not replaying it')
    return nothing
  }

  const entries = Array.isArray(record.sessions) && record.sessions.length > 0
    ? record.sessions
    : [{ id: String(record.sessionId ?? ''), kind: 'initiator' }]
  const reason = record.reason ?? 'no reason recorded'
  const intro = `The Harness restarted (${reason}).`

  const resumed = []
  const nudgedSessions = []
  const wokenChildren = []
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

    let woken = []
    if (record.resumeSubagents === true) {
      woken = await wakeSubagents(ctx, sessionId, record)
    }
    for (const childId of woken) wokenChildren.push(childId)

    // The initiator asked for the restart, so it gets the request back. A peer
    // is only carried along: it was running when the restart happened and its
    // own work is what it must pick up. The message therefore speaks about
    // THAT session — telling it that "the other running sessions were resumed
    // too" put a fact about other conversations into its own transcript, where
    // it is noise and reads like a broadcast rather than an instruction.
    const text = entry.kind === 'peer'
      ? `${intro} Your session was resumed — continue the work that was in flight.`
      : `${intro} Continue the work below.\n\n${record.continuePrompt}`
    // A freshly resumed agent may already be carrying work (the resume itself
    // can open a turn), so the same claim check applies here: a delivery that
    // was never claimed must not be reported as a replay.
    const delivery = await deliverContinue(agent, text)
    if (!delivery.claimed) {
      console.error(`[restart-handoff] WARNING: the handoff instruction was not claimed for ${sessionId}: ${delivery.reason}`)
    } else {
      nudgedSessions.push(sessionId)
    }
    // The fate of one planned session, on its own line: it was resumed, and
    // this is how many of its subagents were woken. A restored parent whose
    // count is 0 was resumed for its own in-flight work (or as the durable
    // parent of a child that could not be woken — that case is logged as
    // NOT WOKEN above).
    console.error(`[restart-handoff] plan: ${sessionId} RESTORED+WOKEN woken=${woken.length}`)
  }

  for (const entry of resumed) {
    await wakeTeamMembers(ctx, entry.agent, record)
  }
  console.error(`[restart-handoff] replayed the handoff: ${resumed.length} session(s) resumed`)

  if (resumed.length === 0) {
    // Not one id in this record names a real session. Replaying it is
    // pointless, and leaving it in place makes EVERY following restart repeat
    // the same empty replay — observed in production, where a record carrying
    // the literal id "caller" was re-attempted on each boot. It is not a
    // handoff this plugin can honour, so it is dropped rather than kept.
    console.error('[restart-handoff] the handoff record names no resumable session, dropping it')
    await clearRecord(settings, HANDOFF_FILE)
    // The same shape as the ledger below, so a caller never has to guess
    // whether it got an array or an object.
    return { resumed: [], nudged: [], children: [] }
  }

  await writeRecord(settings, HANDOFF_FILE, { ...record, phase: 'resumed', resumedAt: Date.now() })
  await clearRecord(settings, HANDOFF_FILE)
  // The ledger travels with the result, because the scan that runs after this
  // needs to know what was ALREADY delivered. The replay resumes a session,
  // which makes it live; by the time the scan reaches it, the log still shows
  // the turn this delivery is answering — the fresh turn is not finished — so
  // the scan would see a live session with work in flight and wake it a
  // second time. The user would get two "continue" instructions for one
  // restart.
  //
  // Only deliveries that were actually CLAIMED are recorded, so a failed one
  // can still be retried by the scan: the duplicate is prevented, the
  // recovery is not.
  return {
    resumed: resumed.map(entry => entry.agent.id),
    nudged: nudgedSessions,
    children: wokenChildren,
  }
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
async function wakeSubagents(ctx, sessionId, record, alreadyWoken = new Set()) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined) return []
  const descendants = await listSubagents(ctx, sessionId)
  // A teammate belongs to the Team roster: the Team path wakes it, with the
  // Team's own wording. Waking it here as well would tell the same child to
  // continue twice, once queued and once steered.
  const teamMembers = await teamMemberIds(ctx, ctx.get('agents')?.get?.(sessionId))
  console.error(`[restart-handoff] wake: parent=${sessionId} descendants=${descendants.length} team=${teamMembers.size}`)
  // WHO to wake is decided by the child's own log, never by its mode: a
  // one-shot child that was cut off mid-turn has work in flight just like a
  // continuable one, and a child that finished must not be woken at all.
  const candidates = descendants
    .filter(child => typeof child?.id === 'string' && child.id !== '' && !teamMembers.has(child.id))
    .sort((left, right) => (left.depth ?? 0) - (right.depth ?? 0))
  const woken = []
  for (const child of candidates) {
    // A child that was already woken this boot — by the handoff replay, before
    // the scan got here — must not be woken twice. It is live now and its log
    // still shows the turn that delivery is answering, so the criterion would
    // say "cut off" again.
    if (alreadyWoken.has(child.id)) {
      console.error(`[restart-handoff] subagent ${child.id} left asleep (already woken this boot)`)
      continue
    }
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
  if (teams === undefined || lead === undefined || lead === null) return []
  // Decide membership BEFORE polling. A session that is not a Lead has no
  // roster, and the reconcile poll below costs up to 5s; paying that for every
  // live session turned the recovery into a multi-minute stall (measured: 20
  // live sessions never finished the scan within 60s).
  let membership
  try {
    membership = teams.tryMembership?.(lead)
  } catch {
    return []
  }
  if (membership?.role !== 'lead') return []
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
 * Three durable fingerprints of the TAIL turn, any one of which means the
 * session was lost with work in flight:
 *  - an unclosed turn (the last `turn/start` has no `turn/end`) — the writer
 *    never got to close it;
 *  - the last `turn/end` is `interrupted` — the session layer closed an
 *    orphaned turn after the fact;
 *  - the last `turn/end` is `aborted` with a `disposed` cause — the process
 *    was torn down mid-turn.
 *
 * A committed `assistant/message` carrying `interrupted: true` is NOT a
 * fingerprint on its own, and deliberately so: it is a HISTORICAL trace. One
 * long conversation accumulates dozens of them (a stream the user stopped, a
 * retried attempt), so treating the marker as a standalone criterion
 * resurrects essentially the whole corpus — measured on the live store, 38
 * root sessions, which is exactly the over-recovery the user rejected. It
 * only corroborates the ONE case where the tail says nothing: the log ends on
 * a `turn/end` whose reason is missing or unknown AND the last message of
 * that turn was marked interrupted.
 *
 * A turn the human stopped (`aborted` + `user`), one that finished
 * (`completed`), one that failed (`error`) and one that hit the token ceiling
 * (`max-tokens`) had nothing in flight and must stay dead.
 * @param {object[]} events - the events of one session log.
 * @returns {{ cutOff: boolean, reason: string }} the verdict and its cause.
 */
function cutOffReason(events) {
  // The raw log decides the strongest fingerprint first: a turn that never
  // ended is a cut-off whether or not the reader balanced it afterwards, and
  // balancing would erase exactly that evidence.
  const raw = Array.isArray(events) ? events : []
  const began = raw.filter(event => event?.type === 'turn/start')
  const closed = raw.filter(event => event?.type === 'turn/end')
  if (began.length > closed.length) return { cutOff: true, reason: 'unclosed-turn' }
  const list = balanceLog(raw)
  const ends = list.filter(event => event?.type === 'turn/end')
  const endReason = ends.at(-1)?.data?.reason
  if (endReason?.kind === 'interrupted') return { cutOff: true, reason: 'interrupted' }
  if (endReason?.kind === 'aborted' && endReason.reason?.kind === 'disposed') {
    return { cutOff: true, reason: 'aborted+disposed' }
  }
  // Corroboration only, and only where the tail is silent: an unmarked
  // interrupted message says nothing about a turn that already reported a
  // reason of its own.
  if (endReason?.kind === undefined) {
    const lastTurn = began.at(-1)?.data?.turn
    const interruptedTail = list.some(event => event?.type === 'assistant/message'
      && event?.data?.interrupted === true
      && (lastTurn === undefined || event?.data?.turn === lastTurn))
    if (interruptedTail) return { cutOff: true, reason: 'interrupted-message' }
  }
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
 * How long a delivered instruction may sit unclaimed before it counts as lost.
 *
 * Only a NON-running agent pays this window: an idle agent claims within
 * milliseconds, and a running agent is exempt because a parked message is its
 * normal state. So this bounds the failure case, not the happy one — and it is
 * paid once per stuck session, which is why it must stay small enough that a
 * few stuck sessions cannot add up to a stall. Five seconds is already two
 * orders of magnitude beyond a healthy claim.
 */
const DELIVERY_CLAIM_TIMEOUT_MS = 5 * 1000

/**
 * How long to watch a freshly delivered message before calling it parked.
 *
 * On an idle agent the driver claims within milliseconds, so this window is
 * what separates "claimed" from "possibly dropped". On a RUNNING agent a parked
 * message is the expected state, so this only decides how long to look before
 * saying so — it must stay short, because it is paid per session.
 */
const QUEUE_SETTLE_MS = 1500

/**
 * How long to wait for an agent to settle before delivering.
 *
 * Only a non-running agent reaches this wait. A `maintenance` phase reports
 * `idle` but runs no turn, and it converges on its own, so waiting is right —
 * but it must be bounded well below the whole scan budget. Measured: the
 * previous 30s here is what turned a restart into 110 seconds when several
 * sessions were busy.
 */
const IDLE_WAIT_TIMEOUT_MS = 3 * 1000

/**
 * The most one delivery may ever cost, retries and cancels included.
 *
 * A healthy delivery returns in milliseconds; this only bounds the stuck case,
 * and it is what keeps the scan's total time independent of how many sessions
 * are stuck. Measured with the budget: a stuck idle session costs ~6s instead
 * of the 13s the unbounded stages added up to.
 */
const DELIVERY_TOTAL_BUDGET_MS = 6 * 1000

/**
 * Whether one message is still waiting in the agent's inbox.
 *
 * `inbox.nextTurn` / `inbox.nextStep` are the host's public pending lists and
 * are exactly what `hasPending` folds. Watching the message leave is the only
 * honest proof that the driver claimed it: `followup()` returning cleanly
 * proves only that the splice succeeded.
 * @param {object} agent - the live agent.
 * @param {string} messageId - the identity of the delivered message.
 * @returns {boolean} true while the message is still queued.
 */
function stillQueued(agent, messageId) {
  const pending = [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]
  return pending.some(message => message?.id === messageId)
}

/**
 * Deliver a continue instruction to a LIVE agent and verify it actually runs.
 *
 * ## Why a bare `followup()` is not enough
 *
 * `followup()` splices the message into the inbox and then calls
 * `wakeDriver()`. In `packages/core/agent-loop/src/agent.ts:214` a wake while
 * `phase.kind !== 'idle'` does not start a turn: it is latched ONLY for
 * `maintenance` or for a wake whose activity is already aborted (`:220-223`).
 * A live `running` driver is expected to claim the queue itself, but it does so
 * only after it reaches its own `if (!this.inbox.hasPending) return false`
 * check (`:392`). A message spliced after that check while the phase is still
 * `running` is therefore claimed by nobody — and nothing throws, so the log
 * says the nudge was delivered while no turn ever starts. That is the silent
 * failure this helper exists to close.
 *
 * ## What it does instead
 *
 * The delivery strategy depends on what the agent is doing, because "still in
 * the queue" means opposite things in the two states:
 *
 *  - `running` — a parked message is NORMAL. The driver re-checks
 *    `inbox.hasPending` at its own turn boundary (`agent.ts:392`) and starts the
 *    next turn with whatever is queued, so `followup()` has already done the
 *    whole job. Waiting for idle here was the bug that cost 110s per restart:
 *    a busy agent may not be idle for the whole window, and it never needed to
 *    be. Confirmation is a short observation that the message is queued or
 *    gone, and then the delivery is done.
 *  - `idle` — a parked message after a short window means the wake was dropped.
 *    Only here is cancel-and-retry the right move.
 *  - maintenance — `status` reports `idle` (:141) but the phase cannot run a
 *    turn, so this is the one state worth WAITING on rather than cancelling:
 *    it converges on its own and replays a latched wake.
 *
 * `claimed` therefore means "a turn is running, or will run, because of this",
 * and `queued` records that the message is parked on a live driver on purpose.
 * @param {object} agent - the live agent.
 * @param {string} text - the instruction text.
 * @param {{ idleTimeoutMs?: number, claimTimeoutMs?: number, queueSettleMs?: number }} [options] - overrides for tests.
 * @returns {Promise<{ delivered: boolean, claimed: boolean, queued: boolean, attempts: number, reason: string }>}
 */
async function deliverContinue(agent, text, options = {}) {
  const idleTimeoutMs = Number(options.idleTimeoutMs ?? IDLE_WAIT_TIMEOUT_MS)
  const claimTimeoutMs = Number(options.claimTimeoutMs ?? DELIVERY_CLAIM_TIMEOUT_MS)
  const queueSettleMs = Number(options.queueSettleMs ?? QUEUE_SETTLE_MS)
  // One budget for the WHOLE delivery, so the failure path cannot add up: the
  // healthy paths return long before it matters, and a stuck session costs at
  // most this much ONCE however many stages it walks through. Without it the
  // retry stages stacked (measured 13s per stuck session), and several stuck
  // sessions turned a restart into a stall.
  const startedAt = Date.now()
  const remaining = () => Math.max(0, DELIVERY_TOTAL_BUDGET_MS - (Date.now() - startedAt))
  const waitIdle = async (timeoutMs = idleTimeoutMs) => {
    if (typeof agent?.whenIdle !== 'function') return 'no-when-idle'
    const budget = Math.min(timeoutMs, remaining())
    if (budget <= 0) return 'budget-spent'
    const settled = await Promise.race([
      agent.whenIdle().then(() => 'idle', () => 'idle'),
      new Promise(resolve => { setTimeout(() => resolve('timeout'), budget) }),
    ])
    return settled
  }
  const waitClaim = async (messageId, timeoutMs = claimTimeoutMs) => {
    const budget = Math.min(timeoutMs, remaining())
    const deadline = Date.now() + budget
    while (Date.now() < deadline) {
      if (!stillQueued(agent, messageId)) return true
      await new Promise(resolve => { setTimeout(resolve, 50) })
    }
    return !stillQueued(agent, messageId)
  }

  // A busy agent consumes the queue at its own boundary, so waiting for idle
  // would burn the whole window for nothing. Only a maintenance phase is worth
  // waiting on: it reports `idle` but runs no turn, and it replays a latched
  // wake when it converges.
  const statusBefore = agent?.status
  const idle = statusBefore === 'running' ? 'skipped:running' : await waitIdle(idleTimeoutMs)

  const message = userMessage(text)
  try {
    agent.followup(message)
  } catch (error) {
    return { delivered: false, claimed: false, queued: false, attempts: 0, reason: `followup-failed: ${error instanceof Error ? error.message : String(error)}` }
  }

  // A live driver owns the queue: either it claims the message (departed) or it
  // will at its next boundary (parked). Both are delivery, not failure.
  if (await waitClaim(message.id, queueSettleMs)) {
    return { delivered: true, claimed: true, queued: false, attempts: 1, reason: `idle=${idle} claimed` }
  }
  if (agent?.status === 'running' && stillQueued(agent, message.id)) {
    return { delivered: true, claimed: true, queued: true, attempts: 1, reason: `idle=${idle} queued for the next turn of the running driver` }
  }
  if (await waitClaim(message.id, claimTimeoutMs)) {
    return { delivered: true, claimed: true, queued: false, attempts: 1, reason: `idle=${idle} claimed after waiting` }
  }

  // Only now is the message a drop: nothing claimed it and no driver is live.
  try {
    agent.cancel?.({ kind: 'restart-handoff' }, { keepInbox: true })
  } catch (error) {
    console.error('[restart-handoff] could not cancel the stuck activity:', error)
  }
  await waitIdle()
  if (stillQueued(agent, message.id) && await waitClaim(message.id, claimTimeoutMs)) {
    return { delivered: true, claimed: true, queued: false, attempts: 1, reason: `idle=${idle} claimed after cancel` }
  }
  const retry = userMessage(text)
  try {
    agent.followup(retry)
  } catch (error) {
    return { delivered: false, claimed: false, queued: false, attempts: 1, reason: `retry-failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (await waitClaim(retry.id, claimTimeoutMs)) {
    return { delivered: true, claimed: true, queued: false, attempts: 2, reason: `idle=${idle} retried` }
  }
  if (stillQueued(agent, retry.id) && agent?.status === 'running') {
    return { delivered: true, claimed: true, queued: true, attempts: 2, reason: `idle=${idle} queued for the next turn of the running driver (after retry)` }
  }
  return { delivered: true, claimed: false, queued: false, attempts: 2, reason: `idle=${idle} NOT CLAIMED: the wake was dropped and the retry did not take` }
}

/**
 * Safety margin added to the harvest window before a `stat` may skip a session.
 *
 * The pre-filter compares a log file's mtime against the last event's `time`,
 * which are stamped by the same write. Measured over all 137 sessions of the
 * live store, `lastEventTime - mtime` never exceeded 5.7ms. A minute of slack
 * costs nothing in reads (a session inside the window is read anyway) and
 * makes the filter strictly more conservative than the rule it pre-decides.
 */
const STALE_PRE_FILTER_SLACK_MS = 60 * 1000

/**
 * Filesystem-safe form of one path segment, mirroring the persistence layer.
 *
 * The jsonl backend stores a session under `sessions/--<projectKey>--/<segment>`
 * and encodes both the project directory and the session id with the same rule:
 * `[A-Za-z0-9._-]` passes through, every other UTF-16 code unit becomes
 * `~XXXX`. Reproduced here because the scan needs the session's log FILE, and
 * the persistence layer exposes no path — only a header and an id.
 * @param {string} raw - the id or path segment.
 * @returns {string} the encoded segment.
 */
function encodeSegment(raw) {
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * The project directory name for a session's working directory.
 *
 * Separators and the Windows drive colon collapse to one `-`; other unsafe
 * code units use the same escape as {@link encodeSegment}. The name is bounded
 * to the filesystem component limit.
 * @param {string} cwd - the session's project directory.
 * @returns {string} the project directory name.
 */
function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  // A separator RUN collapses to one dash, and a run at either end collapses
  // into the surrounding `--` wrapper instead of leaving a stray dash:
  // "/home/user/" must be `--home-user--`, not `--home-user---`.
  const slug = readable.replace(/^-+|-+$/g, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * The mtime of a session's durable log, or `undefined` when it cannot be read.
 *
 * Reading a timestamp costs one `stat`; reading the log costs a full
 * decompress-and-parse of every event. On the live store 87 of the scan's 91
 * seconds went to 49 such reads, and most of those sessions were then thrown
 * away as older than the window. So the window is decided from the filesystem
 * before any log is read.
 *
 * WHY MTIME IS THE RIGHT PROXY. The scan's stale rule looks at the `time` of
 * the LAST event in the log. A log is appended as events happen, so the file's
 * mtime is stamped by the same write as its last event: measured over all 137
 * sessions of the live store, `lastEventTime - mtime` never exceeded 5.7ms.
 * mtime can therefore never be much OLDER than the last event, which makes the
 * filter CONSERVATIVE — a session interrupted a moment ago has a recent mtime
 * and can never be skipped. {@link STALE_PRE_FILTER_SLACK_MS} keeps the filter
 * on the safe side of that measurement.
 *
 * `header.createdAt` is NOT usable here and is deliberately not used: it is the
 * session's CREATION time and a fork inherits its parent's. At the default
 * two-hour window, 25 sessions of that store had a last event inside the window
 * while their `createdAt` said otherwise — including `session-e8d56666`, which
 * a createdAt filter would have dropped and the durable criterion keeps.
 * @param {string} sessionId - the session id.
 * @param {string | undefined} cwd - the session's recorded working directory.
 * @param {number} now - the scan's reference instant.
 * @param {number} maxAgeMs - the harvest window.
 * @returns {Promise<{ stale: boolean, mtime?: number }>} whether the log is
 *   provably outside the window, and the mtime when it could be read.
 */
async function staleByLogMtime(sessionId, cwd, now, maxAgeMs) {
  const home = process.env.DSH_HOME ?? process.cwd()
  const root = pathJoin(home, 'sessions')
  const dir = pathJoin(root, projectKey(cwd ?? ''), encodeSegment(sessionId))
  for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
    let stats
    try {
      stats = await fsStat(pathJoin(dir, file))
    } catch {
      continue
    }
    return { stale: now - stats.mtimeMs > maxAgeMs + STALE_PRE_FILTER_SLACK_MS, mtime: stats.mtimeMs }
  }
  // No stat means no proof: an unreadable path must never be a reason to skip
  // a session. Fall through to the log, which decides on the durable criterion.
  return { stale: false, mtime: undefined }
}

/** Zstandard frame magic, little-endian. */
const ZSTD_MAGIC = 0xfd2fb528

/** The same magic as bytes, for a substring scan over a raw window. */
const ZSTD_MAGIC_BUFFER = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** How much of the file's tail one attempt reads before widening. */
const TAIL_INITIAL_BYTES = 64 * 1024

/** Consecutive widenings after which the tail read gives up and the log decides. */
const TAIL_MAX_WIDENINGS = 12

/**
 * The log path of a session, in the persistence layer's own layout.
 * @param {string} sessionId - the session id.
 * @param {string | undefined} cwd - the session's recorded working directory.
 * @returns {string[]} candidate log paths, compressed first.
 */
function sessionLogPaths(sessionId, cwd) {
  const home = process.env.DSH_HOME ?? process.cwd()
  const dir = pathJoin(pathJoin(home, 'sessions'), projectKey(cwd ?? ''), encodeSegment(sessionId))
  return [pathJoin(dir, 'session.v4.jsonl.zstd'), pathJoin(dir, 'session.v4.jsonl')]
}

/**
 * Offsets of every Zstandard frame in `buf`, from the frame headers.
 *
 * Only the header is parsed — the frame's content size field and its block
 * headers give the frame length, so no frame is decompressed to find the next
 * one. A trailing partial frame (a torn write) is simply not reported, which is
 * what makes a truncated log fall back instead of guessing.
 * @param {Buffer} buf - a byte window expected to start on a frame boundary.
 * @returns {number[]} the offset of each complete frame.
 */
function frameOffsets(buf) {
  const starts = []
  let off = 0
  while (off + 4 <= buf.length) {
    if (buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    const fhd = buf[off + 4]
    const fcsFlag = (fhd >> 6) & 0x3
    const singleSegment = (fhd >> 5) & 1
    const hasChecksum = (fhd >> 2) & 1
    const dictIdFlag = fhd & 0x3
    let p = off + 5
    if (!singleSegment) p += 1
    p += [0, 1, 2, 4][dictIdFlag]
    p += [singleSegment ? 1 : 0, 2, 4, 8][fcsFlag]
    let q = p
    for (;;) {
      if (q + 3 > buf.length) { q = -1; break }
      const bh = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16)
      const lastBlock = bh & 1
      const blockType = (bh >> 1) & 0x3
      const blockSize = (bh >> 3) & 0x1ffff
      q += 3
      q += blockType === 1 ? 1 : blockSize
      if (lastBlock === 1) break
    }
    if (q < 0 || q <= off) break
    if (hasChecksum) q += 4
    starts.push(off)
    off = q
  }
  return starts
}

/**
 * The verdict on a LOG TAIL: was the session's LAST turn cut off?
 *
 * The log decides the same question the durable criterion does, but it answers
 * it from the final turn boundary instead of from whole-file counts. That is
 * exactly what a session's own tail can supply, so the scan can read a few
 * kilobytes instead of decompressing a 20k-event log.
 *
 * The rule, over the events of the window:
 *  - no turn at all (a seed-only or empty log) → nothing was in flight;
 *  - a `turn/start` with no `turn/end` after it, or a last `turn/end` for an
 *    EARLIER turn than the last `turn/start` → the tail turn never closed;
 *  - last `turn/end` reason `interrupted`, or `aborted` + `disposed` → the
 *    session layer / the process closed an orphaned turn;
 *  - otherwise → the turn reported its own reason and nothing was in flight.
 * @param {object[]} events - the window's events, in log order.
 * @returns {{ cutOff: boolean, reason: string }} the verdict and its cause.
 */
function tailCutOffReason(events) {
  const list = Array.isArray(events) ? events : []
  let lastStart
  let lastEnd
  for (const event of list) {
    if (event?.type === 'turn/start') lastStart = event
    else if (event?.type === 'turn/end') lastEnd = event
  }
  if (lastStart === undefined && lastEnd === undefined) return { cutOff: false, reason: 'no-turn-end' }
  if (lastStart !== undefined && lastEnd === undefined) return { cutOff: true, reason: 'unclosed-turn' }
  const startTurn = lastStart?.data?.turn
  const endTurn = lastEnd?.data?.turn
  if (startTurn !== undefined && startTurn > endTurn) return { cutOff: true, reason: 'unclosed-turn' }
  const endReason = lastEnd?.data?.reason
  if (endReason?.kind === 'interrupted') return { cutOff: true, reason: 'interrupted' }
  if (endReason?.kind === 'aborted' && endReason.reason?.kind === 'disposed') {
    return { cutOff: true, reason: 'aborted+disposed' }
  }
  // Corroboration for a tail turn that reports no reason. `cutOffReason` does
  // this over the whole log, and the two criteria must never disagree on a log
  // they both see. Measured on the live store they agree on 134/134 sessions,
  // but that agreement must not depend on every tail happening to carry a
  // reason: a window that holds an interrupted message for the NEWEST turn
  // holds exactly the evidence the whole log would have used.
  if (endReason?.kind === undefined) {
    const interruptedTail = list.some(event => event?.type === 'assistant/message'
      && event?.data?.interrupted === true
      && (startTurn === undefined || event?.data?.turn === startTurn))
    if (interruptedTail) return { cutOff: true, reason: 'interrupted-message' }
  }
  return { cutOff: false, reason: endReason?.kind === undefined ? 'no-turn-end' : String(endReason.kind) }
}

/**
 * Whether a window ends at a point that can be judged: it holds a `turn/end`,
 * or it holds the whole log.
 *
 * A tail window cut in the MIDDLE of a turn has neither a `turn/end` nor the
 * file's start. Judging it would call a perfectly finished session "unclosed",
 * so the caller widens instead. A fresh session that genuinely has an open turn
 * reaches the start of the file with a `turn/start` in hand — that window IS
 * judgeable, and `tailCutOffReason` reports the unclosed turn.
 * @param {object[]} events - the window's events.
 * @param {boolean} reachedStart - whether the window begins at the file start.
 * @returns {boolean} true when the window can decide on its own.
 */
function tailWindowComplete(events, reachedStart) {
  if (reachedStart) return true
  // A window can decide as soon as its LAST turn boundary is known — that is,
  // as soon as it contains a turn boundary at all. Whatever the newest one is:
  //  - a `turn/end` — the last turn closed, and its reason is the verdict;
  //  - a `turn/start` newer than every `turn/end` in the window — the last turn
  //    is still open, which IS the verdict.
  // No widening is needed for either case: the newest boundary in the window is
  // the newest boundary in the file, because the window runs to EOF. A window
  // with NO boundary at all is the only one that must widen.
  const list = Array.isArray(events) ? events : []
  return list.some(event => event?.type === 'turn/start' || event?.type === 'turn/end')
}

/**
 * Read a log's TAIL and, when the tail can answer, the cut-off verdict.
 *
 * Walks backward in byte windows: read the last chunk, find the frames in it,
 * decompress those frames, and stop as soon as the window holds a complete last
 * turn. Each widening doubles the window, so a normally-terminated session
 * costs one small read and a long turn costs a handful — never more than the
 * whole file, which is what `gaveUp` reports.
 * @param {string[]} paths - candidate log paths, compressed first.
 * @param {number} logSize - the file size, for the first window.
 * @returns {Promise<{ ok: boolean, events?: object[], reason?: string }>}
 *   `ok: false` means the tail could not decide and the caller must fall back.
 */
async function readLogTail(paths, logSize) {
  for (const file of paths) {
    let handle
    try {
      handle = await fsOpen(file, 'r')
    } catch {
      continue
    }
    try {
      let windowBytes = Math.min(TAIL_INITIAL_BYTES, logSize)
      for (let attempt = 0; attempt <= TAIL_MAX_WIDENINGS; attempt += 1) {
        if (windowBytes <= 0) return { ok: false, reason: 'empty' }
        const start = Math.max(0, logSize - windowBytes)
        const length = logSize - start
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, start)
        const raw = buf.subarray(0, bytesRead)
        // A window that does not begin on a frame boundary opens IN THE MIDDLE
        // of a frame, so the first bytes are not a frame header. Scan for the
        // first magic and start there: everything before it is the tail of a
        // frame whose head is outside the window, and it cannot be decompressed
        // on its own.
        const firstMagic = raw.indexOf(ZSTD_MAGIC_BUFFER)
        const window = firstMagic === -1 ? Buffer.alloc(0) : raw.subarray(firstMagic)
        const offsets = frameOffsets(window)
        const events = []
        for (let index = 0; index < offsets.length; index += 1) {
          const from = offsets[index]
          const to = index + 1 < offsets.length ? offsets[index + 1] : window.length
          let text
          try {
            text = zstdDecompressSync(window.subarray(from, to)).toString('utf8')
          } catch {
            // A frame that will not decompress is a torn or corrupt write: the
            // tail cannot be trusted, so the caller falls back to the log.
            return { ok: false, reason: 'corrupt-tail' }
          }
          for (const line of text.split('\n')) {
            if (line === '') continue
            let parsed
            try { parsed = JSON.parse(line) } catch { continue }
            if (parsed?.type === 'session') continue
            events.push(parsed)
          }
        }
        const reachedStart = start === 0
        if (events.length > 0 && tailWindowComplete(events, reachedStart)) {
          return { ok: true, events }
        }
        if (reachedStart) return { ok: true, events }
        windowBytes *= 2
      }
      return { ok: false, reason: 'window-too-small' }
    } finally {
      await handle.close().catch(() => {})
    }
  }
  return { ok: false, reason: 'no-log-file' }
}

/**
 * How many session logs the scan reads at once.
 *
 * Each read is a decompress-and-parse of a whole log, so it is I/O- and
 * CPU-bound rather than latency-bound: one read of a 20k-event session costs
 * seconds on its own. A small pool overlaps those reads without flooding the
 * disk or holding dozens of multi-megabyte event arrays in memory at once —
 * four is enough to keep the disk busy while bounding peak memory to roughly
 * four logs.
 */
const SESSION_READ_CONCURRENCY = 4

/**
 * Run `task` over `items` with at most `concurrency` in flight, IN ORDER.
 *
 * The result is positionally stable: `results[i]` is the outcome for
 * `items[i]` however the reads interleave, and a rejected task is reported at
 * its own index instead of aborting the batch. That is what makes the pool a
 * performance change only — the caller walks `results` in the original order
 * and reaches the same verdicts a serial loop would.
 *
 * Workers take items from one shared cursor, so a worker that finishes early
 * picks up the next item in decision order; nothing about the ORDER of the
 * results depends on which worker ran what.
 * @template T, R
 * @param {readonly T[]} items - the work items, in decision order.
 * @param {number} concurrency - the maximum number of tasks in flight.
 * @param {(item: T, index: number) => Promise<R>} task - the work per item.
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: unknown }>>}
 *   one outcome per item, in the input order.
 */
async function mapBounded(items, concurrency, task) {
  const results = new Array(items.length)
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length))
  let next = 0
  const run = async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await task(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, run))
  return results
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
 * @param {string[] | { resumed?: string[], nudged?: string[], children?: string[] }} [handoff] -
 *   what the handoff replay already did. An array is the older shape and means
 *   "these sessions were resumed" with nothing else recorded.
 * @returns {Promise<string[]>} the ids of the recovered sessions.
 */
async function recoverUnplannedSessions(ctx, settings, handoff = []) {
  if (settings.recoverInterruptedSessions === false) return []
  // The replay and this scan are independent paths that can both decide the
  // same session needs waking. The replay runs first and RESUMES the session,
  // which makes it live; by the time this scan reaches it, the log still shows
  // the turn that delivery is answering — the fresh turn is not finished — so
  // the criterion says "cut off" and the session would be woken a second time.
  // The user would get two "continue" instructions for one restart.
  //
  // Only deliveries that were actually claimed are in `nudged`, so a failed
  // one is still retried here: the duplicate is prevented, the recovery is not.
  const alreadyResumed = Array.isArray(handoff) ? handoff : (handoff?.resumed ?? [])
  const alreadyNudged = new Set(Array.isArray(handoff) ? [] : (handoff?.nudged ?? []))
  const alreadyWokenChildren = new Set(Array.isArray(handoff) ? [] : (handoff?.children ?? []))
  const query = ctx.get('sessionQuery')
  if (query === undefined) return []
  let records = []
  try {
    records = await query.listSessions()
  } catch (error) {
    console.error('[restart-handoff] could not list the sessions:', error)
    return []
  }
  const skipped = { noId: 0, child: 0, live: 0, replayed: 0, archived: 0, stale: 0, prefiltered: 0 }
  const scanStartedAt = Date.now()
  let readMs = 0
  let readCount = 0
  const recovered = []
  const maxAgeMs = Number(settings.recoverMaxAgeMs ?? DEFAULTS.recoverMaxAgeMs)
  const maxSessions = Number(settings.recoverMaxSessions ?? DEFAULTS.recoverMaxSessions)
  // Archiving is a user decision and the Host gates every step of an archived
  // session, so resuming one would create an agent that can never take a
  // step. When the archive set is unknown the scan keeps its strict criteria
  // and says so — it must never degrade into "every session".
  const archived = archivedIds(ctx)
  if (archived === undefined) {
    console.error('[restart-handoff] scan: no workspace view available, using the durable criterion alone')
  }
  // Newest first: the cap must keep the sessions the user actually has open.
  records = [...records].sort((a, b) => (b?.header?.createdAt ?? 0) - (a?.header?.createdAt ?? 0))
  // Phase 1 — the cheap filters that decide a session WITHOUT its log, in the
  // decision order the loop below uses: an id check, the live flag (its branch
  // has side effects and stays in the loop), the handoff replay set, the
  // archive set, and one `stat` for the mtime pre-filter. Only the survivors
  // reach the read.
  const pendingReads = []
  for (const record of records) {
    const id = record?.id ?? record?.header?.id
    if (typeof id !== 'string' || id === '') continue
    // The order here mirrors the decision loop below exactly, so a session is
    // counted under the SAME skip reason the serial scan would report: a
    // subagent child is out before its mtime is ever looked at, which keeps
    // `skipped-child` at its serial value and spares the `stat`.
    const isSubagentChild = record?.header?.origin === 'subagent'
      || (typeof record?.header?.delegationDepth === 'number' && record.header.delegationDepth > 0)
    if (isSubagentChild) continue
    if (record?.live === true) continue
    if (alreadyResumed.includes(id)) {
      skipped.replayed += 1
      console.error(`[restart-handoff] scan: ${id} skipped (replayed by the handoff)`)
      continue
    }
    if (archived?.has(id)) {
      skipped.archived += 1
      console.error(`[restart-handoff] scan: ${id} skipped (archived)`)
      continue
    }
    // The stale window is decided from the log file's mtime BEFORE the log is
    // read: reading it costs a full decompress-and-parse of every event, and
    // most candidates on a real store are long dead. The pre-filter is strictly
    // more conservative than the durable rule it pre-decides — see
    // `staleByLogMtime` — so a session it skips would have been skipped below
    // anyway, and a session interrupted a moment ago can never be skipped here.
    const prefilter = await staleByLogMtime(id, record?.header?.cwd, Date.now(), maxAgeMs)
    if (prefilter.stale) {
      skipped.prefiltered += 1
      console.error(`[restart-handoff] scan: ${id} skipped (older than the window, by mtime)`)
      continue
    }
    pendingReads.push({ id, cwd: record?.header?.cwd })
  }
  // Phase 2 — read those logs a few at a time. A read is pure, so overlapping
  // them cannot change a verdict; `mapBounded` hands back one outcome per id in
  // `pendingReads` order, which is the order phase 3 decides in. Only the READS
  // are concurrent — resuming, waking and the `maxSessions` cap all stay in the
  // serial loop below, because they have side effects and an order.
  const readStartedAt = Date.now()
  const readOutcomes = await mapBounded(pendingReads, SESSION_READ_CONCURRENCY, async (item) => {
    // The TAIL decides first: the question is whether the session's LAST turn
    // was cut off, and a few kilobytes at the end of the log answer it without
    // decompressing the rest. `readSession` remains the fallback — it is the
    // authority when the tail cannot be trusted (a single-frame file, a torn
    // write, a corrupt frame, a missing log), and it is also what the durable
    // criterion is defined on.
    const paths = sessionLogPaths(item.id, item.cwd)
    let size
    try {
      size = (await fsStat(paths[0])).size
    } catch {
      size = undefined
    }
    if (size !== undefined) {
      const tail = await readLogTail([paths[0]], size)
      if (tail.ok === true) return { viaTail: true, events: tail.events }
    }
    const snapshot = await query.readSession(item.id)
    return { viaTail: false, events: Array.isArray(snapshot?.events) ? snapshot.events : [] }
  })
  const eventsById = new Map()
  const verdictsById = new Map()
  let tailReads = 0
  let fullReads = 0
  for (let index = 0; index < pendingReads.length; index += 1) {
    const id = pendingReads[index].id
    const outcome = readOutcomes[index]
    readCount += 1
    if (outcome?.ok === true) {
      eventsById.set(id, outcome.value.events)
      if (outcome.value.viaTail === true) {
        tailReads += 1
        // A tail window is already the answer: `cutOffReason` over it would be
        // the global rule applied to a fragment, so the tail's own rule decides.
        verdictsById.set(id, tailCutOffReason(outcome.value.events))
      } else {
        fullReads += 1
      }
    } else {
      eventsById.set(id, undefined)
      console.error(`[restart-handoff] could not read the session ${id}:`, outcome?.error)
    }
  }
  readMs = Date.now() - readStartedAt
  for (const record of records) {
    const id = record?.id ?? record?.header?.id
    if (typeof id !== 'string' || id === '') {
      skipped.noId += 1
      console.error('[restart-handoff] scan: <no id> skipped (no id)')
      continue
    }
    const isSubagentChild = record?.header?.origin === 'subagent'
      || (typeof record?.header?.delegationDepth === 'number' && record.header.delegationDepth > 0)
    if (isSubagentChild) {
      skipped.child += 1
      console.error(`[restart-handoff] scan: ${id} skipped (subagent child)`)
      continue
    }
    if (record?.live === true) {
      skipped.live += 1
      // Being up now does not mean the restart left it alone: a human who
      // opened the conversation right after the crash makes it live before the
      // scan runs. So the log still decides whether this session has work in
      // flight, and the wake-up is delivered either way.
      const liveAgent = ctx.get('agents')?.get?.(id)
      const wokenChildren = await wakeSubagents(ctx, id, { reason: 'unexpected restart' }, alreadyWokenChildren)
      const wokenTeammates = await wakeTeamMembers(ctx, liveAgent, { reason: 'unexpected restart' })
      let nudged = false
      // The log decides, and it is read through the same helper the subagent
      // wake-up uses. NOT `cutOffReason`, which takes an EVENT ARRAY: passing a
      // context there silently yields `{ cutOff: false }` and the nudge would
      // never fire while the log looked perfectly healthy.
      const verdict = await wasSessionCutOff(ctx, id)
      if (alreadyNudged.has(id)) {
        // The handoff replay already delivered this session's continue
        // instruction. Its log still shows the turn that instruction is
        // answering — the fresh turn is not finished yet — so the criterion
        // above says "cut off" and would deliver a SECOND instruction for the
        // same restart. The user would see two "continue" prompts.
        // The Team wake above still runs: the replay never woke teammates.
        console.error(`[restart-handoff] scan: ${id} skipped (already live, continue already delivered this boot) woken=${wokenChildren.length} teammates=${wokenTeammates.length}`)
        continue
      }
      if (verdict.cutOff && liveAgent !== undefined && typeof liveAgent.followup === 'function') {
        try {
          // NOT a bare `followup()`: a wake sent while the driver is live but
          // past its last `hasPending` check is dropped without an error. The
          // helper waits for quiescence, delivers, and proves the message was
          // claimed before reporting success.
          const delivery = await deliverContinue(
            liveAgent,
            'The Harness process went down unexpectedly. Your session is open again — continue the work that was in flight.',
          )
          nudged = delivery.claimed
          const inboxAfter = liveAgent?.inbox
          if (!delivery.claimed) {
            console.error(`[restart-handoff] WARNING: the nudge was not claimed for ${id}: ${delivery.reason}`)
          }
          console.error(`[restart-handoff] scan: ${id} already live, told to continue (${verdict.reason}) status=${liveAgent?.status} claimed=${delivery.claimed} attempts=${delivery.attempts} nextTurn=${inboxAfter?.nextTurn?.length ?? '?'} ${delivery.reason}`)
        } catch (error) {
          console.error(`[restart-handoff] could not nudge the live session ${id}:`, error)
        }
      }
      console.error(`[restart-handoff] scan: ${id} skipped (already live) woken=${wokenChildren.length} teammates=${wokenTeammates.length} nudged=${nudged}`)
      continue
    }
    // Phase 1 has already decided the replay/archive/stale cases for this id,
    // so reaching here means the log was read in phase 2. Take it from there:
    // a missing entry is a read that failed, and it is reported once here.
    const loaded = eventsById.get(id)
    if (loaded === undefined) {
      // Already logged by phase 2; the session is left alone, exactly as the
      // serial `continue` on a failed read would have done.
      continue
    }
    const events = loaded
    // A tail read already produced the verdict (its window is the answer); a
    // full read goes through the durable whole-log rule, unchanged.
    const cutOff = verdictsById.get(id) ?? cutOffReason(events)
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
      // "finished" and "empty" are different facts and are logged apart: a
      // seed-only log says nothing either way, and calling it finished would
      // read like a judgement that was never made.
      const verdict = cutOff.reason === 'no-turn-end' ? 'no turn to judge' : `finished: ${cutOff.reason}`
      console.error(`[restart-handoff] scan: ${id} skipped (${verdict})`)
      continue
    }
    if (recovered.length >= maxSessions) break
    const agent = await resumeSession(ctx, id)
    if (agent === undefined) {
      console.error(`[restart-handoff] scan: ${id} NOT RESTORED (resume failed)`)
      continue
    }
    // Verified delivery: the session is only counted as recovered when the
    // continue instruction actually left the inbox (was claimed by a turn).
    const delivery = await deliverContinue(
      agent,
      'The Harness process went down unexpectedly and your session was resumed. Continue the work that was in flight.',
    )
    if (!delivery.claimed) {
      console.error(`[restart-handoff] WARNING: the recovery instruction was not claimed for ${id}: ${delivery.reason}`)
    }
    const woken = await wakeSubagents(ctx, id, { reason: 'unexpected restart' }, alreadyWokenChildren)
    // A teammate is not a subagent: the Team roster owns it, and it is woken
    // through the Team path. The handoff replay has always done this; the
    // unplanned-exit scan used to forget it, which left every teammate of the
    // session the user had open asleep after a crash.
    const wokenTeammates = await wakeTeamMembers(ctx, agent, { reason: 'unexpected restart' })
    recovered.push(id)
    console.error(`[restart-handoff] scan: ${id} restored (${cutOff.cutOff ? cutOff.reason : 'queued-work'}) woken=${woken.length} teammates=${wokenTeammates.length}`)
  }
  console.error(`[restart-handoff] scan: candidates=${records.length} restored=${recovered.length} skipped-live=${skipped.live} skipped-child=${skipped.child} skipped-replayed=${skipped.replayed} skipped-noId=${skipped.noId} skipped-prefiltered=${skipped.prefiltered} skipped-archived=${skipped.archived} took=${Date.now() - scanStartedAt}ms reads=${readCount} tailReads=${tailReads} fullReads=${fullReads} readMs=${readMs}`)
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
      // The token must reach the caller: it is the ONLY way to make the
      // second, confirming call, and `message` alone never carries it. The
      // plan (reason and the sessions that will be resumed) is shown next to
      // it, so the model confirms something it actually saw.
      render: (_args, value) => {
        if (value === null || typeof value !== 'object') {
          return [{ type: 'text', text: JSON.stringify(value) }]
        }
        const lines = [value.message ?? JSON.stringify(value)]
        if (typeof value.confirmToken === 'string' && value.confirmToken !== '') {
          lines.push(`confirmToken: ${value.confirmToken}`)
        }
        if (value.reason !== undefined && value.reason !== '') {
          lines.push(`reason: ${value.reason}`)
        }
        if (Array.isArray(value.sessions)) {
          lines.push(`sessions that will be resumed (${value.sessions.length}): ${value.sessions.length > 0 ? value.sessions.join(', ') : 'none'}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
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
            `confirmToken: ${token}`,
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
      // The Host's own plugins and MCP servers finish registering after this
      // bundle's apply() returns. A session resumed before they are up is
      // handed a shorter tool list, and its transcript says so. Waiting for
      // the registry to settle costs a moment and removes the difference.
      //
      // The wait is a refinement, never a precondition: if it fails, the
      // recovery still runs. A refinement that can throw must never stand
      // between a restart and the sessions it is meant to bring back — that
      // is how one restart ended up recovering nothing at all.
      void waitForToolProviders(ctx, Number(settings.resumeSettleMs ?? DEFAULTS.resumeSettleMs))
        .then(
          (settled) => {
            console.error(`[restart-handoff] the prompt registry ${settled.settled ? 'settled' : 'did not settle'} after ${settled.waitedMs}ms (${settled.changes} change notifications)`)
          },
          (error) => {
            console.error('[restart-handoff] could not wait for the prompt registry; recovering anyway:', error)
          },
        )
        .then(() => runHandoff(ctx, settings))
        .then((handoff) => recoverUnplannedSessions(ctx, settings, handoff ?? []))
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
  DELIVERY_CLAIM_TIMEOUT_MS,
  DELIVERY_TOTAL_BUDGET_MS,
  DEFAULTS,
  IDLE_WAIT_TIMEOUT_MS,
  QUEUE_SETTLE_MS,
  STALE_PRE_FILTER_SLACK_MS,
  HANDOFF_FILE,
  PENDING_FILE,
  archivedIds,
  balanceLog,
  collectRestartTargets,
  collectStrings,
  createRestartGuard,
  createRestartTool,
  cutOffReason,
  dangerousSegments,
  deliverContinue,
  encodeSegment,
  hasPendingWork,
  headVerb,
  isCommandTool,
  isResumableRoot,
  isRootSession,
  killsSelf,
  lastRequestHeader,
  listResumableSessions,
  listSubagents,
  projectKey,
  readRecord,
  recoverUnplannedSessions,
  resumeSession,
  routeFor,
  runHandoff,
  selfKillSegments,
  SESSION_READ_CONCURRENCY,
  readLogTail,
  sessionLogPaths,
  staleByLogMtime,
  tailCutOffReason,
  tailWindowComplete,
  stillQueued,
  mapBounded,
  teamMemberIds,
  wakeSubagents,
  wakeTeamMembers,
  waitForToolProviders,
  wasSessionCutOff,
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
