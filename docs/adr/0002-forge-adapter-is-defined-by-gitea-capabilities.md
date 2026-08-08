# Forge adapter 的接口按 Gitea 的能力定义

目标部署平台是公司内部的 self-host Gitea,而开发与测试阶段使用 GitHub 更方便获得可用的仓库与事件。两个平台的能力并不对等:GitHub 支持 `suggestion` 代码块一键应用,Gitea 至今不支持。若按 GitHub 的能力设计接口,移植到 Gitea 时会发现对面没有对应实现。因此 forge adapter 的接口取两个平台能力的交集,以 Gitea 为基准定义,GitHub 实现只是更容易满足该接口。

## Consequences

- 接口只包含两边都有的能力:创建带行级评论的 review、读回 review 评论及其 resolve 状态、resolve 与 unresolve、拉取 PR diff 与文件内容、接收 PR 事件。
- GitHub 独有的能力不进入接口,即便开发阶段用得上。
- Gitea 的最低支持版本是 **1.26.0**。`POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve` 与 `/unresolve` 两个端点在 v1.25.5 与 v1.24.7 的源码中均不存在,自 v1.26.0 起提供。Disposition 建在这对端点上,因此 1.26 以下的实例无法使用本工具。这个门槛很高:大量既有 Gitea 部署仍在 1.22 至 1.25,部署文档必须把它写在最显眼处。
- Gitea Enterprise 另有一套版本号。官方规则是社区版 `v1.X.Y` 对应企业版 `vX.Y.*`,故企业版的最低支持版本是 **26.0.0**。
- 首个目标实例运行 `commitgo/gitea-ee:26.4.4`,对应社区版 1.26.4,满足要求。
- 该实例的 API 要求登录后才能调用,匿名 `GET /api/v1/version` 返回 `Only signed in user is allowed to call APIs.`,因此 adapter 的每一次调用都必须携带凭据,读取类调用也不例外。
