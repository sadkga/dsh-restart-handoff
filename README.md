# dsh-restart-handoff

**在对话里重启 DeepSeek Harness，然后自己回到工作里 —— 不需要人打字说「继续」。**

- [中文](#中文) · [English](#english)

---

<a id="中文"></a>

## 中文

### 它做什么

模型通过**一个专用工具** `restart_dsh`，以**两步**的方式重启宿主：

1. **警告调用。** 这一步不重启任何东西。工具返回一段警告：原因、将重放的指令、将恢复的会话，以及一个**确认令牌**。模型必须带着令牌回来，所以重启绝不会是一次随手调用 —— 智能体有第二次机会把计划说清楚。
2. **确认调用。** 令牌匹配时，工具写入交接记录（`$DSH_HOME/restart/handoff.json`）：重启时正在跑的会话、原因、待重放的指令（`continuePrompt`），以及可继续的子代理。会话日志落盘，工具等当前轮次变空闲，然后进程给自己发信号；由 `Restart=always` 的单元拉起新进程。
3. **重放。** 新进程读交接记录，然后
   - **恢复重启发生时正在跑的每一个会话**，并注入一条「请继续」的指令唤醒它；
   - **自上而下地唤起可继续的子代理**，保证子会话只在它自己的父会话活着时才被投递；
   - 把 `continuePrompt` 交给发起重启的那个会话；
   - 对齐 Agent Team 名册并唤起其中的队友。

上面是**计划内**重启。**非计划**重启 —— 崩溃、被杀、断电 —— 不会留下交接记录，所以下次启动时插件会扫描持久化的会话，把「最后一轮被打断」的那些带回来，外加「收件箱里还排着没开始过的提示」的那些。

### 为什么模型不会自己去执行重启

在服务内部执行 `systemctl --user restart dsh.service`，会死在自己要求的那个停止动作上。这样的 `bash` 调用还会丢掉工具结果、丢掉当前轮次、丢掉会话的活跃 Agent。因此插件：

* 把重启暴露为一个**工具**，并且
* **看守会执行命令的工具**：看起来像「重启 Harness」的命令会被拒绝，并给出指向 `restart_dsh` 的提示。

围栏的完整说明见下文 *为什么这样设计*。

### 配置（`cordis.patch.yml`）

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `serviceUnit` | `dsh.service` | 监管该进程的 systemd user 单元。 |
| `handoffDir` | `$DSH_HOME/restart` | 交接记录写入的位置。 |
| `autoResume` | `true` | 下次启动时重放交接记录。 |
| `resumeSubagents` | `true` | 恢复后唤起可继续的子代理。 |
| `resumeRunningSessions` | `true` | 同时恢复其它正在跑或排着活的会话。 |
| `pendingTtlMs` | `300000` | 超过这个年龄的确认令牌会被拒绝。 |
| `idleTimeoutMs` | `30000` | 工具等轮次变空闲再发信号的最长时间。 |
| `handoffTtlMs` | `1800000` | 超过这个年龄的记录视为陈旧，不再重放。 |
| `recoverInterruptedSessions` | `true` | 恢复非计划退出留下的会话。 |
| `recoverMaxAgeMs` | `7200000` | 被打断的会话最多能有多旧才仍会被恢复。 |
| `recoverMaxSessions` | `50` | 一次启动最多恢复几个会话。 |
| `dryRun` | `false` | 只写交接记录，绝不发信号。 |

在 `cordis.patch.yml` 里改任意一项即可覆盖：

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

### 安装

用 Harness 插件 CLI 装进某个 profile。**`--profile` 是必需参数** —— CLI 会把其余参数转发给该 profile 目录里的 `pnpm`：

```bash
dsh plugin --profile web add dsh-restart-handoff
```

从 GitHub 装（不需要 npm 账号）：

```bash
dsh plugin --profile web add github:sadkga/dsh-restart-handoff
```

锁定某个标签：

```bash
dsh plugin --profile web add github:sadkga/dsh-restart-handoff#v0.2.1
```

装完**重启宿主**：插件的客户端元数据与加载器会被缓存，直到进程重启才生效。

插件需要 Node 24（`engines.node`）。

#### 从本地检出安装

插件是一个纯宿主 bundle：一个 `name`、一份 `inject` 列表和一个 `apply`。要用插件管理器安装本地工作副本，把目标指向该目录：

```
plugin_manager → install_bundle → target: /path/to/dsh-restart-handoff
```

这会写入 profile 的 `package.json` 依赖（`link:` 到该目录）、把 `dsh-restart-handoff` 加进 `dsh.profile.bundles`，加载器随后应用 `cordis.patch.yml`，插入插件行和它的配置。

也可以手工接线：

```jsonc
// profiles/web/package.json
"dependencies": {
  "dsh-restart-handoff": "link:/path/to/dsh-restart-handoff"
},
"dsh": { "profile": { "bundles": ["dsh-restart-handoff"] } }
```

然后在 profile 目录里跑 `pnpm install`（`nodeLinker: hoisted`），并重启宿主。

宿主必须由一个会重启它的单元监管 —— 插件给自己发 `SIGTERM`，靠 `Restart=always` 拉起新进程。本仓库使用的单元是 `dsh.service`（`Restart=always`、`RestartSec=5`、`TimeoutStopUSec=1m30s`）。

### 为什么这样设计

#### 一个工具、两次调用，计划绑定在警告上

重启是破坏性的：它会终结进程里所有正在跑的轮次。所以它永远不是一次调用就能完成的。第一次调用只警告并交回一个令牌。

第二次调用执行的是**警告里那份计划**，而不是它自己参数里的计划：原因和指令都从待确认记录里读。一个在两次调用之间改写计划的模型，确认的就是一份没人见过的计划，确认也就毫无意义。令牌被确认消耗，并在 `pendingTtlMs` 后过期；它绝不跨过它本该授权的那次重启存续，因为新进程里没有待确认的警告可以对。

#### 退出是给自己发信号，不是调 `systemctl`

在单元内部执行 `systemctl --user restart dsh.service` 是个坏主意：命令会被它自己要求的停止动作半路杀掉，而且它需要一个宿主未必具备的用户 D-Bus 会话。给自己发 `SIGTERM` 是等价的 —— CLI 会把在途工作排空并以 0 退出，而 `Restart=always` 会拉起新进程，所以即使重启失败也不会留下孤儿进程。

退出发生在**工具已经返回结果、轮次已经变空闲之后**。一个吞掉自己工具结果的重启，等于一个谁都不知道发生了什么就消失的重启。

#### 交接记录就是全部意义

没有记录，「进程死了」和「工作继续了」就是两件互不相干的事。记录是原子写入的（临时文件 + rename），会话列表在退出前的最后一刻重新采样，回放一次后即删除。属于当前运行进程的记录，绝不会被同一个进程重放 —— 那将是一次根本没发生的重启。

#### 恢复判据是**最后一个 turn/end** —— 外加排队中的工作

被打断的会话靠**它最后一个轮次结束的原因**、以及**是否还有工作在等它**来识别：

| 最后一个 `turn/end` 的 reason | 恢复？ | 为什么 |
| --- | --- | --- |
| `interrupted` | 是 | 写入方崩溃了；会话层事后补上了轮次收尾 |
| `aborted` + `disposed` | 是 | 进程在轮次中途被拆掉 |
| `aborted` + `user` | 否 | 是人主动停的 |
| `completed` | 否 | 跑完了；没有在途的东西 |
| `error` | 否 | 失败了；没有在途的东西 |

另外，与 reason 无关地，**收件箱里还排着一个从未开始的提示**的会话也会被恢复：它所属的轮次或许结束了，但已被接受的工作还在等着，会随进程一起丢失。收件箱投影读作 `projections.values.inbox['next-turn']` / `['next-step']`。

`interrupted` 标记是 `session-query` 在给尾部轮次没有收尾的日志做配平时补上的收尾 —— 冷读和恢复时都会补。因此同一套判断同时覆盖「从没被恢复过的会话」和「恢复过、然后又死了的会话」。

`turnBoundary.openTurnStartSeq` 这个投影**刻意不**参与判定。冷读会在调用方看到之前先给日志配平，所以那个字段恒为 `null`；建立在它上面的判据看起来合理，却永远不触发 —— 是让整个功能「看起来活着、实际什么都没做」的死代码。这正是本规则要替换掉的那个 bug。

年龄上限用**最后一个事件的时间戳**，而不是会话的创建时间：合成出来的收尾复用了真实事件的时间，所以两者一致。

#### 围栏判的是命令，不是提及

围栏是文本启发式，所以它的全部价值在于**它看哪里**。两个作用域，一个内核：

* **会执行的工具**（shell、终端、代码执行器）：它的参数被当作命令行判定 —— 内核按 shell 分隔符切分文本，剥掉包装层（`sudo`、`env`、`nohup`、`nice`、`command`、`VAR=value`），看每一段的**首个动词**，再问这个动词是不是冲着这台机器来的。提交信息里提到「kill -1」不是 kill，因为首个动词是 `git`；
* **会存储的工具**（写、编辑、读）：它的参数被当作**数据**。一个内容里提到 `systemctl --user restart dsh.service` 的文件是文档，拦下它反而会阻止 Agent 写自己的测试和笔记。

一句话：**围栏覆盖执行通道；纯数据载荷不当命令判。**

The code-shaped self-harm signals — `os.kill(os.getppid(), …)`,
`process.kill(process.ppid, …)`, `os.killpg`, `process.kill(-1, …)` — are
denied in **every** tool, because a sentence never contains them.

内核还会递归进入解释器的载荷、任何把 `-c` 载荷交给程序的东西，以及执行器调用：

The kernel also recurses into the payload of an interpreter (`sh -c '…'`), of
anything that hands a `-c` payload to a program (`busybox sh -c '…'`) and of
an executor call (`execSync('pkill -f node')`,
`subprocess.run(['kill', '-1'])`, `tools.bash({ command: 'pkill -f node' })`),
because their argument runs exactly what a shell segment would.

最后，插件跑在**宿主进程内部**，所以它知道宿主从外面看是什么样子：它的 pid、它的父进程，以及**它启动时的那条命令行**。于是判据不再是"文本里有没有那个数字"，而是"这条查找命令按它自己的匹配规则，会不会选中宿主"：

| 写法 | 结果 |
| --- | --- |
| `kill -TERM <宿主的字面 pid>` | 拦住 |
| `kill $PPID` | 拦住 |
| `P=$(pgrep -f "apps/cli/src/bin.ts web") && kill -TERM $P` | 拦住 |
| `kill $(pgrep -f "apps/cli/src/bin.ts web")` | 拦住 |
| `pkill -f node` | 拦住 |
| `kill 0`（杀整个进程组） | 拦住 |
| `P=$(pgrep -f "my-unrelated-service") && kill -TERM $P` | 放行 |
| `kill -9 12345`（某个具名进程） | 放行 |
| `kill -- -12345`（宿主以外���进程组） | 放行 |
| `pgrep -f "apps/cli/src/bin.ts web"`（只查看，不发信号） | 放行 |

这是 shell 自己的匹配规则，不是猜测：`pkill -f` 拿 pattern 去匹配每个进程的**完整命令行**，所以凡是 pattern 出现在宿主命令行里的查找，必然会选中宿主；反之，查找一个无关进程是日常工作，必须放行。**要绕过它仍然不难**（base64、脚本文件、把 pid 编码进变量），所以围栏的定位始终是引导和后果说明 —— **真正的兜底是恢复机制：无论宿主是被杀、被崩还是断电，正在跑的会话、子代理和队友都会回来。**

#### 保真：会话回来时还是它自己

恢复的会话保留自己的 provider、模型、思考强度和 agent preset，全部从会话日志读，而不是用部署默认值 —— 包括「适配器默认给的思考强度不算对话的选择，因此不继承」这条规则。

### 恢复性能

扫描在每次启动时都会跑，所以它的成本是每个重启的人都要付的。三件事在真实存储上测过（132 个候选会话，其中一个 8 MB / 20 000 条事件）：

| | `took`（整轮扫描） | `reads` | `readMs` |
| --- | --- | --- | --- |
| 朴素做法：全量读每个日志 | 97 750 ms | 49 | 87 353 ms |
| + mtime 预筛 | 31 901 ms | 14 | 29 631 ms |
| + 只读日志**尾部** | — | — | **14 ms** |
| + 向忙碌的 Agent 投递时不空等 | **12 873 ms** | **2** | **14 ms** |

三个决定带来了这个结果：

* **年龄窗口在读日志之前，就用文件的 mtime 判定。** 读一个日志意味着解压并解析里面每一个事件；真实存储里的大多数候选早就死了。这个预筛严格比它所预判的那条持久规则更保守 —— 整个存储都测过，日志最后一个事件时间与 mtime 的差从未超过 5.7 ms。
* **只读日志的尾部。** 判据是「**最后一个**轮次是不是被打断」，答案就在末尾：最后一个 `turn/start`，以及它后面有没有跟着 `turn/end`。日志是多帧 zstd 文件，所以从末尾回溯帧、只解压最后几帧 —— 最大的那个会话读了 88 条事件，而不是 21 486 条。尾部判据与全量判据在整个存储上逐个会话比对过，全部一致。
* **忙碌的 Agent 不必等。** `followup` 是把消息排进 Agent 的**下一轮**；正在跑的 Agent 会在自己的轮次边界消费它。消息待在运行中 Agent 的队列里是正常状态，不是失败，所以投递不会等它变空闲。

剩下的约 12 秒，是真正把恢复出来的会话和它们的子代理启动起来的代价，而不是检查它们的代价。

两个已知成本不在这个插件的掌控范围内：

* 存储里有十个日志是**单帧** zstd 文件；单帧必须从开头解压，所以它们只能回退到全量读。要让它们也快，需要宿主把日志切成更多帧。
* `readSession` 这条路把大部分时间花在 CPU 上（解压、解析、`structuredClone`、重放校验），而不是 I/O —— 这正是「读尾部」收益如此大的原因，也是「并行读日志」收益甚微的原因。

### 已知边界

* **围栏是引导，不是隔离。** 它匹配命令文本，所以原则上仍能被混淆绕过（`base64 -d | sh`、把 pid 编码进变量、藏进脚本文件）。它的价值在于把模型引导到 `restart_dsh` 并解释后果；真正的隔离需要 PATH 白名单或独立 cgroup，那属于宿主改动。**真正的兜底是：即便宿主被杀，工作也会回来** —— 非计划恢复那条路不在乎进程是怎么死的。
* **它认得出"指向宿主"，但认不出"藏起来的宿主"。** 围栏跑在宿主内部，因此知道宿主的 pid 和命令行；凡是按 shell 自己的匹配规则会选中宿主的查找 + 信号，都会被拦下。但把 pid 藏进变量或脚本之后，它就看不见了 —— 那种情况下靠的是恢复机制，不是围栏。
* **名字里没有「执行」二字的工具一律当数据工具。** 它的载荷不当命令判，所以第三方插件里那些「把收到的字符串当命令执行」的工具在围栏够不着的地方。shell、终端和代码执行器这些通道 —— 模型真正用来重启宿主的那些 —— 是覆盖到的。
* **子代理是因为它的日志被打断才被唤醒，不是因为它的模式。** `continuable` 子会话和 `one-shot` 子会话一视同仁：如果它自己的日志显示有未闭合的轮次，就被唤醒并被告知接着干。跑完的子会话没有活可接，继续睡。
* **人主动停下的会话不会回来。** `aborted` + `user` 被明确排除，`completed` 和 `error` 也是 —— 除非收件箱里还排着一个从未开始的提示。
* **恢复是有上限的。** 一次启动最多恢复 `recoverMaxSessions` 个会话，且只恢复比 `recoverMaxAgeMs` 新的，最新的优先。年龄窗口在读日志之前用文件 mtime 判定，它严格比它所预判的规则更保守：刚刚被打断的会话绝不会被它滤掉。
* **浏览器那一侧不是插件该管的事。** 宿主重启，页面短暂断连，前端会重新挂上。插件恢复的是**会话和工作**，不是页面的连接。
* **`serviceUnit` 只是描述性的。** 重启是自我发信号，所以这个插件从不调用那个单元；这个名字只写进宣告退出的那行日志。真正把新进程拉起来的是单元自己的 `Restart=always`。

### 测试

```sh
npm test        # node --test
```

| 文件 | 覆盖什么 |
| --- | --- |
| `test/restart-handoff.test.mjs` | 两步确认、令牌有效期、确认的边界、会话收集、模型路由、磁盘上的记录。 |
| `test/guard-vectors.test.mjs` | 围栏的向量套件：一条命令一条断言。 |
| `test/recovery-criterion.test.mjs` | 恢复矩阵：哪个 `turn/end` reason 意味着「该回来」，以及排队提示的情形。 |
| `test/handoff-replay.test.mjs` | 重放路径：恢复、交接记录、子代理、队友。 |
| `test/plugin-lifecycle.test.mjs` | `apply` 注册工具、围栏与提示段，并在注册被拒时依然健在。 |
| `test/session-collection.test.mjs` | 一次重启必须带回哪些会话。 |

`probe-guard.mjs` 是一条命令的验收探针：它用真实的围栏跑遍所有已知向量，一旦有不匹配就以非零退出。

---

<a id="english"></a>

## English

<details>
<summary>Click to expand the English version</summary>

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

Install it into a profile with the Harness plugin CLI. **`--profile` is
required** — the CLI forwards the rest to `pnpm` inside that profile's
directory:

```bash
dsh plugin --profile web add dsh-restart-handoff
```

From GitHub instead of npm (no registry account needed):

```bash
dsh plugin --profile web add github:sadkga/dsh-restart-handoff
```

Pin a version by tag:

```bash
dsh plugin --profile web add github:sadkga/dsh-restart-handoff#v0.2.0
```

Restart the Host afterwards: the plugin's client metadata and the loader are
cached until the process restarts.

The plugin needs Node 24 (`engines.node`).

### Installing from a checkout

The plugin is a plain host bundle: a `name`, an `inject` list and an `apply`.
To install a local working copy with the plugin manager, point it at the
directory:

```
plugin_manager → install_bundle → target: /path/to/dsh-restart-handoff
```

That writes the profile's `package.json` dependency (`link:` to this
directory), adds `dsh-restart-handoff` to `dsh.profile.bundles`, and the
loader applies `cordis.patch.yml`, which inserts the plugin row and its
configuration.

