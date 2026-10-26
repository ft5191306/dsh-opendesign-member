# @local/dsh-opendesign-member

把本机 **Open Design** 接入 DSH 团队模式，作为前端/UI 第一优先成员。

每个 DSH 团队成员绑定一个**真实**的 Open Design 会话窗口：消息双向流通，窗口粒度是
成员级（新成员即新窗口），工作区与模型自动对齐。

当前版本 **0.3.0**。可见行为的变化记在 [CHANGELOG.md](CHANGELOG.md)；OD 的实测行为
（端口、重启、表单协议、崩了去哪看日志）在
[docs/opendesign-runtime-facts.md](docs/opendesign-runtime-facts.md)。

## 五个工具

| 工具 | 作用 |
|---|---|
| `opendesign_open` | 打开/复用**该成员自己的** OD 会话窗口，并与团队工作区、模型对齐 |
| `opendesign_ask` | **起一轮真实 OD 对话，默认 fire-and-forget**：OD 接受 run 就立刻返回收据（`runId` + `watcher`），不阻塞 Lead；答案之后由 watcher 推消息，再用 `run_id` 收（近乎瞬时）。也可以用 `inject` 在任务进行中改口。只有显式传 `timeout_ms` 才会在本次调用里等答案 |
| `opendesign_inbox` | 取回**人在 OD 窗口里打的字**，以及 **OD 自己回的话**（桥接没发起的那轮）|
| `opendesign_status` | 廉价地报告 daemon 状态、能力缺口、正在跑的 run、**该成员尚未取回的 run**、绑定与对齐；若已知，还报告右栏复用的 web UI 地址（`web`）|
| `opendesign_watch` | 起一个**常驻后台任务**盯住该成员会话的 run 状态；每次状态**变化**就追加一行到 job 输出**并直接推一条模型可见的消息**（不用轮询），同时让右栏自动刷新；`job_kill` 停 |

**谁写文件：OD，不是你。** 这条值得单列，因为把它读错会让一次设计白做。OD 是这个团队的
前端实现者——文件由它写，你负责给 brief、答它的表单、验它交付的东西。`opendesign_ask`
返回的 `answer` 如果是一份方案、且 `questionForm` 为空，**那它是在等你说「开始」**，
不是「已确认、我来做」。紧接着该发的是又一轮 `opendesign_ask`（"Go ahead and build it
as described"），不是自己去写 SVG 或页面。

判断「它只是说了」还是「它动手了」，看 `actions`：

```json
"actions": { "toolCalls": 3, "tools": { "Read": 1, "Bash": 1, "TodoWrite": 1 },
             "wrote": false, "read": true, "summary": "this turn called 3 tool(s) (Read, Bash, TodoWrite)" }
```

- `wrote: true` 表示这一轮**改了文件**，summary 里会出现 `CHANGED files`
- `toolCalls: 0` 且 `summary: ""` 是纯讨论，这一轮没碰任何东西
- 字段缺失表示 run 的 events 日志读不到——**这是「未知」，不是「没动手」**

**关键：你是要它干活的时候，传 `expect_files: true`。** 否则「只念了一遍方案」
和「已经开始建文件」在返回体里长得一样——实测过：一轮 0 工具、一轮只读了 3 次，
答复都像方案，Lead 因此以为已经开工。带上这个标志后，summary 会把话说死：

```
"this turn called NO tools — it only replied, so nothing was created or changed"
"this turn called 3 tool(s) but changed NO files (Read×2, Bash) — it inspected, it did not build"
"this turn called 2 tool(s) and CHANGED files (Write×2)"
```

日志读不到时仍然沉默——「看不到」不等于「没做」。

`actions` 在**两步**里都有：起轮返回时（`timeout_ms` 等到结束），以及用 `run_id`
收答案时。fire-and-forget 之后你只会走后者，所以这一步尤其重要。

`opendesign_status` **默认不列模型表**：读一次 OD 的模型目录要 9–11 秒（OD 无服务端
缓存），而模型目录已经按 CLI 缓存在磁盘上、设置面板也在用。要看模型就传
`include_models: true`，或直接看插件详情页。

## 默认不等：`opendesign_ask` 是 fire-and-forget

**Lead 调完 `opendesign_ask` 就能继续下一件事。** 默认（不传 `timeout_ms`）下，
OD 一接受 run 就返回收据：

