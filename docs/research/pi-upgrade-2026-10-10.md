# Pi 1.0.1 → 1.1.0、pi-subagents 0.75.0 → 0.76.1 试装(2026-10-10)

当前钉法:`@earendil-works/pi-coding-agent ^1.0.1`、`pi-subagents 0.75.0`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `a938bd5`)。npm 上的发布时刻(`npm view <包> time --json`):

- pi-coding-agent:1.0.2 为 2026-10-04T00:56:19Z,1.0.3 为 2026-10-05T08:37:00Z,1.0.4 为 2026-10-05T21:51:59Z,1.1.0 为 2026-10-07T22:16:26Z。其余七个 earendil 包的 1.1.0 发布于 2026-10-07T22:09–22:14Z。`latest` 是 1.1.0。
- pi-subagents:0.76.0 为 2026-10-04T23:57:07Z,0.76.1 为 2026-10-06T01:33:43Z。`latest` 是 0.76.1。

来源:

- `npm pack` 取 1.0.1 与 1.1.0 两版的 pi-coding-agent、pi-ai、pi-agent-core、pi-tui、chord、pi-telemetry、pi-mcp、pi-codemode,以及 pi-subagents 0.75.0、0.76.0、0.76.1。解包后逐文件 diff(`diff -rq`,去掉 `.map`)。
- 包内 `CHANGELOG.md`:pi-coding-agent 的 `[1.0.2]`–`[1.1.0]` 四节,pi-mcp 同四节,pi-subagents 的 `[0.76.0]` 与 `[0.76.1]`。其余六个 earendil 包不带 CHANGELOG,以 dist diff 为准。
- 上游 release notes:`gh api repos/earendil-works/pi/releases/tags/v1.0.2|v1.0.3|v1.0.4|v1.1.0`,`gh api repos/nicobailon/pi-subagents/releases/tags/v0.76.0|v0.76.1`。Pi 四节的条目与包内 CHANGELOG 逐条相同(去掉链接地址后比对,38 + 12 + 10 + 2 条,无差)。pi-subagents 两节多出的 5 条与 2 条是 Highlights 换了措辞重述,没有 CHANGELOG 之外的内容。
- **实跑过**:一次性 worktree(`a938bd5`)里把两个包钉到新版,`pnpm install`、`pnpm update "@earendil-works/*"`、`tsc --noEmit`,加 4 个测试文件(第 4 节)。
- **请求探针**:本机 HTTP 服务记下请求地址、头与正文,分别用两版 pi-ai 的 `streamSimple` 各发 5 种请求,再 diff 两份记录(第 1.8 节)。
- **工具声明体积**:直接 import 两版已装 pi-subagents 的 `createSubagentParamsSchema` 与 `buildSubagentToolDescription`(第 2.4 节)。

下文 `ca/` = `pi-coding-agent/dist/`,`ai/` = `pi-ai/dist/`,`core/` = `pi-agent-core/dist/`,`ps/` = `pi-subagents/src/`,行号均指新版(1.1.0 / 0.76.1)。

## 结论

能直接升,源码不改。改动只在 `package.json` 两行、lockfile 与 `pnpm-workspace.yaml`。typecheck 通过,4 个测试文件 47 条用例全过。两个新版都已过 24 小时发布年龄窗口,`pnpm-workspace.yaml` 的 8 条 `@1.0.1` 豁免可以整段删掉。

1.0.2–1.1.0 只有一处 Breaking Changes(1.0.3:Azure provider 改名),本项目不用它。要知道的五处变化:

1. **会话条目多一格 `durationMs`**(第 1.4 节)。新落库的助手消息与工具结果带它,`CURRENT_SESSION_VERSION` 仍是 3,旧条目照常重建。它不进任何请求正文。
2. **`max_tokens` 在长上下文里会变小**(第 1.8 节)。pi-ai 估算 token 改为每 3.5 字符一个(原为 4),`clampMaxTokensToContext` 据此压低输出上限。探针实测:128k 上下文的运行基线模型、40 万字符的首条消息,`max_completion_tokens` 从 16384 降到 9618。其余请求正文逐字相同。
3. **`tools` 允许清单改成名字或通配模式匹配**(第 1.5 节)。本项目的工具名不含 `*`、不以 `+` / `-` 开头,判定结果不变;`subagents_enable` 仍被滤掉。
4. **目录变化**(第 1.7 节):compat 键与模型字段零增减;`azure-openai-responses` 改名 `azure`;`opencode-go` 两个模型换了调用目标。常用五个型号逐字相同。
5. **pi-subagents 子会话的系统提示换了顺序**(第 2.2 节):pi-subagents 自己的边界说明从开头挪到结尾,内容不变。取证与会话子代理的工具面、天花板、transcript、用量并入、上限读法都没变。

## 1. Pi 1.1.0

### 1.1 CHANGELOG 逐条

