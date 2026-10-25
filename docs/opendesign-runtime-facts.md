# Open Design 作为团队前端/UI 成员：接入说明与升级维护

本文档记录本机 Open Design（以下简称 OD）接入 DSH 团队模式的实现契约、验收证据，以及**两侧客户端升级后如何维护**。改动只涉及一个自包含插件和一个 DSH profile，不改 OD 安装目录、不改 OD 数据库。

> **什么时候读这份文档**：要查 OD 的**实测行为**而不是代码意图时。这里的每一条都带测量记录——
> daemon 端口每次启动都变、`/api/health` 超时≠不在、`inject` 为什么是取消并重启、
> 表单协议的 `[form answers — …]` 到底是什么、策略任务为什么会以 `no_artifact` 拒绝自己的产物、
> 以及 crash 日志在哪里。代码注释解释**当前写法**，这份文档记录**为什么必须这样写**。
> 改任何涉及 OD 行为的模块（`od-client.js`、`turn-plan.js`、`watch.js`）之前先查这里。

---

## 1. 它是什么

| 层 | 位置 | 作用 |
|---|---|---|
| 桥接插件 | `C:\Users\Libra\dsh-plugins\dsh-opendesign-member` | 把 DSH 团队成员绑定到 OD 的**真实会话窗口**，提供 `opendesign_open` / `opendesign_ask` / `opendesign_status` / `opendesign_inbox` 四个工具（`ask` 兼有 `inject` / `run_id` 两种工作方式，见 §12），并注入团队级对齐规则 |
| OD 侧运行时 profile | `C:\Users\Libra\.dsh\profiles\open-design` | OD 通过 `dsh --profile open-design --stdio` 驱动 DSH；该 profile 决定 OD 会话里**能用哪些模型** |
| 绑定存储 | `C:\Users\Libra\.dsh\opendesign-member\bindings.json` | 每个团队一个 OD project，每个成员一个 OD conversation，每次写入前先合并磁盘现状 |

### 四条已落实的产品约束

1. **窗口粒度 = 团队成员级。** 同一团队共享一个 OD project（`folder-backed`，cwd 等于团队工作区），但**每个成员各自一个 conversation**，且新建成员必然拿到新会话，绝不跨成员或跨团队复用。
2. **双向消息（闭环）。** 出站用 `opendesign_ask`；入站用 `opendesign_inbox` 取回**人在 OD 窗口亲手输入**的消息。桥接自己提交的 prompt 带 `[成员 (DSH role)]` 前缀，入站时被过滤，成员不会把自己的请求读成人话。
3. **只接收单轮最终输出。** 桥接从不读取流式中间帧（`thinking_delta` / `text_delta` / `tool` 一律不采集），只在该 run 进入终态后，按 `assistantMessageId` 读取那一条最终 assistant 消息。
4. **入站恰好一次。** 每个成员持有一个光标（最后一条已投递消息的 id + 时间戳）。光标失效时用时间戳兜底，**绝不把整段历史当成人刚说的话重新投递**。

---

## 2. 已验证的事实（实测，非推断）

| 验证项 | 结果 |
|---|---|
| 工作区一致 | `strategy: folder-backed`，`resolvedDir` = `C:\Users\Libra\.dsh` = `workspace`，`workspaceMatchesProject: true` |
| 模型一致 | open-design profile 暴露 5 个 `open-design/*` 模型，默认 `deepseek-v4.1-flash`（reasoning `max`），与 Lead 同源网关 `https://amr-link.open-design.ai/v1` |
| 成员级会话 | Lead `8b6da38a…`、ui-reviewer `a082345f…`，同 project 不同 conversation |
| 多轮连续 | ui-reviewer 第二轮正确复述第一轮 token（`ALIGN_A`），单成员两轮落在同一 conversationId |
| 重启存活 | OD 重启后 daemon 换端口，桥接自动重连（10191），绑定与多轮历史保留 |
| 只取最终输出 | `opendesign_ask` 返回结构仅 `answer` / `runId` / `status` / `durationMs` / `stillRunning` |
| **客户端类型** | 声明 `x-od-client: desktop` 后 run 的 `clientType` 由 `web` 变 `desktop`，才会出现在 OD 窗口（见 §4.6） |
| **入站真实闭环** | 人在 OD 窗口手打的「啊？」与「我作为用户随便输入点什么」，被 `opendesign_inbox` 原样读回（`delivered: 2`） |
| **入站不重复** | 同一光标下第二次调用返回空；出站的 `[lead (DSH lead)]` prompt 全部被过滤 |
| **入站含 OD 自答** | 人在窗口输入「暂停」→ OD 自跑一轮写下 459 字总结；`odReplies` 恰好返回该条，桥接自己那 2 轮被排除 |
| **超时不杀 run** | 上限 120ms 到点时 `cancelRun` 调用 0 次、返回 `stillRunning: true`；显式取消时调用 1 次 |
| **run_id 收复** | 对已跑 36 分钟的 run 用 `run_id` 收集，4.1s 返回 `stillRunning`，事后复查 OD 仍 `running`、`cancelRequested: false` |
| **光标失效兜底** | 伪造失效光标 + 时间戳时只返回其后的消息，不回放全部历史 |
| **并发写入不互相覆盖** | `flush()` 改为合并磁盘现状；两个 store 实例分别写 project 与 member，两者都保留 |
| **`status` 变便宜** | 一次 `status` 的等价调用序列从 **19,159 ms → 46–63 ms**；`include_models: true` 时约 9 s 且只枚举一次（曾因 probe 与 catalogue 各拉一遍而 18.1 s） |
| **`pendingRun` 有人读** | `stillRunning` 写进 `bindings.json` 的 run，`opendesign_status` 顶层回报 runId 与 `collectWith` |
| **`status` 仍不写盘** | 改动前后 `bindings.json` mtime 不变 |
| **中途改口 = 取消并重启** | 界面「引导对话」实测：不写用户消息，起新 run（旧 run `cancel_origin: user_stop`，新 run 靠 `prior_transcript` 续上下文）。桥接 `inject` 照做（见 §12） |
| **`amr` 不吃 steer** | `promptInputFormat` 空串，`POST /runs/:id/steer` → 409 `RUN_STEERING_UNSUPPORTED`；但界面的「引导对话」不走那条路由，详见 §12 |
| **监视活在调用之外** | `opendesign_watch` 用 `ctx.jobs` 起常驻任务，实测捕获 `appeared → running → gone` 三段（间隔 3 s），每条变化附带 `check the output` 指向（见 §12.5） |
| 降级可读 | OD 关闭时返回具名诊断 `daemon-unreachable` 并列出尝试过的端口，而非崩溃 |

