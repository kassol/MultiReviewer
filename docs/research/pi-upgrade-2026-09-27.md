# pi-subagents 0.70.1 → 0.71.0 跟进(2026-09-27)

当前钉法:`@earendil-works/pi-coding-agent ^0.87.1`、`pi-subagents 0.70.1`(`package.json:22,25`)。Pi 0.87.1 已是最新版,不在本次范围。npm 上的 pi-subagents:0.70.1 发布于 2026-09-21T07:14Z,0.71.0 发布于 2026-09-23T07:16Z(`npm view pi-subagents time`)。上游仓库是 `https://github.com/nicobailon/pi-subagents`(npm 元数据的 `repository` 字段)。

来源:`npm pack` 两版解包后逐文件 diff(`diff -rq` 共 209 项差异,去掉 `.map` / `.d.ts` / 文档后约 50 个 `.js`),加 0.71.0 包内 `CHANGELOG.md` 的 `[0.71.0] - 2026-09-23` 一节。另外用解包的 0.71.0 加本仓库现有的 `node_modules` 跑了一次探针,专门验证下文第 1 节那道闸门。**没有升级依赖,没有跑 typecheck,也没有跑真实 SDK 回归**。结论基于读包和一次探针。

## 结论

可以直接升级,不需要改源码。唯一有实质影响的变更是 `subagent` 工具改为按需加载(下文第 1 节)。在本项目的运行方式下,它被两道判定挡住:一道经探针验证,另一道只读过代码。取证与会话子代理用到的其余接口在两版之间没有改动。需要做的只是改依赖钉法和 AGENTS.md 里的版本号。另外建议把一条回归断言收紧。

## 1. 按需加载 `subagent`(0.71.0 Changed)

**变更内容。** CHANGELOG 0.71.0 Changed 写道:"The full `subagent` tool stays hidden until a request activates it through the small `subagents_enable` loader"。实现在新文件 `src/extension/tool-activation.js`,由 `src/extension/index.js` 在注册完 `subagent` 之后调用 `registerSubagentToolActivation`(diff 只有这一处接线,见 `index.js` 第 58 行与第 1107–1109 行)。文档 `docs/configuration.md:81` 说:在 Pi 0.86.1 及以上,新建的无限制父会话一开始只激活 `subagents_enable`,`subagent` 虽已注册但不激活。

本项目依赖父会话里始终有 `subagent`:工具清单写死了它(`src/reviewer/worker.ts:79`、`src/reviewer/session-worker.ts:340`),系统提示也直接写「call the subagent tool」(`worker.ts:89`)。如果这个工具被藏起来,取证和会话子代理都会失效。

**第一道判定:主机验证失败,`subagent` 仍然直接可用(已用探针验证)。** `registerSubagentToolActivation` 先调用 `unsupportedDynamicToolsReason`(`tool-activation.js:113-120`)。只要这里返回了拒绝原因,它就只打印一行警告然后 `return`,不注册加载器,也不隐藏任何工具。拒绝原因来自 `probeHostPiVersion`(`:31-45`):只有 `resolveRunningPiPackageRoot` 找到当前宿主的 Pi,才会继续比较版本。这个查找按以下顺序进行(`src/runs/shared/pi-spawn.js:60-97`):

