# Pi 0.99.1 → 0.99.2、pi-subagents 0.73.1 → 0.74.0 跟进(2026-10-01)

当前钉法:`@earendil-works/pi-coding-agent ^0.99.1`、`pi-subagents 0.73.1`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `1b28ff2`)。npm 上的发布时刻:pi-coding-agent 0.99.2 为 2026-09-30T19:30:20Z(`npm view @earendil-works/pi-coding-agent time`),pi-subagents 0.74.0 为 2026-09-30T18:09:41Z(`npm view pi-subagents time`)。

来源:

- `npm pack` 取两个版本的 pi-coding-agent、pi-ai、pi-agent-core、pi-tui、chord、pi-telemetry、pi-mcp、pi-codemode 与 pi-subagents,解包后逐文件 diff(`diff -rq`,去掉 `.map`)。
- 包内 `CHANGELOG.md`:pi-coding-agent 与 pi-mcp 的 `[0.99.2]`、pi-subagents 的 `[0.74.0]`。pi-ai、pi-agent-core 等包内不带 CHANGELOG,以 pi-coding-agent 那一节与 dist diff 为准。
- 上游 release notes:[pi v0.99.2](https://github.com/earendil-works/pi/releases/tag/v0.99.2)、[pi-subagents v0.74.0](https://github.com/nicobailon/pi-subagents/releases/tag/v0.74.0),内容与包内 CHANGELOG 一致。
- **实跑过**:一次性 worktree(`1b28ff2`)里把两个包钉到新版,`pnpm install` 加 `pnpm update "@earendil-works/*"`,`tsc --noEmit`,加 5 个测试文件(见文末)。

下文 `ca/` = `pi-coding-agent/dist/`,`ai/` = `pi-ai/dist/`,`ps/` = `pi-subagents/src/`,行号均指新版。

## 结论

能直接升,源码不改。改动只在 `package.json` 两行、`pnpm-workspace.yaml` 豁免清单与 lockfile。typecheck 通过,取证与 Agent 会话的真实 SDK 回归全过。

要知道的一处行为变化在 pi-subagents:它删掉了宿主校验(第 2.1 节),`subagents_enable` 加载器现在每次都会注册。`subagent` 仍然一开始就在工具面上,原因换了:本项目给 `createAgentSession` 传了 `tools` 允许清单,加载器被它滤掉。此前靠的是宿主校验失败。`AGENTS.md` 技术栈段里「认不出本项目的宿主」那句要跟着改。

## 1. Pi 0.99.2

### 1.1 依赖树

- 两版 `package.json` 的 `dependencies` 只是七个 `@earendil-works/*` 从 `^0.99.1` 改成 `^0.99.2`,其余第三方依赖版本一个没变(`npm view … dependencies` 对比)。
- pi-ai 的 `package.json` 新增一个导出子路径 `./models`(`ai/../package.json` diff),本项目不引用。
- pi-agent-core、pi-tui、chord、pi-telemetry 四个包的 diff 只有 `package.json` 的版本号,`dist/` 逐字相同。
- 实装后 lockfile:9 个包换版(8 个 earendil 包加 pi-subagents),pi-subagents 的 `undici` 从 8.10.0 换到 8.10.2(8.10.2 已在树里,Pi 本来就用它)。没有新增其他包,也没有删除其他包(`git diff pnpm-lock.yaml` 的包键对比)。

### 1.2 SDK 入口与会话

| 本项目依赖点 | 0.99.2 的变化 | 结论 |
|---|---|---|
| `createAgentSession({ …, tools, … })`(`src/reviewer/worker-tools.ts:508-525`) | 只多一格传给会话的 `usesDefaultTools: options.tools === undefined && !options.noTools`(`ca/core/sdk.js:302`)。它只在 `/reload` 时决定要不要补启用 `defaultTools` 里新增的工具(`ca/core/agent-session.js` 的 reload 段)。本项目总传 `tools`,这一格恒为 false | 不受影响 |
| `tools` 允许清单 | `allowedToolNames = options.tools`(`ca/core/sdk.js:145`),注册表按它过滤(`ca/core/agent-session.js:2753`),`getAllTools()` 只返回过滤后的(`:1057`)。这三处与 0.99.1 相同,第 2.1 节的结论靠的就是它 | 不受影响 |
| `DefaultResourceLoader`、`SettingsManager`、`SessionManager` | `ca/core/resource-loader.js`、`ca/core/session-manager.js`、`ca/index.d.ts` 两版逐字相同 | 不受影响 |
| 会话事件(`message_end`、`message_update`、`tool_execution_*`、`auto_retry_*`、`compaction_end`、`queue_update`) | `ca/core/agent-session.js` 的 diff 只有三处:`usesDefaultTools`、reload 补启用、`hidden` 声明不进系统提示的工具列表。没有动事件 | 不受影响 |
| `agent_before_settle`(`src/reviewer/worker.ts`)与 `tool_call`(`src/reviewer/evidence.ts:484`) | `ca/core/extensions/runner.js` 逐字相同;`ca/core/extensions/types.d.ts` 只给 `ToolNamespace` 加一个可选 `instructions` | 不受影响 |
| 工具 `exposure` | 新增的「`hidden` 声明不列进系统提示」只作用于 `prepareLoadout` 钩子隐藏的工具(`ca/core/agent-session.js:1141` 附近);本项目与 pi-subagents 都不注册 `prepareLoadout` | 不受影响 |
| 扩展 `registerCommand` | 名字不是字符串或没有 handler 时改为加载失败(`ca/core/extensions/loader.js` diff)。本项目的扩展不注册命令 | 不受影响 |

### 1.3 内建四件套与 fd / rg

`ca/core/tools/` 目录文件清单相同,`read.js`、`grep.js`、`find.js`、`ls.js` 两版逐字相同。fd 与 ripgrep 的调用参数没变。

### 1.4 会话条目格式(ADR 0031)

`ca/core/session-manager.js` 与 `pi-agent-core/dist/` 两版逐字相同,条目形状与 `CURRENT_SESSION_VERSION` 不变。`ca/core/virtual-models.js` 的 `getBranchSelection` 改成从末尾倒查(CHANGELOG「Fixed prompt submission slowing down with session length」),返回值语义不变;本项目不注册 virtual model。

### 1.5 模型目录、compat 与调用目标(ADR 0027)

- 脚本对比两版 `ai/providers/data/*.json`:模型 1592 → 1601 个,**compat 键零增零删,模型行字段零增零删,没有删除任何 id**。
- 两版共有的模型里,`api` 或 `baseUrl` 变了的是 0 个,已存服务的目标绑定不会因升级改判。
- 新增 9 行:`amazon-bedrock` 三行(`anthropic.claude-sonnet-5-5`、`openai.gpt-6.1-sol`、`us.openai.gpt-6.1-sol`)、`baseten:deepseek-ai/DeepSeek-V4.1-Flash-Fast`、`github-copilot:gpt-6.1-sol`、`opencode:gpt-6.1-sol`,以及三个分类器行(`openrouter` 两个、`vercel-ai-gateway` 一个)。
- 字段变化只在单价(18 行)、上下文窗口(2 行)、最大输出(4 行),以及 radius 的 `providers` 列表。
- 本项目常用的 `anthropic:claude-opus-5-5`、`anthropic:claude-sonnet-5-5`、`openai:gpt-6-sol`、`deepseek:deepseek-flash` 逐字相同。`openai:gpt-6.1-sol` 只是 `baseUrl` 与另一字段的键序换了,值相同(`python3 -m json.tool` 后 diff)。
- `supportsStrictMode` 在 openai-completions 模型里的分布从 647/47/20 变成 648/47/20(true / false / 缺省),多出的是新增的那一行。`gatewayCompat` 不用改(`src/reviewer/model-service-runtime.ts`)。
- `RegisterProviderModel` 的 `Extract` 收窄(`src/reviewer/model-runtime.ts:12-15`)在 0.99.2 上照常成立:typecheck 通过。
- `registerProvider` 的「临时标成已配置」那段抽成了 `markProvisionallyConfigured`(`ca/core/model-runtime.js` diff),`registerProvider` 的行为不变。新增调用点只在 `registerNativeProvider`,本项目不用它。
- 远程目录合并 `mergeModels` 改用 Map(`ca/core/remote-catalog-provider.js:20`,CHANGELOG「merging remote catalog models took quadratic time」)。结果的键是 `类型 + id`,顺序为基线在前、新增在后,与旧实现相同。`src/reviewer/catalog.ts` 的 `writeVendorModels` 不受影响。

### 1.6 pi-ai 请求层

- **Anthropic strict tool 回退**(`ai/api/anthropic-messages.js:1223-1261`):schema 里有 Anthropic strict 模式不收的关键字(`minimum`、`maximum`、`maxItems` 等)时,改为非 strict 发送。它只作用于声明了 `constrainedSampling` 且类型为 `json_schema` 的工具(`ai/api/constrained-sampling.js:176`)。本项目 `src/` 与 pi-subagents 里都没有 `constrainedSampling`(grep 为空),请求体不变。
- **Anthropic workload identity federation**(`ai/api/anthropic-messages.js:200`):只在两个条件同时成立时生效:provider 为 `anthropic`,且请求既没有 API key 也没有鉴权头。本项目每个 Reviewer 都带 key,走不到这条路。同时 Pi 给 Anthropic SDK 客户端关掉了 SDK 自己的凭据链(`_shouldResolveDefaultCredentials` 返回 false,`:190`),SDK 不会再去读 `ANTHROPIC_PROFILE` 一类配置。这是收窄。
  - 一处边角:`ANTHROPIC_FEDERATION_RULE_ID`、`ANTHROPIC_ORGANIZATION_ID`、`ANTHROPIC_IDENTITY_TOKEN_FILE` 三个变量名不命中 `src/reviewer/env.ts:8` 的凭据正则,会被继承进 Reviewer 子进程。key 存在时它们不起作用。
- **Retry-After 解析**(`ai/utils/provider-retry.js:33,40`):日期解析不出时改用指数退避。此前这种情况会立即重试。重试的轨迹事件形状不变。
- **溢出识别**(`ai/utils/overflow.js`)多认一种 Z.AI CN 的报错文本。

### 1.7 MCP 与 codemode

pi-mcp、pi-codemode 与 `ca/extensions/{mcp,codemode,tool-search}/` 的改动(namespace 规范化、`description` / `instructions`、OAuth `clientName`、`auth.provider`)只在内建扩展启用时才有意义。上一份调研的结论仍然成立:SDK 会话不加载内建扩展(`docs/research/pi-upgrade-2026-09-30.md` 第「根入口会不会加载新包」节)。`ca/core/resource-loader.js` 两版逐字相同,`ca/index.d.ts` 逐字相同。

## 2. pi-subagents 0.74.0

### 2.1 宿主校验删掉,加载器改成三档(0.74.0 Changed / Fixed)

**变更内容。**
- `ps/extension/tool-activation.js` 删掉了 `unsupportedDynamicToolsReason` / `probeHostPiVersion` / `readHostPiManifest` 整套宿主校验。`ps/runs/shared/pi-spawn.js` 删掉了 `resolveRunningPiPackageRoot`。CHANGELOG 0.74.0 Fixed:"Dynamic tool activation now works when Pi runs inside another app … no longer fall back to keeping `subagent` always loaded"。
- 新增 `toolActivation` 配置,取值 `auto`(默认)、`dynamic`、`eager`(`ps/extension/tool-activation.js:64`,`ps/extension/config.js` 的校验)。`eager` 在注册加载器之前直接返回(`:66`)。
- 加载器在 `auto` 与 `dynamic` 下一律注册(`:114`)。是否选中由 `session_start` 时的 `applyRecordedSelection` 决定,没收到 `session_start` 时 `loaderSelected` 保持初值 true(`:116`)。
- `before_agent_start` 只在 `pi.getAllTools()` 里有加载器时才把它加进 `selectedTools` 并 `setActiveTools`(`:120-123`)。

**本项目的情形(读代码加实跑)。**
- 本项目的子进程收不到 `session_start`:`src/` 里没有任何一处调用 `bindExtensions`(grep 为空)。`createAgentSession` 不发它,`ca/core/sdk.js` 里没有 `bindExtensions` 调用。因此 `loaderSelected` 停在 true。
- 但加载器被允许清单滤掉了。`worker.ts:778` 与 `session-worker.ts:340` 都给 `createAgentSession` 传了 `tools`,清单里没有 `subagents_enable`,`ca/core/agent-session.js:2753` 的过滤把它挡在注册表外。`getAllTools()` 因此看不到它,`before_agent_start` 在 `:123` 就返回了,不往系统提示里加它的 promptSnippet,也不 `setActiveTools`。
- `subagent` 本身被标成 `exposure: "model-only"`(`ps/extension/index.js:639`,`ps/shared/extension-context.js:7`)。Pi 对 `direct` 与 `model-only` 都是注册即激活(`ca/core/extensions/types.d.ts:378-385`),所以它一开始就在工具面上。`model-only` 只意味着不能经 `ctx.executeTool()` 从别的工具里调,本项目不这么用。
- **实跑确认**:`test/reviewer-evidence-session.test.ts:147`(父会话工具里没有 `subagents_enable`)通过。另在 worktree 临时加了一条断言,父会话首个请求的每条消息里都没有 `subagents_enable` 字样,14 条全过,之后恢复了测试文件。
- 每个子进程原先打印的那行 `Could not verify the running Pi installation … keeping subagent eagerly available` 不再出现(5 个测试文件的日志 grep 为空)。

**含义。** 「`subagent` 即时可用、加载器不在工具面上」原先有两道保障:宿主校验失败与允许清单过滤。现在只剩允许清单这一道。`toolActivation: "eager"` 能补回第一道,见文末「可选」。

### 2.2 其余依赖点对照

| 本项目依赖点 | 本项目位置 | 0.74.0 的情况 | 结论 |
|---|---|---|---|
| 能力天花板 `pi-subagents/capability-ceiling` | `src/reviewer/evidence.ts:50-53,132-142` | `ps/api/capability-ceiling.js` 与 `ps/runs/shared/capability-ceiling.js` 逐字相同 | 不受影响 |
| `config.json` 铺装(`asyncByDefault: false`、`intercomBridge.mode: "off"`) | `src/reviewer/evidence.ts:304-305` | `ps/extension/config.js` 多两道校验(`toolActivation`、`disabledFeatures`,并把两者加进校验失败即拒载的键表)。本项目的 config 不写这两键,校验照过。`ps/intercom/intercom-bridge.js` 逐字相同 | 不受影响 |
| `pinSubagentCall` 放行清单(`agent`、`task`、`tasks`、`chain`、`concurrency`、三个超时、`agentScope`、`cwd`、`intercomBridge`、`async`) | `src/reviewer/evidence.ts:367-380,429-461` | 顶层 schema 里这几格都还在(`ps/extension/schemas.js` 的 `SubagentParamProperties`)。`workflowScript` / `workflowScriptPath` 被删,`workflow` 改成 `boolean \| string`(`:202`)。带旧键的调用由执行器抛错(`ps/extension/index.js:645`)。这几个键本来就不在放行清单里,会被剥掉 | 不受影响 |
| 清单外键剥离、拦下 `action: "list"` | `src/reviewer/evidence.ts:484-503` | `tool_call` 钩子的语义未变(第 1.2 节),`reviewer-evidence.test.ts` 19 条全过 | 不受影响 |
| 工具描述要求先 list | 系统提示 `src/reviewer/worker.ts:93`、`src/reviewer/session-worker.ts:182` | `AGENT_SELECTION_GUIDANCE` 仍写 'First call {action:"list",capabilities:true}'(`ps/extension/tool-description.js:7`)。默认模式下没开 `disabledFeatures`,描述只改了 workflow 那几句 | 两处系统提示里那句仍然需要 |
| 只读四件套工具面 | `src/reviewer/evidence.ts:227`(`tools:` 显式清单) | 子会话新增两类可选注入:codemode 与内建 MCP 工具(`ps/runs/shared/child-session.js:284`)。codemode 只在 `launch.tools` 缺省或包含 `codemode` 时才加,而本项目的 agent 定义写了显式 `tools`(`ps/runs/shared/child-launch.js:217` 把它作为允许清单下发)。内建 MCP 只在 agent 的 `tools` 里有 `mcp:` 项时才加 | 不受影响;实跑子会话工具面恰是四件套(`reviewer-evidence-session` 用例) |
| 子会话的 project trust | — | 子会话的 `SettingsManager` 改为带上父会话的 `projectTrusted`(`ps/runs/shared/child-session.js:272`)。取值来自 `ctx.isProjectTrusted()`(`ps/runs/foreground/subagent-executor.js:302`)→ 父会话 `settingsManager.isProjectTrusted()`(`ca/core/agent-session.js:2693`)。本项目父会话用 `SettingsManager.inMemory`,缺省为 true(`ca/core/settings-manager.js:214`)。旧版不传这一格,同样按 true 处理 | 行为与 0.73.1 相同 |
| `inheritSkills: false` | agent 定义 | 现在还会剔除扩展经 `resources_discover` 加进来的 skill(`ps/runs/shared/child-session.js:297`)。本项目子会话不加载带 skill 的扩展 | 收窄,不受影响 |
| transcript 路径与格式 | `src/reviewer/evidence.ts:515-523` | `ps/shared/child-transcript.js` 逐字相同 | 不受影响 |
| 用量并入父会话 | `src/reviewer/evidence.ts:35-37` | `ps/extension/tool-result.js` 逐字相同 | 不受影响 |
| 取证上限(会话)与扇出上限 | `src/reviewer/evidence.ts:73-79` | 读两个环境变量的 `ps/shared/types.js` 逐字相同 | 不受影响 |
| 父子通话工具默认关闭 | `src/reviewer/evidence.ts:300-306,355` | intercom 桥未改,见上 | 不受影响 |
| 升级提示 | — | 只在 `session_start` 且 `ctx.hasUI` 时显示(`ps/extension/index.js:1049`,`ps/extension/upgrade-notice.js:12`)。本项目两样都没有 | 不出现 |
| 模块预加载 | — | 执行器模块改在 `session_start` 后 1 秒预加载(`ps/extension/index.js:1012`)。本项目收不到 `session_start`,仍在首次调用时加载,与 0.73.1 相同 | 不受影响 |
| 前台执行与超时 | `test/reviewer-evidence-session.test.ts` 超时用例 | `ps/runs/foreground/execution.js` 只多两处:被 workflow 中止记成 stopped,以及压缩事件迟到时的恢复。都与前台单次取证无关 | 不受影响 |

### 2.3 peer 与 typebox

- `peerDependencies` 与 `peerDependenciesMeta` 两版相同:pi-ai `>=0.86.1`,其余 `*`,全部可选(`npm view pi-subagents@0.74.0 peerDependencies peerDependenciesMeta`)。`dependencies` 只把 `undici` 从 8.10.0 改成 8.10.2。
- 实装后可选 peer `typebox` 仍解析到项目根的 1.3.11(lockfile 里 `pi-subagents@0.74.0(…)(typebox@1.3.11)`)。

### 2.4 与本项目无关的改动

workflow 脚本改成 reply 里的代码块、`disabledFeatures`、后台 workflow 熬过 `/reload`、Fleet / Herdr / 异步小部件、Windows 性能修复、`modelScope` 的 `scoped`、`agentOverrides.<name>.advertise`、`mcp:` 选择器。这些对应 `runs/background/*`、`workflows/*`、`tui/*`、`slash/*`、`watchdog/*` 与 `extension/rpc.js` 的改动。本项目一律前台执行,`async` 钉 false,`workflow*` 会被剥掉,也没有 UI。

## 3. 试装结果

环境:`git worktree add --detach … main`(`1b28ff2`),`package.json` 两行改成 `^0.99.2` 与 `0.74.0`。先 `pnpm install`(pnpm 12.8.1),再 `pnpm update "@earendil-works/*"`,Node 24。

- 只跑 `pnpm install` 时,pi-subagents 的可选 peer 仍解析到 0.99.1,树里留两套 pi-ai / pi-agent-core / pi-tui / chord / pi-telemetry。与前三次升级是同一种症状。
- `pnpm update "@earendil-works/*"` 之后,`pnpm-lock.yaml` 里 `0.99.1` 与 `0.73.1` 各出现 0 次(`grep -c`)。`node_modules/pi-subagents` 指向 peer 为 0.99.2 的那一份。
- `tsc --noEmit`:退出码 0,无输出。

测试(`MULTIREVIEWER_TEST_DATABASE_URL` 指本机 54329,逐文件 `node --test`):

| 文件 | 用例 |
|---|---|
| `reviewer-evidence-session` | 14 / 14 |
| `agent-session-subprocess` | 12 / 12 |
| `reviewer-verdict-nudge` | 6 / 6 |
| `reviewer-evidence`(补跑) | 19 / 19 |
| `model-service-runtime`(补跑) | 15 / 15 |

第一次跑时本机 PostgreSQL 容器是停着的(`multireviewer-postgres-1 Exited (0) 2 hours ago`),`reviewer-evidence-session` 有 1 条、`agent-session-subprocess` 整文件报 `ECONNREFUSED 127.0.0.1:54329`。用 `docker compose -f docker-compose.test.yml up -d`(在主仓库目录)起来后重跑,即为上表。没有跑全量 `pnpm check`。

## 4. pnpm 发布年龄窗口

- 需要豁免。`npx pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 在不加豁免时拒装,原文:
  - `pi-subagents@0.74.0 was published at 2026-09-30T18:09:41.978Z, within the minimumReleaseAge cutoff`
  - `@earendil-works/pi-coding-agent@0.99.2 was published at 2026-09-30T19:30:20.243Z, within the minimumReleaseAge cutoff`
  - 另 7 个 earendil 包同理(chord、pi-agent-core、pi-ai、pi-codemode、pi-mcp、pi-telemetry、pi-tui)。
- 精确清单 9 项,一行一个版本:

  ```yaml
  minimumReleaseAgeExclude:
    - "@earendil-works/chord@0.99.2"
    - "@earendil-works/pi-agent-core@0.99.2"
    - "@earendil-works/pi-ai@0.99.2"
    - "@earendil-works/pi-codemode@0.99.2"
    - "@earendil-works/pi-coding-agent@0.99.2"
    - "@earendil-works/pi-mcp@0.99.2"
    - "@earendil-works/pi-telemetry@0.99.2"
    - "@earendil-works/pi-tui@0.99.2"
    - "pi-subagents@0.74.0"
  ```

- 用这 9 行替换现有的 8 行 `@0.99.1` 之后,`npx pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 通过(`✓ Lockfile passes supply-chain policies (740 entries)`)。去掉 pi-subagents 那行只报 1 项,去掉 8 行 earendil 只报 8 项,两次实测都确认清单没有多余项。
- `undici@8.10.2`(2026-09-04)已过窗口,不用豁免。
- 窗口关闭时刻:pi-subagents 0.74.0 在 2026-10-01T18:09:41Z,pi-coding-agent 0.99.2 在 2026-10-01T19:30:20Z(各自发布时刻加 24 小时)。
- **本机 pnpm 12.8.1 会改写 `pnpm-workspace.yaml`**:第一次 `pnpm install` 时它把清单写成 `"@earendil-works/chord@0.99.1 || 0.99.2"` 这种并集形式,并自动追加 `pi-subagents@0.74.0`。提交前要改回上面那种一行一个版本的写法。

## 5. 升级要改的位置

1. `package.json:22`:`^0.99.1` → `^0.99.2`;`package.json:25`:`0.73.1` → `0.74.0`。然后 `pnpm update "@earendil-works/*"`,把 pi-subagents 的 peer 重解到同一份。
2. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 换成上面 9 行。注释(「Pi 0.99.1 发布于 2026-09-29」「pi-subagents 0.73.1 升级时已过窗口」)跟着改。
3. 源码不改。
4. 根 `AGENTS.md` 技术栈段:
   - 版本号改成 0.99.2 / 0.74.0。
   - 2026-09-30 条目里「按需加载仍认不出本项目的宿主,`subagent` 照旧即时可用」改成:pi-subagents 0.74 删掉了宿主校验,加载器会注册,但不在我们的 `tools` 允许清单里,因此不进工具面。
   - 变更日志加一条。`src/AGENTS.md` 变更日志同样加一条。
5. 发版前跑一次全量 `pnpm check`。

## 建议

**值得做**

- 升到 Pi 0.99.2 与 pi-subagents 0.74.0。理由:源码零改动;第 1、2 节的依赖点都没有改变语义;取证与会话回归实跑通过。0.99.2 修掉了会话变长后提交变慢(每条 assistant 消息查一次目录),这对按天续谈的 Agent 会话有实际意义。

**可选**

- 在 `installSubagentKit` 写的 `config.json` 里加 `toolActivation: "eager"`(`src/reviewer/evidence.ts:304-305`,一行)。
  - 理由:补回第 2.1 节失去的那道保障。加了之后加载器根本不注册,是否显示 `subagent` 不再只靠 `tools` 允许清单。这个值是官方文档化的取值(CHANGELOG 0.74.0 Changed),写错时 `toolActivation` 属于校验失败即拒载的键(`ps/extension/config.js`),不会静默退回默认。
  - 代价:一行配置,加一条测试断言;`reviewer-evidence.test.ts` 里铺装文件的逐字比对要跟着改。
- 用 `disabledFeatures` 缩短 `subagent` 工具声明。
  - 理由:上游实测全部关掉时从 18,239 字符降到 10,263(CHANGELOG 0.74.0 Added),每个 Reviewer 请求都带这份声明。
  - 能关的组:`agent-management`、`watchdog`、`panes`、`missions`、`lane-management` 等。它们的参数与放行清单不相交(`ps/shared/disabled-features.js` 的 `SUBAGENT_FEATURES`)。
  - `workflow-scripts` 这一组不建议关:关了之后 `tasks` / `chain` 的项 schema 只收 `agent` / `task`(`additionalProperties: false`,`ps/extension/schemas.js` 的 `StructuredTask`),而 `pinSubagentCall` 会给每一项加 `cwd`。执行器拒不拒收这一格,本次没有验证。
  - 需要另开一票,实测 token 变化与取证回归。

**不做**

- 调用 `bindExtensions` 让 pi-subagents 收到 `session_start`。理由:加载器那一侧它改变不了什么——加载器不在注册表里,`applyRecordedSelection` 在 `ps/extension/tool-activation.js:38` 就返回了。但它会触发 `npm root -g` 与全局 agent 发现(见 `pi-subagents-0.73-2026-09-30.md` 第 3 节),并开启执行器预加载与升级提示两条路径。这会放开现在依赖的收窄,换不来任何东西。