---

## 3. 关键实现决策（为什么这样做）

### 3.1 为什么不做成"花名册里的假成员"

DSH 的 Team 成员必须是**进程内 continuable child**（`ctx.subagents.startActivation`）。OD 是独立 Electron 进程，无法进入该花名册。因此采用**真实成员 + 真实 OD 会话镜像**：成员是货真价实的 DSH teammate，额外拥有一个 OD 窗口。这样 `send_message` / 团队任务板 / `wait_agent` 等原生协作能力全部照常可用。

### 3.2 为什么 `opendesign_ask` 是同步返回

工具契约要求返回最终值。桥接创建 run 后轮询 `GET /api/runs/:id` 直到 `status ∈ {succeeded, failed, canceled}`，再读一次 messages。**判终态只看 `status`，绝不看 `code` / `exitCode`**——实测成功的 run 也会返回 `code: 1`。

### 3.3 为什么用 sidecar 管道铸 import token

让 OD 的 agent cwd 等于团队工作区，**唯一**受支持的入口是 `POST /api/import/folder` 或 `POST /api/projects/:id/working-dir`，两者都要求 `x-od-desktop-import-token`。该 token 由 OD daemon sidecar 通过 Windows 命名管道铸出——这正是 OD 自家 CLI 用的通道。管道名派生规则（见 `lib/sidecar-token.js`）：

```
pipe = \\.\pipe\open-design-sidecar-<sha256(username + "\n" + stamp).slice(0,32)>
stamp = "channel=stable\nnamespace=release-stable-win\nsource=packaged\nmode=runtime\napp=daemon"
```

失败时自动降级到 `linked-dirs` 策略（可读工作区，但 cwd 不是工作区），并在 `opendesign_status` 的 `strategy` 里如实标注。

### 3.4 为什么不用 `@deepseek-ai/dsh-tools` 的 `defineTool`

插件以 **link（symlink）** 方式安装，Node 从真实路径解析模块，profile 的 `node_modules` 里的 peer 包解析不到。因此 `lib/tool.js` 自建了等价的最小实现，`index.js` 也**不导出 `Config`**（否则要依赖 `@deepseek-ai/schemastery`），改为在 `resolveConfig()` 里做防御性类型收敛。这同时降低了升级耦合。

---

## 4. 升级维护策略

**核心原则：不写死任何版本号，全部特性探测 + 单点路由表。**

### 4.1 OD 升级后怎么查

所有依赖的 daemon 路由集中在 `lib/od-client.js` 的 `ROUTES` 一张表里。升级后先跑：

```
opendesign_status          # 在任一 DSH 团队会话里
```

看三处：
- `daemon.degraded` —— 为空表示探测到的路由全在；非空会**点名**缺哪个特性（`health` / `version` / `agents` / `appConfig` / `projects` / `activeRunCount`）。**被 `skip` 掉的检查不会出现在这里**——"没问"不等于"坏了"，它报 `{ ok: null, skipped: true }`。
- `daemon.version` —— OD 版本。
- `daemon.activeRunCount` —— OD 此刻真正在跑几个 run（`GET /api/runs/active-count`，2–4 ms）。**这才是判断"它还在干活吗"的字段**，比等一个 turn 返回可靠得多。

