# AGENTS.md — 维护 `@local/dsh-opendesign-member`

给**修改这个插件**的 agent 看。本文只写代码侧约定与踩过的坑。

**OD 的实测行为在 [`docs/opendesign-runtime-facts.md`](docs/opendesign-runtime-facts.md)** —— 端口为什么每次都变、`inject` 为什么是取消并重启、表单协议的真实形状、daemon 反复重启时去查哪个日志。改 `od-client.js` / `turn-plan.js` / `watch.js` 之前先读那一份：它记的是**为什么必须这样写**，代码注释只解释当前写法。

## 代码地图

| 文件 | 职责 | 改动信号 |
|---|---|---|
| `index.js` | 工具注册、团队策略（`alignmentPolicy`）、配置收敛、`settingsSnapshot`、`panelSnapshot`（右栏面板）、`runTurn`、`ensureProject` / `ensureConversation`、settings / panel 路由 | 加工具、改提示词、改会话粒度 |
| `lib/od-client.js` | **所有** OD daemon 路由（`ROUTES` 一张表）、端口发现、web UI 发现（`discoverWebUi` / `frameBlocker`）、SSE 事件流（`awaitRun` 首选）与轮询兜底、表单解析、入站分类 | 路由改名、OD 协议变化 |
| `lib/od-events.js` | SSE 帧解析（`parseSseFrame` / `takeSseFrames`）与 `followRun`，纯函数可单测 | 事件流格式变化 |
| `lib/turn-plan.js` | `planTurn()`：一次 `opendesign_ask` 到底是 collect / inject / run / error，**纯函数，有独立测试** | 改 ask 的分支语义 |
| `lib/watch.js` | `reconcileWatch()` 三态核对 + `verdictFromActiveRuns()` 单一权威判决，**纯函数** | 改 status / ask 的忙碌判定 |
| `lib/conversation-watch.js` | `observeConversation()` + `diffConversation()`：什么算「状态变化」、什么只是「还在动」，**纯函数** | 改常驻监视的信号语义 |
| `lib/watch-push.js` | `createWatchNotifier()`：把真实状态变化投成**模型可见**的 user 消息（`Agent.followup`），去重；失败降级成 job 输出里的原因，绝不抛进 watcher 循环 | 改推送文案 / 去重规则 / 投递入口 |
| `lib/turn-actions.js` | `readTurnActions()`：读 run 的 events.jsonl，数这一轮调了哪些工具、有没有**写文件**，喂 `ask` 的 `actions` 字段 | 改「动手了没有」的判据 |
| `scripts/check.js` | 语法检查，文件集**从目录扫**而不是硬编码 | 加新目录 |
| `scripts/test.js` | 逐文件跑测试（绕开沙箱里 `node --test` 的 `spawn EPERM`） | 改测试约定 |
| `lib/bindings.js` | 绑定、游标、`pendingForm`、`pendingRun`、`bridgeRuns` 的持久化，合并写入 | 新增持久字段 |
| `lib/settings.js` | 插件级模型设置（model / reasoning），首次读 OD 当前值播种一次 | 改设置项语义 |
| `lib/sidecar-token.js` | 从 daemon sidecar 铸 import token | 管道名规则变化 |
| `lib/tool.js` | 最小工具定义层（替代 `defineTool`），含参数校验 | `ToolDefinition` 形状变化 |
| `client.js` | 浏览器半边：插件详情页的「运行模型」区块 + **右栏 Open Design 标签页**（tab type/guide 注册、iframe body、降级说明）。`window.__ModuleLoader__.load`，React 由 `require('react')` 而来 | 改设置面板、改插槽、改右栏 |
| `locale/{zh,en}.json` | 插件元数据的标题与描述 | 改文案 |

## 四条硬约定

**零外部依赖。** 插件以 symlink 安装，Node 从真实路径解析模块，profile 的
`node_modules` 里的 peer 包找不到。所以 `index.js` 只 import `node:*` 和自身
`lib/`；需要 DSH 能力时走 `ctx.*` 服务，不 import 包。

**不导出 `Config`。** 导出它就要 import `@deepseek-ai/schemastery`。
配置在 `resolveConfig()` 里逐字段收敛，类型不对就落回 `DEFAULTS`。

**工具装在 agent scope 上。** 参照 `install(agent)`：在 `agent.ctx.tools.register`，
由 `agent/created` 补装、`agent/disposed` 卸载。全局注册会让非团队成员也看到
`opendesign_*`，而工具内部 `membership()` 会抛错。

