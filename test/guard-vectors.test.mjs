/**
 * The guard's vector suite: one command, one assertion.
 *
 * The guard is a text heuristic, so the only thing that keeps it honest is a
 * fixed list of real commands with a known verdict. Each vector below is its
 * own case with exactly ONE assertion, so a regression names the command that
 * changed its mind instead of failing a table.
 *
 * Three groups:
 *   - the ways an agent can take the Host down (must be denied);
 *   - the ordinary commands that merely MENTION a dangerous word (must pass);
 *   - the scope: a tool that stores data is not a tool that executes it.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { internals } from '../index.js'

const { createRestartGuard, isCommandTool } = internals

/** A fresh guard per vector: the guard is stateless, but this keeps them independent. */
const guard = createRestartGuard()

/**
 * Assert that a command is denied, in ONE assertion: the guard must return a
 * reason, and the reason must name the way out.
 * @param {string} command - the command text.
 * @param {string} tool - the tool that would run it.
 * @returns {void} nothing.
 */
function assertDenied(command, tool = 'bash') {
  const denial = guard({ name: tool, arguments: { command } })
  assert.ok(
    typeof denial === 'string' && /restart_dsh/.test(String(denial)),
    `expected a denial naming restart_dsh for: ${command}`,
  )
}

// ---------------------------------------------------------------------------
// A. Every way an agent could take the Host down — all of them must be denied.
// ---------------------------------------------------------------------------

test('vector: systemctl --user restart dsh.service is denied', () => {
  assertDenied('systemctl --user restart dsh.service')
})

test('vector: systemctl --user stop dsh is denied', () => {
  assertDenied('systemctl --user stop dsh')
})

test('vector: systemctl restart dsh is denied', () => {
  assertDenied('systemctl restart dsh')
})

test('vector: supervisorctl stop dsh is denied', () => {
  assertDenied('supervisorctl stop dsh')
})

test('vector: docker restart dsh is denied', () => {
  assertDenied('docker restart dsh')
})

test('vector: pkill -f dsh is denied', () => {
  assertDenied('pkill -f dsh')
})

test('vector: pkill -f node is denied', () => {
  assertDenied('pkill -f node')
})

test('vector: pkill -f "apps/cli/src/bin.ts web" is denied', () => {
  assertDenied('pkill -f "apps/cli/src/bin.ts web"')
})

test('vector: killall dsh is denied', () => {
  assertDenied('killall dsh')
})

test('vector: killall node is denied', () => {
  assertDenied('killall node')
})

test('vector: killall5 node is denied', () => {
  assertDenied('killall5 node')
})

test('vector: kill $DSH_SESSION_ID is denied', () => {
  assertDenied('kill $DSH_SESSION_ID')
})

test('vector: kill -TERM $PPID is denied', () => {
  assertDenied('kill -TERM $PPID')
})

test('vector: kill ${PPID} is denied', () => {
  assertDenied('kill ${PPID}')
})

test('vector: kill -9 $(pgrep -f "bin.ts web") is denied', () => {
  assertDenied('kill -9 $(pgrep -f "bin.ts web")')
})

test('vector: kill $(cat /tmp/dsh.pid) is denied', () => {
  assertDenied('kill $(cat /tmp/dsh.pid)')
})

test('vector: kill -TERM -1 is denied', () => {
  assertDenied('kill -TERM -1')
})

test('vector: kill -- -1 is denied', () => {
  assertDenied('kill -- -1')
})

test('vector: kill -TERM -- -1 is denied', () => {
  assertDenied('kill -TERM -- -1')
})

test('vector: kill -9 1 is denied', () => {
  assertDenied('kill -9 1')
})

test('vector: python os.kill(os.getppid()) is denied', () => {
  assertDenied('python3 -c "import os,signal; os.kill(os.getppid(), signal.SIGTERM)"')
})

test('vector: node process.kill(process.ppid) is denied', () => {
  assertDenied('node -e "process.kill(process.ppid, 15)"')
})

test('vector: python os.killpg is denied', () => {
  assertDenied('python3 -c "import os; os.killpg(os.getpgid(0), 9)"')
})

test('vector: node process.kill(-1) is denied', () => {
  assertDenied('node -e "process.kill(-1, 15)"')
})

test('vector: ps | xargs kill -9 is denied', () => {
  assertDenied('ps -o pid= -p $PPID | xargs kill -9')
})

