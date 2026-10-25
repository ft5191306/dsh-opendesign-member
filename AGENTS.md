# AGENTS.md — 维护 `@local/dsh-opendesign-member`

给**修改这个插件**的 agent 看。本文只写代码侧约定与踩过的坑。

**OD 的实测行为在 [`docs/opendesign-runtime-facts.md`](docs/opendesign-runtime-facts.md)** —— 端口为什么每次都变、`inject` 为什么是取消并重启、表单协议的真实形状、daemon 反复重启时去查哪个日志。改 `od-client.js` / `turn-plan.js` / `watch.js` 之前先读那一份：它记的是**为什么必须这样写**，代码注释只解释当前写法。

## 代码地图

| 文件 | 职责 | 改动信号 |
|---|---|---|
| `index.js` | 工具注册、团队策略（`alignmentPolicy`）、配置收敛、`settingsSnapshot`、`runTurn`、`ensureProject` / `ensureConversation`、settings 路由 | 加工具、改提示词、改会话粒度 |
| `lib/od-client.js` | **所有** OD daemon 路由（`ROUTES` 一张表）、端口发现、轮询、表单解析、入站分类 | 路由改名、OD 协议变化 |
| `lib/turn-plan.js` | `planTurn()`：一次 `opendesign_ask` 到底是 collect / inject / run / error，**纯函数，有独立测试** | 改 ask 的分支语义 |
| `lib/watch.js` | `reconcileWatch()`：三个来源（记录 / 会话 / 项目状态）核对「现在到底有没有在跑」，**纯函数** | 改 status / ask 的忙碌判定 |
| `lib/conversation-watch.js` | `observeConversation()` + `diffConversation()`：什么算「状态变化」、什么只是「还在动」，**纯函数** | 改常驻监视的信号语义 |
| `lib/turn-actions.js` | `readTurnActions()`：读 run 的 events.jsonl，数这一轮调了哪些工具、有没有**写文件**，喂 `ask` 的 `actions` 字段 | 改「动手了没有」的判据 |
| `scripts/check.js` | 语法检查，文件集**从目录扫**而不是硬编码 | 加新目录 |
| `scripts/test.js` | 逐文件跑测试（绕开沙箱里 `node --test` 的 `spawn EPERM`） | 改测试约定 |
| `lib/bindings.js` | 绑定、游标、`pendingForm`、`pendingRun`、`bridgeRuns` 的持久化，合并写入 | 新增持久字段 |
| `lib/settings.js` | 插件级模型设置（model / reasoning），首次读 OD 当前值播种一次 | 改设置项语义 |
| `lib/sidecar-token.js` | 从 daemon sidecar 铸 import token | 管道名规则变化 |
| `lib/tool.js` | 最小工具定义层（替代 `defineTool`），含参数校验 | `ToolDefinition` 形状变化 |
| `client.js` | 浏览器半边：插件详情页的「运行模型」区块。`window.__ModuleLoader__.load`，React 由 `require('react')` 而来 | 改设置面板、改插槽 |
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

**`flush()` 合并而非覆盖。** 多个成员可能在不同工具调用里写同一份
`bindings.json`，整体覆盖会丢别人的写入。

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
| `await-run.test.js` | 等待上限不得取消 run；显式取消必须取消；答案按 `assistantMessageId` 取；`isTerminalRun` 不看 `exitCode` |
| `read-inbound.test.js` | 三类到达分开（人类 / OD 自答 / 桥接已答）；三层归属判据**各有独立测试**；光标恰好一次；未跑完不算回答 |
| `settings.test.js` | 播种只发生一次且不覆盖用户选择；失效的模型/档位被**报告**而非静默替换 |
| `bindings.test.js` | `flush()` 合并不覆盖；读操作不写盘；`bridgeRuns` 去重且有上限 |
| `probe.test.js` | 被 `skip` 的检查**一个请求都不发**且不算 degraded；`capture` 留住响应体；version 不重复拉；枚举模型时不同时跑 `agents` 检查 |
| `turn-plan.test.js` | collect 不发消息；改口要取消在途 run 并命名它；无在途 run 时不假装取消；改口**不另写历史行**；发送者前缀只加一次；空白串不算 prompt |
| `watch.test.js` | 在跑的 run 压过丢失的记录；查询失败**倾向判忙**（判闲会起重复 turn）；结论必须带 `collectWith`；空白 run id 不算 run |
| `conversation-watch.test.js` | 状态变化才是事件；journal 增长只是 activity（不算变化）；run 消失要单独报（答案此刻可取）；settled 状态不得读成 running |
| `turn-actions.test.js` | 数对工具与次数；`Write` 判为改动文件、只读工具不算；**读不到的日志是 unknown 不是 0**；纯讨论保持沉默；坏行跳过不致命 |

**没覆盖**：`index.js` 的工具注册与 Cordis 集成、`client.js` 的 React 渲染、
以及任何需要真实 daemon 的路径（端口发现、sidecar token、`ensureProject`）。
这些改动仍需在真实环境里手动验一次。

写新测试时优先用 `test/helpers.js` 里的 `fakeClient` / `runRecord` / `message` —
它们固定了 daemon 的字段形状，避免各测试各自臆造。
