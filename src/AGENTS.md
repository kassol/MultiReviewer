# src/AGENTS.md

## 职责

编排服务的全部源码。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `forge/` — Forge 适配层。`forge.ts` 是接口与领域类型,每个平台一个实现文件。
- `git/` — 工作副本的准备与 diff 读取,直接调用 git 命令。
- `review/` — Review Run 的编排。`run.ts` 是唯一入口 `runReview`,其余是它的内部构件:`store.ts` 是 SQLite 持久化,`fingerprint.ts` 算 Finding 的内容指纹并读写评论正文里的指纹锚点,`position.ts` 解析 diff(可评论的行区间与每个文件的改动行数),`batch.ts` 切批并合并各批次的执行结果。
- `reviewer/` — Reviewer 的真实实现。`pi-reviewer.ts` 在主进程侧管子进程,`worker.ts` 是子进程入口,两者只经 `protocol.ts` 定义的消息通信。

## 模块规范

- 只有 `Forge` 与 `Reviewer` 是注入边界。git 与 SQLite 直接使用实现,不加接口。数据库位置经 `ReviewRunDeps.dbPath` 传入。
- SQLite 用 Node 内置的 `node:sqlite`(`DatabaseSync`)。运行时第三方依赖只有 Pi 一个,不为持久化再引入驱动。它会打 `ExperimentalWarning`,这是已知且接受的代价。
- 落库的是每一条来源 Finding 而非去重合并后的那一条:采纳率要按提出它的模型统计。合并关系记在 `finding.group_index` 上。
- Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的结果,默认 `unknown`。
- 跨轮次匹配的锚点是评论正文里的 `<!-- multireviewer:<64 位 sha256 指纹> -->`,不是 comment id——`Forge.createReview` 不回传每条评论的 id。带锚点的评论即本工具发的,人写的评论不参与匹配。
- 匹配的键是 `文件 + 指纹` 而非单看指纹:不同文件里可能有同样的 7 行代码。指纹在新 head commit 的工作副本下重算,相同即代码未变。
- 匹配成功的 Finding 一律不发行级评论,折进 review 正文的 `<details>` 段,已 resolve 与未 resolve 分成两段各自标注。折叠段逐条写全 `file:line`、severity、category、描述与来源模型,误匹配时人展开就能看到完整内容。
- 分批的规模按 diff 的增删行数衡量,不按文件数:50 个各改 2 行的文件不该被切碎,3 个各改 800 行的文件才该切。阈值经 `ReviewRunDeps.maxChangedLinesPerBatch` 传入,不传取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。
- 分批只切 `ReviewRange.files`,`worktreePath` 每批都是同一份完整的 head commit 工作副本。不为分批动 worktree——Reviewer 读不到其他批次改动后的代码就会报出"这个新函数没有调用者"这类误报。
- 同一文件的改动绝不跨批,跨批因此不会出现指向同一处的 Finding。单个文件本身就超阈值时它自成一批,不拒审也不截断:不设批数或预算上限。
- 批次串行,批内 Reviewer 并行。并行跑批会同时开「批数 × 模型数」个子进程,对宿主机不友好。
- 一个模型的多批结果合并成一个 `ReviewerOutcome`,`rejectedToolCalls`、`anomalies`、`usage` 与耗时按批次累加。全部批次都失败才算缺席(记 `failure`,findings 丢弃);部分批次失败时保留成功批次的 Finding 并照常发布,记 `incompleteCoverage`,在 review 正文里与缺席分成两段呈现。
- 汇总去重在全部批次跑完之后做一次,一次 Review Run 只发一次 review。
- `Forge` 接口只包含 Gitea 与 GitHub 都具备的能力(ADR 0002)。实现 GitHub 适配时不得因其能力更强而扩张接口。
- 行号一律指 head commit 中该文件的 1-indexed 行号。Gitea 的 `new_position` 与 GitHub 的 `line` 都是这个语义,接口不暴露 diff 内偏移。
- 凭据不写进 remote URL,也不落盘。每次 git 调用以 `http.extraHeader` 传入。
- 模型凭据只经 `MODEL_API_KEY_ENV` 一个环境变量进入 Reviewer 子进程,不进 IPC 消息——消息会被日志与崩溃转储带出去。
- Pi 的 `authPath`、`modelsPath` 与 agent 目录一律指向子进程私有的临时目录。默认值在 `~/.pi/agent` 下,那里的 `auth.json` 存着宿主机上配置过的每一家厂商的凭据。
- 类型只用可擦除语法(`erasableSyntaxOnly`),源码由 Node 直接运行,无构建步骤。模块内互相引用时 import 路径带 `.ts` 后缀。

## 依赖关系

`review/` 依赖 `forge/` 与 `git/` 的类型与函数。`reviewer/` 依赖 `review/` 的领域类型,反向不依赖——`runReview` 只认 `Reviewer` 接口。`forge/` 与 `git/` 互不依赖。

第三方依赖只有 Pi(`@earendil-works/pi-coding-agent`)与它的 `typebox`,且只在 `reviewer/` 内使用。

## 变更日志

- 2026-08-08: 建立 `forge/`、`git/`、`review/` 三个目录。落地 `Forge` 接口与 GitHub 实现、工作副本准备、`runReview` 骨架(issue #2)。
- 2026-08-08: 落地 issue #6。新增 `review/store.ts` 与 `review/fingerprint.ts`。`ReviewerOutcome` 扩出 `usage`,取自 Pi 的 `session.getSessionStats()`,经 `done` 消息回传。Review Range 的 diff 提前到 Reviewer 之前读,使规模能在开跑之前落库。
- 2026-08-08: 落地 issue #7。跨轮次匹配靠评论正文里的指纹锚点,`fingerprint.ts` 扩出锚点的读写。`runReview` 开始时读回既有评论,匹配成功的 Finding 折进 review 正文并把 resolve 状态落进 `finding.disposition`。`Forge` 接口未扩张。
- 2026-08-08: 落地 issue #9。新增 `review/batch.ts`(切批与批次结果合并),`position.ts` 扩出 `changedLinesByFile`,`run.ts` 的规模统计改由它汇总。`ReviewerOutcome` 扩出 `incompleteCoverage` 表达部分批次失败。`store.ts` 的 `sumUsage` 改为只取 `usage` 一个字段并导出,`batch.ts` 复用它。注入边界未增加。
