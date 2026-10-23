# dsh-restart-handoff

Restart the DeepSeek Harness from inside the conversation and come back to the
work — without a human typing "continue".

## What it does

The model restarts the Host through **one dedicated tool**, `restart_dsh`, in
**two steps**:

1. **Warning call.** The tool records nothing that restarts anything. It
   returns a warning: the reason, the instruction that will be replayed, the
   sessions that will be resumed, and a **confirmation token**. The model must
   come back with that token, so a restart is never a single stray call — the
   agent gets a second chance to state the plan.
2. **Confirmation call.** With the matching token, the tool writes the handoff
   record (`$DSH_HOME/restart/handoff.json`): the sessions that were running,
   the reason, the pending instruction (`continuePrompt`), and the continuable
   subagents. The session log is flushed, the tool waits for the current turn
   to go idle, and the process signals itself. The unit's `Restart=always`
   brings a fresh process up.
3. **Replay.** The fresh process reads the handoff record and
   - **resumes every session that was running** when the restart started, and
     wakes it with a message that tells it to continue,
   - **wakes the continuable subagents** again, top-down, so a child is only
     delivered to while its own parent is live,
   - hands the `continuePrompt` to the session that asked for the restart,
   - reconciles an Agent Team roster and wakes its teammates.

A **planned** restart is the case above. An **unplanned** one — a crash, a
kill, a power cut — leaves no handoff record, so on the next start the plugin
scans the persisted sessions and brings back the ones whose last turn was
interrupted, plus the ones whose inbox still holds a prompt that never
started.

## Why the model never runs the restart itself

`systemctl --user restart dsh.service` from inside the service dies with the
very stop it asks for. A `bash` call like that also loses the tool result, the
turn, and the session's live agent. The plugin therefore:

* exposes the restart as a **tool**, and
* **guards the tools that execute**: a command that looks like a Harness
  restart is denied with a message naming `restart_dsh`.

The guard is described in full under *Why it is built this way* below.

## Configuration (`cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `serviceUnit` | `dsh.service` | The systemd user unit that supervises the process. |
| `handoffDir` | `$DSH_HOME/restart` | Where the handoff record is written. |
| `autoResume` | `true` | Replay the handoff record on the next start. |
| `resumeSubagents` | `true` | Wake the continuable subagents after the resume. |
| `resumeRunningSessions` | `true` | Also resume the other sessions that were running or hold queued work. |
| `pendingTtlMs` | `300000` | A confirmation token older than this is refused. |
| `idleTimeoutMs` | `30000` | How long the tool waits for the turn to go idle before signalling. |
| `handoffTtlMs` | `1800000` | A record older than this is stale and is not replayed. |
| `recoverInterruptedSessions` | `true` | Recover the sessions an unplanned exit left behind. |
| `recoverMaxAgeMs` | `7200000` | How old an interrupted session may be and still be recovered. |
| `recoverMaxSessions` | `50` | How many interrupted sessions one start may recover. |
| `dryRun` | `false` | Write the handoff record but never signal the process. |

The row in `cordis.patch.yml` overrides any of them:

```yaml
- insert:
    - id: restart-handoff
      name: 'dsh-restart-handoff'
      config:
        serviceUnit: 'dsh.service'
        autoResume: true
        resumeSubagents: true
        idleTimeoutMs: 30000
```

## Installation

The plugin is a plain host bundle: a `name`, an `inject` list and an `apply`.
Install it with the Harness plugin manager, pointing the target at this
directory:

```
plugin_manager → install_bundle → target: /home/sadkga/AI/Deepseek Harness/dsh-restart-handoff-v2
```

That writes the profile's `package.json` dependency (`link:` to this
directory), adds `dsh-restart-handoff` to `dsh.profile.bundles`, and the
loader applies `cordis.patch.yml`, which inserts the plugin row and its
configuration.

To wire it into a profile by hand instead:

```jsonc
// profiles/web/package.json
"dependencies": {
  "dsh-restart-handoff": "link:/home/sadkga/AI/Deepseek Harness/dsh-restart-handoff-v2"
},
"dsh": { "profile": { "bundles": ["dsh-restart-handoff"] } }
```

Then `pnpm install` in the profile directory (`nodeLinker: hoisted`) and a
restart of the Host. The plugin needs Node 24 (`engines.node`).

The Host must be supervised by a unit that restarts it — the plugin signals
*itself* with `SIGTERM` and relies on `Restart=always` to bring the fresh
process up. The unit in use here is `dsh.service` (`Restart=always`,
`RestartSec=5`, `TimeoutStopUSec=1m30s`).

## Why it is built this way

### One tool, two steps, and the plan is bound to the warning

The restart is destructive: it ends every running turn in the process. So it
is never a single call. The first call only warns and hands back a token.

The second call runs **the plan from the warning**, not the plan from its own
arguments: the reason and the instruction are read from the pending record.
A model that rewrites the plan between the two calls would be confirming a
plan nobody ever saw, and the confirmation would mean nothing. The token is
spent by the confirmation and expires after `pendingTtlMs`; it never survives
the restart it was meant to authorise, because the fresh process has no
pending warning to confirm against.

### The exit is a signal to ourselves, not a `systemctl` call

`systemctl --user restart dsh.service` from inside the unit is a bad idea:
the command is killed mid-flight by the very stop it asks for, and it needs a
user D-Bus session the Host is not guaranteed to have. Signalling this process
with `SIGTERM` is equivalent — the CLI drains in-flight work and exits 0, and
`Restart=always` brings a fresh process up, so no process is left orphaned if
the relaunch fails.

The exit happens **after** the tool has returned its result and the turn has
gone idle. A restart that swallowed its own tool result would be a restart
that told nobody what happened.

### The handoff record is the whole point

Without a record, "the process died" and "the work continued" are unrelated
events. The record is written atomically (temp file + rename), the session
list is re-sampled at the last moment before the exit, and the record is
deleted once it has been replayed. A record that belongs to the running
process is never replayed by that same process — that would be a restart that
did not happen.

### The recovery criterion is the LAST turn/end — plus the queued work

A session that was interrupted is recognised by **the reason its last turn
ended**, and by **whether work is still waiting for it**:

| last `turn/end` reason | recovered? | why |
| --- | --- | --- |
| `interrupted` | yes | the writer crashed; the session layer closed the turn after the fact |
| `aborted` + `disposed` | yes | the process was torn down mid-turn |
| `aborted` + `user` | no | the human stopped it on purpose |
| `completed` | no | it finished; nothing was in flight |
| `error` | no | it failed; nothing was in flight |

and, independently of the reason, a session whose **inbox still holds a prompt
that never started** is recovered too: the turn it belonged to may have
finished, but the accepted work is still waiting and would be lost with the
process. The inbox projection is read as
`projections.values.inbox['next-turn']` / `['next-step']`.

The `interrupted` marker is the closer that `session-query` appends when it
balances a log whose tail turn never ended — both on a cold read and on a
resume. One judgement therefore covers both a session nobody ever resumed and
a session that was resumed and then died again.

The `turnBoundary.openTurnStartSeq` projection is deliberately **not** part of
the rule. A cold read balances the log before the caller sees it, so that
field is always `null`; a criterion built on it would look reasonable and
never fire — dead code that makes the whole feature look alive while it does
nothing. That is exactly the bug this rule replaces.

The age bound uses the **last event's timestamp**, not the session's creation
time: the synthetic closer reuses a real event's time, so the two agree.

### The guard judges commands, not mentions

The guard is a text heuristic, so its whole value is in *where* it looks.
Two scopes, one kernel:

* a **tool that executes** (shell, terminal, code runner) has its arguments
  judged as command lines: the kernel splits the text at the shell
  separators, peels the wrappers off (`sudo`, `env`, `nohup`, `nice`,
  `command`, `VAR=value`), looks at the **head verb** of each segment, and
  asks whether that verb is aimed at this machine. A commit message that
  mentions "kill -1" is not a kill, because the head verb is `git`;