1. 从 `process.argv[1]` 逐级向上找,找到 `name === "@earendil-works/pi-coding-agent"` 的 package.json 为止;
2. 环境变量 `PI_PACKAGE_DIR`;
3. 环境变量 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`;
4. Bun 编译产物的虚拟路径。

本项目的 Reviewer 子进程与会话子进程,`argv[1]` 分别是 `src/reviewer/worker.ts` 和 `src/reviewer/session-worker.ts`。向上找到的是本仓库的 package.json,`name` 是 `multireviewer`(`package.json:2`),不匹配。子进程的环境变量照搬父进程,只剥掉凭据类变量(`src/reviewer/env.ts`),而镜像和 compose 都不设 `PI_PACKAGE_DIR`(`Dockerfile`、`docker-compose.yml` 中都 grep 不到)。Pi 0.87.1 只读取 `PI_PACKAGE_DIR`,不会自己设置它(`dist/config.js:313`)。

探针的做法:把 0.71.0 的 `tool-activation.js` 接到本仓库的 `node_modules` 上,调用 `unsupportedDynamicToolsReason`。结果如下:

- `argv[1]` 为 `worker.ts` 或 `session-worker.ts` 时,都返回 `"Could not verify the running Pi installation; …/pi-coding-agent is not confirmed to be the host that owns this session"`,即拒绝,`subagent` 保持直接可用。
- 手动设 `PI_PACKAGE_DIR=<pi-coding-agent 目录>` 后,返回 `undefined`,即闸门放行。

结论:在当前部署形态下,闸门失败时保持原行为,和 0.70.1 一样。

**第二道判定:即使闸门放行,工具白名单也会让 `subagent` 保持可见(只读过代码,没有实际运行)。** 这一道只在第一道放行时才起作用,比如有人设了 `PI_PACKAGE_DIR`。依据如下:

- `applyRecordedSelection` 和 `before_agent_start` 都先检查 `pi.getAllTools()` 里有没有 `subagents_enable`,没有就直接返回(`tool-activation.js:102`、`:163`)。
- Pi 0.87.1 的 `getAllTools()` 读的是 `_toolDefinitions`(`dist/core/agent-session.js:896-904`)。这个表在 `_refreshToolRegistry` 里已经按 `allowedToolNames` 过滤过(`:2494-2512`)。
- `allowedToolNames` 就是 `createAgentSession` 的 `tools` 选项(`dist/core/sdk.js:142`)。
- 本项目的 `tools` 白名单里没有 `subagents_enable`(`worker.ts:64-83`、`session-worker.ts:340`)。

所以加载器会被白名单滤掉,`subagent` 也不会被藏起来。上游文档 `docs/configuration.md:83` 的说法一致:"If Pi's allowlist or exclusions remove the loader, the extension does not hide `subagent`"。

**附带影响:服务日志里会多一行警告。** 第一道闸门拒绝时,`console.warn("[pi-subagents] … keeping subagent eagerly available.")` 在每个进程里打印一次(`tool-activation.js:115-118`,由模块级变量 `warnedUnsupportedHost` 控制)。Reviewer 子进程和会话子进程的 stderr 都会进入服务日志(`src/reviewer/subprocess.ts:92`、`src/webhook/agent-session.ts:1168`)。因此每个「批次 × 模型」和每个常驻会话子进程都会多出一行。这只是日志噪声,不影响行为。

## 2. 本项目各依赖点对照

| 本项目依赖的点 | 本项目代码位置 | 0.71.0 的情况 | 结论 |
|---|---|---|---|
| 前台取证子会话,在 Reviewer 子进程内运行 | `evidence.ts:22-26`,`worker.ts:639-643` | `src/runs/shared/child-session.js` 在两版之间没有差异。`runs/foreground/execution.js` 的改动只涉及流式 `progress` 的用量计数和 `structured_output` 的失败归因(见下两行),`subagent-executor.js` 的改动集中在 async / workflow / resume 路径 | 不受影响 |
| 只读四件套、唯一 agent `evidence`、禁止再派子代理 | `evidence.ts:218-238`,`evidence.ts:105-115`;会话子代理见 `session-subagent.ts:51-70` | `agents/agents.js`、`runs/shared/child-tool-plan.js` 没有差异;`agents/worker.md` 改为默认 fresh context,但内置 agent 已由 `disableBuiltins` 全部关掉(`evidence.ts:292-295`)。`agents/skills.js` 新增的 `disable-model-invocation` 过滤只作用于子代理的 skill 注入,而两份 agent 定义都写了 `inheritSkills: false` | 不受影响 |
| 能力天花板的登记接口 `pi-subagents/capability-ceiling` | `evidence.ts:50-53`,`:132-142` | `src/api/capability-ceiling.js` 与 `src/runs/shared/capability-ceiling.js` 没有差异。package.json 只改了 `version` 和 pi-ai 的 peer 版本范围,`exports` 没变 | 不受影响 |
| 钉死 `intercomBridge` / `async` / `agentScope` / `cwd`,并在各层钉 cwd | `evidence.ts:355`,`:429-461`;`config.json` 的写入在 `:302-306` | `extension/config.js`、`extension/schemas.js` 没有差异。`intercom/intercom-bridge.js` 只加了一行注释。新增的 `intercom:session-identity` 认领(`subagent-prompt-runtime.js:526-538`)与子会话命名,只在桥开着、`intercomSessionName` 有值时才生效,本项目桥是关的 | 不受影响 |
| 剥掉清单外的参数键后放行(#404),拦下 `action: "list"` | `evidence.ts:367-390`,`:490-495` | 工具 schema 文件 `extension/schemas.js` 没有差异,放行清单里的键仍然都存在。加载器的返回文字会引导模型调用 `subagent({action:"list",capabilities:true})`(`tool-activation.js:153`),但加载器在本项目里不会出现(第 1 节);就算出现,这一类调用也会被 `:490` 拦下并告诉模型该怎么调 | 不受影响 |
| 会话子代理的 transcript 当场落库 | `session-subagent.ts:127-195`,`evidence.ts:515-523`、`:551-634` | 写 transcript 的 `src/shared/child-transcript.js` 没有差异。`details.results[].transcriptPath / finalOutput / error / exitCode / index` 的组装未改。流式 `progress` 新增一格 `turnCount`(`execution.js:210`),本项目只读 `progress.toolCount` | 不受影响 |
| 子会话用量并入父会话统计,本项目不重复累加(#260) | `evidence.ts:35-37` | `withAggregatedToolUsage` 只在 `subagent-executor.js` 中出现,它所在的代码没有进入 diff。0.71 把「provider 没给的缓存数字」从按 0 计改成不计(`execution.js:380-418`,CHANGELOG Fixed "no longer count missing provider cache numbers as zero"),这只影响流式 `progress` 里的 `inputTokens` / `outputTokens` / `cacheRead` / `cacheWrite` 投影,本项目不读这几个字段 | 不受影响 |
| 每批每模型的取证上限(默认 3)与单次调用的扇出上限 8 | `evidence.ts:73-79`,`:316-318` | 读取这两个环境变量的 `src/shared/types.js` 只新增了 `INTERCOM_SESSION_IDENTITY_EVENT` 常量,`resolveMaxSubagentSpawnsPerRun` 等函数没改 | 不受影响 |
| 父子通话工具默认关闭 | `evidence.ts:300-306`,`:355` | 同上一行「钉死 intercomBridge」:桥的开关与判定没有改 | 不受影响 |
| 模型排除表 | ADR 0021 在 2026-09-15 的修订 | 0.68 已删除,0.71 没有加回来(包内 grep 不到 `PI_MODEL_EXCLUSIONS_PATH`) | 不受影响 |
| 超时后停止请求 | `test/reviewer-evidence-session.test.ts:420-460` | `child-session.js` 没有差异,`execution.js` 的中止路径没改。唯一新增的是 structured output 失败时保留证据,本项目不用 structured output | 不受影响 |

## 3. 依赖变化

- `dependencies` 两版逐项相同:`jiti 2.7.0`、`yaml 2.8.3`、`acorn 8.18.0`、`undici 8.10.0`、`typebox 1.1.38`(`npm view pi-subagents@0.70.1 / @0.71.0 dependencies`)。**不会带回 `pi-server`**。
- `peerDependencies` 只有一处变化:`@earendil-works/pi-ai` 从 `>=0.80.0` 收紧到 `>=0.86.1`(包内 `package.json:28`,CHANGELOG Changed)。它仍是可选 peer,本项目装的是 0.87.1,满足要求。其余三个 peer 仍为 `*`。
- 新增的 `tool-activation.js` 在模块顶层 `import * as piAi from "@earendil-works/pi-ai"`(第 3 行)。0.70.1 的 `watchdog/review.js` 与 `watchdog/permission-arbiter.js` 本来就在顶层导入 pi-ai,所以这不是新的加载要求。它用的是命名空间导入,pi-ai 缺少 `getCurrentTools` 也不会在加载时报错(`:14` 会在运行时再判断)。
- `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 目前写的是 `pi-subagents@0.70.1`(`:23`,注释在 `:13`)。0.71.0 距今已超过 24 小时,不需要豁免;这一行和对应注释可以删掉,也可以改成 0.71.0。

