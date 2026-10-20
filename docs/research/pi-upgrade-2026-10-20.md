# Pi 1.1.0 → 1.3.0 试装(2026-10-20)

当前钉法:`@earendil-works/pi-coding-agent ^1.1.0`、`pi-subagents 0.76.1`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `6952047`)。npm 上的发布时刻(`npm view <包> time --json`):

- pi-coding-agent:1.2.0 为 2026-10-12T23:03:25Z,1.3.0 为 2026-10-15T19:13:30Z。没有 1.1.1。其余七个 earendil 包的 1.3.0 发布于 2026-10-15T19:09–19:14Z。`latest` 是 1.3.0。
- pi-subagents:0.79.1 为 2026-10-18T06:21:36Z,0.79.2 为 2026-10-20T06:12:37Z。`latest` 是 0.79.2。

来源:

- `npm pack` 取 1.1.0、1.2.0、1.3.0 三版的 pi-coding-agent、pi-ai、pi-agent-core、pi-tui、chord、pi-telemetry、pi-mcp、pi-codemode,解包后逐文件 diff(`diff -rq -x '*.map'`)。
- 包内 `CHANGELOG.md`:pi-coding-agent 的 `[1.2.0]` 与 `[1.3.0]`,pi-mcp 同两节,chord 的 `[1.3.0]`。
- 上游 release notes:`gh api repos/earendil-works/pi/releases/tags/v1.2.0|v1.3.0`。`v1.1.1` 回 404(没有这一版)。两节的条目与包内 CHANGELOG 逐条相同(去掉链接地址后排序比对,43 + 32 条,无差)。
- **实跑过**:一次性 worktree(`6952047`)里把 Pi 改成 `^1.3.0`、pi-subagents 改成 `0.79.1`,`pnpm install`、`pnpm update "@earendil-works/*"`、`tsc --noEmit`,加 6 个指定测试文件与 4 个补测文件(第 4 节)。
- **请求探针**:本机 HTTP 服务记下请求地址、头与正文,分别用两版 pi-ai 的 `streamSimple` 各发 8 种请求,再 diff(第 1.8 节)。
- **目录实验**:分别用主检出(Pi 1.1.0)与 worktree(Pi 1.3.0)的 `src/reviewer/catalog.ts` 调 `loadPiProviderCatalog("openrouter", …)`,临时落盘路径,联网与不联网各跑(第 1.7 节)。
- 探针与实验脚本只在 `/tmp` 里跑过,没有进仓库。

下文 `ca/` = `pi-coding-agent/dist/`,`ai/` = `pi-ai/dist/`,行号均指 1.3.0。

## 结论

**不能源码零改动直升。**typecheck 通过,6 个指定测试文件 59 条全过;但补测的 `test/panel-model-services.test.ts` 有 1 条失败,根因是 OpenRouter 目录在 1.2.0 起换了合并方式,本项目的厂商目录补缺(ADR 0009)把 OpenRouter 的整份目录冲成只剩厂商补的那几十行(第 1.7 节)。要先改 `src/reviewer/catalog.ts` 再升。

Breaking Changes 共 5 条(1.2.0 四条、pi-mcp 1.2.0 一条),本项目都不走到(第 1.1 节)。会话条目格式与 `CURRENT_SESSION_VERSION` 不变。要知道的变化:

1. **OpenRouter 目录被冲掉(必须改)**:Pi 1.2.0 起 OpenRouter 用 `withPersonalizedCatalog`,落盘里那一家的 `models` 整个**替换**内置表,不再与内置表合并。本项目把厂商补缺只写进落盘,于是目录从 489 行掉到 76 行,下一次读又变成 470 行;`anthropic-messages` 那 16 行与 `auto` 全部消失。
2. **换模型后旧模型的思考块被丢掉**(第 1.8 节):以前转成普通文本发给新模型,现在不发。Agent 会话在辅助模型变化后重建时走到。
3. **内置 OpenAI 服务的 GPT-6 四个型号请求正文变了**(第 1.8 节):目录给它们新打了 `supportsMidConvoEffort`,`reasoning.effort` 固定发 `medium`,真实档位改由一条 `configuration_update` 输入项带。自定义服务的这一位已由 `gatewayCompat` 剥掉,探针确认逐字不变。
4. **畸形 JSON 的工具参数改为校验失败**(第 1.1 节):以前按解析到一半的字段照样执行,现在回一条带原始参数的错误结果给模型。
5. **开跑前那段窗口里的 abort 现在生效**(第 1.3 节):Pi 从 `prompt()` 一进来就算忙,期间调 `abort()` 会在 `agent_start` 时中止这一轮。本项目自己的 `running` 闸不变,停止在这段窗口里从「没停住」变成「停住」。

## 1. Pi 1.3.0