只列与 SDK 使用方可能有关的条目。TUI、CLI 参数、OAuth 登录、codemode、MCP、Bedrock、Termux、Herdr 等条目一律不受影响:本项目不跑 CLI 与交互模式,SDK 会话不加载 MCP 与 codemode(第 1.6 节)。

| 版本 | 条目 | 本项目 |
|---|---|---|
| 1.0.2 Added | `models.json` 加 `samplingParamsByThinkingLevel` | 不受影响。本项目注册的模型不写这一格,目录里也没有一行带它(脚本统计 0 行)。见第 1.8 节 |
| 1.0.3 Breaking | `azure-openai-responses` provider 改名 `azure` | 本项目源码、测试、ADR 不引用这两个名字(`grep -rn azure src test web/src docs/adr` 为空)。部署实例上若有此名的内置服务或叫 `azure` 的自定义服务,见第 1.7 节 |
| 1.0.3 Changed | 截断的工具输出、MCP 资源、codemode 图片等输出文件改为仅本用户可读 | 不受影响。新文件 `ca/utils/output-files.js`,调用点都在 codemode、MCP 与 Pi 内建 `read`/`bash` 的截断落盘上 |
| 1.0.4 Added | `--tools` / `--exclude-tools` 接受 `*` 模式 | SDK 的 `tools` 选项同样改为模式匹配,见第 1.5 节 |
| 1.0.4 Fixed | 系统提示的规则与 skill 提示不再提 `prepareLoadout` 隐藏的工具 | 不受影响。本项目不用 `prepareLoadout`(`grep -rn prepareLoadout src` 为空),隐藏集为空时输出不变,见第 1.6 节 |
| 1.1.0 Added | `tool_execution_end` 扩展事件加 `durationMs` | 新增可选字段。本项目的 `trace-events.ts:16` 自己声明事件类型,不读它 |
| 1.1.0 Added | `agent_settled` 事件加 `aborted` | 本项目不订阅 `agent_settled`(`grep -rn agent_settled src` 为空) |
| 1.1.0 Added | `--tools` 的 `+name` / `-name` | SDK 的 `tools` 同样认这种写法,见第 1.5 节 |
| 1.1.0 Fixed | `node --watch` 下图片缩放被误判失败 | `resizeImage` 的 worker 改为只认带标签的回应(`ca/utils/image-resize.js:9,32-40`)。本项目的 `session-images.ts:18,77` 调它,不用 `--watch`,行为不变 |
| 1.1.0 Fixed | `server_busy`、`servers are currently busy` 改为可重试 | `ai/utils/retry.js:26-27`。只是多重试两类报错,重试事件的形状不变 |
| 1.1.0 Fixed | 按 3.5 字符一个 token 估算输入,减少上下文超限 | `ai/utils/estimate.js:2`。见第 1.8 节 |
| 1.1.0 Fixed | 分档计价模型的会话费用低算 | 不受影响。本项目只记 token,不读 `stats.cost`(src/AGENTS.md「用量只记 token」) |

pi-mcp 的 `[1.0.2]`–`[1.1.0]` 只有 Added 与 Fixed,没有 Breaking Changes。本项目不 import pi-mcp、pi-codemode、pi-agent-core(`grep -rn "@earendil-works/pi-mcp\|pi-codemode\|pi-agent-core" src` 为空)。

**`engines.node`**:两版的 pi-coding-agent 与 pi-ai 都没有改 `engines`(`package.json` 对比)。

### 1.2 依赖树

- pi-coding-agent 的 `dependencies`:七个 `@earendil-works/*` 从 `^1.0.1` 改成 `^1.1.0`,第三方依赖一个没变(`npm view … dependencies` 两版对比)。
- 子包之间只有版本号联动(pi-ai 的 pi-telemetry、pi-agent-core 的 pi-ai),第三方依赖、peer、`exports` 都没变(逐包比对 `package.json` 的四格)。`@anthropic-ai/sdk` 仍是 0.129.0(探针头 `x-stainless-package-version`)。
- 实装后 lockfile 的包键 740 → 742:
  - 换版 9 个:8 个 earendil 包与 pi-subagents。
  - 新增 2 个:`@js-temporal/polyfill@0.5.1`(ISC)与它的依赖 `jsbi@4.3.2`(Apache-2.0)。来源是 pi-subagents 0.76.0 新增的直接依赖(`pi-subagents/package.json` 的 `dependencies`),给定时任务的时区计算用。两者都发布于 2025-03-31。
  - 没有删除。没有新增带原生二进制的包。
- `pnpm install` 之后 lockfile 里没有 `@earendil-works/*@1.0.1` 或 `pi-subagents@0.75.0` 的键(`grep` 为空)。`pnpm update "@earendil-works/*"` 输出 `Already up to date`,lockfile 不变(`diff -q`)。`pnpm why @earendil-works/pi-ai` 报 `Found 1 version`。

