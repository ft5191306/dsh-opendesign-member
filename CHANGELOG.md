# 变更记录

本文件记录每个**发布版本**的可用性变化。只写使用方能观察到的东西：工具行为、字段、
修复掉的错误结论。内部重构若不影响外部行为，归入「维护」。

版本遵循语义化版本：破坏性行为变化升主版本，新能力升次版本，修复升补丁版本。
本插件以 symlink 方式装载，`private: true` 不入 npm，版本号用于 DSH profile 的
装载记录与这份记录本身。

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

