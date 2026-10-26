# 变更记录

本文件记录每个**发布版本**的可用性变化。只写使用方能观察到的东西：工具行为、字段、
修复掉的错误结论。内部重构若不影响外部行为，归入「维护」。

版本遵循语义化版本：破坏性行为变化升主版本，新能力升次版本，修复升补丁版本。
本插件以 symlink 方式装载，`private: true` 不入 npm，版本号用于 DSH profile 的
装载记录与这份记录本身。

---

## 0.4.0

以「让 Lead 起完轮就能走开，且回来时看到的是事实」为核心的版本。三件事：不等、看得见、
说得准。仍是次版本：工具行为扩展，未破坏既有调用方式（除 `ask` 默认不再等待，见下）。

### 新增

**Open Design 右栏标签页**

DSH 右栏新增「Open Design」标签页，内嵌 OD 自己的 web 界面（iframe），打开即看。
地址由 daemon 的 `install-info.webBaseUrl` 给出并**双判别**（`GET /` 是 HTML **且**
`/api/health` 是 JSON）；被 `X-Frame-Options` / CSP `frame-ancestors` 拒绝时如实报原因
并提供「新标签打开」，不留白框。后台监视到 OD 有动作时，面板自动刷新（Host 维护
revision 计数，客户端每 2s 读一次）。

**`expect_files` —— 「它到底动手了没有」变成可读事实**

`opendesign_ask` 新增参数。设为 `true` 表示这次是**要它干活**而不是讨论，则
`actions.summary` 会明说这一轮的实际情况：

```
"this turn called NO tools — it only replied, so nothing was created or changed"
"this turn called 3 tool(s) but changed NO files (Read×2, Bash) — it inspected, it did not build"
"this turn called 2 tool(s) and CHANGED files (Write×2)"
```

日志读不到时**仍然沉默** ——「看不到」不等于「没做」，编一个结论比不说更坏。

**collect 也返回 `actions`**

此前只有起轮路径统计「干了什么」，而 fire-and-forget 之后调用方**只能**用 `run_id` 收结果，
于是后台轮次的 `actions` 永远不可见。实测：一轮只给了方案（0 工具）、另一轮只读了 3 次
（没写文件），在返回体里与「真的建了文件」完全一样，Lead 因此以为它已经开工。

**`opendesign_status` 报告 `web` 与 `pendingRun.collectWith`**

侧边栏复用 Lead 自己那次发现的结果，不再自己扫端口；记录在案但没人读的 `pendingRun`
现在如实回报，并附可直接照抄的 `collectWith`。

### 变更

**`opendesign_ask` 起新轮默认不再等待**（行为变化）

旧行为：起一轮等到结束（上限 600s）。新行为：OD 接受 run 就返回收据
（`runId` + `watcher`，`durationMs: 0`），Lead 继续下一件事；答案之后由监视推送告知，
再用 `opendesign_ask({ run_id })` 收（默认只等 15s）。

- 需要当场拿答案时显式传 `timeout_ms`，仍受 `turnTimeoutMs` 单次调用上限约束。
- **超时绝不取消 run**：返回 `stillRunning` + `runId` + live watcher，答案事后可收。

**状态变化改为「推」给模型，不再只写 job 输出**

job 输出只有主动 `job_output` 才看得到，而 run 在没人盯的时候继续跑，正是最需要被告知的
时刻。现在真实状态变化同时用 `Agent.followup()` 投一条 user 消息（`source.kind:
"opendesign-watch"`）。同一 transition 只推一次；日志增长（activity）不推。

### 修复

**一次 ask 不再产生三条排队消息**

现场：一个 run 连推 `appeared` → `now unknown` → `gone (was unknown)`。根因两条：

- 一次轮询失败被当成状态变化推送。`unknown` 是「没看到」，不是一种状态 ——
  现在 `diffConversation` 开头就守它，且基线只被**确定**观测覆盖，恢复后报的是
  `gone (was running)`，不会凭空「消失」一个从没被观测到的状态，也不会在没有证据时
  声称答案可取。