## 4. 其余改动与本项目无关

- 进程内 RPC 新增 `cost` 方法和 `/subagent-cost` 数据化(`extension/rpc.js`、`slash/subagent-cost.js`)。本项目不调用 RPC。
- async `workflowScript` 的生命周期事件、`workflowTerminalProof`、容量槽回收,以及后台 runner 不再继承 `GIT_*` 变量(`runs/background/*`、`external-cli-runner.js`)。本项目一律前台执行,`async` 固定为 false,`workflow*` 参数会被剥掉。
- watchdog(`watchdog/*`)、MCP 直连工具命名(`mcp-direct-tool-*`)、Fleet/TUI、prompt workflow 的软链接、Bun 与 pnpm 的 peer 别名。本项目都没用到。
- 包自带的 `skills/pi-subagents/references/*` 有三个文件改了措辞(worker 默认 fresh、children.list 不完整、RPC 方法表)。在 Agent 会话里,这份 skill 仍会列进 `<available_skills>`,正文按需读取,对行为没有影响。
- CHANGELOG 最后一条 "Forked sessions keep Pi 0.87 context edits" 对应 `shared/pruned-fork.js` 与 `fork-context.js`。本项目的子代理不用 fork 上下文。

## 建议

**值得做**

- 升到 pi-subagents 0.71.0。理由:第 2 节列出的依赖点都没有改动,按需加载在本项目里有两道判定挡住;同时 peer 版本范围明确承认了 Pi 0.86.1+,正好覆盖当前的 0.87.1。改动量:`package.json:25` 一行,删除或更新 `pnpm-workspace.yaml:13,23`,重新生成 lockfile;同步修改 AGENTS.md「技术栈」那一段写着 0.70.1 的地方。源码预计不用改。
- 升级后跑 `pnpm check`,重点关注 `test/reviewer-evidence-session.test.ts` 与 `test/agent-session-subprocess.test.ts` 这两条真实 SDK 回归。理由:它们断言的是模型请求实际带上的工具清单。会话那条是整份精确比对(`agent-session-subprocess.test.ts:96`),`subagents_enable` 一旦出现就会失败。改动量:只需跑测试。
- 把 `test/reviewer-evidence-session.test.ts:144` 从 `includes(SUBAGENT_TOOL)` 收紧,增加一条「父会话工具清单里没有 `subagents_enable`」的断言。理由:Reviewer 这一侧目前只检查 `subagent` 在清单里,检查不出加载器混进来。这正是 0.71 新增的风险,而第二道判定目前只读过代码,没有用真实运行验证。改动量:1–2 行断言。

**可选**

- 在 AGENTS.md「部署」或 `src/AGENTS.md` 取证那一条补一句:不要给容器设 `PI_PACKAGE_DIR`。理由:设了会让第一道闸门放行,加载器就会注册;那时只剩白名单这一道判定在起作用。改动量:一句文档。

**不做**

- 设法消掉每个子进程那一行警告(比如设 `PI_PACKAGE_DIR` 让闸门放行)。理由:放行之后加载器会注册,本项目反而要依赖白名单那一道判定。这行警告不影响行为。
