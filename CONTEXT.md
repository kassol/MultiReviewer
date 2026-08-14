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