### 1.3 本项目的 import 逐个核对

import 只在 `src/reviewer/` 下 15 个文件,全部来自 `@earendil-works/pi-coding-agent` 根入口;另有 `evidence.ts:53` 从 `pi-subagents/capability-ceiling` 取天花板。`tsc --noEmit` 退出码 0。

| 依赖点 | 本项目位置 | 1.1.0 的情况 |
|---|---|---|
| 根入口导出 | 全部 | `ca/index.js` 与 `ca/index.d.ts` 逐字相同(`cmp`) |
| `createAgentSession` 入参 | `worker-tools.ts:508-525` | `ca/core/sdk.js` 改了 `tools` 的解析(第 1.5 节)。其余入参不变 |
| `DefaultResourceLoader` | `worker-tools.ts:463-477` | 新增可选项 `disabledBuiltinExtensions`(`ca/core/resource-loader.d.ts:81-82`),不传即空集。`noSkills`、`systemPromptOverride` 的处理没变 |
| `SessionManager.inMemory` | `worker-tools.ts:517-522` | `ca/core/session-manager.js` 与 `.d.ts` 逐字相同 |
| `ModelRuntime`、`registerProvider` | `model-runtime.ts:4`、`catalog.ts:6` | `ca/core/model-runtime.d.ts` 逐字相同。`model-runtime.js` 只在分类器调用里多一句输入检查(`:556`) |
| `RegisterProviderModel` 的 chat 收窄 | `model-runtime.ts:12-15` | chat 模型配置多一格可选 `samplingParamsByThinkingLevel`(`ca/core/model-config.js:181-182,202-203`)。`Extract` 仍按 `thinkingLevelMap` 挑出 chat 那一支,typecheck 通过 |
| `resizeImage` | `session-images.ts:18,77` | `.d.ts` 逐字相同,`.js` 见第 1.1 节 |
| `createFindToolDefinition` / `Grep` / `Ls` | `worker-tools.ts:17-19` | `ca/core/tools/{find,grep,ls}.js` 逐字相同 |
| `defineTool` 一族 | 各工具文件 | `ca/core/tools/tool-definition-wrapper.js` 逐字相同 |
| 会话事件 | `trace-events.ts`、`session-worker.ts` | 事件名不变。`tool_execution_end` 多可选 `durationMs`(`ca/core/agent-session.js:961`),`agent_settled` 多 `aborted`(`:690-691`) |
| `agent_before_settle` | `worker.ts:603` | `_runBeforeSettleBoundary`(`ca/core/agent-session.js:1452-1458`)代码未改动;`reviewer-verdict-nudge` 6 条全过 |
| `tool_call` 钩子 | `evidence.ts:484` | `ca/core/extensions/runner.js` 逐字相同(钩子在 `:960`);`reviewer-evidence-session` 14 条全过 |

`ca/core/tools/read.js` 改了(多一份 `outputSchema` 与 `structuredContent`,给 codemode 用),本项目用自己的 `numberedReadTool` 覆盖 `read`,不走它。

### 1.4 会话条目格式(ADR 0031)

- `CURRENT_SESSION_VERSION` 仍是 3(`ca/core/session-manager.js:11`)。`session-manager.js`、`.d.ts`、`ca/core/messages.js` 与 `ca/core/compaction/` 整个目录逐字相同。
- **新增字段**:
  - 助手消息多可选 `durationMs`(`ai/types.d.ts:398-404`),由 `ai/utils/event-stream.js:102-118` 在收尾那条消息上写入。
  - 工具结果消息多可选 `durationMs`(`ai/types.d.ts:439-440`),由 `core/agent-loop.js:667` 写入。
  - 两格都是可选,注释写明旧条目没有它们。
- 对本项目:
  - 1.1.0 落库的条目会多这一格。旧条目在 1.1.0 上照常重建(读路径逐字相同)。
  - 它不进请求正文:1.1.0 的 pi-ai 里只有 `event-stream.js` 读写 `durationMs`,三种协议的请求构造都不碰它(`grep -rl durationMs ai/`)。
  - 回滚到 1.0.1 时,带这一格的新条目同样能重建:1.0.1 的 pi-ai 不认识它,请求构造按字段挑,不会带出去。这一句只读了代码,没有实跑「1.1.0 产出、1.0.1 重建」。

### 1.5 `tools` 允许清单(问题:subagents_enable 是否仍被滤掉)

1.1.0 的 `tools` 选项从「精确名字的集合」改成三种写法:

- 普通名字或带 `*` 的模式,作允许清单(`ca/core/sdk.d.ts:35-47`)。判定改用 `createToolNameMatcher`(`ca/core/mcp-servers.js:19-23`):不含 `*` 的条目仍按精确名字比。
- 全是 `+name` / `-name` 的清单,在默认工具上加减(`ca/core/settings-manager.js:37-73`)。
- 两种混写直接抛错(`ca/core/sdk.js:145-147`)。

