# pi-subagents 0.74.0 → 0.75.0 跟进(2026-10-04)

当前钉法:`pi-subagents 0.74.0`、`@earendil-works/pi-coding-agent ^0.99.2`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `6f7c885`)。pi-subagents 0.75.0 发布于 2026-10-02T20:27:45.883Z,是 `latest`(`npm view pi-subagents time dist-tags`)。

## 来源

- `npm pack pi-subagents@0.74.0 pi-subagents@0.75.0`,解包后 `diff -rq`(去掉 `.map`):73 个文件有差异,新增 4 个文件(`src/runs/foreground/command-action.{js,d.ts}`、`src/runs/shared/child-commands.{js,d.ts}`),没有删除。逐文件 `diff`。
- 包内 `CHANGELOG.md` 的 `[0.75.0] - 2026-10-02`:Added 5 条、Changed 1 条、Fixed 21 条,另有 5 条 Highlights。
- 上游 release notes:`gh api repos/nicobailon/pi-subagents/releases/tags/v0.75.0`(发布于 2026-10-02T20:28:54Z)。CHANGELOG 的 32 条逐字都在其中。release notes 多一段导语,并把 5 条 Highlights 换了措辞重述一遍,没有 CHANGELOG 之外的新内容。
- 工具声明体积是实测:把 scratchpad 的 `node_modules` 软链到本项目已装的那份依赖(Pi 0.99.2),直接 import 两版包内的 `createSubagentParamsSchema` 与 `buildSubagentToolDescription`。没有安装任何包。
- **没有做的事**:没有试装,没有跑测试,没有跑 `pnpm` 的 lockfile 校验。这三样由并行的试装任务负责。下文凡是依赖实跑的结论都标「未验证」。

下文 `ps/` = `pi-subagents/src/`,行号均指 0.75.0。「SAME」指下面这条命令判定两版逐字节相同:

```
cmp -s 0.74.0/<文件> 0.75.0/<文件>
```

SAME 的文件:`ps/api/capability-ceiling.js`、`ps/runs/shared/capability-ceiling.js`、`ps/shared/child-transcript.js`、`ps/extension/tool-result.js`、`ps/intercom/intercom-bridge.js`、`ps/extension/tool-activation.js`、`ps/shared/disabled-features.js`、`ps/shared/extension-context.js`、`ps/runs/shared/child-launch.js`、`ps/extension/upgrade-notice.js`、`ps/extension/control-notices.js`、`ps/runs/shared/tool-timeout.js`、`ps/runs/shared/pi-spawn.js`、`ps/shared/utils.js`、包根 `index.js`。`skills/`、`prompts/`、`agents/` 三个目录 `diff -rq` 无差异。

## 结论

能直接升,源码不改。0.75.0 不要求 Pi 1.x:peer 声明与 0.74.0 逐项相同,可以留在 Pi 0.99.2 上单独升,也可以与 Pi 1.x 一起升。

本项目依赖的每一处(能力天花板、`config.json`、放行清单、工具面、子会话工具面、transcript、用量、两个上限环境变量、intercom 桥、加载器)在 0.75.0 里语义都没变。唯一摸得到的变化是 `subagent` 工具声明多 347 个字符(18,155 → 18,502,约 1.9%),每个 Reviewer 请求与会话请求都带这份声明。

顺带核出一处旧表述偏差(第 4 节末尾):上一份笔记写「顶层 schema 里放行清单那几格都还在」,其中 `tasks` / `chain` / `concurrency` / `intercomBridge` 四格在默认配置的 schema 里并没有声明,`tasks` / `chain` / `concurrency` 在默认配置下还会被执行器打回。这一点 0.71.0 起就是这样,与本次升级无关。

## 1. CHANGELOG `[0.75.0]` 逐条

Highlights 的 5 条是下面 A1、F1、F4、F5/F6、F2 的重述,不单列。

### Added

