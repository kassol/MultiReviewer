# Pi MCP 外部资料接入方案草案

状态：待评审，2026-10-04。本文提出设计选择，尚未成为 ADR 或正式 spec；本轮未改代码、未验收部署实例。

建议从一个产品的一台真实只读 MCP server 开始，只接 Agent 会话。用途是查询外部产品文档、接口说明等资料。现有 Gitea、产品知识与产品 tracker 保留当前接口。MCP 可独立使用，也可与 codemode 方案组合。

## 现状与目标

Agent 会话按用途注册工具，知识与 tracker 请求经 IPC 交主进程执行。普通会话由创建者或管理员读取；产品梳理可被拥有任一产品仓库分配的用户读取。会话使用私有临时 agentDir、显式资源加载器与工具允许清单，目前没有 MCP 扩展。[证据 1–3]

目标是一条完整路径：管理员绑定资料源 → 有权用户在会话提问 → agent 查询并给出处 → 会话重建后仍能回看引用。Reviewer、取证子代理、规则与合并 agent 首期保持现有工具面。

## 接入边界

- **传输**：首期选 HTTPS Streamable HTTP，以产品专用、只读、限定资料库的服务凭据认证。这样服务生命周期由资料源负责。stdio 要增加二进制供应链、进程回收及文件访问边界，留待确有本地资料源时另评；本期无命令输入框、动态安装、OAuth 登录与任意 URL 访问工具。
- **授权**：管理员核对真实工具语义，保存供应商原名与 Pi 最终名的精确允许清单，默认 `hidden`，仅名单内工具设 `direct`。`readOnlyHint` 等 annotations 只作说明。新工具、schema 漂移、名称归一化冲突一律暂停该源，重新校验后启用。额外 `tool_call` 闸门复核名单和参数范围；资源三工具首期不开放，防止绕过工具名单。[证据 4]
- **产品与仓库**：每产品最多一个源、独立凭据、每会话独立连接。资料库须属于该产品；供应商凭据和查询参数共同限定资料范围。推荐首期采用**管理员专用的外部资料会话**：仅在新建开放对话时选择，持久保存不可清除的 `externalSourceSnapshot`，包含源标识、URL 与批准的资料范围。列表、详情、记录、图片、SSE、后续消息以及将来的导出均先检查当前管理员身份；撤权立即关闭订阅及连接。删除源、修改产品仓库都不移除此门禁，旧记录仍按快照审计。首期移除这类会话的知识/tracker 写工具及相关写作 skill，避免摘录经共享产品实体扩散。普通会话与产品梳理保持原行为。[证据 3]
- **配置**：产品设置页新增仅系统管理员可写的资料源区：固定供应商、URL、只读 token、精确工具名单、启停及连接检查。新增 `product_mcp_source` 表存产品关联、上述配置、加密凭据、校验后的 schema 摘要和更新时间；复用 AES-GCM 凭据函数，不与模型服务记录混用。URL 必须落在试点供应商的部署级精确地址允许清单；禁止跨源重定向携带凭据。[证据 5]

## SDK 与结果路径

在 `session-worker.ts` 的会话扩展中显式加入 `createMcpExtension`，传入 `loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false })`，再由项目内扩展调用 `pi.registerMcpServer` 注册主进程核验后的单一源。这样加载器完全绕开全局与工作树 `mcp.json`，文件配置无法覆盖注册值。保留 `tools` 限制，只追加名单中的确切名称；调用 `session.bindExtensions({})` 启动连接。MCP 单独启用时使用 `direct`。codemode 草案首期嵌套名单只有七件内部只读工具；两方案组合时，必须在其 `parentToolCallId` 授权钩子中显式追加本产品核准的确切 MCP 工具名，启用脚本工具本身不会扩大名单。[证据 2、6]

主进程解密后仅把该源凭据交给对应会话子进程，明文不进 prompt、会话记录或日志。停用、删除、凭据或权限变化中止调用并回收受影响会话；token 轮换后可重建，URL 或资料范围变化要求新建会话。产品删除同时删除绑定与密文。历史引用沿用会话保留期及上述门禁，回看无需重连资料源。

Pi 将完整 MCP `CallToolResult` 放入工具结果的 `structuredContent`，其中又可包含供应商的 `structuredContent`。适配层同时处理 `content`、内层结构化数据及 `isError`，保留来源 URL/资料 ID。[证据 7] 首期仅接文本与 JSON；自定义 transport 的 `fetch` 在反序列化前按读流字节计数，将正常和错误响应限为 1 MiB，SSE 另设 `maxMessageBytes`。送入模型及记录最多 20 KiB，超限给出明确错误或分页指引。`tool_result` 同步缩减文本和结构化数据，并清除 `details.fullOutputPath` 及内容里的全文路径；Pi 转换时已经生成的临时全文当场删除，仅删除适配器登记的 SDK 产物。会话记录只留筛选后的引用与摘录。[证据 9]

连接预算 10 秒；单次请求超时 30 秒，另设不被进度通知延长的 60 秒绝对截止。通过 `createTransport` 包装请求 ID 的截止计时与取消，并保存本会话 transport 句柄。当前 `drain()` 直接退出进程，`session.dispose()` 也没有触发 MCP 的关闭钩子；实施时须补统一关闭入口：停止、排空和回收先取消请求并等待 `transport.close()`，最多 2 秒，再走现有收拢和强杀兜底。[证据 8] 工具调用失败不自动重放，返回资料源不可用及原因类别，内部阅读工具继续可用。审计只记产品、会话、调用 ID、工具名、配置摘要、耗时、结果字节数、成功或失败；组合 codemode 时附父调用 ID。禁止记录凭据和完整查询正文。[证据 4、6]

