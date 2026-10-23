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
| `docs/research/` | 十一轮源码调研与对抗性实测报告（事实依据） |

安装：`plugin_manager` 的 `install_bundle`，target 指向本目录绝对路径。已装入 `web` profile（`package.json` 的 `dsh.profile.bundles` 末位，`node_modules` 为指向本目录的 link）。

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

## 4. 验证证据

- **真实重启 13 次**：其中多次由 AI 通过工具触发、多次由 agent 绕过工具直接重启、多次为崩溃式退出。
- **多会话并发实测**：三个会话同时在跑，其中一个触发重启 → 日志逐条记录 `resumed as initiator` / `resumed as peer` / `replayed the handoff: 3 session(s) resumed`；被中途打断的会话恢复后自行接续并继续委派子代理。
- **非计划恢复实测**：连续多次重启，相同的一批会话每次都被自动救回；恢复后注入的唤醒文案与 `wakeSubagents` 逐字一致（子代理唤起链实证）。
- **单元测试**：`npm test` 全绿，覆盖工具流程、确认语义、令牌 TTL、围栏、恢复判据、子代理/团队唤起。
- **对抗性实测**：十一轮报告里逐条列出的自杀向量与误报清单，围栏逐条复测。

## 5. 审计台账（19 项，全部已修）

功能面：模型/preset/思考强度保真、确认语义绑定、pending TTL、子代理发起拒绝、恢复范围扩大、重启前重采样、pending 无条件清理、`SessionAlreadyOwnedError` 回落活 Agent、队友双重唤醒、peer Lead 漏唤醒、投影 key 读错导致恢复功能空转、启动路径并发、恢复判据并集、残留变量引用、交接记录提前 return。

围栏面：`process.ppid` 符号写错、`kill -1` / `kill -- -1`、`killall5`、`xargs kill`、Windows 动词（taskkill / Stop-Process / Get-Process|Stop-Process）、init 家族、误报收口、解释器 `-c` 递归、路径 basename、包装器带值选项、`VAR=val` 赋值、只读动作豁免、参数内容全量扫描（覆盖 `run_code`/PTC 等执行通道）。

## 6. 已知边界

- **围栏是引导，不是安全隔离**：命令文本匹配原理上可被混淆绕过（`base64 -d | sh`、变量拼接）。它的价值是把模型引导到 `restart_dsh` 并说明后果；物理隔离需要 PATH 白名单或独立 cgroup，属 DSH 宿主改动。
- **一次性子代理不可续跑**：只有 `continuable` 模式的能被唤起。
- **`one-shot` 会话与被用户主动停掉的会话不会复活**（判据 `aborted + user` 明确排除）。
- **恢复上限**：一次启动最多恢复 50 个会话、其中最多 20 个注入续跑消息；超出部分按最新优先截断，日志写明。
- **浏览器端**：宿主重启时页面会短暂断连，重连后由前端重新 attach；插件负责的是**会话与任务的恢复**，不是前端的自动重连。

## 7. 上线检查清单

- [x] `package.json`：`exports` / `files` / `dsh.bundle.patch` 齐全；`license` / `author` / `keywords` 已声明
- [x] `icon.svg` 为合法 SVG（395 字节），插件面板标题与描述在 en/zh 均有本地化
- [x] `scripts.test` = `node --test`（注意：`node --test test/` 在 Node 24 会当模块路径解析，报 MODULE_NOT_FOUND）
- [x] 单元测试全绿
- [x] 已装入 `web` profile 并实际生效
- [ ] 真实重启一轮复验（发布前最后一步）
- [ ] 若发布到 npm：补 `repository` / `publishConfig`，按 `dsh-plugin-release` 流程推 GitHub + 发包