另一处变化:允许清单非空、又不含 `mcp__` 条目时,MCP 工具名也算「允许注册」(`ca/core/agent-session.js:1118-1124`),但只有 `tool_search` 存在时才可激活(`:1131-1135`)。

对本项目:

- 五条链路传的清单都是普通工具名(`worker.ts:778`、`session-worker.ts:340`、`rule-worker.ts:668`、`merge-worker.ts:241`,入口 `worker-tools.ts:514`)。名字里没有 `*`,也不以 `+` / `-` 开头(`grep -rnE 'name: "[+-]|name: "[^"]*\*' src/reviewer` 为空),`getToolListError` 返回空,判定与 1.0.1 相同。
- `subagents_enable` 不是 MCP 名字,仍被 `_isAllowedTool` 滤掉。`reviewer-evidence-session.test.ts:147` 的断言通过。
- SDK 会话不加载 MCP(第 1.6 节),没有 MCP 工具可以借上面那条新规则漏进来。

### 1.6 内建扩展、skill 扫描、系统提示

- 内建扩展仍只在 CLI 入口注入(`ca/main.js:38,451`)。根入口逐字相同,不导出它们。`DefaultResourceLoader` 仍只从调用方给的 `extensionFactories` 里挑 `builtin: true` 的项(`ca/core/resource-loader.js:62-64`)。本项目总是自己给 `resourceLoader`(`worker-tools.ts:516`)。MCP、codemode、tool search 都不启用,`mcp.json` 不被读。
- 默认 skill 扫描仍由 `noSkills: true` 关掉(`worker-tools.ts:467`)。
- 系统提示:`buildSystemPromptSections` 多一个 `hiddenTools` 入参(`ca/core/system-prompt.js:14,70,76`),来自 `prepareLoadout` 的隐藏声明(`ca/core/agent-session.js:1288`)。本项目不用 `prepareLoadout`,隐藏集为空,`declaredTools` 等于 `selectedTools`。`customPrompt` 分支仍是整段替换前言(`:78-80`)。skill 提示只在 `read` 被隐藏时换措辞(`:101-104`),本项目的 `read` 不隐藏。
- 环境变量:按包 grep 变量名,只多一个 `PI_PROGRAM_STATUS`(pi-coding-agent 与 pi-tui,交互模式的 OSC 7501 状态上报,`ca/modes/interactive/program-status-reporter.js`)。它不命中 `src/reviewer/env.ts:8` 的凭据正则,也不需要命中。pi-ai 的变量名集合两版相同。

### 1.7 模型目录、compat 与调用目标(ADR 0027)

脚本对比两版 `ai/providers/data/*.json`(42 个文件,`azure-openai-responses.json` 换成 `azure.json`):

- 模型 1615 → 1650(chat 1536 → 1563,classifier 20 → 26,image 59 → 61)。
- **compat 键 29 → 29,零增零删。模型行字段 20 → 20,零增零删。**`gatewayCompat`(`src/reviewer/model-service-runtime.ts:294-304`)不用改。
- 带 `supportsMidConvoToolChanges` 的 6 → 7,`supportsMidConvoSystemMessages` 85 → 88,`supportsMidConvoEffort` 7 → 9。新增的都是 `claude-haiku-5-5` 一类新行。自定义服务的这两位已被 `gatewayCompat` 剥掉。
- 本项目常用的五行逐字相同(`JSON.stringify` 比对):`anthropic:claude-opus-5-5`、`anthropic:claude-sonnet-5-5`、`openai:gpt-6-sol`、`openai:gpt-6.1-sol`、`deepseek:deepseek-flash`。
- 新增 87 行、删除 52 行。删除里 44 行是 `azure-openai-responses:*`(以 `azure:*` 重新出现,另加一个 `azure:deepseek-v4-pro`),其余 8 行是 opencode-go、openrouter、vercel-ai-gateway 的个别型号。本项目的测试夹具与文档都不引用它们。
- **两版共有的模型里调用目标变了的有 2 个**:`opencode-go:qwen3.7-plus` 与 `opencode-go:qwen3.8-max`,从 `openai-completions` + `https://opencode.ai/zen/go/v1` 换成 `anthropic-messages` + `https://opencode.ai/zen/go`。按 ADR 0027,已存版本的绑定不随升级改;刷新目录后这两行的新目标在当前版本里是「调用目标未经验证」,要重新验证。
- **`azure` 改名的两种影响**(未查部署实例的库,不知道实例上有没有):
  - 叫 `azure` 的自定义服务会被判名字冲突而停用:`conflictingBuiltinProviderNames` 用 Pi 当前的内置 provider 列表判(`src/webhook/server.ts:4109-4127`,列表来自 `catalog.ts:262` 的 `getProviders()`)。
  - provider 为 `azure-openai-responses` 的内置服务,在 1.1.0 的内置表里已没有这个 provider。协议名 `azure-openai-responses` 仍在(`ai/providers/azure.js:41`),已绑定的目标照旧可调;刷新目录会怎样,未验证。