### 1.1 CHANGELOG 逐条

只列与 SDK 使用方可能有关的条目。TUI、CLI 参数、`/share`、OAuth、Nix、Herdr、Bun、按键、主题、codemode、MCP 条目一律不受影响:本项目不跑 CLI 与交互模式,SDK 会话不加载 MCP 与 codemode(第 1.6 节)。

**Breaking Changes**

| 版本 | 条目 | 本项目 |
|---|---|---|
| 1.2.0 | 配置 schema 发布到 `pi.dev/schemas/*`,主题 schema 改址 | 不受影响。本项目不写主题与 `settings.json` |
| 1.2.0 | `before_agent_start` 也对 `pi.sendMessage(…, { triggerTurn: true })` 触发,事件改成按 `messageType` 区分的联合 | 本项目不订阅它(`grep -rn before_agent_start src` 为空)。`ExtensionRunner.emitBeforeAgentStart` 改成收一个 `trigger`(`ca/core/extensions/runner.js:1121`) |
| 1.2.0 | 开跑期间会话算忙:`isIdle()` 为假,`sendMessage()` 并入正在开跑的那一轮,期间的 abort 在开跑后生效 | 本项目不调 `sendMessage` / `isIdle`;abort 那一半走得到,见第 1.3 节 |
| 1.2.0 | `pi mcp list --json` 改报 `resources: true` | 不受影响,CLI |
| pi-mcp 1.2.0 | `CallToolResult.structuredContent` 改成 `unknown` | 不受影响。本项目不 import pi-mcp |

chord 1.3.0 另有十几条 Breaking Changes(`Handle` → `Ref` 等改名、协议版本)。Pi 1.2.0 起不再依赖 chord(CHANGELOG 1.2.0 Removed 第 2 条),它从依赖树里消失,见第 1.2 节。

**其余相关条目**

| 版本 | 条目 | 本项目 |
|---|---|---|
| 1.2.0 Added | OpenRouter 按 key 列模型 | **走得到,而且出问题**,见第 1.7 节 |
| 1.2.0 Changed | `serializeConversation()`(压缩、分支摘要)不再带思考块 | Agent 会话开着自动压缩,走得到:摘要请求变小、摘要里不再有 `[Assistant thinking]` 一段(`ca/core/compaction/utils.js:101`)。Reviewer 等三条链路压缩关着 |
| 1.2.0 Fixed | Anthropic 拒收严格工具集时去掉 `prefer` 级严格工具重试一次 | 走得到,只在那三种 400 时多一次请求(`ai/api/anthropic-messages.js:434-477`)。重试记一条 `anthropic_strict_tools_fallback` 诊断 |
| 1.2.0 Fixed | 「The upstream provider returned an error」改为可重试 | 重试面变宽,见第 1.9 节 |
| 1.2.0 Fixed | worktree 里软链的 `AGENTS.md` 导致不加载上下文文件 | 不受影响。判定只在工作树嵌在主仓库目录之内时生效(`ca/core/resource-loader.js:145-162`);本项目的一次性工作树在 `<缓存根>/.checkouts/…`,与缓存 clone `<缓存根>/<owner>/<repo>` 是平级(`src/git/worktree.ts:58,92`) |
| 1.2.0 Fixed | OpenRouter 路由模型负单价改记 0 | 不受影响,本项目早已自己截负,且只记 token |
| 1.2.0 Removed | 删掉实验性 server/client/plugin 与 `./client`、`./experimental/plugin` 两个源码导出 | 不受影响。本项目只从根入口 import |
| 1.3.0 Added | OpenAI GPT-6 中途改档位保住 prompt cache | 走得到,请求正文变化见第 1.8 节 |
| 1.3.0 Changed | `kimi-coding` 改走 Chat Completions,`models.json` 的地址要带 `/v1` | 调用目标变化见第 1.7 节 |
| 1.3.0 Changed | 换模型时丢掉别的模型产出的思考块 | 走得到,见第 1.8 节 |
| 1.3.0 Fixed | 内部 Pi 依赖钉成精确版本 | 见第 1.2 节 |
| 1.3.0 Fixed | 恢复会话时保留会话里激活过的工具 | 不受影响,见第 1.5 节 |
| 1.3.0 Fixed | 畸形 `\u` 转义导致参数字段丢失 | 走得到,`VALID_JSON_ESCAPES` 去掉 `u`(`ai/utils/json-parse.js:2`) |
| 1.3.0 Fixed | 最终参数是畸形 JSON 的工具调用不再静默执行 | 走得到。新函数 `parseToolCallArguments`(`ai/utils/json-parse.js:91`)给 toolCall 写可选的 `argumentsError`,校验遇到它直接抛(`ai/utils/validation.js:281-282`)。三种协议的流式收尾都改用它。对本项目:`report_finding` 等工具收到截断参数时,模型拿到的是一条带原始参数的错误结果,不再报出一条缺字段的 Finding |
| 1.3.0 Fixed | Anthropic 的错误工具结果里带图片会 400,图片挪到同一条消息的工具结果之后 | 走得到代码,本项目的工具结果不带图片 |
| 1.3.0 Fixed | `Unable to forward upstream stream`、`The service is temporarily unavailable` 改为可重试 | 见第 1.9 节 |
| 1.3.0 Fixed | LiteLLM 一类代理同一 chunk 里带思考与正文时顺序颠倒 | 走得到,`openai-completions` 先处理思考再处理正文(`ai/api/openai-completions.js:384-440`)。只影响流式块顺序 |
| 1.3.0 Fixed | `claude-haiku-5-5`、`claude-opus-5` 不支持 `off` 档 | 目录里两行的 `thinkingLevelMap` 删掉 `off` 键(第 1.7 节)。本项目按目录算可选档位,这两个型号的「关闭思考」不再可选 |
| 1.3.0 Fixed | `openai-codex/gpt-6.1-sol` 上下文窗口改 500K | 只是 `openai-codex` 这一家的目录字段 |