**模型表默认不在 `status` 里。** 要就给 `include_models: true`（约 9 秒，会顺带刷新 `catalogue-cache.json`），或看插件详情页——那里读的是同一份 7 天缓存，几乎免费。`daemon.catalogueAt` 告诉你缓存是何时探测的，`agentAvailable` 来自缓存，冷缓存时是 `null`（未知）而不是 `false`。

### 4.1.1 `status` 为什么必须便宜（一次真实事故）

曾实测一次 `opendesign_status` = **19 秒**。构成：`probe()` 里的 `agents` 检查耗 9.1 s，紧接着又 `listAgents()` 一遍，**同一份 60 KB 数据拉了两遍**，而它换来的只是 37 个裸 id——没有 provider 维度、没有 `reasoningOptions`，而那两样本来就按 CLI 缓存在 `catalogue-cache.json` 里。

致命之处在于 §2 那条对齐规则要求**每个成员做 UI 工作前先调 `opendesign_status`**：等于把 19 秒挂到每个任务的关键路径上。修法：`probe({ skip, capture })`，`status` 默认 `skip: ['agents']` 并用 `capture` 复用 `app-config` 的响应体。实测降到 **46–63 ms**。

> 写这一处时踩过的坑值得记住：第一版只在**打开** `include_models` 时才不 skip，结果 `probe()` 拉一遍、`catalogue(force)` 又拉一遍，实测 18.1 秒——和原来一模一样的重复，只是搬到了显式路径。`probe` 的 `agents` 检查与任何 `listAgents()` / 目录刷新**永远互斥**。`test/probe.test.js` 有一条测试专门守这个。

### 4.2 端口变了怎么办（**已实际发生过**）

OD 每次启动绑定**随机端口**（8620 只是默认值），重启后会变。桥接已改为：先用 `Get-NetTCPConnection` 找出 OD 进程实际监听的端口，逐个用 `GET /api/health` 校验（要求返回 JSON 且 `ok === true`，以此排除同进程的渲染端口）。因此无需手工配置；必要时仍可在插件 config 里写死 `baseUrl` 覆盖。

### 4.3 路由改名 / 语义变化怎么办

1. `opendesign_status` 报出 `degraded` 里的特性名。
2. 在 `ROUTES` 里改那一行路径。
3. 若请求/响应字段改名，只改对应的 `OdClient` 方法（每个路由一个方法，一处改动）。
4. 重启插件行即可生效：`plugin_manager set_plugin enabled:false` → `enabled:true`（entry id `include:opendesign-member`）。

### 4.4 换了模型怎么办

**OD 会话里能用哪些模型，完全由 `profiles/open-design/cordis.patch.yml` 决定**，不必碰 OD 任何文件。OD 每次探测 agent 时会执行 `dsh --profile open-design --models`，把输出的单行 JSON 解析成模型下拉项。

- 改默认模型：改 `agent-default-model` 的 `provider` / `model`。
- 增删可选模型：改 `llm-pi-ai.providers.open-design.models`。
- **硬约束**：该 profile 里设了 provider 级 `reasoning: max`，因为 OD 一旦带上显式 `model` 就会丢掉 `reasoningEffort`，只有选 "Default (CLI config)" 才保留。代价是——**新加进列表的 model id 必须支持 `max` 档**，否则请求会被网关 400。每个 id 的确切档位见仓库根目录 `open-design-gateway.md`。
- 改完复核：`dsh --profile open-design --probe` 与 `--models`。

### 4.5 DSH 升级后怎么办

插件只依赖公开 seam：`ctx.tools.register`、`ctx.systemPrompt.section`、`ctx.agentTeams.tryMembership`、`ctx.agents`、`ctx.workingDirectory.get`。这些都声明在 `inject` 里，缺失时 Cordis 会明确报 `cannot get property "x" without inject`，不会静默错。

若 `ToolDefinition` 形状变化，只需改 `lib/tool.js`（唯一一处构造工具定义的地方）。

### 4.6 桥接的 run 为什么必须声明 `x-od-client: desktop`

**这是"从 DSH 发起请求后，OD 窗口里看不到那个会话"的唯一根因。**

OD daemon 按请求头决定 run 的 `clientType`：

```js
const declaredClient = String(req.get("x-od-client") ?? "").toLowerCase();
if (declaredClient === "desktop" || declaredClient === "web") {
  run.clientType = declaredClient;
} else {
  const ua = String(req.get("user-agent") ?? "");
  run.clientType = ua.includes("Electron/") ? "desktop" : "web";
}
```

桥接是纯 Node 进程，UA 里没有 `Electron/`，所以每一轮都被归档成 **`web` 客户端**。web 的 run 能正常跑（事件流能证明它读了文件、跑了 Shell），但它不是 OD 桌面窗口正在展示的那个 turn，于是窗口里看不到对话。

修法就一行：`createRun` 带 `{ 'x-od-client': 'desktop' }`（见 `lib/od-client.js`）。

实测对照（同一会话、同一 agent/model）：

| | 修复前 `b86cb5e3` | 修复后 `7eab7284` |
|---|---|---|
| `clientType` | `web` | **`desktop`** |
| 状态 | canceled | succeeded |

