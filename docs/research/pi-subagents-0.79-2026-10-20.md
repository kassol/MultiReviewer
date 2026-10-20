# pi-subagents 0.76.1 → 0.79.x 跟进(2026-10-20)

当前钉法:`pi-subagents 0.76.1`、`@earendil-works/pi-coding-agent ^1.1.0`、`typebox ^1.3.11`(`package.json:22,25,26`,提交 `6952047`)。候选版本的发布时刻(`npm view pi-subagents time`):0.77.0 2026-10-10T05:25:31Z、0.78.0 2026-10-13T05:39:09Z、0.79.0 2026-10-17T08:19:00Z、0.79.1 2026-10-18T06:21:36Z、0.79.2 2026-10-20T06:12:37Z。0.79.2 是 `latest`。

## 来源

- `npm pack pi-subagents@0.76.1 / 0.79.1 / 0.79.2`,解包后 `diff -rq -x '*.map'`:0.76.1 → 0.79.1 共 227 项差异(204 个文件不同,21 个新增文件,2 个删除文件:`src/runs/shared/run-history.{js,d.ts}`);0.79.1 → 0.79.2 共 14 个文件不同,没有新增或删除。逐文件 `diff`。
- 包内 `CHANGELOG.md` 的 `[0.77.0]`–`[0.79.2]`。按节计数(不含 Highlights):0.77.0 Added 7 / Changed 11 / Fixed 30;0.78.0 Added 2 / Changed 6 / Fixed 21;0.79.0 Added 5 / Changed 2 / Fixed 18;0.79.1 Changed 2 / Fixed 5;0.79.2 Fixed 8。五个版本都**没有 Breaking 或 Removed 节**。
- 上游 release notes:`gh api repos/nicobailon/pi-subagents/releases/tags/v<版本>`,五个 tag 都在(0.79.2 发布于 2026-10-20T06:13:39Z)。把每条 `- ` 开头的条目拿去 CHANGELOG 里找,找不到的只有每版的 Highlights 改写版(各 5 条),外加 0.79.0 的两句尾注(「更早启动的子代理仍不能被 resume」「内建 MCP 需要 Pi 0.99.2」),两句在 CHANGELOG 正文里已有同义表述。没有 CHANGELOG 之外的新内容。
- 实测:在 `/tmp` 的三个空目录里各装一套 `pi-subagents@<版本> @earendil-works/pi-coding-agent@1.3.0 typebox@1.3.11`(`npm i --ignore-scripts`),import 包内模块量工具声明体积、确认模块图在 Pi 1.3.0 上加载得起来;另用 Pi 1.3.0 与本项目已装的 Pi 1.1.0 各建一次 `DefaultResourceLoader` 验证第 9 节的发现。**没有**往主检出装依赖,**没有**跑项目测试。下文凡是依赖实跑的结论都标「未验证」,以并行的 Pi 1.3.0 试装任务为准。

下文 `ps/` = `pi-subagents/src/`,行号指 0.79.2(0.79.1 与 0.79.2 逐字节相同的文件,行号两版通用)。`pi/` = `@earendil-works/pi-coding-agent/dist/core/`,行号指 1.3.0。

0.76.1 → 0.79.2 逐字节相同(`cmp -s`):`ps/api/capability-ceiling.js`、`ps/runs/shared/capability-ceiling.js`、`ps/extension/tool-result.js`、`ps/intercom/intercom-bridge.js`、`ps/shared/disabled-features.js`、`ps/runs/shared/tool-timeout.js`、包根 `index.js`。`package.json` 的 `pi` 清单(`extensions` / `skills` / `prompts`)不变。

## 结论

**能源码零改动直升,推荐 0.79.2。**依赖点对照表(第 4 节)里每一项要么逐字节未变、要么换了写法但对本项目的调用形状给出同样结果。0.79.2 相对 0.79.1 唯一落在本项目路径上的改动是第 8 节那一条:前台子会话不再从工作目录的 `.pi/APPEND_SYSTEM.md` 补系统提示。取证子会话的工作目录是被审仓库的工作副本,这一条因此关掉了被审仓库往取证子会话系统提示里塞文字的一条路。

升级会让模型侧看到三处变化(详见第 1、3 节):

1. `subagent` 的工具声明从 18,479 个字符降到 3,296 个(−15,183,约 −82%)。每个 Reviewer 请求与 Agent 会话请求都带这一份。
2. 子代理交回的报告超过 2,000 个字符时,父会话模型只看到前 2,000 个字符加一行指向宿主 tmp 下文件的路径。本项目父会话的 `read` 圈在工作副本或会话根里,读不到那个文件。
3. 工具描述不再叫模型先 `{action:"list"}`,改为推荐 `{workflow:"parallel",args:{tasks:[...]}}` 做并行扇出。两处系统提示里「工具描述先列 agent 的建议在这里不适用」那句从此没有对象,留着无害。

## 1. CHANGELOG 逐条