| # | 条目 | 判定 | 依据 |
|---|---|---|---|
| A1 | 内置 `claude-code` / `claude-code-writer` 可按次选模型与 effort | 不受影响 | 只动外部 CLI 适配器(`ps/agents/agents.js:1833-1837`、`ps/runs/shared/claude-code-adapter.js`)。本项目禁用内置 agent(`src/reviewer/evidence.ts:292-295`),天花板只放行自家 agent 名(`:105-115`) |
| A2 | `command.status` / `command.yield` / `command.cancel` 与子会话工具 `subagent_command` | 只影响声明体积 | 运行时只在子会话的 `tools` 同时含 `bash` 与 `subagent_command` 时才建(`ps/runs/shared/child-session.js:322-326`)。本项目两个 agent 的 `tools` 是只读四件套(`src/reviewer/evidence.ts:227`、`src/reviewer/session-subagent.ts:60`)。三个新 action 进了 `SUBAGENT_ACTIONS`(`ps/shared/types.js:129`),新增顶层参数 `toolCallId`(`ps/extension/schemas.js:165`),工具描述多一句(`ps/extension/tool-description.js:21`)。`action` 与 `toolCallId` 都不在放行清单里(`src/reviewer/evidence.ts:367-380`),会被剥掉 |
| A3 | `registerRequiredChildExtensions` 的 `requireForAllRunners` | 不受影响 | 本项目不调用这个接口(`grep -rn 'registerRequiredChildExtensions\|required-child-extensions' src test` 为空)。没有带该标记的条目时 `assertRequiredChildExtensionsAdmitted` 直接返回(`ps/shared/required-child-extensions.js:82-85`) |
| A4 | `schedule.create` 收 `missionId` | 不受影响 | 管理动作。`action` 被剥,剥完没有可派的东西即拦下(`src/reviewer/evidence.ts:490-495`) |
| A5 | `asyncWidgetCollapsed` 配置 | 不受影响 | 只在设了这一格时校验(`ps/extension/config.js:188-190`),作用于 UI 小部件(`ps/extension/index.js:257,423`)。本项目不写这一格,也没有 UI |

### Changed

| # | 条目 | 判定 | 依据 |
|---|---|---|---|
| C1 | CI 对 Pi `0.86.1` 与 `1.0.0` 各跑一次干净安装测试 | 信息 | 说明上游同时支持这两端。本项目的 0.99.2 落在两者之间,上游没有单独测 |

### Fixed