**排查顺序**：窗口看不到会话时，先 `GET /api/runs/:id` 看 `clientType`；为 `web` 就是这里的问题，不要先去怀疑绑定或工作区。

### 4.7 插件更新流程

```powershell
# 1. 改 C:\Users\Libra\dsh-plugins\dsh-opendesign-member 下的源码
# 2. 语法自检
node --check C:\Users\Libra\dsh-plugins\dsh-opendesign-member\index.js
# 3. 重启用运行中的 profile（无需重启 DSH）
#    plugin_manager: set_plugin include:opendesign-member enabled:false
#    plugin_manager: set_plugin include:opendesign-member enabled:true
```

因为安装方式是 link，改源码后重启插件行即可，不必重装包。

---

## 5. 已知边界

1. **成员级窗口不会自动创建。** 成员首次调用 `opendesign_open`（或第一次 `opendesign_ask`）时才建会话；期望"成员一出现就有窗口"需要调用一次。
2. **对齐轮需要显式执行。** 插件把"每个任务至少一轮对齐"写进了系统提示，但这是**模型遵循的规则**，不是强制拦截。
3. **`reasoning` 只对部分 CLI 有效。** 档位来自 `/api/agents` 里每个模型的 `reasoningOptions`。实测：`amr` **37 个模型全都没有 `reasoningOptions`**，传任何档位都会被静默丢弃；`deepseek-harness` 那类带 `open-design/*`、`deepseek-official/*` 前缀的 CLI 才有档位。两者会随用户在 OD 设置页切换而互换，所以判断依据永远是**当前 `config.agentId` 及其模型表**，不是某个写死的 CLI 名。
4. **OD 的 `model` 字段不校验。** 传错 id 仍返回 202，错误延后到 runtime。桥接因此默认走 `default`（CLI 配置），避免踩坑。
5. **单进程共享工作区。** OD 与 DSH 编辑同一目录，写作用域需按人工队友同样协调。
6. **`/api/projects` 可能返回空列表。** 实测某次返回 `projects: 0`，而按 id 直接取 `GET /api/projects/:id` 仍正常。不要把它当作"项目不存在"的判据。
7. **OD 的 run 不会被超时自动终止。** 这是 OD 的既有行为，也是桥接必须自己兜住的地方：等待上限到点只意味着"我不再等了"，run 会继续消耗 daemon 和 token。见 §11 第 5 条。

---

## 6. 本次操作造成的环境变更（需知会）

| 变更 | 说明 |
|---|---|
| `profiles/open-design/cordis.patch.yml` | 由空 `[]` 改为声明 `open-design` 网关与 5 个模型，并把默认模型对齐到 Lead。**这是让 OD 会话能用同一套模型的关键改动** |
| `profiles/desktop/package.json` | 追加 bundle `@local/dsh-opendesign-member`，并登记 link 依赖 |
| `profiles/desktop/node_modules/cloudflared` | 安装过程中该目录被 pnpm 重装；期间为释放文件占用曾短暂终止 cloudflared 进程，**远程访问隧道当前未运行**，二进制需重新下载 |
| OD 内新建探针项目 | 调研阶段遗留（`dshprobe…` / `od-api-probe` / `od-scanprobe` / `odlinkprobe…`），可删除 |
| OD 内新增团队项目 | `a42ae0a8-e0b6-466f-b5d2-2e38ca9ce517`，cwd = `C:\Users\Libra\.dsh`，**保留** |

---

## 7. 新增一个团队的步骤

1. 团队 Lead 在会话里调 `opendesign_open` —— 自动建/复用本项目团队的 OD project（folder-backed 到该团队 cwd）。
2. 需要前端/UI 输入时调 `opendesign_ask`，**第一轮先对齐**：说清这是干什么用的，让它回话。不是把 spec 递过去。
3. 新成员加入后各自调一次 `opendesign_open`，即得到属于自己的新会话。
4. 任务开始时调 `opendesign_inbox`，先看人有没有在 OD 窗口里直接留话；`peek: true` 只读不消费。
5. 用 `opendesign_status` 随时确认 `workspaceMatchesProject` 与 `degraded`；它现在是几十毫秒级的廉价调用，别怕多调。丢失了 `runId` 时也靠它找回还在跑的那一轮（见 §11.5）。

---

## 8. 入站消息的语义（`opendesign_inbox`）

返回**两种不同的东西，故意分开**：

| 字段 | 是什么 |
|---|---|
| `messages` | **人在 OD 窗口里打的字**。普通团队输入。 |
| `odReplies` | **OD 自己的回答**，且是桥接没发起过的那一轮。人可以在窗口里暂停/纠偏/改方向，OD 会跑一轮并写下 assistant 消息，而这条从未被任何 `opendesign_ask` 返回过。 |

