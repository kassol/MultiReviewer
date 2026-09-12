# Agent 会话的记录原样存 Pi 的会话条目,SQLite 是唯一真相

Agent 会话要跨页面关闭、空闲回收与服务重启续谈(地图 #318,票 #320)。Pi 自己把会话存成 append-only 的 JSONL 文件,也能用 `SessionManager.inMemory(cwd, options, entries)` 从外部条目重建;重建要求条目全量且 `parentId` 链与 compaction 的 `firstKeptEntryId` 引用完整,缺了会静默截断历史而不报错。选定的做法:**Pi 会话不落盘,每条 `SessionEntry` 按 `message_end` / `compaction_end` 等事件原样以 JSON 落进 SQLite 的会话记录表,一行一条,附 seq、类型、时间与用量几列索引;重建时把这张表整段喂回 `inMemory`。**系统消息(被排空中止、静默判死、人点停止、模型切换)以 Pi 的 `custom` 条目落同一张表,不进模型上下文。

## Considered Options

- **Pi 的 JSONL 文件为真相,SQLite 只存索引。**少写一层转换,但数据分两处、备份要连带文件目录,与「没有配置文件、一切在库里」的既有取向相悖。
- **自定义消息表,重建时转换成 Pi 条目。**表结构干净,但 Pi 升版换条目形状时转换层要跟,且最容易丢 `parentId` 与 compaction 引用——丢了 Pi 不报错,只是悄悄少一段历史。

## Consequences

- 会话记录表的行结构跟随 Pi 的 `SessionEntry` 联合类型;升 Pi 时重建路径要回归一遍。
- `entry_appended` 事件只为 custom 条目发出,镜像必须挂 `message_end` 与 `compaction_end`;条目 id 在 `turn_end` / `agent_end` 后回读。
- 重建前自检链完整性;不完整时仍按 Pi 的截断重建,会话上标出「前 N 条不在上下文」让面板提示,不拒绝续谈。
- 用量按条目累加,与 `getSessionStats()` 同口径,与 Review Run 的用量分开。
