# Gitea 仓库搜索端点的契约

调研目标：查清「搜索当前 token 可见仓库」的 REST 端点契约，供搜索式下拉使用。对应 issue #50。

## 证据来源

一手来源三类，正文中的 `文件:行号` 均指第一类：

1. **go-gitea/gitea `release/v1.26` 源码**（原始文件取自 `raw.githubusercontent.com/go-gitea/gitea/release/v1.26/<path>`）。
2. **端点自带的 swagger 注释**：与源码同文件的 `// swagger:operation` 块，即官方 swagger 的生成源。目标实例的 `/swagger.v1.json` 需登录后才可读（匿名与带 PAT 均回 303 跳登录页），因此取生成源而非产物。
3. **目标实例只读探测**：`git.whzdhx.com`，`GET /api/v1/version` 回 `{"version":"26.4.4"}`，对应 `release/v1.26`。全程仅 GET。

交叉参考：`src/forge/gitea.ts`、`src/forge/gitea-hooks.ts`、`AGENTS.md:38`。

---

## 结论先行

用 `GET /api/v1/repos/search`。`GET /user/repos` 两条硬伤，直接出局：

1. 它没有关键字参数，只有 `page` / `limit`（`routers/api/v1/user/repo.go:90-103` 的 swagger 块）。搜索式下拉要的关键字过滤它做不到。
2. 它要 `read:user` scope，本项目 bot 的 PAT 没有。实例实测 403，响应体原文：
   `token does not have at least one of required scope(s), required=[read:user], token scope=write:issue,write:repository`。
3. 附带一条：它只列 **当前用户自己拥有** 的仓库（`OwnerID: ctx.Doer.ID`，`routers/api/v1/user/repo.go:111`），协作仓库不在内。bot 通常不是仓库 owner，可用集合会接近空。

---

## 1. 端点、路由与鉴权

路由注册于 `routers/api/v1/api.go:1204-1206`：

```go
// Repos (requires repo scope)
m.Group("/repos", func() {
    m.Get("/search", repo.Search)
```

该 `/repos` 组的 scope 是 repository 类。对照 `/user` 组在 `api.go:1190` 的收尾：

```go
}, tokenRequiresScopes(auth_model.AccessTokenScopeCategoryUser), reqToken(), contextAuthenticatedUser(), checkTokenPublicOnly())
```

`/user/repos`（`api.go:1153`）虽自带 repository scope 标注，但外层 `/user` 组的 `AccessTokenScopeCategoryUser` 同样生效，两者是与关系——这正是实测 403 要 `read:user` 的原因。

**scope 结论：`/repos/search` 不需要额外 scope。** 现有 bot PAT 的 `write:repository` 已覆盖（`AGENTS.md:38` 记的 `MULTIREVIEWER_GITEA_LIVE_PR` 验证证明该 PAT 够用），实例实测 200。

`/search` 这一行没有 `reqToken()`，即匿名可调；但本实例要求登录后才能调 API（ADR 0002，见 `src/forge/gitea.ts:19-21`），匿名无意义。照现有做法一律带 PAT。

## 2. 查询参数（`routers/api/v1/repo/repo.go:44-202`）

swagger 块 `repo.go:50-126` 声明的全部参数：

| 参数 | 类型 | 语义 | 解析处 |
| --- | --- | --- | --- |
| `q` | string | 关键字 | `repo.go:138` `ctx.FormTrim("q")` |
| `topic` | bool | 把关键字当 topic 匹配 | `repo.go:142` |
| `includeDesc` | bool | 关键字也匹配描述 | `repo.go:147` |
| `uid` | int64 | 只搜该 user id 拥有或参与的仓库 | `repo.go:139` |
| `priority_owner_id` | int64 | 结果中优先排该 owner | `repo.go:140` |
| `team_id` | int64 | 限定某 team | `repo.go:141` |
| `starredBy` | int64 | 限定某 user 星标过的 | `repo.go:146` |
| `private` | bool | 含调用者有权访问的私有仓库，**默认 true** | `repo.go:133` |
| `is_private` | bool | 只要公开 / 只要私有，默认全都要 | `repo.go:181-183` |
| `template` | bool | 是否含模板仓库 | `repo.go:151-153` |
| `archived` | bool | 只要归档 / 只要非归档，默认全都要 | `repo.go:177-179` |
| `mode` | string | `fork` / `source` / `mirror` / `collaborative`，其它值回 422 | `repo.go:159-175` |
| `exclusive` | bool | **仅在给了 `uid` 时有意义**：只要该 uid 拥有的，排除协作仓库 | `repo.go:155-157` |
| `sort` | string | `alpha`(默认) / `created` / `updated` / `size` / `git_size` / `lfs_size` / `stars` / `forks` / `id`，非法值回 422 | `repo.go:185-202` |
| `order` | string | `asc`(默认) / `desc`，`sort` 未给时忽略 | `repo.go:187-190` |
| `page` | int | 1 起 | `routers/api/v1/utils/page.go:14` |
| `limit` | int | 页大小 | 同上 |

