# Pi Durable 接入方案草案

状态：待评审。本文提出方案，尚未形成 ADR、正式 spec 或实施授权。核查日期为 2026-10-04，上游基线为 `pi-durable 1.0.2`；该包仍标注实验性，API 可变化。[U1]

建议先验证一个 Reviewer 在一个批次、一个模型内的中断恢复。目标是保留已提交的取证、Finding、复核结论和用量，减少整段会话重跑。现有结果按完整 Reviewer 会话落库；Finding 与复核结论在此之前由主进程数组保存，用量在子进程结束时汇总。[L1–L3]

## 范围与责任

首期只改 Reviewer 执行层。Review Run 恢复、切批、合并、Disposition 与 Forge 发布仍归现有编排；Agent 会话、规则 agent、合并 agent、多副本调度和任意 MCP 写工具不在范围内。现有 `resumeInterruptedRuns → resumeRun → runReview` 保留准入判断，已存在的 batch outcome 直接复用，缺结果时才打开 Durable 会话。[L4]

新增执行记录，以 `(runId, batchIndex, model)` 唯一定位。启动时固定请求、历史、规则与事实、阈值、取证上限、模型完整 pin、提示与工具契约版本。现有 pin 表含运行参数，恢复链目前只比较模型 identity；方案补全 `modelServiceVersion / runtimeModel / thinkingLevel` 的恢复核对。模型服务与凭据只保留当前记录：先确认当前服务版本、目标及运行参数与冻结 pin 兼容，再取当前有效凭据，允许同目标合法轮换；凭据不写入 checkpoint，不新增历史凭据库。不兼容或不可用即明确失败，禁止静默换模型。[L5]

保留现有 head、知识集版本、阈值、完整批次计划门禁及历史快照。产品知识维持现有实时查询语义：已完成查询复用其持久化返回；新查询读当前内容，恢复时不得把新内容塞进旧结果。[L6]

## 存储与唯一执行者

生产和测试均实现 PostgreSQL `Storage`，经 Drizzle 管理 schema 与迁移。上游仅随包提供 Memory、SQLite、JSONL；这项适配是实施前置条件。[U1] 延续 ADR 0036 的父行锁，无 SQLite 或 advisory lock。[L7]

主进程持有 Store 与数据库连接；worker 运行 Harness，通过 IPC 存储代理提交，收到持久化确认后才继续。进程内登记限制每个执行记录一个 worker；重开前确认旧 worker 退出。每次接管在父行 `FOR UPDATE` 下递增 epoch，每次提交核对 epoch 和递增序号，旧 worker 的迟到提交拒绝。提交携带稳定 commitId，确认丢失后查回原提交，不重复应用。IPC 断开立即退出 worker。首期沿用单服务部署，只接续已退出实例的任务，不增加租约、自动抢占或高可用调度。

## 恢复必须保留评审事实

拟新增领域进度记录 `ReviewProgress`，保存按调用 ID 索引的规范化 Finding、verdict、异常、拒绝分类、取证派单、续问状态及结果，工具数与回合数从已提交记录派生。`report_finding` 与 `review_prior_finding` 的执行只校验并返回结构化 `details`，复用现有锚定和归一化规则；不再靠 IPC 到达即修改内存计数。[L2]

PostgreSQL 的一次 Storage 提交同时写工具结果、任务状态、用量与领域投影；纯投影器由新提交的结果更新 `ReviewProgress`。调用 ID 防重复，verdict 按提交序号保留最后结论；schema 拒绝与锚定拒绝分开计数。续问是否执行、取证次数占用也随对应任务创建提交，重启不重置预算。流式进度只作展示。[U2][L2]

模型用量随模型结果提交，子会话用量只汇总一次；恢复读取持久化总量，不累加重新播放的事件。[L3] 未获得供应商最终 usage 的中断请求仍可能收费，记录用量不完整，不承诺准确还原账单。子会话结果、查询返回和工具中间输出都进入持久化记录。完成时以事务写入现有 batch outcome 并标记执行记录已交付；重复交付读取原结果。正式 Finding 与统计仍由原轮次收尾产生。[L1]

这会扩展 ADR 0017 当前仅保留工具返回长度的持久化边界。新增会话正文与工具结果只服务未完成执行的恢复，独立于永久审查轨迹；交付 batch outcome 后清理这些重数据，保留执行版本、用量和交付摘要。不可恢复的执行先记录失败结果再清理，启动时补清已交付残留。现有面板继续只读审查轨迹，不直接开放恢复存储。原型同时测量峰值数据量与清理效果，批准生产接入前修订 ADR 0017、0024 和相关就近规范。[L12]

## Harness 和工具迁移

Durable 使用独立 Harness、registry、task 与 Conversation；现有 `createAgentSession`、内存 SessionManager 和 Pi 扩展不能直接搬入。[U1][L8] 首期新增独立 worker，复用提示、工具校验和领域归一化，适配轨迹事件。Reviewer 取证改用 Durable 子会话；保留现有只读工具、固定模型、前台等待、取证预算与既有调用契约。`pi-subagents` 继续服务原 Agent 会话；其 Pi 扩展钩子、预算、transcript 和 usage 接口需要逐项实现等价行为，这是主要迁移成本。[L9]