- 字段变化:单价 189 行,最大输出 14 行,上下文窗口 13 行,`input` / `thinkingLevelMap` / `inputLimits` 各 3 行,`api` 与 `baseUrl` 各 2 行(即上面两行),`compat` 2 行,名称 1 行。

### 1.8 pi-ai 请求层

`ai/api/anthropic-messages.js`、`ai/api/openai-responses-shared.js`、`ai/utils/overflow.js` 两版逐字相同(`cmp`)。改动的请求相关文件:

- **`ai/api/simple-options.js`**:
  - 新函数 `resolveSamplingParams`(`:11-17`):按思考档位合并 `model.samplingParams`、`model.samplingParamsByThinkingLevel` 与请求级参数。三者都没有时返回 undefined,不往正文里写东西。本项目注册的模型三者都没有。
  - `clampMaxTokensToContext`(`:5-10`)本身没改,它调的 `estimateContextTokens` 改了常数(下一条)。
- **`ai/utils/estimate.js:2`**:`CHARS_PER_TOKEN` 4 → 3.5。估算只用在「最后一条带用量的助手消息之后」的那几条消息上,以及首个请求的整段上下文(`:74-89`)。输出上限 = min(模型 `maxTokens`,上下文窗口 − 估算 − 4096)。估算变大,上限只会变小,而且只在上下文接近窗口时才出现差别。Pi 自己的压缩判定在 `ca/core/compaction/` 里,用的是自己的 `/ 4`(`compaction.js:215,219`),那个目录逐字相同,压缩时机不变。
- **`ai/api/openai-completions.js:747-751`、`ai/api/openai-responses.js:286-290`**:采样参数改经 `resolveSamplingParams`。`openai-responses.js:266-271` 把推理档位的取值收进一个变量,判定与 1.0.1 等价。
- **`ai/utils/provider-retry.js:89-90`**:多一个可选的 `noRetryStatuses`。

**探针实测。**同一份上下文(一段系统提示、两件工具、一条用户消息,`reasoning: "medium"`,`maxRetries: 0`),两版各发 5 种请求,diff 两份记录:

| 场景 | 两版差别 |
|---|---|
| anthropic-messages,目录原样的 compat(内置服务的情形),`claude-opus-5-5` | 逐字相同(头与正文) |
| anthropic-messages,`gatewayCompat` 之后的 compat(自定义服务的情形) | 逐字相同 |
| openai-responses,`gpt-6-sol` | 逐字相同 |
| openai-completions,`deepseek-flash` | 逐字相同 |
| openai-completions,运行基线模型(上下文 128000、输出 16384)、首条消息 40 万字符 | `max_completion_tokens` 16384 → 9618。其余逐字相同 |

请求地址两版相同:`/v1/messages?beta=true`、`/v1/responses`、`/v1/chat/completions`。前四种场景的输出上限两版都等于模型 `maxTokens`(128000 / 128000 / 128000 / 384000)。探针脚本只在临时目录里跑过,没有进仓库。

对本项目:Reviewer 一批的首个请求带整份 diff 与历史,上下文窗口小的模型(运行基线 128k)在大批次上会拿到更小的输出上限。上限仍够不够写完一轮回复,取决于批次大小,没有用线上批次实测。

## 2. pi-subagents 0.76.1

### 2.1 CHANGELOG 逐条

0.76.0 的 Added 1 条、Changed 1 条、Fixed 16 条,0.76.1 的 Changed 1 条、Fixed 8 条。按与本项目的关系分组:

| 条目 | 判定 | 依据 |
|---|---|---|
| 0.76.1:子会话系统提示改为 Pi 的提示在前 | 走得到,内容不变 | 见第 2.2 节 |
| 0.76.0:子会话超时或崩溃时把写到一半的文字交回,结果带 `outputPartial: true` | 走得到,只影响失败那一趟的结论文字 | `ps/runs/foreground/execution.js:1477-1488`。run 照旧判失败。本项目会话子代理的结论取 `finalOutput`,失败时取 `error`(`src/reviewer/session-subagent.ts:186`);取证只读 transcript(`evidence.ts:515-523`)。超时那一趟的结论文字可能多一段 `Partial output before timeout:`,没有实测 |
| 0.76.1:按工具超时停下时报的是工具超时 | 走得到,只改报错文字 | `ps/runs/foreground/execution.js:1132-1135,1189-1193,1490`。`reviewer-evidence-session` 的超时用例通过 |
| 0.76.1:空闲父会话被子代理结果唤醒时补一条 `Subagent updates above.` | 不受影响 | 新文件 `ps/shared/parent-wake.js`。只在 `sendMessage` 带 `triggerTurn: true` 且父会话空闲时发(`:13-27`),来源是后台结果、监督请求与等待订阅(`ps/extension/index.js:308-329,761,768`)。本项目一律前台,前台控制通知仍在 `ps/extension/control-notices.js` 直接返回(该文件逐字相同) |
| 0.76.0:headless 会话在回合结束前把后台结果交给 Pi | 走得到代码,无效果 | `agent_end` 多调一次 `resultWatcher.deliverPendingResults`(`ps/extension/index.js:719`)。它只扫结果目录里已有的后台结果文件(`ps/runs/background/result-watcher.js:646-660`),前台不产这种文件。这一句只读了代码 |
| 0.76.0:`outputSchema` 子会话的结构化结果写进输出文件 | 不受影响 | 本项目的 agent 不写 `outputSchema` 与 `output` |
| 0.76.0:`settings.json.write-lock` | 不受影响 | 只在保存 agent 覆盖、加载 profile、改 Watchdog 设置时加锁(`ps/agents/agents.js:11`)。都是管理动作,`action` 被剥 |
| 0.76.0:定时任务按日 / 周、`worktree.cleanup` 可执行已审过的计划 | 不受影响,只影响声明 | 管理动作。schema 只改这几格的描述(`ps/extension/schemas.js:158-187`) |
| 0.76.0:`capacity.abandonedSlotReleaseAfterMs` | 不受影响 | 后台 workflow 的配额回收 |
| 0.76.1:`/reload` 期间升级报错 | 不受影响 | 包根 `index.js:9-12` 加载时比对已装版本与已加载版本。本项目每个子进程只加载一次 |
| 0.76.1:`subagent doctor` 读同一配额池 | 不受影响 | 只改 doctor 的读数(`ps/runs/foreground/subagent-executor.js` 约 `:6436-6472`)。启动派单的配额读法没变 |
| 其余:内建 MCP 名字里的 `-`/`_`、`workflow: true` 找脚本、多行描述存 YAML、async 小部件、Watchdog、Windows 文件 id、Herdr、定时任务的锁 | 不受影响 | MCP 选择器只在 agent 的 `tools` 有 `mcp:` 项时走到(`ps/runs/shared/child-session.js:146-170`);`workflow` 与 `action` 被放行清单剥掉;其余是后台、UI 或别的平台 |

### 2.2 子会话系统提示的顺序