| # | 条目 | 判定 | 依据 |
|---|---|---|---|
| F1 | Pi 1.0.0 上后台子代理起不来(`pi-agent-core/node` 不存在) | 不受影响 | 只在后台 runner 的别名表里(`ps/runs/background/runner-aliases.js:19-20,146-148`)。本项目一律前台:`asyncByDefault: false`(`src/reviewer/evidence.ts:305`)、调用参数钉 `async: false`(`:355`)、frontmatter `async: false`(`:229`) |
| F2 | 配置值非法时不再静默丢掉 `authorityPolicy` / `permissions` / `toolBudget` | 不受影响 | 这三键加进了「校验失败即拒载」的键表(`ps/extension/config.js:16,245`)。本项目的 `config.json` 只写 `asyncByDefault` 与 `intercomBridge`,两键的校验没有变 |
| F3 | 必需子扩展在 `session_start` 抛错即中止派出 | 不受影响 | 只收集 `requiredPaths` 里的路径(`ps/runs/shared/child-session.js:384,432-456`),它来自 `registerRequiredChildExtensions`。本项目的 `<agent>-tools.ts` 经 frontmatter 的 `extensions:` 进来(`src/reviewer/evidence.ts:228`),属于普通扩展。CHANGELOG 明说普通扩展不变 |
| F4 | Windows 上 npm 装的外部 CLI 起不来 | 不受影响 | 外部 CLI 路径(`ps/runs/shared/external-cli-preflight.js`、`external-cli-runner.js`)。本项目不用外部 runner,镜像是 Linux |
| F5 | 子会话起在扩展注册的虚拟模型上 | 不受影响 | 建子会话时多冲一遍 `pendingVirtualModelRegistrations`(`ps/runs/shared/child-session.js:222-244`)。本项目的子会话扩展只注册工具(`src/reviewer/evidence.ts:258-266`),队列为空,循环不执行。Pi 0.99.2 有这条队列(`grep -l pendingVirtualModelRegistrations node_modules/@earendil-works/pi-coding-agent/dist/core/*.js` 命中 `agent-session-services.js` 等) |
| F6 | 虚拟模型的 `model_verification_failed` | 不受影响 | 新分支只在子会话模型的 `api === "pi-virtual"` 时生效(`ps/runs/shared/child-session.js:505`、`ps/runs/shared/model-resolution.js:13-15`、`ps/runs/foreground/execution.js:1035`)。本项目写给子会话的模型 `api` 取自运行模型(`src/reviewer/evidence.ts:159`),不会是 `pi-virtual` |
| F7 | 后台 chain 的 `expand` 步跑外部 CLI agent | 不受影响 | 后台路径(`ps/runs/shared/dynamic-fanout.js:16`) |
| F8 | 保存内置 agent 覆盖时原子写 settings | 不受影响 | 由管理动作触发(`ps/agents/agents.js:661-719`)。`action` 被剥 |
| F9 | Codex 子会话保留 `call_id\|item_id` 形式的工具调用 id | 不受影响 | 只在子会话模型 `api === "openai-codex-responses"` 时生效(`ps/runs/shared/subagent-prompt-runtime.js:250-258,528`)。`src/` 里没有这个 api(`grep -rn openai-codex-responses src` 为空) |
| F10 | 内建 MCP 的 `mcp:` 项里名字带 `-` | 不受影响 | 只在 agent 的 `tools` 有 `mcp:` 项时走到(`ps/runs/shared/mcp-direct-tool-allowlist.js:92,106`) |
| F11 | `workflow: "true"` 字符串当布尔处理 | 不受影响 | `workflow` 不在放行清单里(`ps/extension/public-execution.js:50-53`) |
| F12 | `action: "validate"` 按启动同一套上限查 `args` | 不受影响 | 管理动作 |
| F13 | 每个开着超过阈值的工具调用都通知父会话,原先每个子会话只通知第一个 | 前台路径上走得到,对本项目不可见 | 见本表下方说明 |
| F14 | 异步 run 写进 `run-history.jsonl` | 不受影响 | 新增的是后台那一支(`ps/runs/shared/run-history.js:126-195`)。前台记录没改,文件在会话自己的 agentDir 下(`:13`) |
| F15 | `/subagent-cost` 计入 resume 的每一轮 | 不受影响 | slash 命令与 RPC(`ps/slash/subagent-cost.js`) |
| F16 | `/subagent-cost` 不再每次打缺 receipt 的错 | 不受影响 | 同上 |
| F17 | 全局 mission 列表取各 mission 自己的记录 | 不受影响 | `ps/missions/store.js:550-560`。本项目不建 mission |
| F18 | headless 会话在收尾后台工作失败时仍投递 goal mission 通知 | 不受影响 | `agent_end` 处理器改了结构(`ps/extension/index.js:686-712`)。`drainOutstandingWork` 成功时的执行顺序与 0.74.0 相同;只有它 reject 时才多走一遍通知收集。mission 库在 agentDir 下(`ps/missions/store.js:263-271`),本项目没有 mission |
| F19 | 一个损坏的 mission 不再挡住其他 goal mission 的通知 | 不受影响 | `ps/missions/goal-driver.js:125-168` |
| F20 | Linux 上已退出未回收的 runner 进程不再让 run 停在 running | 不受影响 | 后台路径(`ps/runs/background/stale-run-reconciler.js`) |
| F21 | profile 里非法的 `machine` 在加载时拒绝 | 不受影响 | `ps/profiles/profiles.js:60-62`。本项目不用 profile |