**`client.js` 里 hooks 不能在有条件的 `return null` 之后。** 插件详情页会渲染所有
section，非本插件的 subject 要走 `props.subject?.pkg?.name !== PACKAGE_NAME` 直接
返回 null——但这个判断必须在**外层无 hook 的包装组件**里做，把带 hooks 的面板拆成
子组件。写在 hooks 之后会让 React 报 hooks 顺序错误。主题色只用 `Theme.listTokens`
里真实存在的 `--dsw-alias-*`，不要凭命名习惯编。

## 验证循环

```powershell
cd <本仓库的绝对路径>

npm run check   # 语法检查：文件集从目录扫，不是硬编码清单
npm test        # 逐文件跑测试；不打印总数就别在文档里写数字
```

两个脚本都**自己发现文件**，不依赖清单。原因有记录：旧 `check` 把文件名一个个写在
`package.json` 里，新增的 4 个模块没人登记，往 `lib/watch.js` 里注入语法错误后
`npm run check` 仍然报成功——护栏一旦会假通过就比没有更糟，因为它会被信任。

`npm test` 逐文件 `node test/<file>.test.js`，正是绕开沙箱里 `node --test` 的
`spawn EPERM`：它要起子进程跑每个文件，而那个子进程在部分沙箱下起不来。输出末尾有汇总行。

改完源码再让运行中的 profile 加载新代码（不必重启 DSH）：

```
plugin_manager set_plugin target=include:opendesign-member enabled=false
plugin_manager set_plugin target=include:opendesign-member enabled=true
# 期望 application: applied
```

改动只涉及 `lib/` 或 `index.js` 时，重载插件行即可——安装方式是 link，不用重装。

**`node --test test/` 会失败——这是 Node 24 的行为，不是测试坏了。** 目录参数会被当成模块入口去解析，报
`Cannot find module ...\test`。用 `npm test`（它内部是 `node --test "test/*.test.js"`，由 Node 自己展开 glob）。

**别用重型 OD 任务做验证。** 一个跑满 `max` 推理档的 turn 会把 OD 单线程
daemon 的事件循环占满，连 `/api/health` 都超时，看起来像插件坏了。用短 prompt、
`timeout_ms` 收紧到 300000 以内。

**`reasoning` 不是处处可用的旋钮。** 当前 OD 选的 CLI 是 `amr`：37 个模型，
**`reasoningOptions` 全为空**，传任何档位都被静默丢弃。只有 `deepseek-harness`
那类带 provider 前缀的 CLI 才有档位。想确认当前 CLI 能不能吃档位，先
`GET /api/app-config` 看 `config.agentId`，再核对该 agent 的模型表。

## 踩过的坑

**监视必须活得比调用久，所以它是 job 不是轮询。** 先做过一版「`ask` 等待期间顺手看一眼」
的 watchdog，很快就废了：`ask` 一返回它就瞎了，而那正是 run 继续跑的时刻。Lead 交出
回合之后就再也看不见 OD 还在干活，只能等下次自己想起来去 `status`。`opendesign_watch`
用 `ctx.jobs` 起常驻任务，产出走 job 的输出环，`job_output` 读、`job_kill` 停。

**`ctx.jobs` 是可选服务，不要写进 `inject`。** 它用 `ctx.get('jobs')` 取，取不到就
报一句「这个组合里没有 jobs，改用 status 轮询」——把 `jobs` 写进 `inject` 会让整个插件
在没装 jobs 的组合里直接起不来，为了一个功能废掉全部功能。

**「状态变了」和「还在动」必须分开报。** thinking 阶段事件流每轮都在涨，若把它算作
变化，每 5 秒一条「有新闻」，人就开始忽略这个信号。`diffConversation` 只把
`appeared` / `status` / `gone` 算变化，journal 增长单独归为 `activity`（不报）。

**`unknown` 不是一种状态，是「没看到」，永远不能报成事件。** 实测过的现场：一个 run
在队列里出现三条消息 —— `appeared`（收据回声）、`now unknown`（一次轮询超时）、
`gone (was unknown) — its answer can be collected`（基线被 unknown 覆盖，于是
「消失」了从没被观测到的状态，还断言答案可取）。三条规则：

- `diffConversation` **开头**就守 `current.status === 'unknown'` → `changed: false`
  （放最前，所以首见 unknown 也不会报 `appeared`）；`gone` 时若基线是 unknown
  （防御性分支），文案只许说 `no longer visible`，**不许**说答案可取。