- fire-and-forget 的收据本身已经说明该 run 在跑，`appeared` 是回声。现在本进程起的 run
  在 working 期间不推，只推「它不 working 了」那一条（答案可取的信号）。人在 OD 窗口
  起的 run 仍推 `appeared` —— 它不是任何收据的回声。

`inject` 停掉的 run 也归入「已由本调用报告」：转弯结果里已经带了
`interrupted: { status, cancelOrigin }`，再推一条 `canceled` 是同一件事说两遍。

**监视对整个 run 期间失明（实测根因）**

`GET /api/runs?…&status=active` 对本插件创建的 folder-backed 工程**恒返回空列表** ——
在一个 run 确实 `running` 时逐秒采样 8 次全部如此，而同一时刻 `GET /api/runs/:id`
对同一个 run 返回 `running`。**空列表和「什么都没在跑」无法区分**，于是监视全程判 idle，
一条消息都不报。

观测源改为：**会话消息行**给出 run id（每条 assistant 行都带 `runId`/`runStatus`，
也覆盖人在 OD 窗口起的 run），**`GET /api/runs/:id`** 给出状态。`listRuns` 保留但不再
用作观测源（有源码级测试钉住）。

**监视曾把已结束的 run 的「消失」再报一次**

daemon 回收终态 run 的记录后，那是一次重复事实。已结束 run 的消失不再单独报。

**`discoverDaemon` 曾把 web sidecar 当成 daemon**

web sidecar 代理 `/api/health`，端口乱序时会被误认，导致面板报「找不到 web UI」。
现在发现成功后做一次 `/` 探测：HTML = web sidecar → 问它的 `install-info.daemonUrl`
并改写为真实 daemon。

### 维护

**`opendesign_status` 从 19 秒降到 46–63 ms**

`probe()` 的 `agents` 检查与 `listAgents()` 在热路径上把同一份数据拉了两遍。现在
`status` 默认 `skip: ['agents']`，且 `include_models: true` 时仍只拉一次 ——
`probe` 的 `agents` 检查与任何目录刷新**永远互斥**。

**`GET /api/agents` 是 9–11 秒的调用**，任何显示字段都不许为它去拉全量目录。

**测试从 91 增至 193**（9 个文件增至 17 个）。新增守护：`await-run`（等待上限不得取消
run）、`od-events`（SSE 帧解析）、`ask-order`（**组合处**的顺序）、`authoritative-watch`
（run 列表不得作观测源）、`read-inbound`（三层归属判据）、`watch-push`（推送去重与
`startedHere`）、`od-webui`（内部 Next 后端必须被拒）、`client-panel`（面板只读）、
`imports`（调用了却没 import 的本地函数）、`dead-code`。

**`DSH_TEST_TMP` 支持**：在拒绝 Node 写 `os.tmpdir()` 的宿主上把测试临时目录导到别处，
否则 17 个测试会以 `mkdtemp` 的 `EPERM` 假失败（已在 `.gitignore` 排除）。

---

## 0.3.0

一次以**实测推翻推断**为核心的版本。多条此前写在文档里的结论是错的，这一版改的是行为，
不是措辞。

### 新增

**`actions` —— 这一轮到底做了什么**

`opendesign_ask` 的返回值新增 `actions: { toolCalls, tools, wrote, read, summary }`，
从该 run 自己的 events 日志统计，而不是从答复措辞猜测。

- `wrote: true` 表示这一轮**改了文件**
- `toolCalls: 0` 且 `summary: ""` 是纯讨论
- `read: false`（字段缺失）表示日志读不到 —— **这是「未知」，不是「没动手」**

起因是一次真实误读：一轮答复读起来像「方案」，实际上已经调了 Read / Bash / TodoWrite，
下一轮直接开始 `Write`。

**`opendesign_watch` —— 常驻后台监视**

用 `ctx.jobs` 起长期任务，比发起它的调用活得更久：

```
opendesign_watch                      → { jobId, intervalMs }
job_output <jobId>                    → 读状态变化
job_kill   <jobId>                    → 停掉
```

只报**状态变化**（`appeared` / `status` / `gone`），journal 增长不算变化 —— 否则每轮
轮询都像有新闻。每条变化附带 `→ check the output: opendesign_ask({ run_id: ... })`。