**F13 的说明。** 它是 0.75.0 里唯一落在前台单次取证路径上的行为变化。
- 触发条件:子会话的某个工具调用开着超过 `activeNoticeAfterMs`,默认 240 秒(`ps/runs/shared/subagent-control.js:11,99`)。`read` / `grep` / `find` / `ls` 不在豁免表里(`ps/runs/shared/tool-timeout.js:15`),所以四件套的调用拖到 240 秒时会触发。
- 0.74.0 每个子会话只发第一次;0.75.0 每个工具调用各发一次(`ps/runs/foreground/execution.js:766,798,842-850`)。
- 事件的去处:进内存数组并挂到结果的 `controlEvents` 上(`ps/runs/foreground/execution.js:372-380,1379,1516`),再经 `createForegroundControlNotifier`(`ps/runs/foreground/subagent-executor.js:2026-2056`,函数体与 0.74.0 相同)。前台来源的通知在 `ps/extension/control-notices.js:28-33` 直接返回,不变成父会话的消息。该文件 SAME。
- 同一批事件还进一个待发队列(`ps/runs/foreground/execution.js:378,699-705`),随进度帧带出去。
- 对本项目:最多是 `subagent` 工具的进度帧与返回的 `details` 里多几条 `controlEvents`。本项目不读这一格(`grep -rn controlEvents src` 为空):取证只读 `details.results[].transcriptPath`(`src/reviewer/evidence.ts:515-523`),会话的瞬时帧经 `sessionSubagentRuns` 取各趟的状态(`src/reviewer/session-worker.ts:375-382`)。`details` 不进模型上下文。

## 2. peer 与装配