- **基线只被确定观测覆盖**：`if (observation.status !== 'unknown') previous = observation;`。
  否则恢复后报的是 `gone (was unknown)`。这条由 `test/watch-push.test.js` 源码级钉住。
- 已结束（terminal）的 run 之后被 daemon 回收，其「消失」**不再报**：结束那一下已经
  报过，再报一次是同一个事实说两遍。

**`GET /api/runs?…&status=active` 不能当观测源 —— 对本插件的工程它恒为空。** 实测
（0.26.1，run 确实 `running` 时逐秒采样 8 次全部如此）：带 `conversationId`、
`projectId`、两者、`workspaceId` 全都 `200 {"runs":[]}`，而同一时刻
`GET /api/runs/:id` 对同一个 run 返回 `running`；缺 `projectId` 时是
`400 PROJECT_SCOPE_REQUIRED`（Workspace-bound 工程），补上它只是把 400 变成空列表。
**空列表和「什么都没在跑」无法区分**，所以 watcher 曾在对整个 run 的持续期间判 idle，
一条消息都不报 —— 比噪音更糟，而且看起来完全正常。现在的观测源是：

1. **会话消息行**给出 run id（每条 assistant 行都带 `runId` / `runStatus`，也覆盖
   人在 OD 窗口起的 run）—— `latestUnfinishedRunId()`，纯函数，有测试；
2. **`GET /api/runs/:id`** 给出状态。

`listRuns` 保留（路由没错，只是不可作观测源），但热路径不许再调它 ——
`test/authoritative-watch.test.js` 钉住这条。

**watcher 必须被「告知」当前该看哪个 run，因为 `ask` 是先 arm 再起 run。** 两个机制：

- `seedRun(runId)` 钩子：`onRunCreated` 里调，**reuse 路径也必须共享它**，否则复用来的
  watcher 会一直盯着上一轮已经结束的 run，新 run 永远看不见。
- `knownRunId` 在 run 不再 working（终态 / 记录消失）时释放，下一 tick 重新发现下一个
  turn；**读取失败时保留**（「没看到」不等于「结束了」，丢了 id 就正好在 daemon 忙时瞎掉）。

**「调用方已经拿到这一轮结果」不算新闻，不能推第二遍。** `opendesign_ask` 会先
arm watcher 再起 run，所以它自己等待的那一轮会被 watcher 看见。如果那一轮在等待
预算内 settle，答案已经随工具结果交回，再推一条 `appeared`/`gone` 就是同一次完成
报两遍（host 对 jobs 的 `settled.awaited` 正是同一条规则）。做法是一张**活的**
`selfHandled` 集合：`onRunCreated` 时把 run id 放进去，等待结束时如果
`settled.stillRunning === true`（答案没交回）就**删掉**，把这一轮交还给 watcher，
之后的 `gone` 正常推。job 输出里对应 `push skipped: this call already carries that
run's result`。删掉这个集合会让每次正常 `ask` 都多出两条噪音推送。
`inject` 停掉的 run 也放进这个集合：转弯结果里已经带了 `interrupted: { status,
cancelOrigin }`，watcher 再推一条 `canceled` 就是同一件事第二次。

**fire-and-forget 的收据本身就是「这个 run 在跑」，不能再推一次 `appeared`。**
另有一张 `startedHere`（与 `selfHandled` 同款：watcher 拥有、reuse 共享、`gone`/终态时
清理）：本进程 `ask` 起的 run，在它仍 working（`isWorking`）时不推 —— 收据已经说过，
`queued→running` 也只是回声。**只推「它不 working 了」那一条**，也就是答案可取的信号。
显式 `opendesign_watch` 往里加是错的（它没有收据可重复），人从 OD 窗口起的 run
也就不在集合里，它的出现照旧推送。

**状态变化要「推」给模型，不能只写进 job 输出。** job 输出只有模型主动 `job_output`
才看得到，而 run 在没人盯的时候继续跑，正是它最需要被提醒的时刻。现在 `armWatcher`
在 `if (report.changed)` 分支里同时做两件事：照旧追加 job 行，并调 `lib/watch-push.js`
的 `notify()`，用 `Agent.followup(message)` 投一条 user 消息
（`source.kind: "opendesign-watch"`）。`followup` 不是自己发明的入口：dsh-schedule
投提醒用的就是它（durable inbox splice + 唤醒 idle driver）。四条不能写错：