**`engines.node`**:三版的 pi-coding-agent 与 pi-ai 都没有改 `engines`(`package.json` 对比)。

### 1.2 依赖树

- pi-coding-agent 的 `dependencies`:`@earendil-works/chord` 删掉;其余五个 earendil 包从 `^1.1.0` 改成**精确的 `1.3.0`**(1.2.0 时还是 `^1.2.0`);第三方依赖一个没变。pi-ai 与 pi-agent-core 对子包的依赖同样改成精确版本。
- chord 1.3.0 的依赖从 `esbuild` 换成 `typebox`。chord 不在树里之后,**生产依赖树里不再有 esbuild**:主检出 `pnpm why esbuild --prod` 报 `esbuild@0.28.2 ← chord@1.1.0 ← pi-coding-agent@1.1.0`,worktree 里同一条命令报 `Found 1 version`,只剩开发依赖那一条。镜像的 `pnpm install --prod` 那一层因此少一个带原生二进制的包。`pnpm-workspace.yaml` 的 `esbuild: true` 仍需要,它给 Vite 构建用。
- pi-agent-core 三版 `dist` 逐字相同(`diff -rq` 无输出)。
- `@anthropic-ai/sdk` 仍是 0.129.0,`openai` 仍是 7.19.0(pi-ai `dependencies`)。
- 实装后 lockfile 的包键 742 → 741:
  - 换版 8 个:7 个 earendil 包(1.1.0 → 1.3.0)与 pi-subagents(0.76.1 → 0.79.1)。
  - 删除 1 个:`@earendil-works/chord@1.1.0`。
  - 新增 0 个。
- `pnpm install` 之后 lockfile 里没有 `@earendil-works/*@1.1.0` 或 `@1.2.0` 的键。`pnpm update "@earendil-works/*"` 不改 lockfile(`diff -q`)。`pnpm why @earendil-works/pi-ai` 报 `Found 1 version`。**这次不需要收拢双份 pi-ai**:1.3.0 起子包钉成精确版本,不会再出现 2026-09-06 那种同时装两份的情况。
- 没有跑传递依赖的安全审计:本机 registry 是 npmmirror,`pnpm audit --prod` 报审计端点不存在。

### 1.3 本项目的 import 逐个核对

import 只在 `src/reviewer/` 下 15 个文件,全部来自 `@earendil-works/pi-coding-agent` 根入口;另有 `evidence.ts:53` 从 `pi-subagents/capability-ceiling` 取天花板。`tsc --noEmit` 退出码 0。

