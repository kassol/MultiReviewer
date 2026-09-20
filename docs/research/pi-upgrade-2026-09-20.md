# Pi 0.86.0 与 pi-subagents 0.69 / 0.70 跟进(2026-09-20)

当前钉法:`@earendil-works/pi-coding-agent ^0.85.1`、`pi-subagents 0.68.0`。npm 最新:Pi 0.86.0(2026-09-19)、pi-subagents 0.70.0(2026-09-19,中间有 0.69.0)。来源是 `npm pack` 解出的包内 CHANGELOG、`.d.ts` 与源码,对照 `node_modules` 现版本;未跑 typecheck 与真实 SDK 回归,结论停在「读包」这一层。

## Pi 0.85.1 → 0.86.0

**破坏性变更三条,本项目都不触发。**

- 自定义 provider 的流入参 `Context` → `TranscriptContext`,只改 `ApiStreamFunction`(`pi-ai/dist/compat.d.ts:39-40`)。本项目只按 api 名注册内置适配器(`src/reviewer/model-runtime.ts:74`),顶层 `streamSimple` / `completeSimple` 仍收 `Context`。
- `ToolCall.arguments` → `JsonObject`、`ToolResultMessage` 变条件类型(`pi-ai/dist/types.d.ts:265/376`)。本项目改参数走 `CustomToolCallEvent.input`,该类型未变;读 details 全程 `unknown` 断言(`src/reviewer/evidence.ts:501-527`)。
- `user_bash` fails closed:本项目不注册 bash。

`createAgentSession` 签名 diff 为空,`noSkills` / `additionalSkillPaths` / `resizeImage` 都在。0.86 的依赖全线 `^0.86.0`,升级照 issue #265 的做法用 `pnpm update "@earendil-works/*"` 收拢重复副本,并更新 `pnpm-workspace.yaml` 的发布年龄豁免。

**升级即得的修复(都落在本项目真实走的路径上)。**

- Anthropic 兼容中转回不同 response model 时,签名思考重放损坏(#9188)——自定义 `anthropic-messages` 网关那条路。
- 无 body 的 400 / 413 被误判成上下文溢出(#9482)——自定义网关高发。
- mid-run 阈值 compaction 静默跳过超大尾部 tool result(#9740)——Agent 会话开着自动 compaction(`src/reviewer/worker-tools.ts:434-459`)。
- agent 级重试退避封顶 `retry.maxAgentDelayMs`,默认 60 秒——少撞 5 分钟静默判死(`src/reviewer/subprocess.ts:21`)。
- 取消竞态误启动 compaction / 残留重试状态(#9340、#9777)——排空中止那条路。
- `EventStream` 排空的二次方 CPU(#9055)。

**现有 workaround 逐条核对,没有一条变多余。**剥 `supportsMidConvoEffort` 仍要(0.86 的 `anthropic-messages.js` 仍据它插 `output_config`);`read` 的 realpath 圈根与带行号读、关默认 skill 扫描、5 分钟静默判死、图片 image-ref ↔ base64、pi-catalog 回落基线都没有上游等价物。OpenRouter 负单价归零那一处已随 issue #188 撤计费而不在代码里。

**新能力。**

- `compaction.modelOverrides`:按模型设 `reserveTokens` / `keepRecentTokens`(`settings-manager.d.ts:4-12`)。Agent 会话可按辅助模型的上下文窗口调压缩预算。
- `compat.allowedFallbackModels`(`model-config.d.ts:122-138`):自定义网关可禁掉 Anthropic 服务端 fallback。
- `cacheWarming`:Reviewer 跑一次即退出,收益存疑;`idle` 模式会花钱,不开。
- 0.86 默认给内建 read / bash / edit / write 开约束采样。本项目同名覆盖 `read`,不受影响;网关不兼容时有 `constrainedSampling: false` 可关。

**运维注意。**0.86 的 deepseek 目录把 `deepseek-v4-flash` 换成 `deepseek-flash`(`pi-ai/dist/providers/data/deepseek.json`)。根 `AGENTS.md` 常用命令里的 smoke 模型名随升级过期;内置 deepseek 服务刷新目录会丢旧行,库里已注册的运行时不受影响。

## pi-subagents 0.68.0 → 0.70.0

0.69.0 对本项目零收益(typed gate、Ghostty 守卫、npm stderr 静默),跳过。0.70.0 是分水岭:npm 包只发编译产物(`.js` + `.d.ts` + `.map`,fix #2300),`pi.extensions` 从 `./index.ts` 变 `./index.js`。三版 peerDependencies 逐字相同,`pi-server` 没有加回来。

**契约风险两处,其余逐项同形。**

- 包形态变 `.js`:`vendoredSubagentsPath()`(`src/reviewer/evidence.ts:155`)仍解析到包根,Pi 资源加载器吃不吃得下要真实 SDK 回归验。
- 新模块 `runs/shared/usage-reconciliation.js` 命中前台路径(`runs/foreground/execution.js:48`):按子会话 assistant 消息**替换** live usage,读起来不会双计;issue #260 的「只计一次」靠 `test/reviewer-evidence-session.test.ts` 那五条用量用例重验。
- 天花板 `allowedTools`、`disableBuiltins`、`asyncByDefault` / `intercomBridge`、两个 spawn 环境变量、会话上限文案、`transcriptPath`、`acceptance: none` 都在且同形。

**升级即得。**

- 冷启动:Pi 不再经 jiti 转译扩展,上游测得入口加载 226 ms 对 2831 ms。每个 Reviewer 子进程与会话子进程各省一次,随批次数 × 模型数线性叠加。
- 0.70 整层删除 `hostAvailableBuiltins`(fix #2289):0.67 那类「宿主同名工具让子会话的 read 被静默剪掉」的成因结构性消失。
- 前台子会话 live 用量缺失时的零用量条目(#2295 / #2296)。

**可删的代码。**`src/reviewer/evidence.ts:88-152` 手写的天花板登记表(约 55 行加一段解释「为什么不能 import」的注释)可换成 `import { registerSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling"`。0.68 下这条导入报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`(注释说的正是这个原因),0.70 导出的是编译产物(`package.json` 的 `exports["./capability-ceiling"]`),导入成功且登记项与手写那份同形。官方 API 另返回 `dispose()`,天花板能随会话回收。

`subagentOnlyExtensions` 与 frontmatter `allowedAgents` 对本项目无增益:前台子会话本就只加载列出的 extensions,`allowNestedSubagents: false` 已覆盖。

## 建议

两个一起升:Pi → 0.86.0,pi-subagents → 0.70.0。验证清单:`pnpm typecheck`、真实 SDK 取证回归(`test/reviewer-evidence-session.test.ts`)、`MULTIREVIEWER_SMOKE_*` 真模型契约(模型名改 `deepseek-flash`)、部署实例上一轮带取证的 Review Run 与一场 Agent 会话。