```json
{"status":"queued","answer":"","runId":"…","stillRunning":true,
 "durationMs":0,"watcher":{"jobId":"bash-…"}}
```

答案不会随这次调用返回；watcher 在 run 结束时会**推**一条消息（带 `run_id`），
然后用 `opendesign_ask({ run_id })` 收，run 已结束的情况下是近乎瞬时的读。
两者分工明确：

- **默认**：起跑即返回 → Lead 继续干活 → 收到推送再收答案；
- **`timeout_ms`**：显式要求「这次就等到答案」，仍受单次调用上限约束
  （`turnTimeoutMs`，默认 600000ms）。
- **收 `run_id`**：默认只等 15s（读一个已经在跑的东西），超时返回 `stillRunning`
  并带上 live watcher 的 jobId。

## 安装

```powershell
# 用插件的官方安装流程，不要手写 profile 的 package.json
# plugin_manager install_bundle target=<本仓库的绝对路径>
```

安装后 `desktop` profile 的 bundle 列表会出现 `@local/dsh-opendesign-member`，
以 **link** 方式指向本目录，因此改源码后只需重启插件行：

```
plugin_manager set_plugin target=include:opendesign-member enabled=false
plugin_manager set_plugin target=include:opendesign-member enabled=true
```

## 前置条件

- **Open Design 桌面端在运行**（daemon 端口每次启动都变，插件自动发现）
- **DSH 的 `open-design` profile 已配置可用的模型路由** —— OD 通过
  `dsh --profile open-design --stdio` 驱动 DSH，那个 profile 决定 OD 会话里
  能选哪些模型
- 插件配置默认 `agentId` **留空**，即跟随 Open Design 当前选中的 CLI（从
  `app-config` 的 `config.agentId` 每次现读）。`model` 也留空，走 profile 默认。

## 设置：模型与推理强度

插件详情页有「运行模型」区块，三行：提供商 / 模型 / 推理强度。

- **只对 DSH 侧发起的 OD 会话生效**，不写 Open Design 自己的配置。
- 首次读取时从 Open Design 当前值**播种一次**，之后以本侧存的为准。
- 「重新读取」按钮才会重新探测模型表。探测一次要 9–11 秒（OD 无服务端缓存），
  所以模型表按 CLI 缓存 7 天，**切换 CLI 会立即失效重探**。
- 推理强度不是处处可用：`amr` 这类 CLI 的模型没有 `reasoningOptions`，
  传档位会被静默丢弃。当前 CLI 不支持时该行显示 `default` 并禁用，而不是装作可选。

## 典型用法

```
# 1. 团队 Lead 先开自己的窗口并确认对齐
opendesign_open

# 1.5 办事之前先起监视：它会活得比这次工具调用更久
opendesign_watch                        # → 返回 jobId
#    之后任何时候：job_output 读变化、job_kill 停掉

# 2. 第一轮永远先对齐：说清这是干什么用的，让 OD 回话
opendesign_ask  prompt="<主观需求 + 客观事实>"

# 3. 看人有没有在 OD 窗口里留话，以及 OD 有没有自己回话
opendesign_inbox  peek=true   # 只看不消费

# 4. OD 出表单时，它返回 questionForm 而不是失败；用答案回应
opendesign_ask  form_answers=[{id:"color", label:"Which color?", value:"red"}]

# 5. OD 迟迟不收敛时，别把等待上限当停手键：它仍在工作
opendesign_ask  run_id="<上一轮返回的 runId>"   # 反复收集是安全的
#    丢了 runId 也不要重发一遍：status 会告诉你那个成员还没取回的 run
opendesign_status

# 6. 任务进行中要改口：取消并重启（和 OD 的「引导对话」一致）
opendesign_ask  inject="改深色，配色别用奶油色了"
#    → 停掉在跑的那一轮，用这句话作为新 prompt 起一轮
#    → 返回 interrupted.answerSoFar：被停掉那一轮已经产出的内容
```

## 常驻监视（`opendesign_watch`）

**它是后台任务，不是一次调用。** 这是它和「等的时候顺手看一眼」的根本区别：
工具调用一返回就瞎了，而 job 活得比调用久——包括比发起它的那一轮 agent 更久。