- **只在 `report.changed` 内推。** journal 增长是 `activity`（`changed: false`），
  每 5 秒推一条会训练人/模型忽略这个通道。
- **一批变化只推一条**，不是每行一条；job 行是给人看的记录，推送是给模型的提醒，
  两者都要写。
- **每次推送都重新 `ctx.agents.get(owner)`。** watcher 活得比 turn 久，arm 时拿到的
  Agent 可能早已 dispose；缓存它等于在对方搬走后还往旧地址投信。
- **推送失败绝不抛进 watcher 循环。** 没有 live agent / `followup()` 抛错 / 异步拒绝，
  都只记**一次性**原因，由 job 输出追加一行 `model push unavailable: …`；监视本身
  照常跑。没有 jobs 服务的组合仍然只是 `opendesign_watch` 报错改用 status 轮询。

去重键是 `kind|runId|status`，同一个 transition 不会推第二次；`gone` 用 previous
observation 的 runId（消失的 run 在 current 里已经没有 id 了）。没有 runId 时消息不带
`opendesign_ask`——不发明一个假 id。

**右栏标签页是「类型 + 座位 + guide 入口」三件事，少一件就不可达。** 客户端服务
`ctx.sidebarRightTabs.register({ id, kind, title, guide })` 声明类型；
`ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id })` 渲染 body；
人从 guide 页点入口时由 `ctx.sidebarRight.openTab(kind)` 打开。**`id` 与座位 `key`
必须是同一个字符串**（tab 按类型 id dispatch，座位按 key 取），`kind` 只是导航名。
`inject` 里不要写死 `sidebarRight` / `sidebarRightTabs`：用 `ctx.inject([...], cb)`
条件注册，组合里没有右栏时只损失这个标签页，设置面板照常。

**web UI 的端口不能按端口号扫出来，必须问 install-info，且要双判别。** 实测 0.26.1
在同一台机器上 `Open Design.exe` 同时监听 daemon(64112)、内部 Next 后端(64118)、
web UI(64120)；64118 的 `GET /` 也回 200 text/html，但 `/api/*` 回 HTML、不代理
daemon——按端口升序扫描会正好选中它，iframe 里就是「壳能开、所有请求都失败」。
`GET {daemon}/api/mcp/install-info` 的 `webBaseUrl` 才是权威地址；每个候选必须同时
满足 `GET /` 是 HTML **且** `GET /api/health` 是 JSON。`frameBlocker` 另判
X-Frame-Options / CSP `frame-ancestors`，被拒就如实报原因并给「新标签打开」。

**右栏面板的路由必须只读。** 打开一个标签页不该 provisioning：`panelSnapshot` 用
`store.peekTeam` 读坐标，不调 `ensureProject` / `ensureConversation`，路由只注册
GET。这条有源码级测试钉住（`test/client-panel.test.js`）。

**`opendesign_ask` 起新轮默认 fire-and-forget（`askStartWaitMs = 0`）。** OD 接受 run
就返回收据（`runId` + `watcher`），Lead 继续下一件事；答案之后由 watcher 推送，再用
`run_id` 收。三条硬约束：
- **0 不能直接传给 `awaitRun`。** 它的约定是 `timeoutMs <= 0` = **不设期限**（永远等），
  所以「不等」必须在 `runTurn` 里 **提前 `return receipt()`**、在 `awaitRun` 之前；
  把 0 传下去会把 fire-and-forget 变成最长阻塞。
- **`onRunCreated` 必须在提前返回之前执行**，否则 bridgeRuns 不登记、watcher 不知道
  这轮归谁，收答案时会被当成新到货。
- **显式 `timeout_ms` 才等**，并受 `turnTimeoutMs` 单次调用上限约束；收 `run_id`
  默认 15s（`COLLECT_DEFAULT_WAIT_MS`），超时返回 `stillRunning` + live watcher。

**`discoverDaemon` 可能把 web sidecar 当成 daemon（它代理 `/api/health`）。** 重启后
端口乱序时实测会发生（web 59278 < daemon 59959）：功能上能用（都走代理），但
`daemon.baseUrl` 显示成 web 地址，而面板随后把「daemon 地址」从 web 候选排除，于是
`install-info` 报的 `webBaseUrl` 恰好等于它时报「找不到 web UI」。修法：
- daemon 发现成功后做一次 `/` 探测：HTML = web sidecar → 问它的
  `install-info.daemonUrl` 并改写为真实 daemon；
