# Pi 0.87.1 → 0.99.1 跟进(2026-09-30)

当前钉法:`@earendil-works/pi-coding-agent ^0.87.1`、`pi-subagents 0.71.0`(`package.json:22,25`)。npm 上的版本:0.99.0(2026-09-29T17:21Z)与 0.99.1(2026-09-29T18:23:26Z),两者之间与 0.87.1 之后没有 0.88–0.98(`npm view @earendil-works/pi-coding-agent time`)。

来源:`npm pack` 取 0.87.1 与 0.99.1 两版的 pi-coding-agent、pi-ai、pi-agent-core,逐文件 diff `dist/`;pi-coding-agent 包内 `CHANGELOG.md`(0.99.0 / 0.99.1 两节);GitHub release [v0.99.0](https://github.com/earendil-works/pi/releases/tag/v0.99.0);pi-ai 与 pi-agent-core 包内不带 CHANGELOG,取自 tag `v0.99.1` 的 `packages/{ai,agent}/CHANGELOG.md`。**实跑过**:在一次性 worktree 里把 Pi 钉到 0.99.1,`pnpm typecheck` 加 12 个与 Pi 相关的测试文件(见文末)。pi-subagents 由另一份调研负责,本文只记 Pi 这边会影响它的改动。

下文 `ca/` = `pi-coding-agent/dist/`,`ai/` = `pi-ai/dist/`,`core/` = `pi-agent-core/dist/`,行号均指 0.99.1。

## 结论

能升,改动量小:源码一处类型修正(`src/reviewer/model-runtime.ts:12-14`),外加 `package.json` 一行、`pnpm-workspace.yaml` 豁免清单、lockfile。typecheck 修完即过;取证与 Agent 会话的真实 SDK 回归全过。0.99 的大功能(MCP、codemode、tool search、virtual models、分类器与出图模型)在本项目的 SDK 用法下都不激活。

## 依赖树

- pi-coding-agent 的 `dependencies` 多三项:`@earendil-works/pi-codemode ^0.99.1`、`@earendil-works/pi-mcp ^0.99.1`、`quickjs-wasi 3.6.2`(两版 `package.json` diff)。pi-ai 把 `openai` 从 6.40.0 升到 7.19.0。`npm-shrinkwrap.json` 从 144 项变 147 项,净增正是 pi-codemode、pi-mcp、quickjs-wasi。
- 实装后 lockfile 的 `packages:` 段:8 个 earendil 包换成 0.99.1,新增 pi-codemode、pi-mcp、quickjs-wasi,`openai` 换成 7.19.0,别的包一项未增减(worktree 里 `git show main:pnpm-lock.yaml` 对比)。
- 三个新包都不带原生二进制:quickjs-wasi 是 1.5 MB 的 `quickjs.wasm`,无依赖;pi-mcp 532 KB,唯一依赖 `cross-spawn`(树里已有);pi-codemode 292 KB,唯一依赖 quickjs-wasi。三者 MIT。镜像体积增量约 2.3 MB。
- **本项目直接运行时依赖仍是五个**(Pi、typebox、pi-subagents、drizzle-orm、pg),`AGENTS.md` 技术栈那句不用改计数,只改版本号。
- `engines.node` 三个包都是 `>=22.19.0`,本项目要求 `>=24.7.0`(`package.json:7`),兼容。

### 根入口会不会加载新包、会不会联网

- `ca/index.js:34-36` 新增三条再导出:`createCodemodeExtension`、`createMcpExtension`、`createToolSearchExtension`。因此 `import "@earendil-works/pi-coding-agent"` 会**静态加载** `@earendil-works/pi-mcp`(`ca/extensions/mcp/tools.js:16`)与 `@earendil-works/pi-codemode/declarations`、`/source`(`ca/extensions/codemode/tool.js:23-24`)。quickjs-wasi 与 MCP 运行时是懒加载的(`ca/extensions/codemode/execute.lazy.js:2`、`ca/extensions/mcp/runtime.lazy.js:2`)。加载本身不发请求。
- 实测根入口 import 耗时:0.87.1 为 0.41–0.76 s,0.99.1 为 0.44–0.46 s(各三次,冷热混合),无可见差异。
- **内建扩展(mcp / codemode / tool-search / llama.cpp)在本项目的会话里不会启用。**内建列表 `builtInExtensions` 只在 CLI 入口 `ca/main.js:445` 注入;根入口不导出它。`DefaultResourceLoader` 只从调用方传入的 `extensionFactories` 里挑 `builtin: true` 的项作内建(`ca/core/resource-loader.js:245-246`),本项目传入的都是自己的 InlineExtension(`src/reviewer/worker-tools.ts:472-474`)。`createAgentSession` 只有在调用方不给 `resourceLoader` 时才自建一个(`ca/core/sdk.js:77-78`),本项目总是给(`src/reviewer/worker-tools.ts:516`)。所以 `mcp.json` 不会被读,也不会拉起 MCP 子进程。
- llama.cpp 在 0.87.1 也已是内建扩展(`0.87.1 ca/extensions/index.js`),本项目一直没有加载它,这次没有变化。

## 本项目对 Pi 的依赖点与逐项对照

Pi 的 import 只在 `src/reviewer/` 下 15 个文件里(`grep -rn "@earendil-works" src`),test 目录不直接 import Pi。

### 会话创建与 SDK 入口

| 本项目调用点 | 0.99.1 的变化 | 结论 |
|---|---|---|
| `createAgentSession({ cwd, agentDir, model, thinkingLevel, modelRuntime, tools, customTools, resourceLoader, sessionManager, settingsManager })`(`worker-tools.ts:508-525`) | `sdk.d.ts` 只改了一处注释;默认工具名改由 `DEFAULT_TOOL_NAMES` 常量给出,值仍是 `read/bash/edit/write`(`ca/core/settings-manager.js:35`)。本项目总传 `tools`(`worker.ts:778`、`session-worker.ts:340`),不走默认值 | 不受影响 |
| `DefaultResourceLoader({ noSkills, additionalSkillPaths, additionalExtensionPaths, extensionFactories, systemPromptOverride })`(`worker-tools.ts:463-476`) | 构造参数无变化;新增宿主包依赖检查、内建扩展分流、同名可替换扩展的剔除(`resource-loader.js` diff) | 不受影响,见上一节 |
| `SettingsManager.inMemory({ compaction, retry })`(`worker-tools.ts:459-462`) | 新增 `codemode`、`deviceId` 等字段,没删字段 | 不受影响 |
| `session.prompt(text, { images })`、`session.steer()` / `followUp()`(`session-worker.ts:438-445`) | `steer` / `followUp` 返回值从 `Promise<void>` 变成 `Promise<QueuedInputDisposition>`(`ca/core/agent-session.d.ts:514,525`) | 本项目只 `await`、不读返回值,不受影响 |
| `session.messages`、`session.agent.state.errorMessage`、`getSessionStats().tokens`(`worker-tools.ts:377-383,583-590`) | 签名未变 | 不受影响 |

### AgentSession 事件与扩展事件

- 本项目订阅的会话事件:`message_end`、`message_update`(text_delta)、`tool_execution_start/update/end`、`auto_retry_start/end`、`compaction_end`、`queue_update`(`trace-events.ts:111-199`、`session-worker.ts:360-398`)。0.99 只给 `tool_execution_*` 加了可选的 `parentToolCallId`(`ca/core/agent-session.d.ts:40-49`),只有经 `ctx.executeTool()` 发起的嵌套调用才带它;本项目不注册 codemode,这一格恒不出现。
- 扩展钩子:`agent_before_settle`(`worker.ts:603`)与 `tool_call`(`evidence.ts:484`)的事件与返回类型在 `extensions/types.d.ts` diff 里没有改动;`tool_call` 事件只多一个可选 `parentToolCallId`。
- `ToolDefinition.execute` 的第五个参数从 `ExtensionContext` 换成它的子类型 `ExtensionToolContext`(多 `tools` 与 `executeTool()`),本项目的工具不读 ctx,不受影响。
- 新增 `exposure` / `defaultActive` 等工具字段,缺省 `direct`,注册即激活,与 0.87 的行为一致(`ca/core/agent-session.js` 的 `_isActivatedOnRegistration`)。

### 会话管理器与条目格式(ADR 0031)

- `CURRENT_SESSION_VERSION` 两版都是 3;`SessionManager.inMemory` 签名未变;`session-manager.js` 的差异只有两处:文件型会话在「有用户或 assistant 消息」时才落盘(#10000),以及新增 `getEntryCount()`。本项目用内存会话、按 `getEntries()` 镜像(`session-worker.ts:255`),不受影响。
- **记录里的条目多出几格可选字段**:assistant 消息多 `thinkingLevel`(`core/agent-loop.js:277`;pi-agent-core CHANGELOG 0.99.0 Added);工具结果可以带 `structuredContent` 与 `isError`(`core/types.d.ts` diff),经 `executeTool()` 的嵌套调用会写进调用方结果的 `nestedCalls`。ADR 0031 原样存条目,多几格不影响落库;面板按 `type` 与 `role` 分支(见 2026-09-23 笔记),重建时原样喂回。
- compaction 那段代码为 virtual model 重构过,阈值判定与压缩条目形状对本项目无可见变化(`ca/core/compaction/compaction.js` 只把 `combineUsage` 挪到公共模块)。

### 内建工具与 fd / ripgrep

`ca/core/tools/{read,grep,find,ls}.js` 与各自的 `.d.ts` 两版逐字相同,fd 与 ripgrep 的调用参数没变。`createFind/Grep/LsToolDefinition`(`worker-tools.ts:17-19`)与 `defineTool` 签名不变;`wrapToolDefinition` 只改了 ctx 工厂的形状(`tool-definition-wrapper.d.ts`)。同名覆盖 read/grep/find/ls 的做法照旧成立。0.99.0 新增的「扩展注册同名工具顶掉内建扩展」告警只针对 `replaceable` 的内建扩展(`resource-loader.js` 的 `omitReplacedExtensions`),不涉及内建工具。

### 模型目录、compat 与调用目标

- **破坏性类型变更,本项目唯一一处编译错误**:`ProviderModelConfig` 从单一接口变成联合 `ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig`(`ca/core/extensions/types.d.ts:1466`;pi-ai CHANGELOG 0.99.0 Breaking Changes 第二、三条)。`thinkingLevelMap` 与 `compat` 只在 chat 那一支上,`src/reviewer/model-runtime.ts:22-23` 的索引访问因此报错。改法见文末。运行时照旧:`registerProvider` 的模型不写 `type` 即按 chat 处理(`ai/utils/model-operations.js:3-5` 的 `getModelType` 缺省 `"chat"`)。
- **compat 键零增零删**。脚本对比两版 `ai/providers/data/*.json` 的全部模型(1495 → 1535 个),compat 键集合相同。`gatewayCompat` 剥的两位(`supportsMidConvoEffort`、`supportsMidConvoSystemMessages`,`model-service-runtime.ts:294-306`)不用增减。`supportsStrictMode` 在 openai-completions 模型里的分布从 true/false/缺省 = 636/49/20 变成 647/47/20,2026-09-23 那次的判断不变。
- **模型行多一个 `type` 字段**(全部数据行都带;无别的字段增删)。`provider.getModels()` 与 `getModel()` 只返回 chat 模型(`ca/core/remote-catalog-provider.js:58`;CHANGELOG「Chat-facing reads … are unchanged」)。`catalog.ts:152`、`piBuiltinProviderTargets`(`catalog.ts` 的 `provider.getModels()`)因此读到的集合与 0.87 同口径。
- **调用目标(ADR 0027)无变化**:两版共有的模型里,`api` 或 `baseUrl` 变了的是 0 个(同一脚本)。已存服务的目标绑定不会因升级改判。
- **目录 id**:新增 71 个,删除 31 个。与本项目常用 provider 相关的新增:`anthropic:claude-sonnet-5-5`(1M 上下文、adaptive thinking)、`openai:gpt-6.1-sol` 与 `openai-codex:gpt-6.1-sol`、`openrouter` 的若干新行(含分类器 `~typesafe/jev-latest`、`typesafe/jev-1.13`)。删除集中在 fireworks、radius、opencode-go、together 与 openrouter 的几个 free 行。`anthropic:claude-opus-5-5`、`openai:gpt-6-sol`、`deepseek:deepseek-flash` 的 compat、`thinkingLevelMap`、上下文与输出上限都未变。`AGENTS.md:41` 的 smoke 模型名不用改。
- **远程目录与 models-store**:pi.dev 请求多带 `?types=chat,image,classifier`(`ca/core/remote-catalog-provider.js:82`),store 里因此会出现 image 与 classifier 条目,同一个上游 id 可能有 chat 与 image 两条(pi-ai CHANGELOG 0.99.0 Breaking Changes 第三条)。没有 `type` 的条目按 chat 处理,本项目写进去的厂商目录行不用改。**一处边角**:`writeVendorModels` 按 id 摘旧行、不看类型(`catalog.ts:214`),厂商目录补一个 chat 行时,会顺手把 store 里同 id 的 image 条目摘掉。本项目不用出图模型,只影响那份可丢弃的缓存。
- `authPath` / `modelsPath` / `modelsStorePath` 三个构造参数未变(`ca/core/model-runtime.d.ts` diff 只有新增方法),隔离做法照旧。
- **openai-responses 的「Sign in with ChatGPT」分支**:provider 为 `openai`、`baseUrl` 为官方地址、且 key 不以 `sk-` 开头时,请求会丢掉 `max_output_tokens`、`temperature` 与两项 prompt cache 字段(`ai/api/openai-responses.js:23-28,238`)。官方 API key(`sk-proj-` / `sk-svcacct-` 等)都以 `sk-` 开头,本项目不受影响;只有有人在内置 openai 服务里填了非 `sk-` 前缀的 key 才会触发。
- openai-completions 与 openai-responses 现在会把模型级 `samplingParams` 合进请求(`ai/api/openai-completions.js` diff);本项目注册的模型不带这一格,不受影响。

### thinkingLevel / thinkingLevelMap

`ThinkingLevel` 取值未变;`thinkingLevelMap` 仍在 chat 模型配置上(`ca/core/extensions/types.d.ts` 的 `ProviderChatModelConfig`)。agent loop 把请求的档位记在 assistant 消息上(见上)。`sessionThinkingLevel` 与 `supportedThinkingLevels` 不用改。

### 其余

- `resizeImage`(`session-images.ts:77`)、`InlineExtension`(新增可选 `replaceable` / `builtin`,本项目不设)、`SessionManager`、`ModelRuntime` 的现有方法签名均未变或只增不减。
- `ca/core/system-prompt.js` 只在 Pi 默认提示里多提一句 MCP 文档;本项目用 `systemPromptOverride`,不受影响。
- pi-telemetry 0.87.1 → 0.99.1 的 `dist` 差异只有 source map,行为不变。

## pnpm 发布年龄窗口

- 需要豁免。`pnpm@11.21.0`(与 `Dockerfile:10,60` 同一个版本)在不加豁免时 `--frozen-lockfile` 拒装,原文:`@earendil-works/pi-coding-agent@0.99.1 was published at 2026-09-29T18:23:26.245Z, within the minimumReleaseAge cutoff`,pi-mcp、pi-telemetry、pi-tui 等同样被拒。
- 精确清单(8 项):`@earendil-works/chord@0.99.1`、`pi-agent-core@0.99.1`、`pi-ai@0.99.1`、`pi-codemode@0.99.1`、`pi-coding-agent@0.99.1`、`pi-mcp@0.99.1`、`pi-telemetry@0.99.1`、`pi-tui@0.99.1`。`quickjs-wasi@3.6.2`(2026-09-19)与 `openai@7.19.0`(2026-09-18)已过窗口,不用豁免。窗口在 2026-09-30T18:23:26Z 关闭(最晚发布的 pi-coding-agent + 24 小时)。
- 用这 8 行(与现有写法同形,一行一个精确版本)替换现有的 6 行 `@0.87.1` 之后,`pnpm@11.21.0 install --frozen-lockfile` 通过(worktree 实测)。
- **本机 pnpm 是 12.8.1,它会自动改写 `pnpm-workspace.yaml`**:第一次 `pnpm install` 时静默把清单写成 `"@earendil-works/chord@0.87.1 || 0.99.1"` 这种并集形式并追加两个新包。这份写法没在 pnpm 11 上验证过,提交前要改回一行一个版本。
- 与上两次升级相同,只改 `package.json` 再 `pnpm install` 时,pi-subagents 的可选 peer 仍解析到 0.87.1,树里留两套 Pi(worktree 实测 `node_modules/.pnpm` 下同时有 0.87.1 与 0.99.1 的 pi-ai / pi-agent-core / pi-tui);`pnpm update "@earendil-works/*"` 之后 lockfile 里不再有 0.87.1。

## Pi 改动里会影响 pi-subagents 的地方(交给那份调研核对)

- pi-subagents 0.71.0 的 peer 是 `pi-ai >=0.86.1`,其余 `*`,0.99.1 满足范围。
- 它从 Pi 取的符号(`SessionManager`、`convertToLlm`、`createReadOnlyTools`、`getMarkdownTheme`、`keyText`、`DynamicBorder`、`keyHint`、`rawKeyHint`、`getLanguageFromPath`、`highlightCode`、`Agent`,以及若干类型)在 0.99.1 根入口的导出里都还在(`ca/index.d.ts` diff 只有增加)。
- 子会话用的 `ToolDefinition.execute` ctx 类型变了、`tool_call` 事件多 `parentToolCallId`、工具多 `exposure` / `defaultActive`:只要不注册 codemode 或 `deferred` 工具,行为与 0.87 相同。
- 内建扩展只在工厂项带 `builtin: true` 时加载,而 `builtInExtensions` 不在根入口导出;pi-subagents 自建子会话时,需要确认它不会经别的路径把 mcp / codemode 带进子会话。
- `ProviderModelConfig` 改成联合类型:pi-subagents 若在 TS 里读这个类型的 chat 专属字段,同样要收窄。本项目写给子会话的 `<agentDir>/models.json` 是 JSON,不写 `type` 即 chat,不受影响。
- 实测:pi-subagents 0.71.0 跑在 Pi 0.99.1 上,取证契约的真实 SDK 回归 14 条全过(下节)。每个子进程照旧打印一行 `Could not verify the running Pi installation … keeping subagent eagerly available`,0.71.0 在 0.87.1 上已是如此。

## 试装结果

环境:`git worktree add --detach … main`(main 已被主仓库检出,加 `--detach` 取同一提交 `cad1a27`),`package.json` 改 `^0.99.1`,`pnpm install` 后 `pnpm update "@earendil-works/*"`,Node 24。

`pnpm typecheck` 原文:

```
src/reviewer/model-runtime.ts(22,73): error TS2339: Property 'thinkingLevelMap' does not exist on type 'ProviderModelConfig'.
src/reviewer/model-runtime.ts(23,68): error TS2339: Property 'compat' does not exist on type 'ProviderModelConfig'.
```

把 `model-runtime.ts:12-14` 的 `RegisterProviderModel` 改成只取 chat 那一支后,typecheck 通过:

```ts
type RegisterProviderModel = Extract<
  NonNullable<Parameters<ModelRuntime["registerProvider"]>[1]["models"]>[number],
  { type?: "chat" }
>;
```

测试(`MULTIREVIEWER_TEST_DATABASE_URL` 指本机 54329,逐文件 `node --test`),全部通过:

| 文件 | 用例 |
|---|---|
| `reviewer-evidence-session` | 14 / 14 |
| `agent-session-subprocess` | 12 / 12 |
| `agent-session-rebuild` | 17 / 17 |
| `agent-session-purposes` | 11 / 11 |
| `agent-session-reclaim` | 4 / 4 |
| `agent-session-skills` | 6 / 6 |
| `reviewer-subprocess` | 34 / 34 |
| `reviewer-turn-trace` | 2 / 2 |
| `reviewer-verdict-nudge` | 6 / 6 |
| `model-service-runtime` | 15 / 15 |
| `model-service-targets` | 5 / 5 |
| `model-service-catalog` | 1 / 1 |

没有跑全量 `pnpm check`。

## 升级要改的位置

1. `package.json:22`:`^0.87.1` → `^0.99.1`,然后 `pnpm update "@earendil-works/*"` 合并重复副本。
2. `pnpm-workspace.yaml:17-23`:豁免清单换成上面 8 行 `@0.99.1`,一行一个版本;注释 `:12-16` 跟着改。窗口过后这 8 行自然失效。
3. `src/reviewer/model-runtime.ts:12-14`:`RegisterProviderModel` 收窄到 chat 那一支(上面那段)。
4. `AGENTS.md` 技术栈段:「钉在 Pi 0.87.1」改成 0.99.1,并写明根入口会静态加载 pi-mcp 与 pi-codemode、但 SDK 会话不启用内建扩展;变更日志加一条。`src/AGENTS.md` 变更日志同样加一条。
5. 发版前跑一次全量 `pnpm check`。

## 建议

**值得做**
- 升级到 0.99.1。理由:改动量只有一处类型收窄,取证与 Agent 会话回归已过;要在内置 anthropic 服务上用 Claude Sonnet 5.5、在 openai 服务上用 GPT-6.1 Sol,必须升级才有目录行。

**可选**
- `writeVendorModels`(`catalog.ts:214`)按 `type` + `id` 摘旧行,和 Pi 自己的 `mergeModels` 同一口径。理由:远程目录现在会写入 image 条目。改动量:约 3 行加一条用例。本项目不用出图模型,不做也不影响结果。

**不做**
- 显式关掉内建扩展或设 `defaultTools`。理由:SDK 路径下它们本来就不加载,多写一道配置只是假设性防御。
