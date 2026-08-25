# 范围审查由容器 PR 承载

ADR 0001 把审查挂在 pull request 上,并把「直推默认分支的仓库无法使用本工具」列为有意为之的后果。当初否决手动触发的理由是要自建三样东西:结果展示、处置采集、登录。到本决策时面板与登录都已建成,三个成本只剩处置采集一项。因此解除 0001 的准入约束:人可以在面板指定仓库、一个 base commit 与一个比较项发起范围审查,不要求存在任何 pull request。0001 的锚点决策保留:结果仍以 PR 行内 review 评论呈现,处置仍以评论的 resolve 状态为载体。没有 PR 的范围由 MultiReviewer 自己在 Forge 上建一个容器 PR:base 分支指向基准,head 分支跟随比较项,永不合并,审查完成时关闭并删分支。

## Considered Options

- **自建 Finding 存储与处置状态,不碰 Forge。**面板已经能展示了,看起来顺手。但 Disposition 会从此有两个事实来源(PR 触发的在 Forge,范围审查的在本地),ADR 0006 的回填、Finding Identity 的跨轮匹配全部要写两套。
- **只允许审既有 PR 内部的两个 commit。**不动 0001,但直推 main 的团队仍然用不了,而那正是提出范围审查的动机。

## Consequences

- Forge 接口新增建分支(从 sha)、删分支、建 PR、改 PR 状态四个写能力。Gitea 1.26 建 PR 要求 head 与 base 都是分支,所以容器 PR 需要两条分支,不能直接引用 sha。
- 比较项推进的同步方式是 MultiReviewer 用本地 clone 把 head 分支推到新 commit。Gitea 没有「把分支指到某 sha」的 API,`git push` 是正规途径。推分支会触发 `synchronized` webhook,webhook 处理器按分支前缀识别容器 PR 并丢弃其事件,增量审查由面板直接发起。
- 面板是唯一操作面。人对 Finding 的处置在面板完成并写回 Forge 的 resolve 状态;处置备注只存面板,不写 Forge。Gitea 没有回复到行内评论线程的 API(`CreatePullReviewComment` 无 reply 字段),即便想写也写不到正确位置。Forge 页面只作为看原版 diff 与评论的只读窗口。
- 面板 resolve 的操作身份是服务凭据,Forge 上 `resolver` 显示为机器人账号;操作人由面板自己记录。按面板用户各自绑 Forge token 会推翻 ADR 0005。
- 仓库里会出现机器人开的分支与 PR,以固定前缀识别。审查完成时删除,未完成期间留存。
- `Review Range` 的 base 在 PR 触发时仍是 merge-base;范围审查只接受线性范围(比较项必须是 base 的后代),merge-base 等于 base,两条链路可以共用同一段代码。
- 完整 diff 视图的数据来自本地 clone,与 Reviewer 读的是同一份。Gitea 的 compare 端点只返回 commit 列表与文件名,没有 patch 文本,不能作为来源。