- **为什么必须分开。** 只收人类消息时，成员只看到人的两个词（例如「暂停」），完全不知道 OD 其实已经回了一整段。实测事故：人输入「暂停」，OD 回了一段 459 字的进度总结，Lead 只收到「暂停」，于是自己另写了一句"已确认停止"，对 OD 已完成的工作一无所知。
- **不会重复投递。** 桥接自己发起的 run，其回答已由 `opendesign_ask` 返回，`odReplies` 必须排除它。判据有三层，逐层兜底：
  1. 绑定里记着的 `bridgeRuns`（本轮起的 run 即刻登记，等待之前先写，避免并发 `inbox` 抢在登记前重复投递）；
  2. run 自己的 `clientRequestId` —— 桥接一律用 `dsh-…`，人在窗口发起的是 UUID。**这是可追溯的权威判据**，对"登记功能上线前"的旧 run 同样有效；
  3. 它回答的那条 user 消息是否带 `[成员名 (DSH …)]` 前缀。给最早那批 `clientRequestId` 为空的旧 run 兜底。
- **未跑完的不算回答。** `runStatus` 不是 `succeeded`/`failed` 的 assistant 消息不进 `odReplies`，半截或空文本不会被当成"OD 说过了"。
- **恰好一次。** 消费后光标前移；同一光标下再调返回空。`messages` 与 `odReplies` 共用同一个光标。
- **`peek: true` 不消费**，供"先看看有没有新话、稍后再正式消费"的场景。
- **光标失效兜底。** 会话被 fork/清空导致光标 id 找不到时，按光标时间戳只取更新的消息；绝不整段回放。
- **不入模型历史的噪音。** 入站消息只作为工具结果返回，不写入任何会话日志。

---

## 9. `<question-form>`：OD 的“提问”不是失败

这是最容易误判为“卡住”的地方，**它其实是正常协议**。

### 机制

OD 的设计师提示词要求模型在需要用户决定时，输出一个 `<question-form>` 文本块，然后**结束本轮**，等宿主渲染 Questions UI 把选择回传成 `[form answers — id]` 消息。注意两点：

1. 它是**助手文本**，不是工具调用；
2. 该轮 run 的终态是 **`succeeded`**，不是挂起。

所以从 DSH 看，这一轮“成功结束了”，但期望的回答是**下一轮**。之前的表现就是：Lead 拿到一堆标签无从应答，看起来像卡死。

### 桥接做了什么

- `opendesign_ask` 把回复拆成 `answer`（纯正文）与 `questionForm`（渲染成带 `[value: ...]` 的可选清单）。**正文里绝不留标签。**
- `questionForm` 非空时的 `answer` 会明确标注“本轮是提问而非回答”，不再像静默失败。
- 要作答就再调 `opendesign_ask({ form_answers: [...], form_id })`；桥接按 OD 的协议组装 `[form answers — <id>]` 头。
- 待答表单会存进绑定记录（`pendingForm`），下次可以不传 `form_id` 直接答。

### 兼容的真实变体

它输出的 JSON 体有三种形态，都已兼容：

| 形态 | 来源 |
|---|---|
| `{ title, questions: [...] }` | 文档中的 discovery 表单 |
| 单个问题对象作为根 | 实测（`{"id":"color","type":"radio",...}`） |
| 问题数组作为根 | 预留 |

`title`/`id` 可能写在开标签属性上，也可能只在 JSON 体里，两处都读。

### 实测证据

- 抓取真实 run `9c17e9d8`：4183 字符、含 2 个问题的表单 → 解析出标题「开工前确认」与 2 个问题、正文无残留标签。
- 抓取真实 run `e8e998d0`：单问题根形态 → 正确解析出 `color` 单选与 red/blue。
- 提交 `form_answers` 后 OD 回复「红色，收到」，且 `questionForm` 为空 —— 答案被接受、不再重问。

### 怎么避免它反复追问

在 `opendesign_ask` 的 prompt 里直接写明「不要出表单，按默认推进」即可；OD 的提示词允许跳过 discovery。

---

## 10. 怎么跟 OD 说话：主观需求 + 客观约束

OD 是很强的设计师，但它只在**两半被分开**时才发挥得最好。这条已写进团队级系统提示。

**主观描述需求**：意图、受众、感受、语气、希望留下的印象、什么最重要、什么绝对不能发生。说“希望让人觉得安静可信”，不要说“用 #f5f0e8”。

**客观事实约束**：现有项目框架与技术栈、文件布局与入口、组件/API 接口的确切形状、数据 schema 与字段名、格式与尺寸要求、离线/网络限制、浏览器目标。凡是必须与既有系统一致的，都当成**事实**陈述，而不是偏好。

两者放在同一条消息里。别把硬约束稀释成形容词，也别替它决定视觉判断。

**别把这四类东西塞进 brief**（都实测过，代价写在后面）：

