# @local/dsh-opendesign-member

把本机 **Open Design** 接入 DSH 团队模式，作为前端/UI 第一优先成员。

每个 DSH 团队成员绑定一个**真实**的 Open Design 会话窗口：消息双向流通，窗口粒度是
成员级（新成员即新窗口），工作区与模型自动对齐。

## 四个工具

| 工具 | 作用 |
|---|---|
| `opendesign_open` | 打开/复用**该成员自己的** OD 会话窗口，并与团队工作区、模型对齐 |
| `opendesign_ask` | 跑一轮真实 OD 对话，**只返回该轮最终答复**；中间流式输出一律不返回。也可以用 `inject` 在任务进行中改口、用 `run_id` 事后收答案 |
| `opendesign_inbox` | 取回**人在 OD 窗口里打的字**，以及 **OD 自己回的话**（桥接没发起的那轮）|
| `opendesign_status` | 廉价地报告 daemon 状态、能力缺口、正在跑的 run、**该成员尚未取回的 run**、绑定与对齐 |
| `opendesign_watch` | 起一个**常驻后台任务**盯住该成员会话的 run 状态；每次状态**变化**就追加一行到 job 输出，用 `job_output` 读、`job_kill` 停 |

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

`opendesign_status` **默认不列模型表**：读一次 OD 的模型目录要 9–11 秒（OD 无服务端
缓存），而模型目录已经按 CLI 缓存在磁盘上、设置面板也在用。要看模型就传
`include_models: true`，或直接看插件详情页。

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

三个刻意的取舍：

- **journal 增长不算「变化」**。thinking 阶段事件流一直在涨，若把它当成变化报出来，
  每一轮轮询都像有新闻，人就会开始忽略这个信号。状态变了才是新闻。
- **它不引用答复正文**。答案由 `opendesign_ask({ run_id })` 收，监视器只负责说
  「有情况，去看」。第二个真相来源只会制造不一致。
- **`gone` 本身是事件**。run 消失正是答案变得可取的那一刻，值得单独报一行。

`stop_when_idle=true` 让它在连续两个周期没活 run 后自己收工；默认不收工，因为
**后面才起的 run 同样需要被看见**。

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
`BindingStore` / `planTurn` / `OdClient.probe`），不需要 Cordis、浏览器或 daemon。
`index.js` 的工具注册与 `client.js` 的 React 渲染**不在自动化覆盖内**，改动这些需手工验证。
详见 [`AGENTS.md`](./AGENTS.md)。

> `npm test` 用的是 `node --test "test/*.test.js"`。在部分沙箱里 `node --test` 起子进程会
> 报 `spawn EPERM`；此时逐个跑 `node test/<file>.test.js` 等价，同样不需要 OD 在运行。

## 延伸阅读

- `~/.dsh/opendesign-team-bridge.md` —— 完整契约、实测证据、升级维护手册、
  环境注意事项。**本机部署文档，不在本仓库内**；它记录的是那一台机器的实测
  数据（端口、版本、profile 布局），换机器需重新探测。
- [`AGENTS.md`](./AGENTS.md) —— 修改本插件的代码约定与踩坑记录

## 许可证

[MIT](./LICENSE)。本插件零外部依赖，只使用 Node 内置模块，因此没有第三方许可义务。
