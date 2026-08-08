# AGENTS.md

## 项目概述

MultiReviewer:基于真实 Coding Agent 的多模型并行 PR 智能审查工具。审查挂载在 pull request 上,结果以行级 review 评论呈现。目标部署平台是公司内部 self-host 的 Gitea,开发阶段以 GitHub 为测试平台,两者通过 forge adapter 兼容。

领域术语见 `CONTEXT.md`,已定架构决策见 `docs/adr/`。`docs/idea.md` 是初始草案,其中的 GitHub SaaS 定位、交叉验证 P0、自建 Web 界面等设定已被后续 ADR 推翻,仅作历史参考。

## 技术栈

TypeScript / Node 24,源码由 Node 原生运行,无构建步骤。测试用内置的 `node:test`。Reviewer 的 agent harness 采用 Pi(`@earendil-works/pi-coding-agent`,MIT),见 ADR 0004,它是唯一的运行时第三方依赖。持久化用 SQLite。包管理用 pnpm。

## 目录索引

- `CONTEXT.md` — 领域术语表,代码与沟通的统一语言以此为准。
- `src/` — 编排服务源码,结构约定见 `src/AGENTS.md`。进程入口是 `src/main.ts`。
- `multireviewer.config.example.json` — 模型组合配置的样例。实际配置放 `multireviewer.config.json`,不进版本库;凭据只写环境变量名,不写值。
- `test/` — 测试,全部打在 `runReview` 一个入口上。`test/support/` 是内存 Forge、脚本化 Reviewer 与 git fixture。
- `docs/adr/` — 架构决策记录。
- `docs/idea.md` — 初始产品与架构草案,部分设定已被 ADR 推翻。
- `docs/agents/` — Agent skills 的仓库级配置:issue tracker、triage 标签、domain docs 消费规则。

## 常用命令

- `pnpm start` — 起 webhook 服务,环境变量见「部署」
- `pnpm check` — 类型检查加全部测试,提交前跑它
- `pnpm typecheck` — 仅类型检查
- `pnpm test` — 仅测试
- `MULTIREVIEWER_LIVE_PR=owner/repo#123 GITHUB_TOKEN=$(gh auth token) pnpm test` — 追加运行对真实 GitHub pull request 的验证,它会真实发布评论并改动 resolve 状态
- `MULTIREVIEWER_GITEA_URL=https://gitea.example.com MULTIREVIEWER_GITEA_TOKEN=<bot 的 PAT> MULTIREVIEWER_GITEA_LIVE_PR=owner/repo#123 pnpm test` — 追加运行对真实 Gitea pull request 的验证,同样会真实发布评论并改动 resolve 状态。它覆盖本实现用到的全部端点,因此跑通即证明这枚 PAT 的 scope 够用
- `MULTIREVIEWER_SMOKE_PROVIDER=deepseek MULTIREVIEWER_SMOKE_MODEL=deepseek-v4-flash MULTIREVIEWER_SMOKE_ENV=DEEPSEEK_API_KEY pnpm test` — 追加运行 `report_finding` 与真实模型之间的契约验证,它会真实调用模型并产生费用

## 部署

`pnpm start` 起一个 webhook 服务。两个平台的 webhook 都指向同一个端点(路径任意),content type 选 JSON,secret 填 `MULTIREVIEWER_WEBHOOK_SECRET` 的值,事件只需勾 pull request。

必需的环境变量:

- `MULTIREVIEWER_WEBHOOK_SECRET` — 校验投递签名的密钥,两个平台共用一个
- 每个 Reviewer 在配置文件里声明的 `apiKeyEnv`,例如 `DEEPSEEK_API_KEY`
- GitHub 凭据二选一:`MULTIREVIEWER_GITHUB_APP_ID` 加 `MULTIREVIEWER_GITHUB_PRIVATE_KEY_PATH`(生产,ADR 0005),或 `GITHUB_TOKEN`(开发)

可选的环境变量:

- `MULTIREVIEWER_GITEA_URL` — Gitea 实例根地址,例如 `https://gitea.example.com`。设了它才建 Gitea 的 Forge,不设则 Gitea 的投递只被记录、不跑审查
- `MULTIREVIEWER_GITEA_TOKEN` — bot 账号的 PAT。设了 `MULTIREVIEWER_GITEA_URL` 时必需
- `MULTIREVIEWER_PORT` — 监听端口,默认 3000
- `MULTIREVIEWER_CONFIG` — 配置文件路径,默认 `multireviewer.config.json`
- `MULTIREVIEWER_DB` — SQLite 文件位置,默认 `multireviewer.db`
- `MULTIREVIEWER_CACHE_DIR` — 工作副本缓存根目录,默认 `.cache/worktrees`

