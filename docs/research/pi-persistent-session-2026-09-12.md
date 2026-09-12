# Pi 常驻会话能力核验：steer / followUp / abort / 重建 / compaction

日期：2026-09-12。对应 issue #319（地图 #318）。证据全部取自本机实际装着的包，未调用收费模型、未改源码。

装着的版本：`@earendil-works/pi-coding-agent` **0.85.1**（`node_modules/@earendil-works/pi-coding-agent/package.json:3`），同版 pi-agent-core 0.85.1、pi-ai 0.85.1。路径简写：`PI` = `node_modules/@earendil-works/pi-coding-agent/dist`，`CORE` = `node_modules/.pnpm/@earendil-works+pi-agent-core@0.85.1_.../dist`，`AI` = 同理的 pi-ai `dist`。交叉参考 `src/reviewer/worker-tools.ts`。

## 1. steer 与 followUp 的精确语义

- `prompt()` 在 `isStreaming` 时只入队即返回，`streamingBehavior` 缺省直接抛错（`PI/core/agent-session.js:860-872`）。两种入队都只是 `agent.steer()` / `agent.followUp()`，不触发 abort（`:1046-1074`；`CORE/agent.js:173-179`）。
- steering 的消费点只有三个：开跑前、`prepareNextTurn`（含压缩）之后、每个 `turn_end` 之后（`CORE/agent-loop.js:83,106-108,158`），取到后在下一次 LLM 调用前注入为 user 消息（`:112-120`）。
- **不打断正在跑的工具调用**：工具批次一旦开跑整批跑完（`CORE/agent-loop.js:133-146`），steer 只影响下一轮。
- 晚到的 steer 也不丢：`_handlePostAgentRun()` 返回 `agent.hasQueuedMessages()` 触发一次 `agent.continue()`（`PI/core/agent-session.js:776-778,810`），末条是 assistant 时从队列取（`CORE/agent.js:243-252`）。
- **排队的能撤回**：`clearQueue()` 取回文本并清两条队列（`PI/core/agent-session.js:1195-1203`；`CORE/agent.js:189-192`）。已投递的撤不回；投递判定按**文本全等**摘 UI 队列首个匹配项，两条同文排队消息会摘错（只影响 UI 计数，`:363-381`）。
- `"all"` vs `"one-at-a-time"` 只改 `drain()`：前者一次取全部、同一注入点连续 push 成多条消息，后者每次只取队首、余下留到下一边界（`CORE/agent.js:63-75`）。都会全部投递，差别是「合成一轮」还是「一条一轮」。默认 `one-at-a-time`（`CORE/agent.js:128-129`；`PI/core/settings-manager.js:478,486`）。

## 2. abort 之后能否继续，中止那步的工具结果

- **能继续**，同一会话同一 `SessionManager`：`abort()` 停重试/压缩/分支摘要再 `agent.abort()` 并等空闲（`PI/core/agent-session.js:1222-1228`），`finishRun()` 清 `activeRun` 与 `isStreaming`（`CORE/agent.js:366-372`），`prompt()` 的闸门 `_isAgentRunActive` 在 `_emitAgentSettled()` 置否（`PI/core/agent-session.js:616-618,347-356,780-785`）。
- 两个后效：abort **不清队列**；下一次 `prompt()` 会以 `skipAbortedCheck=false` 对被中止的 assistant 再判一次压缩（`:893-896`）。
- 记录侧：被中止的 assistant 照常落盘（`:388-398`）；抛错中止由 `handleRunFailure()` 合成一条 `stopReason:"aborted"` 的空 assistant 再落盘（`CORE/agent.js:349-365`）。已准备的工具调用落 `"Operation aborted"` 错误结果（`CORE/agent-loop.js:353-361,372-378`）；**还没轮到准备的一条结果都没有**（`break` 在 `:321,348,368`），记录里留下无配对 toolResult 的 toolCall。
- 孤儿只在发请求时就地补：`transformMessages()` 插入 `"No result provided"` 的 isError 结果，并把 `aborted`/`error` 的 assistant 整条跳过（`AI/api/transform-messages.js:130-147,153-161`），各 provider 都过这层（anthropic `:779`、openai-responses `:88`、google `:104`、bedrock `:734`、mistral `:26`）。补齐不写回记录。

## 3. `SessionManager.inMemory(cwd, options, entries)` 重建

`entries` 作 `preloadedFileEntries` 传入，`persist=false`（`PI/core/session-manager.js:1254-1256,598-613`）。