test('vector: find | xargs kill is denied', () => {
  assertDenied('find /tmp -name "*.pid" | xargs kill')
})

test('vector: fuser -k is denied', () => {
  assertDenied('fuser -k 3080/tcp')
})

test('vector: reboot now is denied', () => {
  assertDenied('reboot now')
})

test('vector: halt is denied', () => {
  assertDenied('halt')
})

test('vector: init 0 is denied', () => {
  assertDenied('init 0')
})

test('vector: telinit 0 is denied', () => {
  assertDenied('telinit 0')
})

test('vector: shutdown -h now is denied', () => {
  assertDenied('shutdown -h now')
})

test('vector: poweroff is denied', () => {
  assertDenied('poweroff')
})

test('vector: taskkill is denied', () => {
  assertDenied('taskkill /F /IM node.exe')
})

test('vector: Stop-Process is denied', () => {
  assertDenied('Stop-Process -Name node')
})

test('vector: Get-Process | Stop-Process is denied', () => {
  assertDenied('Get-Process node | Stop-Process')
})

test('vector: sudo pkill -f node is denied', () => {
  assertDenied('sudo pkill -f node')
})

test('vector: sh -c "pkill node" is denied', () => {
  assertDenied("sh -c 'pkill node'")
})

test('vector: bash -c "kill -1" is denied', () => {
  assertDenied("bash -c 'kill -1'")
})

test('vector: an absolute path to kill is denied', () => {
  assertDenied('/usr/bin/kill -1')
})

test('vector: an environment assignment before kill is denied', () => {
  assertDenied('env FOO=1 kill -1')
})

test('vector: sudo with an option before kill is denied', () => {
  assertDenied('sudo -u root kill -1')
})

// ---------------------------------------------------------------------------
// B. The two-step suicide: look the pid up, then kill it.
// ---------------------------------------------------------------------------

test('vector: killing this very pid is denied', () => {
  assertDenied(`kill -9 ${process.pid}`)
})

test('vector: killing this very pid with SIGTERM is denied', () => {
  assertDenied(`kill -TERM ${process.pid}`)
})

test('vector: killing this very pid without a signal is denied', () => {
  assertDenied(`kill ${process.pid}`)
})

// ---------------------------------------------------------------------------
// C. Ordinary work that merely MENTIONS a dangerous word — all of it must pass.
// ---------------------------------------------------------------------------

test('vector: grep for pkill passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'grep -rn "pkill" src/' } }), undefined)
})

test('vector: cat a file named killall.md passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'cat killall.md' } }), undefined)
})

test('vector: cat docs/killall.md passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'cat docs/killall.md' } }), undefined)
})

test('vector: echo pkill passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'echo pkill' } }), undefined)
})

test('vector: grep for halt passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'grep halt' } }), undefined)
})

test('vector: grep -rn "halt" passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'grep -rn "halt" src/' } }), undefined)
})

test('vector: a sentence about halting the build passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'echo "please halt the build"' } }), undefined)
})

test('vector: a commit message about init 0 passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'git commit -m "add init 0 support"' } }), undefined)
})

test('vector: a commit message about kill -1 passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'git commit -m "kill -1 switch"' } }), undefined)
})

test('vector: git init passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'git init' } }), undefined)
})

test('vector: npm init -y passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'npm init -y' } }), undefined)
})

test('vector: npm run kill:all-tests passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'npm run kill:all-tests' } }), undefined)
})

test('vector: timeout --kill-after passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'timeout --kill-after=30 sleep 5' } }), undefined)
})

test('vector: restarting another service passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'systemctl restart nginx' } }), undefined)
})

test('vector: systemctl status is a read, not a restart', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'systemctl --user status dsh.service' } }), undefined)
})

test('vector: docker ps passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'docker ps' } }), undefined)
})

test('vector: docker logs passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'docker logs dsh' } }), undefined)
})

test('vector: pkill of an unrelated process passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'pkill mytestserver' } }), undefined)
})

test('vector: a precise kill of an unrelated pid passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'kill 12345' } }), undefined)
})

test('vector: fuser -v only looks, it does not kill', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'fuser -v 8080/tcp' } }), undefined)
})

test('vector: grep for restart in a unit file passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'grep -r restart dsh.service' } }), undefined)
})

test('vector: ls passes', () => {
  assert.equal(guard({ name: 'bash', arguments: { command: 'ls -la /tmp' } }), undefined)
})