只列落在本项目路径上、或需要说明为什么落不到的条目。其余条目全部属于第 7 节那几类(后台执行、workflow 脚本、mission、schedule、RPC、TUI / Fleet / Herdr / tmux、外部 CLI、fork 上下文、Windows),本项目一律前台、单派、不建 mission、没有 UI,`action` / `workflow` / `args` / `options` 都被放行清单剥掉(`src/reviewer/evidence.ts:367-380,429-461`)。

### 走得到,行为有变

| 版本 · 条目 | 判定 | 依据 |
|---|---|---|
| 0.77.0 Changed:参数 schema 收成 12 个顶层字段加一个 `options` 对象,管理字段与 `runId` / `maxRuntimeMs` / `isolation` 别名在顶层「照旧可用」(#2767) | 走得到,本项目的钉法照旧生效 | 新 schema:`ps/extension/schemas.js:260-272`。执行前 `flattenSubagentToolOptions` 把 `options` 摊平到顶层(`ps/extension/subagent-options.js:13-51`,调用点 `ps/extension/index.js:615`);`options` 不存在时原样返回顶层(`:18-19`)。本项目在 `tool_call` 钩子里剥掉 `options`(它不在放行清单里),所以钉在顶层的 `agentScope` / `intercomBridge` / `async` / `cwd` 原样进执行器。执行器仍读顶层这几格(`ps/runs/foreground/subagent-executor.js:1647,1657,1981,1992`)。顶层 schema 不设 `additionalProperties`(实测 `createSubagentParamsSchema(undefined).additionalProperties === undefined`),Pi 在钩子之前做的参数校验(`pi-agent-core/dist/agent-loop.js:492` 先校验、`:493` 再调 `beforeToolCall`;校验本身不剔多余键,`pi-ai/dist/utils/validation.js:280-310`)照样放行模型写在顶层的 `timeoutMs` 之类。唯一的差别:模型若把 `timeoutMs` 写进 `options`,它随 `options` 一起被剥掉,这次取证用默认超时 30 分钟(`subagent-executor.js:2620`,两版相同) |
| 0.77.0 Changed:前台结果里超过 2,000 字符的子代理输出只留前 2,000 字符加文件指针(#2774) | 走得到,改变父会话模型读到的取证报告 | 见本表下方说明 |
| 0.77.0 Changed:默认工具描述从约 5,700 字符缩到约 1,200,不再要求先 `list` / `models`;未知 agent 名回「did you mean」加可用 agent 清单(#2768、#2771) | 走得到,只改模型读到的文字 | 新描述见 `ps/extension/tool-description.js:11-27`;`First call {action:"list"...}` 在 0.79.2 的 `tool-description.js`、`extension/index.js`、`tool-activation.js` 里都已不存在(`grep` 无命中)。未知名字的回绝文案在 `ps/agents/agents.js` 的 `formatAvailableAgentLines`。本项目的系统提示 `src/reviewer/worker.ts:93`、`src/reviewer/session-worker.ts:182` 里「the tool description's advice to list agents does not apply here」那半句从此没有指向的对象 |
| 0.77.0 Fixed:其他扩展在 `before_agent_start` 加的提示段进得了子会话请求,子会话边界说明挪到所有扩展之后(#2745) | 走得到,子会话系统提示的内容不变 | 原先 `rewriteSubagentPrompt` 在最终字符串上做替换;现在先在 `systemPromptOptions` 上就地过滤(`ps/runs/shared/subagent-prompt-runtime.js:216-229`,`inheritProjectContext: false` 即 `contextFiles = []`,`inheritSkills: false` 即 `skills = []`),边界说明由排在最后的另一个钩子追加(`:229-244`,扩展排序 `ps/runs/shared/child-session.js` 的 `orderChildPromptHooks`)。本项目的取证与会话子代理是 `systemPromptMode: replace` 加三个 `inherit*: false`(`src/reviewer/evidence.ts:232-235`、`src/reviewer/session-subagent.ts:65-68`),子会话扩展只注册工具,不挂 `before_agent_start`。顺序仍是「agent 定义正文……边界说明」。未实跑 |
| 0.79.0 Fixed:provider 报错停下的子代理,错误里带上 provider 回复原文(最多 500 字符) | 走得到,只改失败那一趟的文字 | `ps/runs/foreground/execution.js` 改用 `assistantMessageError(evt.message)`。会话子代理失败时结论取 `error`(`src/reviewer/session-subagent.ts:186`),面板上那一趟的结论会多一段 `Reply text: …` |
| 0.79.1 Fixed:嵌入 Pi 的应用里,子会话优先用应用自己那份 Pi(#2947) | 走得到,解析到同一份 Pi | 新解析顺序 `ps/runs/shared/pi-spawn.js:119-144`:`argv[1]` 是 `.js/.mjs/.cjs` 才当 Pi CLI 认;本项目 worker 的入口是 `.ts`(`src/reviewer/pi-reviewer.ts:21`、`src/webhook/agent-session.ts:74`),落到 `resolveHostDependencyPiPackageRoot`(`:40-71`),从 `src/reviewer/` 往上找到项目根的 `node_modules/@earendil-works/pi-coding-agent` 并取 realpath——正是 worker 自己 import 的那一份。0.76.1 取的是从 pi-subagents 所在位置 `import.meta.resolve` 出来的那份(pnpm 的 peer 解析,通常也是同一份)。该份的 manifest 坏了时子会话启动直接失败 |
| 0.79.2 Fixed:`systemPromptMode: replace` 的子会话不再拿到 `APPEND_SYSTEM.md`(#2960) | 走得到,关掉一条注入路 | 见第 8 节 |

**0.77.0 #2774 的说明。**

- 前台单派成功时,工具返回的正文是 `capInlineOutput(finalizedOutput.displayOutput, { artifactPath: r.artifactPaths?.outputPath, ... })`(`ps/runs/foreground/subagent-executor.js:4000`)。0.76.1 同一处直接返回全文(`0.76.1/src/runs/foreground/subagent-executor.js:3907`)。
- `capInlineOutput`(`ps/runs/shared/single-output.js:187-207`)在正文超过 `INLINE_OUTPUT_HEAD_CHARS = 2_000`(`:147`)且有可读的输出文件时,只留前约 2,000 字符,接一行 `Full output: <路径> (<大小>, <行数>). Read it if needed.`。
- 前台子会话默认写这个文件:artifacts 默认开(`ps/shared/types.js:47-55`,`enabled: params.artifacts !== false`,`subagent-executor.js:1907`),`includeOutput` 默认开,成功时文件内容就是输出原文(`ps/shared/artifacts.js:202-204`,写入点 `ps/runs/foreground/execution.js:1918-1926`)。transcript 与它同一个开关(`execution.js:1760-1770`),所以不能靠关 artifacts 绕开——那样 transcript 也没了。
- 文件落点:本项目父会话是内存会话(`src/reviewer/worker-tools.ts:529`),没有会话文件,`getArtifactsDir` 取 `TEMP_ARTIFACTS_DIR`(`ps/shared/artifacts.js:161-168`)= `os.tmpdir()/pi-subagents-<uid 作用域>/artifacts`(`ps/shared/types.js:107-113`)。这个目录 0.76.1 起就在写(transcript 也在这里),新的只是父会话模型被指去读它。
- 对本项目:Reviewer 的 `read` 圈在工作副本,会话 agent 的 `read` 圈在会话根加 skill 目录(`src/reviewer/session-worker.ts:344`),都读不到这个路径。超过 2,000 字符的取证报告,Reviewer 只能按前 2,000 字符裁决。取证 agent 的定义要求「Keep the report short」(`src/reviewer/evidence.ts:246`),中文报告 2,000 个 JS 字符约等于 2,000 个汉字,多数报告够不到这个长度,但没有实测数据。审查轨迹里 `subagent` 那一行的 `resultLength` 记的是工具返回正文的长度(`src/reviewer/trace-events.ts:212`),拿 00-test 上已有轨迹统计一次「`resultLength > 2000` 的取证占比」即可量出影响面,本笔记没有查库。
- 会话子代理的面板卡片不受影响:结论取 `details.results[].finalOutput`(`src/reviewer/session-subagent.ts:186`),这一格是全文,没有经过 `capInlineOutput`。

### 走得到代码,对本项目无效果

| 版本 · 条目 | 依据 |
|---|---|
| 0.77.0 Changed / 0.78.0 Added `pinToolDeclarations`:续接的会话沿用转录里已声明的工具定义(#2778、#2853) | `ps/extension/declaration-pinning.js` 只在 `session_start` / `session_tree` 时读转录(`:138-139`)。Pi 只在 `bindExtensions` 里发 `session_start`(`pi/agent-session.js:2651`),而调用 `bindExtensions` 的只有 Pi 的 print / interactive 模式(`grep -rl bindExtensions` 只命中 `modes/` 与 `core/` 自身);`src/` 不调它(`grep -rn bindExtensions src` 为空)。没有 `session_start` 就没有可钉的旧定义,`registerPinnedTool` 注册的是当前定义(`:154-160`)。因此 Agent 会话从库里重建时拿到的也是新的 3,296 字符声明,不是旧的 18,479 |
| 0.79.0 / 0.79.2 Fixed:更新或压缩之后 `subagent` 丢失(#2910、#2916、#2963) | 改动全在 `applyRecordedSelection`(`ps/extension/tool-activation.js:45-117`),只由 `session_start` / `session_tree` 调用(`:173-174`),同上走不到 |
| 0.79.1 Changed:未启用 `subagent` 时不发 `bg_wait` 与 `subagent_supervisor`(#2935、#2936) | 只在 `setSelection` 里分支(`tool-activation.js:19-30`),同上走不到。这几件工具反正不在 `createAgentSession` 的 `tools` 允许清单里,被 Pi 滤掉 |
| 0.78.0 Changed:有 `subagent` 的会话同时声明 `contact_supervisor` | 同在 `setSelection`(`:23`),走不到;即便声明也被允许清单滤掉 |
| 0.79.0 Fixed:`/subagent-cost` 等只读报告不进上下文 | 新增一个 `context` 钩子(`ps/extension/index.js:559-563`),每次请求都跑,只滤掉 `customType` 为 slash 报告且 `viewOnly` 的消息。本项目会话记录里的 custom 条目 `customType` 是自己的,不被滤 |
| 0.77.0 Added:OSC 7501 程序状态 | `registerProgramStatusReporter`(`ps/integrations/program-status.js:96-140`)要 `session_start` 置 `active` 且 stdout 是 TTY 才写;两条都不满足 |
| 0.77.0 Fixed:transcript 不再处理 `tool_result_end` | `ps/shared/child-transcript.js:180` 只认 `message_end`。Pi 不发 `tool_result_end`(在 Pi 1.3.0 包里只出现在 `examples/`),toolResult 消息原本就经 `message_end` 进来。本项目读的 `message` / `tool_start` / `tool_end` 三类记录不变 |
| 0.77.0 Added:新子会话的会话头记 `parentSession` | 只在父会话有会话文件时写(`ps/runs/shared/child-session.js` 的 `newSessionOptions`)。本项目父会话是内存会话 |
| 0.77.0 Fixed:拒绝 project trust 的会话不读项目的 subagent 设置与 agent(#2764) | 本项目父会话的 trust 是 `true`(见第 8 节),行为不变;`agentScope` 又钉成 `user` |
| 0.77.0 Fixed:前台进度只格式化最近 64 个工具调用(#2704) | 性能改进,`progress` 的形状不变 |
| 0.78.0 Changed:不再写 `run-history.jsonl` | 原本就只有后台路径写,前台记录不在其中 |

## 2. peer 与装配

- `dependencies`、`peerDependencies`、`peerDependenciesMeta`、`engines`、`exports` 三版完全相同(对两版 `package.json` 的这几格做 `json.dumps(sort_keys)` 后 `diff`,无输出;0.79.1 → 0.79.2 的 `package.json` 只有 `version` 一行不同)。
  - peer:pi-ai `>=0.86.1`,pi-agent-core / pi-coding-agent / pi-tui / typebox 为 `*`,五项全部 `optional: true`。
  - dependencies:`@js-temporal/polyfill 0.5.1`、`acorn 8.18.0`、`jiti 2.7.0`、`undici 8.10.2`、`yaml 2.8.3`,没有新增。
  - `exports` 仍有 `./capability-ceiling`。
- **装在 Pi 1.3.0 上**:Pi 1.3.0 依赖 pi-ai / pi-agent-core / pi-tui 均为 `1.3.0`(`npm view @earendil-works/pi-coding-agent@1.3.0 dependencies`),满足 peer。项目根的 `typebox 1.3.11` 满足 `*`。
- **实测加载**:`/tmp` 里 `npm i pi-subagents@0.79.x @earendil-works/pi-coding-agent@1.3.0 typebox@1.3.11` 之后,import 包根(`default` 是函数)与 `pi-subagents/capability-ceiling`(九个导出,含 `registerSubagentCapabilityCeiling`)都成功。npm 把 Pi 自带的 `typebox 1.3.27` 嵌在 `pi-coding-agent/node_modules/` 下,pi-subagents 解析到根上的 1.3.11。pnpm 的解析结果(lockfile 里 `pi-subagents@0.79.x(...)(typebox@1.3.11)`)未验证。
- 新增的静态 import:`ps/extension/subagent-options.js:2` 的 `typebox/compile`。`typebox 1.3.11` 的 `exports` 有 `./compile`(读项目已装的 `node_modules/typebox/package.json`),上一条的加载实测也覆盖了它。
- 新增的 Pi 侧依赖:`declarationsEqual` / `getCurrentSystemMessage` / `getCurrentTools` / `toToolDeclaration` 从 `@earendil-works/pi-ai` 根导入(`ps/extension/declaration-pinning.js:1`、`ps/runs/shared/subagent-prompt-runtime.js:4`)。上面的加载实测在 Pi 1.3.0 上通过;在当前钉的 Pi 1.1.0 上是否都有这几个导出,未验证——所以 0.79.x 最好与 Pi 1.3.0 一起升。
- 包体积:0.76.1 11,644,580 字节 / 1,291 个文件;0.79.2 12,099,921 字节 / 1,339 个文件(`npm view ... dist.unpackedSize dist.fileCount`),约多 455 KB。

## 3. 加载器与工具声明体积

- 加载器 `subagents_enable` 的注册条件不变:`eager` 时不注册,宿主缺 `getAllTools` 等接口时不注册,其余一律注册(`ps/extension/tool-activation.js:118-169`)。注册改走 `registerPinnedTool`(`:169`),效果同上一节第一行。
- `before_agent_start` 里 `loaderSelected` 初值仍是 `true`(`:171`),每次开跑仍把加载器补进 `selectedTools` 并 `setActiveTools`(`:175-192`)。新增的只有「另有扩展登记了后台工作提供者时补上 `bg_wait`」(`:181`),本项目没有这类扩展,`listBackgroundWorkProviders()` 为空。加载器照旧被 Pi 的 `tools` 允许清单滤掉,`test/reviewer-evidence-session.test.ts:147` 那条断言的前提不变。
- 工具声明体积(description 加 `JSON.stringify(schema)` 的字符数,实测;默认配置 `{}` 与本项目配置 `{ asyncByDefault: false, intercomBridge: { mode: "off" } }` 量出同一组数):

  | | description | schema | 合计 | 顶层参数 |
  |---|---|---|---|---|
  | 0.76.1 | 5,497 | 12,982 | 18,479 | 81 |
  | 0.79.1 | 1,204 | 2,092 | 3,296 | 13 |
  | 0.79.2 | 1,204 | 2,092 | 3,296 | 13 |
  | 差 | −4,293 | −10,890 | −15,183 | −68 |

  - 0.76.1 的数与 `docs/research/pi-upgrade-2026-10-10.md` 第 2.4 节一致(那一次装在 Pi 1.1.0 上,这一次是 Pi 1.3.0)。
  - 0.79.x 的顶层参数:`agent, task, workflow, args, async, model, cwd, worktree, output, action, id, message, options`。
  - `promptSnippet` 加 `promptGuidelines`:249 → 105 个字符(0.77.0 删掉了 guideline)。本项目父会话用自定义系统提示(`src/reviewer/worker-tools.ts:487` 的 `systemPromptOverride`),Pi 在有自定义提示时不渲染工具片段与规则段(`pi/system-prompt.js`,`customPrompt` 分支只放 `preamble`),这一项本来就不进请求。
  - 折成 token 约少 3,800 个(按 4 字符一个 token 粗估,未实测)。

## 4. 依赖点对照表

| 本项目依赖点 | 本项目位置 | 0.79.2 的情况 | 结论 |
|---|---|---|---|
| 能力天花板 `pi-subagents/capability-ceiling` | `src/reviewer/evidence.ts:50-53,132-142` | 两个 `capability-ceiling.js` 逐字节相同;按会话 id 查表的调用点与 0.76.1 是同一批(`resolveCurrentSubagentCapabilityCeiling(` 的命中文件集合两版相同,前台在 `ps/runs/foreground/execution.js:1619`) | 不受影响 |
| 包根解析 | `src/reviewer/evidence.ts:146` | `exports["."]` 不变 | 不受影响 |
| `config.json`(`asyncByDefault: false`、`intercomBridge.mode: "off"`) | `src/reviewer/evidence.ts:302-306` | `ps/extension/config.js` 有 31 行改动,新增的是 `pinToolDeclarations`、`activeRunsPrompt`、`programStatus`、`runnerLaunchers` 等可选键的校验;本项目写的两键读法不变;`intercom-bridge.js` 逐字节相同 | 不受影响 |
| 前台执行 | 同上、`evidence.ts:229,355` | 默认前台超时仍 30 分钟(`subagent-executor.js:2620`);0.79.0 起前台子会话多一个 `stop` 回调供宿主停(`execution.js` 的 `onChildSession`),本项目不调 | 不受影响 |
| `pinSubagentCall` 放行清单与钉死的四格 | `src/reviewer/evidence.ts:367-380,429-461` | 见第 1 节第一行:执行器仍读顶层;`options` 被剥 | 不受影响,模型写进 `options` 的超时会丢 |
| 剥完无可派即拦下 | `src/reviewer/evidence.ts:490-495` | 模型按新描述写 `{workflow:"parallel",args:{...}}` 时,`workflow` 与 `args` 都被剥,落进这一档,拦下文案为 `subagent has no workflow, args action here; …` | 行为同前,触发的写法变了 |
| `subagents_enable` 靠 `tools` 允许清单滤掉 | `src/reviewer/worker.ts:778`、`src/reviewer/session-worker.ts:340` | 第 3 节 | 不受影响 |
| transcript 路径与格式 | `src/reviewer/evidence.ts:515-523,551-634` | `child-transcript.js` 只少了 `tool_result_end` 分支(第 1 节);`execution.js` 里 `transcriptPath` 的赋值点与 0.76.1 相同(`:1913-1914`) | 不受影响 |
| 会话子代理读 `details.results[]` 的 `index` / `error` / `exitCode` / `finalOutput` / `transcriptPath` / `progress.toolCount` | `src/reviewer/session-subagent.ts:120-189` | `snapshotResult` 仍展开整份 result(`execution.js:172-186`);这几个名字在 `execution.js` 里的出现次数两版相同(`toolCount` 多一次,是新增的计数用法) | 不受影响 |
| 用量并入父会话 | `src/reviewer/evidence.ts:35-37` | `ps/extension/tool-result.js` 逐字节相同 | 不受影响 |
| 会话上限与单次扇出上限两个环境变量 | `src/reviewer/evidence.ts:78-79,316-318` | 读法不变(`ps/shared/types.js:211-227`);types.js 的改动只是几个常量去掉 `export` 与新增 launcher 名规则 | 不受影响 |
| 子会话工具面是只读四件套 | `src/reviewer/evidence.ts:227`、`src/reviewer/session-subagent.ts:60` | `child-launch.js` 只多传一格 `parentSessionFile`(`:216`);`child-tool-plan.js` 改的是运行时扩展按 `.js`/`.ts` 现场解析(#2780);codemode 的条件拆成 `codemodeAllowed` 加内建 MCP 的就绪探测,两者都要 `tools` 含 `codemode` 或有 `mcp:` 项(`child-session.js:380-395`) | 不受影响。实跑确认留给试装任务 |
| 子会话系统提示 | `evidence.ts:232-235`、`session-subagent.ts:65-68` | 第 1 节 #2745 一行;0.79.2 起 `appendSystemPrompt` 恒为显式数组(第 8 节) | 内容不变,少一条注入路 |
| agent 定义 frontmatter | `evidence.ts:224-238`、`session-subagent.ts:57-71` | 两版对 `frontmatter.` 的引用只多一个 `frontmatter.launcher`(可选,后台 runner 用) | 不改 |
| `session_start` 依赖 | `src/` 不调 `bindExtensions` | 新增依赖 `session_start` 的只有声明钉定、程序状态与选择恢复,都对本项目无效果(第 1 节第二张表) | 与 0.76.1 相同 |

## 5. 联网、全局目录、宿主 tmp、子进程与环境变量

对 0.76.1 → 0.79.2 全部有差异的 `.js` 的新增行,以及 11 个新增文件,grep 了 `process.env`、`spawn`、`execFile`、`fetch(`、`homedir`、`tmpdir`、`writeFileSync`、`mkdirSync`、`appendFileSync`、`http`。

| 新增项 | 位置 | 前台单派取证走不走得到 |
|---|---|---|
| 新的联网 | 无 | — |
| 新的环境变量读取 | `PI_SUBAGENTS_COMPONENT_UI`(`ps/shared/extension-context.js`,只决定 UI);`PI_PROGRAM_STATUS`(程序状态);`TMUX_BIN`(`ps/inspectors/tmux/client.js:22`);`structured-output.js` 读 `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` 找 typebox;后台 runner 设 `PI_SUBAGENT_RUNNER_PID` | 都走不到:依次要 UI、`session_start`、Fleet 检查器、`outputSchema`、后台执行 |
| 新的子进程 | tmux 检查器的 `execFile`;`runner-launcher.js` 包后台 runner | 走不到 |
| 新的文件写入 | 后台结果租约目录(`result-files.js`)、外部 runner 输出 | 走不到 |
| 全局目录 | `scheduled-runs.js` 的 `resolveHomeConfigRoot` 只读 `HOME` 并 `realpath`,用于 schedule 根校验 | 走不到(schedule 是管理动作) |
| 宿主 tmp | 作用域名 `pi-subagents-<scope>` 在没有 uid 时多一档 homedir 兜底(`ps/shared/types.js:91-97`);Linux 上取 `uid-<n>`,路径不变 | 不变。第 1 节 #2774 让父会话模型被指向这个目录下的文件,但不新写文件 |

## 6. backlog #466 相关事实(只记事实)

- 默认配置下顶层 `tasks` / `chain` / `concurrency` 仍被执行器打回,文案照旧是 `Legacy top-level chain and parallel inputs were removed; use a workflow script (...)`(`ps/extension/public-execution.js:131-134`,该文件 0.79.1 → 0.79.2 相同,0.76.1 → 0.79.1 只多了 `reuseFrom` 的一处校验)。
- 0.77.0 新增内置 workflow `parallel`(`ps/workflows/workflow-resources.js:177`),调用形状是 `{workflow:"parallel",args:{tasks:[{agent,task},...]}}`,新的默认工具描述把它写成并行扇出的推荐写法(`ps/extension/tool-description.js:16`)。本项目的放行清单不含 `workflow` 与 `args`(`src/reviewer/evidence.ts:367-380`),这种调用会被剥成空、在 `evidence.ts:490-495` 拦下。
- 所以在本项目当前钉法下,一次调用内的并行扇出仍然没有可用入口;变的是模型最可能尝试的写法,以及它被谁拦下(从 pi-subagents 的「Legacy…」换成本项目的「has no workflow, args action here」)。会话系统提示里「send several in one call when the questions are independent」(`src/reviewer/session-worker.ts:182`)与这一事实的矛盾在 0.76.1 就存在,升级不改变它。

## 7. 与本项目无关的改动

后台执行(runner 包装 `launcher:`、交接后的运行归属、`reuseFrom`、resume 已完成子代理、完成通知持久化、容量槽回收、Pi 1.2.0 的 chord 别名)、workflow 脚本(冻结 `Promise`、`emit` 的 undefined、阶段输出路径)、mission、schedule、RPC 快照与 inspect、TUI / Fleet / Herdr / tmux 检查器、外部 CLI、fork 子代理与提示缓存、`toolBudget`、内建 MCP 就绪探测、steer 与 supervisor 问答、Windows 文件锁、内置 role prompt(六个内置 agent 的 `.md` 与 `skills/pi-subagents` 都改了,本项目 `subagents.disableBuiltins: true`,`src/reviewer/evidence.ts:292-295`)。

## 8. 0.79.1 还是 0.79.2

0.79.1 → 0.79.2 改了 14 个文件。落在本项目前台单派路径上的只有一处:

- `ps/runs/shared/child-session.js:415-416`:子会话资源加载器的 `appendSystemPrompt` 从「`launch.appendSystemPrompt` 有值才传」改成「没有值就传 `[]`」。
- `replace` 模式下 `launch.appendSystemPrompt` 恒为空:`replace` 把 agent 正文放进 `systemPrompt`,`append` 才放进 `appendSystemPrompt`(`ps/runs/shared/child-launch.js:230`)。
- Pi 的加载器在 `appendSystemPrompt` 缺省时自己去找文件(`pi/resource-loader.js:480-484`):先找 `<cwd>/.pi/APPEND_SYSTEM.md`,条件是项目受信任,再找 `<agentDir>/APPEND_SYSTEM.md`(`:955-964`)。传 `[]` 时 `!appendSources` 为假,不再找。
- 取证子会话的 `cwd` 被钉成工作副本(`src/reviewer/evidence.ts:438`);子会话的 trust 取自父会话(`ps/runs/shared/child-session.js:369`,来源 `subagent-executor.js:1510,1799,1941` 的 `sessionProjectTrust(ctx)`,即 `ctx.isProjectTrusted()`);父会话的 `SettingsManager.inMemory(...)`(`src/reviewer/worker-tools.ts:467`)不传 trust,默认 `true`(`pi/settings-manager.js:238`)。合起来:0.76.1 至 0.79.1 下,被审仓库只要带一份 `.pi/APPEND_SYSTEM.md`,它的内容就进取证子会话的系统提示;子代理过滤只剥上下文与技能段,不删这一段(`subagent-prompt-runtime.js:216-229`)。这条链只读了代码,没有用真模型跑一遍子会话确认。
- 会话子代理的 `cwd` 是会话根,下面只有 `<owner>/<repo>` 目录,没有 `.pi/`,不受影响。
- 其余 13 个文件:`tool-activation.js`(压缩后恢复 `subagent`,第 1 节说明走不到)、`async-steering-action.js` / `subagent-executor.js` / `notify.js` / `index-segment.js` / `workflow-child-summary.js` / `index.js`(steer、后台完成通知持久化、workflow 容量与超长 toolCallId)、`herdr-pi-bridge.js`(远程 Herdr 子代理的同一修复)、`docs/configuration.md`、`CHANGELOG.md`、`package.json`。

**发布年龄窗口。**

- 镜像里用的是 pnpm 11.21.0 做 `pnpm install --frozen-lockfile`(`Dockerfile:10,15,60,69`)。上一次升级的实测是:默认 24 小时窗口内的版本在这一步被拒(`docs/research/pi-upgrade-2026-10-10.md` 第 3 节)。
- 本机 pnpm 是 12.14.0(`pnpm --version`)。它的默认窗口仍是 1440 分钟,且默认非 strict(pnpm 12.14.0 包内 `CHANGELOG.md`:「The built-in 1440-minute default stays non-strict」)。非 strict 时 `pnpm install` 会把选中的未满窗口版本自动记进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`(同一份 CHANGELOG 的 #13687 条目)。`pnpm-workspace.yaml` 当前没有 `minimumReleaseAge` 也没有豁免清单。
- 0.79.2 的窗口在 2026-10-21T06:12:37Z 关闭。0.79.1(2026-10-18)与 Pi 1.3.0(2026-10-15T19:13:30Z)都已过窗口。
- **值得加豁免**:0.79.2 修的那一条落在本项目路径上(上文),而豁免的代价只是 `pnpm-workspace.yaml` 里一行 `- "pi-subagents@0.79.2"`,过了窗口自然失效。在 2026-10-21T06:13Z 之后才出镜像的话不用加。本机 pnpm 12 若自动写进了这一行,保留即可;写法与 2026-10-04 那一版相同(一行一个精确版本)。镜像里 pnpm 11.21 对它的校验未实跑。

## 9. 范围外发现:Reviewer 父会话读取被审仓库的 AGENTS.md 与 APPEND_SYSTEM.md

与本次升级无关,升级前后都存在。

- 父会话的资源加载器(`src/reviewer/worker-tools.ts:475-487`)只给了 `systemPromptOverride`,没有给 `noContextFiles` 与 `appendSystemPrompt`。Pi 的默认是 `noContextFiles: false`(`pi/resource-loader.js:267`),于是从 `cwd` 往上逐级读 `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md`(`loadProjectContextFiles`,`:165-191`),并按上一节的规则读 `<cwd>/.pi/APPEND_SYSTEM.md`。Pi 在有自定义提示时仍把这两样拼进系统提示:`addendum` 与 `project_context` 两段(`pi/system-prompt.js` 的 `buildSystemPrompt`,`if (appendSystemPrompt)` 与 `if (contextFiles.length > 0)` 两处)。
- 实测:在 `/tmp` 下建一个含 `AGENTS.md` 与 `.pi/APPEND_SYSTEM.md` 的目录,用与 `worker-tools.ts:467-487` 相同的选项(`SettingsManager.inMemory({})`、`noSkills: true`、`systemPromptOverride`)建 `DefaultResourceLoader` 并 `reload()`。本项目已装的 Pi 1.1.0 与 Pi 1.3.0 都返回 `trusted: true`、`getAgentsFiles()` 含仓库 `AGENTS.md` 的内容、`getAppendSystemPrompt()` 含 `APPEND_SYSTEM.md` 的内容。
- 影响:Reviewer、规则 agent、合并 agent 的 `cwd` 是工作副本,PR 作者可以在被审分支里放一份 `AGENTS.md` / `CLAUDE.md` / `.pi/APPEND_SYSTEM.md`,内容进入这一轮 Reviewer 的系统提示。取证子代理那一侧特意写了 `inheritProjectContext: false`,理由正是「那是被审仓库的内容,半可信」(`src/reviewer/evidence.ts:215-216`),父会话这一侧没有同样的处理。仓库内没有文档说明父会话读这些文件是有意为之(`grep -rn "noContextFiles\|project_context\|APPEND_SYSTEM" docs src test` 为空)。Agent 会话的 `cwd` 是会话根,仓库的 `AGENTS.md` 在子目录里,读不到。
- 处理不在本笔记范围,由主会话分档。

## 10. 升级要改的位置

1. `package.json:25`:`0.76.1` → `0.79.2`。按前几次的经验与 Pi 升级同一次做,再跑一次 `pnpm update "@earendil-works/*"` 把可选 peer 收拢到同一份 Pi。
2. `pnpm-workspace.yaml`:见第 8 节,在 2026-10-21T06:13Z 之前出镜像就加一行 `pi-subagents@0.79.2` 豁免。
3. 源码:**不需要改**。可选的两处文字(不改也不影响行为):
   - `src/reviewer/worker.ts:93`、`src/reviewer/session-worker.ts:182` 里「the tool description's advice to list agents does not apply here」:新描述已不含这条建议。前半句「do not call the tool with action "list" or any other action first」仍然有用,管理动作照旧会被剥掉拦下。
   - `src/reviewer/evidence.ts:363-365` 的注释「模型看得到 pi-subagents 工具的完整 schema」:schema 现在只有 13 个顶层字段,其余在 `options` 里。
4. 测试:`test/reviewer-evidence.test.ts` 的纯函数用例不依赖 pi-subagents 的文案;`test/reviewer-evidence-session.test.ts`、`test/agent-session-subprocess.test.ts` 用真实 SDK 走前台单派,覆盖第 1 节 #2745 与第 4 节的结论。要量第 1 节 #2774 的影响,可在其中一条用例里让假模型的子代理输出超过 2,000 字符,断言父会话收到的工具返回正文。
5. 根 `AGENTS.md`:技术栈段「当前钉在 Pi 1.1.0 与 pi-subagents 0.76.1」改版本号;变更日志加一条,`src/AGENTS.md` 同样加一条。

## 建议

**值得做**

- 升到 pi-subagents 0.79.2,与 Pi 1.3.0 一起升。理由:源码零改动;每个带 `subagent` 的请求少 15,183 个字符的工具声明;0.79.2 关掉被审仓库经 `.pi/APPEND_SYSTEM.md` 进入取证子会话系统提示的路。代价是最多一行发布年龄豁免。
- 发版前用 00-test 已有的审查轨迹统计一次取证返回 `resultLength > 2000` 的占比,确认第 1 节 #2774 的截断面有多大。占比可忽略就不处理;不可忽略时再决定要不要在 `subagentContractExtension` 里接一个 `tool_result` 钩子,用 `details.results[0].finalOutput` 换回全文。

**不做**

- 关掉 artifacts 来避开 2,000 字符截断。理由:transcript 与它同一个开关(`execution.js:1760-1770`),关了取证过程就进不了审查轨迹。
- 放行 `options`。理由:`options` 里能放任何管理字段(`ps/extension/schemas.js:263-270`),放行等于绕过整份放行清单。