* a **tool that stores** (write, edit, read) has its arguments treated as
  **data**. A file whose content mentions `systemctl --user restart
  dsh.service` is documentation, and denying it would stop the agent from
  writing its own tests and notes.

In short: **the guard covers the execution channels; a pure data payload is
not judged as a command.**

The code-shaped self-harm signals — `os.kill(os.getppid(), …)`,
`process.kill(process.ppid, …)`, `os.killpg`, `process.kill(-1, …)` — are
denied in **every** tool, because a sentence never contains them.

The kernel also recurses into the payload of an interpreter (`sh -c '…'`), of
anything that hands a `-c` payload to a program (`busybox sh -c '…'`) and of
an executor call (`execSync('pkill -f node')`,
`subprocess.run(['kill', '-1'])`, `tools.bash({ command: 'pkill -f node' })`),
because their argument runs exactly what a shell segment would.

Finally, the plugin runs *inside* the Host process, so `process.pid` is the
Host's pid. `kill <that pid>` is denied by literal match — it closes the
two-step suicide (`pgrep` first, `kill` second) that no text rule could
otherwise catch.

### Fidelity: the session comes back as it was

A resumed session keeps its own provider, model, reasoning effort and agent
preset, all read from the session log rather than from the deployment
defaults — including the rule that an adapter-defaulted reasoning effort is
not a conversation choice and is therefore not inherited.

## Known boundaries

* **The guard is guidance, not isolation.** It matches command text, so it can
  in principle be obfuscated (`base64 -d | sh`, variable concatenation). Its
  value is that it steers the model to `restart_dsh` and explains the
  consequence; real isolation needs a PATH allowlist or a separate cgroup,
  which is a Host change. **The real backstop is that the work comes back
  even when the Host is killed** — the unplanned-recovery path does not care
  how the process died.
* **A tool whose name does not say it executes anything is treated as a data
  tool.** Its payload is not judged as a command, so a third-party plugin tool
  that executes an arbitrary string it received in a payload is outside the
  guard's reach. The shell, terminal and code-runner channels — the ones a
  model actually uses to restart the Host — are covered.
* **Only `continuable` subagents are woken.** A `one-shot` child cannot be
  continued.
* **A session the human stopped does not come back.** `aborted` + `user` is
  explicitly excluded, and so are `completed` and `error` — unless the inbox
  still holds a prompt that never started.
* **Recovery is bounded.** One start recovers at most `recoverMaxSessions`
  sessions, and only those newer than `recoverMaxAgeMs`, newest first.
* **The browser side is not the plugin's job.** The Host restarts, the page
  briefly disconnects, and the frontend re-attaches. The plugin restores the
  *sessions and the work*, not the page's connection.
* **`serviceUnit` is descriptive only.** The restart is a self-signal, so the
  unit is never invoked by this plugin; the name is only written to the log
  line that announces the exit. The unit's own `Restart=always` is what
  actually brings the fresh process up.

## Tests

```sh
npm test        # node --test
```

| File | What it covers |
| --- | --- |
| `test/restart-handoff.test.mjs` | The two-step confirmation, the token TTL, the confirmation's edges, the session collection, the model route, the records on disk. |
| `test/guard-vectors.test.mjs` | The guard's vector suite: one command, one assertion. |
| `test/recovery-criterion.test.mjs` | The recovery matrix: which `turn/end` reason means "come back", and the queued-prompt case. |
| `test/handoff-replay.test.mjs` | The replay path: resume, handoff record, subagents, teammates. |
| `test/plugin-lifecycle.test.mjs` | `apply` registers the tool, the guard and the prompt section, and survives a refused registration. |
| `test/session-collection.test.mjs` | Which sessions a restart has to bring back. |

`probe-guard.mjs` is a one-command acceptance probe: it drives the real guard
over every known vector and exits non-zero on a mismatch.