`rewriteSubagentPrompt`(`ps/runs/shared/subagent-prompt-runtime.js:189-206`)原来返回「边界说明 + 结构化说明 + 改写后的提示」,现在是「改写后的提示 + 边界说明 + 结构化说明」。上游的理由是有的 provider 和扩展按 Pi 默认提示的第一句识别它(CHANGELOG 0.76.1 Fixed 第 4 条,#2692)。

本项目的取证与会话子代理都写 `systemPromptMode: replace`(`src/reviewer/evidence.ts:232`、`src/reviewer/session-subagent.ts:65`)。改写后的提示开头是我们的 agent 定义正文,边界说明(`CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS`,`:28-34`,原文未改)挪到末尾。说给模型的内容不变。`reviewer-evidence-session` 与 `agent-session-subprocess` 里对子会话系统提示的断言都通过。

### 2.3 依赖点对照表

逐字相同(`cmp`)的文件:`ps/api/capability-ceiling.js`、`ps/runs/shared/capability-ceiling.js`、`ps/shared/child-transcript.js`、`ps/extension/tool-result.js`、`ps/intercom/intercom-bridge.js`、`ps/extension/tool-activation.js`、`ps/shared/disabled-features.js`、`ps/shared/extension-context.js`、`ps/runs/shared/child-launch.js`、`ps/runs/shared/tool-timeout.js`、`ps/runs/shared/pi-spawn.js`、`ps/shared/utils.js`、`ps/extension/public-execution.js`、`ps/extension/config.js`、`ps/shared/types.js`、`ps/runs/shared/child-tool-plan.js`、`ps/extension/control-notices.js`、`ps/runs/shared/subagent-control.js`。`agents/`、`skills/`、`prompts/` 三个目录 `diff -rq` 无差异。

| 本项目依赖点 | 本项目位置 | 0.76.1 的情况 | 结论 |
|---|---|---|---|
| `subagents_enable` 靠 `tools` 允许清单滤掉 | `worker.ts:778`、`session-worker.ts:340` | `ps/extension/tool-activation.js` 逐字相同;Pi 侧判定见第 1.5 节 | 仍被滤掉,`reviewer-evidence-session.test.ts:147` 通过 |
| 能力天花板 | `evidence.ts:51,136` | 两个 `capability-ceiling.js` 逐字相同,`exports` 仍有这一项(`package.json`) | 不受影响 |
| `config.json`(`asyncByDefault: false`、`intercomBridge.mode: "off"`) | `evidence.ts:305` | `ps/extension/config.js` 逐字相同 | 不受影响 |
| `pinSubagentCall` 放行清单与钉死的四格 | `evidence.ts:367-380`(`maxRuntimeMs` 在 `:374`) | schema 的 diff 只在 `repo` / `planId` / `mode` / `at` / `every` / `on` / `timezone` / `catchUp` 的描述与 `on` 的类型(`ps/extension/schemas.js:158-187`),都不在放行清单里。顶层参数仍是 81 个 | 不受影响 |
| 工具描述仍要求先 list | 系统提示 `worker.ts:93`、`session-worker.ts:182` | `AGENT_SELECTION_GUIDANCE` 仍以 'First call {action:"list",capabilities:true}' 开头(`ps/extension/tool-description.js:7`) | 两处系统提示里那句仍然需要 |
| transcript | `evidence.ts:515-523`、`session-subagent.ts` | `ps/shared/child-transcript.js` 逐字相同 | 不受影响 |
| 用量并入父会话 | `evidence.ts:35-37` | `ps/extension/tool-result.js` 逐字相同 | 不受影响 |
| 取证上限与扇出上限 | `evidence.ts:78-79,316-318` | 读法在 `ps/shared/types.js`,逐字相同 | 不受影响 |
| 父子通话工具 | `evidence.ts:305,355` | `ps/intercom/intercom-bridge.js` 逐字相同 | 不受影响 |
| 子会话工具面是只读四件套 | `evidence.ts:227`、`session-subagent.ts:60` | `child-launch.js` 与 `child-tool-plan.js` 逐字相同;`child-session.js` 只改 MCP 选择器 | 不受影响 |
| agent 定义 frontmatter | `evidence.ts:225-237`、`session-subagent.ts:58-70` | 两版 `ps/agents/agents.js` 对 `frontmatter.` 的引用逐行相同 | 不受影响 |
| peer 与 typebox | — | `peerDependencies` 与 0.75.0 相同:pi-ai `>=0.86.1`,其余 `*`,全部可选。lockfile 里 `typebox` 仍解析到项目根的 1.3.11(`pi-subagents@0.76.1(…)(typebox@1.3.11)`) | 不受影响 |

### 2.4 工具声明体积

description 加 `JSON.stringify(schema)` 的字符数,默认配置:

| | description | schema | 合计 |
|---|---|---|---|
| 0.75.0 | 5,497 | 13,005 | 18,502 |
| 0.76.1 | 5,497 | 12,982 | 18,479 |
| 差 | 0 | −23 | −23 |

差额来自几处管理参数的描述缩短(`ps/extension/schemas.js:158-187`)。0.75.0 的数与上一份笔记一致(`docs/research/pi-subagents-0.75-2026-10-04.md` 第 3 节)。

### 2.5 联网与文件写入

新增的运行时依赖是 `@js-temporal/polyfill`(第 1.2 节)。新增的文件写入在 settings 锁、定时任务锁、worktree 清理里,都需要管理动作或后台执行才走到。前台单次取证没有新的联网点。这一节只读了 CHANGELOG 与上面列出的 diff,没有像上一份笔记那样对全部新增行 grep。

## 3. pnpm 发布年龄窗口

实测时刻 2026-10-09T23:15Z。

- **不再需要豁免。**删掉 `pnpm-workspace.yaml` 里那段注释与 8 行 `minimumReleaseAgeExclude` 之后,`npx -y pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 通过:`✓ Lockfile passes supply-chain policies (742 entries in 2s)`。这一次是重新校验,没有走缓存。
- 对照:同一份 lockfile 临时加 `minimumReleaseAge: 4320`(3 天),同一条命令拒装,报 `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 8 lockfile entries failed verification`,首两项是 `@earendil-works/chord@1.1.0` 与 `@earendil-works/pi-agent-core@1.1.0`。说明校验确实在跑,默认 24 小时窗口下 8 个 1.1.0 包都已放行。pi-subagents 0.76.1 与两个新增包不在这 8 项里。
- 不删豁免时,同一条命令也通过(`verified 8m ago`)。那 8 行钉的是 `@1.0.1`,树里已经没有它们,留着是死配置。
- **本机 pnpm 12.10.1 这次没有改写 `pnpm-workspace.yaml`**:`pnpm install` 与 `pnpm update` 之后它与原文件相同(`diff` 为空)。pnpm 11.21 的那两次校验也没有改写它。
- 建议的写法:删掉第 11–17 行的注释与第 18–26 行的清单,文件只剩 `packages` 与 `allowBuilds` 两段。注释里「0.68 起 pi-subagents 不再捆绑 pi-server」那一句仍然成立,但它只是给豁免清单作的说明,清单没了就一起删;这一事实在根 `AGENTS.md` 技术栈段里已有。下次升级碰上发布不满 24 小时的版本时,照 2026-10-04 那一版的写法重新加。

## 4. 试装结果

环境:`git worktree add --detach … main`(`a938bd5`),`package.json` 两行改成 `^1.1.0` 与 `0.76.1`。pnpm 12.10.1,Node 24。

- `pnpm install` 一次成功。之后 `pnpm update "@earendil-works/*"` 不改 lockfile。lockfile 变化见第 1.2 节。
- `pnpm typecheck`(`tsc --noEmit`):退出码 0,无输出。源码零改动。

测试(`MULTIREVIEWER_TEST_DATABASE_URL` 指本机 54329,容器 `multireviewer-postgres-1` 在跑;逐文件 `node --test`,退出码全部为 0):

| 文件 | 用例 | 耗时 |
|---|---|---|
| `reviewer-evidence-session` | 14 / 14 | 21 秒 |
| `agent-session-subprocess` | 12 / 12 | 39 秒 |
| `reviewer-verdict-nudge` | 6 / 6 | 6 秒 |
| `model-service-runtime` | 15 / 15 | 1 秒 |

合计 4 个文件 47 条,0 失败,0 跳过。没有跑全量 `pnpm check`,没有跑 `MULTIREVIEWER_SMOKE_*` 的真模型契约。上一份笔记跑过的另外 19 个文件(`agent-session-rebuild`、`reviewer-evidence` 等)这次没跑。

## 5. 升级要改的位置

1. `package.json:22`:`^1.0.1` → `^1.1.0`;`package.json:25`:`0.75.0` → `0.76.1`。
2. `pnpm install`,再 `pnpm update "@earendil-works/*"`。确认 lockfile 里没有 `@earendil-works/*@1.0.1` 与 `pi-subagents@0.75.0` 的键。
3. `pnpm-workspace.yaml`:删第 11–26 行(豁免注释与清单),见第 3 节。用 `npx -y pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 再验一次。
4. 源码不改。
5. 根 `AGENTS.md`:
   - 技术栈段(第 11 行)「当前钉在 Pi 1.0.1 与 pi-subagents 0.75.0」改成 1.1.0 与 0.76.1。同段其余句子仍然成立。运行时第三方依赖仍是五个直接依赖;pi-subagents 多带一个传递依赖 `@js-temporal/polyfill`,不改这个数。
   - 变更日志加一条。要点:源码未改;会话条目多可选 `durationMs`,版本仍是 3;token 估算改 3.5 字符,长上下文里输出上限变小;`tools` 改模式匹配,本项目工具名不受影响;目录 compat 零增减,`azure` 改名与 `opencode-go` 两行换目标;pi-subagents 子会话提示的边界说明挪到末尾;豁免清单删除。
6. `src/AGENTS.md` 变更日志加一条,内容同上的缩写。
7. 发版前跑一次全量 `pnpm check`。
8. 发版后在部署实例上:
   - 各跑一轮带取证的 Review Run 与一次 Agent 会话续谈(续谈一个升级前建的会话)。
   - 查库里有没有 provider 为 `azure`(自定义)、`azure-openai-responses` 或 `opencode-go` 的模型服务。有的话按第 1.7 节处理。

## 建议

**值得做**

- 升到 Pi 1.1.0 与 pi-subagents 0.76.1,同一次发版。理由:源码零改动;会话条目读路径、SDK 入口、四件套、资源加载器、天花板、transcript 这些依赖点所在的文件逐字相同或只有不触及本项目的新增;四个测试文件全过;自定义服务三种协议的请求经探针确认只在长上下文时 `max_tokens` 有差别。
- 同时删掉 `pnpm-workspace.yaml` 的豁免清单。理由:它钉的版本已不在树里;两个新版都已过窗口,pnpm 11.21 的重新校验通过。

**可选**

- 用一个大批次的线上 Review Run 看一眼输出上限。理由:`max_tokens` 变小只在上下文窗口小、批次大时出现(第 1.8 节),自动化测试用的假模型覆盖不到。代价是读一轮的审查轨迹。
- 用 `tool_execution_end` 新带的 `durationMs` 取代 `trace-events.ts:220` 自己算的耗时。理由:它是 Pi 用单调时钟量的 `execute()` 时长,比我们从事件到达时刻算的准。这是一处改进,与升级本身无关,另开一票。

**不做**

- 在 `gatewayCompat` 里多剥 compat 键。理由:compat 键集合零增减,新增带 `supportsMidConvo*` 的只是新型号,剥法照旧覆盖。
- 为 `durationMs` 写「1.1.0 产出条目、1.0.1 重建」的夹具。理由:两版的 `session-manager.js` 逐字相同,字段是可选的,且不进请求正文(第 1.4 节)。部署实例上续谈一个旧会话就是读路径的真实验证。
