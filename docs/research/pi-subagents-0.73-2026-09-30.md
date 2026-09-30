# pi-subagents 0.71.0 → 0.73.1 跟进(2026-09-30)

当前钉法:`@earendil-works/pi-coding-agent ^0.87.1`、`pi-subagents 0.71.0`、`typebox ^1.3.11`(`package.json:22,25,26`)。npm 上的发布时刻(`npm view pi-subagents time`):0.72.0 为 2026-09-27T03:03Z,0.72.1 为 03:58Z,0.73.0 为 14:56Z,0.73.1 为 19:08Z。上游仓库是 `https://github.com/nicobailon/pi-subagents`(npm 元数据的 `repository.url`)。

来源:

- `npm pack` 取 0.71.0 与 0.73.1,解包后逐文件 diff。`diff -rq` 去掉 `.map` / `.d.ts` 后有 50 个文件不同,另有 4 个新文件。
- 0.73.1 包内 `CHANGELOG.md` 的 `[0.72.0]` 到 `[0.73.1]` 四节。
- 为判断与 Pi 0.99.1 的搭配,另 `npm pack` 了 `@earendil-works/pi-coding-agent@0.99.1`,核对 pi-subagents 用到的导出与事件。
- 一次探针:把 0.73.1 的 `tool-activation.js` 接到本仓库 0.71.0 那一层的 `node_modules` 上运行。
- 两次 `pnpm install --lockfile-only`:在临时目录里复制 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml` 与 `web/package.json` 后运行。

**没有改本仓库依赖,没有跑 typecheck,也没有跑真实 SDK 回归**。结论来自读包、一次探针和两次临时锁文件解析。

## 结论

可以升到 0.73.1,不需要改源码。它能在 Pi 0.87.1 上用,也能与 Pi 0.99.1 搭配。

- 与本项目相关的实质变化只有一处:`typebox` 从 dependencies 挪到可选 peer。pnpm 会把它解析到本项目直接依赖的 typebox,见第 1 节。
- 按需加载 `subagent` 的宿主校验函数没有改,本项目的子进程里仍然认不出宿主,`subagent` 保持即时可用。已用探针验证,见第 2 节。
- 前台取证用到的其余接口(能力天花板、config、intercom、transcript、用量并入、spawn 预算)所在的文件在两版之间逐字相同。
- 另有一处顺带的行为变化:在本项目的子进程里,执行子代理时不再去扫全局 npm 包里的 agent。这是收窄,见第 3 节。

## 1. typebox 改为可选 peer(0.72.0 Changed)

**变更内容。**
- CHANGELOG 0.72.0 Changed:"TypeBox is now provided by Pi instead of bundled with the package"。
- 包内 `package.json` 从 `dependencies` 删掉 `"typebox": "1.1.38"`,在 `peerDependencies` 加 `"typebox": "*"`,并在 `peerDependenciesMeta` 里标成 `optional: true`。
- 包内仍有 13 处 `from "typebox"`、`"typebox/compile"` 与 `"typebox/value"` 导入,例如 `src/extension/tool-activation.js:3`。

**对本项目的影响(已用临时锁文件验证)。**
- 本项目直接依赖 `typebox ^1.3.11`(`package.json:26`),锁文件里是 1.3.11。
- 只把 `pi-subagents` 改成 `0.73.1` 后跑 `pnpm install --lockfile-only`(pnpm 12.8.1),解析结果是 `pi-subagents@0.73.1(...)(typebox@1.3.11)`,可选 peer 取的是项目根上那一份。
- 原先 pi-subagents 自带的 `typebox@1.1.38` 从锁文件里消失(`grep -c` 为 0)。版本范围 `*` 当然满足。
- 各版本的使用情况:
  - Pi 0.87.1 自己的 pi-coding-agent / pi-ai / pi-agent-core 仍依赖 `typebox 1.3.27`(各包 `package.json`)。
  - 本项目的工具 schema 早就是用 1.3.11 构造、交给 Pi 用 1.3.27 校验,这条跨版本路径一直在跑(`src/reviewer/worker.ts:12` 等十个文件)。
  - pi-subagents 那侧从 1.1.38 换到 1.3.11,离 Pi 用的版本更近,没有更远。
- 本项目**不需要**为这一条改 `package.json`。可选收敛:把根上的 `typebox` 提到 `^1.3.27`,让整棵树只剩一份。这不是升级 pi-subagents 的前提。

## 2. 按需加载 `subagent`:宿主仍认不出,保持即时可用

- `src/runs/shared/pi-spawn.js`(`resolveRunningPiPackageRoot` 等)两版逐字相同。
- `tool-activation.js` 里的 `probeHostPiVersion` 与闸门判定没有改(`tool-activation.js:12-19,30-44`)。只有两处变化:
  - 删掉对 `piAi.getCurrentTools` 的探测。CHANGELOG 0.72.0 Fixed 写的是 "An older `pi-ai` installed next to the package no longer turns off on-demand tool loading"。
  - 加载器的参数不再拒收多余的键,返回文字多了一句说明。
- 探针结果与 0.71 那次相同:
  - `argv[1]` 为 `src/reviewer/worker.ts` 或 `src/reviewer/session-worker.ts` 时,返回 "Could not verify the running Pi installation; …/pi-coding-agent is not confirmed to be the host that owns this session",即拒绝,加载器不注册。
  - 手动设 `PI_PACKAGE_DIR` 后返回 `undefined`,即放行。
- 第二道判定(工具白名单滤掉 `subagents_enable`)同样没有被这次改动碰到。它只读 `pi.getAllTools()`,这部分逻辑没有变。
- 被删的那条 `getCurrentTools` 探测在 Pi 0.87.1 上本来就成立,删掉对本项目没有影响。
- 回归断言 `test/reviewer-evidence-session.test.ts:147`(父会话工具清单里没有 `subagents_enable`)继续有效。

## 3. 延迟加载与全局 agent 发现(0.72.0 Changed/Fixed)

**变更内容(`src/extension/index.js`):**
- 前台执行器改为第一次调用时再 `import`(`getExecutor`)。
- `session_start` 改为异步跑 `resolveGlobalNpmRoot()`(新文件 `src/agents/global-npm-root.js`,执行 `npm root -g`,超时 5 秒,任何失败都回 `null`)。
- `subagent` 的执行与 `before_agent_start` 都先 `await waitForAdvertisement()`。

**本项目的情形(只读过代码,没有运行验证):**
- Pi 0.87.1 只在 `AgentSession.bindExtensions()` 里发 `session_start`(`dist/core/agent-session.js:2313`)。本项目 `src/` 里没有任何一处调用 `bindExtensions`(grep 为空),Reviewer 与会话子进程因此收不到 `session_start`。由此推出三点:
  - `advertisementReady` 与 `sessionChanged` 都停在初值 `Promise.resolve()`,`waitForAdvertisement` 立即返回,不增加等待。
  - `npm root -g` 不会在启动时执行。
  - `discoverAgentsForRuntime` 传下去的 `globalNpmRoot` 是初值 `null`(`index.js` 里的 `let globalRoot = null`)。`collectPackageSubagentPaths` 见到非 `undefined` 就不再调 `getGlobalNpmRoot()`(`src/agents/agents.js:357`)。
- 行为差异:0.71 在第一次派子代理时会同步执行一次 `npm root -g`(0.71 `agents.js:212` 的 `execSync`),并把全局 npm 包里的 agent 纳入发现。0.73.1 在本项目里跳过这两步。
- 对本项目的影响:发现范围早已钉成 `agentScope: "user"`(`src/reviewer/evidence.ts:437`),能力天花板也只放行一个 agent 名。这一变化只会让子进程少读宿主机的全局包,是收窄。第一次派单还省掉一次子进程调用。
- 首次调用多一次动态 `import` 执行器模块,只发生一次。

## 4. 广告目录改走结构化提示段(0.73.1 Fixed)

- 0.73.1 不再用 `before_agent_start` 返回 `{ systemPrompt }`。0.71 的这种写法在 Pi 0.87.1 里会被设成 `forceSystemPrompt`(`dist/core/extensions/runner.js:1042-1044`)。
- 新写法是:在 `event.systemPromptOptions.selectedTools` 含 `subagent` 时写 `event.systemPromptOptions.sections.advertised_subagents`。
- Pi 0.87.1 已提供这两格:`normalizeBuildSystemPromptOptions` 返回的对象里 `selectedTools` 与 `sections` 恒存在(`dist/core/system-prompt.js:13,18`)。Pi 0.99.1 的同一文件同一行也是这样。
- 对本项目:
  - 我们的 agent 定义不写 `advertise`(`src/reviewer/evidence.ts:224-238`),内置 agent 已全部禁用。
  - 第 3 节已说明,`advertisedContext` 在我们的进程里从不被设置,目录恒为空,这一段不会出现。
  - 系统提示与 Agent 会话记录里的系统提示条目不受影响。

## 5. 本项目各依赖点对照

| 本项目依赖的点 | 本项目代码位置 | 0.73.1 的情况 | 结论 |
|---|---|---|---|
| 前台取证子会话,在 Reviewer 子进程内运行 | `src/reviewer/worker.ts:726,744`,`src/reviewer/session-worker.ts:303` | `runs/shared/child-session.js` 只多一个 `contextWindow` getter。`runs/foreground/execution.js` 没有差异。执行器改为延迟 `import`(第 3 节) | 不受影响 |
| 只读四件套工具面、唯一 agent `evidence` 与会话子代理 agent | `src/reviewer/evidence.ts:105-115,218-238`,`src/reviewer/session-subagent.ts` | `runs/shared/child-tool-plan.js` 只改了 `fast` 模式的模型判定。`agents/agents.js` 只加了 `globalNpmRoot` 参数。agent 定义解析与 `disableBuiltins` 没有改 | 不受影响 |
| 能力天花板登记接口 `pi-subagents/capability-ceiling` | `src/reviewer/evidence.ts:50-53,132-142` | `src/api/capability-ceiling.js` 与 `src/runs/shared/capability-ceiling.js` 没有差异。`package.json` 的 `exports` 只新增 `./inspectors`。执行器改为在 fork 之前先判天花板(CHANGELOG 0.72.0 Fixed "fails before any fork work starts"),本项目不用 fork | 不受影响 |
| `pinSubagentCall` 钉死 `intercomBridge` / `async` / `agentScope` / `cwd` 与各层 cwd,`config.json` 铺装 | `src/reviewer/evidence.ts:302-306,355,429-461` | `extension/config.js`、`intercom/intercom-bridge.js` 没有差异。`native-supervisor-channel.js` 只改 `pending` 的显示。`extension/schemas.js` 只改四处 description,并给 `usageBudget` 加 `minProperties: 1` | 不受影响 |
| 清单外键剥离,拦下 `action: "list"` | `src/reviewer/evidence.ts:367-390,490-495` | schema 没有新增或删除任何键,放行清单里的键全部还在。新增的执行前校验:`timeoutMs` / `maxRuntimeMs` 大于 2147483647 时直接拒绝(CHANGELOG 0.73.0 Fixed)。二者同时给出且不相等时拒绝,这一条 0.71 已有(0.71 `subagent-executor.js:2505`) | 不受影响 |
| 工具描述要求「先 list」 | 系统提示 `src/reviewer/worker.ts:93`、`src/reviewer/session-worker.ts:182` | `extension/tool-description.js` 没有差异,`AGENT_SELECTION_GUIDANCE` 仍写 'First call {action:"list",capabilities:true}'(`tool-description.js:6`)。加载器的返回文字仍引导先 list(`tool-activation.js:163`),但加载器在本项目里不注册 | 两处系统提示里那句仍然需要 |
| `subagents_enable` 懒加载与宿主校验 | `test/reviewer-evidence-session.test.ts:145-147` | 见第 2 节:仍然认不出宿主,保持即时可用 | 不受影响 |
| transcript 路径与格式 | `src/reviewer/evidence.ts:515-523,551-653`,`src/reviewer/session-worker.ts:370-384` | `shared/child-transcript.js` 没有差异。执行器里 `transcriptPath` 的组装位置没有改(0.71 `subagent-executor.js:465,549,1912,2853`) | 不受影响 |
| 子会话用量并入父会话,本项目不重复累加 | `src/reviewer/evidence.ts:35-37` | `withAggregatedToolUsage` 函数体逐字相同,只是行号从 2611 移到 2708 | 不受影响 |
| 取证会话上限(默认 3)与单次调用的扇出上限 8 | `src/reviewer/evidence.ts:73-79,316-318` | 读这两个环境变量的 `src/shared/types.js` 没有差异 | 不受影响 |
| 父子通话工具默认关闭 | `src/reviewer/evidence.ts:300-306,355` | 桥的配置与判定没有改,见上面钉死参数那一行 | 不受影响 |
| 模型排除表 | ADR 0021 在 2026-09-15 的修订 | 0.68 已删除,本次没有加回 | 不受影响 |
| 超时后停止请求 | `test/reviewer-evidence-session.test.ts` 超时用例 | `child-session.js` 的中止路径与 `execution.js` 都没有改 | 不受影响 |
| `model: inherit` | `src/reviewer/evidence.ts:230` | `runs/shared/model-resolution.js` 只在模糊匹配失败后多试一次「id 自带 provider 前缀」 | 不受影响 |

## 6. 与 Pi 的搭配

**Pi 0.87.1(当前):**
- peer 范围 `@earendil-works/pi-ai >=0.86.1` 没有变,0.87.1 满足。
- 第 2 到 4 节用到的 Pi 能力在 0.87.1 里都有:`systemPromptOptions.sections`、`getAllTools` / `getActiveTools` / `setActiveTools`,以及 `pi.getThinkingLevel`(`dist/core/extensions/loader.js:328`,只供 TUI 取颜色)。
- 临时锁文件解析通过,只多一份 `typebox@1.3.11` 的 peer 实例,没有出现第二份 Pi 包。

**Pi 0.99.1:**
- 0.99.1 的 pi-coding-agent 仍依赖 `typebox 1.3.27`,pi-ai 版本满足 `>=0.86.1`。
- pi-subagents 用到的 SDK 导出在 0.99.1 的 `dist/index.js` 里全部存在:`createAgentSession`、`DefaultResourceLoader`、`SettingsManager`、`SessionManager`、`ModelRuntime`、`convertToLlm`、`createReadOnlyTools`、`keyText`、`getMarkdownTheme`、`highlightCode`、`getLanguageFromPath`、`DynamicBorder`、`keyHint`、`rawKeyHint`。
- `before_agent_start` 的 `systemPromptOptions` 形状与 `selectedTools` 的处理与 0.87.1 相同(0.99.1 `dist/core/system-prompt.js:12,18`,`dist/core/agent-session.js:1523-1529`)。
- `getAllTools`、`setActiveTools` 仍然在(0.99.1 `dist/core/extensions/loader.js:125,127`)。

判断:接口层面兼容。本次**没有**核对 Pi 0.87→0.99 在 `tool_call` 钩子、`getSessionStats` 与会话条目上的语义变化,那部分由 Pi 升级的调研负责。本项目的契约扩展与用量口径都依赖这几处。

**搭配 0.99.1 时锁文件上要注意一点(已用临时锁文件验证):**
- 在现有锁文件上只把 pi-coding-agent 改成 `^0.99.1` 再 `--lockfile-only`,pi-subagents 的可选 peer 仍解析到旧的 `pi-ai@0.87.1`。树里 `pi-ai`、`pi-agent-core`、`pi-tui` 各有 0.87.1 与 0.99.1 两份,与 issue #265 那次同一种症状。
- 删掉锁文件重新解析时,各 Pi 包只剩一份(0.99.1)。但根上的 `typebox` 也跟着浮到了 `1.3.34`。
- 两者一起升时照 #265 的办法做:`pnpm update "@earendil-works/*"` 让 peer 重解到一份,不要删锁文件整份重来。

## 7. 其余改动与本项目无关

- workflow(`failureKind`、输出截断、脚本里拼错 agent 名时提前失败)、async / external-job / 后台 runner、Fleet 与 inspector 插件、watchdog 与 permission 的模型查找、`/subagent-cost`、`/council` 改走 `guide`、`fast` 模式、spinner 配色。
- 这些是 `runs/background/*`、`workflows/*`、`tui/*`、`inspectors/*`、`watchdog/*`、`slash/*` 与 `extension/subagent-guide.js` 的改动。本项目一律前台执行,`async` 固定为 false,`workflow*` 参数会被剥掉,也没有 UI。
- 包自带 skill 的 `references/execution-controls.md` 改了措辞。在 Agent 会话里它仍会列进 `<available_skills>`,正文按需读取,不影响行为。

## 建议

**值得做**

- 升到 pi-subagents 0.73.1。理由:第 5 节的依赖点都没有改动,懒加载的闸门仍然拒绝,typebox peer 由项目根上那份满足。
  - 改动:`package.json:25` 一行,重新生成 lockfile。
  - 同步修改根 `AGENTS.md`「技术栈」段里的 `pi-subagents 0.71.0`。
  - `pnpm-workspace.yaml:14` 那句「pi-subagents 0.71.0 升级时已过窗口」改成 0.73.1。0.73.1 发布已超过 24 小时,不需要豁免。
- 升级后跑 `pnpm check`,重点看 `test/reviewer-evidence-session.test.ts` 与 `test/agent-session-subprocess.test.ts` 两条真实 SDK 回归。理由:第 3 节「收不到 `session_start`」与第 2 节第二道判定都只读过代码或只做了探针,真实运行才能坐实。
- 根 `AGENTS.md` 技术栈段补半句:`typebox` 也是 pi-subagents 的 peer,由项目根的那一份提供。理由:删掉根上的 `typebox` 会让 pi-subagents 找不到它,而它是可选 peer,pnpm 不会报错。

**可选**

- 把根 `typebox` 提到 `^1.3.27`,与 Pi 用同一份。改动是 `package.json:26` 一行。这件事与本次升级无关,可以随 Pi 升级一起做。

**不做**

- 调用 `bindExtensions` 或设 `PI_PACKAGE_DIR` 来让 pi-subagents 的发现与懒加载「正常工作」。理由:两者都会放开本项目现在依赖的收窄(全局 agent 不进发现、加载器不注册)。