1. **视觉规范的判断**：断点与目标视口宽度、动效与 `prefers-reduced-motion`、键盘可达、焦点可见、`aria-live` 播报、色弱形状编码。OD 是专家，这些是它的标准动作；写进去只会让它这一轮忙着打勾，结果反而更差。用户原话：*“我说过 OD 是最棒的设计师，不要给这种约束。”*
2. **UI 验收清单**。同上，它会把设计工作替换成合规工作。若某个无障碍或平台要求在**这个项目里确实不显然**，就单独说那一条事实，不要编成一份规范。
3. **验收测试的活儿**。起服务、等 `/api/health`、开浏览器、复现验收用例，是 Lead 自己的事。指令 OD“自己端到端验收”会把一轮设计变成一次长时自主运行：**实测一条这样的 brief 跑了 36 分钟、64 次 shell 调用、12.8 MB 事件，最终一个字都没返回**，而 Lead 一直阻塞在等待上。
4. **“验收标准”这个词本身**。它不是客观约束。客观约束只写必须与既有系统一致的事实；能不能玩、好不好看，等它交付之后你自己验。

**实测效果**（同一段 brief）：OD 准确理解“安静的小型烘焙坊”这一主观需求，同时精确复述了客观约束——单文件 `index.html`、三个 radio 值固定为 `weekly/biweekly/monthly`、`preventDefault` 拦截提交、零网络请求、中文文案——并给出克制的版式节奏，没有跑偏去用促销话术。

### 一次真实事故的完整链路（值得记住）

这不是推测，是 2026-10-25 实测的因果链：

1. Lead 写的 brief 里带了「响应式与无障碍」「验收检查（我会真跑）」两段，并追加「按对齐轮说的范围真跑一遍、自己在每步结束 `GET` 对账」。
2. OD 把「自己验收」当成了任务的一部分，于是起服务、写 CDP 驱动、反复重跑用例——**它埋头干活，不再回来交答案**。
3. Lead 侧唯一的出口是 `opendesign_ask` 的等待上限。当时上限到点会**顺带取消 OD 的 run**，于是 Lead 拿到一句 `did not settle within 600000ms` 就以为失败了，实际 OD 那轮还活着。
4. 结果：run 继续跑 36 分钟、64 次 shell 调用、12.8 MB 事件，**谁也没法再取回它的答案**。人最后只能去 OD 窗口手动按停止。

两条互不替代的修法，缺一条这条链路就还能复现：

- **brief 侧**：上文的四类东西不写进 brief。设计师的工作到头是「交付设计」，验收是你的。
- **桥接侧**：等待上限不再是取消键（`stillRunning` + `run_id`），所以即使 OD 真的跑久了，答案也不会丢。

**判断信号**：`opendesign_ask` 返回 `stillRunning: true` 时，不要重发请求、不要报失败；用 `run_id` 反复收集。要停只能是人的决定。

---

## 11. 运行环境注意事项（重要）

1. **推理档 `max` 会让单轮变很慢。** 实测过一轮 4 分钟、3.5 万条事件仍无工具调用；这类长思考会把 OD 的 daemon 事件循环占满，导致连 `/api/health` 都超时。**桥接的默认 `reasoning` 建议留空**（走 profile 默认），只有确实需要时才在单次调用里显式传 `reasoning`。
2. **OD daemon 是单线程的。** 一个长 turn 在跑时，其他 API 会变慢甚至超时，这是 OD 的既有行为，不是桥接缺陷。桥接因此做了两阶段发现（见 §3.4）与 `daemon-down` / `daemon-unreachable` 的区分：
   - `daemon-unreachable`：OD 没开；
   - `daemon-down`：OD 开着但内部 daemon 已死 —— 重启 OD，桥接会自动重连。
3. **端口每次启动都变。** 已实测 8620 → 10191 → 9690，桥接按进程实际监听端口自动发现。
4. 不要在桥接测试里跑重型 OD 任务：会把自己的会话和 OD 一起拖慢。
5. **等待上限不是停手键**（2026-10 修复）。`timeout_ms` 到点只表示「我不再等了」，**不会取消 OD 的 turn**：结果返回 `stillRunning: true` 与 `runId`，用 `opendesign_ask({ run_id })` 反复收集即可，收集调用本身也不会杀 turn。只有调用方自己的取消（或人在 OD 窗口按停止，`cancelOrigin: user_stop`）才真正终止。
   - 修复前的缺陷：等待上限与用户取消被合并成同一个 `AbortSignal`，`awaitRun` 一旦看到 aborted 就调 `cancelRun`。于是上限到点**顺手按下了停止**，而 OD 侧当时其实还活着并继续跑——`3076ed9c` 这个 run 就是这样变成孤儿：Lead 收到 “did not settle within 600000ms”，run 却继续跑了 36 分钟、写到 12.8 MB 事件，谁也没法再取回它的答案。
   - 判据：返回 `stillRunning: true` 不是失败，不要重发请求；只有 `status: succeeded` 才是答案，`questionForm` 非空则是提问。
   - **`runId` 丢了也能找回**（2026-10 补）。`stillRunning` 的那一轮会写进 `bindings.json` 的 `pendingRun`，`opendesign_status` 在返回体顶层如实回报，并带 `collectWith`——可直接照抄的那次 `opendesign_ask({ run_id })`。此前这个字段只写不读：一旦超时那一下丢了 `runId`，还在跑的那轮就**永久失联**，`bindings.json` 里有记录但没有任何工具开口。
   - 快速判断"OD 还在干活吗"：看 `opendesign_status` 的 `daemon.activeRunCount`。它是 daemon 级事实（`GET /api/runs/active-count`，2–4 ms），不依赖你有没有 `runId`。