To wire it into a profile by hand instead:

```jsonc
// profiles/web/package.json
"dependencies": {
  "dsh-restart-handoff": "link:/path/to/dsh-restart-handoff"
},
"dsh": { "profile": { "bundles": ["dsh-restart-handoff"] } }
```

Then `pnpm install` in the profile directory (`nodeLinker: hoisted`) and a
restart of the Host.

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

Finally, the plugin runs *inside* the Host process, so it knows what the Host
looks like from the outside: its pid, its parent, and **the command line it was
started with**. The rule is therefore no longer "does the number appear in the
text" but "would this lookup, by the shell's own matching rule, select the
Host":

| Form | Result |
| --- | --- |
| `kill -TERM <the Host's literal pid>` | denied |
| `kill $PPID` | denied |
| `P=$(pgrep -f "apps/cli/src/bin.ts web") && kill -TERM $P` | denied |
| `kill $(pgrep -f "apps/cli/src/bin.ts web")` | denied |
| `pkill -f node` | denied |
| `kill 0` (the caller's whole process group) | denied |
| `P=$(pgrep -f "my-unrelated-service") && kill -TERM $P` | allowed |
| `kill -9 12345` (one named process) | allowed |
| `kill -- -12345` (a process group other than the Host's) | allowed |
| `pgrep -f "apps/cli/src/bin.ts web"` (a lookup, no signal) | allowed |

That is the shell's own matching rule, not a guess: `pkill -f` matches the
pattern against every process's **full command line**, so any pattern occurring
in the Host's command line selects the Host — and a lookup for an unrelated
process is ordinary work that must stay allowed. **Walking around it is still
easy** (base64, a script file, a pid encoded into a variable), so the guard's
role remains steering and explanation — **the backstop is the recovery: whether
the Host is killed, crashes, or loses power, the running sessions, their
subagents and their team members come back.**

### Fidelity: the session comes back as it was

A resumed session keeps its own provider, model, reasoning effort and agent
preset, all read from the session log rather than from the deployment
defaults — including the rule that an adapter-defaulted reasoning effort is
not a conversation choice and is therefore not inherited.

## Recovery performance

The scan runs on every start, so its cost is felt by everyone who restarts the
Host. Three things were measured on a real store (132 candidate sessions,
including one 8 MB / 20 000-event log):

| | `took` (whole scan) | `reads` | `readMs` |
| --- | --- | --- | --- |
| naive: read every log in full | 97 750 ms | 49 | 87 353 ms |
| + mtime pre-filter | 31 901 ms | 14 | 29 631 ms |
| + read the log **tail** | — | — | **14 ms** |
| + deliver without waiting for a busy agent | **12 873 ms** | **2** | **14 ms** |

Three decisions produce that:

* **The age window is decided from the file's mtime, before the log is
  read.** Reading a log means decompressing and parsing every event in it; most
  candidates on a real store are long dead. The pre-filter is strictly more
  conservative than the durable rule it pre-decides — the whole store was
  measured, and the difference between a log's last event time and its mtime
  never exceeded 5.7 ms.
* **Only the tail of the log is read.** The criterion is "was the *last* turn
  cut off", so the answer lives at the end: the last `turn/start` and whether a
  `turn/end` follows it. The log is a multi-frame zstd file, so the frames are
  walked from the end and only the last few are decompressed — 88 events
  instead of 21 486 for the largest session. The tail criterion and the
  full-log criterion were compared over every session on the store and agree
  on all of them.
* **A busy agent is not waited for.** A `followup` queues a message for the
  agent's *next* turn; a running agent consumes it at its own turn boundary. A
  message sitting in the queue of a running agent is the normal state, not a
  failure, so the delivery does not wait for the agent to go idle.

The remaining ~12 s is the cost of actually starting the recovered sessions and
their subagents, not of inspecting them.

Two known costs sit outside this plugin's reach:

* Ten of the store's logs are **single-frame** zstd files; a single frame must
  be decompressed from its start, so those fall back to a full read. Making
  them cheap needs the Host to cut logs into more frames.
* The `readSession` path spends most of its time in CPU (decompress, parse,
  `structuredClone`, replay validation), not I/O — which is why reading the
  tail is such a large win, and why reading the logs in parallel is not.

## Known boundaries

* **The guard is guidance, not isolation.** It matches command text, so it can
  in principle be obfuscated (`base64 -d | sh`, a pid encoded into a variable,
  a script file). Its value is that it steers the model to `restart_dsh` and
  explains the consequence; real isolation needs a PATH allowlist or a separate
  cgroup, which is a Host change. **The real backstop is that the work comes
  back even when the Host is killed** — the unplanned-recovery path does not
  care how the process died.
* **It recognises "aimed at the Host" but not "the Host, hidden".** The guard
  runs inside the Host, so it knows the Host's pid and command line; any lookup
  that would select it by the shell's own rule, followed by a signal, is
  denied. Hide the pid in a variable or a script and it is out of sight — and
  then the recovery path is what carries the work, not the guard.
* **A tool whose name does not say it executes anything is treated as a data
  tool.** Its payload is not judged as a command, so a third-party plugin tool
  that executes an arbitrary string it received in a payload is outside the
  guard's reach. The shell, terminal and code-runner channels — the ones a
  model actually uses to restart the Host — are covered.
* **A subagent is woken because its log was cut off, not because of its mode.**
  A `continuable` child and a `one-shot` child are treated the same: if the
  child's own log shows an unclosed turn, it is woken and told to pick the work
  back up. A child that finished has nothing to pick up and is left asleep.
* **A session the human stopped does not come back.** `aborted` + `user` is
  explicitly excluded, and so are `completed` and `error` — unless the inbox
  still holds a prompt that never started.
* **Recovery is bounded.** One start recovers at most `recoverMaxSessions`
  sessions, and only those newer than `recoverMaxAgeMs`, newest first. The age
  window is decided from the log file's mtime before the log is read, which is
  strictly more conservative than the rule it pre-decides: a session
  interrupted a moment ago can never be filtered out by it.
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


</details>
