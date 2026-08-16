# MultiReviewer

对 pull request 执行多模型并行代码审查的工具。目标平台是公司内部 self-host 的 Gitea,开发阶段以 GitHub 为测试平台。

## Language

**Forge**:
托管代码与 pull request 的平台。当前有 Gitea 与 GitHub 两个实现,接口以 Gitea 的能力为基准。
_Avoid_: 平台、代码托管、Git 服务

**Review Run**:
一次审查执行。针对某个 pull request 的某个 head commit,运行一组 Reviewer,输出一批 Finding。同一 pull request 的每个新 head commit 触发新的 Review Run。
_Avoid_: 审查任务、review job、扫描

**Review Range**:
一次 Review Run 覆盖的代码范围,由 pull request 的 base 与 head commit 界定,取其合并 diff。
_Avoid_: diff、变更集

**Reviewer**:
一个绑定了具体模型的审查执行体。一次 Review Run 并行运行多个 Reviewer。
_Avoid_: agent、模型、worker

**Finding**:
一条被提出的代码问题。归属于提出它的 Reviewer,并指向 Review Range 内的具体位置。
_Avoid_: issue、问题、comment、告警

**Finding Identity**:
判断两条 Finding 是不是同一条的依据,中文叫「同一处 Finding」。同一个 pull request 里、同一个 Reviewer 指向同一处未改动代码的 Finding 是同一条,不论它在多少轮 Review Run 里被报出;代码改动后再次报出的是新的一条。
_Avoid_: 去重、指纹、逻辑 Finding

**Disposition**:
人对一条 Finding 的处置结论。载体是 Forge 上该条 review 评论的 resolve 状态,已 resolve 即已处置。它是判断审查质量的唯一信号来源。
_Avoid_: 反馈、评分、标注

**仓库注册表**:
准入仓库的清单。主键是 Forge 的数值 repo id,改名与转移 owner 后凭 payload 里的 id 仍能匹配。只有注册表里的仓库的投递会被受理,未注册一律 401。
_Avoid_: 白名单、仓库列表

**Key**:
一个仓库准入 webhook 投递的凭证,每仓库一把,作为 Gitea hook 的 secret 参与 HMAC 验签。明文存库——HMAC 验签需要原始值,这是密码学约束,不是疏忽。
_Avoid_: secret、token、密码

**模型凭据**:
调用某一家模型厂商所需的凭据,每个 provider 一把,同一家下的多个 model 共用。由面板写入并加密存库,主密钥来自环境变量;只写不回显,解不开的密文视为未配置(ADR 0008)。它与 Key 是两类东西——Key 管仓库准入,模型凭据管厂商调用。
_Avoid_: Key、API key、模型 token

**模型覆盖**:
一个仓库对全局模型组合的替换。语义是全量替换 reviewers 列表,配置文件管全局默认、库管每仓库覆盖,不存在「文件与库谁赢」;注册后的下一次投递生效。
_Avoid_: 自定义模型、per-repo config

**面板前缀**:
管理面板路径的随机首段,运行时来自 `MULTIREVIEWER_PANEL_PREFIX`,只盖面板页面与它的 API,不盖 `/webhook` 与 `/assets`。作用是让面板不被扫描器枚举到,真正的门禁是 admin token;轮换前缀不影响任何已注册仓库的 hook。
_Avoid_: base path、子路径、随机路径

**代次**:
一把 Key 的单调递增序号,写在 hook URL 的 `?k=` 参数上,一次列 hook 即可读出 Gitea 上装的是第几代(ADR 0007)。代次是索引不是凭证:它只决定用哪把 Key 验签,验签仍决定一切,取错即 401。代码标识符用 `generation`。
_Avoid_: 版本、key id、generation number
