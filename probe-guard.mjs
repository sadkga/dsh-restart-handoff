/**
 * Temporary probe: drive the real guard over every known vector.
 * Deleted after the run; it exists only to print the BLOCKED/ALLOWED list.
 */

import { internals } from './index.js'

const { createRestartGuard } = internals
const guard = createRestartGuard()

const HOST_PID = process.pid

/** [label, command, expected] — expected is 'BLOCKED' or 'ALLOWED'. */
const VECTORS = [
  // --- self-kill vectors that must stay blocked ---
  ['kill -1', 'kill -1', 'BLOCKED'],
  ['kill -- -1', 'kill -- -1', 'BLOCKED'],
  ['kill -9 1', 'kill -9 1', 'BLOCKED'],
  ['killall5 node', 'killall5 node', 'BLOCKED'],
  ['pkill -f node', 'pkill -f node', 'BLOCKED'],
  ['pkill -f bin.ts web', 'pkill -f "apps/cli/src/bin.ts web"', 'BLOCKED'],
  ['kill -TERM $PPID', 'kill -TERM $PPID', 'BLOCKED'],
  ['kill ${PPID}', 'kill ${PPID}', 'BLOCKED'],
  ['ps | xargs kill -9', 'ps -o pid= -p $PPID | xargs kill -9', 'BLOCKED'],
  ['find | xargs kill', 'find /tmp -name "*.pid" | xargs kill', 'BLOCKED'],
  ['sudo pkill -f node', 'sudo pkill -f node', 'BLOCKED'],
  ['kill -9 <host pid>', `kill -9 ${HOST_PID}`, 'BLOCKED'],
  ['os.kill(os.getppid())', 'python3 -c "import os,signal; os.kill(os.getppid(), signal.SIGTERM)"', 'BLOCKED'],
  ['os.killpg(...)', 'python3 -c "import os; os.killpg(os.getpgid(0), 9)"', 'BLOCKED'],
  ['process.kill(process.ppid)', 'node -e "process.kill(process.ppid, 15)"', 'BLOCKED'],
  ['process.kill(-1)', 'node -e "process.kill(-1, 15)"', 'BLOCKED'],
  ['taskkill', 'taskkill /IM dsh.exe /F', 'BLOCKED'],
  ['Stop-Process', 'Stop-Process -Name dsh', 'BLOCKED'],
  ['Get-Process | Stop-Process', 'Get-Process | Stop-Process', 'BLOCKED'],
  ['systemctl restart dsh.service', 'systemctl restart dsh.service', 'BLOCKED'],
  ['service dsh stop', 'service dsh stop', 'BLOCKED'],
  ['supervisorctl restart dsh', 'supervisorctl restart dsh', 'BLOCKED'],
  ['docker restart dsh', 'docker restart dsh', 'BLOCKED'],
  ['fuser -k 3080/tcp', 'fuser -k 3080/tcp', 'BLOCKED'],
  ['init 0', 'init 0', 'BLOCKED'],
  ['halt', 'halt', 'BLOCKED'],
  ['reboot now', 'reboot now', 'BLOCKED'],
  ['kill $(cat pid)', 'kill $(cat /tmp/dsh.pid)', 'BLOCKED'],
  ['systemctl --user restart', 'systemctl --user restart dsh.service', 'BLOCKED'],
  ['systemctl --user stop', 'systemctl --user stop dsh', 'BLOCKED'],
  ['killall dsh', 'killall dsh', 'BLOCKED'],
  ['kill $DSH_SESSION_ID', 'kill $DSH_SESSION_ID', 'BLOCKED'],
  ['kill -TERM -1', 'kill -TERM -1', 'BLOCKED'],
  ['kill -9 $(pgrep bin.ts)', 'kill -9 $(pgrep -f "bin.ts web")', 'BLOCKED'],
  ['sudo pkill -f node (wrapper)', 'sudo pkill -f node', 'BLOCKED'],

  // --- the four bypass classes that used to get through ---
  ['bypass: sh -c', "sh -c 'pkill node'", 'BLOCKED'],
  ['bypass: bash -c', "bash -c 'kill -1'", 'BLOCKED'],
  ['bypass: /usr/bin/kill', '/usr/bin/kill -1', 'BLOCKED'],
  ['bypass: env FOO=1', 'env FOO=1 kill -1', 'BLOCKED'],
  ['bypass: sudo -u root', 'sudo -u root kill -1', 'BLOCKED'],
  ['bypass: eval', "eval 'kill $PPID'", 'BLOCKED'],
  ['bypass: sudo --user=root', 'sudo --user=root kill -1', 'BLOCKED'],
  ['bypass: env -u FOO', 'env -u FOO kill -1', 'BLOCKED'],
  ['bypass: nohup', 'nohup kill -1', 'BLOCKED'],
  ['bypass: nice -n 10', 'nice -n 10 kill -1', 'BLOCKED'],
  ['bypass: command builtin', 'command kill -1', 'BLOCKED'],
  ['bypass: xargs -0', 'echo 1 | xargs -0 kill -9', 'BLOCKED'],

  // --- read-only work that must not be blocked ---
  ['ro: systemctl status', 'systemctl --user status dsh.service', 'ALLOWED'],
  ['ro: docker logs', 'docker logs dsh', 'ALLOWED'],
  ['ro: fuser -v', 'fuser -v 8080/tcp', 'ALLOWED'],
  ['ro: git commit -m kill -1', 'git commit -m "kill -1 switch"', 'ALLOWED'],
  ['ro: grep -rn pkill', 'grep -rn "pkill" src/', 'ALLOWED'],
  ['ro: echo halt', 'echo "please halt the build"', 'ALLOWED'],
  ['ro: npm run kill:all-tests', 'npm run kill:all-tests', 'ALLOWED'],
  ['ro: timeout --kill-after', 'timeout --kill-after=30 sleep 5', 'ALLOWED'],
  ['ro: kill 12345', 'kill 12345', 'ALLOWED'],
  ['ro: docker ps', 'docker ps', 'ALLOWED'],
  ['ro: service --status-all', 'service --status-all', 'ALLOWED'],
  ['ro: ls -la /tmp', 'ls -la /tmp', 'ALLOWED'],
  ['ro: grep -r restart', 'grep -r restart dsh.service', 'ALLOWED'],
  ['ro: cat killall.md', 'cat docs/killall.md', 'ALLOWED'],
  ['ro: git commit init 0', 'git commit -m "add init 0 support"', 'ALLOWED'],
  ['ro: echo <host pid>', `echo ${HOST_PID}`, 'ALLOWED'],
  ['ro: docker compose ps', 'docker compose ps', 'ALLOWED'],
  ['ro: npm run build', 'npm run build', 'ALLOWED'],
]

