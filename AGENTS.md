# AGENTS.md

## 项目概述

MultiReviewer:基于真实 Coding Agent 的多模型并行 PR 智能审查工具。审查挂载在 pull request 上,结果以行级 review 评论呈现。目标部署平台是公司内部 self-host 的 Gitea;GitHub 实现自 2026-08-25 起封存(ADR 0014),新增 Forge 能力只做 Gitea。

领域术语见 `CONTEXT.md`,已定架构决策见 `docs/adr/`。`docs/idea.md` 是初始草案,其中的 GitHub SaaS 定位、交叉验证 P0、自建 Web 界面等设定已被后续 ADR 推翻,仅作历史参考。

## 技术栈

TypeScript / Node 24,源码由 Node 原生运行,无构建步骤。测试用内置的 `node:test`。Reviewer 的 agent harness 采用 Pi(`@earendil-works/pi-coding-agent`,MIT),见 ADR 0004。取证子代理用 Pi 官方注册表包 `pi-subagents`(MIT,ADR 0021):它以普通运行时依赖的形态 vendor 进镜像(`pnpm install --prod` 那一层就装好了,运行时不联网装包),由 Reviewer 子进程铺进会话的临时 agentDir。运行时第三方依赖只有这两个。持久化用 SQLite。管理面板用 React 19、Radix Themes 与 Tailwind v4 构建。包管理用 pnpm。

## 目录索引

- `CONTEXT.md` — 领域术语表,代码与沟通的统一语言以此为准。
- `src/` — 编排服务源码,结构约定见 `src/AGENTS.md`。进程入口是 `src/main.ts`。
- `web/` — 管理面板前端(Vite + TanStack Router/Query),结构约定见 `web/AGENTS.md`。产物在 Docker 多阶段构建里生成,不进版本库。
- `test/` — 测试,打在三条验收边界上(HTTP 端点 / 假 Gitea / SQLite 临时库)。`test/support/` 是内存 Forge、脚本化 Reviewer、git fixture、假 Gitea 与面板 harness。
- `Dockerfile` / `.dockerignore` — 运行镜像。`node:24-slim` 加 git、ripgrep 与 fd-find,依赖在镜像内重装(宿主机的 `node_modules` 含平台专属产物,不进镜像)。装 ripgrep 与 fd-find 是给 Reviewer 的 `grep` / `find` 工具用:缺二进制时 Pi 会去 GitHub 下载,容器里下不动就各卡满 120 秒超时,一轮 Review Run 白等约 4 分钟。
- `docker-compose.yml` — 服务器上的编排定义。与 `.env` 两个文件即可运行,不需要源码。
- `scripts/build-push.sh` — 在开发机构建镜像并推到 registry,默认目标架构 `linux/amd64`。
- `scripts/setup.sh` — 部署向导。在服务器上执行,逐步问出 Forge 凭据与面板配置、写 `.env`、拉镜像起容器、以「面板能用」为验收自检;新实例从日志抽出一次性 bootstrap 口令交给第一个系统管理员,仓库接入、用户与角色、模型凭据及模型组合在面板上做。
- `docs/adr/` — 架构决策记录。
- `docs/idea.md` — 初始产品与架构草案,部分设定已被 ADR 推翻。
- `docs/agents/` — Agent skills 的仓库级配置:issue tracker、triage 标签、domain docs 消费规则。
- `docs/research/` — 一手来源调研笔记,每条结论标出处。

## 常用命令

- `pnpm start` — 起 webhook 服务,环境变量见「部署」
- `pnpm --filter @multireviewer/web dev` — 面板前端本地联调:与 `pnpm start` 双进程,Vite proxy 把 `/api` 转本机后端(端口读同一份 `.env` 的 `MULTIREVIEWER_PORT`)
- `pnpm --filter @multireviewer/web build` — 前端构建(镜像里自动做,本地跑服务要面板时手动跑一次)
- `pnpm check` — 类型检查加全部测试,提交前跑它(不含前端类型检查,改 `web/` 后另跑 `pnpm --filter @multireviewer/web typecheck`)
- `pnpm typecheck` — 仅类型检查
- `pnpm test` — 仅测试
- `MULTIREVIEWER_LIVE_PR=owner/repo#123 GITHUB_TOKEN=$(gh auth token) pnpm test` — 追加运行对真实 GitHub pull request 的验证,它会真实发布评论并改动 resolve 状态
- `MULTIREVIEWER_GITEA_URL=https://gitea.example.com MULTIREVIEWER_GITEA_TOKEN=<bot 的 PAT> MULTIREVIEWER_GITEA_LIVE_PR=owner/repo#123 pnpm test` — 追加运行对真实 Gitea pull request 的验证,同样会真实发布评论并改动 resolve 状态。它覆盖本实现用到的全部端点,因此跑通即证明这枚 PAT 的 scope 够用
- `MULTIREVIEWER_SMOKE_PROVIDER=deepseek MULTIREVIEWER_SMOKE_MODEL=deepseek-v4-flash MULTIREVIEWER_SMOKE_ENV=DEEPSEEK_API_KEY pnpm test` — 追加运行 `report_finding`、复核工具与真实模型之间的契约验证,它会真实调用模型并产生费用

## 部署

部署形态是 Docker。镜像在开发机构建后推到 registry,服务器只拉镜像。服务器上放三个文件在同一目录即可,不需要源码:`docker-compose.yml`、`setup.sh`、以及向导生成的 `.env`。模型组合与批次上限在库里,由面板管,没有配置文件。

```
# 开发机:构建并推送。开发机 arm64、服务器 amd64 时必须交叉构建,脚本已默认 linux/amd64
scripts/build-push.sh registry.example.com/team/multireviewer:latest

# 服务器:首次部署跑向导,六步问出配置、拉镜像、起容器,自检面板与 SQLite 并交付 bootstrap 口令
bash setup.sh

# 服务器:后续更新
docker compose pull && docker compose up -d
```

