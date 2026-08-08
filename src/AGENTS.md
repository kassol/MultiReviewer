# src/AGENTS.md

## 职责

编排服务的全部源码。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `forge/` — Forge 适配层。`forge.ts` 是接口与领域类型,每个平台一个实现文件。
- `git/` — 工作副本的准备与 diff 读取,直接调用 git 命令。
- `review/` — Review Run 的编排。`run.ts` 是唯一入口 `runReview`,其余是它的内部构件:`store.ts` 是 SQLite 持久化,`fingerprint.ts` 算 Finding 的内容指纹并读写评论正文里的指纹锚点,`position.ts` 解析 diff(可评论的行区间与每个文件的改动行数),`batch.ts` 切批并合并各批次的执行结果。
- `reviewer/` — Reviewer 的真实实现。`pi-reviewer.ts` 在主进程侧管子进程,`worker.ts` 是子进程入口,两者只经 `protocol.ts` 定义的消息通信。`numbered-read.ts` 与 `anchor.ts` 是 worker 的行号构件(见下)。
- `webhook/` — `server.ts` 是 webhook 端点:校验签名、把两个平台的投递规范化成同一形状、判幂等、异步触发 `runReview`。
- `main.ts` — 进程入口。读配置与环境变量,建出 Forge 与 Reviewer,起 webhook 服务。

## 模块规范