### Gitea 的准备步骤

**实例版本必须是社区版 1.26.0 / 企业版 26.0.0 以上。**Disposition 建立在 review 评论的 resolve / unresolve 端点上,而这对端点自该版本才提供,更低的版本用不了本工具(ADR 0002)。服务启动时会读 `GET /api/v1/version` 检查一次,不合格就报错退出。

1. 建一个专用 bot 账号,审查评论以它的身份发出。
2. 用该账号签发一枚 PAT,scope **只勾 `write:repository`**,别的一个都不要。这是实测确认的最小集合:对企业版 26.4.4 用一枚只含此 scope 的 PAT 跑通了全链路——读版本、读 PR 元数据与变更文件、clone、创建带行级评论的 review、读回评论、resolve 与 unresolve。本工具用到的端点全部落在 Gitea 的 `repository` 类别下(`routers/api/v1/api.go` 里 `/repos` 组声明的就是它),`write:issue` 不需要。
3. 把 bot 账号以协作者身份加入每一个需要审查的仓库。Gitea 的 PAT scope 不限定到具体仓库,能访问哪些仓库取决于这一步(ADR 0005)。
4. 在仓库或组织上配 webhook,指向本服务,事件勾 pull request,secret 填 `MULTIREVIEWER_WEBHOOK_SECRET` 的值。