| 依赖点 | 本项目位置 | 1.3.0 的情况 |
|---|---|---|
| 根入口导出 | 全部 | `ca/index.js` 只多导出 `formatReadLineRange`,`ca/index.d.ts` 多 `BeforeAgentStartCustomEvent` / `BeforeAgentStartUserEvent` 两个类型。没有删导出 |
| `createAgentSession` 入参 | `worker-tools.ts:508-525` | `ca/core/sdk.js` 与 `.d.ts` 逐字相同(`cmp`) |
| `DefaultResourceLoader` | `worker-tools.ts:474-488` | `.d.ts` 逐字相同;`.js` 只改上下文文件的遮蔽判定(第 1.1 节) |
| `SessionManager.inMemory` | `worker-tools.ts:517-522` | `ca/core/session-manager.js` 与 `.d.ts` 逐字相同 |
| `SettingsManager.inMemory` 的 `retry` / `compaction` | `worker-tools.ts:468-474` | 默认值挪进新文件 `ca/core/settings-defaults.js`,数值不变,见第 1.9 节 |
| `ModelRuntime`、`registerProvider` | `model-runtime.ts:4`、`catalog.ts:6` | `ca/core/model-runtime.d.ts` 逐字相同。`model-runtime.js` 只改 OpenRouter 的目录包装(`:88-96`,第 1.7 节)。模型配置 schema 挪到 pi-ai 的 `providers/compat-schema` 与 `providers/model-schema`,compat 三类 schema 都是 `additionalProperties: true`(`ai/providers/compat-schema.js:206,251,303`) |
| `RegisterProviderModel` 的 chat 收窄 | `model-runtime.ts:12-15` | typecheck 通过 |
| `resizeImage` | `session-images.ts:18,77` | `ca/utils/image-resize.js` 逐字相同 |
| `createFindToolDefinition` / `Grep` / `Ls`、`defineTool` 一族 | `worker-tools.ts:17-21`、各工具文件 | `ca/core/tools/{find,grep,ls,index,tool-definition-wrapper}.js` 逐字相同 |
| 会话事件 | `trace-events.ts`、`session-worker.ts` | 事件名不变 |
| `agent_before_settle` | `worker.ts:603` | runner 只改 `emitBeforeAgentStart`;`reviewer-verdict-nudge` 6 条全过 |
| `tool_call` 钩子 | `evidence.ts:484` | 同上;`reviewer-evidence-session` 14 条全过 |
| `prompt` / `steer` / `followUp` / `abort` | `session-worker.ts:451-458,521` | `_queueUserInput` 逐字相同。`prompt()` 改走新的 `_startRun`(`ca/core/agent-session.js:1392`),一进来就置 `_isAgentRunActive`;开跑期间的 `abort()` 记下请求,`agent_start` 时中止(`:713`)。本项目的 `running` 闸(`session-worker.ts:229,449-455`)不依赖 Pi 的 `isStreaming`,分流不变 |

### 1.4 会话条目格式(ADR 0031)

- `CURRENT_SESSION_VERSION` 仍是 3(`ca/core/session-manager.js:11`)。`session-manager.js`、`.d.ts`、`ca/core/messages.js`、`ca/core/compaction/compaction.js` 逐字相同。
- 新增字段只有一个:toolCall 块多可选 `argumentsError`(`ai/types.d.ts:277`)。它只在 `json-parse.js` 写、`validation.js` 读;三种协议的请求构造都不碰它(`grep -rn argumentsError ai/`)。
- 助手消息的可选 `providerThinkingLevel` 1.1.0 就有(1.1.0 `types.d.ts:383`)。1.3.0 起内置 OpenAI 的 GPT-6 型号也会写它(`ai/api/openai-responses.js:119`),并在同模型重放时据它插 `configuration_update`(`ai/api/openai-responses-shared.js:250-254`)。
- 对本项目:库里的旧条目在 1.3.0 上照常重建(读路径逐字相同)。回滚到 1.1.0 时多出的两格会被忽略。这一句只读了代码,没有实跑「1.3.0 产出、1.1.0 重建」。

### 1.5 `tools` 允许清单(问题:subagents_enable 是否仍被滤掉)

- `ca/core/sdk.js`、`ca/core/mcp-servers.js`(`createToolNameMatcher`)与 `ca/core/settings-manager.js` 里的 `getToolListError` / `applyToolModifiers` 未改动。`agent-session.js` 的 `_isAllowedTool`(`:1123`)所在段没有改动。判定与 1.1.0 相同。
- 1.3.0 的「恢复会话保留激活工具」:`_restoreToolsFromTranscript` 的触发条件从「`initialActiveToolNames` 未定义」改成 `usesDefaultTools`(`ca/core/agent-session.js:214-215`)。`usesDefaultTools` 只在没传 `tools` 或传的全是 `+name`/`-name` 时为真(`ca/core/sdk.js:314`)。本项目五条链路都传普通工具名(`worker.ts:778`、`session-worker.ts:340` 等,入口 `worker-tools.ts:514`),两版都不从会话记录恢复工具。
- `subagents_enable` 仍被滤掉:`reviewer-evidence-session.test.ts:147` 的断言通过。

### 1.6 内建扩展、skill 扫描、MCP、codemode

- 内建扩展清单 `ca/extensions/index.js` 逐字相同;它只被 `ca/main.js:38` import(`grep -rn extensions/index.js`)。`DefaultResourceLoader` 仍只从调用方给的 `extensionFactories` 里挑 `builtin: true` 的项(`ca/core/resource-loader.js:62-64,251`)。本项目自己给 `resourceLoader`,MCP、codemode、tool search 都不启用,`mcp.json` 不被读。
- 默认 skill 扫描仍由 `noSkills: true` 关掉(`worker-tools.ts:479`)。`ca/core/system-prompt.js` 逐字相同。
- 环境变量:按包 grep `PI_*`,pi-coding-agent 只多一个 `PI_CLIPBOARD_OSC52`(交互模式剪贴板);pi-ai 的集合不变。都不命中 `src/reviewer/env.ts` 的凭据正则,也不需要命中。