- `discoverWebUi` 的排除集合只管**端口扫描**，**不否决** install-info 的权威报告
  （报告与 daemonUrl 相同也接受）。

**右栏面板与 status 共用一份发现结果，并靠 revision 自动刷新。**
`lastKnown = { daemonUrl, web }` 由连接/发现成功更新；`opendesign_status` 直接报
`web`（未知时后台预热一次，绝不 await），面板路由用同一份，discovery 失败时回退上次
地址并标 `stale: true`。watcher 的真实变化、新 run 接受、答案收取都会
`bumpPanelRevision()`；面板每 2s 读一次路由，revision 变了就重载 iframe——这就是
「后台监视到 OD 有动作时自动刷新侧边栏」，浏览器自己不扫 OD。读取失败也会 2s 后自动重试。

**端口每次启动都变。** 实测 8620 → 10191 → 9690 → 14246 → 3228 → 14197。
`ownedPorts()` 用 `tasklist` + `netstat` 找出 OD 进程实际监听的端口；**不要**改回
`powershell.exe` 子进程，它在部分沙箱下静默失败（stdout 为空），会让发现逻辑
悄悄退化成默认端口列表。

**`/api/health` 超时 ≠ daemon 不在。** 单线程忙时 socket 照样 accept。所以
`discoverDaemon` 分两段：先短超时探 health，超时则用 TCP connect 判定"忙"，
报 `daemon-down` / `daemon-unreachable` 区分两种处置方式。

**等待上限绝不能变成取消键。** `awaitRun` 的 `timeoutMs` 到点必须返回
`stillRunning: true` + `runId`，**不能**调 `cancelRun`。曾经的写法是把
`AbortSignal.timeout(budget)` 和调用方的 signal 一起 `AbortSignal.any(...)` 传进去，
于是超时顺带按下了停止——而 OD 那轮其实还活着，继续跑了 36 分钟、写到 12.8 MB
事件，谁也没法再取回答案。只有调用方自己的取消才允许 `cancelRun`；超时只是
「我不再等了」，答案靠 `opendesign_ask({ run_id })` 事后收。

**`GET /api/agents` 是 9–11 秒的调用，谁在热路径上拉它谁就毁了那条路径。**
OD 每次调用都重跑所有运行时的模型枚举，无服务端缓存，响应 60 KB。实测过一次
`opendesign_status` = 19 秒，构成是：`probe()` 里的 `agents` 检查 + 紧跟其后的
`listAgents()`，**同一份数据拉了两遍**，而且它拿到的只是 37 个裸 id，既不便宜
也不够用——完整的 provider + `reasoningOptions` 目录本来就按 CLI 缓存在
`catalogue-cache.json`（7 天 TTL），设置面板一直在用。现在：

- `probe({ skip, capture })` —— `skip` 完全不发请求且**不算 degraded**（"没问"不等于
  "坏了"）；`capture` 把响应体留在 `features[name].value`，调用方不必再问一次。
- `status` 默认 `skip: ['agents']`，耗时 19 s → **46–63 ms**（本机实测）。
- **`include_models: true` 时也照样 `skip: ['agents']`。** 容易写错的第一版就是这么错的：
  打开开关才不 skip，于是 `probe()` 拉一遍、`catalogue(force)` 又拉一遍，实测 18.1 s ——
  和最初那个 bug 一模一样，只是搬到了显式路径上。`probe` 的 `agents` 检查与任何
  `listAgents()` / 目录刷新**永远互斥**，只能有一个去拉。
- 任何新工具想读 CLI 当前选中的模型，走 `currentCli(od, prefetchedConfig)` 或
  `cachedCatalogue(agentId)`，**不要**为了一个显示字段调 `probe()` 全量或 `listAgents()`。
- 能力位 `agentAvailable` 来自缓存，冷缓存时报 `null`（未知），不能报 `false`。

**`pendingRun` 必须有人读。** `notePendingRun()` 写了却没人读的那段时间里，
`stillRunning` 回来一旦丢了 `runId`，还在跑的那轮就永久失联——`bindings.json` 里
有记录，但没有任何工具开口。现在 `opendesign_status` 顶层 `pendingRun` 如实回报，
并附 `collectWith`（可直接照抄的那次 `opendesign_ask({ run_id })`）。加新工具时
别再让持久字段只写不读。

**「引导对话」= 取消并重启，不是 steer。这是本插件最容易被写错的一条。**