```
opendesign_watch                       # 默认 5 秒一轮
opendesign_watch interval_ms=2000      # 更勤
job_output bash-xxxx                   # 读变化
job_kill   bash-xxxx                   # 停掉
```

它**只报状态变化**，并且每条变化都直接告诉你下一步：

```
appeared: run cad6f421 is queued
  → check the output: opendesign_ask({ run_id: "cad6f421-…" })
status:   run cad6f421 now running
  → check the output: opendesign_ask({ run_id: "cad6f421-…" })
gone:     run cad6f421 is no longer live (was running) — its answer can be collected
```

**状态变化会直接「推」给模型。** 除了写进 job 输出，每次真实状态变化还会通过
`Agent.followup(...)` 投一条**模型可见的 user 消息**（`source.kind: "opendesign-watch"`），
所以模型不需要自己想起来去 `job_output`——run 在没人盯的时候继续跑，正是它最需要被
提醒的时刻。规则：

- **只在 `report.changed` 时推**：`appeared` / `status` / `gone` 推；journal 增长的
  `activity` 不推（理由同上一条，否则每 5 秒一条推送）。
- **一批变化只推一条**。去重键是 `kind|runId|status`，同一个 transition 不会推第二次；
  `gone` 用消失前那次的 runId，所以消息里仍带着收集答案的那次调用。
- **`opendesign_ask` 自己等待的那一轮不会再被推一遍**：答案已经随这次工具调用返回，
  同一次完成报两遍只会制造噪音（与 host 对 `settled.awaited` 的处理同一条道理）。
  只有等待提前结束（`stillRunning`，答案还没交回）时，这一轮才交回给 watcher，
  之后的 `gone` 会正常推送。job 输出里对应一行 `push skipped: this call already
  carries that run's result`。
- **文案是固定形状的短英文**：成员名 + 变化 + `opendesign_ask({ run_id: "<id>" })`，
  不是 job 行原文；没有 runId 时不编造 id，也不带收集调用。
- **拿不到推送通道时降级而不报错**：该 owner 没有 live agent（例如会话已结束）时，
  watcher 照常轮询、照常写 job 输出，只追加一行 `model push unavailable: …` 说明原因。

三个刻意的取舍：

- **journal 增长不算「变化」**。thinking 阶段事件流一直在涨，若把它当成变化报出来，
  每一轮轮询都像有新闻，人就会开始忽略这个信号。状态变了才是新闻。
- **它不引用答复正文**。答案由 `opendesign_ask({ run_id })` 收，监视器只负责说
  「有情况，去看」。第二个真相来源只会制造不一致。
- **`gone` 本身是事件**。run 消失正是答案变得可取的那一刻，值得单独报一行。

`opendesign_watch` 起的监视器**不会自己收工**：后面才起的 run 同样需要被看见，
而「已经空闲」不足以判断「不会再有下一轮」。要停就 `job_kill`。

它和 `opendesign_ask` 的守卫共用同一条权威判据
（`GET /api/runs?conversationId=X&status=active`）：**一次查询**回答「这个会话在不在跑」。
查询不到时它报 `unknown` 而不是猜测——判闲会重复起 turn，判忙会让成员永久卡住，
两种猜测都有实际事故记录，所以这里只报第三种状态。

## 右栏窗口：把 OD 嵌进 DSH（方案 F）

DSH 的右栏可以开一个 **Open Design 窗口** 标签页，里面就是 OD 的**网页版**窗口，不用在
两个应用之间来回切。它用的是 OD 0.26.1 自带的 web sidecar（同一份产品 UI、走 HTTP），
不是 Electron 的 `od://` 原生窗口——后者浏览器打不开。

怎么开：

1. 会话里点右上角「打开右侧边栏」；
2. 在 guide 页点「Open Design 窗口」；
3. 标签页里是 `http://127.0.0.1:<webPort>/projects/<projectId>/conversations/<conversationId>`，
   直接落在**该成员自己的会话**上（坐标来自桥接绑定）。

实现与边界（都实测过）：

- **端口是发现来的，不是写死的。** 先问 daemon 的 `GET /api/mcp/install-info` 的
  `webBaseUrl`，再要求该地址 `GET /` 是 HTML **且** `GET /api/health` 是 JSON。
  后半条是必须的：OD 同时开的内部 Next 后端也把 `/` 回成 HTML，但 `/api/*` 回 HTML、
  不代理 daemon——嵌它等于嵌一个所有请求都失败的空壳。实测这台机器内部端口 64118、
  web UI 64120，按端口升序扫描会正好选错。
