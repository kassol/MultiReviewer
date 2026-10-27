# Agent 会话只读 codemode 接入方案

状态：待评审草案。2026-10-04，项目基线 `a938bd5`。本文提出设计与验收判据，功能尚未实现；正式 spec 通过评审后进入 GitHub Issues。

建议先让 Agent 会话用 codemode 组合现有只读工具，验证跨仓库查询能否减少模型往返和上下文占用。工具查询到的事实与来源必须保留。首期使用现有 Pi 1.0.1；上游资料核对到 1.0.2，codemode、MCP、SDK 三份文档在两版一致。

## 目标与边界

首期覆盖现有三种会话用途，只增加一种调用方式：一次脚本并行查多个仓库、过滤结果、返回所需条目。验收样例是“列出两个仓库指定目录的未处置 Finding，并附相关知识和代码位置”。

脚本允许调用 `read`、`grep`、`find`、`ls`、`git`、`query_findings`、`query_knowledge`。模型原有的直接调用方式保留。知识写入、tracker、提问轮次、产出工具与 `subagent` 继续直接调用。首期保持 Reviewer、规则 agent、合并 agent 与取证子代理的工具面不变；MCP 和非聊天模型另按各自需求接入。

## 当前依据

| 已核实的现状 | 对设计的约束 |
|---|---|
| 会话按用途显式列工具，构造时传 `tools` 与 `customTools`，见 `src/reviewer/session-worker.ts:103`、`:333` | 在现有允许清单增加 `codemode`，保留用途差异 |
| SDK 资源加载与会话构造共用 `prepareAgentRuntime`、`openAgentSession`，见 `src/reviewer/worker-tools.ts:440`、`:507` | 由 Agent 会话调用方传扩展，避免默认影响所有 worker |
| Finding 和知识经 IPC 查询，工具返回文本，见 `src/reviewer/session-finding-tool.ts:144`、`:161`、`src/reviewer/session-knowledge-tool.ts:142` | 增加结构化返回，保留原有文本和查询范围 |
| entries 镜像后由主进程落库并重建，见 `src/reviewer/session-worker.ts:253`、`src/webhook/agent-session.ts:1197`、`:1316` | 复用这条存储链，新增状态必须过重建验证 |
| 面板只从 assistant 的顶层 `toolCall` 构造工具行，见 `web/src/lib/agent-session-records.ts:428`、`:452` | 补上 codemode 内部调用的呈现，不能只显示一条脚本 |

## 接入设计

### 工具与执行边界

在 Agent 会话资源加载器中显式注册 `createCodemodeExtension({ mode: "on", models: false })`，并把 `codemode` 加入该会话的 `tools`。`on` 保留直接工具；`models: false` 使脚本只承担工具组合。扩展代码来自已安装包，调用者目录和宿主配置继续沿用现有隔离方式。

增加一个会话专用的本地扩展处理嵌套调用：依据 `parentToolCallId` 判定是否由 codemode 发起，并按上述七项清单准入。自有写入、交互与产出工具同时声明 `exposure: "model-only"`；来自 pi-subagents 的工具也受嵌套准入钩子约束。所有准入后的调用经过 Pi 的 `ctx.executeTool`，继续执行现有参数校验、路径围栏和工具钩子。源码依据见上游 [工具曝光类型](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/core/extensions/types.ts) 与 [执行入口](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/src/extensions/codemode/execute.ts)。

宿主在 codemode 的 `tool_call` 钩子中解析并规范化脚本选项，建议初始上限为每次 60 秒、返回 4000 token；模型可缩小，上限由宿主保持。再限制单脚本最多 32 次工具调用、最多 4 次同时执行，超限调用明确失败。这些是待实测的固定常量，首期不增加面板设置。时间上限控制 VM；底层查询停止还要单独验收。

Finding、知识查询的 IPC 等待接入工具的 AbortSignal：取消后移除 pending 项，迟到回应丢弃，避免脚本停止后继续挂住等待。已交给数据库的短查询允许完成，结果不再投递。只读 git 子进程同样传递取消信号；现有同步文件读取在返回时结束。停止按钮与服务排空沿用当前 `session.abort()` 链路。

### 查询结果

仅为 `query_findings`、`query_knowledge` 增加 `outputSchema` 与 `structuredContent`，从已有 IPC 结果构造公开返回，逐项挑选所需字段。保留文本 `content`，使直接调用保持可读。结构化结果携带成功或失败状态、原查询范围、结果列表，以及是否可能达到查询上限；空结果和查询失败分别表达。参数或权限拒绝、查询失败同时设置 `isError: true` 和结构化失败状态，使脚本异常、直接调用和面板状态一致；当前普通 `toolText` 失败返回需据此调整。

Finding 继续保留仓库、文件、行号、严重度、处置状态与完整描述；知识继续保留产品或仓库归属、种类、适用范围与正文。脚本可以排序、计数和筛选；最终回答必须引用返回中的位置，查询上限仍按现有 50 条执行，不把“达到上限”说成查全。首期只读文件仍返回带行号文本，读取和路径语义保持一致。

### 状态与面板

