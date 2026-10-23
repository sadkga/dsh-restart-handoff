# dsh-restart-handoff

Restart the DeepSeek Harness from inside the conversation and come back to the
work — without a human typing "continue".

## What it does

The model restarts the Host through **one dedicated tool**, `restart_dsh`, in
**two steps**:

1. **Warning call.** The tool records nothing that restarts anything. It
   returns a warning: the reason, the instruction that will be replayed, the
   number of sessions that will be resumed, and a **confirmation token**. The
   model must come back with that token, so a restart is never a single stray
   call — the agent gets a second chance to state the plan.
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

## Why the model never runs the restart itself

`systemctl --user restart dsh.service` from inside the service dies with the
very stop it asks for. A `bash` call like that also loses the tool result, the
turn, and the session's live agent. The plugin therefore:

* exposes the restart as a **tool**, and
* **guards the shell tools**: a `bash`/`pwsh` command that looks like a
  Harness restart is denied with a message naming `restart_dsh`.

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
| `dryRun` | `false` | Write the handoff record but never signal the process. |

## Notes

* The resumed sessions appear in the Web UI like any other live session; the
  browser reconnects on its own, and the new turns are in the session log.
* Subagents in `one-shot` mode cannot be continued; only `continuable`
  children are woken.
* The handoff record is deleted once it has been replayed, and a record that
  belongs to the running process is never replayed by itself.
* The confirmation is bound to the plan the user saw: the second call may not
  change the reason or the continuation, and an expired token is refused.
* A resumed session keeps its own model and agent preset, both read from the
  session log, so the work continues on the same footing it was running on.
* Only a top-level session may restart the Harness; a subagent asks its
  parent, because the subagent runtime owns the child session.
* Tests: `node --test test/restart-handoff.test.mjs` covers the guard, the two-step
  confirmation, the token TTL, the session collection and the model route.