固定 commit 的只读工具可声明 safe replay；报 Finding 与复核依靠上述调用 ID 去重。外部副作用不具有 exactly-once 保证；首期 Forge 发布留在既有流程，未来写工具须先定义业务幂等或对账。[U2] 普通模型流中断会重发请求，调度器复用已提交工具结果。[U3]

恢复先重建固定 head 的工作树，再开放 Harness。沿用 `prepareWorktree`，保存逻辑根与 commit，将工具路径解析到新树，拒绝旧绝对路径越界；commit 不可达即失败。当前 PR head 已变化仍按既有门禁结束原轮。[L4][L10]

## 版本与回退

执行记录固定 Durable 精确版本、存储格式、工具契约和 prompt 版本。首期只恢复完全兼容版本；升级需显式迁移与回归。保留原 worker，接入选择在轮次启动时固定，不增加通用运行时选择平台。暂停新增 Durable 轮次后先排空或终结存量，再回退镜像；旧镜像不能恢复新 Harness 状态。完成的 batch outcome 可继续复用，放弃中的调用须保留已记用量与终止原因，不能伪装成未执行。

## 实施顺序与验收

1. 先做 PostgreSQL Storage 与 IPC 原型：拟增 `src/review/schema/reviewer-executions.ts`、`src/review/store/reviewer-executions.ts`、`src/reviewer/durable-storage.ts` 及生成迁移。官方 Storage conformance suite 跑真 PG；验证提交前后杀进程、重复提交、双 worker 和迟到 epoch。
2. 再加 `src/reviewer/durable-worker.ts` 与领域投影，修改 `protocol.ts`、`pi-reviewer.ts`；验证 Finding/verdict、两类拒绝、续问、取证预算和子会话结果的中断恢复。假模型固定输出，对比连续执行与恢复后的领域结果和用量。
3. 最后接 `run.ts`、`store/runs.ts`、`webhook/server.ts`：覆盖原恢复门禁、完整模型 pin、工作树重建、最终交付崩溃及回退。扩充 `run-resume`、`restart-recovery`、Reviewer 契约测试，完成 `pnpm check`。

随后按既有构建推送与部署流程，在已约定部署实例验真实 Review Run、进程中断恢复和评论去重；本机不另起验收服务。本轮只交付方案，不访问主机。原型证明持久化开销可接受、真实中断确实减少重跑后，再决定生产接入。[L11]

[codemode 草案](pi-codemode-proposal-2026-10-04.md) 与 [MCP 草案](pi-mcp-proposal-2026-10-04.md) 首期作用于 Agent 会话，均不作为本方案前置条件。

## 源码与上游依据

源码行号基于本轮读取；拟新增文件均已在正文标明，以下均为现存文件。

- L1：`src/review/run.ts:2348–2360,2417–2432`，完整会话结果复用与落库；`src/review/store/runs.ts:452–465`，batch outcome 写入；`src/review/schema/runs.ts:81–95`，中间态与正式统计边界。
- L2：`src/reviewer/worker.ts:642–708,798–827`，内存计数、锚定、续问结论和收尾；`src/reviewer/pi-reviewer.ts:110–119,162–190`，Finding 归一化、verdict 最后值与数组。
- L3：`src/reviewer/worker-tools.ts:572–590`，主会话与取证用量汇总。
- L4：`src/webhook/server.ts:10660–10724`，启动续跑与失败改判；`src/review/run.ts:1945–2004,2023–2036,2348–2360`，恢复准入与结果复用。
- L5：`src/review/schema/runs.ts:58–78`，完整 pin；`src/review/store/runs.ts:490–519`，恢复只读 identity；`src/review/schema/repos.ts:83–119`，模型服务与凭据按 provider 保存当前记录；`src/webhook/server.ts:909–945,975–996,10668–10679`，当前计划与凭据物化。
- L6：`src/review/run.ts:2102–2109,2132–2164`，历史快照、产品知识目录与实时正文读取。
- L7：`docs/adr/0036-persistence-moves-to-postgresql-through-drizzle.md:5–13`，PG、Drizzle、父行锁及排除方案。
- L8：`src/reviewer/worker-tools.ts:507–524`，现有 AgentSession 创建。
- L9：`src/reviewer/evidence.ts:279–318,325–347,477–503`，子代理铺装与权限钩子；`src/reviewer/worker.ts:763–771`，取证 transcript 转轨迹。
- L10：`src/git/worktree.ts:196–228`，指定 commit 的一次性工作树。
- L11：`AGENTS.md:43–64,108–120,162`，构建、部署与实例验收约定；验收执行前再次核对就近文档和跨工具记忆中的实例。
- L12：`docs/adr/0017-review-trace-is-stored-as-event-rows.md:5–10`，工具正文与审查轨迹的现有持久化边界；`docs/adr/0024-batch-is-the-recovery-grain-of-a-review-run.md:5–7`，当前恢复粒度。
- U1：[v1.0.2 README](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/README.md)，独立 Harness、实验性、存储后端及单 owner；[CHANGELOG](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/CHANGELOG.md#L3)，2026-10-04 版本。
- U2：[Storage 接口](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/types.ts#L993)，原子提交；[ToolTask](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/tool.ts#L85)，执行意图、safe replay 与 interrupted；同文件 `362–383,438–459`，结果、任务与用量提交。
- U3：[GenerationTask](https://github.com/earendil-works/pi/blob/v1.0.2/packages/durable/src/harness/generation.ts#L185)，普通请求恢复；同文件 `350–361,401`，partial 中断条目及重新调用模型。