## 实施与验收

| 阶段 | 预计文件范围 | 完成条件 |
|---|---|---|
| 供应商试点 | 新增 `src/reviewer/session-mcp.ts`；修改 `session-worker.ts`、`session-protocol.ts`、`session-skills.ts`、`session-purposes.ts`、`worker-tools.ts`、`webhook/agent-session.ts` | 假 MCP 完整走通显式注册、查询、引用、取消及清理 |
| 配置与授权 | `src/review/schema/{products,sessions}.ts`、`src/review/store/{products,sessions,index}.ts`、`drizzle/`、`src/webhook/server.ts`、`web/src/products.tsx`、`web/src/agent-session.tsx`、`web/src/api.ts` | 管理员绑定及撤销生效；跨产品和非管理员请求被拒 |
| 验收与文档 | 新增对应会话集成测试；方案获准后更新相关 AGENTS、CONTEXT 与 ADR | 本机规定检查通过；沿用已约定部署实例完成真实 server 验收 |

最小验证矩阵：①正确资料与引用，文本/结构化数据/`isError`；②未知工具、伪造只读 hint、schema 漂移与资源入口拒绝；③跨产品、撤权断 SSE、删源后旧记录仍受限、凭据轮换及恶意 `mcp.json`；④超时、持续进度、停止、排空、断连、超大 JSON/SSE 与临时全文清理；⑤重建可回看、共享写工具不可用且日志无密钥；⑥MCP 单独与 codemode 组合执行同一授权判据。真实验收用部署实例，禁止以开发机服务替代。

进入真实集成前仅需确定两项输入：**试点产品及真实 server 的 URL、工具文档与认证方式；该产品可读取的资料库范围和测试凭据**。当前按“支持 HTTPS、服务 token、可限定资料库的只读 server”设计；若实际只提供 OAuth 或 stdio，调整传输与认证方案后再实施。

组合调用采用 [codemode 草案](pi-codemode-proposal-2026-10-04.md) 的工具边界；[Durable 草案](pi-durable-proposal-2026-10-04.md) 首期只覆盖 Reviewer，两者独立评审。

## 证据索引

代码位置核对于 2026-10-04；上游公开资料使用 v1.0.2，当前安装包的对应实现为 1.0.1。本文所列上游能力是已核实接口，参数预算、授权门槛与表结构均为本方案建议。

1. 当前会话工具与 IPC：`src/reviewer/session-worker.ts:103`、`:294`、`:341`；`src/reviewer/session-tracker-tools.ts:74` → `src/webhook/agent-session.ts:1029` → `src/webhook/product-tracker.ts:145`。会话记录写入：`src/webhook/agent-session.ts:1197` → `src/review/store/sessions.ts:330`。
2. 私有 agentDir、显式资源加载、严格工具清单：`src/reviewer/worker-tools.ts:442`、`:463`、`:508`；会话重建：`src/webhook/agent-session.ts:1316`。
3. 仓库范围及产品梳理例外：`src/webhook/agent-session.ts:301`；现有会话可见性：`src/webhook/server.ts:2559`、`:2578`；记录与 SSE 复用该判定：`:2913`、`:2941`。
4. 传输、工具曝光、完整结果、取消和权限钩子：[Pi v1.0.2 MCP 文档](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/mcp.md)。执行传递 signal：`node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js:203`；动态工具注册与曝光：`dist/extensions/mcp/index.js:296`。
5. 现有密钥变量与加解密：`src/panel/credential-crypto.ts:17`、`:32`、`:48`。
6. 显式扩展与 `bindExtensions`：[Pi v1.0.2 SDK 文档](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/sdk.md#codemode-mcp)。`loadConfig`、`createTransport` 扩展点：`node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/index.d.ts:33`；空配置形状：`dist/extensions/mcp/config.d.ts:47`；默认文件加载及替代调用：`dist/extensions/mcp/index.js:875`、`:1097`。同一索引内省略包前缀的 `dist/` 均属于该安装包。
7. 结果封装：`node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js:151`；`tool_result` 可以同时改写结构化内容：`dist/core/extensions/types.d.ts:1077`。现有部署验收规范：`AGENTS.md:162`。
8. 当前排空直接退出：`src/reviewer/session-worker.ts:535`；Pi `dispose()` 清监听：`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:977`；MCP 连接关闭监听的是 `session_shutdown`：`dist/extensions/mcp/index.js:1011`。
9. 先写临时全文后回传路径：`node_modules/@earendil-works/pi-coding-agent/dist/extensions/mcp/tools.js:90`、`:157`；HTTP transport 接受自定义 `fetch` 与 `maxMessageBytes`：`node_modules/.pnpm/@earendil-works+pi-mcp@1.0.1/node_modules/@earendil-works/pi-mcp/dist/transports/streamable-http.d.ts:27`；JSON 路径直接 `response.json()`、SSE 路径限制事件大小：同包 `streamable-http.js:184`、`:272`。