- **header 可选**：有就取其 `id`、可能跑迁移（`_rewriteFile()` 在非持久化下为空操作，`:671-679,708-710`）；没有就新建 header + 新 sessionId，entries 接在后面（`:680-683`）。
- 只认 `SessionEntry` 联合里的类型（`PI/core/session-manager.d.ts:105`）。进上下文的仅 `message` / `custom_message` / `branch_summary` / `compaction`（`:166-189`）；`model_change` / `thinking_level_change` 只供读模型与思考档（`:146-161`）；`custom` / `label` / `session_info` 不进上下文。**没有 usage 条目类型**——用量挂在 assistant 与 toolResult 的 `message.usage`，以及 `compaction` / `branch_summary` 的 `entry.usage`。
- 缺条目分三档：缺普通 message 只少这条；缺被别人当 `parentId` 的条目，`_buildIndex()` 以**数组末条**为 leaf（`:691-695`）、`buildSessionPath()` 顺 `parentId` 上行遇缺就静默停（`:124-145`），断点之前全部历史从上下文消失；缺 `compaction.firstKeptEntryId` 指向的条目，压缩点之前一条不留（`:213-225`）。两种静默截断都不报错。
- `getSessionStats()` 遍历 `getEntries()`（含被压缩掉的历史）累加（`PI/core/agent-session.js:2656-2706`）：喂全量则用量连续，只喂 `buildContextEntries()` 结果则从压缩点重新起算。`contextUsage` 另算，压缩后首个有效 assistant 用量出现前返回 `tokens: null`（`:2708-2740`）。

## 4. `subscribe` 的覆盖面、事件顺序与 delta 形状

- **`entry_appended` 覆盖不了**：全 dist 只有一个 emit 点，在扩展桥 `appendEntry` 里只为 `appendCustomEntry` 发（`PI/core/agent-session.js:2029-2035`）。消息、compaction、model/thinking 变更、label、session_info 都直接 `sessionManager.appendXxx()`，不发此事件（`:392,398,1261,1371,1539,1826,2411`）。镜像要挂 `message_end` + `compaction_end` 自己记账。
- 监听器同步调用且忽略返回值（`:313-317`；签名返回 `void`，`PI/core/agent-session.d.ts:103`），写库无法反压；落盘发生在通知**之后**（`:386` 通知、`:388-398` 落盘），监听器里读不到刚写的 entry id，要 id 得在 `turn_end`/`agent_end` 后回读 `getEntries()`。
- 顺序：`agent_start` → `turn_start` → 每条 prompt 消息 `message_start`/`message_end`（`CORE/agent-loop.js:49-54`）→ assistant `message_start` → N×`message_update` → `message_end`（`:199-252`）→ 每工具 `tool_execution_start` →（可选 `tool_execution_update`）→ `tool_execution_end` → 该 toolResult 的 `message_start`/`message_end`（`:297-302,316-318,556-559`）→ `turn_end`（`:147`）→ 第二轮起循环内再发 `turn_start`（`:109`）→ 末尾 `agent_end`（`:170`）。会话层给 `agent_end` 补 `willRetry` 并在收尾后补 `agent_settled`（`PI/core/agent-session.js:386,347-356`）。
- delta：`message_update` 带 `assistantMessageEvent`（`CORE/types.d.ts:392-394`），类型为 `text_*` / `thinking_*` / `toolcall_*` / `done` / `error`，各带 `contentIndex`、增量 `delta` 与到此为止的 `partial`；`partial` 是共享活对象，不是事件时刻快照（`AI/types.d.ts:403-460`）。

## 5. 上下文增长：compaction

- 三个入口一个底座：手动 `compact(customInstructions?)` 先 `abort()`、不续跑被打断的回合（`PI/core/agent-session.js:1474`）；阈值与溢出走 `_checkCompaction()` → `_runAutoCompaction()`（`:1634-1728,1739`）。
- 触发判定 `shouldCompact(contextTokens, contextWindow, settings)`，token 优先取真实 usage，error/零用量时退回 `estimateContextTokens()`（`:1701-1726`）；溢出与可恢复截断会把失败的 assistant 从 state 摘掉、压缩后重试一次（`:1658-1695`）。`enabled:false` 直接不压（`:1636-1637`），本项目正是这么关的（`src/reviewer/worker-tools.ts:327-330`）。
- 形状：追加一条 `compaction` 条目（`summary`/`firstKeptEntryId`/`tokensBefore`/可选 `details`/可选 `usage`/`fromHook`，`PI/core/session-manager.d.ts:36-47`），历史一条不删（append-only 树），随后 `agent.state.messages` 由 `buildSessionContext()` 整体重建（`PI/core/agent-session.js:1539-1542,1826-1829`）。上下文视图 = 该 compaction（投影成带前后缀的一条 user 消息，`PI/core/messages.js:103-110`）+ 从 `firstKeptEntryId` 起保留的旧条目 + 压缩点之后全部条目（`PI/core/session-manager.js:213-225`）。切点只落 user 或 assistant，不落 toolResult（`PI/core/compaction/compaction.d.ts:82-84`）。

## 对底座设计的含义

- 排队与插话不用自造：`prompt(text, {streamingBehavior})` + `clearQueue()` 覆盖插话、追加、撤回，且 steer 不打断工具，工具事务性无需额外保护。
- 镜像进 SQLite 挂 `message_end`（加 `compaction_end`、`queue_update`），**不能**指望 `entry_appended`；监听器同步无反压，entry id 在 `turn_end`/`agent_end` 后回读。
- 重建必须喂全量 entries 且 `parentId` 链完整：链断或 `firstKeptEntryId` 丢失都静默截断历史，只能靠我们自己校验。
- 用量连续性与重建口径绑死：`getSessionStats()` 按全部条目累加；`contextUsage` 在压缩后首个有效回复前必定为 `null`。
- abort 会在记录里留下无配对 toolResult 的 toolCall，补齐只发生在 `transformMessages()`。自己拼上下文绕过 provider 层就得自己补。