**没有「按权限过滤」的参数。** `exclusive` 过滤的是所有权（owner 与 collaborator 之分），不是 admin/push/pull 权限；`mode=collaborative` 同理。要「只列 bot 有 admin 权限的仓库」，只能拿回结果后按 `permissions.admin` 在本端筛。

`q` 是大小写不敏感的子串匹配：实测 `q=REV` 命中 `zhangxu/review`。

### token 可见性过滤

`repo.go:137` 传 `Actor: ctx.Doer`，`repo.go:133` 的 `private` 默认在已登录时为 true，`repo.go:149` 再叠 `opts.ApplyPublicOnly(ctx.PublicOnly)`。结果集由 `repo_model.SearchRepository` 按 Actor 可见性裁剪，**不需要调用方额外传参**。实例实测：该 PAT 拿到 27 个仓库，其中 25 个 `private=true`，均为 bot 实际有权访问的。

## 3. 返回体形状

包装体是 `api.SearchResults`（`repo.go:233-236`）：

```json
{ "ok": true, "data": [ ...Repository... ] }
```

注意与 `/user/repos` 不同——后者回裸数组。两个端点的解析代码不能共用。

单个 repo 对象（实例实测键名，与 `modules/structs/repo.go` 的 `Repository` 对应）包含：`id`（数值）、`name`、`full_name`、`owner`、`private`、`internal`、`archived`、`empty`、`fork`、`mirror`、`default_branch`、`clone_url`、`ssh_url`、`html_url`、`updated_at`、`permissions` 等。实测样本：`id=27`，`full_name="zhangxu/review"`。

`owner` 是完整的 User 对象，含 `id`、`login`、`username`、`full_name`、`avatar_url`、`email`、`visibility` 等。下拉里取 `owner.login` 或直接用 `full_name` 即可。

### permissions 一定在搜索结果里

`repo.go:222-229` 对结果集逐个仓库计算调用者权限后再转换：

```go
permission, err := access_model.GetDoerRepoPermission(ctx, repo, ctx.Doer)
...
results[i] = convert.ToRepo(ctx, repo, permission)
```

`services/convert/repository.go:42-44` 把它落成三个布尔：

```go
Admin: permissionInRepo.AccessMode >= perm.AccessModeAdmin,
Push:  permissionInRepo.UnitAccessMode(unit_model.TypeCode) >= perm.AccessModeWrite,
Pull:  permissionInRepo.UnitAccessMode(unit_model.TypeCode) >= perm.AccessModeRead,
```

赋值处 `repository.go:222` `Permissions: permission`。实例实测每条结果都带 `"permissions": {"admin": true, "push": true, "pull": true}`。

**对下拉的意义：搜索结果自带权限，一次请求就够，不必为每个候选再打一次 `/repos/{owner}/{repo}`。** 「无权限」标记直接读 `permissions.admin`。

本实例上该 bot 对全部 27 个仓库都是 admin，因此「admin=false 的渲染」在这里没有真实样本可验；语义由上述源码保证。

## 4. 分页终止条件

响应带 `X-Total-Count`（`repo.go:232` `ctx.SetTotalCountHeader(count)`）与 `Link` 头（`repo.go:231`）。实测响应头含 `x-total-count: 27` 与 `access-control-expose-headers: X-Total-Count`。

`limit` 会被钳制（`services/convert/utils.go:15-22`）：

