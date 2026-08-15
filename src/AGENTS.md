# src/AGENTS.md

## 职责

编排服务的全部源码。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `forge/` — Forge 适配层。`forge.ts` 是接口与领域类型,每个平台一个实现文件。`gitea-hooks.ts` 是 Gitea 专属的 hook 管理模块,不进 `Forge` 接口(ADR 0002 的能力交集不含 hook 管理,面板只服务 Gitea)。
- `git/` — 工作副本的准备与 diff 读取,直接调用 git 命令。
- `review/` — Review Run 的编排。`run.ts` 是唯一入口 `runReview`,其余是它的内部构件:`store.ts` 是 SQLite 持久化,`fingerprint.ts` 算 Finding 的内容指纹并读写评论正文里的指纹锚点,`position.ts` 解析 diff(可评论的行区间与每个文件的改动行数),`batch.ts` 切批并合并各批次的执行结果。
- `reviewer/` — Reviewer 的真实实现。`pi-reviewer.ts` 在主进程侧管子进程,`worker.ts` 是子进程入口,两者只经 `protocol.ts` 定义的消息通信。`numbered-read.ts` 与 `anchor.ts` 是 worker 的行号构件(见下)。
- `webhook/` — `server.ts` 是 HTTP 入口:路由表分发 `POST /webhook`(投递:准入验签、规范化两个平台的形状、判幂等、异步触发 `runReview`)与 `<前缀>/api/*`(面板 API),其余路径与方法一律 404。
- `panel/` — 管理面板的服务端构件。`auth.ts` 是认证判定(token 比对、session、按 IP 退避锁定),纯逻辑不碰 HTTP,时钟可注入。
- `main.ts` — 进程入口。读配置与环境变量,建出 Forge 与 Reviewer,起 webhook 服务。

## 模块规范