// ---------------------------------------------------------------------------
// D. The scope: a tool that STORES data is not a tool that EXECUTES it.
// ---------------------------------------------------------------------------

test('scope: a read tool carrying a command is not judged as a command', () => {
  assert.equal(guard({ name: 'read', arguments: { command: 'systemctl --user restart dsh.service' } }), undefined)
})

test('scope: a write tool storing a dangerous command is not judged as a command', () => {
  assert.equal(guard({ name: 'write', arguments: { path: '/tmp/note.md', content: 'systemctl --user restart dsh.service\n' } }), undefined)
})

test('scope: an edit tool storing a dangerous command is not judged as a command', () => {
  assert.equal(guard({ name: 'edit', arguments: { path: '/tmp/note.md', old: 'a', new: 'kill -9 1' } }), undefined)
})

test('scope: the restart tool itself is never denied', () => {
  assert.equal(guard({ name: 'restart_dsh', arguments: { reason: 'x', continuePrompt: 'y' } }), undefined)
})

test('scope: code-shaped self-harm is denied even in a data tool', () => {
  const denial = guard({ name: 'write', arguments: { content: 'process.kill(process.ppid, 15)' } })
  assert.equal(typeof denial, 'string')
})

test('scope: the shell tools are command tools', () => {
  assert.equal(isCommandTool('bash'), true)
})

test('scope: the powershell tool is a command tool', () => {
  assert.equal(isCommandTool('pwsh'), true)
})

test('scope: a code runner is a command tool', () => {
  assert.equal(isCommandTool('run_code'), true)
})

test('scope: a file tool is not a command tool', () => {
  assert.equal(isCommandTool('write'), false)
})

test('scope: a read tool is not a command tool', () => {
  assert.equal(isCommandTool('read'), false)
})

// ---------------------------------------------------------------------------
// E. The wrappers and the execution calls that used to slip through.
// ---------------------------------------------------------------------------

test('vector: eval "kill $PPID" is denied', () => {
  assertDenied("eval 'kill $PPID'")
})

test('vector: sudo --user=root kill -1 is denied', () => {
  assertDenied('sudo --user=root kill -1')
})

test('vector: env -u FOO kill -1 is denied', () => {
  assertDenied('env -u FOO kill -1')
})

test('vector: nohup kill -1 is denied', () => {
  assertDenied('nohup kill -1')
})

test('vector: nice -n 10 kill -1 is denied', () => {
  assertDenied('nice -n 10 kill -1')
})

test('vector: command kill -1 is denied', () => {
  assertDenied('command kill -1')
})

test('vector: xargs -0 kill -9 is denied', () => {
  assertDenied('echo 1 | xargs -0 kill -9')
})

test('vector: service dsh stop is denied', () => {
  assertDenied('service dsh stop')
})

// ---------------------------------------------------------------------------
// F. The code channel: a call that RUNS its argument runs the command too.
// ---------------------------------------------------------------------------

test('vector: execSync("pkill -f node") is denied', () => {
  assertDenied("const { execSync } = require('child_process'); execSync('pkill -f node')", 'run_code')
})

test('vector: subprocess.run(["kill", "-1"]) is denied', () => {
  assertDenied('import subprocess; subprocess.run(["kill", "-1"])', 'run_code')
})

test('vector: a nested tools.bash call is denied', () => {
  assertDenied("await tools.bash({ command: 'pkill -f node' })", 'run_code')
})

test('vector: os.kill(os.getppid()) in a code tool is denied', () => {
  assertDenied('import os, signal; os.kill(os.getppid(), signal.SIGTERM)', 'run_code')
})

test('vector: process.kill(process.ppid) in a code tool is denied', () => {
  assertDenied('process.kill(process.ppid, 15)', 'run_code')
})

test('vector: harmless code passes', () => {
  assert.equal(guard({ name: 'run_code', arguments: { code: 'const x = 1' } }), undefined)
})

// ---------------------------------------------------------------------------
// G. The known boundary: a tool whose NAME does not say it executes anything
// is treated as a data tool, so its payload is not judged as a command.
// ---------------------------------------------------------------------------

test('boundary: an unknown plugin tool carries data, not commands', () => {
  assert.equal(
    guard({ name: 'some_plugin_tool', arguments: { payload: { steps: ['echo hi', 'pkill -f node'] } } }),
    undefined,
  )
})