- 只有 `Forge` 与 `Reviewer` 是注入边界。git 与 SQLite 直接使用实现,不加接口。数据库位置经 `ReviewRunDeps.dbPath` 传入。
- SQLite 用 Node 内置的 `node:sqlite`(`DatabaseSync`)。运行时第三方依赖只有 Pi 一个,不为持久化再引入驱动。它会打 `ExperimentalWarning`,这是已知且接受的代价。
- 落库的是每一条来源 Finding 而非去重合并后的那一条:采纳率要按提出它的模型统计。合并关系记在 `finding.group_index` 上。
- Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的结果,默认 `unknown`。
- Finding 的行号必须是抄来的,不能是模型数出来的(pr-agent、ai-pr-reviewer、claude-code-action 三家开源实现的共同经验;Pi 内建 `read` 返回裸内容,模型在 55 行的文件上实测数偏 4 行)。两层保障都在 worker 内:`numbered-read.ts` 以同名 customTool 覆盖 Pi 内建 `read`,每行加 `N: ` 前缀让模型抄号;`report_finding` 多一个必填 `snippet` 字段(问题起始行的原文),`anchor.ts` 用它核对行号——对得上放行,对不上但文件里找得到就校正到最近的匹配行,找不到打回让模型重报。打回走正常工具返回而非错误:`rejectedToolCalls` 只留给 Pi 的 schema 校验失败,即契约失配信号。
- 跨轮次匹配的锚点是评论正文里的 `<!-- multireviewer:<64 位 sha256 指纹> -->`,不是 comment id——`Forge.createReview` 不回传每条评论的 id。带锚点的评论即本工具发的,人写的评论不参与匹配。
- 匹配的键是 `文件 + 指纹` 而非单看指纹:不同文件里可能有同样的 7 行代码。指纹在新 head commit 的工作副本下重算,相同即代码未变。
- 匹配成功的 Finding 一律不发行级评论,折进 review 正文的 `<details>` 段,已 resolve 与未 resolve 分成两段各自标注。折叠段逐条写全 `file:line`、severity、category、描述与来源模型,误匹配时人展开就能看到完整内容。
- 分批的规模按 diff 的增删行数衡量,不按文件数:50 个各改 2 行的文件不该被切碎,3 个各改 800 行的文件才该切。阈值经 `ReviewRunDeps.maxChangedLinesPerBatch` 传入,不传取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。
- 分批只切 `ReviewRange.files`,`worktreePath` 每批都是同一份完整的 head commit 工作副本。不为分批动 worktree——Reviewer 读不到其他批次改动后的代码就会报出"这个新函数没有调用者"这类误报。
- 同一文件的改动绝不跨批,跨批因此不会出现指向同一处的 Finding。单个文件本身就超阈值时它自成一批,不拒审也不截断:不设批数或预算上限。
- 批次串行,批内 Reviewer 并行。并行跑批会同时开「批数 × 模型数」个子进程,对宿主机不友好。
- 一个模型的多批结果合并成一个 `ReviewerOutcome`,`rejectedToolCalls`、`anomalies`、`usage` 与耗时按批次累加。全部批次都失败才算缺席(记 `failure`,findings 丢弃);部分批次失败时保留成功批次的 Finding 并照常发布,记 `incompleteCoverage`,在 review 正文里与缺席分成两段呈现。
- 汇总去重在全部批次跑完之后做一次,一次 Review Run 只发一次 review。
- 审查不设置任何阻断合并的状态。本工具从不调用 status / check API,`Forge` 接口里也没有这类方法,`createReview` 一律用不阻断的 COMMENT 事件。这是有意的:审查是建议,人保留最终判断权。
- Webhook 单一端点接两个平台,靠请求头区分来源。必须先认 `X-Gitea-Event`——Gitea 为兼容 GitHub 的接收端把 `X-GitHub-Event` 一起发了,先认 GitHub 会把 Gitea 的投递按 GitHub 的 action 拼写解析,结果一条都不触发。
- 签名头两个平台共用 `X-Hub-Signature-256`(`sha256=` 加原始 body 的 HMAC-SHA256 十六进制)。Gitea 另发的 `X-Gitea-Signature` 内容相同、只是没有前缀,不必再认。比对用 `timingSafeEqual`,长度不等时先短路——它在长度不同时抛异常。
- 「PR 新增 commit」的 action 两个平台拼写不同:GitHub 是 `synchronize`,Gitea 是 `synchronized`。规范化后统一为 `new-commit`。凡是照抄 GitHub 拼写的地方都会让 Gitea 收不到事件,依据写在 `webhook/server.ts` 的注释里。
- 拼写之外还有一层:Gitea 的 webhook **订阅**里「同步」是独立事件 `pull_request_sync`,与 `pull_request` 分开(`modules/webhook/type.go`)。只订阅后者时 PR 新增 commit 根本不投递,本服务这边的 action 映射再对也没机会执行。实测确认过——这是部署侧的配置,代码挡不住,只能写进准备步骤。
- 只有 PR 打开与 PR 新增 commit 触发 Review Run。草稿 PR 在触发层用规范化事件里的 `draft` 挡掉,不进 `runReview`。
- Webhook 的状态码语义:签名不过 401,事件类型或 action 不关心 200(投递是成功的,只是没有活要干),body 解析不了或字段对不上 400(平台改字段名时要在投递记录里显形),来源平台还没有 Forge 实现 200(是本服务的配置缺口,不是投递的问题)。
- 幂等键是「仓库 + head commit」,落在 `webhook_delivery` 表的 UNIQUE 约束上,靠插入冲突判重而不是先查后插:并发投递时先查后插会两个请求都查不到、都开跑。`review_run` 上不加同样的约束——人手动重审同一个 head commit 是合法的。
- Webhook handler 立即返回 200,Review Run 在后台跑。后台任务的 rejection 必须接住并记录,否则会变成 unhandledRejection 把这个长跑进程带崩。
- 每条通过签名校验的投递记一行,写明这次做了什么(开始审查 / 草稿不审 / 已审过跳过 / action 不触发 / 非 pull request 事件)。没有这行时,服务正常工作与完全收不到投递在日志上一模一样,只有启动那一句。记录点在签名校验之后:未认证的请求谁都能发,记它们等于把日志交给外人写。日志出口是 `onDelivery`,与 `onRunSettled` 一样是可注入的,测试收进数组而不刷屏。
- `Forge` 接口只包含 Gitea 与 GitHub 都具备的能力(ADR 0002)。实现 GitHub 适配时不得因其能力更强而扩张接口。
- Finding 的优先级是 `P0` / `P1` / `P2`,P0 最高。归一化层同时收下 `critical` / `high` / `medium` / `low` 这类形容词并映射到 P 级——收窄枚举会让模型自造词汇、调用被拒、Finding 全部丢失(ADR 0004),宽松接收加服务端归一化是配套的两半。
- Finding 的 `description` 由模型用中文写,`severity` 与 `category` 保持英文标识符。前者给人读,后者是枚举值。
- 审查进度以 PR 上的 reaction 呈现:开跑挂 `eyes`,跑完未发现问题换 `+1`。零 Finding 且无模型缺席时本工具不发任何 review,没有这个标记时「审查通过」与「审查根本没跑」在 PR 上完全一样。
- 新一轮开跑前先撤掉上一轮的 `+1`:PR 推了新 commit 会再审一次,新代码还没看就挂着旧的通过标记是错的。
- `eyes` 的撤销放在 `finally` 里,成功、失败、中途抛异常都要走到——留着它 PR 上会永远挂着一只眼睛,看起来像审查卡死。
- Reaction 的每一次调用都经 `tryReaction` 包一层,失败只记日志。进度标记是装饰,少一个 emoji 是小事,一次审查因此白跑不是。bot 令牌缺 `write:issue` 时走的就是这条路。
- 两个平台的 reaction 端点都挂在 `/issues/{序号}` 下——PR 在两边内部都是 issue。Gitea 按 content 删,GitHub 要先列出再按 reaction id 删,`Forge` 把这个差异挡在实现里。
- 行号一律指 head commit 中该文件的 1-indexed 行号。Gitea 的 `new_position` 与 GitHub 的 `line` 都是这个语义,接口不暴露 diff 内偏移。Gitea 读回时行号在 `position` 上,`original_position` 是旧文件一侧的行号,两者只有一个非零(`services/convert/pull_review.go` 的 `ToPullReviewComment` 按内部 `line` 的正负分流)。旧侧的评论对应不到 head commit 里的行,直接跳过。
- Gitea 的变更文件状态与 GitHub 拼写不同:「修改」是 `changed`、「删除」是 `deleted`,另有 `copied` / `unchanged`。照抄 GitHub 的 `modified` / `removed` 会把全部修改过的文件误判成新增。
- Gitea 没有「一次列出 PR 全部 review comment」的端点,只能先列 review 再逐个取它的评论。列 review 分页(`page` / `limit`),取评论不分页。`comments_count` 为 0 的 review 直接跳过,省掉一次请求。
- Gitea 的 resolve / unresolve 作用于**评论 id**,端点是 `POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve`,路径里没有 PR 序号,返回 204 无正文。GitHub 那边作用于 thread,`ExistingReviewComment.id` 因此在两个平台上装的是不同的东西,只当不透明句柄用。
- 调用 Gitea API 一律带 `Authorization: token <PAT>`,读取类调用也不例外——目标实例要求登录后才能调用。这条有测试守着,不靠自觉。
- Gitea 的版本检查在 `main.ts` 启动时做一次,不合格就报错退出:版本不够时 resolve / unresolve 会 404,要等到第一次有人处置 Finding 才显形。企业版从 `/api/v1/version` 返回的是自家版本号:对企业版 26.4.4 实测读到 `26.4.4`,不是对应的社区版 `1.26.4`。版本号解析不出来时放行——把合规实例挡在门外比漏检更糟。
- 凭据不写进 remote URL,也不落盘。每次 git 调用以 `http.extraHeader` 传入。
- 模型凭据只经 `MODEL_API_KEY_ENV` 一个环境变量进入 Reviewer 子进程,不进 IPC 消息——消息会被日志与崩溃转储带出去。
- Pi 的 `authPath`、`modelsPath` 与 agent 目录一律指向子进程私有的临时目录。默认值在 `~/.pi/agent` 下,那里的 `auth.json` 存着宿主机上配置过的每一家厂商的凭据。
- 类型只用可擦除语法(`erasableSyntaxOnly`),源码由 Node 直接运行,无构建步骤。模块内互相引用时 import 路径带 `.ts` 后缀。