**`opendesign_ask` 自动挂载监视器**

返回值带 `watcher: { jobId, reused }`。幂等：同一会话只有一个 job；记忆中的 job 若已死，
**重启而不是返回失效 id**。

**`status.watch` —— 现在到底在不在跑**

`opendesign_status` 顶层新增 `watch: { state, busy, runId?, collectWith?, source? }`，
核对三个独立来源：桥接自己记的 run、会话里活跃的 run、项目级 `status.runId`。
第三条能在会话里还没有 assistant 行时就看到正在跑的 run。

**`inject` 改为取消并重启**

对齐 OD 界面「引导对话」的真实行为（实测：不写用户消息、起新 run、旧 run
`cancel_origin: user_stop`）。返回值新增 `interrupted.answerSoFar`，如实回报被停掉那一轮
已产出的内容。

### 修复

**表单答复被吞掉**

上一版加的一道「有 run 在跑就拦住」的守卫**无条件生效**，把 `form_answers` 也拦了，
于是 OD 从没收到答案、下一轮又问一遍同一个表单。现在 `planTurn` 在 plan 上标记
`answersReply`，答复永远不会被这道守卫拦下；若确实有陈旧 run，先停掉它再送答案，
事实写进 `answeredOverRun`。

**`pendingRun` 记录被误清**

旧代码把「查询 run 状态失败」当成「run 已结束」，于是清掉记录。OD daemon 单线程，
长 turn 流式输出时 `GET /runs/:id` 很容易超时，一超时就丢记录、下一轮起第二个 run。
现在只有**确凿的终态**才清。

**监视器和 `status` 在 daemon 重启后失明**

daemon 每次启动换端口（实测 3228 → 14197 → 10115 → 11944）。旧监视器每轮重新发现端口，
一遇到端口切换就阻塞整轮；失败后还会丢掉带 `rediscover` 钩子的 client，把唯一自愈机制
扔掉。现在复用共享连接，失败时保留它。

监视器也不再调用 `ensureProject` —— 它**只读**。daemon 换数据目录后项目列表为空，
provisioning 会让监视器卡在导入文件夹里好几分钟，看起来就像「没起来」。

### 变更

**`inject` 的语义变了**（不兼容）

旧行为：往会话里写一条用户消息，**下一轮**才执行，不打断当前 run。
新行为：**取消当前 run**，用这句话作新 prompt 起一轮。
要保住旧那一轮的产出，先用 `run_id` 收完再发新 prompt。

**`opendesign_status` 不再有 `pendingInject` 字段**

`inject` 不再写消息行，这个字段随之消失。`bindingStore` 的 `setPendingInject` /
`pendingInject` / `clearPendingInject` 一并删除。

### 维护

**护栏改成自我发现**

`npm run check` 原来把文件名硬编码在 `package.json` 里，新增模块没人登记就漏检。
实测：往 `lib/watch.js` 注入语法错误，`npm run check` 仍报成功。**一个会假通过的护栏
比没有更糟，因为它会被信任。** 现在两个脚本都从目录扫文件（8 个变 23 个）。

`npm test` 改为逐文件起子进程，同时绕开沙箱里 `node --test` 的 `spawn EPERM` ——
那条路在此前是不可运行的，文档里写的补救办法是「逐个手动跑」，而没人会可靠地那么做。

**新增 `lib/` 三个纯函数模块**

`turn-plan.js`（一次 `ask` 是 collect / inject / run / error）、`watch.js`（忙闲核对）、
`conversation-watch.js`（什么算状态变化）、`turn-actions.js`（这一轮做了什么）。
各有独立测试。

**测试数从 35 增至 91**（4 个文件增至 9 个）。

**实测事实进仓库**

`docs/opendesign-runtime-facts.md`（354 行）。此前在仓库外，没有任何指针指向它。

---

## 0.2.0

初始发布。`opendesign_open` / `ask` / `inbox` / `status` 四个工具，成员与会话绑定，
`<question-form>` 解析，入站消息三分类，模型设置面板。