- **侧边栏复用 `opendesign_status` 的发现结果，不自己找端口。** 一次成功的发现
  （daemon 地址 + web 地址）由插件共享：`opendesign_status` 在结果里直接报 `web`，
  面板路由用同一份 `lastKnown`。即使 discovery 暂时失败（OD 重启中、进程表读不到），
  面板会**回退到上一次确认过的地址**并标注「地址可能已过期」，而不是挂成找不到端口。
- **后台监视有动作 → 侧边栏自动刷新。** watcher 观察到真实状态变化、以及新的 run 被
  接受 / 答案被收时，Host 的 revision 计数器 +1；右栏每 2 秒读一次面板路由（一次
  本地缓存读，十几毫秒），revision 变了就重载 iframe 并更新面板。人不用点任何按钮。
  读取失败也会 2 秒后自动重试，不会一直停在错误页。
- **降级要响。** 找不到 web UI、被 `X-Frame-Options` / `frame-ancestors` 拒绝、
  或 daemon 不可达时，标签页显示原因并提供「在浏览器新标签打开」，**不会**留一个
  空白 iframe。
- **面板只读。** `/api/opendesign-member/panel` 只接受 GET，读坐标用 `peekTeam`：
  打开面板不会顺带建项目 / 会话 / run。
- **它和桥接是同一份数据。** 桥接起的 run（`clientType: desktop`）与网页版自己起的
  run（iframe 里 `clientType: web`）在同一会话互相可见；实测消息逐字节一致。
- **不会自动弹出来**：由人从右栏 guide 打开。OD 重启换了端口会自己换源。
- **已知环境坑**：如果 Team 项目根目录是**巨大且活着的目录**（例如直接绑 `~/.dsh`），
  OD 在 run 期间会长时间占满单线程 daemon，右栏里的会话区会一直转圈、`/api/runs`
  也会超时。给 OD 一个真正的项目目录就正常（实测小项目里 run 状态在 5 秒内可见）。

## 任务进行中改口（`inject`）

**它的语义是「取消并重启」，不是中途 steer。** 这两件事在本机 CLI `amr` 上必须分清：

- `POST /runs/:id/steer`（OD 源码里标注为「引导对话」的那条路由）在 `amr` 上返回
  **409 `RUN_STEERING_UNSUPPORTED`**，原文：“its stdin is closed together with the
  opening prompt”。实测确实如此。
- 但 OD 界面上的「引导对话」按钮**不走那条路由**。实测（2026-10-25，真点真数据）：
  在 run `56f9c028` 还在跑时点它，**没有新建任何用户消息行**，却起了新 run
  `8473cde6`，旧 run 以 `cancel_origin: user_stop` 结束；新 run 靠 `prior_transcript`
  拿到前文。

所以本插件的 `inject` 照做同一件事：

| 行为 | 是否一致 |
|---|---|
| 停掉在跑的 run | ✅ `cancel_origin: user_stop`（daemon 自己写的） |
| 起一个新 run | ✅ 新 run 用这句话作 prompt |
| 为这句话另写一条用户消息 | ✅ **不写**，它成为新 run 自己的 user turn |
| 旧 run 的产出 | ⚠️ 丢失，但 `interrupted.answerSoFar` 如实回报它产出了什么 |

要**保住**旧那一轮的产出就别用 `inject`：先用 `run_id` 收完，再正常发新 prompt。

`opendesign_status` 的 `steering.supported` 只说明「当前 CLI 能不能中途收话」
（`null` = 还没探测过）。**它不影响 `inject`**：改口靠的是取消并重启，不依赖中途输入。

## 跟 OD 说话的原则

**主观描述需求，客观事实约束。** 说意图、受众、感受、语气、希望留下的印象；
用确切的框架、文件布局、接口形状、字段名、格式尺寸做硬约束。两者放同一条
消息里，别把硬约束稀释成形容词，也别替它决定视觉判断。