### 1.7 模型目录、compat 与调用目标(ADR 0027、ADR 0009)

**目录数据**。脚本对比两版 `ai/providers/data/*.json`(42 个文件,文件集合相同):

- 模型 1645 → 1709(chat 1559 → 1610,classifier 25 → 39,image 61 → 60)。provider 42 → 42,零增减。
- **compat 键 29 → 29,零增零删。模型行字段 20 → 20,零增零删。**
- 带 `supportsMidConvoToolChanges` 的 7 → 7,`supportsMidConvoSystemMessages` 88 → 93,`supportsMidConvoEffort` 9 → 13。`supportsMidConvoEffort` 新增的四行是 `openai:gpt-6-sol`、`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna`,这一位第一次出现在 `openai-responses` 协议上。`gatewayCompat`(`src/reviewer/model-service-runtime.ts:294-305`)不分协议地剥这一位,自定义服务不用改(第 1.8 节探针确认)。
- 常用五行:`anthropic:claude-opus-5-5`、`deepseek:deepseek-flash` 逐字相同;`anthropic:claude-sonnet-5-5` 只改 `cacheRead` 单价;`openai:gpt-6-sol`、`gpt-6.1-sol` 只多 `supportsMidConvoEffort`。
- 删除 42 行、新增 106 行。删除的是 google-vertex 两行、nvidia 两行、opencode / opencode-go 八行、openrouter 二十一行、vercel-ai-gateway 九行。本项目的测试夹具与文档都不引用它们。
- **两版共有的模型里调用目标变了的有 111 个**:
  - `kimi-coding` 四行:`anthropic-messages https://api.kimi.com/coding` → `openai-completions https://api.kimi.com/coding/v1`。
  - `opencode` 与 `opencode-go` 107 行:地址从 `opencode.ai/zen…` 换成 `opencode.ai/inference…`,协议不变。
  - 按 ADR 0027,已存版本的绑定不随升级改;刷新目录后这些行在当前版本里是「调用目标未经验证」。未查部署实例的库,不知道实例上有没有这三家的服务。
- 字段变化:`baseUrl` 111 行、单价 68 行、最大输出 32 行、上下文窗口 31 行、`compat` 26 行、`thinkingLevelMap` 22 行、`input` 5 行、`api` 4 行、其余个位数。

**OpenRouter 目录的合并方式变了(本项目受影响)**。1.2.0 起 OpenRouter 不再套 `withRemoteCatalog`,改套 `withPersonalizedCatalog`(`ca/core/model-runtime.js:93`):

- 旧版:`getModels()` = 内置表与落盘行**合并**,落盘行只在 `lastModified` 新于内置表生成时间时才用。
- 新版:`getAllModels = () => (personalModels.length > 0 ? personalModels : builtinModels())`(`ca/core/remote-catalog-provider.js:151`)。落盘那一家的 `models` 非空时**整个替换**内置表,不看 `lastModified`(`:156-163`)。

本项目的厂商补缺(`src/reviewer/catalog.ts:134-158` `mergeVendorCatalog`、`:201-221` `writeVendorModels`)只把「内置表与远程目录都没有的那些」写进落盘的 `openrouter.models`,再让 Pi 不联网重读一次。不带 key 的 `refresh` 不写 OpenRouter 那一条(两版实测:联网刷新之后落盘里都没有 `openrouter`),所以落盘那一条只有厂商补的行。旧版合并得出完整目录;新版拿它替换掉内置表。

实测(`loadPiProviderCatalog("openrouter")`,每次一个新的空落盘,除非注明):

| 情形 | Pi 1.1.0 | Pi 1.3.0 |
|---|---|---|
| 不联网 | 401 行 | 396 行 |
| 联网(含厂商补缺) | 489 行:`anthropic-messages` 16、`openai-completions` 473 | **76 行:全是 `openai-completions`** |
| 同一份落盘再联网一次 | — | **470 行:全是 `openai-completions`** |
| 不联网,读 1.1.0 写下的落盘 | 489 行 | **88 行**,没有 `auto`,没有 `anthropic/claude-opus-5.5` |

后果:

- 模型服务页上 OpenRouter 的目录只剩厂商补的那一批,`auto` 与 16 行 `anthropic-messages` 型号消失;来回读还会在 76 与 470 之间跳。
- ADR 0027 的混合协议判定失效:发现结果只剩一种协议,本该拒绝的验证模型被沿用唯一目标放行。`test/panel-model-services.test.ts:592`「预览与最终目录漂移后验证模型没有自己的目标:混合协议下明确拒绝」在 1.3.0 上失败,`:625` 期望 422、实得 200,响应体 `{"provider":"openrouter","version":1,"credential":{"state":"verified"},"directory":{"state":"discovery-failed"}}`——混合协议下的提交落了一个版本。同一文件在主检出(1.1.0)上 34/34 通过。
- 落盘是可丢弃的发现输入缓存(根 `AGENTS.md`「`MULTIREVIEWER_CACHE_DIR`」),Review Run 用的是库里冻结的版本,升级本身不改已存版本;问题出在下一次预览、提交或刷新目录。

### 1.8 pi-ai 请求层

`ai/api/transform-messages.js`、`anthropic-messages.js`、`openai-completions.js`、`openai-responses.js`、`openai-responses-shared.js` 都有改动;`ai/utils/estimate.js`(`CHARS_PER_TOKEN = 3.5`)与 `ai/compat.js`(`streamSimple`)逐字相同。

- **跨模型思考块**(`ai/api/transform-messages.js:87-104`):同模型的判定仍是 provider、api、model id 三者相同。不同模型产出的思考块以前转成普通文本,现在整块丢掉;同模型的照旧保留。
- **OpenAI Responses 的 `configuration_update`**(`ai/api/openai-responses.js:20,80-88`):模型带 `supportsMidConvoEffort` 且有推理档位、不是 ChatGPT 登录(`:25-30`)时,`reasoning.effort` 固定发 `medium`,真实档位放进末尾一条 `configuration_update` 输入项(`ai/api/openai-responses-shared.js:278-279`)。
- **Anthropic 的思考关闭**(`ai/api/anthropic-messages.js:917-920,978-985`):带 `supportsMidConvoEffort` 的模型在思考关闭(且 `thinkingLevelMap.off` 不是 `null`)时改发 `thinking: { type: "disabled" }`、不插档位消息。目录里这 13 行的 `off` 不是缺席就是 `null`,当前目录上走不到。
- **Anthropic 严格工具降级**(`:434-477`):见第 1.1 节。

**探针实测。**同一份上下文(一段系统提示、两件工具、一条用户消息,`maxRetries: 0`,provider 名用 `probe-builtin` / `probe-custom`,compat 取各自版本的目录行;「gatewayCompat」一档按 `model-service-runtime.ts:294-305` 剥掉两位),两版各发 8 种请求,diff 两份记录(去掉 host、content-length 等逐次变化的头):

| 场景 | `reasoning: "medium"` | `reasoning: "high"` |
|---|---|---|
| anthropic-messages,目录原样 compat,`claude-opus-5-5` | 逐字相同 | 逐字相同 |
| anthropic-messages,gatewayCompat,`claude-opus-5-5` | 逐字相同 | 逐字相同 |
| openai-responses,目录原样 compat,`gpt-6-sol`(内置服务的情形) | `input` 末尾多 `{"type":"configuration_update","reasoning":{"effort":"medium"}}` | `reasoning.effort` `high` → `medium`,末尾多一条 `effort: "high"` 的 `configuration_update` |
| openai-responses,gatewayCompat,`gpt-6-sol`(自定义服务的情形) | 逐字相同 | 逐字相同 |
| openai-completions,`deepseek-flash` | 逐字相同 | 逐字相同 |
| openai-completions,运行基线模型(上下文 128000、输出 16384)、首条消息 40 万字符 | 逐字相同 | 逐字相同(两版 `max_tokens` 都是 9503) |
| anthropic-messages,gatewayCompat,历史里有另一个模型的思考块 | 那条助手消息从「思考文本 + 正文」两块变成只剩正文一块 | 同左 |
| openai-completions,历史里有另一个模型的思考块 | 那条助手消息从 `"I should look at the file first.Looking."` 变成 `"Looking."` | 同左 |

请求地址两版相同:`/v1/messages?beta=true`、`/v1/responses`、`/v1/chat/completions`。

对本项目:

- Agent 会话在辅助模型换了之后用新模型重建(`src/AGENTS.md` 2026-09-12 issue #335 条),旧模型的思考从此不进新模型的上下文。同一个模型续谈不受影响。
- 只有 provider 为内置 `openai`、用 GPT-6 四个型号的服务会看到 `configuration_update`。这是 OpenAI 官方接口支持的写法(CHANGELOG 1.3.0 Added 第 1 条),没有拿真实 OpenAI key 实测。未查部署实例上有没有内置 `openai` 服务。

### 1.9 重试

- 默认值未变:`retry.enabled: true`、`maxRetries: 3`、`baseDelayMs: 2000`、`maxAgentDelayMs: 60000`、`provider.maxRetryDelayMs: 60000`,只是挪进 `ca/core/settings-defaults.js:17-25`;`settings-manager.js` 读 `retry` 的那几格与 1.1.0 一一对应。本项目显式给的 `{ enabled: true, maxRetries: 10 }`(`worker-tools.ts:473`)照样生效。
- `auto_retry_start` / `auto_retry_end` 的发出点与载荷:两版 `agent-session.js` 里这两个事件各自前后 6 行逐字相同(行号挪到 `:783,1523,3051,3074`)。`streamHeartbeat`(`worker-tools.ts:352-369`)不用改,`worker-tools` 8 条与 `reviewer-turn-trace` 3 条全过。
- `ai/utils/provider-retry.js` 逐字相同。
- 可重试报错多三类(`ai/utils/retry.js:40,46,50`):`The service is temporarily unavailable`、`The upstream provider returned an error`、`Unable to forward upstream`。十次重试的退避与心跳不变,只是这三类报错从「直接失败」变成「重试到十次」。

## 2. pi-subagents

见 `docs/research/pi-subagents-0.79-2026-10-20.md`。

## 3. pnpm 发布年龄窗口

实测时刻 2026-10-20T07:11Z。`pnpm-workspace.yaml` 现在没有 `minimumReleaseAge` 与 `minimumReleaseAgeExclude`(只有 `packages` 与 `allowBuilds`)。本机 pnpm 12.14.0 的 `pnpm config get minimumReleaseAge` 回 `undefined`;镜像用 pnpm 11.21.0(`Dockerfile:10`)。

- **Pi 1.3.0 与 pi-subagents 0.79.1 都不需要豁免。**`npx -y pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 通过:`✓ Lockfile passes supply-chain policies`。
- 对照:同一份 lockfile 临时加 `minimumReleaseAge: 4320`(3 天),同一条命令拒装,报 `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification`,唯一一项是 `pi-subagents@0.79.1 was published at 2026-10-18T06:21:36.733Z`。说明校验确实在跑,而 7 个 earendil 1.3.0 包(发布已 4.5 天)在 3 天窗口下也放行。
- **改用 pi-subagents 0.79.2 就要豁免**:它发布于 2026-10-20T06:12:37Z,按 24 小时窗口要到 2026-10-21T06:12Z 才放行。本次没有装 0.79.2(0.79.1 与 Pi 1.3.0 装得到一起)。
- 本机 pnpm 12.14.0 的 `pnpm install` 与 `pnpm update` 没有改写 `pnpm-workspace.yaml`(`git diff` 为空),但两次都打印 `Agent skills awaiting approval: pi-subagents. Run "pnpm approve" to review them.`,退出码 0。这是本机 pnpm 12 的提示,镜像里的 11.21.0 不出现。

## 4. 试装结果

环境:`git worktree add --detach /tmp/mr-pi-1-3 main`(`6952047`),`package.json` 两行改成 `^1.3.0` 与 `0.79.1`。pnpm 12.14.0,Node 24.14.0。PostgreSQL 是 `docker-compose.test.yml` 起的 `multireviewer-postgres-1`,`MULTIREVIEWER_TEST_DATABASE_URL` 指本机 54329。

- `pnpm install`:一次成功,退出码 0,14.7 秒。0.79.1 与 Pi 1.3.0 装得到一起。之后 `pnpm update "@earendil-works/*"` 不改 lockfile。lockfile 变化见第 1.2 节。
- `pnpm typecheck`(`tsc --noEmit`):退出码 0,无输出。

指定的 6 个测试文件(逐文件 `node --test`):

| 文件 | 用例 | 退出码 | 耗时 |
|---|---|---|---|
| `reviewer-evidence-session` | 14 / 14 | 0 | 21 秒 |
| `agent-session-subprocess` | 13 / 13 | 0 | 33 秒 |
| `reviewer-verdict-nudge` | 6 / 6 | 0 | 6 秒 |
| `model-service-runtime` | 15 / 15 | 0 | 1 秒 |
| `worker-tools` | 8 / 8 | 0 | 1 秒 |
| `reviewer-turn-trace` | 3 / 3 | 0 | 13 秒 |

合计 59 条,0 失败,0 跳过。

为核对第 1.7 节补跑的 4 个文件:

| 文件 | 用例 | 退出码 |
|---|---|---|
| `model-service-catalog` | 1 / 1 | 0 |
| `model-service-targets` | 5 / 5 | 0 |
| `model-service-persistence` | 10 / 10 | 0 |
| `panel-model-services` | **33 / 34** | **1** |

失败的那一条原文:

```
✖ 预览与最终目录漂移后验证模型没有自己的目标：混合协议下明确拒绝，不推理、库里零写入 (648.590792ms)
  AssertionError [ERR_ASSERTION]: {"provider":"openrouter","version":1,"credential":{"state":"verified"},"directory":{"state":"discovery-failed"}}
  200 !== 422
      at TestContext.<anonymous> (file:///private/tmp/mr-pi-1-3/test/panel-model-services.test.ts:625:12)
```

同一文件在主检出(Pi 1.1.0)上跑一次:34 / 34,退出码 0。没有复跑 worktree 里的失败。没有跑全量 `pnpm check`,没有跑 `MULTIREVIEWER_SMOKE_*` 的真模型契约。worktree 已删除,删前确认没有残留的 `node --test` 进程。

## 5. 升级要改的位置

1. **`src/reviewer/catalog.ts:134-158,201-221`(必须先改)**:厂商补缺不能再只把补的行写进 OpenRouter 的落盘那一条。可选做法,要由作者定:
   - 写进落盘的 `models` 改成「当前目录全量 + 补的行」。代价:内置表的行被冻进可丢弃缓存,Pi 升级改了内置行时要等下一次重写才跟上。
   - 不再写落盘,补的行只在 `loadPiProviderCatalog` 返回的投影里合并。理由:根 `AGENTS.md` 写明 Reviewer 不读这份缓存、Review Run 用库里冻结的版本,ADR 0009 里「落盘是面板与 Reviewer 子进程之间唯一的通路」那一条前提已经不成立。要同步改 ADR 0009 的附记。
   - 改完后 `test/panel-model-services.test.ts:592` 应回到通过;另补一条「联网补缺之后 OpenRouter 仍有 `auto` 与 `anthropic-messages` 两种目标」的用例,现在没有测试压住它。
2. `package.json:22`:`^1.1.0` → `^1.3.0`;`package.json:25` 按 pi-subagents 那份笔记定。
3. `pnpm install`,确认 lockfile 里没有 `@earendil-works/*@1.1.0` 与 `chord` 的键。不需要 `pnpm update "@earendil-works/*"`(第 1.2 节)。
4. `pnpm-workspace.yaml`:用 pi-subagents 0.79.1 时不改;用 0.79.2 且发版早于 2026-10-21T06:12Z 时加一条 `minimumReleaseAgeExclude`。用 `npx -y pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 再验一次。
5. `gatewayCompat` 不改(第 1.7、1.8 节)。
6. 根 `AGENTS.md`:技术栈段「当前钉在 Pi 1.1.0 与 pi-subagents 0.76.1」改版本号;「运行时第三方依赖」那句不变(chord 是传递依赖)。变更日志加一条,要点:OpenRouter 目录合并方式变化与修法;换模型丢思考块;内置 OpenAI GPT-6 的 `configuration_update`;畸形工具参数改为校验失败;开跑前的 abort 生效;生产树不再有 esbuild;`kimi-coding` 与 opencode 两家换调用目标。
7. `src/AGENTS.md` 变更日志加一条,内容同上的缩写。
8. 发版前跑一次全量 `pnpm check`。
9. 发版后在部署实例上:
   - 各跑一轮带取证的 Review Run 与一次 Agent 会话续谈(续谈一个升级前建的会话)。
   - 刷新一次 OpenRouter 的目录,确认 `auto` 与 `anthropic-messages` 型号仍在。
   - 查库里有没有 provider 为内置 `openai`、`kimi-coding`、`opencode`、`opencode-go` 的模型服务;有的话按第 1.7、1.8 节处理。

## 建议

**值得做**

- 先修 `catalog.ts` 的厂商补缺,再升 Pi 1.3.0。理由:不修的话 OpenRouter 目录在下一次读时就会缩水,ADR 0027 的混合协议拒绝会被绕过,已有一条用例失败为证。其余依赖点(会话条目、SDK 入口、四件套、资源加载器、重试事件)逐字相同或只有不触及本项目的新增。
- 修法倾向第二种(不写落盘,只在投影里合并)。理由:写落盘的前提已经不成立,继续写就要跟 Pi 的落盘语义走,这次就是被它改掉的。

**可选**

- 用一个带思考档位的内置 OpenAI 服务跑一轮,确认 `configuration_update` 被接受。理由:探针只证明请求变了,没有证明真实接口收。代价是一次真实调用;只在实例上有内置 `openai` 服务时才需要。

**不做**

- 在 `gatewayCompat` 里多剥 compat 键。理由:键集合零增减,`supportsMidConvoEffort` 的剥法不分协议,已覆盖新出现在 `openai-responses` 上的那四行。
- 为跨模型思考块写夹具。理由:这是上游有意的修正(CHANGELOG 1.3.0 Changed 第 2 条),本项目没有依赖旧行为的地方。
