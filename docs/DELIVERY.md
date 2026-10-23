# dsh-restart-handoff · 交付说明

> 内部交付文档（面向维护者）。用户可见的功能说明在 `../README.md`，设计原理在 README 的 `## Why it is built this way` 一节。

## 1. 目标

让 DeepSeek Harness 的 AI **只通过一个专用工具**重启宿主，并在重启后**自动把工作接回来**——包括正在跑的所有会话、子代理、Agent Team 队友；同时杜绝 AI 用 shell 自杀式重启（那会丢掉一切正在进行的会话）。

## 2. 交付物

| 文件 | 说明 |
| --- | --- |
| `index.js` | 插件主体：工具、围栏、交接协议、启动恢复、子代理/团队唤起 |
| `cordis.patch.yml` | Loader 补丁：插入插件行与配置 |
| `locale/en.json` `locale/zh.json` | 插件面板标题与描述（图标 `icon.svg`） |
| `test/*.test.mjs` | 单元测试（`npm test` → `node --test`） |
| `docs/DELIVERY.md` | 本文件 |
| `probe-guard.mjs` | 一次性验收探针：把全部围栏向量跑一遍，有不符就非零退出（**不发布**，未列入 `files`） |

安装：`plugin_manager` 的 `install_bundle`，target 指向本目录绝对路径。

## 3. 能力矩阵

| 能力 | 实现要点 | 状态 |
| --- | --- | --- |
| 专用工具重启 | `restart_dsh`；shell 自杀被 `ctx.tools.guard` 拦截 | ✅ |
| 二次确认 | 第一次只警告 + 发令牌；第二次执行**警告里那份计划**（不可中途改写）；令牌 TTL 5 分钟、跨重启不保留 | ✅ |
| 交接协议 | 原子写盘（tmp+rename）；退出前一刻重采样会话清单；用后即清 | ✅ |
| 多会话恢复 | 所有未 live 的根会话恢复成 live（上限 50、最新优先）；被打断的额外注入「继续未完成的工作」 | ✅ |
| 子代理唤起 | `continuable` 子代理经投递 API 冷恢复，**自上而下逐层** | ✅ |
| Team 队友唤起 | 队友只被唤醒一次（Team 路径），peer 本身是 Lead 时也唤醒 | ✅ |
| 非计划退出兜底 | 崩溃 / 被杀 / 手动重启 → 启动时自扫持久化会话，接回被打断的 | ✅ |
| 保真恢复 | 沿用会话自己的模型、思考强度、agent preset（从日志与投影读） | ✅ |
| 会话模型/预设保真 | 同上；"适配器补的思考强度不是对话选择"按宿主同一规则处理 | ✅ |

## 4. 恢复判据（本次修复的核心）

**只认最后一个 `turn/end` 的 reason**：

| reason | 恢复？ | 依据 |
| --- | --- | --- |
| `interrupted` | 是 | 写入方崩溃；`session-query` 冷读配平时补的合成收尾（`packages/session/session-persistence-jsonl/src/cold-read.ts:55` → `interruptedTurnClosers`，`packages/core/session/src/repair.ts:96`） |
| `aborted` + `disposed` | 是 | 进程被拆（`Agent.cancel` 的 dispose 路径） |
| `aborted` + `user` | 否 | 人为停止 |
| `completed` / `error` | 否 | 本来就没有在飞的工作 |

**不再使用 `turnBoundary.openTurnStartSeq`**：冷读会先配平日志，该字段恒为 `null`，拿它做判据等于把功能写成死代码（而且是静默失效）。

## 5. 围栏的两层作用域（本次修复的核心之一）

| 工具类型 | 判定 |
| --- | --- |
| 会执行命令的工具（`bash` / `pwsh` / `terminal` / `run_code` …） | 全部参数字符串按**命令行**判定：拆分隔符 → 剥包装器 → 取段首动词 → 看是否指向本机 |
| 存放数据的工具（`write` / `edit` / `read` …） | 只判**代码形态**的自伤信号（`os.kill(os.getppid())`、`process.kill(process.ppid)`、`os.killpg`、`process.kill(-1)`）——散文里不会出现这些 |

同一个内核（`headVerb` → `dangerousSegments` → `collectStrings`），旧内核（`splitSegments` / `tokenize` / `isHostPidIn`）已删除，不存在两套并存。

解释器与执行器调用（`sh -c '…'`、`execSync('…')`、`subprocess.run([...])`、`tools.bash({command: '…'})`）的载荷**递归解析**。

## 6. 验证证据

- **单元测试**：`npm test` → `node --test`，176 个用例全绿（见 `test/` 六个文件）。
- **围栏向量**：`test/guard-vectors.test.mjs` 一条向量一个断言；`probe-guard.mjs` 跑同一批向量，0 不符。
- **恢复判据**：`test/recovery-criterion.test.mjs` 覆盖 reason 全矩阵，并断言 `openTurnStartSeq` **不**参与判定。
- **插件装配**：`test/plugin-lifecycle.test.mjs` 证明 `apply` 能注册工具、围栏、提示词段落，且注册被拒时不整体崩掉。
- **真实重启**：见 `docs/` 与工作区的十一轮源码调研报告（宿主源码为唯一事实依据）。

## 7. 已知边界

- **围栏是引导，不是安全隔离**：命令文本匹配原理上可被混淆绕过（`base64 -d | sh`、变量拼接）。物理隔离需要 PATH 白名单或独立 cgroup，属 DSH 宿主改动。
- **名字不像执行器的工具按数据工具处理**：第三方插件工具若在载荷里执行任意字符串，不在围栏可达范围（README 同名章节有详述）。
- **一次性子代理不可续跑**：只有 `continuable` 模式的能被唤起。
- **用户主动停掉的会话不会复活**（`aborted + user` 明确排除）。
- **崩溃时排队但所属 turn 已正常结束的用户 prompt 不会被重放**：判据只看最后一个 `turn/end` 的 reason。
- **恢复上限**：一次启动最多恢复 `recoverMaxSessions`（50）个会话、只有 `recoverMaxAgeMs`（2 小时）内的；超出部分按最新优先截断。
- **浏览器端**：宿主重启时页面会短暂断连，重连后由前端重新 attach；插件负责的是**会话与任务的恢复**，不是前端的自动重连。

## 8. 上线检查清单

- [x] `package.json`：`exports` / `files`（含 `test`、`docs`）/ `dsh.bundle.patch` 齐全；`engines.node >= 24` 已声明
- [x] `icon.svg` 为合法 SVG（395 字节），插件面板标题与描述在 en/zh 均有本地化
- [x] `scripts.test` = `node --test`（注意：`node --test test/` 在 Node 24 会当模块路径解析，报 MODULE_NOT_FOUND）
- [x] 单元测试全绿
- [x] `node --check index.js` 与 `node -e "import('./index.js')"` 双重验证通过
- [ ] 真实重启一轮复验（发布前最后一步，由维护者统一安排）
- [ ] 装入 `web` profile：`package.json` 的 `dsh.profile.bundles` 追加 `dsh-restart-handoff`，`pnpm install`（`nodeLinker: hoisted`）
- [ ] 若发布到 npm：补 `repository` / `publishConfig`，按 `dsh-plugin-release` 流程推 GitHub + 发包