向导的边界收在「面板能用」:生成凭据主密钥、问基地址,起服务后打登录页并探测 `GET /api/session`。零用户时该端点回 401 加 `bootstrap: true`,向导再从容器日志抽出一次性 bootstrap 口令;已有账号时 401 不带这一位,正常提示用已有账号登录。bootstrap 只在库里零用户时打印,注册第一个用户成功即失效,服务重启换一枚,不进 `.env` 也不落库;第一个注册的人就是系统管理员,注册入口随后关闭。仓库接入、用户与角色、模型服务、模型组合与覆盖都在面板上做;首次进入业务页会显示「可运行模型服务 → 审查配置就绪 → 注册仓库」检查单,实例启用后隐藏。仓库注册要求审查配置先就绪,未就绪时服务端在访问 Gitea、生成 Key 与写库之前回 409。系统不预置角色,给同事建号时先把仓库分给他:不授角色的账号读得到分到的仓库,要写或做动作时才建角色并勾权限格(ADR 0018)。向导不问模型凭据也不问模型标识,不生成全局 webhook secret,也不指导手工配 hook;检出已废除的变量(`MULTIREVIEWER_ADMIN_TOKEN` / `MULTIREVIEWER_WEBHOOK_SECRET` / `MULTIREVIEWER_PUBLIC_URL` / `MULTIREVIEWER_GITEA_REPO` / `MULTIREVIEWER_PANEL_PREFIX` / `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `MULTIREVIEWER_DEEPSEEK_MODEL` / `MULTIREVIEWER_OPENROUTER_MODEL`)会清掉并说明原因。清理之前先把 `.env` 复制成 `.env.bak-<YYYYMMDD>`,同一天重跑不覆盖已有副本——被清掉的旧值只在这份副本里,模型服务配好后自行删除。

两处容易踩的地方:

- **`MULTIREVIEWER_PORT` 与 `MULTIREVIEWER_HOST_PORT` 是两个东西。**容器内固定监听 3000(`MULTIREVIEWER_PORT` 在镜像里就设死了),对外映射用 `MULTIREVIEWER_HOST_PORT`。把宿主端口写进 `MULTIREVIEWER_PORT` 会让应用改去监听那个号,端口映射当场对不上。
- **容器以宿主机上那个部署用户的身份运行**,由 `.env` 里的 `MULTIREVIEWER_UID` / `MULTIREVIEWER_GID` 指定(向导取 `id -u` / `id -g` 自动写入)。`./data` 因此天然可写,不需要 chown。部署目录放在 home 下时尤其要保持这样:把目录改成别的属主会让本人写不进自己的 home。镜像默认用户是 uid 1000 的 `node`,compose 的 `user:` 覆盖它。

不用容器直接跑时 `pnpm start` 起同一个服务,启动时用 `--env-file-if-exists=.env` 读取同目录的 `.env`。

webhook 指向 `POST /webhook?k=<代次>` 这一个端点(路径固定,其余路径与方法一律 404),content type 选 JSON,secret 填该仓库的 Key。投递凭所属仓库的 Key 准入:仓库要先进注册表,未注册一律 401,没有全局 secret。hook 的建立与 Key 的管理由面板完成:注册(`POST /api/repos`)自动在 Gitea 建 hook 并落 Key,移除自动删 hook。GitHub 仓库没有注册途径。

必需的环境变量:

- `MULTIREVIEWER_BASE_URL` — 服务对外的基地址(实例根,不含路径)。明文 http 且非 localhost 时拒绝启动:Secure cookie 发不出去,面板会打得开却登不进。它取代向导旧变量 `MULTIREVIEWER_PUBLIC_URL`——旧值含 `/webhook` 后缀,同名不同义会静默出错,故换名弃用

Forge 凭据至少要配齐一组,一组都没有时启动失败——服务起得来却一次审查都跑不了比起不来更难发现:

- Gitea:`MULTIREVIEWER_GITEA_URL`(实例根地址,例如 `https://gitea.example.com`)加 `MULTIREVIEWER_GITEA_TOKEN`(bot 账号的 PAT)
- GitHub:`MULTIREVIEWER_GITHUB_APP_ID` 加 `MULTIREVIEWER_GITHUB_PRIVATE_KEY_PATH`(生产,ADR 0005),或 `GITHUB_TOKEN`(开发)

只配其中一组即可。没配那一格的平台投递进来只被记录、不跑审查,响应仍是 200。

可选的环境变量:

- `MULTIREVIEWER_PORT` — 监听端口,默认 3000。镜像里已设为 3000,走容器时不要再改
- `MULTIREVIEWER_PANEL_DIST` — 前端构建产物目录,默认 `web/dist`。镜像里是 `/app/web/dist`。产物不在时面板页面回 503(与 404 分开)
- `MULTIREVIEWER_DB` — SQLite 文件位置,默认 `multireviewer.db`。镜像里是 `/data/multireviewer.db`
- `MULTIREVIEWER_CACHE_DIR` — 工作副本缓存根目录,默认 `.cache/worktrees`;镜像里是 `/data/worktrees`。模型服务显式发现 Pi 内置 provider 时,其下 `pi-models/models-store.json` 只作可丢弃的远程目录输入缓存;数据库里的模型服务版本与目录快照才是面板和 Review Run 的事实。Reviewer 不读取这份缓存,服务也不再生成或读取共享的 `models.json` 当前配置。schema-v0 迁移提交后会先删除旧 `models.json` 与 `models-store.json`,后者只会在之后的显式发现中按新规则重建。填相对路径也能用,不过部署时建议直接写绝对路径,省得跟着工作目录变。**仓库注册成功后服务在后台把它的工作副本 clone 到这里**(issue #184),之后的 Review Run、diff、分支列表与提交列表都在这份副本上只做 fetch;副本不在时仍会按需现 clone,只是那一次慢一些。副本的准备状态在首页左栏的行操作里显示,失败可重试。要读代码的每一次调用(一轮 Review Run、一次基点探索、一次处置反哺)从这份副本另派生一份一次性工作树,放在同一个根下的 `.checkouts/<owner>/<仓库>/` 里,用完即删——同一个仓库上并发的几件事因此各读各的那个 commit(issue #212)。这些目录是可弃的中间物,进程被杀留下的那些由下一次准备清掉;持久卷要保的仍是缓存副本本身。**磁盘代价按并发数算**:同一个仓库上并发的每个参与者各持一份完整工作副本,峰值占用是缓存副本加上并发数乘以一份工作副本,持久卷容量按这个峰值预估。**这个目录被清掉会丢历史轮次的 diff**:每一轮 Review Run 的两端靠本地 clone 里的 `refs/multireviewer/runs/<轮次 id>/base` 与 `/head` 保持可达(issue #161),范围审查完成后容器 PR 的分支已删,远端再没有第二处存着它们。清掉之后新的审查照常跑,打不开的只是已完成阶段那些历史轮次的 diff(面板显示 409 加一句说明),各仓库的工作副本会在下一次用到时重新 clone;要保留就把它放进持久卷,镜像里的 `/data/worktrees` 已经是
- `PI_OFFLINE` — Pi 的离线开关,设成任意值(例如 `1`)即关闭模型服务发现中的外部目录增量。显式预览或刷新 Pi 内置 provider 时仍可读 Pi 随包目录,但不请求 pi.dev 或 OpenRouter;未设置时这两层只作为发现输入,成功结果整份写入当前模型服务版本的数据库快照,Review Run 不在运行途中刷新目录
- `MULTIREVIEWER_CREDENTIAL_MASTER_KEY` — 模型凭据的加密主密钥(ADR 0008),模型服务页用它加解密。**向导会自动生成一枚并写进 `.env`**(已有值时沿用,`FORCE=1` 也不重新生成),手工部署时取一串随机材料即可,例如 `openssl rand -hex 32`。没设时服务照常启动,模型服务页仍可读模型状态,但不能执行凭据动作并会说明差什么——起不来就进不了面板。换掉它等于把已存的凭据作废,模型服务显示未配置,重新粘一次 key 即可

只有 `docker-compose.yml` 读、应用不读的:

- `MULTIREVIEWER_IMAGE` — 镜像引用,必填
- `MULTIREVIEWER_HOST_PORT` — 对外映射的宿主机端口,默认 3000
- `MULTIREVIEWER_UID` / `MULTIREVIEWER_GID` — 容器以哪个 uid/gid 运行,默认 1000

部署目录放哪里都行,向导与 compose 的路径全部相对自身位置解析。`~/share/workspace` 与 `/srv/multireviewer` 一样能用。

向导可以中断后重跑:已经写进 `.env` 的值会被认出来,对应阶段直接跳过,只补没做完的部分。`FORCE=1 bash setup.sh` 强制每个阶段都重做。

### 面板门禁的运维

- **怀疑某个人的会话 cookie 泄露时,由系统管理员在访问控制页重置那个人的密码。**重置会只作废该用户的全部会话,并要求他用临时密码登录后立即改密,不牵连其他人。会话已经落 SQLite,所以**重启容器不再清空会话**;登出只作废当前会话,用户自己改密码会保留当前会话并踢掉其余会话。
- **HTTPS 是门禁的前提,不是可选项。**会话 cookie 带 `Secure`,明文 HTTP 下浏览器根本不发它;`MULTIREVIEWER_BASE_URL` 是明文 http 且非 localhost 时服务直接拒绝启动(localhost 放行,浏览器把它当安全上下文)。本服务自己不终止 TLS,证书与 https 由外部反代负责,归部署方。
- **面板挂在基地址的根路径上,没有隐匿层。**未认证的 API 请求一律 401,端点存在与否都一样;门禁是用户账号与会话 cookie。随机面板前缀在 2026-08-31 移除:它只挡扫描器枚举,内部部署下的运维摩擦大于收益。

账号是本服务自己管理的本地账号,不复用 Gitea、GitHub 或其他身份源。系统管理员在访问控制页建用户、重置密码、删用户,并创建自定义角色;每个普通用户挂一个角色,角色由 11 个权限格组成(`repo:write` / `review:rerun` / `review:create` / `review:complete` / `review:advance` / `finding:dispose` / `knowledge:write` / `model:read` / `model:write` / `credential:read` / `credential:write`)。读评审记录、仓库与处置率不由权限格决定:登录即可读,读得到哪些由仓库分配决定(ADR 0018),没有角色的账号照样看得见分给它的仓库。`model:write` 与 `credential:write` 各自包含同资源的读权限,隐含关系只剩这两对;新增权限格不会自动落到已有角色上,升级不扩权;角色矩阵会把被包含的读权限显示为随写生效。系统管理员不是角色且始终全权限。口令强度在注册、自改密码与管理员重置三条路径上都**不设下限**;服务唯一兜底是失败后的登录闸门最多退避 30 秒,并在撞上闸门时留一行含账号、源 IP 与失败次数的日志。部署方若有强度要求,必须在组织流程或外围身份治理中另行约束;服务不会替部署方判定弱口令。

### Gitea 的准备步骤

**实例版本必须是社区版 1.26.0 / 企业版 26.0.0 以上。**Disposition 建立在 review 评论的 resolve / unresolve 端点上,而这对端点自该版本才提供,更低的版本用不了本工具(ADR 0002)。服务启动时会读 `GET /api/v1/version` 检查一次,不合格就报错退出。

1. 建一个专用 bot 账号,审查评论以它的身份发出。
2. 用该账号签发一枚 PAT,scope 勾 **`write:repository` 与 `write:issue`** 两项,别的一个都不要。这是实测确认的最小集合:
   - `write:repository` 覆盖审查主链路——读版本、读 PR 元数据与变更文件、clone、创建带行级评论的 review、读回评论、resolve 与 unresolve。这些端点全部落在 Gitea 的 `repository` 类别下(`routers/api/v1/api.go` 里 `/repos` 组声明的就是它)。
   - `write:issue` 只为 PR 上的进度 reaction(👀 / 👍)。reaction 端点挂在 `/issues/{index}` 下,只有 `write:repository` 时返回 403 并明说 `required=[write:issue]`。

   少了 `write:issue` 服务照常审查,只是 PR 上不再有进度标记,日志会记一行 `reaction 更新失败,审查照常`。
3. 把 bot 账号以协作者身份加入每一个需要审查的仓库。Gitea 的 PAT scope 不限定到具体仓库,能访问哪些仓库取决于这一步(ADR 0005)。
4. 本服务的地址在私有网段时(自托管几乎总是如此),放开 Gitea 的 webhook 目标白名单。`app.ini` 的 `[webhook]` 段 `ALLOWED_HOST_LIST` 默认是 `external`,只放行公网单播地址,发往 RFC 1918 地址的投递会被 Gitea 自己拒掉,投递记录里写作 `webhook can only call allowed HTTP servers`。追加本服务的地址即可,官方镜像也可用 `GITEA__webhook__ALLOWED_HOST_LIST` 这个环境变量:

   ```ini
   [webhook]
   ALLOWED_HOST_LIST = external, 172.17.0.1
   ```

   保留 `external` 使已有的其他 webhook 不受影响。**不要图省事写 `private`**——那会放开整个 RFC 1918,任何有仓库管理权的人都能把 webhook 指向内网任意服务。逐个列出目标地址。改完重启 Gitea。
5. webhook 不手工配:面板注册仓库时自动创建,事件订阅、secret、`?k=` 代次都由服务写好(组织级 webhook 与每仓库一把 Key 互斥,不适用)。背景知识留一条:Gitea 把「同步」拆成独立事件 `pull_request_sync`(`modules/webhook/type.go`),服务订阅时两个都带上了;在 Gitea 界面上手改 hook 的事件勾选会破坏这一点,面板的核对功能会把这类漂移列出来,点「轮转推平」恢复。

> 换实例或升级 Gitea 后想重新确认 scope,跑一次 `MULTIREVIEWER_GITEA_LIVE_PR=...` 的验证即可,它覆盖本实现用到的全部端点。**这个验证要指向一个此前没被本工具评论过的 PR**:同一个 PR 重跑时,上一轮留下的带锚点评论会让本轮 Finding 匹配成功而被折叠,行级评论数因此为零,看起来像失败(跨轮次匹配见 issue #7)。

## 全局规范

- 领域术语以 `CONTEXT.md` 定义为准,代码、注释、沟通全程统一
- commit message 用英文,简洁描述变更意图
- forge adapter 的接口以 Gitea 能力为基准;GitHub 实现已封存,新增方法不补 GitHub 侧(ADR 0014)
- Gitea 最低支持社区版 1.26.0 / 企业版 26.0.0(review comment 的 resolve / unresolve 端点自该版本提供)
- 调用 Gitea API 一律携带凭据,目标实例要求登录后才能调用
- 测试只验证外部可观察的行为,打在三条验收边界上(issue #26 的测试决策):HTTP 端点(起真服务打 HTTP,注入假 Forge、临时库路径与时钟)、`runReview` 入口(经 `Forge`、`Reviewer` 与 `MergeAgent` 三个注入边界)、SQLite 临时库;git 与 SQLite 用真实实现,落在临时目录
- 需要真实凭据或真实平台的测试默认跳过,由环境变量显式开启
- **交付前的验证一律在部署实例上做,不在开发机起服务。**自动化测试照旧在本机跑(那是验收边界上的断言,与实例无关),但「改完之后人去确认它真的能用」这一步走部署实例:面板操作、webhook 投递、真实 Review Run 都在那里验。本机 dev 双进程验不出这类东西——它没有真 Gitea、没有已注册的仓库、没有模型凭据,补齐这些的成本比推一次镜像高,而验完的结论还不能代表实例。开发机因此不常驻 `.env` 里的面板变量(基地址 / 凭据主密钥);要在本机起面板时临时补,验完删掉

## Agent skills

### Issue tracker

Issue 与 spec 存放于本仓库的 GitHub Issues,通过 `gh` CLI 读写。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个默认角色标签:`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context 布局:根目录 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。

## 变更日志

- 2026-09-04: 落地 issue #242。**一轮 Review Run 多一个「只复核」模式**:只复核那一轮只对有未处置历史的文件分批,Reviewer 不注册报出工具、只能给复核结论,延续与自动处置照常,零新报时不发 review。没有未处置历史时这一轮不开跑。默认仍是完整审查,行为与这一票之前逐字一致。详见 `src/AGENTS.md`。

- 2026-09-04: 落地 issue #236。**阶段详情页的正文拆成「Finding」与「时间线」两个 tab**:三个进度计数与页头动作留在 tab 之外两页都看得见,四个筛选只属于 Finding 页;当前 tab 记在地址的 `?tab=` 上(缺省 `findings`,缺省不写进地址,切换走 `replace`),`?trace=` 的深链接落在时间线页、`?finding=` 落在 Finding 页。一个阶段几百条待处置时不用滚到底才看得到轮次。服务端与 API 契约无改动。细节见 `web/AGENTS.md`。

- 2026-09-03: 落地 issue #234。**增量评审的选择器按上次的来源打开,默认只列当前比较项之后的提交**:范围审查记下选比较项时用的分支或 Tag(`range_review` 两列),弹窗据它停在同一条分支或 Tag 模式上;默认列表按 `after=<当前比较项>` 收窄,当前那一行标「当前」且不可选,服务端同时拒掉「新比较项就是当前比较项」。发起弹窗行为不变。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-09-03: 落地 issue #233。**Finding 侧滑的代码差异恢复整文件全量渲染**:去掉当天早些时候加的按 hunk 裁剪与「展开完整差异」按钮,大文件的渲染成本改由每个 hunk 一张表加 `content-visibility: auto` 让浏览器跳过屏幕外的布局与绘制来压,当条 Finding 所在行仍居中并高亮。细节见 `web/AGENTS.md`。

- 2026-09-03: 落地 issue #232(父 spec #229)。**一轮 Review Run 里的批次改为受限并行**:同时在跑的批次数不超过「批次并发数」(默认 3,#230 已冻进本轮快照),批内 Reviewer 仍全部并行,闸只管这一轮、跨 Review Run 不设。此前九个批次严格串行,线上一轮 313 文件的范围审查跑了 5 小时 13 分,其中大半是两个模型互相空等。汇总与完成顺序脱钩:结果按批次序号定序,失败记的第几批与复核结论「序号大的批作数」都按序号。单模型耗时从各批相加改成首批开始到末批结束的墙上时间——各批时间区间重叠之后相加会把重叠的那段数两遍。Reviewer 的轨迹事件带上批次序号,面板轨迹页按模型 × 批分组呈现,旧轨迹照常显示。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-09-03: **分批多了一道文件数上限,审查策略页多两项设置**:一批装不下超过 40 个文件(默认值),文件数与改动行数任一超限即另起一批——此前一批可以塞进上百个文件,模型平均每个文件摸不到一次。同时新增「批次并发数」(默认 3),这一票只把它冻进运行计划,批次仍然串行跑,受限并行是下一票。两项与「批次改动行上限」同形:面板可改、区分系统默认与自定义、各自带版本、开跑前冻进本轮快照。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-09-03: 落地 issue #231(父 spec #229,ADR 0021 修订)。**取证不再无限派**:每个 Reviewer 每批最多派 3 次取证,派满即拒。此前设的那道预算限的是一次取证调用内部的扇出,不是一共派几次——会话总量默认不限,线上那一轮里一个模型派了 79 次取证、串行等待 151 分钟,占它总耗时的一半。名额收紧的同时告诉模型名额稀缺:系统提示写明取证留给最高严重度、且不读对方代码就不能成立的主张。ADR 0021 补一段修订,把两道上限的作用域写清楚(会话总量 3、单次调用扇出 8),原文里「总上限 8 × 批次数 × Reviewer 数」那句不成立的陈述在那一段里纠正。细节见 `src/AGENTS.md`。

- 2026-09-03: 落地 ADR 0023。**「审查完成」与「增量评审」从共用权限格拆成独立权限格**:此前分别搭 `finding:dispose`、`review:create` 的便车,两者与借用的权限格语义无关(标记完成是终止审查,推进是换比较项;发起与推进、处置与完成都不是一回事)。权限格新增 `review:complete`(第 10 格)与 `review:advance`(第 11 格),两条路由(`POST /range-reviews/{id}/complete`、`POST /range-reviews/{id}/advance`)各自切到对应新格;`finding:dispose` / `review:create` 别处的用法一字未动,仓库分配判据不变。**新格不隐含于旧格,存量角色升级后不自动获得**:这段时间窗口只有系统管理员能点这两个按钮,直到管理员手动给某个角色授权——刻意让人重新判断谁该有这两个动作,不是缺陷。角色管理界面(`access-control.tsx`)手动维护的 `PERMISSION_INFO` 同步补两行,否则新格不可授予。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-09-03: **术语「推进比较项」改名「增量评审」**:面板按钮与弹窗文案、接口注释、日志与 `CONTEXT.md`「比较项」词条里的定义句一并换成新术语,纯改名,接口路径、权限格、数据库字段与行为一字未动。

- 2026-09-01: **子进程超时改按「多久没动静」计,不再限总时长**:审查跑多久都行,连续 5 分钟没有任何回传才判卡死。大批次不再有被误杀的风险,卡死的收尾环节也不再拖满 20 分钟。细节见 `src/AGENTS.md`。


- 2026-09-01: **合并去重改由合并 agent 判定**(ADR 0022):同一处的两个不同问题不再因为共享几个字被合成一条评论,同一个问题的两种说法也不再因为一个字都不共享被拆成两条。判断由一个 agent 读内容(必要时翻代码)给出,编排层代码验三条硬性质——一条不丢、一条不重、组内行距不越界,验不过或 agent 失败即整轮退回原来的算法合并,最坏情况与之前一致。面板轨迹里的合并理由从「相距 1 行 · 相似度 16%」变成一句人话,回退与合并 agent 的过程都看得见。它复用本轮第一个 Reviewer 的模型与凭据,不新增配置;token 用量计入本轮总量。细节见 `src/AGENTS.md`。

- 2026-08-31: **`read` 工具与锚定校验不再跟随符号链接出圈**:被审仓库提交指向 worktree 外的符号链接时,读取被拒(返回「读不出来」),圈内互指的合法链接不受影响。判定按 realpath 后的真实位置做,补上了词法检查挡不住的最后一条任意文件读路径。细节见 `src/AGENTS.md`。

- 2026-08-31: **取证链路收口**:取证子代理默认前台执行(不再出现「异步派单拿不到结果再同步重跑一遍」的双倍花销),子会话的 token 用量并进该模型本轮的用量统计(面板不再少报),同一模型多段归属在面板上只显示一枚模型徽章。细节见 `src/AGENTS.md`。

- 2026-08-31: **合并组里模型报出的内容一条不丢**(修订 ADR 0015):同一个模型在一个合并组里的多条归属全部保留、评论里各自成段,只有逐字相同的真重复报才折叠。此前「一个模型只留严重度最高一条」在生产中吞掉过 P1/P2。数据库随之撤掉归属表的模型唯一约束,存量库开库自动重建。细节见 `src/AGENTS.md`。

- 2026-08-31: **同一个模型分开报的相邻问题不再被合并吞掉**:跨模型去重的距离档只对不同模型生效,同模型只认同一行的硬证据。生产实测中一条独立的 P1(类型校验删除)曾被并进隔壁 P0 组后从评论里彻底消失,检出率受损;修后它会独立成条。跨模型合并的判据与阈值一律未动,准确性不变。顺带修正 Reviewer 系统提示里取证 agent 名的措辞,消除模型每轮首次派取证猜错名字的固定摩擦。细节见 `src/AGENTS.md`。

- 2026-08-31: **Reviewer 能直接看变更内容了**:会话新增受控只读 git 工具(diff / show / log / blame),被删的行与被删的文件自此可见——此前 Reviewer 只读 head 状态,删掉的判空、锁、校验只能靠现状间接推断。安全边界不变:子命令与 flag 白名单、路径圈内校验、子进程环境不含模型凭据,bash 仍然不开。细节见 `src/AGENTS.md`。

- 2026-08-31: 落地 issue #225 的第四个入口。**发起范围审查时也能写一句本轮指令**:发起表单在选提交的下面多一格「本轮指令(选填)」,填了就只作用于随发起跑起来的那一轮,同一阶段的下一轮不带;要长期生效的要求仍然录进知识集。至此四个发起入口(PR 重跑、范围审查重跑、增量评审、发起范围审查)措辞与行为一致。不新增权限格,它随 `review:create` 走;超过 500 字或类型不对当场 400,一条分支都不建。

- 2026-08-31: **随机面板前缀移除,面板改挂根路径。**面板页面在 `/`、面板 API 在 `/api`,`/webhook` 与 `/assets` 不变;非 API / webhook / assets 的 GET 一律回 index.html,由客户端路由接管。`MULTIREVIEWER_PANEL_PREFIX` 彻底废除:`main.ts` 不再读它、`server.ts` 的 `panelPrefix` 依赖项删掉、会话 cookie 的 `Path` 改成 `/`、前端不再有注入的前缀全局变量(`web/src/injected.ts` 删除,Router 不设 `basepath`,`api.ts` 直接打 `/api`),Vite 的注入插件也随之删掉、dev proxy 改成 `/api`。向导不再生成前缀,并把它加进「已废除变量」的清理清单(照旧先备份 `.env`),自检探测改打根路径的 `GET /api/session`。**不做兼容期、不做旧前缀重定向**:随机前缀只防扫描器枚举,真正的门禁是账号与会话;内部部署下这层隐匿带来的运维摩擦(书签、反代规则、排障时多一层「路径对不对」)大于收益。升级后旧的 `/<前缀>/...` 书签一律 404,改用基地址本身。
- 2026-08-31: 落地 issue #220(父 issue #219,ADR 0020)。**权限格 `rule:write` 改名 `knowledge:write`,面板与代码内术语换成知识集词表**。纯机械改名,零新行为:同一格管的还是那几个写侧端点,存量角色在开库时一次性改写字面量,能力无增减。面板上的「规则集」「规则集版本 N」「规则集未确认」「空规则集」按 CONTEXT.md 换成知识集那一组,访问控制页的角色矩阵那一行从「评审 · 规则治理」变成「评审 · 知识治理」。端点路径、表名、类型名与变量名一律不动,那是后续票的施工面。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-29: 落地 issue #217。**删掉六处已经完成使命的一次性迁移**:schema-v0 的模型服务迁移器整个文件、以及开库时跑的五个升级块(旧 Finding 按新身份折叠、删费用列、清退役读权限格、修复关闭 PR 的空状态、存量仓库补「已确认空规则集」)。删除依据是所有部署实例都已在当前版本上启动过至少一次(现役实例只有 00-test),这些代码路径再也不会命中。**schema-v0 数据库拒绝启动的报错保留**:库里已有表却仍是版本 0 时开库直接抛错,升级路径由更早的版本负责。面板、接口、schema 与运行行为一格未变。细节见 `src/AGENTS.md`。
- 2026-08-29: **自定义 provider 新增 `anthropic-messages` 接口协议**。ANTHROPIC_BASE_URL 式网关(Claude Code 中转一类)可作为模型服务接入:模型发现按协议分派鉴权头,运行时注册剥掉 baseUrl 尾部 /v1(@anthropic-ai/sdk 自拼 /v1/messages),推理验证与 Review Run 复用 Pi 原生协议支持、零适配。候选 kind 字面量 `openai-compatible` 更名 `custom`,`CONTEXT.md` 的「自定义 provider」词条不再限定 OpenAI-compatible。live 验证另暴露 adaptive thinking 模型拒收 `thinking.type: disabled` 与显式 temperature:思考元数据(`thinkingLevelMap` / `compat`)现随运行模型全链路携带并落库两列。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-29: 落地 issue #212。**同一个仓库上并发的几件事不再互相换掉对方正在读的代码**:以前每个仓库只有一份缓存工作副本,两条并发的 Review Run、一次基点重探索与一次处置反哺都往它上面 checkout,后到的那一次会把前一次正在读的文件换成另一个 commit 的内容,Finding 的行号与代码片段因此锚到错的地方。现在缓存副本只负责 clone 与 fetch,每一次要读代码的调用从它派生一份一次性工作树、用完即删。对操作员可见的变化只有缓存根下多一段 `.checkouts/`(可弃的中间物,见部署那节的 `MULTIREVIEWER_CACHE_DIR`)。细节见 `src/AGENTS.md`。
- 2026-08-28: 落地 issue #202(父 issue #200,ADR 0019)。**每个仓库有了自己的规则集,升级后存量仓库自动视同已确认空规则集**。评审规则与规则集版本两张表落 SQLite:规则由作用范围(glob,空值即全仓库)、一句规范陈述、层标签、两态生命周期(生效 / 废止)与出处构成,规则集整组版本化。开库时给每个还没有版本行的已注册仓库补一行版本 1——空规则集是合法状态,评审等价于无规则注入,**行为与升级前一字不差**;新注册的仓库落到同一种状态(**issue #206 已经改掉这一半**,见那一条)。面板多一个按仓库读规则集的端点与首页上选中仓库时的只读弹窗(按层标签分组,空集给空态),读侧沿用「登录 + 仓库分配可读」,不设新权限格,分配外与没注册同形 404。`CONTEXT.md` 补齐九个术语,决策见 `docs/adr/0019`。Review Run、Reviewer 注入与 Finding 形态一行未动:规则怎么来(基点探索)、怎么改(修订提案与裁决)、怎么进 prompt 都是后续票。
- 2026-08-28: 落地 issue #201。**Reviewer 现在看得到这一轮声称要做的事**:Review Run 组装 prompt 时多带一段意图上下文——PR 触发的轮次给 pull request 的标题与正文,范围审查的轮次给发起时人写的标题(容器 PR 的标题与正文由本工具自己拼出,不是意图来源),两档都给本地 clone 上 `merge-base..head` 的 commit message 全文,新的在前。模型据此在正确性之外覆盖规格保真度:声称的行为缺失、未声称的行为混入,都按既有 Finding 形态报出。内容过长按两个阈值截断(正文保头部 4000 字符,commit 列表保最新的 30 条并把砍掉的条数一并告知模型)。纯 prompt 拼装:**schema、Finding 形态、严重度词汇与面板契约一格未动**,意图只从已有的 Forge 元数据与本地 clone 取,没有新增外部调用面。`PullRequest` 多一个可选的 `body`,Gitea 实现读它,GitHub 封存不补(ADR 0014)。细节见 `src/AGENTS.md`。
- 2026-08-28: 落地 issue #199(spec #197)。**升级前跑过的历史 Finding 打开阶段页也看得到行作者**:阶段汇总(`GET <前缀>/api/stage-summary`)返回之前,先把这个阶段里行作者四列仍为 NULL 的 Finding 找出来——升级前落的行,以及当时判定失败留空的那些——在仓库的缓存副本上按各自那一轮的 head 判一次并写回四列;已经写回的下次读取不再重算。同一个 head 上同一个文件的多条合成一次 `git blame`,与评审落库时走的是同一段代码。缓存副本还没备过时整步跳过,head 不可达、文件已删、行号越界都只记一行日志、那几条留 NULL 等下次读取再试。**补录的任何失败都不让阶段页打不开**:响应照常 200,那几条的 `lineAuthor` 为 `null`,面板显示「无法追溯」。接口契约、路由与权限格一格未加,前端一行未动。细节见 `src/AGENTS.md`。
- 2026-08-28: 落地 issue #198(spec #197)。**一条 Finding 现在带着它的行作者**(`CONTEXT.md` 新增该术语):新一轮 Review Run 落库每条 Finding 时,在这一轮的 head commit 上按文件与行号取 git author 的姓名、邮箱、authored 时刻与那次提交 sha,一并写进 `finding` 表新加的四个可空列(走既有的 `ALTER TABLE` 迁移数组,升级只换镜像,不占 `user_version`)。同一个文件的多条 Finding 合成一次 `git blame`;判定失败只记日志、四列留空,这一轮照常完成。延续到新一轮的 Finding 按新的 head 重算,不沿用上一轮——行号漂移之后那一行的作者往往已经换人。阶段汇总响应里每条 Finding 因此多一个 `lineAuthor`(`sha` / `name` / `email` / `authoredAt`)或 `null`,**没有新增路由,也没有新增权限格**;Finding 侧滑的元信息区多一行「作者名 · 短 sha · 日期」,悬停看邮箱,判不出来时写「无法追溯」,短 sha 不做链接。升级前的历史 Finding 这一票仍是空的,读取时补录是 issue #199。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-27: **阶段详情 Finding 侧滑里的长代码会 soft wrap 了**:diff 表格按侧滑可用宽度布局,旧 / 新行号列固定,代码与 hunk 头保留空白并在边界内折行;一个逻辑行折成几段时仍只显示一次行号,新增 / 删除底色与 Finding 锚定结构不变。此前只在 diff 容器内横向滚动的规则由此取消,超长连续字符也不会撑宽侧滑。服务端接口、diff 解析与审查语义均未改变。细节见 `web/AGENTS.md` 与 `web/DESIGN.md`。
- 2026-08-27: **已关闭 pull request 手动重跑后继续显示「已结束」**:`review_run.pr_state` 随新轮次继承同一 PR 审查阶段的关闭状态,Review Run 完成只更新轮次结果,不再把阶段误改回「进行中」;新轮次的 unknown Finding 同样按已关闭阶段进入处置率。启动时会幂等修复旧版已产生的「历史轮次 closed、最新重跑 NULL」数据;PR `reopened` 仍清除该阶段全部轮次的关闭标记。服务端接口与面板契约没有变化。细节见 `src/AGENTS.md`。
- 2026-08-26: 落地 issue #196。**阶段详情侧滑重新对齐 v8 设计系统,全站用户文案完成审计**:Finding 入口改为带可访问名称的 diff 图标,Review Run 入口统一为「审查轨迹」;侧滑在 `md=768px` 起四边留 14px、宽度上限 920px并使用毛玻璃、圆角与浮层阴影,窄屏改为 86dvh 底部抽屉。Primitive Portal 显式挂进 `PanelTheme` 内的 `#panel-portal`,代码差异保持一行代码一行显示,长行只在自身容器内横向滚动;移动端关闭、Forge 外链、处置与 Reviewer 展开动作补足 44px。审查轨迹补全五项 token 用量并提高证据文字对比度。面板 40 处口语指代、术语漂移、内部实现泄露、模糊错误与标点一并收敛;浏览器页签标题补上当前页面。服务端接口、schema、审查与处置语义均未改变。细节见 `web/AGENTS.md` 与 `web/DESIGN.md`。
- 2026-08-26: 落地 issue #195(spec #190),spec #190 的 5 张子票(#191–#195)到此全部落地。**管仓库不再离开评审记录**:仓库页与 `/repos` 路由删掉,原仓库页的五块逻辑整体搬到首页——「注册仓库」在左栏顶部,每行一个「…」菜单装「配置」与「移除」,配置弹窗分模型组合(跟随全局 / 自定义)、准入 Key(代次、Hook 差异与轮转)、工作副本(四档状态与准备动作)三个区块,移除沿用二次确认,移除的正是当前选中的仓库时退回「全部仓库」;这三处按 `repo:write` 出现。右栏头部在选中具体仓库时显示「发起范围审查」(`review:create`)与输 PR 号重跑(`review:rerun`),选「全部仓库」时两个都隐藏——发起表单因此不再有仓库选择,仓库一律由入口预填。窄视口下注册按钮与行操作收在仓库选择器旁边。一个仓库都没分到的账号仍看得见注册按钮:自己注册的仓库自动分配给自己,注册成功后重新探测一次会话,人不会停在那段空态上。导航少一项「仓库」,连带少掉唯一的计数徽章。`web/src/repos.tsx` 改名为 `web/src/repo-actions.tsx`,只留这些动作与仓库契约类型;**服务端一个接口没改**,部署时只换前端产物。细节见 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #194(spec #190)。**面板首页就是评审记录**:总览页与 `/runs` 路由删掉,登录后直接落在 `/` 的两栏——左栏是这个账号可见的仓库(首项「全部仓库」,其余按最近活动倒序,行上是 `owner/repo`、最近活动与工作副本非 ready 的标记),右栏是所选仓库的审查阶段列表,状态与来源筛选、无限滚动与点行进阶段页都是原来那一份。选中的仓库写进地址上现有的一对 `owner` + `repo`,刷新与分享链接都保留,从阶段页返回回到同一片列表。窄视口下左栏折叠成顶部的仓库选择器,写同一份地址参数。一个仓库都没分到的普通用户看到一段让他联系管理员的说明。一级导航第一项因此是评审记录(`/`),移动端底部导航顺序随之更新;站内原先指 `/runs` 的链接全部改指 `/`。**服务端一个接口没改**,部署时只换前端产物。仓库页与 `/repos` 是下一票。术语见 `CONTEXT.md` 的「评审记录」,细节见 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #193(spec #190)。**读评审记录不再需要权限格**:`repo:read` 与 `review:read` 两格删掉,原来声明它们的接口改为登录即可(仓库列表与 hook 核对、评审记录与阶段、阶段汇总、轮次与它的 diff 与轨迹、处置率),读得到哪些仍由 #192 的仓库分配决定,分配外照旧 404。角色写入带这两个字面量按「认不出的权限格」回 400;升级时角色里的这两种行在建 schema 时删掉,其余格不动——库里的 `user_version` 被模型服务迁移器独占,这一步做成幂等删除,不占版本号。`model:read` 与 `credential:read` 一字未动。面板跟着改:总览、评审记录、仓库、处置率四个页面与导航项登录即可见,`homeFor` 简化为登录就落 `/`,零权限说明页删掉(零分配空态由首页那一票承担),访问控制页的角色矩阵少两行。总览页与 `/runs`、`/repos` 两个路由本票不动。决策见 ADR 0018,术语见 `CONTEXT.md` 的「权限格」,细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #192(spec #190)。**普通用户只看得见、只操作得了分给自己的仓库**:面板 API 在鉴权之后统一过一层「账号可见仓库」,仓库列表、审查阶段列表与处置率矩阵按分配收窄;阶段页与它的汇总、Finding、轨迹、diff,以及处置、重跑、发起范围审查、增量评审、审查完成、仓库配置(模型组合、Key 轮转、工作副本)与移除,目标不在分配内一律回 404,措辞与「不存在」那句逐字相同——从响应上分不出是没有还是没分给我。系统管理员跳过整层,看全部、操作全部。非系统管理员注册仓库时,那个仓库在同一个事务里分给他,注册完立刻出现在自己的列表里;管理员注册不写分配行。**webhook 投递与容器 PR 流程完全不受影响**,这一层只在面板 API 的路径上。权限格与角色矩阵一格没动:没有这一格的人仍然先拿 403,分配决定的是有这一格之后能碰哪些仓库。前端这一票没改,零分配空态与两栏首页是后续的票。细节见 `src/AGENTS.md`。
- 2026-08-26: 落地 issue #191(spec #190)。**仓库分配落库了**:新表 `panel_user_repo(username, repo_id)` 记「哪个用户能看见哪个仓库」,组合主键,系统管理员不受限、不在表里留行。系统管理员在访问控制页新建用户时勾选仓库,用户表多一列「已分配仓库」显示数量,点它开弹窗改分配。`POST <前缀>/api/users` 与 `PUT <前缀>/api/users/{name}` 的请求体多一个可选 `repoIds`(缺省或 null 即这次不改,空数组即清空,形状不对回 400),`GET <前缀>/api/users` 每行多一个 `repoIds`,`GET <前缀>/api/session` 多一个 `repoIds`(系统管理员是 null)。删用户与移除仓库都把对应的分配行一并删掉。**这一票不改任何读接口的过滤**:谁看得见哪些评审记录仍由权限格决定,按分配过滤是后续的票。术语见 `CONTEXT.md` 的「仓库分配」,细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #189。**看一个审查阶段从四层收成三层**:评审记录列表 → 阶段页 → 侧滑。评审记录只有一份(`/runs`),仓库是它的一个过滤条件(地址上一对 `owner` + `repo`,服务端早就支持),仓库页不再内嵌第二份列表,只留一个指向带该仓库过滤的评审记录的链接,「发起范围审查」与输 PR 号重跑仍在仓库页。阶段页只有一种视图:上半是这个阶段当前状态下仍存在的 Finding,下半是时间线一轮一行;轮次视图、「本轮 diff / 审查轨迹」分段控件、「回到阶段汇总」按钮、Finding 卡片的「去最新一轮 diff」链接与地址上的 `run` / `file` 两个参数一并删掉,旧的 `?run=` 地址落到阶段页并被忽略。下钻只剩侧滑一种,在同一路由上由查询参数驱动:`finding=` 开那条 Finding 在**最新一轮**里所在文件的 diff(滚到并高亮锚定行,同文件的其它 Finding 挂在各自行下,处置照旧行内做),`trace=` 开那一轮的审查轨迹(结论与耗时之下是失败模型的原因与这一轮的 token 用量);开关都走 replace,Esc、遮罩与关闭按钮三种关法,关闭后焦点回到点开它的那一行。页顶只有一个返回,回到来时那份列表(仓库、状态、来源三个过滤跟着阶段页的地址走),壳里的面包屑与它一致。历史轮次的 diff 浏览没有替代入口。**服务端接口与 schema 一行未动**,部署时只换前端产物。细节见 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #188。**计费下线了**:面板不再显示任何金额、单价与「费用未知 / 费用未记账」,统计页顶上那张卡改成 token 用量作主读数(总 token 走 29px,输入 / 输出 / 缓存读 / 缓存写压在下面一行,右侧是这个时间窗的运行次数),阶段详情里那一轮的「成本」一段删掉、只留 token,模型服务、模型目录与模型选择器不再有单价那一栏。库里跟着删列:`review_run` 与 `reviewer_outcome` 的 `cost_usd` / `known_cost_usd` / `cost_source` / `unknown_cost_reviewer_count`,以及模型行的 `cost_json`,升级时由 `openStore` 一次 `DROP COLUMN` 删掉,**token 五列与它们的历史数字一个不动**。取舍写在票上:那些金额不是供应商账单,只是本地按 Pi 与 OpenRouter 的价目表折算的估算,却带着「可信价格 / 未知费用 / 负价归零」一整套不变量与专测。token 用量与计费无关,它是运行诊断信息,完整留着。
- 2026-08-26: 落地 issue #187(issue #170)。**复核结论带来的新位置锚不上时,人在审查轨迹里看得见了**:原先 `review_prior_finding` 的 `present` 附带的行号核对不过时只把位置丢掉、结论照收,既不计数也不进轨迹,模型一直把新位置抄错的话延续一直触发不了,而线上看起来像模型根本没给过位置。现在它与 `report_finding` 的锚定失败同一口径:计进 Reviewer 收尾事件的「锚定被拒」,并在这个 Reviewer 的轨迹里留一条被拒记录——复核的是哪条历史 Finding、模型给的行号是多少、为什么被拒都在里面,面板按现有的被拒样式显示,面板一行没动。锚定成功与不带位置的结论一切照旧,计数不变,回给模型的重给提示一字未改。细节见 `src/AGENTS.md`。
- 2026-08-26: 落地 issue #186(issue #170)。**本轮的合并组只有一个数组**:合并后的 Finding、它在本轮 head 上的内容指纹与它折叠到的那条历史评论,从三个靠同一个下标对应的平行数组收成 `run.ts` 的 `ReviewGroup` 一项,合并组序号就是它在数组里的下标。延续配对返回的序号、复核结论自带新位置时合成的那条与分派循环因此都只对着这一个数组,合成只在一处追加——三个数组各 push 一次时,任何人在配对与分派之间多插一次数组操作,「延续自」的链接就会挂到另一条评论上,而这种错没有测试压得出来。对外行为一字未变:评论内容、延续链接、落库的指纹与跨轮匹配全部与现状一致,现有用例的断言一条没改。细节见 `src/AGENTS.md`。
- 2026-08-26: 落地 issue #184。**仓库注册后工作副本在后台备好,之后只 fetch**:`POST <前缀>/api/repos` 建完 hook 就返回,不等 clone;clone 在后台跑,结果(就绪 / 失败与原因、时刻)落 `repo` 表的三列,`GET <前缀>/api/repos` 每行多一个 `worktree`。仓库页显示这个状态(准备中 / 就绪 / 失败并附原因),准备中每 5 秒续查;没备好时给出「准备工作副本」入口,打的是新端点 `POST <前缀>/api/repos/{id}/worktree`(权限沿用 `repo:write`,已在准备中回 409)。第一次发起范围审查、第一次收到投递因此不再为一次 clone 等待。副本不在时按需 clone 的兜底原样保留,功能不断。**移除仓库会一并删掉它的工作副本**,后台还在备时先等它跑完再删;评审记录照旧保留,但该仓库历史轮次的 diff 随副本一起没了(它们钉在这份 clone 的 ref 上,issue #161),面板对那些轮次回 409。同一个副本目录上的准备一次只跑一个:注册与紧接着到来的投递此前会各自 clone 进同一个目录,后一个当场失败。进程重启中断的准备在下次启动时改判失败,面板因此给得出重试入口。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-26: 落地 issue #183。**打开评审记录列表与阶段详情不再受库里阶段总数拖累**:两者原先共用同一步「把全库阶段归并、排序出来」,列表在内存里切页、详情在全表里线性找一条。现在归并、筛选、排序与 offset 分页都在一条 SQL 里完成,回到 JS 的只有当前页的那几行,三个计数照旧只为这几行算;详情按阶段标识直查那一个阶段。阶段详情因此与阶段总数无关(三千个阶段的库上快了几十倍),列表一页仍要扫一遍全部阶段找出排序键,只是扫的是 SQL 而不是 JS。响应形状、计数口径、筛选与排序规则一字未改。细节见 `src/AGENTS.md`。
- 2026-08-26: 落地 issue #185。**范围审查的两个只读接口删了**:`GET <前缀>/api/range-reviews` 与 `GET <前缀>/api/range-reviews/{id}` 在范围审查页删掉(issue #180)之后一个调用方都没有,现在请求它们与请求任何未知端点一样——先过认证,再回 JSON 404。范围审查的列表由 `GET <前缀>/api/stages` 给,单条的记录、比较项分组与 Finding 由 `GET <前缀>/api/stages/{stageId}` 与 `GET <前缀>/api/stage-summary` 给。发起、base 预填、增量评审、审查完成与重跑五个接口一字未改。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #180(spec #172),spec #172 的 8 张子票(#173–#180)到此全部落地。**范围审查没有自己的页面了**:`/range-reviews` 路由、主导航里的「范围审查」项与 `web/src/range-reviews.tsx` 一并删掉,旧地址不做跳转——面板在前缀下照常回 index.html,路由认不出来就是常规的未找到。面板从此只有一种看审查的方式:评审记录列表一行一个审查阶段,点开是 `/stages/<阶段标识>`,范围审查的发起在评审记录页头与仓库页的评审记录区块,增量评审、审查完成与重跑都在阶段详情页的页头。发起、推进、审查完成与重跑四个接口一字未改。只为那一页存在的东西跟着删:主从详情面板的外壳 `web/src/components/detail-panel.tsx`(它最后的消费者就是这一页)、查询键 `RANGE_REVIEWS_QUERY_KEY` 与 `["range-review", id]`——两个键在页面删掉之后没有任何读者,只剩几处失效调用空转,一并清掉。容器 pull request 正文里给的面板地址改指阶段详情页(`/stages/range:<id>`),否则从 Forge 点进来落在一个已经不存在的页面上。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #179(spec #172)。**增量评审复用发起时的 commit 选择器,base 锁定**:推进对话框里 base 只以短 sha 显示、改不了,人从分支与提交列表里点选新的比较项,手输框已删。不是 base 后代的提交在列表里置灰不可选,切换分支后规则照旧——每次列提交都带着这个阶段的 base。`GET <前缀>/api/repo-commits` 因此多收一个可选的 `base`,带了就为每条提交回 `descendsFromBase`,不带时字段不出现、响应形状不变;`base` 只收 7 到 40 位的 sha,查不到这个 commit 回 400(分支查不到仍是 404)。后代口径与推进接口的校验一致:base 自己不算后代。推进接口与它的后代校验一字未改,绕过页面直接调接口仍旧被拒。服务端细节见 `src/AGENTS.md`,面板见 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #176(spec #172)。**一个审查阶段的操作都在它的详情页上做**:增量评审、审查完成与重跑三个动作进了 `/stages/<阶段标识>` 的页头。推进与审查完成只对范围审查阶段出现,行为与原范围审查页一致(推进这一票仍是手输 commit sha,issue #179 换成 commit 选择器),实现从范围审查页搬进共用组件,两个页面只有一份。**重跑对两种来源一致**:pull request 阶段在最新 head 上再跑一轮(现状不变),范围审查阶段在当前比较项上再跑一轮——`POST <前缀>/api/rerun` 的 body 因此二选一,给 `rangeReviewId` 即范围审查那一档,新起的 Review Run 归入同一个阶段。**审查完成之后的范围审查是终态**:推进与重跑都回 409,页面上那三个按钮留着但不可点。权限沿用:重跑 `review:rerun`、推进 `review:create`、审查完成 `finding:dispose`,按钮按权限出现。范围审查页还在(issue #180 删),只是不再自己实现推进与审查完成。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #178(spec #172)。**发起范围审查改用 commit 选择器,不再手输 sha**:表单里先选分支(默认选中仓库默认分支),再从这条分支的提交列表里点行分别设 base 与比较项,行上有短 sha、提交信息首行、作者与时间,列表分页加载;两端可以各自来自不同分支。数据来自服务端本地 clone(与 Reviewer 同一份),两个新的只读接口 `GET <前缀>/api/repo-branches` 与 `GET <前缀>/api/repo-commits` 权限格都是 `review:create`,仓库要已注册。**列分支前先 fetch**,刚推上去的 commit 立刻选得到;容器 PR 的机器人分支按 `multireviewer/` 前缀滤掉。发起接口与它的后代校验一字未改,选到非后代仍旧被拒并在表单里提示。`Forge.Repository` 补 `defaultBranch`。增量评审复用同一选择器(base 锁定、非后代置灰)是 issue #179。服务端细节见 `src/AGENTS.md`,面板见 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #177(spec #172)。**范围审查从评审记录页头发起,并且有了自己的标题**:全局评审记录页头的入口先选仓库,仓库页评审记录区块的入口预填仓库,两处与范围审查页用的是同一张表单(`web/src/range-review-launch.tsx`)。表单三个字段——标题、base、比较项;标题必填且发起后不可改,`POST <前缀>/api/range-reviews` 缺标题或只给空白一律 400。`range_review` 补一列 `title`(升级前的旧行是 NULL,评审记录按 `#编号` 显示),`GET <前缀>/api/stages` 的范围审查行从此带着它。表单打开时读新的只读接口 `GET <前缀>/api/range-reviews/prefill?owner=&repo=`(权限格 `review:create`)预填 base:同仓库最近一个审查完成的范围审查的最终比较项,没有已完成的就留空。base 与比较项本票仍是手输 sha,提交列表选择器是 issue #178。「同仓库同 base 已有未完成范围审查时只提醒」一字未改。服务端细节见 `src/AGENTS.md`,面板见 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #175(spec #172)。**一个审查阶段有了自己的详情页**:地址是 `/stages/<阶段标识>`,标识就是评审记录行上的那个(`pr:<owner>/<repo>/<number>` 与 `range:<id>`),可以直接发给同事;pull request 阶段与范围审查阶段共用这一页。打开默认看到阶段汇总——这个阶段此刻还剩什么没处置,顶上三个数与筛选照旧;轮次降为其中的时间线,按一次代码推进分组:pull request 按 head commit,范围审查按比较项。点时间线上的某一轮切到那一轮的完整 diff 与审查轨迹,轮次记在地址上(`?run=`),刷新仍停在那一轮,也能切回阶段汇总;处置仍在 Finding 卡片里行内做。**评审记录列表与仓库页的评审记录区块点开一行改成跳这个地址**,两处原来的详情抽屉与列表页的 `?run=` 一并删掉,不做旧地址跳转。服务端新增 `GET <前缀>/api/stages/{stageId}`(`review:read`):阶段那一行与分组好的时间线一次给全,面板不用自己拼;标识里的斜杠在地址里编码成一段,查不到即 404。范围审查页此票不动,它的推进与审查完成入口仍在自己的详情里,由 issue #176 搬进详情页;重跑同理。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #174(spec #172)。**评审记录的每一行从一轮 Review Run 变成一个审查阶段**:pull request 阶段按仓库与 pull number 归并,范围审查阶段按范围审查自身标识归并;同一 pull request 推多少次、同一范围审查推进多少次,列表里都只有一行。行上是来源标记、名字(pull request 标题,没有的显示 `#编号`)、状态(pull request 关闭即已结束、重开回到进行中并延续同一阶段;范围审查以审查完成为已结束)、最新一轮的时间与阶段汇总三个数(待处置 / 人工已处置 / 已修复,口径与阶段汇总接口同源)。**筛选与分页在服务端**:状态与来源两个维度,默认全部;全局评审记录与仓库页的评审记录读同一个新接口 `GET <前缀>/api/stages`,一个阶段在两处是同一条记录。点开一行仍是现有的详情抽屉,打开的是这个阶段最新一轮(新增 `GET <前缀>/api/runs/{id}`)。按 Review Run 分页的 `GET <前缀>/api/runs` 保留,只剩总览的「今日运行」与「最近运行」在读它——那两处说的是轮次,不是阶段。权限沿用 `review:read`。独立详情页、页头发起范围审查与删除范围审查页面分别是 issue #175 / #177 / #180。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 [issue #173](https://github.com/kassol/MultiReviewer/issues/173)(spec #172 的第一票)。**评审记录里的行终于有名字**:pull request 触发的每一轮 Review Run 在开跑时记下那个 pull request 的标题,列表里那一行显示它;范围审查触发的轮次不记标题(它的名字来自范围审查自身),升级前跑过的轮次也没有,这两类照旧显示 `#编号`。旧库升级只多一列,不回填历史。这是「评审记录以审查阶段为行」的预重构:阶段行需要一个名字,而标题此前不落库。`CONTEXT.md` 的 Review Run 词条补上这一句。服务端细节见 `src/AGENTS.md`,面板见 `web/AGENTS.md`。

- 2026-08-25: 落地 [issue #170](https://github.com/kassol/MultiReviewer/issues/170)。延续(CONTEXT.md 已延续)不再依赖模型在新位置重报:Reviewer 复核判「仍在」时可以在同一次调用里给出该问题此刻所在的行与那一行的原文,平台核对位置后按历史条目在那里合成本轮的一条去承接同一条 Finding Identity。线上两次验证里模型回了「仍在」就不再重报,旧评论一直停在已经不存在的行上,这是那条链路缺的最后一环。模型同时重报同一处时以重报那条为准;代码没改动、或新位置落在本轮 diff 之外的,一律不承接。契约变化记在 ADR 0016,服务端细节见 `src/AGENTS.md`。


- 2026-08-25: 落地 issue #181,修「面板详情页打开时其他请求被拖慢数秒」。定位结论是请求放大而非事件循环被同步操作占住——`webhook/server.ts` 的 diff 端点每个请求各做一遍准备(Forge 上读仓库与 pull request、本地副本上解析两端算 merge-base),而详情页按文件懒加载会一次发几十个请求。本机实测事件循环最大延迟只有 4–12 ms,同一进程里的轻量 JSON 接口却从空闲的 6–7 ms 涨到 40 ms。改法是把这段准备按「库文件 + runId」记 10 秒(只记成功的那次),同一轮的几十个请求共用一次;改后轻量接口回到 19–21 ms,整批 diff 的墙上时间减半。响应结构与错误分档不变。细节见 `src/AGENTS.md`。
- 2026-08-25: 完成审查轨迹的 grilling 并落地。Reviewer 的过程(assistant 文本、工具调用与参数、报出与被拒的 Finding、失败原因)与 Review Run 的编排事件(工作副本就绪、批次起止、每组 Finding 合并及判据、评论已发)以事件行落 `review_trace` 表,随 Review Run 永久保留;面板运行详情页新增「审查轨迹」分段,进行中的轮次经 SSE 实时推送、断线按序号续传,已结束的只读表。`CONTEXT.md` 新增「审查轨迹」词条,决策见 ADR 0017,spec 是 [issue #171](https://github.com/kassol/MultiReviewer/issues/171)。服务端细节见 `src/AGENTS.md`,面板见 `web/AGENTS.md`。

- 2026-08-25: 完成评审记录归并的 grilling。评审记录改以审查阶段为行,pull request 与范围审查同列同形,范围审查不再有自己的页面;详情改为独立地址,默认阶段汇总加轮次时间线;发起与增量评审改用基于服务端本地 clone 的分支加提交列表选择器,发起必填标题,base 预填上一个已完成范围审查的比较项。`CONTEXT.md` 新增「评审记录」词条并修订审查阶段、范围审查、比较项。共识收拢成 spec [评审记录以审查阶段为单位](https://github.com/kassol/MultiReviewer/issues/172)(`ready-for-agent`),拆成 8 张子 issue #173–#180,阻塞关系用 GitHub 原生 issue dependencies 表示;#173 可立即开工。尚未实现。

- 2026-08-25: 线上验证 issue #167 时发现延续从不触发:注入历史的 prompt 要求模型「历史一律不再报出」,而延续要靠模型在改写后的新位置再报一次,两条指令互斥。prompt 改为只对代码未改动的历史条目禁止重报,代码已改写但问题仍在的要回「仍在」并在新位置再报。细节见 `src/AGENTS.md`。

- 2026-08-25: 修「延续」的一处口径(issue #167 的 spec 评审)。**承接的新位置必须落在本轮 diff 之内**:落在 diff 之外的那条只能写进 review 正文、没有可 resolve 的载体,承接它会让旧评论被关掉而新位置接不住,处置率的分母还会凭空少一条;这种情况现在不承接,旧行留在未处置等人。人已经处置过又改回未处置的那些照样参与延续,备注与署名跟着走——延续是位置的交接,不是处置。细节见 `src/AGENTS.md`。

- 2026-08-25: 落地 issue #168(阶段汇总)。**一个审查阶段现在有一张总账**:范围审查详情打开就是这个阶段的当前状态——同一处问题不论在几轮里被报过都只占一条,状态取最新一轮,顶上是待处置 / 人工已处置 / 已修复三个数,点一下就按它筛,也能按文件筛;每条写着它第几轮第一次被报出、最近一次是第几轮,可以外链去 Gitea 上最新那条评论,也可以直接跳到最新一轮的 diff 位置,处置就在这一页做完。已延续的那些不再冒出来占位置:那处代码已经改写、问题交接到了新位置,列表里只留承接它的那一条,首次报出的轮次跟着它走。轮次不再是主视图,降成时间线,每轮只说这一轮做了什么:新报出几条、折叠几条、自动修好几条、交接几条,以及有几条模型压根没复核。PR 触发的那条链路在评审记录页与仓库页的轮次详情里有同一个开关,两条链路看到的是同一张总账。接口是新增的 `GET <前缀>/api/stage-summary`,要「评审 · 读取」。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #169。**处置率回答的是「这个仓库的审查有没有被处理」,不再给模型打分**(ADR 0015):主维度改成仓库 × category × 时间窗,一个范围审查与一个 pull request 各算一个审查阶段,同一仓库上的各个阶段合成一行。分母口径一个字没改(人工 + 已修复 + 未处置 + 已关闭阶段上的 unknown),已延续照旧整条退出;一条被几个模型同时报出的 Finding 在分母里只计一次。模型那一维只剩「参与条数」——该模型报出过的 Finding 条数,几个模型合报时各加一。处置率页因此改成「按仓库统计 + 仓库与分类矩阵 + 模型参与条数」,总览页右栏改列各仓库处置率,评审记录页头部那个总处置率口径随服务端走。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #167(ADR 0016 的延续)。**代码改写了、问题还在的那些,不再每轮各算一条新的**:模型复核说「仍在」、而这处代码在这一轮已经被改写(旧指纹在新代码里算不出来)时,本轮在同一个文件里、讲的是同一回事(判据与「两个模型说的是不是同一处」同一道)、位置最近的那条承接同一条 Finding——它的新评论里写明延续自哪条旧评论并带链接,旧评论 MultiReviewer 自己去 Gitea 上合上,面板上记「已延续」。人在旧位置填的处置备注、署名与处置时刻跟着走到新位置,人撤回过处置的那份免疫也一起过去,自动规则不会因为换了位置就再碰一次。已延续不是处置:处置率的分子分母都没有它,待处置的计数与列表里也没有它,下一轮不会再让模型复核同一个问题两次;回填读回旧评论那个 resolve 也不把它读成处置。本轮没在新位置报出来的、或者报出来的那条讲的是另一回事的,旧那条原样留着等人——把问题挪到一处无关的代码上再把旧评论合上,比不承接更糟。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #166(ADR 0016 取代 0013)。**改好的问题由模型复核认定,平台自己合上**:每一轮把本审查阶段每条未处置的历史 Finding 交给全部模型复核,任一个说「仍在」就仍在,全部说「已修」才算修好——修好的那条 MultiReviewer 自己去 Gitea 上 resolve,面板记「已修复」,处置人留空、只记时刻。代码变没变不再单独说明任何事:在上游加判空这类一个字都没碰到原处的修法照样认得出,而代码改了却仍没修好的不再被当成修好(它的位置交接是下一张票)。人的判断始终压过它:Gitea 上已处置的不碰,人把「已修复」改回未处置之后自动规则不再碰它,回填也不把「已修复」读成人工处置。全部模型都失败的那一轮什么都不做——没有结论就没有证据。PR 触发与范围审查是同一套规则。面板的「已修复」文案与统计列在 #164 已经就位。细节见 `src/AGENTS.md`。

- 2026-08-25: 落地 issue #165(ADR 0016 的注入与复核契约)。**后续轮次的模型不再对已经报过的问题一无所知**:每一轮开跑之前,本审查阶段(一个范围审查从发起到审查完成,或一个 pull request 从打开到关闭)报过的 Finding 全部注入每个模型——未处置的连正文、严重度、分类与人填的处置备注一起给,已处置的只占一行;两档都不带操作人,人名不进模型输入,也不设条数上限。模型对每条未处置的历史逐条回一个复核结论(仍在 / 已修 / 无法判断),同时被要求不把历史再报一遍;结论逐条落库,漏给的按「无法判断」记,时间流每轮带上漏复核的条数,凭它看得出哪个模型没有认真复核。**结论本票只记录、不裁决**:自动处置的判据仍是「代码改了且本轮没再报出」,以复核结论为证据的自动处置、延续与阶段汇总是后续的票。细节见 `src/AGENTS.md`。

- 2026-08-25: 落地 issue #164(ADR 0015 的预重构)。**同一处问题不再按模型各挂一条评论**:一条 Finding 的身份从此是「pull request + 文件 + 内容指纹」,不含模型。同一轮里几个模型报同一处,Gitea 上只有一条评论——严重度取最高、分类取首报、正文每个模型一段并写明是谁说的,人只处置一次;上一轮 A 模型报的、这一轮 B 模型又报,仍折叠回原来那条评论,不再重发。面板的 diff 卡片列出这条 Finding 的全部归属模型,按模型筛选照旧。自动处置那一档从「已改动」改名叫「已修复」(库里 `changed` → `fixed`),**只换名不换义**:判据仍是「代码改了且本轮没再报出」,换成模型的复核结论是后续的票。旧库在启动时一笔事务内升级:同一处的旧行合成一条、模型归属一条不少、处置值跟着改名,中途失败整笔回滚。处置率的口径与分母不变。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #161。**审查完成之后,历史轮次的 diff 仍然打得开**:范围审查完成会删掉容器 PR 的两条分支,推进过的历次比较项从此在 Gitea 上无处可寻,以前只要本地缓存跑过一次 git gc,那些轮次的 diff 就永久 409。现在每一轮开跑时把这一轮的两端钉在本地 clone 上,gc 不再回收。代价写在部署那节的 `MULTIREVIEWER_CACHE_DIR` 上:清掉缓存目录会丢历史轮次的 diff,换机器同理。细节见 `src/AGENTS.md`。

- 2026-08-25: grill 完 issue #162,定下 Finding 跨 Reviewer 合并与以复核结论为证据的自动处置。CONTEXT.md 改写 Finding Identity 与 Disposition,新增审查阶段、复核、已延续三个词条;ADR 0015 取代 0006 的 Identity 键与模型维度,ADR 0016 取代 0013。实现待 spec,当时代码尚未跟进(Identity 与合并、`changed` 改名由 issue #164 落地,复核与自动处置在后续票)。

- 2026-08-25: 修 issue #152 的跨轮处置。**处置备注、署名与「人已经看过」这件事不再活一轮就没**:一条 Finding 被新一轮再次报出、折叠回原来那条评论时,面板上填的备注、处置人与处置时刻跟着留在新的一轮上,不再只停在旧那一轮的记录里。人把「已改动」改回未处置之后,即便这条 Finding 又被报出一轮,后面代码真改了也不会再被自动处置一次——人的判断压过自动规则这条口径(ADR 0013)从此跨轮成立。处置结论本身的口径不变。细节见 `src/AGENTS.md`。

- 2026-08-25: 落地 issue #160。**面板上能看到这一轮到底改了什么**:Review Run 详情不再是一份 Finding 清单,而是这一轮 Review Range 的完整 diff——文件列表加逐文件 diff,每条 Finding 挂在它所指的那一行下面,在那里直接 resolve / unresolve 并填备注,不用先记住行号再去 Gitea 找。diff 由服务端从 Reviewer 用的那份本地 clone 生成、按文件分块给,展开一个文件才取它的内容,几百个文件的改动也打得开。按文件、模型、处置状态筛选。指向的代码不在这次改动里、或者只在 review 正文里的那些单独列出,不藏。head commit 已经不在本地副本里(分支删了、仓库被强推过)时说明原因,不报 500。PR 触发与范围审查两类轮次同一个视图。看 diff 需要 `review:read`,处置仍需要 `finding:dispose`。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #159。**作者改了代码就等于处置**:新一轮 Review Run 发现上一轮某条 Finding 所指的代码已经改动、本轮又没有再报出来时,MultiReviewer 自己去 Forge 上 resolve 那条评论,处置值记「已改动」(CONTEXT.md Disposition,ADR 0013)。代码没改、只是这一轮模型没再提的不动——那是模型的波动。人已经作出的处置一律不覆盖:Forge 上已 resolve 的不碰,人在面板上把「已改动」改回未处置之后,自动规则也不再碰它。回填照常以 Forge 为准,但不把「已改动」读成人工处置。PR 触发与范围审查是同一段代码,两条链路一起生效。处置率因此分人工与自动两列(分母口径不变):处置率页的每个模型多一行「人工 x · 自动 y」,Review Run 详情的进度条拆成两段,Finding 行上的自动处置写「代码已改动 · 自动处置」。

- 2026-08-25: 落地 issue #158。**一个阶段可以收尾了**:范围审查详情里点「审查完成」(二次确认),MultiReviewer 关掉承载 Finding 的容器 pull request、删掉那两条分支,记下完成人与时刻,并按 ADR 0006 做一次全量回填——Gitea 上已 resolve 的同步回面板,其余未处置的从此计入处置率的分母。完成后比较项不再推进,同一个仓库同一个 base 再发起就是一个新的范围审查、不再提醒;已完成阶段的全部 Finding、处置与备注照常可查。Forge 那几步任一失败只记原因,状态留在进行中,改完权限再点一次即可。审查完成需要 `finding:dispose`。「已改动」自动处置与完整 diff 视图分别是 issue #159 / #160。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #157。**作者改完代码不用重开一个阶段了**:范围审查详情里点「增量评审」填新 commit,MultiReviewer 把容器 PR 的 head 分支移过去并按 base..新比较项跑新的一轮,轮次仍归在同一个范围审查下。只要求新比较项是 base 的后代,作者 rebase 之后拉出来的 commit 照样填得进;不是后代当场拒绝,一条分支都不动。推分支失败只记原因,状态留在进行中,改完分支保护再点一次即可。详情页列出历次比较项与各自的轮次。推进需要 `review:create`。审查完成是 issue #158。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #156。**处置不用再跳 Gitea 了**:Review Run 详情面板按模型列出本轮每一条 Finding(正文、严重度、类别、文件与行,加一枚跳到 Forge 看原评论的链接),有新权限格 `finding:dispose` 的人在行内 resolve / unresolve,并可附一条只存面板的处置备注(CONTEXT.md)。服务端先写 Forge 再落库,Forge 上的 resolver 仍是机器人账号,操作人与时刻记在库里;处置成功即让轮次那几份查询失效,列表与处置进度条当场跟着变。落在 review 正文里的 fallback 没有可处置的评论,面板不给动作、API 也拒绝。在 Gitea 上做的 resolve 照旧经回填回到面板,回填不碰面板记的操作人与备注。新权限格不落到已有角色。「已改动」自动处置与完整 diff 视图分别是 issue #159 / #160。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #155。**直推默认分支的代码现在也能审了**:在面板的新页面「范围审查」选一个已注册仓库、填 base commit 与比较项就能发起,不要求仓库里存在 pull request。MultiReviewer 在 Gitea 上自建两条 `multireviewer/` 前缀的分支与一个永不合并的容器 PR 承载 Finding(ADR 0012),随即跑第一轮 Review Run;容器 PR 自己产生的 webhook 投递按分支前缀丢弃,不会多跑一轮。比较项必须是 base 的后代,判定在本地 clone 上做,填错当场拒绝且一条分支都不留;任一 Forge 步骤失败会记下原因并把已建的分支删掉。同一仓库同一 base 已有进行中的只提醒,确认后仍可再开一个。新增权限格 `review:create`,不自动落到已有角色。评审记录里的轮次标出来源(PR / 范围审查)。增量评审、审查完成与面板处置分别是 issue #157 / #156 / #158。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-25: 落地 issue #154。Forge 获得容器 PR 需要的写能力:从 commit sha 建分支、删分支、建 pull request、关闭 pull request,只做 Gitea 实现(ADR 0014);把分支推到指定 commit 走本地 clone 的 `git push --force`。容器 PR 的生命周期本身还没接上,见 issue #155。细节见 `src/AGENTS.md`。

- 2026-08-25: 落地 issue #153。每条以行级评论发布的 Finding 记住它在 Forge 上的评论 id 与页面链接,时间流 API 一并返回;正文 fallback 与升级前的历史行两项为空。这是面板处置与「跳到 Forge 看原版」的共同前提,本次不改面板界面。细节见 `src/AGENTS.md`。

- 2026-08-24: 管理面板整体换到 v8「毛玻璃控制台」视觉方向,并把主线工作流打通。视觉侧:令牌层重写(`--v8-*` 是唯一颜色事实来源)、左侧栏改双层毛玻璃顶栏加 underline 导航、窄屏底部 Tab 栏、新增总览页与全局 ⌘K、主从选中态改蓝 tint 加 3px 左条。工作流侧:`GET <前缀>/api/session` 增加 `giteaUrl` 字段,面板由此能指回 pull request——处置只在 Forge 上发生,此前面板报出的待处置数点不进去;总览指标、评审记录筛选与运行详情之间以地址串起,未结束的轮次显示为「运行中」并自动续查。细节见 `web/AGENTS.md` 与 `web/DESIGN.md`。

- 2026-08-24: 主从列表选中态不再声明第二套 hover 背景。模型服务、审查策略与仓库的选中项在默认和悬停时统一保持深色背景与白色文字。

- 2026-08-24: 修复 Radix Themes 未分层样式覆盖 Tailwind 响应式布局。样式入口固定 `theme < base < radix < components < utilities`,Card、Button 与 Table 上明确声明的布局和断点显隐恢复生效；模型服务返回列表链接不再误标为当前地址。

- 2026-08-24: 管理面板完成 Radix 迁移收口。`MasterListItem` 统一仓库、模型服务与模型组合的主从选择；`DateRangePicker`、`EditableModelCombobox`、`EmptyState` 和 `useDialogReturnFocus` 分别统一日期范围、可编辑模型标识、空态与受控浮层焦点返回。页面按路由分块，仓库与模型服务在 `lg` 起采用列表／详情双栏和独立滚动，640–1023px 保持单层切换。部署实例已用 ego-browser 完成 2056px、768px 与 390px 端到端验收。

- 2026-08-24: 修正 Radix Themes 弹窗关闭按钮的定位。IconButton 保留自身布局规则，右上角定位交给外层容器，避免窄屏时关闭图标落到弹窗底部；模型服务、新建用户与角色、服务迁移、凭据维护和仓库注册统一处理。

- 2026-08-24: 管理面板补齐弹窗状态生命周期。模型服务三步弹窗从路由返回时恢复 provider、Tab 与两处滚动位置；新建用户、角色和自定义 provider 改名弹窗取消或关闭后清空草稿与提交状态。

- 2026-08-24: 管理面板的模型组合行改用 Radix Themes Checkbox 作为唯一多选标记,整行可点并保留浅色选中反馈；登录与改密后的默认入口调整为评审记录,无审查读取权限时进入下一个可见页。当前文档同步移除迁移前的 shadcn、暗色变体和已删除依赖说明。

- 2026-08-24: 管理面板清理 Radix 迁移后的零引用依赖。移除 `class-variance-authority` 与 `tw-animate-css`，同时删除已无调用方的动画导入和暗色变体守卫；`cmdk`、`react-day-picker` 与 `radix-ui` 继续承担搜索组合框、日期区间和 Primitive 行为。

- 2026-08-24: 管理面板完成模型服务页浮层与导航迁移。重新验证统一使用 `EditableModelCombobox` 保留 cmdk 搜索和手填；服务详情使用 Themes `TabNav`,发现差异与组合引用使用 Collapsible；稳定路由、当前 provider、当前 Tab 与业务状态保持不变。

- 2026-08-24: 管理面板完成访问控制表格迁移。用户列表与权限矩阵直接使用 Radix Themes `Table`,保留行内角色选择、权限复选、管理动作、表头关联、粘性首列和容器内横向滚动。

- 2026-08-24: 管理面板完成处置率页 Radix 迁移。日期范围统一使用 `DateRangePicker`,双月 Calendar 行为只保留在组件内部,窄屏模型矩阵使用 Collapsible；桌面 Themes `Table`、Finding Identity 口径、范围选择和响应式布局保持不变。

- 2026-08-24: 管理面板的审查策略页将批次上限的原生折叠区迁移到 Radix Collapsible，默认折叠、帮助提示、键盘操作、单独保存与版本冲突恢复保持不变。

- 2026-08-24: 管理面板完成评审记录页 Radix 迁移。结论筛选、桌面记录表和失败原因展开分别使用 Themes `SegmentedControl`、Themes `Table` 与 Collapsible，保留已加载数据过滤、日期分组、无限加载、重跑权限和窄屏记录布局。

- 2026-08-24: 管理面板统一 Provider 单选组件。模型服务主从列表与审查策略/仓库覆盖的 `ModelComposer` 共用深色实底、白字、深色 hover、焦点及辅助文字对比规则；路由项与页内按钮分别保留 `aria-current` 和 `aria-pressed`,模型多选继续使用浅色反馈。

- 2026-08-24: 管理面板完成 Dialog 组件族迁移。普通编辑与三步模型服务配置直接使用 Radix Themes `Dialog`,删除、密码重置、丢弃与离开确认使用 `AlertDialog`;长内容限制在弹窗内部滚动,旧 shadcn Dialog wrapper 删除。

- 2026-08-24: 管理面板完成统计表格迁移。统计矩阵直接使用 Radix Themes `Table`，保留横向局部滚动、粘性模型列、语义 caption、数值布局和移动端折叠展示；旧 shadcn Table wrapper 删除。

- 2026-08-24: 管理面板完成原生表单选择控件迁移。访问控制的角色分配使用 Radix Themes `Select`,权限矩阵、模型补录确认和批量管理使用 Themes `Checkbox`,全选状态支持部分选中；可搜索且可手填的 model id 保留 datalist 行为。

- 2026-08-24: 管理面板完成 Skeleton 组件族迁移。所有读取占位块改为直接使用 Radix Themes `Skeleton` 并保留原尺寸和布局；旧 shadcn Skeleton wrapper 与页面级 Skeleton 覆盖删除。

- 2026-08-24: 管理面板完成 Card 组件族迁移。所有独立任务卡改为直接使用 Radix Themes `Card`，长表格、模型服务侧栏和模型组合的局部滚动边界保持不变；审查配置与 Hook 配置的警告改为 Themes `Callout`，旧 shadcn Card wrapper 删除。

- 2026-08-24: 管理面板完成 Badge/StatusBadge 组件族迁移。来源、身份与类别直接使用 Radix Themes Badge；Review Run、Hook、模型服务、凭据、目录和模型可用性统一经四态 StatusBadge 展示,深色 provider 选中行保留对应状态色；旧 shadcn Badge wrapper 与页面状态色配方删除。

- 2026-08-24: 管理面板完成 TextField/Label 组件族迁移。全部文本输入直接使用 Radix Themes `TextField.Root`,可见与隐藏字段标签使用 Themes `Text as="label"` 并保留 `htmlFor`/`id`;模型筛选图标进入 `TextField.Slot`,旧 shadcn Input/Label wrapper 删除。

- 2026-08-24: 管理面板完成 Button/IconButton 整族迁移。业务动作直接使用 Radix Themes 官方组件与视觉属性，纯图标动作保留可访问名称；Calendar 保留日期行为并改用 Themes Button/IconButton 与 Theme token，旧 shadcn Button wrapper 及 `buttonVariants` 删除。

- 2026-08-24: 管理面板完成 Lucide 到 Radix Icons 的整族迁移。状态、搜索、关闭、展开、刷新和动作图标统一使用 `@radix-ui/react-icons`，保留状态文字、可访问名称、加载旋转与品牌 SVG；`lucide-react` 已从前端依赖和锁文件删除。

- 2026-08-24: 管理面板接入 Radix Themes 与 Radix Icons 基础层。应用根和迁移期 Primitive Portal 共用同一亮色 Theme 配置；Radix token 映射到迁移期 Tailwind 语义名,业务页面按组件族继续迁移。

- 2026-08-24: 管理面板的 Radix UI 迁移选定“发布门禁看板”视觉方向。Radix Themes 统一通用视觉,Radix Primitives 补行为,Radix Icons 统一业务图标；模型服务、仓库与审查策略共用同一 `MasterListItem` 深色选中规则。本条取代同日仅允许模型服务 provider 使用实心选中态的旧限制。

- 2026-08-25: 完成范围审查的 grilling。解除 ADR 0001 的「必须走 PR 流程」准入约束:人可在面板指定 base 与比较项发起范围审查,由 MultiReviewer 自建的容器 PR 承载行内 Finding 与 Disposition,见 ADR 0012;代码已改动且未再报出的 Finding 自动 resolve 并以独立处置值「已改动」分开统计,见 ADR 0013。`CONTEXT.md` 新增范围审查、比较项、容器 PR、审查完成、处置备注词条。尚未实现。同日封存 GitHub 实现,见 ADR 0014。共识收拢成 spec [范围审查：容器 PR 承载、面板处置与「已改动」自动处置](https://github.com/kassol/MultiReviewer/issues/152)(`ready-for-agent`),拆成 8 张子 issue #153–#160,阻塞关系用 GitHub 原生 issue dependencies 表示;#153、#154 两张预重构可立即开工。

- 2026-08-24: 完成管理面板迁移到 Radix UI 前的源码与官方能力研究。盘点 46 个 shadcn 基础组件、56 个项目组件、22 种 Lucide 图标及浏览器原生控件，明确 Radix Themes、Primitives 与 Icons 的职责边界；后续以 `DateRangePicker` 与 `EditableModelCombobox` 收口 Calendar 和可搜索手填行为。

- 2026-08-24: 管理面板完成全局选中态审查，统一主导航、主从列表、tab、筛选器与编辑中选择的颜色语义；修复实心选中行 hover 对比度、主导航激活文字颜色和详情 tab 重复选中，并记录弹窗关闭后保留列表项与 tab 的约束。

- 2026-08-24: 收回误作用于审查策略的选中态颜色；实心主色仅保留在模型服务 provider 列表与仓库列表，并补齐配置弹窗关闭后的 provider/tab 状态恢复。

- 2026-08-24: 模型服务页面收敛状态文案，移除正常服务与可用模型的重复提示；配置弹窗取消后保留原服务选择，模型组合编辑器强化当前服务与已选模型的高亮。

- 2026-08-24: 收紧运行镜像打包。前端构建与运行依赖安装完成后清理 pnpm store、npm cache 与临时缓存,避免把包管理器缓存带进最终镜像层;运行镜像仍只携带服务源码、生产依赖与前端 dist。

- 2026-08-20: 落地 issue #149。因 Pi 内置名称冲突而停用的自定义 provider 可从模型服务维护页原子迁移到新名称;服务、全局模型组合与全部仓库覆盖同事务改写,历史审查记录保持不变。普通模型服务不提供改名。
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
- 2026-08-08: 写部署向导 `scripts/setup.sh`,并补上部署时暴露的两处缺口。`.env` 此前没有任何东西读它,`pnpm start` 改为带 `--env-file-if-exists=.env`。`main.ts` 此前无条件要求 GitHub 凭据,只审 Gitea 的部署因此起不来;GitHub 那一格改成与 Gitea 对称的可选,并加上「一个 Forge 都没配就启动失败」的拦截——起得来却一次审查都跑不了的哑服务比起不来更难发现。新增 `test/main-boot.test.ts`,spawn 真实进程覆盖这两档。
- 2026-08-08: 部署形态定为 Docker。镜像在开发机构建后推 registry,服务器只放 `docker-compose.yml`、`setup.sh` 与向导生成的两个文件,不需要源码。基础镜像选 `node:24-slim` 而非 alpine:依赖树里有平台专属预编译产物,musl 下未验证。镜像内必须装 git——工作副本靠 git 命令准备。宿主机的 `node_modules` 含 darwin 原生二进制,`.dockerignore` 排掉,依赖一律在镜像内重装。数据绑宿主机 `./data`,属主须为 uid/gid 1000。容器内监听端口固定 3000,对外映射另用 `MULTIREVIEWER_HOST_PORT`——与应用读的 `MULTIREVIEWER_PORT` 同名会让映射失效。镜像已实测:git 2.39.5、非 root 运行、启动监听、坏签名回 401;向导里两条依赖容器的校验也已对真实镜像验过正反两向。
- 2026-08-08: 容器改为以宿主机上的部署用户身份运行(`user:` 取 `.env` 的 `MULTIREVIEWER_UID` / `MULTIREVIEWER_GID`,向导写入 `id -u` / `id -g`),取代原先「data 目录 chown 到 1000」的做法。部署目录放进 home 时,把目录改成别的属主会让本人写不进自己的 home。实测容器在没有 passwd 条目的 uid 下照常工作:HOME 落到 `/`,而本服务与 git 都不写 HOME。部署目录位置无约束,向导与 compose 的路径均相对自身解析,已在 `~/share/workspace` 下以 uid 501 跑通全流程。
- 2026-08-08: 修部署向导的一处硬故障。compose 以「只读单文件」绑定 `multireviewer.config.json`,而数据目录那一步的容器探针早于配置写入——绑定时宿主机上该路径不存在,docker 建了一个属主为 root 的同名目录,写配置随即撞上 "Is a directory" 且没有 sudo 清不掉。向导现在在第一条 compose 命令之前就坐实该路径是文件,并对残留的目录给出清理命令。同时让向导可续跑:已写进 `.env` 的值会让对应阶段跳过,`FORCE=1` 强制重做。
- 2026-08-08: 向导的公网自检补上一处盲点。那个 curl 是从服务器自己发的,地址填成只有本机可达的值(docker0 网桥 `172.17.x`、`127.x`、`localhost`)时它照样通过,而 Gitea 一条投递也发不出来。现在这类地址会提前警告并记进待办;`172.16/12` 的其余部分不报警,那是合法的企业内网段。同时把话说清:唯一能证明 Gitea 到得了本服务的检查是 Gitea 那侧的投递记录。
- 2026-08-08: 服务补上投递日志。此前它只在失败时输出,正常收到投递、判定不处理、审查跑完都不打印任何东西,日志里只有启动那一句——服务在正常工作与完全收不到投递之间看起来一模一样。现在每条通过签名校验的投递记一行,写明这次做了什么。记录点选在签名校验之后:未认证的请求谁都能发。
- 2026-08-08: 按使用反馈改审查结果的呈现。严重度从 high/medium/low 换成 P0/P1/P2——评论列表里一眼看得出轻重,形容词做不到;归一化层仍收形容词,模型不总照约定报。Finding 描述改中文。新增 PR 进度标记:开跑挂 👀,跑完未发现问题换 👍,这是零 Finding 时 PR 上唯一的痕迹。为此 bot 的 PAT 要补 `write:issue`——实测 reaction 端点挂在 `/issues` 下,只有 `write:repository` 时 403,这推翻了此前「一个 scope 就够」的结论。「PR 新增 commit 重新触发审查」早已实现(`webhook/server.ts` 的 `synchronized` → `new-commit`),本次未改。
- 2026-08-08: 对真实实例验证「PR 新增 commit 重新触发审查」,过程中查出一处部署侧的静默失效:Gitea 的 webhook 订阅里「合并请求同步」是独立事件 `pull_request_sync`,与「合并请求」分开。只勾后者时新 commit 一条投递都不发,代码侧的 action 映射没有机会执行,而且毫无异常迹象。补勾之后实测触发成功(`new-commit @90ff21d — 开始审查`)。同一轮还验证了草稿拦截:PR 标题带 `WIP:` 前缀时 Gitea 判为草稿,投递照发但本服务按设计不审,日志记「草稿,不审」。
- 2026-08-08: 实测确认自托管部署的一道必经关卡:Gitea 的 `webhook.ALLOWED_HOST_LIST` 默认 `external`,只放行公网单播地址,发往 RFC 1918 地址的投递被 Gitea 自己拒掉,报 `webhook can only call allowed HTTP servers`。服务侧完全无感——请求根本没发出来。写进 Gitea 准备步骤,向导的投递排查里也列了这条报错。取值语法取自官方 config cheat sheet:内置组 `loopback` / `private` / `external` / `*`,另可写 CIDR 与通配主机名。
- 2026-08-14: 定下处置率的口径,见 ADR 0006。查出 `finding.disposition` 一次性写入、永不回填,首次报出一律 `unknown`,而被人 resolve 且代码也改掉的 Finding 下一轮不再被报出,于是永远不留 `resolved` 行——现有数据算不出可信的比率。口径改为:分母的单位是 **Finding Identity**(`CONTEXT.md` 新增该词条),disposition 靠回填链路从 Forge 补齐(每轮 Review Run 顺手回写 + PR `closed` 时全量,两处都不新增 API 调用),fallback Finding 因为没有承载 resolve 的地方而排除在统计外,`unknown` 按 pull request 状态区分。术语用「处置率」,不叫采纳率:resolve 状态证明不了代码被修好。
- 2026-08-14: 定下 key 轮转的形状,见 ADR 0007。Gitea 改不了 hook 的 secret 也从不回显它,轮转只能删旧建新,而「库里的 key 与 Gitea 上的 secret 是否一致」原本不可观测。做法是给每个仓库的 key 编一个单调递增的**代次**,写进 hook URL 的 `?k=` 参数——`config.url` 是唯一双向可见的字段,一次 `GET .../hooks` 就读出 Gitea 上装的是第几代。代次可读之后轮转不再需要状态机:库里的 key 列表与 Gitea 上的代次一比,唯一确定下一步,轮转成为可重入的单调推进。顺序取先建后删,并存期间的重复投递被 `claimDelivery` 的 `(owner, repo, head_sha)` 幂等键吃掉,无 hook 窗口因此不存在。删除仓库时 hook 删不掉就不放行删除,「有 hook 无记录」这个中间态被设计消除。
- 2026-08-14: 定下 webhook 与面板的路径划分。查出服务现在根本不路由——`src/webhook/server.ts:362` 的 handler 从未读过 `req.url`,任何路径的请求都当投递处理,所以这是从零引入路由。路由表:`POST /webhook`(带 `?k=` 代次)、`<前缀>/api/*`、`<前缀>/*` 回注入过的 `index.html`、`/assets/*` 静态产物、其余 404。面板的随机前缀只盖面板,webhook 固定在 `/webhook`——盖住它等于每次轮换前缀都要重建全部 hook,而 webhook 的保护本来就是 HMAC 验签不是路径保密。静态资源不进前缀,Vite 保持默认绝对 base;前缀是运行时随机值,靠服务返回 `index.html` 时注入一个全局变量喂给 Router basepath 与 API 基址,构建产物与前缀无关。部署侧:反代只配一条规则整域全转并原样透传路径,前缀轮换不碰反代;不支持子路径部署,服务占域名根;基地址换新变量名 `MULTIREVIEWER_BASE_URL`,旧的 `MULTIREVIEWER_PUBLIC_URL` 值含 `/webhook` 后缀,同名不同义会静默出错;基地址是 `http://` 且非 localhost 时拒绝启动——Secure cookie 在明文 HTTP 下发不出去,服务起得来、面板打得开、就是登不进。
- 2026-08-15: 定下前端本地联调方式,「仓库准入与管理面板」的地图(issue #17)至此走完。dev 与生产的分叉压缩到「谁往 `index.html` 注入前缀全局变量」一个点:生产是服务,dev 是用 `transformIndexHtml` 钩子的内联 Vite 插件。前缀来源是同一份 `.env` 的 `MULTIREVIEWER_PANEL_PREFIX`,后端运行时读、Vite 用 `loadEnv` 配置阶段读;dev 下走 Vite proxy 代理 `/<前缀>/api` 到本机后端,浏览器视角同源同路径,cookie 正常携带、无 CORS;前端只读注入的全局变量,不设 `import.meta.env` 回落,注入缺失当场报错。地图共 8 条决策(6 张 grilling、1 张 research、1 张 prototype),下一步交 `/to-spec` 收拢成可建造的 spec。
- 2026-08-15: 落地 issue #27(仓库准入与管理面板的第一票)。服务从零引入路由:webhook 固定在 `POST /webhook`,其余任何路径与方法一律 404、不重定向。部署向导随之改:公网地址输入自动补齐 `/webhook` 后缀,本机自检指向 `/webhook`,「路径任意」的表述删除。
- 2026-08-15: 落地 issue #28。仓库注册表与 per-repo Key 准入:投递从 payload 取数值 repo id 查注册表,按 `?k=` 代次选 Key 再验签,未注册与代次不对分成两类 401 记录、按仓库只记首次。全局 `MULTIREVIEWER_WEBHOOK_SECRET` 硬切删除,启动不再读它;GitHub 因无注册途径从准入层退场,适配层与其测试保留。CONTEXT.md 新增 仓库注册表 / Key / 代次 三个词条。过渡期注意:管理面板落地前注册表只能直接写库种入,部署向导的 hook 注册指导暂时失效(issue #38 收口)。
- 2026-08-15: 落地 issue #29。面板最初的认证 API 与启动校验:`POST <前缀>/api/session` 验 admin token 换 HttpOnly + Secure、`Path` 限前缀的 session cookie,登录失败按 IP 退避与锁定;其余 API 未认证一律 401,认证后未知端点回 JSON 404,页面 404 与前缀猜错不可区分。当时启动新增三个必需环境变量 `MULTIREVIEWER_ADMIN_TOKEN` / `MULTIREVIEWER_PANEL_PREFIX` / `MULTIREVIEWER_BASE_URL`;这套 token 门禁后来由 issue #109 取代。
- 2026-08-15: 落地 issue #30。Gitea 专属 hook 管理模块 `src/forge/gitea-hooks.ts`:列 / 建 / 删仓库 hook(窄订阅事件集、`active` 显式置真、删除遇 404 视为成功、按 `config.url` 幂等收敛)与 bot 权限查询(非 admin 拒绝并明说缺什么)。不进 `Forge` 接口,契约依据是 `docs/research/gitea-webhook-api.md`。
- 2026-08-15: 落地 issue #31。仓库注册与移除全流程走面板 API:注册验 bot admin 权限、自动建 hook(URL 带 `?k=` 代次)、落注册表与 Key,可带模型覆盖(全量替换 reviewers,默认跟随全局,注册后下一次投递生效);移除先删 hook、删不掉不放行,评审记录保留。仓库列表带累计量、按最近活动排序。「直接写库种入」的过渡状态就此结束。
- 2026-08-15: 落地 issue #32。Key 轮转与核对(ADR 0007):轮转是可重入的单调推进,先建后删、轮转中投递不中断、失败再点一次从断点继续、库回滚后一次轮转自愈;核对拉 Gitea 的 hook 列表与库比对,只展示差异与下一步动作,不自动修。
- 2026-08-15: 落地 issue #33。管理面板前端从零起(`web/`,Vite + React + TanStack Router/Query):登录一屏加三页顶部导航的空壳。服务端补齐路由表的页面两格(前缀下返回注入前缀全局变量的 index.html、`/assets` 服务构建产物),Docker 改多阶段构建,dist 不进版本库也不含前缀。dev 双进程联调:Vite 插件注入同名变量、proxy 转 `<前缀>/api`,前缀读同一份 `.env`。生产镜像、dev 双进程与真实浏览器(登录、三页导航、深层路由刷新)均已实测。
- 2026-08-15: 落地 issue #34。仓库页 master-detail(原型变体 A):注册模态、移除二次确认(删 hook、评审记录保留)、轮转按钮、打开仓库即核对并可一键推平差异、模型组合可编辑(新端点 `PUT /repos/<id>/reviewers`),key 任何界面不回显。真实浏览器走通注册 → 轮转 → 手删 hook 后推平 → 改组合 → 移除全流程。
- 2026-08-15: 落地 issue #35。处置率的回填链路(ADR 0006)打通:每轮 Review Run 顺手把读回的 resolve 状态覆盖到历史 finding,PR closed 投递触发全量回填并落 PR 状态;`finding` 记来源类型(行级评论 / 正文),正文行排除在统计外。两个时机都不新增 API 调用。
- 2026-08-16: 落地 issue #36。处置率统计与页面:`store.ts` 的 `dispositionStats` 按 Finding Identity 折叠出模型 × 分类矩阵,`GET <前缀>/api/stats` 打包矩阵与库体量(库文件字节数 + 全部表行数),前端处置率页按原型变体 B 落地(模型卡片 + 矩阵,每格永远带分子分母)。口径细则见 `src/AGENTS.md`,页面见 `web/AGENTS.md`。
- 2026-08-16: 落地 issue #37。评审记录页与手动重跑:跨仓库 Review Run 时间流(按天分组、滚动加载更早、覆盖已移除仓库的历史、顶部统计带与处置率页同源),重跑两个入口(时间流逐条、仓库页输 PR 号)共用 `POST <前缀>/api/rerun`,开的是新一轮 Review Run、走既有跨轮次折叠。服务端见 `src/AGENTS.md`,页面见 `web/AGENTS.md`。
- 2026-08-16: 落地 issue #38。当时部署向导边界收在「面板能登录」:阶段 7 生成 admin token 与随机面板前缀、问基地址,再拿 token 真登录自检。这套流程后来由 issue #117 改成账号 bootstrap 与 SQLite 状态探测;本条只记录历史。
- 2026-08-16: 修 issue #39。Gitea 适配层三处 PR 列表翻页的终止条件从「不满一页」改为「读到空页」,实例把 limit 钳到 `API.MAX_RESPONSE_ITEMS` 时不再提前停、Review Range 不再静默缺文件。细节见 `src/AGENTS.md`。
- 2026-08-16: 落地 issue #40。重写 README:移除「Early design phase」与 Out of Scope 的交叉验证宣传,最低版本要求(社区版 1.26.0 / 企业版 26.0.0)置于 Requirements 首句,GitHub 表述改为「适配层存在、准入仅 Gitea」,部署与文档细节指向 AGENTS.md 与 CONTEXT.md。
- 2026-08-16: 落地 issue #73。模型标识统一成 `provider:model`(`CONTEXT.md` 早已如此定义,词条未动):落库的 Finding 与 Reviewer 结果、面板展示、处置率统计归属全部用完整标识,模型组合的去重键随之改成完整标识——同一个 model id 在两家 provider 下是两个 Reviewer,可共存。历史行在服务启动时一次性回填,幂等;provider 在库里没有记录,判据取「按裸 model id 在当前模型组合与各仓库覆盖里反查得到唯一 provider」,反查不到就不动那一行(留下的旧形态行在统计里各成一条,不会被错误归并)。内容指纹与评论锚点都不含模型标识,历史评论的跨轮次匹配不受影响。
- 2026-08-16: 落地 issue #64。模型凭据加密进库、由面板写入(ADR 0008):按 provider 一把,同一家下的多个模型共用;保存时真发一次最小请求验证厂商 key,不通过不落库并回报原因;只写不回显,列表只给 provider、是否已配、更新时间与尾 4 位;同 provider 二次写入是覆盖。主密钥是新的可选环境变量 `MULTIREVIEWER_CREDENTIAL_MASTER_KEY`,没设时凭据端点读写都 503 并说明差什么,服务其余部分照常启动。解不开的密文一律按未配置透出,不抛也不做重加密迁移。面板新增凭据页(`web/src/credentials.tsx`)。本票不动启动时的凭据校验(issue #65)与配置文件(issue #66),`buildReviewers` 仍读 `apiKeyEnv`,库里的凭据还没有接进 Review Run。部署向导也未改,新部署要手工往 `.env` 补主密钥(issue #72 收口)。
- 2026-08-16: 落地 issue #65。凭据校验从启动挪到组装 Reviewer(ADR 0008)。启动不再读 `apiKeyEnv`:空库、一把模型凭据都没有、连主密钥都没设的新部署照常起,人进面板把它配起来。组装点是 Review Run 开始的那一刻(投递与手动重跑共用):按 provider 从库里取一次凭据快照,在编排进程里解密,整轮不重读——轮转对进行中的 Run 无影响,下一次投递自然用新的。缺凭据的 provider 不再抛错拦住投递,而是建出一个一跑就报失败的 Reviewer,那次 Review Run 因此在时间线上留下一条失败记录,失败原因写明缺哪一家。凭据来源收敛到库这一条:`apiKeyEnv` 字段还在配置文件里(issue #66 删),但组装不再读它,文件与库不构成双轨。子进程的注入路径未动(ADR 0004):仍是单变量 `MULTIREVIEWER_MODEL_API_KEY`、先剥光父进程环境,密文与主密钥都不进子进程。
- 2026-08-16: 落地 issue #66。全局设置进库,`multireviewer.config.json` 废除。模型组合与批次上限存 `global_setting` 表,面板的 `GET`/`PUT <前缀>/api/settings` 读写同一形状(`{reviewers: [{provider, model}], maxChangedLinesPerBatch}`);全局组合与每仓库覆盖同构,一套校验判据通吃,报错标注是全局还是哪个仓库;批次上限缺省时读回默认值 2000。`ReviewerSpec` 去掉 `apiKeyEnv`,凭据只从库里按 provider 取(ADR 0008)。空库、还没配组合时投递照常受理,留下一条失败的 Review Run 写明「还没有配置模型组合」——零 Reviewer 的 Run 不留痕,那才是真的看不出问题。删掉的东西:`multireviewer.config.example.json`、`loadConfig` 与默认配置路径、环境变量 `MULTIREVIEWER_CONFIG`(镜像里那一行也删)、compose 的只读单文件绑定与「只需要这三样」的注释、向导写配置的那一段(向导的模型标识核对改成直接核两个入参)。面板暂时只有端点没有设置页,组合的选择器是 issue #68 / #69。
- 2026-08-16: 落地 issue #67。面板 API 加模型目录端点 `GET <前缀>/api/catalog`,回服务进程里那份 Pi 的全部 provider(实测 39 家)与它们的模型,每家带上凭据是否已配。目录是运行时事实,随 Pi 升级而变:从服务端读,不进前端构建期依赖,前端不重建也不会显示旧目录。目录与凭据状态一次请求拿齐——拆成两个端点要在前端合并两份数据,还多一次往返。每个模型只给 `id`、`name`、`contextWindow`、`cost`:`id` 是模型标识 `provider:model` 的后半段,选择器要靠它回填,其余三项是选型判据;reasoning / maxTokens / input / baseUrl 不给,面板不用它们做判断。没配凭据的 provider 照常在结果里,不过滤——先能看见一家,才知道该去配它的凭据。不做工具调用能力的拦截:Pi 的模型类型里没有这个字段,面板自建黑名单追不上上游,让它在 Review Run 里失败并写明原因。本票只有端点,模型组合的选择器是 issue #68。
- 2026-08-16: 落地 issue #70。注册仓库改成搜索式下拉。面板新增 `GET <前缀>/api/repos/search`:当时仍走统一 token 门禁,服务端用 bot PAT 调 Gitea 的 `/repos/search`,浏览器不直连 Gitea;能力挂在 Gitea 专属的 hook 管理模块上,不进通用 `Forge` 接口。
- 2026-08-16: 落地 issue #71。面板补上登出:`DELETE <前缀>/api/session` 回一个 `Max-Age=0`、属性与登录时逐字一致的 Set-Cookie。当时会话在内存、重启即清空;issue #109 后会话改为落库,重启语义反转,现行运维办法见上文「面板门禁的运维」。
- 2026-08-16: 落地 issue #72。部署向导退出配置面。删掉三个阶段:DeepSeek 密钥、OpenRouter 密钥、模型组合(连同容器里那次 Pi 模型表核对),向导从九步降到六步,成功边界仍是「面板能登录」。清理动作之前先把 `.env` 复制成 `.env.bak-<YYYYMMDD>`(权限 600,同一天重跑不覆盖已有副本——覆盖会用已经清过的内容把旧值冲掉)。四个变量随后检出即清并说明原因:`DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`(模型凭据改由面板凭据页加密存库,ADR 0008)与 `MULTIREVIEWER_DEEPSEEK_MODEL` / `MULTIREVIEWER_OPENROUTER_MODEL`(模型组合改由面板设置页存库)。备份是文件复制、清理只打变量名,key 的值一次都不上屏。凭据主密钥 `MULTIREVIEWER_CREDENTIAL_MASTER_KEY` 改由向导 `openssl rand -hex 32` 生成并写进 `.env`,值不回显;已有值时沿用,`FORCE=1` 也不重新生成——重新生成等于把已存的凭据作废。不生成的话新部署必须手工补一个随机密钥才打得开凭据页,而向导的收尾恰恰是让人去那一页配 key。交付清单的「下一步」补两条:设置页选模型组合、凭据页粘两家的 key,并说明这两步没做完时投递会建一次失败的 Run 而不是故障。
- 2026-08-16: 收口 issue #56 十票落地后的评审复核,七条。两条是行为决策:一、模型标识的历史回填整体取消——provider 从库里恢复不出来,按当前模型组合反查会把历史 Finding 永久错归厂商,代价是同一个模型在迁移前后裂成两行(旧行裸 model id、新行 `provider:model`),统计矩阵里各成一条;二、模型凭据允许保存认不出的 provider——模型目录列出 Pi 全部 39 家,而厂商验证只认得 4 家,拒收会让其余 35 家的模型选得出、凭据配不上;这些凭据跳过验证落库并标成未验证,面板逐行透出这个状态。其余五条是缺陷修复:模型目录的进程内缓存不再存住失败的 promise;全局模型组合允许为空(每仓库覆盖仍必须至少一个);批次上限的 NaN 不再静默清空设置;注册模态改搜索词后不再提交过期的选中项;模型选择器的总量截断有了提示。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-17: 面板换视觉世界。上一轮青色密控制台被否。方向定为品类标准件,手艺对标 GitHub / Linear / Vercel:近黑主色、白底、冷灰外壳。登录后落到评审记录;该页改成检查列表。产品事实见 `web/PRODUCT.md`,视觉系统见 `web/DESIGN.md`。
- 2026-08-18: 模型目录补两个词条:远程目录、厂商目录。OpenRouter 现货并进目录的 spec 是 issue #75。
- 2026-08-18: 开 wayfinder 地图「模型怎么进组合」(issue #76)。目的地是三条入口的可开工 spec。OpenRouter 厂商目录折进图里,不单独实现。
- 2026-08-18: 走完地图 issue #76 的 [厂商目录这轮还点名哪家](https://github.com/kassol/MultiReviewer/issues/79)。厂商目录这轮只接 OpenRouter,代码验收边界按 issue #75 的形状留下,不点名第二家。判据是落盘那一行要带齐 `api` / `baseUrl` / `compat` / `cost` / `contextWindow`,而 13 家实测里只有 OpenRouter 免鉴权就给全量(200,414 个模型),其余一律 401 / 403。接一家要 key 的会让目录加载反过来依赖凭据表,「还没配凭据也能看见完整目录」随之失效;缺单价的行会让 Review Run 成本恒为零——成本取自 Pi 内置定价表,硬编码等于在本仓库维护一张会过期的价目表。一手厂商缺的模型走手填入口兜底。笔记落 `docs/research/vendor-model-catalog-apis.md`,含 13 家的实测响应与字段出处;未来若接第二家,顺序是 Together → Groq → Anthropic,接之前先解决目录加载怎么拿凭据与缺单价的成本口径。
- 2026-08-18: 走完地图 issue #76 的 [手填标识开在哪些 provider 上](https://github.com/kassol/MultiReviewer/issues/80)。手填模型标识只开在已配模型凭据的 provider 上,provider 那一格从目录里选、不敲。判据是选择器今天就以凭据为硬门禁(未配凭据的分组标题写「未配凭据,选不了」,其下每个模型 disabled),放开到全部 39 家会让同一个 provider 点不动却敲得进,两套规则并存。敲一个目录里没有的 provider id 落到的是自定义 provider 那条入口,让它选而不敲把两条入口的边界交给控件形态,不靠运行时猜。填错不加新校验:模型标识不存在由子进程报「模型不存在」,该家没凭据则组装出一个一跑就失败的 Reviewer 并写明去凭据页配,单个 Reviewer 失败不拦整轮。顺带查明服务端的 `PUT /api/settings` 只校验形状、非空与标识不重复,不查凭据也不查目录成员——门禁一直只在前端。
- 2026-08-18: 走完地图 issue #76 的 [自定义 provider 在模型标识里叫什么](https://github.com/kassol/MultiReviewer/issues/81)。provider 段就是 Pi 的登记 id(models.json 里 `providers.<id>` 的那个键),要定的只是谁写、能写几个:操作员起名,一个名字对应一个 base URL 与一把模型凭据,与内置 39 家共用同一命名空间。判据是 `model_credential.provider` 为主键,一家一把凭据;固定成 `openai-compatible` 一家会让公司网关与本地 vLLM 二选一,固定前缀加序号则在 PR 评论与处置率统计里看不出是哪一家。撞上内置名字当场拒收——Pi 对同名不报错而是静默覆盖(只给 baseUrl 不给 models 时内置模型列表原样保留、全部改指新端点),叫 `openai` 会让已有组合悄声换端点。名字限小写字母、数字与连字符,与内置 id 同形,顺带包含「禁冒号」这条硬约束(`parseModelIdentity` 按第一个冒号切分)。`CONTEXT.md` 新增词条 自定义 provider。「拿自定义端点覆盖内置 provider 的 base URL」判为出界:那是改一家已有的,不是加一家新的。
- 2026-08-18: 走完地图 issue #76 的 [手填与自定义的模型行怎么活过重启与远程刷新](https://github.com/kassol/MultiReviewer/issues/82)。票的前提要修正:模型行不走 `models-store.json` 走 `models.json`。`withRemoteCatalog` 只包在内置 provider 列表上,自定义 provider 没有 `refreshModels`,store 里的条目根本不会被恢复,两条入口不可能共用 store。而 `models.json` 是独立且盖在 store 上面的一层——`getModels()` 每次读都重跑一遍 `applyModelsJson(providerId, base.getModels(), config)`,`base.getModels()` 才是「内置 + store overlay」的合并,远程刷新换掉的只是内部那个 `dynamicModels`,models.json 那层在它之后原样再叠。「怎么不被抹掉」在选对层之后自己消失。附带三条:`applyModelsJson` 是 upsert(内置行保留、同 id 覆盖、新 id 追加);给已有 provider 加行时 `defaults` 回落到该家 `models[0]`,`api` 与 `baseUrl` 自动继承,手填一行最少只要一个 id;全新 provider 无此回落,缺 `api` 或 `baseUrl` 该家整个从目录消失。真相源定在库里(与模型组合、模型凭据同处),`models.json` 是可从库重建的派生物,写在缓存目录里两侧共用(同 `models-store.json` 的绝对路径理由),写库时同步重写、启动时再写一次兜底——只在读目录时重建会让没人打开过面板的实例投递进来直接报模型不存在,那正是当初 store 踩过的坑。`authPath` 保持各自私有不共用(ADR 0004)。单价与上下文选填,留空走 Pi 默认(单价 0、上下文 128000、maxTokens 16384),该模型的 Run 成本因此记零,面板需标出这一状态。
- 2026-08-18: 走完地图 issue #76 的 [三条入口在面板上怎么同时出现](https://github.com/kassol/MultiReviewer/issues/83),地图至此结清。三条入口取原型变体 C 的两栏布局:左栏是厂商列(内置 39 家与自定义的排在同一列,底部「+ 加一家 provider」),右栏是选中那家的模型列,右栏底部固定一行手填 model id。判据是它把「填进哪一家」这个问题设计掉了——手填框长在已选中那家下面,provider 不是一个要填对的字段而是当前所处的位置,而变体 A 与 B 都得靠下拉或按钮组强制同一条约束;左栏把自定义 provider 与内置的排成一列,也顺带说清了「共用同一命名空间」。明确接受的代价是跨厂商搜索没了(现在敲 glm 能横扫 39 家):模型组合是低频设置,三条入口的边界清楚每次都要用,这笔交易划算。原型另发现一档:本机一把凭据都没配时变体 A 的落空提示下面没有任何出路,C 不存在这一档。三个变体留在 `prototype/model-entry-panel` 分支,不进主干。下一步交 `/to-spec`:新开一份总 spec 并把 issue #75 包进去,它是三条入口之一的完整实现细节、已可开工,重写一遍只会让两份描述漂移。
- 2026-08-18: 地图 issue #76 收拢成 spec [模型进组合的三条入口：厂商目录、手填标识、自定义 provider](https://github.com/kassol/MultiReviewer/issues/84)(`ready-for-agent`),地图随之关闭。六张决策票的结论逐条折进去,[厂商目录：把 OpenRouter 现货并进模型目录](https://github.com/kassol/MultiReviewer/issues/75) 原样包进总 spec、不单独实现(它是三条入口之一的完整实现细节、已可开工,重写会让两份描述漂移),该票已注明折入。测试验收边界四条全部沿用既有的、一条新的都不加:面板 API 真实 HTTP(先例 `panel-settings` / `panel-credentials`)测两类写入的读写与拒收;模型目录端点(先例 `panel-catalog`,期望值另建 Pi 运行时问它、不拿被测模块自己的输出当判据)测目录里的集合变化;Reviewer 运行时(先例 `reviewer-model-store`,真建运行时并打桩 fetch 断言零外发)守「面板选得出的子进程必须取得到」这条最要紧的不变量;`runReview` 入口测失败路径留下带原因的记录。厂商目录那部分沿用 issue #75 已定的三条验收边界。
- 2026-08-18: 定下验证的场所:交付前的人工确认走部署实例,不在开发机起服务(全局规范新增一条,`web/AGENTS.md` 的模块规范呼应一条)。自动化测试不受影响,仍在本机跑——那是验收边界上的断言,与实例无关。判据是本机 dev 双进程没有真 Gitea、没有已注册的仓库、没有模型凭据,面板上大半的屏在那里是空的,补齐这些的成本比推一次镜像高,而验完的结论还不能代表实例。开发机的 `.env` 因此只留 Gitea 那几个变量,面板前缀 / 基地址 / 凭据主密钥不常驻;临时要在本机起面板时补上、验完删掉。
- 2026-08-18: 落地 issue #85 与 #86,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的两张预重构,对操作员不可见。面板与 Reviewer 子进程共用的落盘文件从一份变两份:`MULTIREVIEWER_CACHE_DIR/pi-models/` 下除了远程目录的落盘 `models-store.json`,还多一份由库里的模型行派生的 `models.json`。后者此前两侧各指自己的临时目录、谁也读不到谁,而它是手填模型行与自定义 provider 唯一的落地层(issue #82),这一票只把路径打通,不引入任何新的模型来源。启动时写一次(内容此刻是空的 provider 集合);写不出来只告警不拦启动,读照常。两份文件都是可从库与 pi.dev 重建的派生物,清空它只影响下一次读目录。凭据那一份仍各自私有不共用(ADR 0004),共用的只有目录。另给模型目录的进程内缓存补了显式失效入口,供下一票的模型行写入调用。

  评审顺带查出一个**自 2026-08-17 起就存在的部署缺陷**:`MULTIREVIEWER_CACHE_DIR` 留空或填相对路径时,共用完全不生效——Reviewer 子进程的工作目录是工作副本,同一个相对值在服务与子进程两侧解析出两个不同目录,面板选得出的远程模型子进程一个都取不到。Docker 部署里这个变量是绝对路径 `/data/worktrees`,所以镜像跑法不受影响;直接 `pnpm start` 且没设这个变量的部署一直是断的。现在服务在父进程里把它解析成绝对路径再传给子进程,填相对值也能用了。**票 #86 的前提查证后有一处是错的**:凭据写入后目录端点的 `configured` 本来就是每次请求现读库算出来的,不受缓存影响,已用测试证伪并因此没有把失效接到凭据写入上。
- 2026-08-18: 落地 issue #87,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的第一条。**目录里没有的模型,现在可以自己填一个进去。**全局设置页底下多一张「手填模型标识」的卡片:挑一家已配模型凭据的厂商,填厂商文档里那个 model id,提交之后它立刻出现在上面的模型组合选择器里,选进组合就能跑。填一行只要 model id 一项——接口地址与协议由 Pi 从那一家已有的模型继承,不用操作员再问一遍。

  几条要知道的:**只有已配凭据的厂商能填**,一把 key 都没配时那个下拉是空的、卡片会说清先去凭据页;**厂商从下拉里选,不能敲**,敲一个目录里没有的名字是「自己加一家 provider」那条入口,还没做。**填错了不会当场拦你**:model id 打错要到下一次审查才显形,那一个模型留下一条写明「模型不存在」的失败记录,同一轮里其余模型照常跑完、review 照常发。**手填的行活过重启,也活过面板刷新远程目录**:它存在库里,`models.json` 只是从库重建出来的派生物,清掉缓存目录或换卷都不丢——服务下次启动会按库里的行把它写回去。删除就在卡片的列表里,删掉之后模型目录立刻少掉那一行。已经把它选进模型组合的话记得一起改掉,否则下一次审查这个模型会报「模型不存在」。

  已知的一处别踩:**填一个那一家目录里已经有的 model id**,会把已有那一行的单价盖成 0(手填的行不填单价就是 0),而成本统计取的是这张单价表,那个模型的花费从此显示为零。要改单价等 issue #89,现在别拿手填去覆盖已有的模型。
- 2026-08-18: 落地 issue #92(实现细节见 issue #75),spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的第三条。**OpenRouter 在官网上有、选择器里搜不到的那些模型,现在自己会补进来。**操作员什么都不用做,也没有开关:服务读模型目录时,在 pi.dev 的远程目录之后再向 OpenRouter 拉一次它自己的现货清单,把前两层都还没有的模型补进目录(2026-08-18 实测这样的模型有 67 个)。补进来的模型和别的一样选、一样跑,还没配 OpenRouter 凭据时也照样看得见——先能选,再去凭据页配 key。决策与两条约束见 ADR 0009。

  几条要知道的:**已经在用的模型标识一个都不变**,撞上的以目录里已有那一行为准(包括 Pi 提供的 `openrouter:auto`),已有的模型组合不用重选。**OpenRouter 挂了或拉不到时选择器不空白**,退回原来那一份,只是少掉补进来的那些。**内网无出口的部署照旧设 `PI_OFFLINE`**,它一次关掉远程目录与厂商目录两层,一个请求都不发。**这一层的状态在目录端点上看**:`GET <前缀>/api/catalog` 的 `vendors` 字段按厂商报 `ok`(补上了)/ `unavailable`(没拉到)/ `off`(关掉了),与远程那一层的 `remote` 分开,少了一批模型时照它分辨是哪一层没生效;面板上这轮不画这个字段,运维读 API 或日志。**这轮只接 OpenRouter**,13 家实测里只有它免鉴权就给全量、而且响应自带单价与上下文窗口(`docs/research/vendor-model-catalog-apis.md`);别家缺的模型走手填那条入口。
- 2026-08-18: 落地 issue #89,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 里的一位呈现。**手填的模型不填单价时,面板现在会告诉你这个模型的费用会记成零。**模型选择器的行上、以及已选模型那一排标签上,原本写单价的位置换成一句「单价没填,费用记成零」;手填卡片的表单底下也写明这一点——这张表单填不了单价,填进来的行一律是这一档。

  这是把 issue #87 那条「别踩」摆到明面上:成本统计取的是 Pi 的单价表,而留空的行走它的默认值 0,于是这个模型在评审记录里的花费永远是 0。不说的话「没记账」会被读成「这次很便宜」。**手填一个该家已经有的 model id 也是这一档**(已有那一行被替掉、单价回落 0),现在它同样标得出来。

  一条要知道的边界:**目录里本来就免费的模型不标**。内置表里单价真是 0 的模型有一百多个,那个 0 是目录给的事实。判据只看库里那一行的两个单价字段有没有填,不看目录给出的单价。
- 2026-08-18: 落地 issue #88,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的第二条。**公司内网的模型网关、本机跑的那个部署,现在自己加一家就用得上了。**全局设置页底下多一张「自定义 provider」的卡片:给这家起个名字、填 base URL、挑接口协议、填第一个 model id 与那把 key,保存之后它就和内置那三十九家并排出现在模型目录里,它的模型选进模型组合就能跑。之后想在这家下面再加模型,用上面那张手填卡片,provider 下拉里已经有它了。

  几条要知道的:**名字由你起,但只能用小写字母、数字与连字符**,而且**撞上目录里已有的名字会被拒收**——Pi 对同名 provider 不报错而是做覆盖,叫 `openai` 会把已有那一家的每个模型都悄声改指你填的这个端点,面板上一点痕迹都没有。**base URL 与接口协议必须填**:全新的一家没有可继承的来源,缺任一者这一家会整个从目录里消失,而不是报错。接口协议两个选项——走 `/chat/completions` 的选 `openai-completions`,走 `/responses` 的选 `openai-responses`。**key 只写不回显,而且标成未验证**:自定义端点没有厂商验证认得的那种只读端点,key 对不对要等下一次审查才知道,凭据页上那一行因此写着「未验证」。**base URL 填错不会当场拦你**:地址对不对要到真请求才知道,那时那一个模型留下一条写明原因的失败记录,同一轮里其余模型照常跑完。

  **删一家会连它的模型行与那把 key 一起摘掉**,所以删之前会先查它在模型组合里还被引用着没有:全局组合与哪个仓库的覆盖里还有它,面板会指名道姓说清,先去那几处换掉再回来删。**重启之后这一家仍在**,它存在库里,派生的模型配置由服务启动时按库重建。**这一票还是挂在设置页上**,三条入口的两栏面板是 issue #90。
- 2026-08-18: 落地 issue #90,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的界面那一竖。**挑模型、手填一个标识、加一家 provider,现在在同一屏上。**全局设置页原来那个「挑模型」弹层没了,换成一块两栏面板:左边一列是全部厂商——内置那三十九家与你自己加的排在一起,各写着有几个模型、哪些家还没配凭据,列底部一颗「+ 加一家 provider」;右边是选中那家的模型,顶上一个搜索框,底下固定一行「在这家下手填一个 model id」。已经选进组合的模型单独一块放在上面,自己加的那几家标「自定义」、手填的标「手填」,单价留空的照旧标出费用记成零。

  这样排的理由是**「填进哪一家」这个问题没有了**:手填框长在你正看着的那一家下面,provider 不再是一个要填对的字段,是当前所处的位置。原先设置页底下那两张卡片(手填模型标识、自定义 provider)因此从页上消失,它们各自搬进了面板里对应的位置,能做的事一件不少——手填行的删除在右栏那一行的行尾,自定义 provider 的端点与删除在右栏顶上。

  **一个明确接受的代价:跨厂商搜索没了。**原来那个大搜索框敲 `glm` 能横扫三十九家,现在得先在左栏点中一家,搜索只筛这一家。判据是模型组合属低频设置(配好几个月不动),而三条入口的边界清楚是每次都要用的(issue #83)。真要跨厂商找,凭据页那个厂商下拉仍在。

  几条要知道的:**未配凭据的家照常列得出来**,点进去模型也看得见,只是选不了、手填框禁用并写明原因,「去配凭据」的下一步始终在眼前。**右栏一次最多列 120 行**,超了会写明还有多少、让你在搜索框里缩范围——openrouter 一家就有五百多个模型。**手填提交之后**那个模型立刻出现在这家的列表里,面板顺手按它过滤了列表,点一下就选进组合。**保存仍是那一颗「保存」按钮**,按下之后下一次投递按新组合跑。**仓库详情页那处「自定义模型组合」这一票没动**,它还是原来的弹层,换成同一块面板是 issue #91。
- 2026-08-18: 落地 issue #94,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的收尾一票。**自己加的那一家 provider,名字哪天被 Pi 撞上了,现在会当面告诉你,而不是悄悄把内置那一家换掉。**加一家时撞上已有的名字本来就会被拒收,可名字这件事会变:Pi 升一个版本就可能多出一家叫这个名字的内置厂商。撞上之后 Pi 不报错,它会把内置那一家的每个模型都改指你填的那个端点——模型标识一个字都不变,面板上一点痕迹都没有。

  从这一票起这一档有确定的行为:**你加的那一家整个停用**,内置那一家一点不动、还指着它原本的接口地址。两栏面板的左栏上那一行标出「名字冲突,已停用」,点进去右栏顶上写清撞的是哪一家,以及两条出路:**给它改个名字重建**,或者**把它删掉**。它的模型还留在模型组合里的话,下一次审查里那一个模型留下一条写明「名字冲突」的失败记录(与「缺凭据」、「模型不存在」分得开,一眼看出该去改名而不是去配 key),同一轮里其余模型照常跑完、review 照常发。这期间往这一家下面填模型标识会被拒收并说明原因——填进去也选不到。

  两条要知道的:**改完名字不用重启、也不用点别的**,冲突不存进库里,每次读模型目录现算一遍,改好下一次就正常了;Pi 哪天又把那个内置名字撤掉,同样自己恢复。**升级 Pi 之后重启就已经生效**,不必先去开一次面板。
- 2026-08-18: 落地 issue #91,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的界面收尾。**仓库那一处「自定义模型组合」也是那块两栏面板了。**点仓库详情里的「自定义」不再弹小窗:详情里模型组合那一格当场变成编辑态,上面是已选的模型,下面就是全局设置页上那两栏——左边厂商列(内置的与你自己加的排在一起,列底部「+ 加一家 provider」),右边是选中那家的模型与那一行手填 model id。两处能做的事一模一样,在仓库这一处加一家自定义 provider、手填一个模型标识,与在全局设置页做是同一件事:动的是同一份模型目录,全局设置页那边立刻也看得见。

  几条要知道的:**那两颗按钮一个字没变**——点「自定义」从当前生效的那一组改起(还在跟随全局时就是全局那一组),点「跟随全局」仍是一个动作、直接清掉这个仓库的覆盖。**一个模型都不选存不了**(保存按钮是灰的),要回到跟随全局就点「取消」再点「跟随全局」。**改的只是这一个仓库**,保存之后它的下一次投递按这一组跑,别的仓库不受影响。**编辑态是页内的一段、不是弹层**:面板比原来那个小窗高得多,做成弹层会在矮屏上把底下的手填框与保存按钮顶到看不见的地方。顺带修掉一处:原来那个小窗整个是一张表单,**在里面敲回车会当场把覆盖提交掉**,现在编辑态里没有这张表单,填 model id 只是填 model id。
- 2026-08-19: 上面七票在部署实例上走了一遍三条入口(厂商目录实测 openrouter 从 348 涨到 418、总数 1295;手填一行、加一家自定义 provider、撞名拒收、重启后两者都还在),查出并修掉两处只有真实数据才会露头的缺陷。一、**OpenRouter 给路由类模型的单价是字符串 `-1`**(`openrouter/auto` 等四行),意思是随路由到的那个模型浮动,不是一个费率;照每百万 token 换算就成了 `-1000000`,面板上写作 `$-1000000/M`,而这几个模型的 Review Run 成本会算成负数、把累计花费往下拽。负单价现在按「没有单价」收 0,与 Pi 内置那条 `auto` 记的数一致。二、**中文提示里夹进了多余空格**(「连 字符」「才 知道」「不带 单价」等六处):JSX 把相邻两行的文本用一个空格拼起来,英文正好需要那个空格、中文不需要,这类句子因此改成一行、不在词中间断行。另有一条只提不改——`web/src/runs.tsx` 第 355 行同样的空格是这批改动之前就有的。
- 2026-08-19: 修 [openrouter/auto 这类路由模型的 Review Run 成本会是负数](https://github.com/kassol/MultiReviewer/issues/95),上一条留下的那一半收口。面板上那个负单价已经不显示了,而 Review Run 的成本走的是另一条路——它取自 Pi 的 `session.getSessionStats()`、用的是 Pi 内部那张定价表,不经过模型目录,因此选中那两个模型跑一轮时落库的成本仍是负数,会把评审记录页与处置率页上的累计花费往下拽。现在负成本一律按零落库,而且是**逐条截负再加**:先加会让负的那一份把同一轮里正常那几个模型的花费一起吃掉。取零与「单价留空」那一档记的数一致,面板上因此不多一种状态——两处都是「这一笔没记准」。Pi 那两行数据本身仍是错的,真要根治得等上游改。
- 2026-08-19: 落地 [面板门禁换成用户账号与自定义角色 RBAC](https://github.com/kassol/MultiReviewer/issues/109),部署收口见 issue #117。共享的 `MULTIREVIEWER_ADMIN_TOKEN` 退场,面板改为本地用户账号、落库会话与自定义角色:8 个权限格管功能面,用户与角色只由系统管理员管理,手动重跑记调用者。零用户启动时日志打印一枚内存中的 bootstrap 口令,第一个注册的人成为系统管理员后口令与注册入口一起失效;重启只会换还没用掉的 bootstrap,**不会清掉已落库会话**。六阶段部署向导的第四阶段改成「面板密钥与基地址」,自检改问 `GET /session` 的零用户状态并抽取口令;已有账号是正常续跑,旧 admin token 检出即在备份后清掉。交付清单要求先注册首位管理员,再创建角色、给同事建号并授角色。
- 2026-08-19: wayfinder 地图[重新设计模型服务与模型组合的完整链路](https://github.com/kassol/MultiReviewer/issues/119)定下[模型补录只有 model id 时怎样生成运行时模型](https://github.com/kassol/MultiReviewer/issues/127)。新增领域词「运行基线」:可信模型信息按字段优先,缺失项由 MultiReviewer 显式补成仅文本、不声明推理能力、上下文窗口 128k、最大输出 16k、费用未知。目录事实继续显示「未提供」,运行详情单列实际运行值及来源;未知费用保留 token 用量、金额记未知,汇总标明不完整,未来取得价格也不回算历史 Run。
- 2026-08-19: wayfinder 地图[重新设计模型服务与模型组合的完整链路](https://github.com/kassol/MultiReviewer/issues/119)定下[模型服务地址、协议与凭据怎样原子切换](https://github.com/kassol/MultiReviewer/issues/128)。候选配置只在页面内存,经无状态目录预览、最终重新发现与 Pi 真实推理后才按配置版本原子提交;失败不创建空壳也不动当前配置。修改自定义服务地址或协议必须重输凭据,创建与修改同时要求 `model:write` 和 `credential:write`;Pi 内置 provider 的地址与协议只读。目录快照随完整模型服务版本切换,Review Run 固定使用启动时版本。模型补录绑定 base URL 与接口协议:凭据轮换沿用,地址或协议变化时默认不带入,操作员须逐项明确重新补录;仍被组合引用且新目录未发现、候选也未重录的模型会阻止切换。`CONTEXT.md` 新增「候选配置」「模型服务版本」并收紧「模型补录」。
- 2026-08-19: wayfinder 地图[重新设计模型服务与模型组合的完整链路](https://github.com/kassol/MultiReviewer/issues/119)定下[现有 provider、模型补录与组合怎样迁移](https://github.com/kassol/MultiReviewer/issues/122)。迁移前用 SQLite backup API 留一份不覆盖的备份,再以单事务迁新表、校验组合、切 schema 并删旧表;旧 API 与两份目录派生文件同版切除。自定义 provider 原样形成版本 1;旧凭据按既有验证与自定义服务成功 Run 的证据分成已验证、迁移待重新验证、未配置。旧 `model_row` 只有在自定义 provider 目标可证明时迁成手动补录,内置／未知 provider 行与组合缺失来源统一迁成「迁移保留」,每个模型标识只留一份来源;旧价格和上下文窗口丢弃。组合与仓库覆盖原样迁移,坏 JSON 阻止整次迁移。
- 2026-08-20: 落地 issue #141 的模型服务 clean cutover。启动在创建 HTTP 服务前识别 schema-v0,先留唯一 SQLite 备份,再以单事务迁入模型服务表、保留组合与历史 Review Run、删除旧模型表;迁移提交后删除旧 `models.json` / `models-store.json`,成功监听才输出并确认一次性摘要,失败启动保留待重试标记。旧 `/catalog`、`/credentials`、`/model-rows`、`/custom-providers` API、Store 方法与共享当前模型配置全部删除;面板与 Review Run 只读模型服务版本和目录快照。
- 2026-08-20: 完成模型服务与审查策略统一改造的 grilling，见 ADR 0010。模型服务配置与模型选择继续分页面并串成首次配置路径；全局模型组合首次配置后改为非空，审查配置就绪后才允许注册仓库；模型组合与分批上限采用独立版本；模型服务详情改为概览 / 维护 / 模型三页签。`CONTEXT.md` 新增模型发现、全局模型组合、审查策略、审查配置就绪与实例启用，并收紧权限格和自定义 provider 的语义。
- 2026-08-20: 落地 issue #144。服务端与 session 统一使用有效权限:三类 write 包含对应 read,`review:rerun` 独立。角色矩阵明确显示包含关系;只有 read 的用户进入仓库、评审记录、模型服务与审查策略时只看到静态内容,页面不渲染写控件。
- 2026-08-20: 落地 issue #145。`/settings` 保留为审查策略入口;全局模型组合与批次上限各自携带版本并独立保存,陈旧写返回 409。新模型组合必须非空且当前可用,历史空值继续可读;批次上限区分系统默认与自定义并可显式恢复默认。面板冲突恢复只覆盖发生冲突的一项。
- 2026-08-20: 落地 issue #146。模型服务详情已有概览、维护、模型三条稳定地址;服务端统一给运行能力与组合引用位置,目录失败退为次级提醒。无凭据、无模型来源、无组合引用的内置 provider 只留在添加搜索入口。首次配置串联与三步配置随后由 issue #147、#148、#150 完成。
- 2026-08-20: 落地 issue #147。模型服务只留一个添加入口;内置 provider 配置拆为来源、模型发现、真实推理三条稳定地址,候选与凭据只留页面内存。未保存离开有应用确认与浏览器关闭警告,长操作显示阶段并锁导航;最终提交重新发现、真实推理并按版本原子生效。创建成功进入审查策略并定位 provider,不改全局模型组合;失败响应只含安全摘要和 request id。
- 2026-08-20: 落地 issue #150。认证后的业务页增加首次配置检查单,按可运行模型服务、审查配置就绪、实例启用三步推进;入口遵循有效权限。仓库注册新增服务端前置门禁,未就绪时不访问 Gitea、不生成 Key、不落库;历史仓库的空组合投递仍留下失败 Review Run。
- 2026-08-20: 落地 issue #148。自定义 provider 创建与既有模型服务修改复用三步稳定配置页。自定义预览不要求 validation model;发现失败或目录缺项后可手填 model id,最终重新发现并真实推理,成功后作为模型补录随完整版本原子提交。创建成功进入审查策略并定位 provider,修改成功回服务概览;#149 原子改名、#150 检查单和 #144 权限边界保持不变。
- 2026-08-20: 完成 issue #151 的部署实例验收。既有模型服务完成真实发现与最小推理,失败候选保留 request id 且未创建服务。审查策略独立保存、陈旧写恢复、非空组合、权限包含关系、重复渲染及桌面/窄屏均已走查;需要破坏当前配置才能构造的未就绪注册与冲突改名回滚继续由真实 HTTP 和临时 SQLite 自动化测试覆盖。
- 2026-08-24: 模型服务配置流程改为弹窗承载三步路由；模型凭据验证模型避免逐字符断行；模型目录增加持久化启用状态与批量管理，停用模型不再进入审查策略可选项，引用中的模型停用会被阻止。
- 2026-08-25: 落地 issue #182。运行镜像补装 ripgrep 与 fd-find,Reviewer 的 `grep` / `find` 不再触发 Pi 的联网下载。Debian 的 fd 二进制名是 `fdfind`,Pi 的工具查找按 `["fd", "fdfind"]` 依次探测系统 PATH,命中即用,因此不做 `fd` 软链。bookworm 给到 ripgrep 13.0.0 与 fd 8.6.0;fd 8.6.0 没有 `--no-require-git`,Pi 只在搜索路径不在 git 仓库内时才带这个参数,而 Reviewer 的工作目录就是工作副本,实际路径上不会出现。
- 2026-08-28: 落地 issue #203(父 issue #200,ADR 0019)。**规则集从只读变成人能改:权限矩阵多一格 `rule:write`,有格的人手工新增、修改与废止规则**。每次变更推进一个规则集版本,面板弹窗上的版本号跟着走;修改落成「旧行废止于新版本 + 新内容生效于新版本」,历史版本的快照因此仍取到当时那一组,Review Run 冻结版本的语义不破。废止的规则不再进规则集,但在弹窗末尾的「已废止」一段里仍查得到。新增的权限格不落到已有角色上,也不隐含任何读权限:读规则集照旧只要登录加仓库分配。手工写下的规则记人工出处,基点探索与处置反哺那两条写入链路是后续票。Review Run、Reviewer 注入与 Finding 形态一行未动。
- 2026-08-28: 落地 issue #204(父 issue #200,ADR 0019)。**规则集从此真正影响评审**:Review Run 一开跑就冻结该仓库当前的规则集版本并记在这一轮上,全程用它——运行中有人改规则也不影响已经开跑的这一轮,回看历史轮次时知道当时按的是哪一版。每个批次只注入作用范围命中该批文件的规则,加上全仓库规则;Reviewer 的 prompt 多一段,说明这些是这个仓库既定的评审标准、优先按规则判,规则没覆盖到的照常自行判断。模型报 Finding 时可以自报命中了哪条规则,服务端拿本轮注入过的那组标识校验,对不上就置空,条目本身照收;命中规则落库但本期不展示,也不影响 Finding 的合并与去重。**空规则集的行为与升级前一字不差**:不渲染规则段,报 Finding 的工具形状也不变。作用范围的 glob 语义自定并从简(`*` 不跨目录,`**` 跨任意层),不新增第三方依赖。规则怎么来(基点探索)、怎么改(修订提案与裁决)仍是后续票。细节见 `src/AGENTS.md`。
- 2026-08-28: 落地 issue #205(父 issue #200,ADR 0019)。**规则集从此有了来路:对规则集为空的仓库发起基点探索,agent 从一个基点 commit 推导规则草案,人逐条改定后整组确认生效**。发起时选基点 commit(与发起范围审查同一个选择器,默认预填默认分支的 HEAD)与所用模型(从当前可用模型里选,可用性判据与全局模型组合同一份);探索在后台跑,状态是运行中 / 失败(原因可见、可重新发起)/ 完成,同一个仓库同时只跑一个,进程重启会把停在运行中的那次改判失败。产出按重要性截断为至多 30 条,只收规范性陈述——上限的本质是人一次确认得完、不麻木。草案每个仓库至多一份,重新探索覆盖未确认的旧草案;人可以逐条修改、删除,也可以手写新增。规则确认把草案整组变成生效规则并生成该仓库的下一个规则集版本,探索出来的记基点探索出处、手写的记人工出处,草案随即清空。**当前规则集为空是草案与修订提案的分界**:规则集已经非空的仓库当时发起探索回 409(**issue #207 已经改掉这一半**:现在照样发起得了,产出排进修订提案队列逐条裁决,见那一条)。发起、草案增删改与规则确认都由 `rule:write` 拦下,读侧照旧只要登录加仓库分配。规则 agent 是一道与 Reviewer 同构的注入边界,基点探索与日后的处置反哺共用它;真实实现走同一套 Pi 只读子进程,凭据只进那一个进程的环境。Review Run、Reviewer 注入与 Finding 形态一行未动。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-29: 落地 issue #206(父 issue #200,ADR 0019)。**新注册的仓库在完成规则确认之前不执行 Review Run**:注册不再自动落一个「已确认空规则集」,收到的 pull request 投递照常验签受理、只记录不审,面板上的手动重跑与发起范围审查回 409 并说明差什么;人在规则集弹窗里做完基点探索与规则确认,下一次投递与下一次发起即放行,不需要重启服务。存量仓库不受影响:升级那一次仍把已注册的仓库全部写成已确认空规则集,评审行为零变化——迁移改成只在建表那一次跑,否则它会把新注册、还没确认的仓库一并补成已确认。面板上的可见性从简:规则集弹窗在没有版本时把「规则集版本 N」换成一句「规则集未确认」,下面紧接着就是探索与确认那一段;注册成功的提示改成引导去做规则确认。
- 2026-08-29: 落地 issue #207(父 issue #200,ADR 0019)。**规则集确认之后仍改得动:再次基点探索的产出以修订提案排队,人逐条裁决**。修订提案是独立实体:变更类型(新增 / 修改 / 废止)、修改与废止指向的目标规则、提案内容、出处(基点探索 / 处置反哺,反哺那一档由 issue #208 产生,字面量先定好)与出处附注(反哺时放触发它的处置备注),状态机是待裁决 / 已采纳 / 已驳回,裁决过的留在队列里供查。规则集非空的仓库现在发起得了探索(#205 的那道 409 撤掉),agent 拿到当前生效规则集,提的是对照它的变更而不是重列全部;服务端按目标规则认得出认不出映射成三种变更类型——认得出的按有没有废止标记成为废止或修改,认不出的成为新增,带废止标记却认不出目标的丢掉。**规则草案一行不动**:分界判在探索结束那一刻,规则集为空才走草案。裁决逐条做:采纳前内容可改(改后的那一份既进规则集也覆盖队列里的记录),采纳按变更类型落库并生成新的规则集版本(与手工增删改同一套版本推进语义:修改是旧行废止于新版加新内容生效于新版,废止只让目标停止生效,新增记提案自己的出处),驳回只改状态、一版都不推进;目标规则已经被人废止掉时那条提案采纳不了。裁决由 `rule:write` 拦下,队列本身随规则集读端点一起给,读侧照旧只要登录加仓库分配。面板在规则集弹窗里多一段修订提案:待裁决的逐条显示变更类型、出处、目标规则与作用范围,有 `rule:write` 时可以修改、采纳、驳回,已裁决的收在一个可展开的小节里。Review Run、Reviewer 注入与 Finding 形态一行未动。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。

- 2026-08-29: 落地 issue #208(父 issue #200,ADR 0019),**父 issue #200 至此收口**。**写了处置备注的处置由 agent 解读为修订提案,没有备注的处置零触发**。人在面板上处置一条 Finding 并附一句处置备注,备注落库之后立刻在后台排一次解读:agent 拿到这条备注、被处置的那条 Finding(文件、行、标题、描述)与该仓库当前生效的规则集,给出 0..n 条对照现集的变更建议,经与基点探索同一套映射排进修订提案队列,出处标处置反哺、附注是备注原文。**产出为空是合法结果**,一条提案都不留;agent 在这条链路上同样不直接改规则集,人裁决采纳才落。所用模型沿用该仓库最近一次基点探索的那个,从未探索过就取全局模型组合的第一个,两者都没有即跳过并留原因。解读失败只留一行日志、不自动重试(人下一次写备注本来就会再排一次),整件事与处置写入解耦:解读失败不影响处置本身,处置的响应也不等它。没有备注的 resolve 语义含混,不触发任何解读(ADR 0019 的取舍);Forge 上点的 resolve 没有备注,也就不进这条链路。面板没有新增界面:反哺的运行状态不展示,提案出现在规则集弹窗的修订提案队列里即是可见性。Review Run、Reviewer 注入与 Finding 形态一行未动。细节见 `src/AGENTS.md`。