```go
func ToCorrectPageSize(size int) int {
	if size <= 0 {
		size = setting.API.DefaultPagingNum
	} else if size > setting.API.MaxResponseItems {
		size = setting.API.MaxResponseItems
	}
	return size
}
```

所以 `limit=100` 在默认配置下实际是 50。**「不满一页即最后一页」在这里同样不成立**——这正是提交 9a5e8c2「Stop pagination on an empty page, not a short page」的教训，`src/forge/gitea.ts:150-155` 已有对应注释。

本端点上的正确终止判据，按优先级：

1. **`data` 为空数组即停**。与仓库现有循环一致，最稳。实测 `page=2&limit=50`（总数 27）回 `{"ok":true,"data":[]}` 而非 404 或错误。
2. `X-Total-Count` 可作为已取条数的校验，但不要单独用它算页数——页大小是服务端钳制后的值，客户端请求的 `limit` 不等于实际页大小。

**下拉场景其实不需要翻页。** 请求单页 `limit=50`（不超过 `MaxResponseItems` 默认值），配 `q` 过滤，返回条数够填一个下拉；条数由 `X-Total-Count` 告知，可提示「还有更多，请细化关键字」。

## 5. 对 `git.whzdhx.com` 的适配性

实例版本 `26.4.4`（企业版），按 `src/forge/gitea.ts:98-104` 记的换算对应社区版 `release/v1.26`。上述端点与参数在该实例上逐项实测通过：

| 请求 | 结果 |
| --- | --- |
| `?q=review&limit=2` | 200，`x-total-count: 1`，命中 `zhangxu/review` |
| `?q=&limit=50` | 200，`x-total-count: 27` |
| `?q=REV` | 200，1 条（大小写不敏感） |
| `?q=nonexistent-zzz` | 200，`x-total-count: 0`，`data: []` |
| `?page=2&limit=50` / `?page=99&limit=50` | 200，`data: []` |
| `?sort=updated&order=desc&limit=50` | 200，排序生效（首条变为 `zhangxu/review`） |
| `?exclusive=true&limit=50` | 200，27 条（未给 `uid`，无过滤效果，印证 §2 的说明） |
| `?archived=false&limit=50` | 200，27 条 |
| `?mode=source&limit=50` | 200，27 条 |
| `GET /user/repos?limit=2` | **403**，要求 `read:user` |

## 6. 与现有代码的接口对齐

- **放哪个文件**：`src/forge/gitea.ts`。仓库搜索是通用读取能力，不属于 hook 生命周期管理；`src/forge/gitea-hooks.ts:8-9` 只导入 `request` 与 `GiteaForgeOptions` 来做 hook 的增删改查。
- **沿用哪套辅助函数**：`requestJson<T>`（`src/forge/gitea.ts:86-92`），它在 `request` 上包一层 `.json()`。`request`（`src/forge/gitea.ts:58-84`）已负责拼 `/api/v1` 前缀（`apiRoot`，`gitea.ts:44-46`）、带 `Authorization: token <PAT>`、把非 2xx 转异常。
- **要读响应头时用 `request` 而非 `requestJson`**：`requestJson` 丢掉 `Response`，取不到 `X-Total-Count`。`src/forge/gitea-hooks.ts:112` 与 `:142` 就是直接用 `request` 拿 `Response` 的先例。
- **`PAGE_SIZE`**：`src/forge/gitea.ts:24` 定义为 100，会被服务端钳到 50。若新增方法只取单页，显式用 50 更诚实；沿用 `PAGE_SIZE` 也不会出错，前提是终止判据用「空页」。
- **返回体解包**：搜索端点是 `{ok, data}` 包装，不能照抄 `gitea.ts:157` 那种直接把响应当数组的写法。

## 未找到依据的项

- 实例的 `API.DEFAULT_PAGING_NUM` 与 `API.MAX_RESPONSE_ITEMS` 实际配置值读不到（需要管理端）。`limit=9999` 与 `limit=0` 都回 27 条，因为总数 27 小于两者的默认值（30 / 50），无法区分。按默认值假设，并用「空页才停」兜底。
- 本实例上没有 `permissions.admin=false` 的仓库样本，该分支的渲染无法实测验证。
