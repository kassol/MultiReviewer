# 审查挂载在 pull request 上

曾考虑过手动触发加自建 Web 界面,以适配团队当前直推默认分支的习惯,但那条路要自建结果展示、处置采集与登录三块,并且拿不到真正的行内评论。Gitea 与 GitHub 都在 pull request 上提供行级 review 评论与 resolve 状态,这是两个平台唯一共有的行内锚点。因此审查统一挂在 pull request 上:由 PR 事件触发,结果以行级 review 评论呈现,采用本工具的团队需要走 PR 流程。

## Consequences

- 团队工作流被产品约束:直推默认分支的仓库无法使用本工具。这是有意为之,避免为单一团队习惯做特例。
- Disposition 有一等载体,无需自建:`PullReviewComment.resolver` 为空即未处置,`POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve` 与 `/unresolve` 可读可写。
- 跨轮次跟踪材料由平台提供:review 评论回传 `commit_id`、`original_commit_id` 与 `diff_hunk`。
- 自建 Web 界面、OAuth 登录、自建 Finding 存储全部不需要。
- 行级评论的位置必须落在 diff 内。落不上的 Finding 退化为 PR 级别的整体评论。
- 一个已知能力缺口:Gitea 不支持 `suggestion` 代码块的一键应用,该特性不进入接口。
