# AGENTS.md

## 项目概述

MultiReviewer:基于真实 Coding Agent 的多模型并行 PR 智能审查工具。审查挂载在 pull request 上,结果以行级 review 评论呈现。目标部署平台是公司内部 self-host 的 Gitea,开发阶段以 GitHub 为测试平台,两者通过 forge adapter 兼容。

领域术语见 `CONTEXT.md`,已定架构决策见 `docs/adr/`。`docs/idea.md` 是初始草案,其中的 GitHub SaaS 定位、交叉验证 P0、自建 Web 界面等设定已被后续 ADR 推翻,仅作历史参考。

## 技术栈

TypeScript / Node 24,源码由 Node 原生运行,无构建步骤。测试用内置的 `node:test`。Reviewer 的 agent harness 采用 Pi(`@earendil-works/pi-coding-agent`,MIT),见 ADR 0004,它是唯一的运行时第三方依赖。持久化用 SQLite。包管理用 pnpm。

## 目录索引

- `CONTEXT.md` — 领域术语表,代码与沟通的统一语言以此为准。
- `src/` — 编排服务源码,结构约定见 `src/AGENTS.md`。进程入口是 `src/main.ts`。
- `web/` — 管理面板前端(Vite + TanStack Router/Query),结构约定见 `web/AGENTS.md`。产物在 Docker 多阶段构建里生成,不进版本库。
- `test/` — 测试,打在三条缝上(HTTP 端点 / 假 Gitea / SQLite 临时库)。`test/support/` 是内存 Forge、脚本化 Reviewer、git fixture、假 Gitea 与面板 harness。
- `Dockerfile` / `.dockerignore` — 运行镜像。`node:24-slim` 加 git,依赖在镜像内重装(宿主机的 `node_modules` 含平台专属产物,不进镜像)。
- `docker-compose.yml` — 服务器上的编排定义。与 `.env` 两个文件即可运行,不需要源码。
- `scripts/build-push.sh` — 在开发机构建镜像并推到 registry,默认目标架构 `linux/amd64`。
- `scripts/setup.sh` — 部署向导。在服务器上执行,逐步问出凭据、写 `.env`、拉镜像起容器、以「面板能登录」为验收自检;仓库接入、模型凭据与模型组合在面板上做,不在向导里。
- `docs/adr/` — 架构决策记录。
- `docs/idea.md` — 初始产品与架构草案,部分设定已被 ADR 推翻。
- `docs/agents/` — Agent skills 的仓库级配置:issue tracker、triage 标签、domain docs 消费规则。
- `docs/research/` — 一手来源调研笔记,每条结论标出处。

## 常用命令

- `pnpm start` — 起 webhook 服务,环境变量见「部署」
- `pnpm --filter @multireviewer/web dev` — 面板前端本地联调:与 `pnpm start` 双进程,前缀读同一份 `.env` 的 `MULTIREVIEWER_PANEL_PREFIX`,Vite proxy 把 `<前缀>/api` 转本机后端
- `pnpm --filter @multireviewer/web build` — 前端构建(镜像里自动做,本地跑服务要面板时手动跑一次)
- `pnpm check` — 类型检查加全部测试,提交前跑它(不含前端类型检查,改 `web/` 后另跑 `pnpm --filter @multireviewer/web typecheck`)
- `pnpm typecheck` — 仅类型检查
- `pnpm test` — 仅测试
- `MULTIREVIEWER_LIVE_PR=owner/repo#123 GITHUB_TOKEN=$(gh auth token) pnpm test` — 追加运行对真实 GitHub pull request 的验证,它会真实发布评论并改动 resolve 状态
- `MULTIREVIEWER_GITEA_URL=https://gitea.example.com MULTIREVIEWER_GITEA_TOKEN=<bot 的 PAT> MULTIREVIEWER_GITEA_LIVE_PR=owner/repo#123 pnpm test` — 追加运行对真实 Gitea pull request 的验证,同样会真实发布评论并改动 resolve 状态。它覆盖本实现用到的全部端点,因此跑通即证明这枚 PAT 的 scope 够用
- `MULTIREVIEWER_SMOKE_PROVIDER=deepseek MULTIREVIEWER_SMOKE_MODEL=deepseek-v4-flash MULTIREVIEWER_SMOKE_ENV=DEEPSEEK_API_KEY pnpm test` — 追加运行 `report_finding` 与真实模型之间的契约验证,它会真实调用模型并产生费用

## 部署

部署形态是 Docker。镜像在开发机构建后推到 registry,服务器只拉镜像。服务器上放三个文件在同一目录即可,不需要源码:`docker-compose.yml`、`setup.sh`、以及向导生成的 `.env`。模型组合与批次上限在库里,由面板管,没有配置文件。

```
# 开发机:构建并推送。开发机 arm64、服务器 amd64 时必须交叉构建,脚本已默认 linux/amd64
scripts/build-push.sh registry.example.com/team/multireviewer:latest

# 服务器:首次部署跑向导,六步问出凭据、拉镜像、起容器、真登录一次面板自检
bash setup.sh

# 服务器:后续更新
docker compose pull && docker compose up -d
```

