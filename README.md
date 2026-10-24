# @local/dsh-opendesign-member

把本机 **Open Design** 接入 DSH 团队模式，作为前端/UI 第一优先成员。

每个 DSH 团队成员绑定一个**真实**的 Open Design 会话窗口：消息双向流通，窗口粒度是
成员级（新成员即新窗口），工作区与模型自动对齐。

## 四个工具

| 工具 | 作用 |
|---|---|
| `opendesign_open` | 打开/复用**该成员自己的** OD 会话窗口，并与团队工作区、模型对齐 |
| `opendesign_ask` | 跑一轮真实 OD 对话，**只返回该轮最终答复**；中间流式输出一律不返回 |
| `opendesign_inbox` | 取回**人在 OD 窗口里打的字**，以及 **OD 自己回的话**（桥接没发起的那轮）|
| `opendesign_status` | 报告 daemon 状态、能力缺口、全部绑定与对齐情况 |

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

# 2. 第一轮永远先对齐：说清这是干什么用的，让 OD 回话
opendesign_ask  prompt="<主观需求 + 客观事实>"

# 3. 看人有没有在 OD 窗口里留话，以及 OD 有没有自己回话
opendesign_inbox  peek=true   # 只看不消费

# 4. OD 出表单时，它返回 questionForm 而不是失败；用答案回应
opendesign_ask  form_answers=[{id:"color", label:"Which color?", value:"red"}]

# 5. OD 迟迟不收敛时，别把等待上限当停手键：它仍在工作
opendesign_ask  run_id="<上一轮返回的 runId>"   # 反复收集是安全的
```

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
- **入站分两种。** `messages` 是人在窗口里打的字；`odReplies` 是 OD 自己的回答，
  且只报桥接没发起过的那些（人在窗口里暂停/纠偏时 OD 的回话）。只收人类消息时，
  人会看到「暂停」而看不到 OD 随后那一整段总结。
- **入站恰好一次。** 每个成员有游标，消费后前移；光标失效时按时间戳兜底，
  绝不整段回放历史。`messages` 与 `odReplies` 共用同一个光标。
- **只取最终输出。** 不采集任何流式帧，只按 `assistantMessageId` 读那一条。

## 开发

```powershell
npm run check   # node --check 每个源文件
npm test        # 35 个测试，不需要 Open Design 在运行
```

测试只覆盖纯函数导出（`awaitRun` / `readInbound` / `resolveSelection` / `BindingStore`），
不需要 Cordis、浏览器或 daemon。`index.js` 的工具注册与 `client.js` 的 React 渲染
**不在自动化覆盖内**，改动这些需手工验证。详见 [`AGENTS.md`](./AGENTS.md)。

## 延伸阅读

- `~/.dsh/opendesign-team-bridge.md` —— 完整契约、实测证据、升级维护手册、
  环境注意事项。**本机部署文档，不在本仓库内**；它记录的是那一台机器的实测
  数据（端口、版本、profile 布局），换机器需重新探测。
- [`AGENTS.md`](./AGENTS.md) —— 修改本插件的代码约定与踩坑记录

## 许可证

[MIT](./LICENSE)。本插件零外部依赖，只使用 Node 内置模块，因此没有第三方许可义务。