三层事实，按实测顺序：

1. `POST /api/runs/:id/steer` 在 `amr` 上返回 **409 `RUN_STEERING_UNSUPPORTED`**，
   原文 “its stdin is closed together with the opening prompt”。OD 源码把这条路由标注为
   「引导对话」，所以看起来「界面有、桥接也能做」。
2. **但界面的按钮不走那条路由。** 实测（2026-10-25，人肉点按钮 + 数据库取证）：run
   `56f9c028` 还在跑时点它，会话里**没有出现任何新的用户消息行**，却起了新 run
   `8473cde6`（在旧 run 结束前 105ms），旧 run `cancel_origin: user_stop`；新 run 的
   thinking 里明确提到 `prior_transcript` —— 它靠前文转录续上，不是中途注入。
3. 所以本插件的 `inject` 也做**取消并重启**：`cancelRun(旧的)` → 等终态 → `createRun(新)`，
   旧 run 的产出用 `interrupted.answerSoFar` 如实回报。

改这块前的三条硬约束：

- **不要在 `inject` 里另写用户消息。** 那句话会成为新 run 自己的 user turn；先写再跑
  会让同一句在历史里出现两次。`pendingInject` 那套（写行 + `userMessageId` 复用）已经  删掉，别再加回来。
- **取消后必须等终态再起新 run。** `handleRunCreate` 对普通聊天 run **不做**单会话互斥
  （daemon 注释：`ordinary chat turns are never gated by this`），两个活 run 会交错历史。
- **`answerSoFar` 要在取消之前取。** 取消后再读，读到的是终态记录，不是被中断那一刻的产出。

判定分支全在 `planTurn()`（`lib/turn-plan.js`），它是纯函数，`test/turn-plan.test.js`
钉住了 12 条语义。往 `ask` 里加分支之前先改那里，别在 `execute` 里堆 if。

**`<question-form>` 是助手文本，不是工具调用。** 那一轮 run 的终态是
`succeeded`。解析交给 `splitQuestionForm`；它输出三种 JSON 形态（`{questions}` /
单问题根 / 数组根），`title` 可能在开标签属性上也可能只在 JSON 体里。

**`readInbound` 要读两类东西，且不能把桥接自己的回答当成新到货。** `messages`
是 human 的话，`odReplies` 是 OD 自己在桥接之外那一轮的回话。判"是不是桥接发起
的"有三层，缺一层就有一种历史数据会说谎：

1. `bindings.bridgeRuns`（本轮 run 在**等待之前**登记，否则并发 `inbox` 会抢在
   登记前重复投递）；
2. run 的 `clientRequestId` 以 `dsh-` 开头（人在窗口发的是 UUID）——**唯一可追溯的
   权威判据**，对登记功能上线前的旧 run 也成立；
3. 它回答的那条 user 消息带 `[成员 (DSH …)]` 前缀——给最早那批
   `clientRequestId` 为空的旧 run 兜底（实测存在 `clientType: web`、id 为空的 run）。

只做第 1 层就够本地自测通过，但用户的历史会话会一次性冒出 6 条假"新到货"。三层
都要有；新增判据时先拿真实会话跑 `readInbound` 看 `odReplies` 是否只剩人发起的那条。

**`flush()` 合并而非覆盖，而且合并粒度是 FIELD，不是 member。** 多个成员可能在不同
工具调用里写同一份 `bindings.json`，整体覆盖会丢别人的写入。**更隐蔽的一层**：两个工具
调用会同时持有**同一个** member 的两半——`opendesign_ask` 写 `bridgeRuns`，
`opendesign_inbox` 写 `cursor`。按 member 整体替换时，后写者把前者的字段一起抹掉；
实测丢的正是 `cursor`，后果是入站消息被重复投递，破坏「恰好一次」。
所以每个 setter 登记自己写过的字段，`flush()` 只取这些字段，其余从磁盘来。
**删除也算一次写**：`clearPendingRun` / `clearPendingForm` 靠它才不会被磁盘副本复活。
`setMember` 只认领坐标字段（`CONVERSATION_STATE_FIELDS` 之外的），因为调用方会
`{ ...binding, model }` 整体展开一个可能过期的 member。

