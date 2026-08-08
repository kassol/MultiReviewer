# Forge 凭据按平台各自选型:Gitea 用 bot 账号加 scoped PAT,GitHub 用 GitHub App

两个平台的认证模型差异极大,无法像能力接口那样取交集。GitHub 有 App 这一等身份:用私钥签 JWT 换 installation token,按仓库安装并授予权限,运行时无需任何人参与,令牌自动轮换——这正是审查机器人应有的模型。Gitea 没有对应物。因此凭据获取方式按平台分别实现,置于 forge adapter 之下,接口只暴露"取得某仓库的可用凭据",不暴露机制。

Gitea 侧选定专用 bot 账号加细粒度 PAT,令牌 scope 取所需的最小集合(至少 `read:repository` 与 `write:issue`),bot 账号以协作者身份加入需要审查的仓库。

## Considered Options

OAuth2 曾被考虑并否决。Gitea 的 OAuth2 provider 在 v1.26.4 的源码中只接受 `authorization_code` 与 `refresh_token` 两种 grant type(`routers/web/auth/oauth2_provider.go` 的 grant type switch,其余返回 `unsupported_grant_type`),没有 client credentials,也没有设备流,因此无人值守的服务无法自行取得令牌。

更关键的是,OAuth 在 Gitea 上并不提供 GitHub App 那样的仓库级安装授权。`models/auth/access_token_scope.go` 中的 scope 只限定令牌能执行的操作类别,除 `public-only` 外没有限定到具体仓库的机制;可访问哪些仓库仍取决于背后用户的协作者身份。也就是说,无论走 PAT 还是 OAuth,都必须把 bot 账号加入目标仓库,OAuth 省不掉这一步。

OAuth 相对 scoped PAT 的唯一实际收益是令牌轮换,代价是部署时需人工完成一次浏览器授权、服务需提供 redirect 端点,且 refresh token 轮换本身是真实的故障模式——本项目的 harness prototype 中,一个第三方 provider 正是因 `refresh_token_reused` 而失效。

## Consequences

- 部署文档必须包含 Gitea 侧的两步:创建 bot 账号并签发限定 scope 的令牌,以及把该账号加入需要审查的仓库。
- 令牌是静态的,轮换由部署方自行安排,服务只负责从配置读取。
- 发布 PR review 评论所需的确切 scope 需在实现阶段实测确认(`write:issue` 与 `write:repository` 二者之一)。
- GitHub 侧需要实现 App 私钥签发 JWT 与换取 installation token 的流程,与 Gitea 侧共用同一个 adapter 接口。
