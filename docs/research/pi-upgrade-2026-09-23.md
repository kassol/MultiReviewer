# Pi 0.87.1 与 pi-subagents 0.70.1 跟进(2026-09-23)

当前钉法:`@earendil-works/pi-coding-agent ^0.86.0`、`pi-subagents 0.70.0`(`package.json:22,25`)。npm 上的版本:Pi 0.86.1(2026-09-20)、0.87.0(2026-09-21)、0.87.1(2026-09-22T19:42Z)。来源:`npm pack` 解出 pi-coding-agent / pi-ai / pi-agent-core / pi-tui / chord / pi-telemetry 两版,读包内 CHANGELOG、`.d.ts` 与 `dist/*.js` 做 diff;pi-ai 与 pi-agent-core 的包里不带 CHANGELOG,取自 GitHub tag `v0.87.1` 的 `packages/{ai,agent}/CHANGELOG.md`。**没有跑 typecheck,也没有跑真实 SDK 回归**,结论只到「读包」这一层。

## Pi 0.86.0 → 0.87.1

### 依赖树

- pi-coding-agent 的 `dependencies` 两版逐项相同,只有 `@earendil-works/*` 从 `^0.86.0` 升到 `^0.87.1`。它的 `npm-shrinkwrap.json` 两版都是 143 个条目,其中 earendil 包只有 chord / pi-agent-core / pi-ai / pi-telemetry / pi-tui 五个。
- pi-ai 与 pi-agent-core 的依赖 diff 只有 pi-telemetry / chord 的版本号。**不会带回 `pi-server`**,也没有新增或移除第三方运行时依赖。
- 包体积:pi-coding-agent 7.17 MB → 7.33 MB,其余几个包变化都在 ±4% 以内。
- 升级方法与 issue #265、#403 相同:`pnpm update "@earendil-works/*"` 合并重复副本。`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 要把那六个 `@0.86.0` 换成 `@0.87.1`。0.87.1 要到 2026-09-23T19:42Z 才满 24 小时,在那之前升级必须加这份豁免。

### 0.87.0 的三个主要特性对本项目是否适用

**1. 会话以 SessionManager 为准,新增 `ContextEditEntry` 与可操作的生命周期边界。** 来源:coding-agent CHANGELOG 0.87.0 New Features / Added;`session-manager.d.ts` 新增 `ContextEditEntry`、`appendContextEdit`、`buildSessionProjection`;`extensions/types.d.ts` 新增 `AgentBeforeSettleEvent` 与 `BoundaryResult { entries?, continue? }`。

- **Agent 会话的重建方式正是上游推荐的做法。** 上游写明应该用 `SessionManager.inMemory(cwd, { id }, entries)` 恢复会话。本项目 `src/reviewer/worker-tools.ts:517-523` 本来就这样重建,从来没有直接改 `agent.state.messages`(grep 没有命中)。这一条破坏性变更不影响本项目。
- **Agent 会话的记录里会出现新的条目类型 `context_edit`。** 0.87 在自动重试或溢出恢复时,会用 `_omitRecoveryAttempt` 把失败的那次尝试记成 `context_edit(replacement: null)`(`agent-session.js:667-683`)。本项目开着重试(`worker-tools.ts:459-462`,`maxRetries: 1`)。镜像按条目数截取(`session-worker.ts:245-251`),新条目会原样落库,重建时再原样喂回 Pi,与 ADR 0031「原样存条目」一致。这类条目不带用量,`agentSessionEntryUsage`(`webhook/agent-session.ts:407`)读出来是 0。面板只渲染 `message` / `custom` / `custom_message` 三类(`web/src/lib/agent-session-records.ts:356,386,412`),其余一律跳过。`agentSessionContextGap`(`webhook/agent-session.ts:555`)沿 `parentId` 链往上走,`context_edit` 也有 `parentId`。**风险在测试**:凡是断言「重试之后记录有几条」的用例,条目数可能多出来,要跑一遍全量测试确认。
- **上游修掉了重试时的上下文污染。** 0.86 下,失败的那次尝试会留在之后请求的上下文里(0.87.0 Fixed:"selected error retries … retaining abandoned model attempts")。Reviewer、规则 agent、合并 agent 与 Agent 会话四条链路都开着 1 次重试,升级后直接受益,本项目不用改代码。
- **`agent_before_settle` 可以作为 issue #431「自动续一句」的现成实现。** 在会话即将结束前,handler 返回 `{ entries: [{ type: "custom_message", display: false, … }], continue: true }`,就能保证模型再收到一次请求(`types.d.ts` 的 `BoundaryResult`,以及 CHANGELOG 0.87.0 Added)。这样不用在 `runAgentWorker` 里手写第二次 `prompt`,可以作为 `extensionFactories` 挂在 Reviewer 上(与 `worker.ts:640` 的取证契约扩展是同一个挂载点)。#431 已经以「未复现,复现了再开」结案,所以这项只记作备用方案,现在不做。
- `turn_end` 变成可以返回结果的事件、`agent_settled` 触发的 run 被推迟:本项目不订阅这两个 extension 事件。`trace-events.ts:111-193` 与 `session-worker.ts:352-390` 订阅的是 AgentSession 事件(`message_end`、`tool_execution_*`、`compaction_end`、`auto_retry_*`、`queue_update`),这些事件都没有改。pi-subagents 0.70.0 自己订阅 `agent_settled` 与 `turn_end`(`src/extension/index.js:1046`、`src/watchdog/register-main.js:395`),但只是观察,没有在 handler 里发起 run。这一点的兼容性交给 pi-subagents 那一节确认。