成功脚本产生的 `codemode-store` custom entry 随现有 entries 链路落库；脚本失败时不提交其 store 修改。它用于查询游标、ID 和短摘要，业务事实仍在现有表中。首期沿用上游宿主执行的固定限制：单值最多 262144 个 JSON 字符、总值最多 1048576 个 JSON 字符；这份预算独立于 4000 token 输出上限。超限必须失败且不产生 store 条目，验收中单独核对。基点更新路径追加清空脚本缓存的条目，再从新 commit 读取；普通重启与压缩保留状态。要求回答当前 Finding 或知识状态时重新查询，缓存摘要仅作历史上下文。

Pi 的 codemode 结果已有 `details.calls`，包含嵌套调用 ID、工具名、参数摘要、状态、耗时及错误。面板从这份结果扩展工具行，展示“查询了什么、是否成功”，继续隐藏源码正文。失败脚本也显示已经完成的调用；原始结果与摘要不重复累计用量。结构化查询中的内部字段在工具边界裁剪，错误继续走现有凭据脱敏。

上游截断输出会写入宿主临时文件，该路径不在本项目只读围栏内。为该 worker 指定可归属的独立临时输出目录，会话专用扩展在结果钩子中改成“有上限的摘要加缩小查询范围提示”，移除 `fullOutputPath` 及文本中的不可读路径，立即删除这次调用产生的全文文件；异常退出后的目录由父进程回收。仅清理本次创建的文件，保持现有路径围栏。

## 实施顺序

| 步骤 | 拟改位置 | 完成条件 |
|---|---|---|
| 受控执行 | `src/reviewer/session-worker.ts`；新增 `src/reviewer/session-codemode.ts` | 显式启用、七项嵌套准入、限额与取消生效 |
| 查询契约 | `src/reviewer/session-finding-tool.ts`、`session-knowledge-tool.ts`、`git-tool.ts` | 结构化与文本结果一致，取消清理等待 |
| 状态生命周期 | `src/webhook/agent-session.ts` 的基点更新路径 | 缓存随基点更新失效，普通重建保留 |
| 临时输出 | `src/webhook/agent-session.ts` 的 worker 创建与回收路径 | 临时全文归属明确，正常与异常退出都能清理 |
| 记录呈现 | `web/src/lib/agent-session-records.ts` 及使用工具行的组件 | 重建后仍能逐项查看内部调用与失败 |
| 回归与对照 | 现有 `agent-session-tools`、`findings`、`knowledge`、`rebuild`、`drain` 用例及前端 records 纯函数用例 | 下表通过，部署实例对照结果支持启用 |

本方案通过后再按实现调整相关 ADR 和就近规范。文档草案阶段保持既有约定有效。

## 验收与启用判据

| 场景 | 必须观察到的结果 |
|---|---|
| 脚本并行查询，包含一项失败 | 各成功项完整返回；失败项可识别；不混淆两个仓库 |
| 嵌套写知识、建票、提问、派子代理及越界路径 | 调用在对应边界被拒，业务表与文件无副作用；直接调用仍遵守原有用途权限 |
| 无限循环、调用超限、取消后迟到回应 | 在宿主限额内结束，pending 清理，下一条消息能正常执行 |
| 成功 store 后重建；失败脚本后重建 | 成功状态恢复；失败写入不出现；历史回复可正常读取 |
| store 单值或总值超限 | 调用明确失败，没有新增 store 条目，重建仍可用 |
| 更新会话基点后续谈 | 脚本缓存清空；重新读取新 commit；原会话历史仍可回看 |
| 查询达到上限、脚本部分失败、输出截断 | 明确显示范围与失败状态；全文临时文件清理；不声称结果完整 |
| 面板刷新与服务重启 | 内部调用的状态可回看，旧会话和提问卡片照常工作 |

自动化沿用真实 PostgreSQL、临时 git 目录和假模型服务边界；全部改动合并后由主会话跑一次 `pnpm check`。改 web 后另跑前端 typecheck 与 build。上述是未来检查计划，本轮未执行。

收益对照在约定部署实例进行：固定模型及其参数、仓库 commit、知识和 Finding 数据，选跨仓库查询、批量文件检索、单次简单读取三组任务；启用与关闭各重复三次，报告答案事实完整性、来源准确性、模型往返、输入输出 token、耗时中位数及范围。功能与权限用例必须全过；复杂任务成本或耗时需有一致收益，简单任务不能出现明显退化。没有实测收益时维持默认关闭，不扩大到 Reviewer。

首期仅新增测试 harness 的启用参数，部署实例以本次试验镜像比较；是否成为产品默认能力由对照结果决定。回退镜像后保留已有 entries，验证旧版能够跳过 `codemode-store` 并继续读取历史；回退后的新调用恢复原工具面。

## 来源与关联方案

- [Pi codemode 文档](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/codemode.md)：脚本环境、状态与失败语义。
- [Pi SDK 示例](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/examples/sdk/14-codemode-mcp.ts)：显式扩展注册与 `tools` 允许清单的关系。
- [MCP 草案](pi-mcp-proposal-2026-10-04.md)：新增外部资料来源时组合使用。
- [Durable 草案](pi-durable-proposal-2026-10-04.md)：执行中断后的恢复单独评估。