- 只有 `Forge` 与 `Reviewer` 是注入边界。git 与 SQLite 直接使用实现,不加接口。数据库位置经 `ReviewRunDeps.dbPath` 传入。
- SQLite 用 Node 内置的 `node:sqlite`(`DatabaseSync`)。运行时第三方依赖只有 Pi 一个,不为持久化再引入驱动。它会打 `ExperimentalWarning`,这是已知且接受的代价。
- 落库的是每一条来源 Finding 而非去重合并后的那一条:采纳率要按提出它的模型统计。合并关系记在 `finding.group_index` 上。
- Disposition 的权威状态在 Forge 上,`finding.disposition` 只缓存最近一次读回的结果,默认 `unknown`。
- Finding 的行号必须是抄来的,不能是模型数出来的(pr-agent、ai-pr-reviewer、claude-code-action 三家开源实现的共同经验;Pi 内建 `read` 返回裸内容,模型在 55 行的文件上实测数偏 4 行)。两层保障都在 worker 内:`numbered-read.ts` 以同名 customTool 覆盖 Pi 内建 `read`,每行加 `N: ` 前缀让模型抄号;`report_finding` 多一个必填 `snippet` 字段(问题起始行的原文),`anchor.ts` 用它核对行号——对得上放行,对不上但文件里找得到就校正到最近的匹配行,找不到打回让模型重报。打回走正常工具返回而非错误:`rejectedToolCalls` 只留给 Pi 的 schema 校验失败,即契约失配信号。打回本身另记一个 `anchorRejections`,两种成因(文件读不出来、snippet 对不上)合记一个数——它们都是"模型报的位置不可信",分成两个数得不出新的动作。打回后模型不重报那条 Finding 就静默消失,没有这个计数谁都不知道丢过;打回多而 Finding 少即该换模型或改 prompt。判定与措辞在 `anchor.ts` 的 `anchorReport` 里,worker 只在它返回打回时加一。
- 跨轮次匹配的锚点是正文里的 `<!-- multireviewer:<64 位 sha256 指纹> -->`,不是 comment id——`Forge.createReview` 不回传每条评论的 id。行级评论与 review 正文里的 fallback 块都埋它,带锚点的即本工具发的,人写的评论与人写的 review 正文都不参与匹配。正文里的锚点多带一段文件路径(`<!-- multireviewer:<指纹>:<文件> -->`):匹配的键是「文件 + 指纹」,而行级评论的路径由 API 一并读回,正文没有这个来源。路径那一段在解析时可选,issue #11 之前发出去的锚点照常匹配得上。
- 匹配的输入有两处:行级评论,以及本工具历史 review 的正文。diff 外的 Finding 没有行级评论承载,只活在正文里,不读正文这类 Finding 每轮全文重发(PR #3 的 `reset()` 实测每轮都在正文里重复出现)。正文里的锚点没有 resolve 状态可读,匹配上一律按未处置折叠;折叠段不区分来源——读者对两种来源要做的事情相同,分段只多出一个理解不了也用不上的概念。
- 匹配的键是 `文件 + 指纹` 而非单看指纹:不同文件里可能有同样的 7 行代码。指纹在新 head commit 的工作副本下重算,且按行号偏移 ±3 滑动重算(`run.ts` 的 `MATCH_OFFSETS`),任一命中即同一处——模型两轮对同一个缺陷可能选不同的代表行(一轮指缺陷行,一轮指函数头,PR #4 实测差 3 行),精确相等会让同一个问题每轮重发。容差取值与跨模型去重的 `LINE_TOLERANCE` 相同,判据不同:这里的内容判据是指纹本身,偏移只移动指纹窗口;跨模型去重没有这样的锚,另加了一道内容相似度(见下条)。
- 跨模型去重的「同一处」是行距 ≤ `LINE_TOLERANCE` 且(行号相同 或 内容相似度 ≥ `SIMILARITY_THRESHOLD`)。只看行距时相距 3 行的两个不同问题会被合成一条,评论正文与它的来源对不上(PR #3 实测 `new Function` 的 RCE 与 `summary()` 越界被合成一条)。相似度取 token 集合的 Jaccard,token 按「ASCII 连续段整段成词、CJK 逐字成词」切:中英混排上逐字符切会让 `new Function` 与 `summary count` 共享一大把字母,中文短标题上字符 bigram 又常常一个都不共享。比的是 `title`,为空时退回必定非空的 `description`。行号相同时跳过内容判据——行号经 snippet 锚定核对过,是「同一处」的硬证据,拿标题措辞推翻它是用弱信号盖强信号。阈值 0.05 压得很低:合并错了是一条评论盖住两个问题,拆错了是同一个缺陷每轮发两条。分组是「与组内任一条同处即并入」而非只比组内最后一条——一条 Finding 可能与组里靠前的那条讲同一回事、与最后一条无关。这道判据只压得住「毫无交集」那一档,两类样本的取值本身重叠:实测同一缺陷的纯中文同义改写可以落到 0(该合并却拆开),两个不同缺陷共享「时未校验」这类套话可以到 0.29(该拆开却合并)。取舍与限制固定在 `test/similarity.test.ts` 里。要真正收紧只能换更强的信号,不是调这个数。
- 匹配成功的 Finding 一律不发行级评论,折进 review 正文的 `<details>` 段,已 resolve 与未 resolve 分成两段各自标注。折叠段逐条写 `file:line`、等级、标题与描述,误匹配时人展开就能看到完整内容。匹配成功的 diff 外 Finding 只进折叠段,不再进 fallback 段——两处都进就是同一条 Finding 在一条 review 里呈现两遍。
- 评论是给开发者看的最终结果,格式固定为 等级 / 标题 / 问题 / 影响 / 建议 五段,段间空行分隔。模型署名与各家的不同表述一概不进评论:哪个模型说的什么在 `finding` 表里,采纳率统计从那里拿。`title` / `impact` / `suggestion` 为空不算异常,呈现层整段跳过——不为排版丢 Finding。这三个字段不落库,`finding` 表结构不变。
- review 正文首行是本轮概览,形如 `MultiReviewer:5 条 Finding(P0 3 / P2 2)`,开发者扫一眼即知这轮审查的轻重。总数的口径是「本轮结论」而非「本轮新增」:行级评论、diff 外的 fallback 与折叠的三类全算,`runReview` 的分派循环让这三类恰好覆盖去重合并后的每一条,总数即 `findings.length`。为零的等级不列——读者要的是轻重,`P0 0` 只让人多数一个零。零 Finding 时首行退回裸的 `MultiReviewer`:那一档只在有模型缺席或覆盖不全时才发得出 review,写「0 条」会把「没审到」读成「没问题」,缺席由下面那段自己说。
- 分批的规模按 diff 的增删行数衡量,不按文件数:50 个各改 2 行的文件不该被切碎,3 个各改 800 行的文件才该切。阈值经 `ReviewRunDeps.maxChangedLinesPerBatch` 传入,不传取 `DEFAULT_MAX_CHANGED_LINES_PER_BATCH`。
- 分批只切 `ReviewRange.files`,`worktreePath` 每批都是同一份完整的 head commit 工作副本。不为分批动 worktree——Reviewer 读不到其他批次改动后的代码就会报出"这个新函数没有调用者"这类误报。
- 同一文件的改动绝不跨批,跨批因此不会出现指向同一处的 Finding。单个文件本身就超阈值时它自成一批,不拒审也不截断:不设批数或预算上限。
- 批次串行,批内 Reviewer 并行。并行跑批会同时开「批数 × 模型数」个子进程,对宿主机不友好。
- 一个模型的多批结果合并成一个 `ReviewerOutcome`,`rejectedToolCalls`、`anchorRejections`、`anomalies`、`usage` 与耗时按批次累加。计数类字段新增时必须跟着加进这里,漏一个就是分批时数字丢一半。全部批次都失败才算缺席(记 `failure`,findings 丢弃);部分批次失败时保留成功批次的 Finding 并照常发布,记 `incompleteCoverage`,在 review 正文里与缺席分成两段呈现。
- 汇总去重在全部批次跑完之后做一次,一次 Review Run 只发一次 review。
- 审查不设置任何阻断合并的状态。本工具从不调用 status / check API,`Forge` 接口里也没有这类方法,`createReview` 一律用不阻断的 COMMENT 事件。这是有意的:审查是建议,人保留最终判断权。
- Webhook 单一端点接两个平台,靠请求头区分来源。必须先认 `X-Gitea-Event`——Gitea 为兼容 GitHub 的接收端把 `X-GitHub-Event` 一起发了,先认 GitHub 会把 Gitea 的投递按 GitHub 的 action 拼写解析,结果一条都不触发。
- 签名头两个平台共用 `X-Hub-Signature-256`(`sha256=` 加原始 body 的 HMAC-SHA256 十六进制)。Gitea 另发的 `X-Gitea-Signature` 内容相同、只是没有前缀,不必再认。比对用 `timingSafeEqual`,长度不等时先短路——它在长度不同时抛异常。
- 「PR 新增 commit」的 action 两个平台拼写不同:GitHub 是 `synchronize`,Gitea 是 `synchronized`。规范化后统一为 `new-commit`。凡是照抄 GitHub 拼写的地方都会让 Gitea 收不到事件,依据写在 `webhook/server.ts` 的注释里。
- 拼写之外还有一层:Gitea 的 webhook **订阅**里「同步」是独立事件 `pull_request_sync`,与 `pull_request` 分开(`modules/webhook/type.go`)。只订阅后者时 PR 新增 commit 根本不投递,本服务这边的 action 映射再对也没机会执行。实测确认过——这是部署侧的配置,代码挡不住,只能写进准备步骤。
- 只有 PR 打开与 PR 新增 commit 触发 Review Run。草稿 PR 在触发层用规范化事件里的 `draft` 挡掉,不进 `runReview`。
- 准入先于验签,每仓库一把 Key,没有全局 secret:从 payload 取数值 repo id 查注册表,按 `?k=` 代次选 Key,再验签。id 与代次都来自未认证的请求,只当查询索引,验签仍决定一切(ADR 0007)。「未注册」与「代次不对」是仅有的两类验签前记录,按仓库只记首次——它们是管理员排查「接入了却没反应」的唯一线索;`logOnce` 的去重键因含未认证方可自选的仓库 id 而设上限(`LOGGED_ONCE_MAX`),满了只去重不再记新类。
- Webhook 的状态码语义:解析不出仓库 id(含非法 JSON)、未注册、代次不对、签名不过都是 401(对未认证方不区分原因),事件类型或 action 不关心 200(投递是成功的,只是没有活要干),字段对不上 400(此时已通过验签,平台改字段名时要在投递记录里显形),来源平台还没有 Forge 实现 200(是本服务的配置缺口,不是投递的问题)。
- 路由在一切之前:`POST /webhook` 与 `<前缀>/api/*` 之外的请求一律 404,不重定向(重定向会把扫描器引向真实入口),也不进投递日志。路径匹配不含查询串——hook URL 携带 `?k=<代次>`(ADR 0007)。`<前缀>/*` 回 index.html 与 `/assets/*` 静态产物是后续票,落地前同属 404,前缀猜错与前缀下路径不存在因此不可区分。
- 仓库注册(`POST <前缀>/api/repos`)的顺序有讲究:验 bot 是仓库 admin(不足则 403 并明说缺什么)→ 查重(409)→ 代次取 Gitea 上可见的最大代次 +1(残留旧 hook 不撞 URL,ADR 0007)→ **先落库再建 hook**(hook 一旦在,投递就会来,库里必须已有 Key 能验它;建 hook 失败回滚注册,不留「已注册却无 hook」的哑仓库)。移除(`DELETE <前缀>/api/repos/<id>`)反过来:先按数值 id 解析仓库现名(`GET /repositories/{id}`——注册表里的名字是注册时的,按旧名寻址会把「改名」误判成「已删」而留下孤儿 hook),**再删 hook,删不掉(404 除外)不放行**,删成后摘注册表;评审记录一行不动。
- 轮转(`POST <前缀>/api/repos/<id>/rotate`,ADR 0007)是可重入的单调推进,不落轮转状态,断点从「库里的 key 列表 + Gitea 上的代次」推断。一次请求做完:上一轮未收尾(两把 Key)先收敛到较新代次,再取库与 Gitea 两侧最大代次 +1 开新一轮。收敛的顺序固定:先确保目标 hook 在(建),再删其余全部本服务 hook(含库回滚残留的更高代次——这就是回滚自愈),最后摘旧 Key;途中两把 Key 并存,投递不中断。核对(`GET <前缀>/api/repos/<id>/hooks`)只读:与 `ensureHook` 用同一个 `hookConverged` 判据比对差异,逐条给下一步动作,不自动修。两个端点都先按数值 id 解析仓库现名再寻址 hook。
- 每仓库的模型覆盖存 `repo.reviewers`(ReviewerSpec 的 JSON),语义是全量替换 reviewers 列表;投递时解析,坏配置按「配置错误」记录并回 200,且放在幂等 claim 之前——坏配置不该吃掉幂等键,修好后同一 head commit 要能重新触发。构建经注入的 `buildReviewers`,`main.ts` 接到与全局配置同一套构建逻辑上。
- 面板认证:登录(`POST <前缀>/api/session`)是唯一免认证的端点,验 admin token 换 HttpOnly + Secure + SameSite=Strict、`Path` 限前缀的 session cookie——前缀轮换后旧 cookie 自然失效。其余 API 端点先验 session,未认证一律 401,不区分端点存不存在;认证后的未知端点回 JSON 404,与页面的裸 404 分开——API 的调用方是程序,要能把「端点不存在」从「前缀不对」里区分出来。登录失败按 IP 退避与锁定(头三次免罚,之后指数翻倍封顶 15 分钟),锁定期内对的 token 也不放行;IP 取直连地址、不认 `X-Forwarded-For`——未认证方伪造它就能绕过锁定,反代之后退化为全桶共锁,对单管理员面板锁过头好过锁不住。session 在内存里,重启全体重新登录。
- 幂等键是「仓库 + head commit」,落在 `webhook_delivery` 表的 UNIQUE 约束上,靠插入冲突判重而不是先查后插:并发投递时先查后插会两个请求都查不到、都开跑。`review_run` 上不加同样的约束——人手动重审同一个 head commit 是合法的。
- Webhook handler 立即返回 200,Review Run 在后台跑。后台任务的 rejection 必须接住并记录,否则会变成 unhandledRejection 把这个长跑进程带崩。
- 通过签名校验的投递记一行,写明这次做了什么(开始审查 / 草稿不审 / 已审过跳过 / action 不触发 / 非 pull request 事件)。没有这行时,服务正常工作与完全收不到投递在日志上一模一样,只有启动那一句。记录点在签名校验之后:未认证的请求谁都能发,记它们等于把日志交给外人写。仅有的例外是「未注册」与「代次不对」两类准入拒绝,见上面准入那条:按仓库只记首次、集合设上限、仓库名滤掉控制字符。日志出口是 `onDelivery`,与 `onRunSettled` 一样是可注入的,测试收进数组而不刷屏。
- 前三档是本服务对 pull request 的判定结果,逐条记;后两档与本服务无关,按仓库 + 事件类型 / action 只记首次(`server.ts` 的 `logOnce`)。webhook 订阅通常宽于本服务要的两个 action,PR 下每条评论、每次打标签都投一次,逐条记会把判定结果淹掉。首次仍记而不是完全不记:「投递到底有没有到」只有这行能证明,它同时是测试对「收到了但不处理」的观测点。去重键带 `owner/repo`(`repoTag` 抽,非 PR 事件抽不到时退回全局键):一份实例服务多个仓库,不按仓库分桶时第一个仓库的 push 会把其余仓库的同类投递日志全吞掉,运维看不出后者的 webhook 通没通。去重状态在进程内,重启后每类每仓库再记一次。
- `Forge` 接口只包含 Gitea 与 GitHub 都具备的能力(ADR 0002)。实现 GitHub 适配时不得因其能力更强而扩张接口。hook 管理不进这个接口,它是 `gitea-hooks.ts` 的 Gitea 专属能力。
- hook 管理的契约细节以 `docs/research/gitea-webhook-api.md` 为准:同 URL 的 POST 会堆出重复 hook,幂等靠先列后建、按 `config.url` 匹配;订阅比对只能按集合(回显顺序来自 Go map 迭代);建 hook 用窄订阅哨兵 `pull_request_only` 加 `pull_request_sync`,`active` 必须显式置真;收敛核对看 events 集合、active 与 `config.content_type` 三样;PATCH 的 `events` 是全量覆盖、secret 改不了(换 Key 走删旧建新的轮转,ADR 0007);删 hook 的 404 视为成功;分页以空页收尾(实例会把 limit 钳到 `MAX_RESPONSE_ITEMS`);hook 端点要求仓库 admin 权限,write 不够。
- `listReviewBodies` 读回 PR 上每条 review 的正文,不违反 ADR 0002:两个平台都能列出 PR 的 review 并拿到它的正文(Gitea 是 `GET /pulls/{index}/reviews` 返回的 `PullReview.Body`,GitHub 是同路径的 REST 端点),取的仍是两边能力的交集。GitHub 那侧不复用 `listReviewComments` 的 GraphQL reviewThreads——那里只有行级评论,没有 review 自己的正文。Gitea 那侧不像 `listReviewComments` 那样跟着 `comments_count` 为 0 跳过:Finding 全部落在 diff 之外的那一轮发出的正是「有正文、零行级评论」的 review,要匹配的锚点就在它的正文里。
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

`review/` 依赖 `forge/` 与 `git/` 的类型与函数。`reviewer/` 依赖 `review/` 的领域类型,反向不依赖——`runReview` 只认 `Reviewer` 接口。`forge/` 与 `git/` 互不依赖。`webhook/` 依赖 `review/` 的 `runReview` 与 `store.ts`、`forge/` 的接口类型与 `gitea-hooks.ts`、`panel/` 的认证构件、`config.ts` 的 ReviewerSpec 校验,反向不依赖。`panel/` 不依赖其他目录。`main.ts` 依赖以上全部,只有它读环境变量。

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
- 2026-08-08: 行号锚定改为「抄不数」:`numbered-read.ts` 覆盖 Pi 内建 `read` 给每行加号,`report_finding` 加必填 `snippet`,`anchor.ts` 据此核对与校正行号。跨轮次匹配加 ±3 行滑动指纹(`MATCH_OFFSETS`),锚点格式不变,与既有评论向后兼容。评论格式改为 等级/标题/问题/影响/建议 五段(`report_finding` 扩出 `title` / `impact` / `suggestion`),模型署名退出评论,`finding` 表结构未动。
- 2026-08-08: 落地 issue #14。投递日志分成两类:本服务对 pull request 的判定结果(开始审查 / 草稿不审 / 已审过跳过)逐条记,无关的事件类型与 action 只记首次。PR 下每条评论都投一次 `pull_request_comment`,此前逐条记会把判定结果淹掉。去重的键是「事件类型」或「平台 + action」,状态是 `createWebhookServer` 闭包里的一个 `Set`,重启后每类重记一次。`onDelivery` 的签名与其余日志行为未动。
- 2026-08-08: 落地 issue #15。跨模型去重在行距容差内加一道内容判据,`dedupe.ts` 新增导出的 `contentSimilarity`(token 集合的 Jaccard)与模块常量 `SIMILARITY_THRESHOLD`(0.05)。token 按「ASCII 连续段整段 + CJK 逐字」切——逐字符切在中英混排上失真,字符 bigram 在中文短标题上又几乎全是 0,两者实测都做不了判据。行号相同的两条不过内容判据,`title` 为空时退回 `description`。分组改为「与组内任一条同处即并入」。跨轮次匹配的 `MATCH_OFFSETS` 未动:它的内容判据是指纹本身,与这里分了岔,两处注释都写明了。
- 2026-08-08: 落地 issue #11。diff 外的 Finding 也参与跨轮次匹配:`fallbackBlock` 同样埋锚点,匹配输入扩为「行级评论 + 本工具历史 review 的正文」。`Forge` 扩出 `listReviewBodies`,两个平台都能列出 review 的正文,不违反 ADR 0002;两个实现各自落地,`test/github-forge.test.ts` 是 GitHub 那侧第一个不需要真实仓库的用例。锚点多一段可选的文件路径——正文没有 API 给出的路径,而键是「文件 + 指纹」;旧格式照常解析,已发出去的评论不受影响。`parseFingerprintAnchor` 改为 `parseFingerprintAnchors` 取全部锚点:一条正文里可能有多个 fallback 块。正文里的锚点没有 resolve 状态,匹配上按未处置折叠。
- 2026-08-08: 落地 issue #12。锚定打回有了计数:`ReviewerOutcome` 与 `done` 消息扩出必填的 `anchorRejections`,`batch.ts` 跨批次累加,`reviewer_outcome` 表加 `anchor_rejections` 列。两种打回成因合记一个数——文件读不出来与 snippet 对不上都是"位置不可信",分列得不出新的动作。字段做成必填而非可选:下游每处写 `?? 0` 迟早漏一处,而构造点只有子进程与批次合并两处。`store.ts` 没有迁移框架,`CREATE TABLE IF NOT EXISTS` 对既有表不生效,新增 `ADD_COLUMNS` 逐条跑 `ALTER TABLE ADD COLUMN` 并吞掉"列已存在",升级前建的数据库因此照常可用。打回的判定与措辞从 worker 里提到 `anchor.ts` 的 `anchorReport`,两条打回路径合成一处,计数只加一次。
- 2026-08-08: 落地 issue #13。review 正文首行从裸标题扩为本轮概览,写明 Finding 总数与 P0/P1/P2 分级计数(`run.ts` 的 `overviewLine`,`reviewBody` 为此多收一个 `findings` 参数)。计数口径是「本轮结论总数」:行级评论、diff 外 fallback 与折叠的三类全算,`runReview` 的分派循环让三类恰好覆盖去重后的每一条,不必另算。为零的等级不列,`P0 0` 只让人多数一个零。零 Finding 时首行退回裸的 `MultiReviewer`——那一档只有模型缺席或覆盖不全时才发得出 review,「0 条」会被读成「没问题」。其余呈现未动。
- 2026-08-09: 两轴复核(Standards + Spec)加正确性轴的收口。#14 的「只记首次」去重键补上 `owner/repo`(`repoTag`,非 PR 事件抽不到时退回全局键):此前键是全实例共用,第一个仓库的 push / 忽略动作会把其余仓库的同类投递日志全吞掉。`parseFingerprintAnchors` 加 `typeof body !== "string"` 守卫:`listReviewBodies` 直接喂平台读回的 `review.body`,一条 null 正文不该在 `matchAll` 上把整轮 Run 带崩。#15 的 `SIMILARITY_THRESHOLD` 注释校正成本口径——ticket 把误合并排在漏合并之上,0.05 低阈值是弱信号下的最小伤害而非「拆错比合错轻」,两头的已知代价固定在 `test/similarity.test.ts`;启发式与阈值未动。
- 2026-08-15: 落地 issue #27。服务从零引入路由:`POST /webhook` 照常处理投递,其余任何路径与方法一律 404、不重定向,`GET /webhook` 与 `/` 也是。分发点在 `createWebhookServer` 的 `createServer` 回调里,路径匹配不含查询串,面板与静态资源的分支后续加在这里。投递行为与状态码语义未动。
- 2026-08-15: 落地 issue #28。`store.ts` 新增 `repo` 与 `repo_key` 两张表及 `registerRepo` / `addRepoKey` / `listRepoKeys`;`server.ts` 的准入改为「payload 取 repo id → 查注册表 → 按 `?k=` 代次选 Key → 验签」,`WebhookServerDeps.secret` 删除,`main.ts` 不再读 `MULTIREVIEWER_WEBHOOK_SECRET`。非法 JSON 从 400 挪到 401——解析不出 id 就无从选 Key,400 只剩「验签过了但字段对不上」。`logOnce` 移到验签之前并设 `LOGGED_ONCE_MAX` 上限:未注册 / 代次不对两类拒绝要记首次,而去重键含未认证方可自选的仓库 id。注入边界未增加,测试仍走 HTTP 缝加临时库种数据。
- 2026-08-15: 落地 issue #29。新增 `panel/auth.ts`(token 摘要后 timingSafeEqual、内存 session、按 IP 退避锁定,时钟注入);`server.ts` 路由表挂上 `<前缀>/api` 分支,登录发 `Path` 限前缀的 Secure cookie。`main.ts` 新增三个必需项:`MULTIREVIEWER_ADMIN_TOKEN`(接替原全局 secret 的位置)、`MULTIREVIEWER_PANEL_PREFIX`(校验字符集并拒绝 `webhook` / `assets`)、`MULTIREVIEWER_BASE_URL`(明文 http 且非 localhost 拒绝启动)。测试在 HTTP 缝上新开 `test/panel-auth.test.ts`,退避窗口用注入时钟驱动,不等真实时间。
- 2026-08-15: 落地 issue #30。新增 `forge/gitea-hooks.ts`:列 / 建 / 删仓库 hook 与 bot 权限查询,`Forge` 接口未动。`gitea.ts` 的 `request` / `requestJson` 导出供它复用,`request` 加了可放行状态码参数——「404 算成功」这类语义在调用点决定。测试打在 fetch 桩上(`test/gitea-hooks.test.ts`),打桩器从 `gitea-forge.test.ts` 提到 `test/support/stub-fetch.ts` 共用。
- 2026-08-15: 落地 issue #31。面板 API 扩出仓库端点:`GET /repos`(按最近活动排序,带累计 Review Run 与来源 Finding 数)、`POST /repos`(注册:验 admin → 查重 → 代次取 Gitea 侧最大 +1 → 先落库再建 hook,失败回滚)、`DELETE /repos/<id>`(先删 hook、删不掉不放行,评审记录保留)。`store.ts` 的 `registerRepo` 改为「注册表行 + 第一把 Key」同事务落库并支持 `reviewersJson`;新增 `getRepo` / `removeRepo` / `listRepos`,repo 表加 `reviewers` 列。投递链在 claim 之前解析模型覆盖,经注入的 `buildReviewers` 构建;`checkAdmin` 一并带回数值 repo id,`listHooks` 对整仓 404 回空(仓库在 Forge 侧已删除时移除流程要能走通)。测试新开 `test/panel-repos.test.ts`,hook 操作打在 `test/support/fake-gitea.ts` 的真实 HTTP 假实例上,投递用「从假 Gitea 读回的 hook secret 与 ?k=」来签——面板写的 Key 与准入认的 Key 必须是同一把。评审复核补三处:移除前先按 id 解析仓库现名(改名后按旧名寻址会把「改名」误判成「已删」,留下孤儿 hook,破坏 ADR 0007 的不变量);`buildReviewers` 从可选改必填,消掉生产不可达的分支;注册时对模型覆盖试构建一次,坏凭据引用在注册响应里显形而不是等投递。
- 2026-08-15: 落地 issue #32。轮转与核对两个端点,`store.ts` 补 `removeRepoKey`,`gitea-hooks.ts` 导出 `hookConverged`(ensure 与核对共用判据)。轮转的收敛函数 `convergeToGeneration` 把「收上一轮」与「完成新一轮」统一成同一个动作:确保目标 hook → 删其余本服务 hook → 摘其余 Key,重入天然成立;假 Gitea 补了哨兵事件的回显模拟(`pull_request_only` 落回裸 `pull_request`)与 `rename`,panel 测试 harness 提到 `test/support/panel-harness.ts` 共用。三档验收(删旧失败重入收尾、库回滚自愈、核对无副作用)各有测试。评审复核补两处:收敛只清「低于目标代次」的 hook 与 Key——清「不等于」的话,双击轮转的并发交错能把库摘到零 Key,投递全 401 且再点轮转在空列表上炸掉;仓库在 Gitea 已删时轮转直接 409 指向移除,不让「再点一次」变成原地循环。