**「这个会话在不在跑」现在走「消息行 + `getRun`」，不再走 run 列表。** 历史记录：曾经
以为 `GET /api/runs?conversationId=X&status=active` 是唯一权威答案（一次查询取代了
三处猜测，单次 1–2 ms 对旧路径 38 ms，项目状态启发式 `liveProjectRun` 因此整个删除）。
速度结论仍然成立，但**正确性结论被推翻**：对这个插件的 folder-backed 工程，该路由恒返回
空列表（见上一条实测）。所以候选 id 来自会话消息行，状态由 `getRun` 确认；
`reconcileWatch` 只作「什么都没确认」时的降级路径。
**查询失败是 `unknown`，不是 `idle`**：判闲会起重复 turn，判忙会让成员永久瘫痪。

**「不知道」必须是第三种状态，不能压成忙或闲。** `reconcileWatch` 返回
`state: 'busy' | 'idle' | 'unknown'`，`busy` 是 `true | false | null`。
压成忙 → 一次查询失败变成永久阻塞（实测：该成员此后所有 `ask` 永远返回 `adopted`，
只能手改 `bindings.json` 救）；压成闲 → 在活 run 上起第二轮、两条历史交错。
所以 `unknown` **放行**，最坏只是多起一轮，daemon 的 `409 RUN_IN_PROGRESS` 兜底。
守卫写成 `watch.busy === true`，**不能**写成 `if (watch.busy)`。

**`opendesign_ask` 的顺序：问「要不要起新轮」必须在「停掉旧轮」之后。**
`watch` 先算一次给 plan 用；若这次要 interrupt，取消成功后必须**重新**观测，
再用新结论过守卫。原写法在取消前算、取消后不重算，于是活 run 上 `inject` 会
「杀掉旧轮 + 不起新轮 + 返回 adopted 报那个刚被杀掉的 run」——净功能为零。
这个缺陷在 `planTurn` 和 `reconcileWatch` 各自的测试里都看不见，因为它在两者的
**组合处**；`test/ask-order.test.js` 用正则读源码钉住了顺序。

**`awaitRun` 首选 SSE（`GET /api/runs/:id/events`），失败退轮询，且降级要响亮。**
实测一轮 15 秒的任务：SSE 路径 1 次 `getRun`，轮询路径 13 次；一轮 10 分钟的任务
从约 600 次降到 1 次。四条不能写错：
1. **到点只 abort 连接，绝不 cancel run**（见上一条血泪史）。
2. 响应不是 `text/event-stream` 就退轮询，并把原因**写进 `degraded`**，
   `opendesign_ask` 的返回体里有这个字段（`ASK_SCHEMA`）。不要静默降级。
3. 帧解析在 `lib/od-events.js`（纯函数可测）：`id:` / `event:` / `data:`，
   空行分隔，`: keepalive` 跳过，终态看 `event: "end"`。
4. 流在没有 `end` 的情况下关掉**不算结束**：先带 `Last-Event-ID` 重连一次，
   再不行才退轮询。

**OD 不提供删除消息的 API。** 探针消息会永久留在会话里，测试前想清楚。也不要
在用户真实会话里留探针——它们会污染 `odReplies` 的判据。

## 改完检查

- `npm test` 全绿（沙箱里 `node --test` 报 `spawn EPERM` 就逐个跑测试文件）
- `opendesign_status` 的 `degraded` 为空
- `opendesign_status` 明显快（本机基线约 46–63 ms）。慢回 9 秒以上，就有东西在热路径上
  拉了 `/api/agents`——用 `degraded` 看不出来，它不会因此降级
- 四个工具（`open` / `ask` / `status` / `inbox`）都在 `Tool.listTools` 里，且 `parameters` 非空对象
- `opendesign_status` 不写盘（调用前后 `bindings.json` mtime 不变）
- 改过入站逻辑后：`opendesign_inbox` 连调两次，第二次应为空（恰好一次）

## 测试覆盖了什么，没覆盖什么

`test/` 下的测试全部跑在纯函数与单方法导出上，**不需要 Open Design 在运行**：