> 换实例或升级 Gitea 后想重新确认 scope,跑一次 `MULTIREVIEWER_GITEA_LIVE_PR=...` 的验证即可,它覆盖本实现用到的全部端点。**这个验证要指向一个此前没被本工具评论过的 PR**:同一个 PR 重跑时,上一轮留下的带锚点评论会让本轮 Finding 匹配成功而被折叠,行级评论数因此为零,看起来像失败(跨轮次匹配见 issue #7)。

## 全局规范

- 领域术语以 `CONTEXT.md` 定义为准,代码、注释、沟通全程统一
- commit message 用英文,简洁描述变更意图
- forge adapter 的接口只包含 Gitea 与 GitHub 都具备的能力,以 Gitea 为基准
- Gitea 最低支持社区版 1.26.0 / 企业版 26.0.0(review comment 的 resolve / unresolve 端点自该版本提供)
- 调用 Gitea API 一律携带凭据,目标实例要求登录后才能调用
- 测试只验证外部可观察的行为,全部打在 `runReview` 上,经 `Forge` 与 `Reviewer` 两个注入边界控制输入;git 与 SQLite 用真实实现,落在临时目录
- 需要真实凭据或真实平台的测试默认跳过,由环境变量显式开启

## Agent skills

### Issue tracker

Issue 与 spec 存放于本仓库的 GitHub Issues,通过 `gh` CLI 读写。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个默认角色标签:`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context 布局:根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## 变更日志

- 2026-08-07: 项目初始化。git init,收录初始想法文档 `docs/idea.md`,创建 GitHub public repo。
- 2026-08-07: 配置 Agent skills 仓库级约定。issue tracker 选 GitHub Issues,triage 标签沿用默认,domain docs 采用 single-context 布局,配置文件写入 `docs/agents/`。
- 2026-08-07: 完成首轮 grilling。建立 `CONTEXT.md` 术语表,写入 ADR 0001(审查挂 pull request)、0002(adapter 按 Gitea 能力定义)、0003(Reviewer 读服务端 clone)。期间探索过手动触发加自建 Web 界面的方案并已放弃。
- 2026-08-07: 选定 Reviewer harness 为 Pi,技术栈随之定为 TypeScript / Node,见 ADR 0004。
- 2026-08-07: 跑通 `report_finding` 机制的 prototype,四家厂商模型验证通过,结论折入 ADR 0004。原型保存在 `prototype/report-finding` 分支,不进主干。
- 2026-08-08: 证实目标实例为 Gitea 企业版 26.4.4(对应社区版 1.26.4),最低版本要求写入 ADR 0002。凭据选型定为 Gitea 用 bot 账号加 scoped PAT、GitHub 用 App,见 ADR 0005。
- 2026-08-08: 隔离边界从整个服务下移到单个 Reviewer:每个 Reviewer 跑在独立子进程中并只持有自家厂商凭据,见 ADR 0004 的执行环境一节。评估并否决了以 agentOS 作为沙箱层。
- 2026-08-08: 落地 issue #2。建立 `Forge` 接口与 GitHub 实现、工作副本的准备与缓存、`runReview` 骨架与位置校验。工具链定为 Node 24 原生运行 TypeScript 加 `node:test`。
- 2026-08-08: 落地 issue #4。真实 Reviewer 基于 Pi SDK 实现,跑在独立子进程中。发现 Pi 默认从 `~/.pi/agent/auth.json` 读凭据,仅剥离环境变量不足以隔离,`authPath` 与 `modelsPath` 因此一并指向子进程私有的临时目录。
- 2026-08-08: 落地 issue #5。跨模型去重按同文件加行号阈值合并,合并保留全部来源模型与各自表述。模型组合移入全局配置文件。缺席模型列进 review 正文,全部 Reviewer 失败时不发布空 review。
- 2026-08-08: 落地 issue #6。Review Run、Reviewer 执行结果与每条来源 Finding 落 SQLite,驱动选 Node 内置的 `node:sqlite`,不引入第三方驱动。用量与成本取自 Pi 的 `session.getSessionStats()`,实测 deepseek-v4-flash 一次审查得到非零成本,定价表内置在 Pi 包里,不受空的 `modelsPath` 影响。Finding 的内容指纹取指向行前后各 3 行、归一化空白后的 sha256。
- 2026-08-08: 落地 issue #7。跨轮次匹配的锚点是评论正文里的 HTML 注释 `<!-- multireviewer:<指纹> -->`,两个平台的 markdown 渲染都会把它剥掉。带锚点即本工具发的评论,人写的评论不参与匹配。匹配成功的 Finding 不再重发行级评论,折进 review 正文的 `<details>` 段,已 resolve 与未 resolve 分别标注,读回的状态落进 `finding.disposition`。
- 2026-08-08: 落地 issue #8。PR 打开与新增 commit 经 webhook 触发审查,HTTP 层用 Node 内置的 `node:http`,不引入框架。两个平台共用 `X-Hub-Signature-256` 校验签名;来源靠 `X-Gitea-Event` 优先识别——Gitea 把 `X-GitHub-Event` 一起发了。「PR 新增 commit」的 action 两个平台拼写不同(GitHub `synchronize`、Gitea `synchronized`),依据取自 go-gitea/gitea `release/v1.26` 源码。幂等键是「仓库 + head commit」,靠 `webhook_delivery` 表的 UNIQUE 插入冲突判重。审查不设置任何阻断合并的状态。
- 2026-08-08: 落地 issue #9。超大 Review Range 按文件分批,规模按 diff 的增删行数衡量,阈值配置项为 `maxChangedLinesPerBatch`,默认 2000。批次串行、批内 Reviewer 并行,工作副本每批都是完整的 head commit。部分批次失败的模型保留成功批次的 Finding 并在正文标注覆盖不全,与缺席分开呈现。
- 2026-08-08: 落地 issue #3。Gitea 的 Forge 实现落地,`Forge` 接口未调整,GitHub 实现未动。端点与字段名逐处标注 go-gitea/gitea `release/v1.26` 的源码依据。三处与 GitHub 拼写不同:变更文件的状态是 `changed` / `deleted` 而非 `modified` / `removed`;没有「一次列出 PR 全部 review comment」的端点,只能先列 review 再逐个取;resolve / unresolve 作用于评论 id 而非会话。行级评论的 `new_position` 是文件行号,与接口语义一致。版本检查在 `main.ts` 启动时做一次;企业版从 `/api/v1/version` 返回哪套版本号查不到公开依据,读不出版本号时放行。
- 2026-08-08: issue #3 的 Gitea 实测完成。对企业版 26.4.4 确认:`/api/v1/version` 返回的是企业版自家版本号(`26.4.4`,不是社区版 `1.26.4`);匿名调用该端点得 403,读取类调用同样要带凭据;PAT 的确切最小 scope 是 `write:repository` 一项,`write:issue` 不需要;clone 的 basic auth 用 bot 的 PAT 作密码、用户名任意——这一条在干净 HOME、屏蔽全局与系统 git 配置、无 SSH agent 的环境下单独复验过,排除了本机 keychain 与 SSH 私钥的干扰。同一组对照还确认:`http.extraHeader` 里的凭据无效时 git 直接失败,不会静默回落到 credential helper 里的其他凭据,因此宿主机配了 helper 也不会让审查以别人的身份发出。实测另暴露一点:真实实例的验证要指向没被本工具评论过的 PR,否则跨轮次匹配会把本轮 Finding 折叠掉。