- `peerDependencies` 与 `peerDependenciesMeta` 与 0.74.0 相同(`diff 0.74.0/package.json 0.75.0/package.json` 只有 `version` 一行不同):pi-ai `>=0.86.1`,pi-agent-core / pi-coding-agent / pi-tui / typebox 为 `*`,五项全部 `optional: true`(`npm view pi-subagents@0.75.0 peerDependencies peerDependenciesMeta`)。
- `dependencies` 不变:`acorn 8.18.0`、`jiti 2.7.0`、`undici 8.10.2`、`yaml 2.8.3`。没有 `engines`。pi-server 仍不在其中。
- `typebox` 仍是可选 peer,由项目根那一份提供。
- **装在 Pi 0.99.2 上**:pi-ai 0.99.2 满足 `>=0.86.1`。可以装。
- **装在 Pi 1.0.1 上**:Pi 1.0.1 依赖 pi-ai `^1.0.1`、pi-agent-core `^1.0.1`、pi-tui `^1.0.1`、typebox `1.3.27`(`npm view @earendil-works/pi-coding-agent@1.0.1 dependencies`),同样满足 peer。可以装。
- 0.75.0 import 的 Pi 入口与 0.74.0 是同一组四个:`@earendil-works/pi-coding-agent`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai/compat`(对两版 `src/` 与 `index.js` 的 import 说明符做 `grep -o` 后比对)。pi-ai 1.0.1 仍导出 `./compat`(`npm view @earendil-works/pi-ai@1.0.1 exports`)。
- **按宿主 Pi 版本分支的代码**,包里没有读版本号的判断,只有三处按能力探测:
  - `ps/runs/background/runner-aliases.js:20,146-148`:`pi-agent-core/node` 改成可选别名。pi-agent-core 1.0.1 的 `exports` 只有 `.` 与 `./package.json`(`npm view @earendil-works/pi-agent-core@1.0.1 exports`)。只有后台 runner 用它。
  - `ps/runs/shared/child-session.js:325`:`typeof pi.createBashTool === "function"`。只在子会话被授予 `bash` 加 `subagent_command` 时求值。
  - `ps/runs/shared/child-session.js:222-244`:虚拟模型队列按结构取,队列不存在时循环不执行。
  - 另有一处原有的:`ps/extension/tool-activation.js:68-74`,宿主缺 `getAllTools` 等接口时不注册加载器。该文件 SAME。
- **未验证**:0.75.0 的前台路径在 Pi 1.0.1 上能否跑通。本次只读了 peer 声明、import 说明符与导出表,没有比对 Pi 1.0.1 的具名导出,也没有实跑。以并行试装任务的结果为准。
- 当前 `latest` 的 Pi 是 1.0.2(发布于 2026-10-04T00:56:19Z),1.0.1 发布于 2026-10-03T12:35:33Z(`npm view @earendil-works/pi-coding-agent time dist-tags`)。

## 3. 加载器、`exposure` 与工具声明体积

- `toolActivation` 默认仍是 `auto`(`ps/extension/tool-activation.js:64`,`ps/extension/index.js:1059` 把 `config.toolActivation` 传进去,校验在 `ps/extension/config.js:191-192`)。
- `disabledFeatures` 默认仍是空:不设时 `createSubagentParamsSchema` 返回完整 schema(`ps/extension/schemas.js:277-278`)。`ps/shared/disabled-features.js` SAME。
- 加载器 `subagents_enable` 的注册条件没变(`ps/extension/tool-activation.js` SAME):`eager` 时不注册(`:66-67`),宿主缺接口时不注册(`:68-74`),其余情况一律注册(`:114`)。`before_agent_start` 只在 `getAllTools()` 里有加载器时才动工具面(`:119-124`)。
- 本项目的情形与 0.74.0 相同:加载器会注册,但不在 `createAgentSession` 的 `tools` 允许清单里(`src/reviewer/worker.ts:778`、`src/reviewer/session-worker.ts:340`),被 Pi 滤掉。`test/reviewer-evidence-session.test.ts:147` 钉住这一点。
- `subagent` 的 `exposure` 仍是 `model-only`(`ps/extension/index.js:641` 的 `...MODEL_ONLY_TOOL`,`ps/shared/extension-context.js:7`,后者 SAME)。
- 工具声明体积(description 加 `JSON.stringify(schema)` 的字符数,实测):

  | | description | schema | 合计 |
  |---|---|---|---|
  | 0.74.0 | 5,349 | 12,806 | 18,155 |
  | 0.75.0 | 5,497 | 13,005 | 18,502 |
  | 差 | +148 | +199 | +347(约 1.9%) |

  - 默认配置 `{}` 与本项目的配置 `{ asyncByDefault: false, intercomBridge: { mode: "off" } }` 量出来是同一组数。
  - `promptSnippet` 加 `promptGuidelines` 两版都是 249 个字符。
  - description 的增量是 `command.status/yield/cancel` 那一句(`ps/extension/tool-description.js:21`)。schema 的增量来自新参数 `toolCallId`(`ps/extension/schemas.js:165`)与三处描述改写(`:188` `missionId`、`:208` `args`、`:256` gate)。
  - 顶层参数从 80 个变成 81 个,多的就是 `toolCallId`。
  - 折成 token 约不到 100 个(按 4 字符一个 token 粗估,未实测)。

## 4. 依赖点对照表

| 本项目依赖点 | 本项目位置 | 0.75.0 的情况 | 结论 |
|---|---|---|---|
| 能力天花板 `pi-subagents/capability-ceiling` | `src/reviewer/evidence.ts:50-53,132-142` | `ps/api/capability-ceiling.js:1` 与 `ps/runs/shared/capability-ceiling.js` 均 SAME。导出表仍有这一项(`package.json:88-91`) | 不受影响 |
| 天花板与新工具 | `src/reviewer/evidence.ts:105-115` | `ps/runs/shared/child-tool-plan.js:187` 多滤一个 `subagent_command`,只在 agent 没写 `tools` 时走到。本项目写了显式清单 | 不受影响 |
| `config.json` 铺装 | `src/reviewer/evidence.ts:302-306` | 没有新的必填键。`asyncByDefault` 的读法没变(`ps/extension/config.js:233`)。拒载键表多三项(`:16`),新增一处 `asyncWidgetCollapsed` 的类型校验(`:188-190`),本项目都不写。`ps/intercom/intercom-bridge.js` SAME | 不受影响 |
| 放行清单里声明在顶层 schema 的八格:`agent`、`task`、`async`、`timeoutMs`、`maxRuntimeMs`、`toolTimeoutMs`、`agentScope`、`cwd` | `src/reviewer/evidence.ts:367-380` | 都还在,描述逐字未改(`ps/extension/schemas.js:139,140,221,222,223,225,228,229`) | 不受影响 |
| 放行清单的另外四格:`tasks`、`chain`、`concurrency`、`intercomBridge` | `src/reviewer/evidence.ts:367-380,440-459` | 与 0.74.0 相同。见表后「旧表述偏差」 | 本次无变化 |
| 清单外键剥离、拦下 `action: "list"` | `src/reviewer/evidence.ts:484-503` | 新增的 `command.*` 三个 action 与 `toolCallId` 同样被剥。`tool_call` 钩子属于 Pi,不在本次范围 | 不受影响 |
| 工具描述要求先 list | 系统提示 `src/reviewer/worker.ts:93`、`src/reviewer/session-worker.ts:182` | `AGENT_SELECTION_GUIDANCE` 仍以 'First call {action:"list",capabilities:true}' 开头(`ps/extension/tool-description.js:7`) | 两处系统提示里那句仍然需要 |
| 子会话工具面是只读四件套 | `src/reviewer/evidence.ts:227`、`src/reviewer/session-subagent.ts:60` | 显式 `tools` 仍作为允许清单下发(`ps/runs/shared/child-launch.js:217`,SAME)。新增的可选注入只有一类:包了一层的 `bash` 加 `subagent_command`,条件是 `tools` 同时含这两个名字(`ps/runs/shared/child-session.js:322-326,357-360`)。codemode 与内建 MCP 的条件没变(`:339-344,317`) | 不受影响。实跑确认留给试装任务 |
| 子会话的 project trust | — | `ps/runs/shared/child-session.js:327`,写法没变 | 不受影响 |
| `inheritSkills: false` | `src/reviewer/evidence.ts:235` | `ps/runs/shared/child-session.js:350-352`,写法没变 | 不受影响 |
| transcript 路径与格式 | `src/reviewer/evidence.ts:515-523,551-634` | `ps/shared/child-transcript.js` SAME | 不受影响 |
| 用量并入父会话 | `src/reviewer/evidence.ts:35-37` | `ps/extension/tool-result.js` SAME | 不受影响 |
| 两个上限环境变量 | `src/reviewer/evidence.ts:78-79,316-318` | 读法没变(`ps/shared/types.js:206,218`)。该文件只改了 `SUBAGENT_ACTIONS` 一行 | 不受影响 |
| intercom 桥默认与逐次覆盖 | `src/reviewer/evidence.ts:305,355` | 桥本身 SAME。执行器仍读 `params.intercomBridge` 作覆盖(`ps/runs/foreground/subagent-executor.js:1612-1614`) | 不受影响 |
| 前台执行与超时 | `test/reviewer-evidence-session.test.ts` 超时用例 | `ps/runs/foreground/execution.js` 改三处:成功收尾前调 `session.finishCommands?.()`(`:684-695`,本项目的子会话没有这个方法,`:486` 只在建了命令运行时才挂上);F13 的通知频率(`:766,798,842-850`);F6 的虚拟模型核对(`:1035`)。超时与中止的写法没动。子会话关停抽成 `shutdownSession`(`ps/runs/shared/child-session.js:368-382`),步骤与原来相同,多一句 `commands?.shutdown()` | 不受影响 |
| `session_start` 依赖 | `src/` 不调 `bindExtensions`(`grep -rn bindExtensions src` 为空) | 挂 `session_start` 的仍是那几处:状态复位(`ps/extension/index.js:1016`)、升级提示(`:1056`)、agent 广告(`:1057`)、加载器选择(`ps/extension/tool-activation.js:117`)。执行器预加载的定时器在 `:521`。没有新增依赖 `session_start` 才能工作的前台路径 | 与 0.74.0 相同 |
| 升级提示 | — | `ps/extension/upgrade-notice.js` SAME | 不出现 |

**旧表述偏差(与本次升级无关)。** `docs/research/pi-upgrade-2026-10-01.md:98` 写「顶层 schema 里这几格都还在」。实际情况在 0.74.0 与 0.75.0 里都是:

- 默认配置下模型看到的顶层 schema 没有 `tasks`、`chain`、`concurrency`、`intercomBridge` 四格(对 `createSubagentParamsSchema(resolveDisabledFeatureSurface({}))` 的 `properties` 逐键检查,两版都是这四格缺、另八格在)。`tasks` 与 `chain` 只在关掉 `workflow-scripts` 功能组时才进 schema(`ps/extension/schemas.js:264-270,285-286`)。
- 默认配置下执行器会打回顶层 `tasks` / `chain` / `concurrency`:`ps/extension/public-execution.js:128-132` 返回 "Legacy top-level chain and parallel inputs were removed; use a workflow script"。`structuredWorkflows` 只在关掉 `workflow-scripts` 时为真(`ps/runs/foreground/subagent-executor.js:7398`)。这句报错在已装的 0.71.0 与 0.73.1 里就有(`grep -c` 各命中)。
- `intercomBridge` 没有声明在 schema 里,但执行器照读(见上表),schema 也不禁止多余键(`additionalProperties` 未设)。钉 `intercomBridge: { mode: "off" }` 仍然有效。
- 含义:在本项目当前配置下,Reviewer 与会话 agent 实际只能派单个 `agent` 加 `task`。`pinSubagentCall` 里钉 `tasks[]` / `chain[]` 各项的那段(`src/reviewer/evidence.ts:440-459`)在默认配置下走不到执行,它是防御代码。`workflow` 被放行清单剥掉,所以一次调用内的并行扇出目前没有可用入口。这个结论只读了代码,没有实跑。

## 5. 联网、全局目录、子进程与环境变量

对全部有差异的 `.js` 的新增行 grep 了 `process.env`、`spawn`、`execFile`、`fetch(`、`homedir`、`tmpdir`、`npm root`、`http`、`writeFileSync`、`mkdirSync`。

| 新增项 | 位置 | 前台单次取证会不会走到 |
|---|---|---|
| 新的联网 | 无 | — |
| 新的环境变量读取 | 无。`external-cli-preflight.js` 的改动只是按大小写不敏感的方式读传入的 `env` 里的 `PATH` / `PATHEXT` | 不会。外部 CLI 路径 |
| 新的子进程 | 外部 CLI 的 `spawn` / `spawnSync` 改成先解析 `.cmd`(`ps/runs/shared/external-cli-preflight.js`、`external-cli-runner.js`);子会话里包一层的 `bash`(`ps/runs/shared/child-commands.js`) | 不会。前者要外部 runner,后者要 `bash` 加 `subagent_command` |
| 新的文件写入 | settings 原子写(`ps/agents/agents.js:661-719`);`required-child-extensions.json`(`ps/shared/required-child-extensions.js:95-99`);命令通道目录(`ps/runs/shared/child-commands.js`);后台 run 写 `run-history.jsonl` | 不会。依次需要管理动作、`requireForAllRunners`、`bash` 子会话、后台执行 |
| 全局目录(`~/.pi`、宿主 tmp、`npm root -g`) | 新增行里没有 `homedir`、`tmpdir`、`npm root` | — |

`ps/shared/utils.js` 与 `ps/runs/shared/pi-spawn.js` 均 SAME,agentDir 与 tmp 根的解析没有变。

## 6. agent 定义文件(frontmatter)

- 没有新的必填字段,没有改名字段。两版 `ps/agents/agents.js` 里对 `frontmatter.` 的引用逐行相同(对两版 `grep -n 'frontmatter\.'` 去行号后 `diff`,无输出)。
- 唯一与 frontmatter 有关的改动在 `ps/agents/agents.js:1833-1837`:外部 runner 的「不支持字段」检查对两个 Claude Code 适配器放过 `model` 与 `thinking`。本项目的 agent 是原生 Pi 子会话,不经过这一支。
- `docs/agents.md` 的字段表只改了 `model` 与 `thinking` 两行的说明文字。
- 本项目写的十三个字段(`src/reviewer/evidence.ts:225-237`、`src/reviewer/session-subagent.ts:58-70`)都不用改。

## 7. 与本项目无关的改动

外部 CLI 适配器(Claude Code 的模型与 effort、Windows `.cmd`)、后台执行(`runs/background/*`:Pi 1.0.0 的别名、调度、僵尸进程、控制通道)、mission(`missions/*`)、profile、`/subagent-cost` 与 RPC、TUI 小部件、workflow 的 `args` 上限与 `"true"` 归一、内建 MCP 的名字归一、Codex 工具调用 id。本项目一律前台执行,不用外部 runner,不建 mission,没有 UI,`workflow` 与 `action` 都被剥掉。

## 8. 升级要改的位置

1. `package.json:25`:`0.74.0` → `0.75.0`。然后 `pnpm install`。前几次升级的经验是再跑一次 `pnpm update "@earendil-works/*"`,把 pi-subagents 的可选 peer 重解到同一份 Pi。这次只动 pi-subagents 时是否还需要这一步,未验证。
2. `pnpm-workspace.yaml`:
   - 0.75.0 的 24 小时窗口在 2026-10-03T20:27:45Z 关闭,写这份笔记时是 2026-10-04T01:03Z。**不需要新加豁免行**(按发布时刻推算,没有实跑 pnpm 校验)。
   - `:26` 的 `pi-subagents@0.74.0` 那一行已经没有用,可以删。`:12` 的注释提到「pi-subagents 0.74.0 发布于 2026-09-30」,跟着改。
   - 如果同一次还把 Pi 升到 1.0.1:它的窗口到 2026-10-04T12:35:33Z 才关,在那之前要豁免。这属于 Pi 升级那一份笔记。
3. 源码不改。测试不改:`test/reviewer-evidence.test.ts:526-533` 比对的 `config.json` 内容没变,`test/reviewer-evidence-session.test.ts:147` 的断言仍成立。
4. 根 `AGENTS.md`:
   - 技术栈段(`AGENTS.md:11`)「当前钉在 Pi 0.99.2 与 pi-subagents 0.74.0」里的 `0.74.0` 改成 `0.75.0`。同一段其余各句仍然成立:pi-subagents 以普通运行时依赖 vendor 进镜像,前台子会话跑在 Reviewer 子进程内,`typebox` 是 peer,`pi-server` 不在依赖树里,运行时第三方依赖共五个。只升 pi-subagents 时别的字不用动。
   - 变更日志加一条。`src/AGENTS.md` 变更日志同样加一条。
5. 发版前跑一次全量 `pnpm check`,其中 `reviewer-evidence-session`、`agent-session-subprocess`、`reviewer-evidence` 三个文件覆盖本文第 3、4 节的结论。

## 建议

**值得做**

- 升到 pi-subagents 0.75.0。理由:源码零改动;依赖点对照表每一行都没有改变语义;它把 Pi 1.x 上的后台路径修好了,之后升 Pi 1.x 时 pi-subagents 这一侧不再是阻塞项。代价是每个请求多 347 个字符的工具声明。
- 它与 Pi 升级相互独立。两件事可以放进同一次发版,也可以分开。分开时先升哪一个都行。

**可选**

- 上一份笔记留下的两项仍然开着,0.75.0 没有改变它们的前提:
  - `config.json` 加 `toolActivation: "eager"`,让加载器根本不注册(`ps/extension/tool-activation.js:66-67`)。
  - 用 `disabledFeatures` 缩短工具声明。现在的基数是 18,502 个字符。第 4 节的发现给这一项补了一条信息:默认配置下顶层 `tasks` / `chain` 本来就被打回,关掉 `workflow-scripts` 反倒会让它们成为可用入口(`ps/extension/public-execution.js:128`),那时 `pinSubagentCall` 给每一项加的 `cwd` 会撞上项 schema 的 `additionalProperties: false`(`ps/extension/schemas.js:263`)。要做的话需要另开一票实测。
- 把第 4 节的「旧表述偏差」落到文档:`docs/research/pi-upgrade-2026-10-01.md:98` 那一行与 `src/reviewer/evidence.ts:358-361,383-387` 的注释都按「`tasks` / `chain` 可用」来写。要不要让 Reviewer 有并行扇出,是一个产品取舍,本文不替它下结论。

**不做**

- 给取证 agent 加 `bash` 与 `subagent_command`。理由:它们超出只读四件套的契约(ADR 0021),天花板的 `allowedTools` 也不放行。
- 调用 `bindExtensions`。理由与上一份笔记相同,0.75.0 没有新增依赖 `session_start` 的前台路径。