## 依赖关系

`review/` 依赖 `forge/` 与 `git/` 的类型与函数。`reviewer/` 依赖 `review/` 的领域类型,反向不依赖——`runReview` 只认 `Reviewer` 接口。`forge/` 与 `git/` 互不依赖。`webhook/` 依赖 `review/` 的 `runReview` 与 `openStore`、`forge/` 的接口类型,反向不依赖。`main.ts` 依赖以上全部,只有它读环境变量。

第三方依赖只有 Pi(`@earendil-works/pi-coding-agent`)与它的 `typebox`,且只在 `reviewer/` 内使用。

## 变更日志

- 2026-08-08: 建立 `forge/`、`git/`、`review/` 三个目录。落地 `Forge` 接口与 GitHub 实现、工作副本准备、`runReview` 骨架(issue #2)。
- 2026-08-08: 落地 issue #6。新增 `review/store.ts` 与 `review/fingerprint.ts`。`ReviewerOutcome` 扩出 `usage`,取自 Pi 的 `session.getSessionStats()`,经 `done` 消息回传。Review Range 的 diff 提前到 Reviewer 之前读,使规模能在开跑之前落库。
- 2026-08-08: 落地 issue #7。跨轮次匹配靠评论正文里的指纹锚点,`fingerprint.ts` 扩出锚点的读写。`runReview` 开始时读回既有评论,匹配成功的 Finding 折进 review 正文并把 resolve 状态落进 `finding.disposition`。`Forge` 接口未扩张。
- 2026-08-08: 落地 issue #8。新增 `webhook/server.ts` 与进程入口 `main.ts`。HTTP 层用 Node 内置的 `node:http`,不引入框架。`store.ts` 新增 `webhook_delivery` 表与 `claimDelivery`,并把 SQLite 的 busy timeout 设为 5 秒——webhook 层与后台 Review Run 各持一个句柄写同一个文件,默认的 0 会让撞上写锁的那一方当场报错。注入边界未增加:webhook 层的测试走真实 `runReview` 加内存 Forge 与脚本化 Reviewer。
- 2026-08-08: 落地 issue #9。新增 `review/batch.ts`(切批与批次结果合并),`position.ts` 扩出 `changedLinesByFile`,`run.ts` 的规模统计改由它汇总。`ReviewerOutcome` 扩出 `incompleteCoverage` 表达部分批次失败。`store.ts` 的 `sumUsage` 改为只取 `usage` 一个字段并导出,`batch.ts` 复用它。注入边界未增加。
- 2026-08-08: 落地 issue #3。新增 `forge/gitea.ts`,导出 `createGiteaForge` 与 `assertSupportedVersion`。`Forge` 接口未调整,`forge/github.ts` 未动——Gitea 能做到接口要求的每一件事,没有需要收窄的地方。`main.ts` 填上 `forges.gitea` 那一格,凭据取自 `MULTIREVIEWER_GITEA_URL` 与 `MULTIREVIEWER_GITEA_TOKEN`,没配就不建这一格。测试打在 fetch 边界上(`test/gitea-forge.test.ts`),另有默认跳过的真实实例验证(`test/gitea-live.test.ts`)。
- 2026-08-08: `webhook/server.ts` 补投递日志。此前服务只在失败时输出,收到投递、判定不处理、审查跑完都完全静默,「Gitea 发了但没反应」无从排查。新增可注入的 `onDelivery`,默认写 stdout。
- 2026-08-08: 严重度改为 `P0` / `P1` / `P2`(全链路,含 `report_finding` 的 schema),Finding 描述改由模型用中文写。`Forge` 接口扩出 `addReaction` / `removeReaction`,审查进度以 PR 上的 👀 / 👍 呈现——两个平台都有 reaction,不违反 ADR 0002。GitHub 的 `request` 拆出 `send` 与 `requestVoid`:删 reaction 回 204,在空 body 上解析 JSON 会抛。
