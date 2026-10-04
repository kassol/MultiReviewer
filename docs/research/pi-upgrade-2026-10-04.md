# Pi 0.99.2 → 1.0.1(跨大版本)、pi-subagents 0.74.0 → 0.75.0 试装(2026-10-04)

当前钉法:`@earendil-works/pi-coding-agent ^0.99.2`、`pi-subagents 0.74.0`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `6f7c885`)。npm 上的发布时刻(`npm view <包> time --json`):

- pi-coding-agent 1.0.0 为 2026-10-01T19:15:22Z,1.0.1 为 2026-10-03T12:35:33Z。
- pi-subagents 0.75.0 为 2026-10-02T20:27:45Z。

来源:

- `npm pack` 取 0.99.2 与 1.0.1 两版的 pi-coding-agent、pi-ai、pi-agent-core、pi-tui、chord、pi-telemetry、pi-mcp、pi-codemode,解包后逐文件 diff(`diff -rq`,去掉 `.map`)。
- 包内 `CHANGELOG.md`:pi-coding-agent 的 `[1.0.0]` 与 `[1.0.1]`,pi-mcp 的 `[1.0.0]` 与 `[1.0.1]`。其余六个包不带 CHANGELOG,以 dist diff 为准。
- 上游 release notes:[pi v1.0.0](https://github.com/earendil-works/pi/releases/tag/v1.0.0)、[pi v1.0.1](https://github.com/earendil-works/pi/releases/tag/v1.0.1)(`gh api repos/earendil-works/pi/releases/tags/<tag>`)。与包内 CHANGELOG 逐行比对,差别只在文档链接写成了绝对地址。
- **实跑过**:一次性 worktree(`6f7c885`)里把两个包钉到新版,`pnpm install`、`pnpm update "@earendil-works/*"`、`tsc --noEmit`,加 23 个测试文件(第 3 节)。
- **请求探针**:一个本机 HTTP 服务记下请求的地址、头与正文,分别用两版 pi-ai 的 `streamSimple` 各发 6 种请求,再 diff 两份记录(第 1.9 节)。
- pi-subagents 0.75.0 的包内差异由 `docs/research/pi-subagents-0.75-2026-10-04.md` 负责,本文只记它在试装里的表现。

下文 `ca/` = `pi-coding-agent/dist/`,`ai/` = `pi-ai/dist/`,`core/` = `pi-agent-core/dist/`,行号均指 1.0.1。

## 结论

能直接升,源码不改。改动只在 `package.json` 两行、`pnpm-workspace.yaml` 豁免清单与 lockfile。typecheck 通过,23 个测试文件 305 条用例全过。

1.0 是版本号上的大版本。对 SDK 使用方,它的破坏性改动只有一处:`@earendil-works/pi-agent-core` 删掉了 harness 整套与 `./node` 等七个子路径(第 1.2 节)。本项目与 pi-coding-agent 都不引用它们。pi-coding-agent 的 CHANGELOG 在 `[1.0.0]` 与 `[1.0.1]` 里都没有 Breaking Changes 段。

要知道的三处行为变化:

1. **Pi 内置 `anthropic` 服务的请求头换了一个 beta 标记**(第 1.9 节)。`mid-conversation-tool-changes-2026-07-01` 换成 `inline-tools-2026-09-15`,六个新型号每次请求都带。自定义模型服务不带这个标记,请求正文两版逐字相同。
2. **Anthropic SDK 从 0.124.0 升到 0.129.0**。探针里可见的差别只有 `x-stainless-package-version` 这一个头的值。
3. **目录删了 15 个模型 id**(第 1.8 节),都不在本项目常用的型号里。

## 1. Pi 1.0.1

### 1.1 CHANGELOG 逐条(问题 1)

`[1.0.0]` 的小节是 New Features / Added / Changed / Fixed,`[1.0.1]` 多一个 Removed(`grep -n "^### "` 两节)。两节都没有 Breaking Changes。

**`[1.0.0]` Changed**

| 条目 | 本项目 |
|---|---|
| 默认 TUI 模式改成全屏(`ca/core/settings-manager.js:951`) | 不受影响。只有交互模式读它,本项目没有 TUI |
| `/login` 加 Radius 入口,取消登录回到上一级菜单 | 不受影响。CLI 交互 |
| provider 文档页改名 | 不受影响 |
| MCP OAuth 凭据改按「服务名 + URL」存 | 不受影响。SDK 会话不加载 MCP(第 1.6 节) |
| codemode 提示缩短约 40% | 不受影响。SDK 会话不加载 codemode |
| codemode 报错给出恢复办法,`typeof tools.name` 探测改用 `"name" in tools` | 不受影响 |
| `/login`、`/logout` 的标签文字 | 不受影响 |
| OAuth 浏览器页换图标 | 不受影响 |

**`[1.0.1]` Changed**

| 条目 | 本项目 |
|---|---|
| 全局 npm 安装的 `pi update` 改为建议迁到托管安装 | 不受影响。本项目不跑 `pi update` |
| Anthropic 会话途中新增或重定义的工具改为内联定义 | 只影响 Pi 内置 `anthropic` 服务上带 `supportsMidConvoToolChanges` 的六个型号。详见第 1.9 节 |

**`[1.0.1]` Removed**

| 条目 | 本项目 |
|---|---|
| 发布包不再带 `npm-shrinkwrap.json` | 不受影响。实装后 lockfile 里第三方包的键只有两处变化(第 1.2 节),没有别的包因此换版 |

**`[1.0.1]` Fixed 里与本项目有关的两条**

- 「Selected model is at capacity」改为可重试(`ai/utils/retry.js:27` 多一条匹配文本 `"model is at capacity"`)。重试事件的形状不变。
- `brace-expansion` 钉到 5.0.12(三个 GHSA)。本项目的 lockfile 要多跑一步才吃得到,见第 1.2 节。

**pi-mcp `[1.0.1]` Breaking Changes**:`OAuthClientProvider.clientMetadataUrl` 换成 `clientMetadataDocument(metadata)`。本项目不 import pi-mcp(`grep -rn "@earendil-works" src/ test/ web/src` 只有 pi-coding-agent),不受影响。

**`engines.node`**:两版都是 `>=22.19.0`(`npm view … engines`)。`legacy-node20` 这个 dist-tag 指向 0.74.2,与本项目无关。镜像是 `node:24-slim`(`Dockerfile:45`)。

### 1.2 依赖树(问题 2)

- pi-coding-agent 的 `dependencies`:七个 `@earendil-works/*` 从 `^0.99.2` 改成 `^1.0.1`,新增直接依赖 `brace-expansion 5.0.12`,其余第三方版本一个没变(`npm view … dependencies` 两版对比)。子包没有拆分、改名或增删。
- pi-ai 的 `@anthropic-ai/sdk` 从 0.124.0 换到 0.129.0(`pi-ai/package.json:70`)。
- **pi-agent-core 瘦身**(1.0.0 起,`npm view @earendil-works/pi-agent-core@1.0.0 exports` 只剩 `.` 与 `./package.json`):
  - 删掉 `dist/harness/`、`dist/search/`、`dist/node.js`。
  - 删掉七个导出子路径:`./node`、`./harness/context`、`./experimental/pico3`、`./harness/env/nodejs`、`./harness/runtime/reducer`、`./harness/session`、`./harness/session/testing`。
  - 根入口只剩 `agent`、`agent-loop`、`proxy`、`setDefaultStreamFn`、`types`(`core/index.d.ts`)。压缩、会话、技能、遥测等再导出全部删掉。
  - 自身依赖从七个减到两个(pi-ai 与 typebox)。装出来的目录从 4960 KB 降到 340 KB(`du -sk`)。
  - `core/agent.js`、`core/agent-loop.js`、`core/types.d.ts` 等其余文件两版逐字相同(`diff -rq` 只报 `index.{js,d.ts}`)。
  - pi-coding-agent 的非 bundle 产物只从根入口 import 它(`grep -rhoE 'from "@earendil-works/pi-agent-core[^"]*"'`,39 处全是根入口)。本项目不 import 它。
  - pi-subagents 0.75.0 只在后台 runner 的别名表里提到 `@earendil-works/pi-agent-core/node`,并标了 `optional: true`(`pi-subagents/src/runs/background/runner-aliases.js:20`)。0.74.0 的同一行没有 `optional`(`:19`)。本项目一律前台执行,走不到这张表。
- 没有新增带原生二进制的包。镜像体积净减约 4.6 MB(pi-agent-core)。
- 实装后 lockfile 的包键(`packages:` 段,740 → 741 个):
  - 换版 10 个:8 个 earendil 包、pi-subagents、`@anthropic-ai/sdk`。
  - 新增 1 个:`brace-expansion@5.0.12`。
  - 没有删除。
- **`brace-expansion@5.0.9` 还留在树里**。`minimatch@10.2.6` 声明 `^5.0.8`,lockfile 沿用旧解析 5.0.9(lockfile 的 `minimatch@10.2.6` 快照)。Pi 把 5.0.12 钉成直接依赖,这只在 npm 的扁平安装下才会顶掉 5.0.9。`pnpm update brace-expansion` 之后 lockfile 里只剩 5.0.12,包键回到 740 个(实跑)。这三个 GHSA 在本项目能不能触发,未验证:没有读 minimatch 在 Pi 里的调用点。

### 1.3 本项目的 import 逐个核对(问题 4)

`grep -rn "@earendil-works" src/ test/ web/src`:import 只在 `src/reviewer/` 下 15 个文件,`test/` 与 `web/src` 没有。`tsc --noEmit` 退出码 0,下表每个符号都还在。

| 符号 | 本项目位置 | 1.0.1 的情况 |
|---|---|---|
| `createAgentSession` | `src/reviewer/worker-tools.ts:508-525` | `ca/core/sdk.js` 与 `sdk.d.ts` 两版逐字相同(`cmp`) |
| `DefaultResourceLoader` | `src/reviewer/worker-tools.ts:463-476` | `ca/core/resource-loader.js` 与 `.d.ts` 逐字相同 |
| `SettingsManager.inMemory` | `src/reviewer/worker-tools.ts:459-462` | 签名不变(`ca/core/settings-manager.d.ts:200`)。diff 只有 `quietStartup` 的类型与 `tuiMode` 的缺省值,本项目只传 `compaction` 与 `retry` |
| `SessionManager.inMemory` | `src/reviewer/worker-tools.ts:517-522` | `ca/core/session-manager.js` 与 `.d.ts` 逐字相同(签名在 `.d.ts:386`) |
| `ModelRuntime`、`registerProvider`、`ModelRuntime.create` | `src/reviewer/model-runtime.ts:4,64,77`、`src/reviewer/catalog.ts:6` | `ca/core/model-runtime.js` 与 `.d.ts` 逐字相同 |
| `RegisterProviderModel` 的 chat 收窄 | `src/reviewer/model-runtime.ts:12-15` | `ProviderModelConfig` 联合没动(`ca/core/extensions/types.d.ts` 的 diff 只有工具渲染器相关的四处新增)。typecheck 通过 |
| `resizeImage` | `src/reviewer/session-images.ts:18,77` | `ca/utils/image-resize.js` 与 `.d.ts` 逐字相同(签名在 `.d.ts:10`)。改的是 `image-convert.js`,新增两个给 TUI 用的导出 |
| `defineTool`、`ToolDefinition`、`InlineExtension` | 各工具文件与 `worker.ts:7-11` | `ca/core/tools/tool-definition-wrapper.js` 逐字相同。`types.d.ts` 没动这三个类型 |
| `createFindToolDefinition`、`createGrepToolDefinition`、`createLsToolDefinition` | `src/reviewer/worker-tools.ts:17-19` | `ca/core/tools/{find,grep,ls}.js` 逐字相同 |
| `AgentSession`、`AgentSessionEventListener` | `src/reviewer/worker-tools.ts:14-15`、`session-worker.ts:17` | `ca/core/agent-session.d.ts` 只多三个私有成员(`_pendingToolNames`、`_setActiveTools`、`_isAllowedTool`) |
| `session.prompt` / `steer` / `followUp` | `src/reviewer/session-worker.ts:438-445`、`worker-tools.ts:564` | 签名不变 |
| `getSessionStats()` | `src/reviewer/worker-tools.ts:583` | 签名不变(`ca/core/agent-session.d.ts:844`) |
| 会话事件(`message_end`、`message_update`、`tool_execution_*`、`auto_retry_*`、`compaction_end`、`queue_update`) | `src/reviewer/trace-events.ts`、`session-worker.ts` | `ca/core/agent-session.js` 的 diff 只动工具激活那几处(第 1.5 节),事件名与载荷没动 |

`ca/index.js` 两版逐字相同,根入口的运行时导出没有增减。`ca/index.d.ts` 多导出三个类型:`QuietStartup`(第 22 行)、`ToolRendererResolver` 与 `ToolRenderers`(第 8 行)。没有删除任何导出。

### 1.4 会话条目格式(问题 3,ADR 0031)

- `CURRENT_SESSION_VERSION` 两版都是 3(`ca/core/session-manager.js:11`)。
- `ca/core/session-manager.js` 与 `.d.ts` 两版逐字相同。条目形状、`parentId` 链、压缩条目、自带迁移(`migrateV1ToV2`、`migrateV2ToV3`,`:31,56`)都没有动。
- `ca/core/compaction/` 整个目录逐字相同(`diff -rq` 无输出)。`ca/core/messages.js` 逐字相同。
- 产生消息的 `core/agent.js`、`core/agent-loop.js`、`core/types.d.ts` 逐字相同。`ai/types.d.ts` 的 diff 只有一行注释。
- 结论:0.99.x 落库的条目在 1.0.1 上原样可重建,**源码不用动**。这一条靠的是文件逐字相同;没有做「0.99.2 产出条目、1.0.1 重建」的跨版本实跑。`agent-session-rebuild` 17 条在 1.0.1 上全过。
- 重建路径上唯一的代码改动在工具激活(第 1.5 节的 `_restoreToolsFromTranscript`)。它对本项目没有可见差别。

### 1.5 扩展 API 与 `tools` 允许清单(问题 5)

| 本项目依赖点 | 1.0.1 的位置与变化 | 结论 |
|---|---|---|
| `agent_before_settle`(`src/reviewer/worker.ts:603`) | 触发点在 `ca/core/agent-session.js:1417-1431`,类型在 `ca/core/extensions/types.d.ts:765,1173`。两处代码没有改动 | 不受影响;`reviewer-verdict-nudge` 6 条全过 |
| `tool_call` 钩子(`src/reviewer/evidence.ts:484`) | `ca/core/extensions/runner.js:960`,类型在 `types.d.ts:895,1187`。`runner.js` 的 diff 只新增 `resolveToolRenderers`(`:542`) | 不受影响;`reviewer-evidence` 19 条全过 |
| 工具 `exposure` | `ToolExposure` 五个取值不变(`types.d.ts:388`),`direct` 与 `model-only` 仍是注册即激活(`ca/core/agent-session.js:2861-2863`) | 不受影响 |
| `tools` 允许清单:入口 | `allowedToolNames = options.tools`(`ca/core/sdk.js:145`,文件逐字相同) | 不受影响 |
| `tools` 允许清单:注册表过滤 | 原先的局部函数抽成方法 `_isAllowedTool`(`ca/core/agent-session.js:1099-1101`),四个过滤点在 `:2785,2787,2817,2829`。判据逐字相同 | 不受影响 |
| `tools` 允许清单:`getAllTools()` | `ca/core/agent-session.js:1063`,只返回过滤后的注册表 | 不受影响。pi-subagents 的 `subagents_enable` 仍被滤掉,`reviewer-evidence-session` 里那条断言通过 |
| 新增 `pi.registerToolRenderer()` | `ca/core/extensions/loader.js:289-293` | 只影响 TUI 与 HTML 导出的绘制,本项目不用 |

**`_pendingToolNames`(新增)。** 会话从记录里恢复工具面时,记录声明过、此刻还没注册的工具名先记成「待定」,等它注册时再激活(`ca/core/agent-session.js:141,1332-1340,2852`)。下一次开跑时清空(`:1351`)。待定名同样过 `_isAllowedTool`(`:1338`)。这是给重连较慢的 MCP 工具用的。本项目的工具在建会话时就全部注册,`_setActiveTools` 当场把它们从待定里删掉(`:1095-1096`)。记录里有、现在已经不注册的工具名会待定到首次开跑,其间没有东西去注册它。

### 1.6 内建扩展、`mcp.json`、联网、skill 扫描(问题 6)

`docs/research/pi-upgrade-2026-09-30.md`「根入口会不会加载新包」一节的结论原样成立,依据的文件两版逐字相同:

- 内建扩展列表只在 CLI 入口注入(`ca/main.js:38,451`)。根入口不导出 `builtInExtensions`(`ca/index.js:34-36` 只导出三个工厂函数)。
- `DefaultResourceLoader` 只从调用方传入的 `extensionFactories` 里挑 `builtin: true` 的项(`ca/core/resource-loader.js:64,246`)。本项目传的都是自己的 `InlineExtension`。
- `createAgentSession` 只在调用方不给 `resourceLoader` 时自建一个(`ca/core/sdk.js:77-78`)。本项目总是给(`src/reviewer/worker-tools.ts:516`)。
- 因此 MCP、codemode、tool search 都不启用,`mcp.json` 不被读,没有新的联网点。1.0.x 对 `ca/extensions/{mcp,codemode}/`、pi-mcp、pi-codemode 的全部改动都落在这条不启用的路径上。
- 默认 skill 扫描仍由 `noSkills: true` 关掉(`ca/core/resource-loader.js:258,419`;`src/reviewer/worker-tools.ts:467`)。`agent-session-skills` 6 条全过。
- `systemPromptOverride` 仍然顶掉默认前言:`ca/core/system-prompt.js:76-78` 走 `customPrompt` 分支,1.0.x 改的那一行文档清单在 `else` 分支里(`:91`)。
- 根入口 import 耗时:0.99.2 为 685 / 431 / 420 ms,1.0.1 为 629 / 418 / 422 ms(各三次),无可见差异。

### 1.7 内建四件套与 fd / rg(问题 7)

`ca/core/tools/{read,grep,find,ls}.js`、`index.js`、`path-utils.js` 与 `ca/utils/tools-manager.js` 两版逐字相同(`cmp`)。调用参数没变:

- fd:`--glob --color=never --hidden`,按条件加 `--no-require-git`、`--max-results`、`--full-path`(`ca/core/tools/find.js:128-160`)。镜像钉的 fd 10.5.0 认这些参数。
- ripgrep:`--json --line-number --color=never --hidden`,按条件加 `--ignore-case`、`--fixed-strings`、`--glob`(`ca/core/tools/grep.js:93-100`)。

`ca/core/tools/` 下唯一改动的运行文件是 `bash.js`(输出 schema 的三句描述缩短)。本项目的允许清单里没有 `bash`。

### 1.8 模型目录、compat 与调用目标(问题 8,ADR 0027)

脚本对比两版 `ai/providers/data/*.json`(42 个文件,文件名清单相同):

- 模型 1601 → 1615 个(chat 1529 → 1536,classifier 15 → 20,image 57 → 59)。
- **compat 键 29 → 29,零增零删。模型行字段 20 → 20,零增零删。**`gatewayCompat` 不用改(`src/reviewer/model-service-runtime.ts:294-298`)。
- 两版共有的模型里,`api` 或 `baseUrl` 变了的是 0 个。已存服务的目标绑定不会因升级改判。
- 新增 29 行:`amazon-bedrock` 4 行、`cloudflare-ai-gateway` 9 行(见下)、`cloudflare-workers-ai` 两个分类器、`nvidia` 2 行、`opencode` 2 行、`openrouter` 4 个 chat 加 2 个 image 加 1 个分类器、`vercel-ai-gateway` 1 个 chat 加 2 个分类器。
- **删除 15 个 id**:
  - `cloudflare-ai-gateway` 9 个 Claude 型号从点号改成短横(`claude-opus-5.5` → `claude-opus-5-5` 等)。旧 id 删除,新 id 计入上面的新增。
  - `nvidia:nvidia/nemotron-3-super-120b-a12b`。
  - `openrouter:openai/gpt-6.1-sol-pro:batch`、`openrouter:openai/gpt-6.1-sol:batch`。
  - `together:deepseek-ai/DeepSeek-V4-Pro`、`together:google/gemma-4-31B-it`、`together:openai/gpt-oss-20b`。
  - 影响范围:某个 Pi 内置服务的目录快照里有这些 id、并且模型组合引用了它们时,升级后刷新目录会少掉这一行。本项目的测试夹具与文档都不引用这 15 个 id(未查部署实例的库)。
- 字段变化:单价 57 行,最大输出 12 行,上下文窗口 6 行,radius 一行的 `providers` 列表,`together:deepseek-ai/DeepSeek-V4-Pro-0813` 的 `thinkingLevelMap` 与 `compat`。
- `supportsStrictMode` 在 openai-completions 模型里的分布从 648 / 47 / 20 变成 652 / 45 / 20(true / false / 缺省)。
- `supportsMidConvoToolChanges` 6 → 6,`supportsMidConvoSystemMessages` 85 → 85,`supportsMidConvoEffort` 7 → 7。
- 本项目常用的五行逐字相同(`JSON.stringify` 比对):`anthropic:claude-opus-5-5`、`anthropic:claude-sonnet-5-5`、`openai:gpt-6-sol`、`openai:gpt-6.1-sol`、`deepseek:deepseek-flash`。`anthropic.json`、`openai.json`、`deepseek.json` 三个文件整份逐字相同(`cmp`)。
- `ca/core/remote-catalog-provider.js` 逐字相同。`ca/core/model-registry.js` 只多一个 `generateImages()`(`:95-98`),本项目不调。`ca/core/model-resolver.js` 只换了 nvidia 的默认型号(`:18`),本项目总是显式给模型。

### 1.9 pi-ai 请求层(问题 9)

pi-ai 的 `dist` 里改动的运行文件共 9 个(另有 10 份目录数据)。与本项目三种协议有关的是三个:

**`ai/api/anthropic-messages.js`:会话途中的工具变更改成内联定义。**

- 启用条件没变:`compat.supportsMidConvoSystemMessages && compat.supportsMidConvoToolChanges && initialTools.length > 0`(`:870`)。旧版多一个「没有同名重定义」的条件,新版去掉了。
- 启用时带的 beta 标记从 `mid-conversation-tool-changes-2026-07-01` 换成 `inline-tools-2026-09-15`(`:119,855`)。
- 途中新增的工具从「请求级 `tools` 里加一条 `defer_loading: true`,消息里放 `tool_reference`」改成「消息里放 `tool_definition`,带完整定义」(`:1027-1040`)。请求级 `tools` 从此固定为初始工具加一个占位项(`:921-927`)。
- **自定义模型服务走不到这条路。**`gatewayCompat` 剥掉了 `supportsMidConvoSystemMessages`(`src/reviewer/model-service-runtime.ts:298`),启用条件的第一项就是 false。
- **Pi 内置 `anthropic` 服务会走到。**目录里带 `supportsMidConvoToolChanges` 的是六个型号:`claude-fable-5`、`claude-fable-5-1`、`claude-opus-4-8`、`claude-opus-5`、`claude-opus-5-5`、`claude-sonnet-5-5`。它们的每个请求都带新的 beta 标记,与工具有没有变无关。Reviewer 的工具面一轮内固定,不会出现 `tool_addition` 块。Agent 会话在重建后工具面与记录不同时会出现(例如发版新增了一件工具)。
- 这条路打的是 Anthropic 官方地址。`inline-tools-2026-09-15` 在官方地址上是否对全部账号开放,未验证:没有用真实 key 发请求。

**`ai/api/openai-responses-shared.js:211-217`:重放工具调用时的 item id 取舍。**

- 旧规则:换了模型且 id 以 `fc_` 开头时丢掉 id;重放成 `function_call` 且 id 不以 `fc_` 开头时丢掉 id。
- 新规则:换了模型时一律丢掉 id;id 的前缀与重放的类型不符时丢掉 id(`function_call` 要 `fc_`,`custom_tool_call` 要 `ctc_`)。
- 只在历史里有工具调用、并且会话中途换了模型或工具类型时才有差别。Reviewer 一轮固定一个模型。Agent 会话在辅助模型变更后重建,此时会走到「换了模型」这一支,行为是多丢几个 id,方向是收窄。

**`ai/utils/retry.js:27`**:可重试的报错文本多一条 `"model is at capacity"`。

其余改动的文件是 bedrock、cloudflare、两个 OAuth 登录流程与 OAuth 页面,本项目不用。`ai/api/openai-completions.js`、`ai/api/openai-responses.js`、`ai/utils/overflow.js`(溢出识别)、`ai/utils/provider-retry.js` 两版逐字相同(`cmp`)。思考档位映射没有改动:`anthropic-messages.js` 的 diff 里没有它,另两个协议文件没变。

**探针实测。**同一份上下文(一段系统提示、两件工具、一条用户消息,`reasoning: "medium"`),两版各发 6 种请求,diff 两份记录:

| 场景 | 两版差别 |
|---|---|
| anthropic-messages,目录原样的 compat(内置服务的情形) | `anthropic-beta` 末项换名;`x-stainless-package-version` 0.124.0 → 0.129.0。正文相同 |
| anthropic-messages,`gatewayCompat` 之后的 compat(自定义服务的情形) | 只有 `x-stainless-package-version`。正文相同,没有 `anthropic-beta` 头 |
| 同上两种,会话途中新增一件工具 | 内置:消息里的 `tool_reference` 变成 `tool_definition`,请求级 `tools` 少掉那条 `defer_loading` 项。自定义:只有 `x-stainless-package-version` |
| openai-responses(`gpt-6-sol`) | 逐字相同 |
| openai-completions(`deepseek-flash`) | 逐字相同 |

请求地址两版相同:`/v1/messages?beta=true`、`/v1/responses`、`/v1/chat/completions`。探针脚本只在临时目录里跑过,没有进仓库。

**Anthropic SDK 0.124.0 → 0.129.0。**依据是探针:两版请求的差别只有 `x-stainless-package-version`。SDK 的 CHANGELOG(0.125–0.129 五节)里与请求或重试有关的条目:

- 0.129.0「also send X-Stainless-Timeout for client-level timeouts」。探针里两版都带 `x-stainless-timeout: 600`,这个头没有新增。
- 0.127.0「join multiple anthropic-beta values with a comma and no space」。探针里两版的 `anthropic-beta` 都是逗号无空格,pi-ai 自己拼这个头。
- 0.126.0 与 0.127.0 改了 SDK 自带重试的几处细节(Retry-After 越界时用默认退避、请求体是流时不重试、中止后不再等重试)。pi-ai 发请求时把 SDK 的 `maxRetries` 钉成 0(`ai/api/anthropic-messages.js:436`),重试由它自己的 `retryProviderRequest` 做(`:438-442`;`ai/utils/provider-retry.js` 两版逐字相同)。SDK 自带重试的这几处改动因此走不到。

SDK 读的环境变量名两版相同(`readEnv(...)` 的 grep 结果 diff 为空)。

### 1.10 子进程环境(问题 10)

- 按包 grep 环境变量名(`process.env.X`、`env.X`、字面量),两版的集合相同:pi-coding-agent 74 个、pi-ai 72 个、pi-tui 27 个、pi-mcp 与 pi-codemode 各 1 个,diff 为空。pi-agent-core 少掉一个(随 harness 删除)。
- Anthropic SDK 的 `readEnv` 名单两版相同(24 个)。
- 结论:没有新增会被继承的变量。`src/reviewer/env.ts:8` 的凭据正则不用改。2026-10-01 记下的边角仍在:`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_IDENTITY_TOKEN_FILE` 不命中正则,key 存在时它们不起作用。

## 2. pi-subagents 0.75.0 在试装里的表现

- `peerDependencies` 与 `dependencies` 和 0.74.0 相同(`npm view pi-subagents@0.75.0 peerDependencies dependencies`):pi-ai `>=0.86.1`,其余 `*`,全部可选。
- 可选 peer `typebox` 仍解析到项目根的 1.3.11(lockfile 的 `pi-subagents@0.75.0(…)(typebox@1.3.11)`)。
- 取证与会话子代理的回归全过(第 3 节)。子会话工具面、`subagents_enable` 不在父会话工具面上、超时停下、仓库自带 agent 定义派不出去,这几条断言都在 `reviewer-evidence-session` 的 14 条里。
- 测试日志里没有 `keeping subagent eagerly available` 或 `Could not verify` 字样(23 份日志 grep 为空)。
- 没有出现失败,所以没有做「pi-subagents 退回 0.74.0 配 Pi 1.0.1」的隔离跑。从代码看,0.74.0 配 Pi 1.0.1 只在后台 runner 的别名解析上会找不到 `./node`(第 1.2 节),前台路径不经过它;这一句未实跑验证。

## 3. 试装结果

环境:`git worktree add --detach … main`(`6f7c885`),`package.json` 两行改成 `^1.0.1` 与 `0.75.0`。pnpm 12.9.1,Node 24.14.0。

- `pnpm install` 之后 lockfile 里 `0.99.2` 与 `0.74.0` 各出现 0 次(`grep -c`)。这一次只跑 `pnpm install` 就没有留下双份树。
- 再跑 `pnpm update "@earendil-works/*"`:输出 `Already up to date`,lockfile 不变(`diff` 退出码 0)。`pnpm why @earendil-works/pi-ai` 报 `Found 1 version`。这一步照旧保留在流程里,代价是 1 秒。
- `tsc --noEmit`:退出码 0,无输出。源码零改动。
- 追加 `pnpm update brace-expansion` 之后再跑一次 typecheck 与三个测试文件,结果相同。

测试(`MULTIREVIEWER_TEST_DATABASE_URL` 指本机 54329,容器 `multireviewer-postgres-1` 在跑;逐文件 `node --test`,退出码全部为 0):

| 文件 | 用例 |
|---|---|
| `reviewer-evidence-session` | 14 / 14 |
| `agent-session-subprocess` | 12 / 12 |
| `reviewer-verdict-nudge` | 6 / 6 |
| `reviewer-evidence` | 19 / 19 |
| `model-service-runtime` | 15 / 15 |
| `agent-session-rebuild` | 17 / 17 |
| `agent-session-skills` | 6 / 6 |
| `agent-session-tools` | 5 / 5 |
| `agent-session-reclaim` | 4 / 4 |
| `agent-session-prompt` | 10 / 10 |
| `agent-session-drain` | 1 / 1 |
| `panel-agent-session-images` | 7 / 7 |
| `worker-tools` | 7 / 7 |
| `reviewer-subprocess` | 34 / 34 |
| `reviewer-turn-trace` | 2 / 2 |
| `reviewer-trace-events` | 20 / 20 |
| `reviewer-batch-trace` | 4 / 4 |
| `reviewer-contract` | 37 / 37 |
| `merge-agent` | 40 / 40 |
| `model-service-catalog` | 1 / 1 |
| `model-service-targets` | 5 / 5 |
| `model-service-review-run` | 5 / 5 |
| `panel-model-services` | 34 / 34 |

合计 23 个文件 305 条,0 失败,0 跳过。最慢的是 `agent-session-rebuild`(约 30 秒),没有文件挂死。没有跑全量 `pnpm check`。没有跑 `MULTIREVIEWER_SMOKE_*` 的真模型契约。

## 4. pnpm 发布年龄窗口

实测时刻 2026-10-04T01:07Z。

- 需要豁免。不改豁免清单时 `npx pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 拒装,原文:
  - `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 8 lockfile entries failed verification:`
  - `@earendil-works/pi-coding-agent@1.0.1 was published at 2026-10-03T12:35:33.444Z, within the minimumReleaseAge cutoff (2026-10-03T01:07:33.617Z)`
  - 另 7 个 earendil 包同理(chord、pi-agent-core、pi-ai、pi-codemode、pi-mcp、pi-telemetry、pi-tui,发布于 12:29–12:32Z)。
- 精确清单 8 项,一行一个版本:

  ```yaml
  minimumReleaseAgeExclude:
    - "@earendil-works/chord@1.0.1"
    - "@earendil-works/pi-agent-core@1.0.1"
    - "@earendil-works/pi-ai@1.0.1"
    - "@earendil-works/pi-codemode@1.0.1"
    - "@earendil-works/pi-coding-agent@1.0.1"
    - "@earendil-works/pi-mcp@1.0.1"
    - "@earendil-works/pi-telemetry@1.0.1"
    - "@earendil-works/pi-tui@1.0.1"
  ```

- 用这 8 行替换现有的 9 行之后,同一条命令通过(`✓ Lockfile passes supply-chain policies (741 entries in 974ms)`)。去掉 pi-telemetry 那一行只报这 1 项。清单没有多余项。
- 这次校验用的是 `pnpm update brace-expansion` 之前的 lockfile(741 项)。之后的 lockfile 只是少掉 `brace-expansion@5.0.9` 一项,没有新增项;pnpm 11.21 对它回的是缓存结果(`verified 3m ago`)。
- **不用豁免的三个**:
  - `pi-subagents@0.75.0`:窗口已在 2026-10-03T20:27Z 关闭。8 行清单里没有它,校验照过。
  - `@anthropic-ai/sdk@0.129.0`:发布于 2026-09-28。
  - `brace-expansion@5.0.12`:发布于 2026-09-14。
- 窗口关闭时刻:2026-10-04T12:35:33Z(pi-coding-agent 1.0.1 发布时刻加 24 小时)。在这之后构建镜像,清单可以整段留空;留着这 8 行也不影响。
- **本机 pnpm 12.9.1 会改写 `pnpm-workspace.yaml`**。第一次 `pnpm install` 把清单写成 `"@earendil-works/chord@0.99.2 || 1.0.1"` 这种并集形式,并保留 `pi-subagents@0.74.0` 那一行。提交前要改回上面那种一行一个版本的写法。之后的 `pnpm update brace-expansion` 没有再改写它(`cmp` 相同)。

## 5. 升级要改的位置

1. `package.json:22`:`^0.99.2` → `^1.0.1`;`package.json:25`:`0.74.0` → `0.75.0`。
2. `pnpm install`,再 `pnpm update "@earendil-works/*"`,再 `pnpm update brace-expansion`。确认 lockfile 里 `0.99.2`、`0.74.0`、`brace-expansion@5.0.9` 各出现 0 次。
3. `pnpm-workspace.yaml`:
   - 第 18–26 行的 9 行清单换成第 4 节的 8 行。
   - 第 12–13 行的注释改成:Pi 1.0.1 发布于 2026-10-03,调研见 `docs/research/pi-upgrade-2026-10-04.md`。pi-subagents 0.75.0 升级时已过窗口,不在清单里。
   - 第 16 行(pi-server 不在树里)仍然成立,保留。
4. 源码不改。
5. 根 `AGENTS.md`:
   - 技术栈段(第 11 行)「当前钉在 Pi 0.99.2 与 pi-subagents 0.74.0」改成 1.0.1 与 0.75.0。同段其余句子仍然成立:`pi-server` 不在依赖树里;运行时第三方依赖仍是五个;前台取证子会话跑在 Reviewer 子进程内。
   - 变更日志加一条。要点:Pi 跨到 1.0,源码未改;pi-agent-core 删掉 harness 与七个子路径,本项目不引用;Pi 内置 `anthropic` 服务的 beta 标记换成 `inline-tools-2026-09-15`,自定义服务的请求不变;目录删 15 个 id;compat 键零增减,`gatewayCompat` 不变。
6. `src/AGENTS.md` 变更日志(第 356 行起)加一条,内容同上的缩写。
7. 发版前跑一次全量 `pnpm check`。
8. 发版后的验收:在部署实例上各跑一轮带取证的 Review Run 与一次 Agent 会话续谈(续谈一个升级前建的会话,验证 0.99.x 条目的重建)。实例上配有 Pi 内置 `anthropic` 服务时,用它另跑一轮,确认新的 beta 标记被接受。

## 建议

**值得做**

- 升到 Pi 1.0.1 与 pi-subagents 0.75.0。理由:源码零改动;会话条目格式、SDK 入口、四件套、资源加载器这些依赖点所在的文件两版逐字相同;23 个测试文件全过;自定义服务的三种协议请求经探针确认不变。
- 升级时顺手跑 `pnpm update brace-expansion`。理由:不跑的话 lockfile 里 minimatch 仍解析到 5.0.9,Pi 1.0.1 修的三个 GHSA 在本项目的树里没有生效。代价是一条命令,lockfile 少一个包键。

**可选**

- 等到 2026-10-04T12:35Z 之后再升。理由:窗口关闭后 `pnpm-workspace.yaml` 的豁免清单可以清空,少维护 8 行。代价是晚半天。
- 发版后对 Pi 内置 `anthropic` 服务(若实例上配了)刷新一次目录并跑一轮。理由:beta 标记换名只在这条路径上生效,自动化测试用的是假模型服务,覆盖不到官方地址的应答。

**不做**

- 在 `gatewayCompat` 里追加剥 `supportsMidConvoToolChanges`。理由:pi-ai 的启用条件把它与 `supportsMidConvoSystemMessages` 并在一起判(`ai/api/anthropic-messages.js:870`),后者已经被剥掉。探针确认自定义服务的请求里没有 `anthropic-beta` 头与 `tool_addition` 块。多剥一位不改变任何请求。
- 做「0.99.2 产出条目、1.0.1 重建」的跨版本测试夹具。理由:`session-manager.js`、压缩目录、`agent-loop.js` 与消息类型两版逐字相同,条目形状没有可以出错的地方。部署实例上续谈一个旧会话就是这条路径的真实验证(第 5 节第 8 步)。
- 为 pi-subagents 单独留在 0.74.0。理由:0.74.0 的后台 runner 别名表把 `pi-agent-core/node` 当必需项,Pi 1.0 已删掉这个子路径;0.75.0 把它标成可选。两者一起升才对得上。