**不要把视觉与验收的判断塞回给 OD。** 响应式断点、动效与 `prefers-reduced-motion`、
键盘可达、焦点可见、`aria-live` 播报、色弱形状编码、以及一份 UI 验收清单——这些是它
本来就会做好的专业判断，写进 brief 只会让这一轮变成打勾而不是设计。同理，**别把验收
测试的活儿派给它**：起服务、等健康检查、开浏览器、复现你的验收用例，是你自己的事。
实测代价：一条要求 OD"自己端到端验收"的 brief 跑了 36 分钟、64 次 shell 调用，最后
一个字都没回。

"验收标准"不属于客观约束。客观约束只写**必须与既有系统一致的事实**；能不能用、好不好看，
由你在它交付之后自己验。

## 重要行为

- **`<question-form>` 不是故障。** OD 需要用户决定时会输出表单块并结束本轮，
  该轮 run 是 `succeeded`。`opendesign_ask` 会把它渲染成带 `[value: ...]` 的
  可选清单放进 `questionForm`，正文里不留标签。
- **等待上限不是停手键。** `timeout_ms` 或配置的上限到点，返回 `stillRunning: true`
  与 `runId`，**OD 那一轮仍在跑**。用 `opendesign_ask({ run_id })` 收集即可，
  反复收集是安全的。只有你显式取消（或人在 OD 窗口按停止）才真正终止。
  **`runId` 丢了也不会丢答案**：那一轮会被记进 `bindings.json` 的 `pendingRun`，
  `opendesign_status` 在返回体顶层的 `pendingRun.collectWith` 里给出取回它需要的那一次调用。
- **收答案不要用长等待。** `opendesign_ask({ run_id })` 的默认等待只有 **15 秒**
  （只有「起新的一轮」才是 600 秒上限）：收集是读一个已经在跑的东西，而一旦有 watcher，
  run 结束时会**推**一条消息把你叫醒，再收就是近乎瞬时的一次读。把 `timeout_ms`
  设成几分钟去「等 OD 做完」，只会白白占住 Lead 的回合（实测一次 900000ms 的 collect
  让调用方原地等了 6 分钟以上）。
- **入站分两种。** `messages` 是人在窗口里打的字；`odReplies` 是 OD 自己的回答，
  且只报桥接没发起过的那些（人在窗口里暂停/纠偏时 OD 的回话）。只收人类消息时，
  人会看到「暂停」而看不到 OD 随后那一整段总结。
- **入站恰好一次。** 每个成员有游标，消费后前移；光标失效时按时间戳兜底，
  绝不整段回放历史。`messages` 与 `odReplies` 共用同一个光标。
- **只取最终输出。** 不采集任何流式帧，只按 `assistantMessageId` 读那一条。
- **改口不重复。** `inject` 的那句话**不另写用户消息**，它成为新 run 自己的 user turn。
  实测：改口后会话里这一句只有 **1 条**，旧 run 以 `cancel_origin: user_stop` 结束。

## 开发

```powershell
npm run check   # node --check 每个源文件
npm test        # 逐文件跑；不需要 Open Design 在运行
```

测试只覆盖纯函数与单方法的可测导出（`awaitRun` / `readInbound` / `resolveSelection` /
`BindingStore` / `planTurn` / `OdClient.probe` / `createWatchNotifier`），不需要 Cordis、
浏览器或 daemon；`watch-push.test.js` 另有源码级测试钉住推送在 watcher 的
`report.changed` 分支内。`index.js` 的工具注册与 `client.js` 的 React 渲染**不在自动化
覆盖内**，改动这些需手工验证。详见 [`AGENTS.md`](./AGENTS.md)。

> `npm test` 用的是 `node --test "test/*.test.js"`。在部分沙箱里 `node --test` 起子进程会
> 报 `spawn EPERM`；此时逐个跑 `node test/<file>.test.js` 等价，同样不需要 OD 在运行。

## 延伸阅读

- `~/.dsh/opendesign-team-bridge.md` —— 完整契约、实测证据、升级维护手册、
  环境注意事项。**本机部署文档，不在本仓库内**；它记录的是那一台机器的实测
  数据（端口、版本、profile 布局），换机器需重新探测。
- [`AGENTS.md`](./AGENTS.md) —— 修改本插件的代码约定与踩坑记录

## 许可证

[MIT](./LICENSE)。本插件零外部依赖，只使用 Node 内置模块，因此没有第三方许可义务。