---

## 12. 任务进行中改口：取消并重启（和 OD 的「引导对话」一致）

### 12.1 三层事实，别只看第一层

**第一层（源码）**：`POST /api/runs/:id/steer` 的准入判据是
`agentSupportsMidTurnSteering`，即 `promptInputFormat === "stream-json"`；daemon 注释
写着「clients must stop advertising the affordance rather than retry」。本机 `amr`
该字段为**空串**，所以这条路由在 `amr` 上返回 409。

**第二层（实测）**：对真在跑的 `amr` run 发 steer，确实 409：

```
POST /api/runs/c28ebbb0…/steer  {"text":"改成讲对比度"}
→ 409 RUN_STEERING_UNSUPPORTED
  "agent amr cannot take a mid-turn message: its stdin is closed together with the opening prompt"
```

**第三层（关键，推翻前两层给人的结论）**：**界面的「引导对话」按钮不走那条路由。**
2026-10-25 在真实桌面端人肉点击 + 数据库取证：

| 观察点 | 实测结果 |
|---|---|
| 会话里出现新的用户消息行 | ❌ **没有**，整段只有人打字发出的那 2 条 |
| 是否起新 run | ✅ 起了 `8473cde6`，在旧 run `56f9c028` 结束前 **105ms** |
| 旧 run 怎么结束 | `cancel_origin: user_stop` |
| 新 run 怎么拿到前文 | thinking 里出现 `prior_transcript` 字样，靠转录续上 |

也就是说：**它取消当前 run，用合并了新指令的上下文重启一个 run。** 不是 steer，
也不是排队。那个按钮在前端 bundle 里 grep `steerRun` / `.steer(` **一次都没命中**。

### 12.2 所以桥接的 `inject` 也这么做

`opendesign_ask({ inject })` = `cancelRun(旧的)` → 等终态 → `createRun(新)`。

| 行为 | 与 OD 是否一致 |
|---|---|
| 停掉在跑的 run | ✅ `cancel_origin: user_stop`（daemon 自己写的） |
| 起新 run | ✅ 新 run 用这句话作 prompt |
| 为这句话另写用户消息 | ✅ **不写**，它成为新 run 自己的 user turn |
| 旧 run 的产出 | ⚠️ 丢失，但 `interrupted.answerSoFar` 如实回报 |

实测一次完整改口：

```
opendesign_ask({ inject: "算了，别写说明了，改成用三个要点…" })
→ status: succeeded
  interrupted: {
    runId: "3976837d…", status: "canceled",
    cancelOrigin: "user_stop", answerSoFar: "", answerTruncated: false
  }
```

数据库里的痕迹与 OD 一致：旧 run 行 `canceled / user_stop`，改口那句话**没有**独立的
user 消息行，而是新 run `809350e2` 自己的 user turn。

### 12.3 三个坑（改这块前必读）

1. **别在 `inject` 里另写用户消息。** 早先的版本走 `PUT /messages` + `userMessageId`
   复用，功能上也自洽，但它对应的是「不打断、排到下一轮」，与 OD 语义不符，已删除。
   现在这句话只作为新 run 的 prompt 存在，历史里就一条。
2. **取消后必须等终态再起新 run。** `handleRunCreate` 对普通聊天 run **不做**单会话
   互斥（daemon 注释：`ordinary chat turns are never gated by this`），两个活 run 会在
   同一个 conversation 里交错历史。
3. **`answerSoFar` 要在取消之前取。** 取消后读到的是终态记录，不是被中断那一刻的产出。
   而一个 `thinking` 阶段就被砍掉的 run，产出本来就是空的（实测 `answerSoFar: ""`）——
   如实报空，别编。

### 12.4 两条删除/清理能力的更正

- **OD 没有删除消息的 API**（仍然成立）。探针消息会永久留在会话里，别往人真实的
  会话里写探针。
- **但工程可以删**：`DELETE /api/projects/:id` 实测有效（返回 `{"ok":true}`，随后
  `GET /api/projects` 数量归零），会先 `cancelRunsOwnedBy` 再删库。做临时探针工程时
  用它清理，不必拿归档凑合（`GET /api/projects/:id/archive` 是**打包下载 zip**，不是归档标记）。

---

## 12.5 常驻监视：`opendesign_watch`（后台 job，不是轮询）

**为什么必须是 job。** 先做过一版「`ask` 等待期间顺手看一眼」的 watchdog，实测一天就
废了：`ask` 一返回它就瞎了，而那正是 run 继续跑的时刻。Lead 交出回合之后再也看不见
OD 还在干活，只能等下次自己想起来去 `status`——这正是「卡住」的主观来源。

改用 DSH 的 `ctx.jobs`：

