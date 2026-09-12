# pi-subagents 0.66/0.67 升级调研

日期：2026-09-12。代码基线：`cae6fce282b8a05cc469f4d87175bae8379ad096`。本篇是 `pi-upgrade-2026-09-05.md` 的增量，范围只到 pi-subagents 0.65.1 → 0.67.0 与 Pi 0.85.1 的配套关系。未调用收费模型，未改任何源码，未装进项目——0.65.1 与 0.67.0 的 tarball 在 scratchpad 里解包比对。

## 结论

**等**。0.67.0 引入一处会静默打断取证的行为变化：子代理的工具声明现在要与宿主会话的**内建**工具面取交集，而 Reviewer 的 `read` 是 `customTools` 里的自定义实现（`src/reviewer/worker.ts:628` 的 `numberedReadTool`），Pi 给它的来源标记是 `sdk` 而非 `builtin`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2113-2132`）。取证子会话因此只会拿到 `grep/find/ls`，`read` 被剪掉，且 agent 名 `evidence` 不匹配 review/scout 通道，**只发非致命警告，不报错**（[child-tool-plan.ts:407-411,532-543](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/child-tool-plan.ts)）。这是升级的唯一硬阻塞，改法明确但要动代码，不宜顺手带上。0.66/0.67 没有安全公告，留在 0.65.1 无安全风险。

## 版本与依赖

| 版本 | 发布时间 (UTC) |
| --- | --- |
| 0.65.1 | 2026-09-04 23:07:53 |
| 0.66.0 | 2026-09-06 13:18:04 |
| 0.67.0 | 2026-09-10 04:42:45 |

来源 `npm view pi-subagents time --json`。npm `latest` 是 0.67.0，无 prerelease dist-tag。

Pi 侧：`dist-tags` 只有 `latest: 0.85.1`（2026-09-05 12:17:19）与 `legacy-node20: 0.74.2`，0.85.1 之后无新版、无 prerelease。pi-subagents 0.67.0 的 `peerDependencies` 与 0.65.1 **逐字相同**（`@earendil-works/pi-ai >=0.80.0`，其余三项 `*`），0.85.1 满足。`dependencies` 也逐字相同，仍只有 `@earendil-works/pi-server@0.85.0` 这一个 Pi 子包——不会像上一轮那样拉进第二份 `pi-ai`，收拢命令 `pnpm update "@earendil-works/*"` 本轮用不上。

## 触及本仓库铺装点的变更

**会打断取证（0.67.0，#2034）。** 新增 `getHostBuiltinToolNames`，只收 `sourceInfo.source === "builtin"` 的工具；0.65.1 无此函数。后果见「结论」。`test/reviewer-evidence-session.test.ts:143` 断言子会话工具面恰是四件套，升级后必然失败——回归网兜得住，不会静默上线。

**修了我们踩过的坑（0.66.0，#1955/#1957）。** 排除表本体 `model-exclusions.ts` 与 0.65.1 字节相同，但写入前的判定改了：`REQUEST_LIMIT_EXCEEDED` 补进限流模式，且 `!isRetryableModelFailure(error) || isContextOverflow(error)` 直接跳过记录（[model-fallback.ts:538,620](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/model-fallback.ts)）。我们已把 `PI_MODEL_EXCLUSIONS_PATH` 关进 agentDir（`src/reviewer/evidence.ts:75,296`），影响面本就只剩一批；该修复进一步去掉「一次超长上下文废掉本批余下取证」。

**不受影响的铺装点（已逐项比对）。**

- 能力天花板：注册表键 `pi-subagents.capability-ceiling.v1` 两版相同，结构只多一个可选 `unavailableHostBuiltins`（[capability-ceiling.ts:4,33](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/runs/shared/capability-ceiling.ts)）。`src/reviewer/evidence.ts:89,92-101` 无需改。
- config 捕获时机：`const config = loadConfig()` 仍在扩展注册时读一次（[extension/index.ts:433](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/extension/index.ts)），`installKit` 必须先于 `resourceLoader.reload()` 的约束不变（`src/reviewer/worker-tools.ts:325,343`）。
- 父子通话：0.67 新增 `validateIntercomBridgeConfig`，只认 `mode/instructionFile/resultDelivery` 三个键，我们钉的 `{ mode: "off" }` 合法（`src/reviewer/evidence.ts:304`）。默认模板不再插值父会话 id，`{ mode: "off" }` 的语义未变。
- 内置 agent：0.67 多一个内置 `evidence-auditor`（[builtin-names.ts](https://github.com/nicobailon/pi-subagents/blob/v0.67.0/src/agents/builtin-names.ts)）。`disableBuiltins: true` 与天花板 `allowedAgents: ["evidence"]` 两道都挡得住。
- agent frontmatter：`systemPromptMode / inherit*/ allowNestedSubagents / acceptance / async / model / thinking / tools` 在 0.67 全部仍被解析；新增可选 `advertise`，不给即旧行为。
- 用量：子会话汇总 Usage 仍挂在工具返回上（`subagent-executor.ts:2915`），`transcriptPath` 字段数两版一致，`src/reviewer/evidence.ts:341-349` 与「不手工补算」的结论继续成立。
- spawn 预算：`PI_SUBAGENT_MAX_SPAWNS_PER_SESSION` / `..._PER_RUN` 两个环境变量仍被读取，`run-fanout-budget.ts` 只是 0.66 把内部类型名的 `V1` 后缀去掉（#1913），非导出 API。

其余 0.66/0.67 变更集中在后台运行、workflow、FleetView、调度与 TUI——本项目一律前台、不用 workflow，不受影响。

## 留在 0.65.1 的风险

只剩上面那条上下文溢出误入排除表（影响面已被 agentDir 收到一批之内）。无安全修复、无数据损坏类修复指向我们用到的路径。

## 升级时必须改的地方

1. `src/reviewer/worker.ts:628`：取证要用 Pi 内建 `read`，而宿主的 `read` 被自定义实现占着。二选一——把 `numberedReadTool` 改名（如 `read_numbered`）并同步 `src/reviewer/worker-tools.ts:41` 与系统提示；或给取证 agent 的 `tools` 换成宿主确实以 `builtin` 暴露的名字。前者动 Reviewer 的工具面，要重跑全量；后者要先实测 0.67 下 `getAllTools()` 的实际来源标记。
2. `package.json:21`：`pi-subagents` 由 `0.65.1` 改 `0.67.0`（继续钉死不带 `^`）。
3. `test/reviewer-evidence-session.test.ts:143`：四件套断言随第 1 项调整，并补一条「宿主自定义同名工具不会把子会话的 `read` 剪掉」的反向用例。
4. `src/AGENTS.md:35`、`docs/adr/0021-…md`：记下宿主内建交集这道新约束。
5. `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`：0.67.0 已过 24 小时窗口，本轮无需加豁免。

未核实项：0.67 下 `getHostBuiltinToolNames` 对本项目会话的实际返回值没有跑过真实 SDK，上面第 1 项的判断基于 Pi 0.85.1 dist 的注册代码推出，动手前应先用一条探针坐实。

## 2026-09-12 附记：上游已修，等下一版

上面「升级时必须改的地方」第 1 项与第 3 项作废。核对 0.67.0 源码后确认两件事：取证子会话是一份全新的 `createAgentSession({ tools: [名字] })`，名字解析到 Pi 自带的内建工具，宿主的 `customTools` 从不传给子会话（`src/runs/shared/child-session.ts:267-280`，0.65.1 同样），所以取证一直用的是 Pi 内建裸 `read`，与 `numberedReadTool` 无关；剪掉 `read` 的根因是 0.67.0 的 `getHostBuiltinToolNames` 只认宿主注册表里来源为 `builtin` 的条目，同名自定义工具把那一条的来源改成了 `sdk`。

这个缺陷 0.67.0 发布当天就被集中报上去（[#2132](https://github.com/nicobailon/pi-subagents/issues/2132)、[#2133](https://github.com/nicobailon/pi-subagents/issues/2133)、[#2134](https://github.com/nicobailon/pi-subagents/issues/2134)、[#2135](https://github.com/nicobailon/pi-subagents/issues/2135)、[#2140](https://github.com/nicobailon/pi-subagents/issues/2140)、[#2160](https://github.com/nicobailon/pi-subagents/issues/2160)、[#2183](https://github.com/nicobailon/pi-subagents/issues/2183)），已由 [#2143](https://github.com/nicobailon/pi-subagents/commit/d9864f82) 修进 main：判定改为 `source === "builtin" || PI_BUILTIN_TOOL_NAMES.has(tool.name)`（[main 的 child-tool-plan.ts:355-368](https://github.com/nicobailon/pi-subagents/blob/main/src/runs/shared/child-tool-plan.ts)），本项目那条 `sdk` 来源的 `read` 因名字在内建八件套里而算作可用。截至本日 npm `latest` 仍是 0.67.0，修复未发版；main 的 Unreleased 段同时还有「瞬时空响应不再写进 24 小时排除表」（#2154），对本项目有利。

建议改为：跳过 0.67.0，等下一个包含 #2143 的正式版；届时 `package.json:21` 换版本、`pnpm-workspace.yaml` 视发布时间加豁免，跑 `test/reviewer-evidence-session.test.ts` 四件套断言即可验证，源码无需改动。