**2. `context_with_system` 扩展事件。** 用来在每次请求前改写整份 transcript,包括 system 消息。本项目不改写上下文,只有取证契约扩展订阅了 `tool_call`(`evidence.ts:484`),因此**不适用**。附带的修复是:`context` handler 不再看得到 system 消息,Pi 会在 handler 跑完后恢复提示和工具声明。本项目不注册 `context` handler,不受影响。

**3. 按模型设置图片输入上限,`inputLimits.images.resize`。** 来源:pi-ai `types.d.ts` 新增 `ModelInputLimits`;目录里 1015 个模型带上了 `inputLimits`。

- 0.87 的 `AgentSession.prompt()` 会按 `model.inputLimits.images.resize` 重新处理一遍图片(`_normalizePromptImages`,`agent-session.js:1179-1197`)。0.86 没有这一步。`steer` / `followUp` 不走这一步(`agent-session.js:1415-1456`)。
- 本项目的运行模型是按字段逐个登记的(`model-runtime.ts:79-90`、`model-service-runtime.ts:355-381`),不带 `inputLimits`。因此 Pi 用的是默认配置,与上传时 `resizeImage` 的默认值相同(`session-images.ts:77`;`image-resize.js` 两版没有差异)。上传时已经缩放过的图,到了 prompt 这一步 `wasResized=false`,不会往用户消息里追加尺寸说明。`deflateImageBlocks` 按位置替换(`session-images.ts:159-168`),重新编码不影响引用对应关系。
- 可以把 `inputLimits` 抄进目录快照吗?抄了意义不大。以 Anthropic 为例,`claude-opus-5-5` 的 resize 配置是 2000×2000 / 4718592 字节,和默认值完全相同。**不做。**

### 破坏性变更与本项目的调用点

