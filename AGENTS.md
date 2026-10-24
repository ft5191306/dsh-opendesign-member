# AGENTS.md — 维护 `@local/dsh-opendesign-member`

给**修改这个插件**的 agent 看。产品契约与实测证据见本机部署文档
`~/.dsh/opendesign-team-bridge.md`（不在本仓库内），本文只写代码侧约定与踩过的坑。

## 代码地图

| 文件 | 职责 | 改动信号 |
|---|---|---|
| `index.js` | 工具注册、团队策略（`alignmentPolicy`）、配置收敛、`settingsSnapshot`、`runTurn`、`ensureProject` / `ensureConversation`、settings 路由 | 加工具、改提示词、改会话粒度 |
| `lib/od-client.js` | **所有** OD daemon 路由（`ROUTES` 一张表）、端口发现、轮询、表单解析、入站分类 | 路由改名、OD 协议变化 |
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

npm run check   # node --check 每个源文件
npm test        # 35 个测试，无需 OD 在跑、无需 Cordis、无需浏览器
```

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

**端口每次启动都变。** 实测 8620 → 10191 → 9690 → 14246。`ownedPorts()` 用
`tasklist` + `netstat` 找出 OD 进程实际监听的端口；**不要**改回
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

- `npm test` 全绿
- `opendesign_status` 的 `degraded` 为空
- 四个工具（`open` / `ask` / `status` / `inbox`）都在 `Tool.listTools` 里，且 `parameters` 非空对象
- `opendesign_status` 不写盘（调用前后 `bindings.json` mtime 不变）
- 改过入站逻辑后：`opendesign_inbox` 连调两次，第二次应为空（恰好一次）

## 测试覆盖了什么，没覆盖什么

`test/` 下的 35 个测试全部跑在纯函数导出上，**不需要 Open Design 在运行**：

| 文件 | 守的是什么 |
|---|---|
| `await-run.test.js` | 等待上限不得取消 run；显式取消必须取消；答案按 `assistantMessageId` 取；`isTerminalRun` 不看 `exitCode` |
| `read-inbound.test.js` | 三类到达分开（人类 / OD 自答 / 桥接已答）；三层归属判据**各有独立测试**；光标恰好一次；未跑完不算回答 |
| `settings.test.js` | 播种只发生一次且不覆盖用户选择；失效的模型/档位被**报告**而非静默替换 |
| `bindings.test.js` | `flush()` 合并不覆盖；读操作不写盘；`bridgeRuns` 去重且有上限 |

**没覆盖**：`index.js` 的工具注册与 Cordis 集成、`client.js` 的 React 渲染、
以及任何需要真实 daemon 的路径（端口发现、sidecar token、`ensureProject`）。
这些改动仍需在真实环境里手动验一次。

写新测试时优先用 `test/helpers.js` 里的 `fakeClient` / `runRecord` / `message` —
它们固定了 daemon 的字段形状，避免各测试各自臆造。