| 文件 | 守的是什么 |
|---|---|
| `await-run.test.js` | 等待上限不得取消 run；显式取消必须取消；答案按 `assistantMessageId` 取；`isTerminalRun` 不看 `exitCode`；SSE 到点只断连接；非 SSE 退轮询且**报 degraded**；流无 `end` 关掉不算结束 |
| `od-events.test.js` | SSE 帧解析：`id`/`event`/`data` 三元组；`: keepalive` 跳过；多行 data 合并；跨 chunk 切断不丢帧；坏 JSON 只报告不抛 |
| `ask-order.test.js` | **组合处**的顺序：`observe` 在 cancel **之后**、守卫**之前**；守卫只认 `busy === true`；两处 return 都能带 `interrupted`；collect 默认只等 15s（起轮仍 600s）、`stillRunning` 的 collect 必须带 live watcher |
| `authoritative-watch.test.js` | `liveProjectRun` 已删；**run 列表不得作观测源**（实测对 folder-backed 工程恒为空）；发现走「消息行 + `getRun`」；`knownRunId` 在 run 不再 working 时释放；`seedRun` 钩子存在且 reuse 共享；查不到是 `unknown`；`excludeRunIds` 生效 |
| `read-inbound.test.js` | 三类到达分开（人类 / OD 自答 / 桥接已答）；三层归属判据**各有独立测试**；光标恰好一次；未跑完不算回答 |
| `settings.test.js` | 播种只发生一次且不覆盖用户选择；失效的模型/档位被**报告**而非静默替换 |
| `bindings.test.js` | `flush()` 按**字段**合并不覆盖；同一 member 的不同字段两个 store 都不丢；清除不会被复活；换会话要丢掉旧窗口状态；读操作不写盘；`bridgeRuns` 去重且有上限 |
| `probe.test.js` | 被 `skip` 的检查**一个请求都不发**且不算 degraded；`capture` 留住响应体；version 不重复拉；枚举模型时不同时跑 `agents` 检查 |
| `turn-plan.test.js` | collect 不发消息；改口要取消在途 run 并命名它；无在途 run 时不假装取消；改口**不另写历史行**；发送者前缀只加一次；空白串不算 prompt |
| `watch.test.js` | 在跑的 run 压过丢失的记录；查询失败是**三态 `unknown`**（压成忙会永久阻塞，压成闲会起重复 turn）；结论必须带 `collectWith`；空白 run id 不算 run |
| `conversation-watch.test.js` | 状态变化才是事件；journal 增长只是 activity（不算变化）；run 消失要单独报（答案此刻可取）；settled 状态不得读成 running；**`unknown` 永不报成事件**（首见、常态、以及 blind 之后恢复用最后确定基线）；已结束 run 被回收不重报；`latestUnfinishedRunId` 从消息行发现当前 run（终态行表示没在跑、状态未落地仍算候选、无 runId 行跳过） |
| `turn-actions.test.js` | 数对工具与次数；`Write` 判为改动文件、只读工具不算；**读不到的日志是 unknown 不是 0**；纯讨论保持沉默；坏行跳过不致命 |
| `watch-push.test.js` | 一次真实变化只推一条；`activity` 不推；消息形状/文案/收集调用正确；missing/disposed agent 只记一次性原因、绝不抛；每次推送重新解析 live agent；同一 transition 去重；`gone` 用 previous 的 runId；源码钉住推送在 `report.changed` 分支内、失败写回 job 输出、全仓仍只有一个 `jobs.start(`；`selfHandled` 集合（ask 自己等待的那一轮不重推、`stillRunning` 才交还） |
| `od-webui.test.js` | 显式 `webUrl` 先验证再使用；**HTML 但 `/api/health` 非 JSON 的内部 Next 后端被拒**；install-info 的 `webBaseUrl` 优先且仍被验证；X-Frame-Options / `frame-ancestors` 拒绝带 header+value；缓存 TTL 与 `cache:false` |
| `client-panel.test.js` | 客户端 tab type 与 body 用同一个 key、guide 入口存在、右栏能力是条件注入、只有 `embeddable === true` 才渲染 iframe、降级必须带原因；Host 面板路由 GET-only、`panelSnapshot` 只读、deep link 路径形状 |
| `imports.test.js` | `index.js` 调用的每个本地 `lib/` 导出都必须被 import（真实缺陷：`observeConversation` 未导入 → watcher 永远只写 "not ready yet"、一条状态变化都报不出来） |

**没覆盖**：`index.js` 的工具注册与 Cordis 集成、`client.js` 的 React 渲染、
以及任何需要真实 daemon 的路径（端口发现、sidecar token、`ensureProject`）。
这些改动仍需在真实环境里手动验一次（本轮已用真实会话 + 无头 Edge 做过端到端验证，
见 `review-opendesign/DELIVERY-v0.4.0.md`）。

写新测试时优先用 `test/helpers.js` 里的 `fakeClient` / `runRecord` / `message` —
它们固定了 daemon 的字段形状，避免各测试各自臆造。