```
opendesign_watch                      → { jobId: "bash-xxxx", intervalMs: 5000 }
job_output bash-xxxx                  → 读变化
job_kill   bash-xxxx                  → 停掉
```

实测捕获一个完整生命周期（间隔 3 秒）：

```
watching conversation c78b52a6 every 3000ms
17:18:09 appeared: run cad6f421 is queued
           → check the output: opendesign_ask({ run_id: "cad6f421-…" })
17:18:12 status:   run cad6f421 now running
           → check the output: opendesign_ask({ run_id: "cad6f421-…" })
17:18:28 gone:     run cad6f421 is no longer live (was running) — its answer can be collected
```

**三个刻意的信号取舍**（`lib/conversation-watch.js`，纯函数，13 个测试）：

| 取舍 | 原因 |
|---|---|
| journal 增长**不算**变化，单独归为 `activity` 且不报 | thinking 阶段事件流每轮都涨；把它当变化，每 5 秒一条「有新闻」，人就开始忽略信号 |
| 不引用答复正文 | 答案由 `ask({run_id})` 收；第二个真相来源只会制造不一致 |
| `gone` 单独算事件 | run 消失正是答案变得可取的那一刻 |

`ctx.jobs` 是**可选**服务，用 `ctx.get('jobs')` 取，**不要写进 `inject`**：写进去会让
整个插件在没装 jobs 的组合里直接起不来——为一个功能废掉全部功能。

---

## 13. 不启动桌面客户端，直接跑 daemon + 网页版（可行，但 onboarding 会卡）

2026-10-25 实测出来的一条路，记下来免得再摸索：

```powershell
# 1. daemon：必须用 Electron 自带的 Node
#    系统 Node 是 ABI 137，OD 的 better-sqlite3 是 ABI 145，直接跑会 ERR_DLOPEN_FAILED
$env:ELECTRON_RUN_AS_NODE="1"
$env:OD_DATA_DIR="…\namespaces\release-stable-win\data"
$env:OD_REQUIRE_DESKTOP_AUTH="0"     # 不设它，daemon 会开 desktop-auth 门
$env:VELA_BIN="…\resources\open-design\bin\vela.exe"   # 否则 amr 判定 not-on-path
& "…\Open Design.exe" "…\prebundled\daemon\daemon-cli.mjs" --port 10580 --host 127.0.0.1 --no-open

# 2. 网页版：独立 Next.js，自包含
$env:PORT="10589"; $env:HOSTNAME="127.0.0.1"
node "…\open-design-web-standalone\apps\web\server.js"
```

`od --help` 里写着「Start the local daemon and open the web UI」，但 `--no-open` 下
**只起 daemon**，网页版要单独拉。

**卡点**：网页版 onboarding 即使选了「本地 AI」也坚持「尚未检测到任何代理」，而同一个
daemon 的 `/api/agents` 里 `amr` 是 `available: true`、37 个模型。说明 web standalone 与
desktop 用的是**两套不同的 daemon 连接方式**，不是环境变量能对齐的。想驱动真界面，还是
让用户正常打开桌面客户端最省事。

### 13.1 `Open Design.exe` 无参启动会 exit 0 且不出窗口

`packaged-main.mjs` 的 `main()` 里：

```js
if (await bootstrapSidecarProcess(launchStamp, {…})) { app22.exit(0); return; }
```

它把 sidecar 拉起来之后就自己退出，窗口由后续进程负责。所以「双击没反应」不等于坏了。

### 13.2 `amr` 不可用的真凶是 `vela` 不在 PATH

`/api/agents` 的 diagnostics 会直接写明：

```json
{ "reason": "not-on-path",
  "message": "AMR (`vela`) was not found on your PATH." }
```

`vela.exe` 在 `resources\open-design\bin\`，`vela --version` 正常（0.1.7）。把它加进
PATH 或设 `VELA_BIN`，`amr` 立刻变 `available: true`。**这条对桌面版同样适用。**

- **OD 没有删除消息的 API**（仍然成立）。探针消息会永久留在会话里，别往人真实的
  会话里写探针。
- **但工程可以删**：`DELETE /api/projects/:id` 实测有效（返回 `{"ok":true}`，随后
  `GET /api/projects` 数量归零），会先 `cancelRunsOwnedBy` 再删库。做临时探针工程时
  用它清理，不必拿归档凑合（`GET /api/projects/:id/archive` 是**打包下载 zip**，不是归档标记）。
   - **`runId` 丢了也能找回**（2026-10 补）。`stillRunning` 的那一轮会写进 `bindings.json` 的 `pendingRun`，`opendesign_status` 在返回体顶层如实回报，并带 `collectWith`——可直接照抄的那次 `opendesign_ask({ run_id })`。此前这个字段只写不读：一旦超时那一下丢了 `runId`，还在跑的那轮就**永久失联**，`bindings.json` 里有记录但没有任何工具开口。
   - 快速判断"OD 还在干活吗"：看 `opendesign_status` 的 `daemon.activeRunCount`。它是 daemon 级事实（`GET /api/runs/active-count`，2–4 ms），不依赖你有没有 `runId`。