/**
 * Tool calls whose arguments carry the dangerous command.
 *
 * The last one is a KNOWN BOUNDARY, not a bug: a tool whose name does not say
 * that it executes anything is treated as a data tool, so its payload is not
 * judged as a command. See README → "Known boundaries".
 */
const TOOL_VECTORS = [
  ['tool: run_code execSync', 'run_code', { code: "const { execSync } = require('child_process'); execSync('pkill -f node')", description: 'restart the harness' }, 'BLOCKED'],
  ['tool: run_code os.kill', 'run_code', { code: 'import os, signal; os.kill(os.getppid(), signal.SIGTERM)', description: 'stop the parent' }, 'BLOCKED'],
  ['tool: run_code process.kill', 'run_code', { code: 'process.kill(process.ppid, 15)', description: 'stop the parent' }, 'BLOCKED'],
  ['tool: run_code python subprocess', 'run_code', { code: 'import subprocess; subprocess.run(["kill", "-1"])', description: 'stop all' }, 'BLOCKED'],
  ['tool: run_code bash call', 'run_code', { code: "await tools.bash({ command: 'pkill -f node' })", description: 'restart' }, 'BLOCKED'],
  ['tool: nested payload', 'some_plugin_tool', { payload: { steps: ['echo hi', 'pkill -f node'] } }, 'ALLOWED'],
  ['tool: pwsh script', 'pwsh', { script: 'Stop-Process -Name dsh' }, 'BLOCKED'],
  ['tool: terminal_exec', 'terminal_exec', { command: "bash -c 'kill -1'" }, 'BLOCKED'],
  ['tool: plain read', 'read', { file_path: '/tmp/notes.md' }, 'ALLOWED'],
]

const results = []
let mismatches = 0

for (const [label, command, expected] of VECTORS) {
  const denial = guard({ name: 'bash', arguments: { command } })
  const actual = denial === undefined ? 'ALLOWED' : 'BLOCKED'
  const ok = actual === expected
  if (!ok) mismatches += 1
  results.push({ kind: 'command', label, expected, actual, ok, detail: command })
}

for (const [label, name, args, expected] of TOOL_VECTORS) {
  const denial = guard({ name, arguments: args })
  const actual = denial === undefined ? 'ALLOWED' : 'BLOCKED'
  const ok = actual === expected
  if (!ok) mismatches += 1
  results.push({ kind: 'tool', label, expected, actual, ok, detail: `${name} ${JSON.stringify(args).slice(0, 90)}` })
}

// The restart tool itself must never be denied.
const selfDeny = guard({ name: 'restart_dsh', arguments: { reason: 'kill -1 the harness', continuePrompt: 'kill -1' } })
if (selfDeny !== undefined) mismatches += 1
results.push({
  kind: 'tool',
  label: 'tool: restart_dsh itself',
  expected: 'ALLOWED',
  actual: selfDeny === undefined ? 'ALLOWED' : 'BLOCKED',
  ok: selfDeny === undefined,
  detail: 'restart_dsh with a scary reason string',
})

for (const item of results) {
  const mark = item.ok ? '  ok ' : 'FAIL '
  console.log(`${mark}${item.actual.padEnd(7)} ${item.label.padEnd(34)} | ${item.detail}`)
}

console.log(`\nBLOCKED: ${results.filter(r => r.actual === 'BLOCKED').length}  ALLOWED: ${results.filter(r => r.actual === 'ALLOWED').length}  mismatches: ${mismatches}`)
process.exit(mismatches === 0 ? 0 : 1)