向导的边界收在「面板能登录」:生成 admin token、面板前缀与凭据主密钥、问基地址、起服务后打登录页并真登录一次(token 写坏时自检失败,不静默交付),收尾给交付清单。仓库接入、模型凭据、模型组合与覆盖都在面板上做,向导不问模型凭据也不问模型标识,不生成全局 webhook secret,也不指导手工配 hook;检出已废除的变量(`MULTIREVIEWER_WEBHOOK_SECRET` / `MULTIREVIEWER_PUBLIC_URL` / `MULTIREVIEWER_GITEA_REPO` / `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `MULTIREVIEWER_DEEPSEEK_MODEL` / `MULTIREVIEWER_OPENROUTER_MODEL`)会清掉并说明原因。清理之前先把 `.env` 复制成 `.env.bak-<YYYYMMDD>`,同一天重跑不覆盖已有副本——被清掉的两把厂商 key 只在这份副本里,厂商后台不会再给第二次明文。

两处容易踩的地方:

- **`MULTIREVIEWER_PORT` 与 `MULTIREVIEWER_HOST_PORT` 是两个东西。**容器内固定监听 3000(`MULTIREVIEWER_PORT` 在镜像里就设死了),对外映射用 `MULTIREVIEWER_HOST_PORT`。把宿主端口写进 `MULTIREVIEWER_PORT` 会让应用改去监听那个号,端口映射当场对不上。
- **容器以宿主机上那个部署用户的身份运行**,由 `.env` 里的 `MULTIREVIEWER_UID` / `MULTIREVIEWER_GID` 指定(向导取 `id -u` / `id -g` 自动写入)。`./data` 因此天然可写,不需要 chown。部署目录放在 home 下时尤其要保持这样:把目录改成别的属主会让本人写不进自己的 home。镜像默认用户是 uid 1000 的 `node`,compose 的 `user:` 覆盖它。

不用容器直接跑时 `pnpm start` 起同一个服务,启动时用 `--env-file-if-exists=.env` 读取同目录的 `.env`。

webhook 指向 `POST /webhook?k=<代次>` 这一个端点(路径固定,其余路径与方法一律 404),content type 选 JSON,secret 填该仓库的 Key。投递凭所属仓库的 Key 准入:仓库要先进注册表,未注册一律 401,没有全局 secret。hook 的建立与 Key 的管理由面板完成:注册(`POST /<前缀>/api/repos`)自动在 Gitea 建 hook 并落 Key,移除自动删 hook。GitHub 仓库没有注册途径。

必需的环境变量:

- `MULTIREVIEWER_ADMIN_TOKEN` — 面板登录的 admin token
- `MULTIREVIEWER_PANEL_PREFIX` — 面板路径的随机首段,只能由字母、数字、`-` 与 `_` 组成,且不能是 `webhook` 或 `assets`
- `MULTIREVIEWER_BASE_URL` — 服务对外的基地址(实例根,不含路径)。明文 http 且非 localhost 时拒绝启动:Secure cookie 发不出去,面板会打得开却登不进。它取代向导旧变量 `MULTIREVIEWER_PUBLIC_URL`——旧值含 `/webhook` 后缀,同名不同义会静默出错,故换名弃用

Forge 凭据至少要配齐一组,一组都没有时启动失败——服务起得来却一次审查都跑不了比起不来更难发现:

- Gitea:`MULTIREVIEWER_GITEA_URL`(实例根地址,例如 `https://gitea.example.com`)加 `MULTIREVIEWER_GITEA_TOKEN`(bot 账号的 PAT)
- GitHub:`MULTIREVIEWER_GITHUB_APP_ID` 加 `MULTIREVIEWER_GITHUB_PRIVATE_KEY_PATH`(生产,ADR 0005),或 `GITHUB_TOKEN`(开发)

只配其中一组即可。没配那一格的平台投递进来只被记录、不跑审查,响应仍是 200。

可选的环境变量:

- `MULTIREVIEWER_PORT` — 监听端口,默认 3000。镜像里已设为 3000,走容器时不要再改
- `MULTIREVIEWER_PANEL_DIST` — 前端构建产物目录,默认 `web/dist`。镜像里是 `/app/web/dist`。产物不在时面板页面回 503(与 404 的「前缀记错」分开)
- `MULTIREVIEWER_DB` — SQLite 文件位置,默认 `multireviewer.db`。镜像里是 `/data/multireviewer.db`
- `MULTIREVIEWER_CACHE_DIR` — 工作副本缓存根目录,默认 `.cache/worktrees`。镜像里是 `/data/worktrees`。它下面的 `pi-models/` 里还放着面板与 Reviewer 子进程共用的两份 Pi 模型文件:`models-store.json` 是远程目录的落盘,`models.json` 是由库里的模型行派生出的用户模型配置。两份都由服务写、子进程只读(不联网):面板选得出的模型靠它们才在子进程里取得到。这个目录因此对服务进程必须可读可写,换掉或清空它只影响下一次读目录,不丢数据——两份都是可以从库与 pi.dev 重建的派生物。**填相对路径也能用**(服务在父进程里把它解析成绝对路径再传给子进程),不过部署时建议直接写绝对路径,省得跟着工作目录变
- `PI_OFFLINE` — Pi 自己的离线开关,设成任意值(例如 `1`)即关掉全部启动期网络动作,其中包括模型选择器的远程目录。开着时服务第一次读目录会向 `pi.dev` 拉一次每家 provider 的增量(实测模型数从 1153 涨到 1225),10 秒拿不到就降级到 Pi 内置的那一份,目录端点用 `remote` 字段说明这一层的状态(`ok` / `unavailable` / `off`)。内网无出口或离线部署设上它:请求一个都不发,选择器只列内置模型
- `MULTIREVIEWER_CREDENTIAL_MASTER_KEY` — 模型凭据的加密主密钥(ADR 0008),面板凭据页用它加解密。**向导会自动生成一枚并写进 `.env`**(已有值时沿用,`FORCE=1` 也不重新生成),手工部署时取一串随机材料即可,例如 `openssl rand -hex 32`。没设时服务照常启动,只有凭据页整体不可用并说明差什么——起不来就进不了面板。换掉它等于把已存的凭据作废,面板显示未配置,重新粘一次 key 即可

只有 `docker-compose.yml` 读、应用不读的:

- `MULTIREVIEWER_IMAGE` — 镜像引用,必填
- `MULTIREVIEWER_HOST_PORT` — 对外映射的宿主机端口,默认 3000
- `MULTIREVIEWER_UID` / `MULTIREVIEWER_GID` — 容器以哪个 uid/gid 运行,默认 1000

部署目录放哪里都行,向导与 compose 的路径全部相对自身位置解析。`~/share/workspace` 与 `/srv/multireviewer` 一样能用。

向导可以中断后重跑:已经写进 `.env` 的值会被认出来,对应阶段直接跳过,只补没做完的部分。`FORCE=1 bash setup.sh` 强制每个阶段都重做。

### 面板门禁的运维

- **轮换 admin token = 改 `.env` 的 `MULTIREVIEWER_ADMIN_TOKEN` + 重启容器。**会话表在内存里,不落库,所以重启即清空全部会话:轮换天然带踢会话,已登录的浏览器下一次请求就回 401。怀疑会话 cookie 泄露时正解也是轮换 token,没有单独作废某一个会话的手段(面板上的登出只作废自己那一个)。
- **HTTPS 是门禁的前提,不是可选项。**会话 cookie 带 `Secure`,明文 HTTP 下浏览器根本不发它;`MULTIREVIEWER_BASE_URL` 是明文 http 且非 localhost 时服务直接拒绝启动(localhost 放行,浏览器把它当安全上下文)。本服务自己不终止 TLS,证书与 https 由外部反代负责,归部署方。
- **面板前缀不是安全边界。**未认证的 API 请求一律 401,端点存在与否都一样,前缀只是路由匹配的第一段。它挡的是「面板地址被爬到」,挡不住知道地址的人;真正的门禁是 admin token 与会话 cookie。前缀轮换只会让旧的 `Path` 限定 cookie 失配,不构成额外保护。

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
- forge adapter 的接口只包含 Gitea 与 GitHub 都具备的能力,以 Gitea 为基准
- Gitea 最低支持社区版 1.26.0 / 企业版 26.0.0(review comment 的 resolve / unresolve 端点自该版本提供)
- 调用 Gitea API 一律携带凭据,目标实例要求登录后才能调用
- 测试只验证外部可观察的行为,打在三条缝上(issue #26 的测试决策):HTTP 端点(起真服务打 HTTP,注入假 Forge、临时库路径与时钟)、`runReview` 入口(经 `Forge` 与 `Reviewer` 两个注入边界)、SQLite 临时库;git 与 SQLite 用真实实现,落在临时目录
- 需要真实凭据或真实平台的测试默认跳过,由环境变量显式开启
- **交付前的验证一律在部署实例上做,不在开发机起服务。**自动化测试照旧在本机跑(那是缝上的断言,与实例无关),但「改完之后人去确认它真的能用」这一步走部署实例:面板操作、webhook 投递、真实 Review Run 都在那里验。本机 dev 双进程验不出这类东西——它没有真 Gitea、没有已注册的仓库、没有模型凭据,补齐这些的成本比推一次镜像高,而验完的结论还不能代表实例。开发机因此不留 `.env` 里的面板变量(admin token / 面板前缀 / 基地址 / 凭据主密钥);要在本机起面板时临时补,验完删掉

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
- 2026-08-15: 落地 issue #29。面板认证 API 与启动校验:`POST <前缀>/api/session` 验 admin token 换 HttpOnly + Secure、`Path` 限前缀的 session cookie,登录失败按 IP 退避与锁定;其余 API 未认证一律 401,认证后未知端点回 JSON 404,页面 404 与前缀猜错不可区分。启动新增三个必需环境变量 `MULTIREVIEWER_ADMIN_TOKEN` / `MULTIREVIEWER_PANEL_PREFIX` / `MULTIREVIEWER_BASE_URL`,基地址是明文 http 且非 localhost 时拒绝启动。已有部署升级到本版须在 `.env` 补这三项,向导对它们的支持归 issue #38。
- 2026-08-15: 落地 issue #30。Gitea 专属 hook 管理模块 `src/forge/gitea-hooks.ts`:列 / 建 / 删仓库 hook(窄订阅事件集、`active` 显式置真、删除遇 404 视为成功、按 `config.url` 幂等收敛)与 bot 权限查询(非 admin 拒绝并明说缺什么)。不进 `Forge` 接口,契约依据是 `docs/research/gitea-webhook-api.md`。
- 2026-08-15: 落地 issue #31。仓库注册与移除全流程走面板 API:注册验 bot admin 权限、自动建 hook(URL 带 `?k=` 代次)、落注册表与 Key,可带模型覆盖(全量替换 reviewers,默认跟随全局,注册后下一次投递生效);移除先删 hook、删不掉不放行,评审记录保留。仓库列表带累计量、按最近活动排序。「直接写库种入」的过渡状态就此结束。
- 2026-08-15: 落地 issue #32。Key 轮转与核对(ADR 0007):轮转是可重入的单调推进,先建后删、轮转中投递不中断、失败再点一次从断点继续、库回滚后一次轮转自愈;核对拉 Gitea 的 hook 列表与库比对,只展示差异与下一步动作,不自动修。
- 2026-08-15: 落地 issue #33。管理面板前端从零起(`web/`,Vite + React + TanStack Router/Query):登录一屏加三页顶部导航的空壳。服务端补齐路由表的页面两格(前缀下返回注入前缀全局变量的 index.html、`/assets` 服务构建产物),Docker 改多阶段构建,dist 不进版本库也不含前缀。dev 双进程联调:Vite 插件注入同名变量、proxy 转 `<前缀>/api`,前缀读同一份 `.env`。生产镜像、dev 双进程与真实浏览器(登录、三页导航、深层路由刷新)均已实测。
- 2026-08-15: 落地 issue #34。仓库页 master-detail(原型变体 A):注册模态、移除二次确认(删 hook、评审记录保留)、轮转按钮、打开仓库即核对并可一键推平差异、模型组合可编辑(新端点 `PUT /repos/<id>/reviewers`),key 任何界面不回显。真实浏览器走通注册 → 轮转 → 手删 hook 后推平 → 改组合 → 移除全流程。
- 2026-08-15: 落地 issue #35。处置率的回填链路(ADR 0006)打通:每轮 Review Run 顺手把读回的 resolve 状态覆盖到历史 finding,PR closed 投递触发全量回填并落 PR 状态;`finding` 记来源类型(行级评论 / 正文),正文行排除在统计外。两个时机都不新增 API 调用。
- 2026-08-16: 落地 issue #36。处置率统计与页面:`store.ts` 的 `dispositionStats` 按 Finding Identity 折叠出模型 × 分类矩阵,`GET <前缀>/api/stats` 打包矩阵与库体量(库文件字节数 + 全部表行数),前端处置率页按原型变体 B 落地(模型卡片 + 矩阵,每格永远带分子分母)。口径细则见 `src/AGENTS.md`,页面见 `web/AGENTS.md`。
- 2026-08-16: 落地 issue #37。评审记录页与手动重跑:跨仓库 Review Run 时间流(按天分组、滚动加载更早、覆盖已移除仓库的历史、顶部统计带与处置率页同源),重跑两个入口(时间流逐条、仓库页输 PR 号)共用 `POST <前缀>/api/rerun`,开的是新一轮 Review Run、走既有跨轮次折叠。服务端见 `src/AGENTS.md`,页面见 `web/AGENTS.md`。
- 2026-08-16: 落地 issue #38。部署向导边界收在「面板能登录」:阶段 7 生成 admin token 与随机面板前缀(重跑先确认再重新生成,FORCE 也绕不过确认)、问基地址存 `MULTIREVIEWER_BASE_URL`(先校验再落盘,明文 http 的放行判定与服务端逐 host 对齐);检出旧变量(`MULTIREVIEWER_WEBHOOK_SECRET` / `MULTIREVIEWER_PUBLIC_URL` / `MULTIREVIEWER_GITEA_REPO`)即清掉并说明、指导删旧 hook;自检改为打登录页期待 200 加用刚写的 token 真登录一次期待 204 + Set-Cookie(token 写坏当场失败,429 单独解释退避);旧的「注册 webhook」「第一次真实审查」两个阶段删除,收尾改交付清单(面板地址、token、下一步、服务器侧排障速查)。评审复核顺手修正 bot PAT scope 表述(write:repository 与 write:issue 两项)与 Gitea 版本解析的 sanity 校验。
- 2026-08-16: 修 issue #39。Gitea 适配层三处 PR 列表翻页的终止条件从「不满一页」改为「读到空页」,实例把 limit 钳到 `API.MAX_RESPONSE_ITEMS` 时不再提前停、Review Range 不再静默缺文件。细节见 `src/AGENTS.md`。
- 2026-08-16: 落地 issue #40。重写 README:移除「Early design phase」与 Out of Scope 的交叉验证宣传,最低版本要求(社区版 1.26.0 / 企业版 26.0.0)置于 Requirements 首句,GitHub 表述改为「适配层存在、准入仅 Gitea」,部署与文档细节指向 AGENTS.md 与 CONTEXT.md。
- 2026-08-16: 落地 issue #73。模型标识统一成 `provider:model`(`CONTEXT.md` 早已如此定义,词条未动):落库的 Finding 与 Reviewer 结果、面板展示、处置率统计归属全部用完整标识,模型组合的去重键随之改成完整标识——同一个 model id 在两家 provider 下是两个 Reviewer,可共存。历史行在服务启动时一次性回填,幂等;provider 在库里没有记录,判据取「按裸 model id 在当前模型组合与各仓库覆盖里反查得到唯一 provider」,反查不到就不动那一行(留下的旧形态行在统计里各成一条,不会被错误归并)。内容指纹与评论锚点都不含模型标识,历史评论的跨轮次匹配不受影响。
- 2026-08-16: 落地 issue #64。模型凭据加密进库、由面板写入(ADR 0008):按 provider 一把,同一家下的多个模型共用;保存时真发一次最小请求验证厂商 key,不通过不落库并回报原因;只写不回显,列表只给 provider、是否已配、更新时间与尾 4 位;同 provider 二次写入是覆盖。主密钥是新的可选环境变量 `MULTIREVIEWER_CREDENTIAL_MASTER_KEY`,没设时凭据端点读写都 503 并说明差什么,服务其余部分照常启动。解不开的密文一律按未配置透出,不抛也不做重加密迁移。面板新增凭据页(`web/src/credentials.tsx`)。本票不动启动时的凭据校验(issue #65)与配置文件(issue #66),`buildReviewers` 仍读 `apiKeyEnv`,库里的凭据还没有接进 Review Run。部署向导也未改,新部署要手工往 `.env` 补主密钥(issue #72 收口)。
- 2026-08-16: 落地 issue #65。凭据校验从启动挪到组装 Reviewer(ADR 0008)。启动不再读 `apiKeyEnv`:空库、一把模型凭据都没有、连主密钥都没设的新部署照常起,人进面板把它配起来。组装点是 Review Run 开始的那一刻(投递与手动重跑共用):按 provider 从库里取一次凭据快照,在编排进程里解密,整轮不重读——轮转对进行中的 Run 无影响,下一次投递自然用新的。缺凭据的 provider 不再抛错拦住投递,而是建出一个一跑就报失败的 Reviewer,那次 Review Run 因此在时间线上留下一条失败记录,失败原因写明缺哪一家。凭据来源收敛到库这一条:`apiKeyEnv` 字段还在配置文件里(issue #66 删),但组装不再读它,文件与库不构成双轨。子进程的注入路径未动(ADR 0004):仍是单变量 `MULTIREVIEWER_MODEL_API_KEY`、先剥光父进程环境,密文与主密钥都不进子进程。
- 2026-08-16: 落地 issue #66。全局设置进库,`multireviewer.config.json` 废除。模型组合与批次上限存 `global_setting` 表,面板的 `GET`/`PUT <前缀>/api/settings` 读写同一形状(`{reviewers: [{provider, model}], maxChangedLinesPerBatch}`);全局组合与每仓库覆盖同构,一套校验判据通吃,报错标注是全局还是哪个仓库;批次上限缺省时读回默认值 2000。`ReviewerSpec` 去掉 `apiKeyEnv`,凭据只从库里按 provider 取(ADR 0008)。空库、还没配组合时投递照常受理,留下一条失败的 Review Run 写明「还没有配置模型组合」——零 Reviewer 的 Run 不留痕,那才是真的看不出问题。删掉的东西:`multireviewer.config.example.json`、`loadConfig` 与默认配置路径、环境变量 `MULTIREVIEWER_CONFIG`(镜像里那一行也删)、compose 的只读单文件绑定与「只需要这三样」的注释、向导写配置的那一段(向导的模型标识核对改成直接核两个入参)。面板暂时只有端点没有设置页,组合的选择器是 issue #68 / #69。
- 2026-08-16: 落地 issue #67。面板 API 加模型目录端点 `GET <前缀>/api/catalog`,回服务进程里那份 Pi 的全部 provider(实测 39 家)与它们的模型,每家带上凭据是否已配。目录是运行时事实,随 Pi 升级而变:从服务端读,不进前端构建期依赖,前端不重建也不会显示旧目录。目录与凭据状态一次请求拿齐——拆成两个端点要在前端合并两份数据,还多一次往返。每个模型只给 `id`、`name`、`contextWindow`、`cost`:`id` 是模型标识 `provider:model` 的后半段,选择器要靠它回填,其余三项是选型判据;reasoning / maxTokens / input / baseUrl 不给,面板不用它们做判断。没配凭据的 provider 照常在结果里,不过滤——先能看见一家,才知道该去配它的凭据。不做工具调用能力的拦截:Pi 的模型类型里没有这个字段,面板自建黑名单追不上上游,让它在 Review Run 里失败并写明原因。本票只有端点,模型组合的选择器是 issue #68。
- 2026-08-16: 落地 issue #70。注册仓库改成搜索式下拉。面板新增 `GET <前缀>/api/repos/search`:走面板既有的 admin token 门禁,服务端用 bot PAT 调 Gitea 的 `/repos/search`(现有 scope 够用,契约见 `docs/research/gitea-repo-search-api.md`),浏览器不直连 Gitea——直连等于把 Gitea 的仓库可见范围挂在一个前端能拿到的 token 上,还要再造一条凭据轮换路径。能力挂在 Gitea 专属的 hook 管理模块上,不进通用 `Forge` 接口(ADR 0002)。响应逐条标两个状态:已注册(查注册表)、bot 不是 admin(读搜索结果自带的权限字段);两类不可选项照样返回、由前端置灰,过滤掉会让人明知仓库存在却搜不到。只取第一页,总数大于这一页即标截断,前端提示继续输入。前端手输 owner / repo 两个框删除,不留兜底。注册端点的入参与权限检查一字未改,repoId 仍由服务端从权限检查那一次请求读出。
- 2026-08-16: 落地 issue #71。面板补上登出:`DELETE <前缀>/api/session` 落在门禁之后(未登录调它回 401),从内存会话表删掉该 session 并回一个 `Max-Age=0`、属性与登录时逐字一致的 Set-Cookie;壳的侧栏底部是入口。顺带把三条既有事实写进部署段的「面板门禁的运维」:轮换 admin token 要改环境变量加重启,重启即清空全部会话(会话表在内存不落库),怀疑 cookie 泄露时正解也是轮换 token;HTTPS 是门禁的前提,会话 cookie 带 Secure、基地址明文 http 且非 localhost 时服务拒绝启动,TLS 由外部反代终止;面板前缀不是安全边界,未认证请求端点存在与否都回 401。门禁本身一字未改。
- 2026-08-16: 落地 issue #72。部署向导退出配置面。删掉三个阶段:DeepSeek 密钥、OpenRouter 密钥、模型组合(连同容器里那次 Pi 模型表核对),向导从九步降到六步,成功边界仍是「面板能登录」。清理动作之前先把 `.env` 复制成 `.env.bak-<YYYYMMDD>`(权限 600,同一天重跑不覆盖已有副本——覆盖会用已经清过的内容把旧值冲掉)。四个变量随后检出即清并说明原因:`DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`(模型凭据改由面板凭据页加密存库,ADR 0008)与 `MULTIREVIEWER_DEEPSEEK_MODEL` / `MULTIREVIEWER_OPENROUTER_MODEL`(模型组合改由面板设置页存库)。备份是文件复制、清理只打变量名,key 的值一次都不上屏。凭据主密钥 `MULTIREVIEWER_CREDENTIAL_MASTER_KEY` 改由向导 `openssl rand -hex 32` 生成并写进 `.env`,值不回显;已有值时沿用,`FORCE=1` 也不重新生成——重新生成等于把已存的凭据作废。不生成的话新部署必须手工补一个随机密钥才打得开凭据页,而向导的收尾恰恰是让人去那一页配 key。交付清单的「下一步」补两条:设置页选模型组合、凭据页粘两家的 key,并说明这两步没做完时投递会建一次失败的 Run 而不是故障。
- 2026-08-16: 收口 issue #56 十票落地后的评审复核,七条。两条是行为决策:一、模型标识的历史回填整体取消——provider 从库里恢复不出来,按当前模型组合反查会把历史 Finding 永久错归厂商,代价是同一个模型在迁移前后裂成两行(旧行裸 model id、新行 `provider:model`),统计矩阵里各成一条;二、模型凭据允许保存认不出的 provider——模型目录列出 Pi 全部 39 家,而厂商验证只认得 4 家,拒收会让其余 35 家的模型选得出、凭据配不上;这些凭据跳过验证落库并标成未验证,面板逐行透出这个状态。其余五条是缺陷修复:模型目录的进程内缓存不再存住失败的 promise;全局模型组合允许为空(每仓库覆盖仍必须至少一个);批次上限的 NaN 不再静默清空设置;注册模态改搜索词后不再提交过期的选中项;模型选择器的总量截断有了提示。细节见 `src/AGENTS.md` 与 `web/AGENTS.md`。
- 2026-08-17: 面板换视觉世界。上一轮青色密控制台被否。方向定为品类标准件,手艺对标 GitHub / Linear / Vercel:近黑主色、白底、冷灰外壳。登录后落到评审记录;该页改成检查列表。产品事实见 `web/PRODUCT.md`,视觉系统见 `web/DESIGN.md`。
- 2026-08-18: 模型目录补两个词条:远程目录、厂商目录。OpenRouter 现货并进目录的 spec 是 issue #75。
- 2026-08-18: 开 wayfinder 地图「模型怎么进组合」(issue #76)。目的地是三条入口的可开工 spec。OpenRouter 厂商目录折进图里,不单独实现。
- 2026-08-18: 走完地图 issue #76 的 [厂商目录这轮还点名哪家](https://github.com/kassol/MultiReviewer/issues/79)。厂商目录这轮只接 OpenRouter,代码缝按 issue #75 的形状留下,不点名第二家。判据是落盘那一行要带齐 `api` / `baseUrl` / `compat` / `cost` / `contextWindow`,而 13 家实测里只有 OpenRouter 免鉴权就给全量(200,414 个模型),其余一律 401 / 403。接一家要 key 的会让目录加载反过来依赖凭据表,「还没配凭据也能看见完整目录」随之失效;缺单价的行会让 Review Run 成本恒为零——成本取自 Pi 内置定价表,硬编码等于在本仓库维护一张会过期的价目表。一手厂商缺的模型走手填入口兜底。笔记落 `docs/research/vendor-model-catalog-apis.md`,含 13 家的实测响应与字段出处;未来若接第二家,顺序是 Together → Groq → Anthropic,接之前先解决目录加载怎么拿凭据与缺单价的成本口径。
- 2026-08-18: 走完地图 issue #76 的 [手填标识开在哪些 provider 上](https://github.com/kassol/MultiReviewer/issues/80)。手填模型标识只开在已配模型凭据的 provider 上,provider 那一格从目录里选、不敲。判据是选择器今天就以凭据为硬门禁(未配凭据的分组标题写「未配凭据,选不了」,其下每个模型 disabled),放开到全部 39 家会让同一个 provider 点不动却敲得进,两套规则并存。敲一个目录里没有的 provider id 落到的是自定义 provider 那条入口,让它选而不敲把两条入口的边界交给控件形态,不靠运行时猜。填错不加新校验:模型标识不存在由子进程报「模型不存在」,该家没凭据则组装出一个一跑就失败的 Reviewer 并写明去凭据页配,单个 Reviewer 失败不拦整轮。顺带查明服务端的 `PUT /api/settings` 只校验形状、非空与标识不重复,不查凭据也不查目录成员——门禁一直只在前端。
- 2026-08-18: 走完地图 issue #76 的 [自定义 provider 在模型标识里叫什么](https://github.com/kassol/MultiReviewer/issues/81)。provider 段就是 Pi 的登记 id(models.json 里 `providers.<id>` 的那个键),要定的只是谁写、能写几个:操作员起名,一个名字对应一个 base URL 与一把模型凭据,与内置 39 家共用同一命名空间。判据是 `model_credential.provider` 为主键,一家一把凭据;固定成 `openai-compatible` 一家会让公司网关与本地 vLLM 二选一,固定前缀加序号则在 PR 评论与处置率统计里看不出是哪一家。撞上内置名字当场拒收——Pi 对同名不报错而是静默覆盖(只给 baseUrl 不给 models 时内置模型列表原样保留、全部改指新端点),叫 `openai` 会让已有组合悄声换端点。名字限小写字母、数字与连字符,与内置 id 同形,顺带包含「禁冒号」这条硬约束(`parseModelIdentity` 按第一个冒号切分)。`CONTEXT.md` 新增词条 自定义 provider。「拿自定义端点覆盖内置 provider 的 base URL」判为出界:那是改一家已有的,不是加一家新的。
- 2026-08-18: 走完地图 issue #76 的 [手填与自定义的模型行怎么活过重启与远程刷新](https://github.com/kassol/MultiReviewer/issues/82)。票的前提要修正:模型行不走 `models-store.json` 走 `models.json`。`withRemoteCatalog` 只包在内置 provider 列表上,自定义 provider 没有 `refreshModels`,store 里的条目根本不会被恢复,两条入口不可能共用 store。而 `models.json` 是独立且盖在 store 上面的一层——`getModels()` 每次读都重跑一遍 `applyModelsJson(providerId, base.getModels(), config)`,`base.getModels()` 才是「内置 + store overlay」的合并,远程刷新换掉的只是内部那个 `dynamicModels`,models.json 那层在它之后原样再叠。「怎么不被抹掉」在选对层之后自己消失。附带三条:`applyModelsJson` 是 upsert(内置行保留、同 id 覆盖、新 id 追加);给已有 provider 加行时 `defaults` 回落到该家 `models[0]`,`api` 与 `baseUrl` 自动继承,手填一行最少只要一个 id;全新 provider 无此回落,缺 `api` 或 `baseUrl` 该家整个从目录消失。真相源定在库里(与模型组合、模型凭据同处),`models.json` 是可从库重建的派生物,写在缓存目录里两侧共用(同 `models-store.json` 的绝对路径理由),写库时同步重写、启动时再写一次兜底——只在读目录时重建会让没人打开过面板的实例投递进来直接报模型不存在,那正是当初 store 踩过的坑。`authPath` 保持各自私有不共用(ADR 0004)。单价与上下文选填,留空走 Pi 默认(单价 0、上下文 128000、maxTokens 16384),该模型的 Run 成本因此记零,面板需标出这一状态。
- 2026-08-18: 走完地图 issue #76 的 [三条入口在面板上怎么同时出现](https://github.com/kassol/MultiReviewer/issues/83),地图至此结清。三条入口取原型变体 C 的两栏布局:左栏是厂商列(内置 39 家与自定义的排在同一列,底部「+ 加一家 provider」),右栏是选中那家的模型列,右栏底部固定一行手填 model id。判据是它把「填进哪一家」这个问题设计掉了——手填框长在已选中那家下面,provider 不是一个要填对的字段而是当前所处的位置,而变体 A 与 B 都得靠下拉或按钮组强制同一条约束;左栏把自定义 provider 与内置的排成一列,也顺带说清了「共用同一命名空间」。明确接受的代价是跨厂商搜索没了(现在敲 glm 能横扫 39 家):模型组合是低频设置,三条入口的边界清楚每次都要用,这笔交易划算。原型另发现一档:本机一把凭据都没配时变体 A 的落空提示下面没有任何出路,C 不存在这一档。三个变体留在 `prototype/model-entry-panel` 分支,不进主干。下一步交 `/to-spec`:新开一份总 spec 并把 issue #75 包进去,它是三条入口之一的完整实现细节、已可开工,重写一遍只会让两份描述漂移。
- 2026-08-18: 地图 issue #76 收拢成 spec [模型进组合的三条入口：厂商目录、手填标识、自定义 provider](https://github.com/kassol/MultiReviewer/issues/84)(`ready-for-agent`),地图随之关闭。六张决策票的结论逐条折进去,[厂商目录：把 OpenRouter 现货并进模型目录](https://github.com/kassol/MultiReviewer/issues/75) 原样包进总 spec、不单独实现(它是三条入口之一的完整实现细节、已可开工,重写会让两份描述漂移),该票已注明折入。测试缝四条全部沿用既有的、一条新的都不加:面板 API 真实 HTTP(先例 `panel-settings` / `panel-credentials`)测两类写入的读写与拒收;模型目录端点(先例 `panel-catalog`,期望值另建 Pi 运行时问它、不拿被测模块自己的输出当判据)测目录里的集合变化;Reviewer 运行时(先例 `reviewer-model-store`,真建运行时并打桩 fetch 断言零外发)守「面板选得出的子进程必须取得到」这条最要紧的不变量;`runReview` 入口测失败路径留下带原因的记录。厂商目录那部分沿用 issue #75 已定的三条缝。
- 2026-08-18: 定下验证的场所:交付前的人工确认走部署实例,不在开发机起服务(全局规范新增一条,`web/AGENTS.md` 的模块规范呼应一条)。自动化测试不受影响,仍在本机跑——那是缝上的断言,与实例无关。判据是本机 dev 双进程没有真 Gitea、没有已注册的仓库、没有模型凭据,面板上大半的屏在那里是空的,补齐这些的成本比推一次镜像高,而验完的结论还不能代表实例。开发机的 `.env` 因此只留 Gitea 那几个变量,面板变量(admin token / 面板前缀 / 基地址 / 凭据主密钥)不常驻;临时要在本机起面板时补上、验完删掉。
- 2026-08-18: 落地 issue #85 与 #86,spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的两张预重构,对操作员不可见。面板与 Reviewer 子进程共用的落盘文件从一份变两份:`MULTIREVIEWER_CACHE_DIR/pi-models/` 下除了远程目录的落盘 `models-store.json`,还多一份由库里的模型行派生的 `models.json`。后者此前两侧各指自己的临时目录、谁也读不到谁,而它是手填模型行与自定义 provider 唯一的落地层(issue #82),这一票只把路径打通,不引入任何新的模型来源。启动时写一次(内容此刻是空的 provider 集合);写不出来只告警不拦启动,读照常。两份文件都是可从库与 pi.dev 重建的派生物,清空它只影响下一次读目录。凭据那一份仍各自私有不共用(ADR 0004),共用的只有目录。另给模型目录的进程内缓存补了显式失效入口,供下一票的模型行写入调用。

  评审顺带查出一个**自 2026-08-17 起就存在的部署缺陷**:`MULTIREVIEWER_CACHE_DIR` 留空或填相对路径时,共用完全不生效——Reviewer 子进程的工作目录是工作副本,同一个相对值在服务与子进程两侧解析出两个不同目录,面板选得出的远程模型子进程一个都取不到。Docker 部署里这个变量是绝对路径 `/data/worktrees`,所以镜像跑法不受影响;直接 `pnpm start` 且没设这个变量的部署一直是断的。现在服务在父进程里把它解析成绝对路径再传给子进程,填相对值也能用了。**票 #86 的前提查证后有一处是错的**:凭据写入后目录端点的 `configured` 本来就是每次请求现读库算出来的,不受缓存影响,已用测试证伪并因此没有把失效接到凭据写入上。