| 变更 | 本项目的调用点 | 结论 |
|---|---|---|
| 删除 `shouldStopAfterTurn`,改用 `finishTurn`(agent-core CHANGELOG 0.87.0) | grep 没有命中 | 不触发 |
| `SessionEntry` 联合类型新增 `ContextEditEntry` | 没有对条目类型做穷举 switch。面板按 `type` 分支,认不出的跳过(`agent-session-records.ts:412`) | 不触发;记录里多出条目,见上文 |
| `AgentSession` 的上下文以 SessionManager 为准,赋值 `agent.state.messages` 不再生效 | 只读 `session.agent.state.errorMessage`(`worker-tools.ts:382`、`session-worker.ts:445`);字段仍在(`agent-core types.d.ts:363`) | 不触发 |
| `TurnEndEvent` 扩展、`ExtensionRunner.emit()` 不再接受 `turn_end` | 本项目不构造 extension 事件,也不调用 runner | 不触发 |
| `appendCompaction` 的 `firstKeptEntryId` 可以为 `null`(retain-none 压缩) | 本项目不调用。自动压缩仍然写真实 id;就算写了自身 id,`agentSessionContextGap` 的 `byId` 也能查到 | 不触发 |
| **openai-completions 的 `supportsStrictMode` 自动检测默认值从 true 改为 false**(`openai-completions.js:1288`;#9816) | 见下一节 | 行为变化,不是编译错误 |

用到的 Pi 导出(`defineTool`、`createAgentSession`、`SessionManager`、`SettingsManager`、`DefaultResourceLoader`、`ModelRuntime`、`resizeImage`、`InlineExtension`、`create{Find,Grep,Ls}ToolDefinition`)在 `index.d.ts` 里都还在,签名 diff 为空(`resizeImage` 与 `settings-manager.d.ts` 两版逐字相同)。预计 typecheck 零改动,但未实跑。

### 目录数据里的 compat 与模型 id

对比两版 `pi-ai/dist/providers/data/*.json`(结构是 `{api: {id: model}}`),逐模型收集 compat 键:

- **没有新增的 compat 键,也没有删除的。** `gatewayCompat`(`model-service-runtime.ts:294-306`)不用再多剥哪一位。
- **变化的是 `supportsStrictMode` 的取值分布。** openai-completions 模型里,标 `true` 的从 21 个增加到 636 个,留空的从 599 个减少到 20 个。0.87 把「没声明就当支持」改成「目录显式声明才算支持」,新增声明的包括 deepseek、groq、openrouter、zai、fireworks 等 19 家。对本项目的影响有两处:
  - **内置服务:已存的快照会失去 strict 工具 schema。** 0.86 时发现的内置 openai-completions 服务(例如 deepseek),快照里 compat 没有这一位(`model-service-runtime.ts:439` 照抄目录的 compat)。0.86 下靠自动检测得到 true,0.87 下变成 false,`report_finding` 等工具不再带 `strict`。刷新一次目录、重新验证后就能拿回 true。这只是约束采样变松,工具调用照常能用,不会导致失败。
  - **自定义网关:行为与 0.86 相同。** 自定义服务按 model id 猜厂商(`customModelVendor`,`:255-261`,只识别 openai / anthropic / google)。openai 目录的 compat 带着 `supportsStrictMode: true`,会被抄进网关模型,网关因此照旧收到 `strict`,与 0.86 的默认值一致,不算回退。猜不出厂商的 id 从默认 true 变成 false,更保守。只有接入的网关拒收 `strict` 时,才需要在 `gatewayCompat` 里剥掉这一位。当前没有这方面的证据。
- **模型 id 的变化。** 新增:anthropic 的 `claude-opus-5-5`(1M 上下文、adaptive thinking);openai / openai-codex / azure 的 `gpt-6-sol` 与 `gpt-6-luna`;xai 的 `grok-4.7`;新 provider `meta`(0.86.1 加入)。删除:nvidia 的 `deepseek-ai/deepseek-v4-flash-0731`;openrouter 的 `anthropic/claude-opus-4` 等 13 项;opencode 的 `mimo-v2.5-free`。**`deepseek-flash` 没有改名**,`AGENTS.md:41` 的 smoke 命令不用改。
- **对自定义网关的收益。** 自定义网关上的 `claude-opus-5-5` 或 `gpt-6-sol`,升级后发现能从目录拿到真实的上下文、输出上限与思考档位,不再退回运行基线(128k / 16k / 不推理)。要用这些新型号就必须升级。

### 上次留下的两项

- `compaction.modelOverrides`:`settings-manager.d.ts` 两版逐字相同,没有变化。Agent 会话仍然用默认值(`worker-tools.ts:459`),照旧不做。
- `compat.allowedFallbackModels`:`model-config.d.ts:135` 的定义没有变,`anthropic-messages.js` 的引用次数也相同(两版都是 5 处)。两版之间 anthropic-messages 的唯一差异是 OAuth 用的 `claudeCodeVersion` 字符串,本项目走 API key,与这个字符串无关。仍然不做。

### 升级后直接得到的修复

- 重试与溢出恢复后,失败的那次尝试不再留在上下文里(0.87.0,见上文)。
- openai-completions 在「只有图片的用户消息」里不再发空的 text part(#9797,`openai-completions.js:930-932`)。有些兼容网关会因为这个空 part 回 400,Agent 会话走 openai-completions 网关时可能碰到。
- 以 `GIF` 开头的文本文件不再被 `read` 当成图片(#9755)。本项目覆盖了 `read` 并自己带行号读取,这条修复只在 harness 层生效,收益很小。
- 以 Claude Fable 5.1 为目标、从中途切开回合的压缩摘要被拒收的问题已修复(#9908)。Agent 会话开着自动压缩,会走到这条路径。
- 0.86.1:z.ai 的 `Prompt too long` 被识别为上下文溢出(#9805);Node 编译缓存让 CLI 启动更快(只影响 CLI 入口,本项目的子进程走 SDK,不受益)。

## pi-subagents 0.70.0 → 0.70.1

来源:两版 `npm pack` 解包 diff 与 0.70.1 的 `CHANGELOG.md`。修正版,无破坏性变更。

- `package.json` 只改版本号;peer 仍是 `pi-coding-agent: "*"`(optional)、`pi-ai: ">=0.80.0"`。
- 删掉按任务措辞推断「是否要改文件」的完成判定:`completionGuard` 设置、`PI_SUBAGENTS_LLM_INTENT_ARBITER` 开关与 `completion-guard` / `task-intent` / `llm-intent-arbiter` 三个文件;`acceptance.js` 只认显式 `acceptanceRole`。取证 agent 显式声明 `acceptance: { level: "none" }`(`src/reviewer/evidence.ts:237`),不走被删路径。
- 子会话加载宿主 SDK 改为 `loadHostPiCodingAgent`(`child-session.js`):依次试 `argv[1]` 上溯包根、`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`、`import.meta.resolve`。Reviewer 子进程前两处落空,最终解析到 pnpm 链入的同一份 Pi,效果与旧版相同。
- 运行时注册的 agent 认 `subagents.defaultModel`(#2368):本项目 agentDir 不写它,不触发。另修 Pi 0.86.1 上的 watchdog 与 inspector 打包。
- 本项目钉法不受影响:能力天花板 `pi-subagents/capability-ceiling`(`evidence.ts:51-53`)不在 diff 里;前台执行与关 intercom(`evidence.ts:305`、`:355`)、只读四件套与 cwd / `agentScope` 钉法相关代码未动。
- 与 Pi 0.87.1:pi-subagents 从 Pi 导入的 13 个符号在 0.87.1 均在,0.86→0.87 导出只增不减;0.87 唯一删除的 `shouldStopAfterTurn` 两边都没用;`CURRENT_SESSION_VERSION` 两版都是 3。**缺口**:0.70.1 早于 Pi 0.87.0 发布,上游只写明支持 0.86.1,未在 0.87 上测过;npm 只有 `latest=0.70.1`。因此升级后必须跑取证契约的真实 SDK 回归,替代上游缺的这一轮。

## 建议

**值得做**

- 升级到 Pi 0.87.1。理由:重试的上下文污染与只含图片的消息被网关 400 这两项修复都落在本项目实际走的路径上;要在自定义网关上用 Opus 5.5 或 GPT-6 Sol,必须升级才能拿到真实的模型参数。改动量:`package.json` 一行、`pnpm-workspace.yaml` 豁免清单六行、lockfile,源码预计零改动。
- 升级后跑 `pnpm check`,重点看 Agent 会话里「重试之后记录有几条」一类断言,以及 `test/reviewer-evidence-session.test.ts` 的真实 SDK 取证回归。理由:`context_edit` 会让记录条数变化,而本项目没有实跑过。改动量:只跑测试;如果条数断言变了,改几处数字。
- 发版后在面板上刷新内置的 openai-completions 模型服务(deepseek 等)的目录并重新验证。理由:旧快照缺 `supportsStrictMode`,在 0.87 下工具不再带 `strict`。改动量:纯运维操作,不改代码。

- pi-subagents 同步升到 0.70.1。理由:删掉一段猜测逻辑、风险更低,且是唯一可用版本;`package.json` 的 `^0.86.0` 不含 0.87,两包一起改。改动量:一行。

**可选**

- `gatewayCompat` 增加剥掉 `supportsStrictMode`。理由:与上游 #9816「兼容端点默认不发 strict」的方向一致,但现在没有网关拒收的证据,0.86 下本来也在发。改动量:3 行加一条用例。
- 如果 #431 描述的无声收工再次出现,用 `agent_before_settle` 加 `continue: true` 实现「自动续一句」,不在 `runAgentWorker` 里手写第二次 prompt。理由:上游已经提供追加一条不显示的提示并保证模型再被请求一次的原语,而且只触发一次。改动量:约 40 行的 InlineExtension,加上判定「给出少于应给」的条件。

**不做**

- 把 `inputLimits` 抄进快照。理由:默认配置与 Anthropic 目录的配置相同,上传时也已经缩放过。
- `context_with_system` 与 `ContextEditEntry` 的主动写入。理由:本项目不改写上下文。
- `compaction.modelOverrides` 与 `allowedFallbackModels`。理由:这两个接口在这次升级中没有变化,当初不做的理由仍然成立。
