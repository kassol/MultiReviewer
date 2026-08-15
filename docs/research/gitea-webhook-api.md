# Gitea 仓库级 webhook 的 API 契约

调研目标：面板自动创建 / 更新 / 删除仓库级 webhook 所需的完整契约。对应 issue #20。

## 证据来源

一手来源三类，正文中的 `文件:行号` 均指第一类：

1. **go-gitea/gitea `release/v1.26` 源码**（原始文件取自 `raw.githubusercontent.com/go-gitea/gitea/release/v1.26/<path>`）。
2. **官方 swagger**：同分支 `templates/swagger/v1_json.tmpl`，`basePath` = `{{.SwaggerAppSubUrl}}/api/v1`（该文件第 22 行）。
3. **目标实例只读探测**：`GET /api/v1/version` 回 `{"version":"26.4.4"}`，与 `release/v1.26` 对应。仅执行 GET。

交叉参考：本仓库 `src/forge/gitea.ts` 已有的端点标注、`src/AGENTS.md:38-40`。

---

## 1. 端点与 HTTP 方法

路由注册于 `routers/api/v1/api.go:1248-1257`：

```go
m.Group("/hooks", func() {
    m.Combo("").Get(repo.ListHooks).
        Post(bind(api.CreateHookOption{}), repo.CreateHook)
    m.Group("/{id}", func() {
        m.Combo("").Get(repo.GetHook).
            Patch(bind(api.EditHookOption{}), repo.EditHook).
            Delete(repo.DeleteHook)
        m.Post("/tests", context.ReferencesGitRepo(), context.RepoRefForAPI, repo.TestHook)
    })
}, reqToken(), reqAdmin(), reqWebhooksEnabled())
```

| 操作 | 方法与路径 | 成功状态码 | handler |
| --- | --- | --- | --- |
| 列出 | `GET /api/v1/repos/{owner}/{repo}/hooks` | 200 | `routers/api/v1/repo/hook.go:26-79` |
| 读取单个 | `GET .../hooks/{id}` | 200 | `hook.go:82-123` |
| 创建 | `POST /api/v1/repos/{owner}/{repo}/hooks` | **201** | `hook.go:200-230` → `routers/api/v1/utils/hook.go:131-142` |
| 更新 | `PATCH .../hooks/{id}` | 200 | `hook.go:233-268` → `utils/hook.go:318-336` |
| 删除 | `DELETE .../hooks/{id}` | **204**（空 body） | `hook.go:271-308` |
| 触发测试投递 | `POST .../hooks/{id}/tests` | 204 | `hook.go:126-197` |

`{id}` 是 webhook 的数字主键（`int64`），非 URL、非名称。分页参数 `page` / `limit` 见 `hook.go:43-50`。

swagger 中的 operationId 依次为 `repoListHooks` / `repoGetHook` / `repoCreateHook` / `repoDeleteHook` / `repoEditHook`，声明的响应集合只有 `{201|200|204, 404}`（`v1_json.tmpl` 中两条 path 的 `responses`）。**swagger 未声明 401 / 403 / 422，但代码会返回**，见第 6 节。

---

## 2. 请求体字段

### 创建：`CreateHookOption`（`modules/structs/hook.go:54-73`）

| JSON 键 | 类型 | 必填 | 语义 |
| --- | --- | --- | --- |
| `type` | string | 是（`binding:"Required"`） | webhook 类型，见下 |
| `config` | `map[string]string` | 是（`binding:"Required"`） | 全部值必须是**字符串** |
| `events` | `[]string` | 否 | 事件订阅，见第 3 节 |
| `branch_filter` | string | 否 | glob 模式（`binding:"GlobPattern"`） |
| `authorization_header` | string | 否 | 附加到投递请求的 Authorization 头 |
| `active` | bool | 否，**默认 false** | 创建即启用与否 |
| `name` | string | 否（`MaxSize(255)`） | 人类可读名称 |

`type` 的合法取值：swagger enum 为 `["dingtalk","discord","gitea","gogs","msteams","slack","telegram","feishu","wechatwork","packagist"]`（`modules/structs/hook.go:56`）。运行时校验走 `webhook_service.IsValidHookTaskType`（`services/webhook/webhook.go:37-43`）：`gitea` / `gogs` 直接放行，其余查已注册的 requester 表。**面板用 `"gitea"`。**

`config` 三个关键键（`routers/api/v1/utils/hook.go:87-100, 215-231`）：

- `url` — 投递目标地址。**必填**，缺失回 422 `Missing config option: url`。校验只做 `validation.IsValidURL`（`modules/validation/helpers.go:41-49`）：能被 `url.ParseRequestURI` 解析、scheme 是 `http` 或 `https`、端口合法。
- `content_type` — **必填**，只接受 `"json"` 或 `"form"`（`models/webhook/webhook.go:69-78, 117-120`）。非法回 422 `Invalid content type`。
- `secret` — **可选**，无校验、无默认。写入 `Webhook.Secret`（`utils/hook.go:221`），投递时用于 HMAC：`services/webhook/deliver.go:97, 104-105, 136, 142-143` 生成 `X-Gitea-Signature`（裸 hex）与 `X-Hub-Signature-256`（`sha256=` 前缀）。与本仓库 `src/webhook/server.ts:103` 的验签一致。

拼写就是小写下划线：`url` / `content_type` / `secret`。另有 `is_system_webhook`（`utils/hook.go:207-214`，字符串布尔）以及 slack 专用的 `channel` / `username` / `icon_url` / `color`（`utils/hook.go:237-261`），面板用不到。

### 更新：`EditHookOption`（`modules/structs/hook.go:76-89`）

```go
Config              map[string]string `json:"config"`
Events              []string          `json:"events"`
BranchFilter        string            `json:"branch_filter"`
AuthorizationHeader string            `json:"authorization_header"`
Active              *bool             `json:"active"`
Name                *string           `json:"name,omitzero"`
```

`type` 不可改。指针字段（`active` / `name`）省略即保留原值；非指针字段（`events` / `branch_filter` / `authorization_header`）省略即被**清空或重置**，见第 4 节。

---

## 3. 「合并请求」与「合并请求同步」的事件名

常量定义在 `modules/webhook/type.go:20, 28`：

- 合并请求：`pull_request`
- 合并请求同步：`pull_request_sync`

**关键行为：`pull_request` 会展开成整个 PR 事件族。** `routers/api/v1/utils/hook.go:159-161`：

```go
func pullHook(events []string, event string) bool {
    return util.SliceContainsString(events, event, true) ||
           util.SliceContainsString(events, string(webhook_module.HookEventPullRequest), true)
}
```

`updateHookEvents`（`utils/hook.go:163-197`）用它给 8 个 PR 开关赋值：`pull_request` / `pull_request_assign` / `pull_request_label` / `pull_request_milestone` / `pull_request_comment` / `pull_request_review` / `pull_request_review_request` / `pull_request_sync`。只要 `events` 里出现 `pull_request`，这 8 个全部为 true。

`SliceContainsString` 是大小写不敏感的**全等**比较（`modules/util/slice.go:13-19`），不是前缀匹配。因此存在一个哨兵值 `pull_request_only`（`utils/hook.go:188`）：只订阅裸 `pull_request` 而不展开整族，要发 `["pull_request_only"]`。

实例探测印证了展开行为 —— `GET /api/v1/repos/zhangxu/review/hooks` 回的 `events` 恰好是上述 8 项：

```json
"events":["pull_request_assign","pull_request_comment","pull_request","pull_request_label",
          "pull_request_milestone","pull_request_review_request","pull_request_review","pull_request_sync"]
```

两种写法供面板选择：

- 宽订阅：`"events": ["pull_request"]` → 得到全部 8 项（含 sync）。
- 窄订阅：`"events": ["pull_request_only", "pull_request_sync"]` → 只得到 `pull_request` 与 `pull_request_sync`。

**`events` 为空数组或省略时回落为 `["push"]`**（`utils/hook.go:164-166`）。

回显顺序不稳定：`EventsArray` 遍历 `map[HookEventType]bool`（`models/webhook/webhook.go:200-206`），Go map 迭代无序。面板比对订阅时**必须按集合比，不能按数组顺序比**。

---

## 4. 更新 secret：端点、字段、部分更新

**结论：v1.26 的 PATCH 无法修改 secret。**

`editHook`（`routers/api/v1/utils/hook.go:340-405`）读取 `form.Config` 时只处理 `url`（342-348）、`content_type`（349-355）、slack 的 `channel` 等（357-371）。**全文件中 `Secret` 只出现在 `addHook` 的第 221 行**，`editHook` 从不赋值 `w.Secret`。随后 `webhook.UpdateWebhook` 用 `AllCols().Update(w)` 写回（`models/webhook/webhook.go:309-312`），写的是从库里读出的旧 `Secret`。

因此请求体里带 `config.secret` 会被静默忽略，HTTP 仍回 200 与更新后的 hook。**轮换 secret 只能删旧 hook 再建新 hook**（先 POST 新的、确认成功后 DELETE 旧的，避免出现无 hook 的窗口）。

其余字段的部分更新语义（同一函数）：

| 字段 | 省略时的行为 | 依据 |
| --- | --- | --- |
| `config.url` | 保留原值 | 342-348 行按 key 是否存在判断 |
| `config.content_type` | 保留原值 | 349-355 行同上 |
| `config.secret` | 永远保留原值（不可改） | 全函数无赋值 |
| `events` | **重置**：空数组回落为 `["push"]` | 375 行无条件 `updateHookEvents(form.Events)` |
| `branch_filter` | **清空为 `""`** | 379 行无条件赋值 |
| `authorization_header` | **清空** | 381 行无条件 `SetHeaderAuthorization` |
| `active` | 保留原值（指针） | 392-394 行 |
| `name` | 保留原值（指针） | 396-398 行 |

`PushOnly` / `SendEverything` 被强制置 false、`ChooseEvents` 置 true（376-378 行）。

**面板必须把 PATCH 当成「events / branch_filter / authorization_header 三项的全量覆盖」**：只想改 secret 而不动 events 做不到；只想改 url 而不动 events，也必须把完整 events 一并回传。

---

## 5. 删除的幂等性

**不幂等：重复删同一个 hook 回 404。**

`repo.DeleteHook`（`routers/api/v1/repo/hook.go:299-307`）调 `webhook.DeleteWebhookByRepoID`；后者先 `GetWebhookByRepoID`，查不到就返回 `ErrWebhookNotExist`（`models/webhook/webhook.go:336-341, 263-272`），handler 据此走 `ctx.APIErrorNotFound()`。

- 首次删除：`204 No Content`，空 body。
- 再次删除：`404`，body 由 `services/context/api.go:253-273` 生成：

```json
{"message":"not found","url":"<AppURL>/api/swagger","errors":null}
```

实例探测印证（`GET .../hooks/999999`，同一个 `APIErrorNotFound` 分支）：

```
{"message":"not found","url":"https://gitea.example.com/api/swagger","errors":null}
HTTP 404
```

面板删除时把 404 当成「已达成目标状态」处理即可。

---

## 6. 三种失败情形

错误体统一是 `APIError`（`services/context/api.go:68-73`）：`{"message": string, "url": string}`；`APIErrorNotFound` 额外带 `errors`。

### 6.1 权限不足

路由中间件按 `reqToken()` → `reqAdmin()` → `reqWebhooksEnabled()` 顺序执行（`routers/api/v1/api.go:1257`），另有整个 `/repos` 组的 token scope 校验（`api.go:1504`）。

| 情形 | 状态码 | `message` | 依据 |
| --- | --- | --- | --- |
| 未认证 | 401 | `token is required` | `api.go:366-374` |
| token 缺 `repo` scope | 403 | `token does not have at least one of required scope(s), required=..., token scope=...` | `api.go:347`、`api.go:1504` |
| 非仓库 admin | 403 | `user should be an owner or a collaborator with admin write of a repository` | `api.go:435-440` |
| 实例禁用 webhook | 403 | `webhooks disabled by administrator` | `api.go:624-632` |

**面板需要的最低权限是仓库 admin**（`IsUserRepoAdmin`），仅有 write 不够。

### 6.2 同 URL 的 hook 已存在

**不是错误：回 201，产生第二条 hook。**

`CreateWebhook` 是无条件 insert（`models/webhook/webhook.go:233-236`）：

```go
func CreateWebhook(ctx context.Context, w *Webhook) error {
    w.Type = strings.TrimSpace(w.Type)
    return db.Insert(ctx, w)
}
```

`Webhook` 表的 xorm 标签里 `URL` 是纯 `TEXT`、无唯一索引（`models/webhook/webhook.go:124-144`），`addHook` 也不做重复检查（`routers/api/v1/utils/hook.go:201-271`）。swagger 未为 `repoCreateHook` 声明 409。

**面板必须自己做幂等**：先 `GET .../hooks`，按 `config.url` 匹配已有 hook，命中则 PATCH（或跳过），未命中才 POST。否则重试会堆出重复 hook 与重复投递。

### 6.3 URL 被 `webhook.ALLOWED_HOST_LIST` 拒绝

**创建阶段不校验，API 回 201。**

`ALLOWED_HOST_LIST` 只在投递侧生效：`services/webhook/deliver.go:311-339` 的 `Init()` 里解析成 `hostmatcher.HostMatchList`，装进 HTTP client 的 `Proxy` 与 `DialContext`（325-326 行）；拒绝时的错误文案在 `deliver.go:300-303`：

> `webhook can only call allowed HTTP servers (check your %s setting), deny '%s'`

配置读取见 `modules/setting/webhook.go:37`；未配置时回落为 `hostmatcher.MatchBuiltinExternal`（`deliver.go:316-318`），即默认禁止内网/回环地址。

创建路径上唯一的 URL 校验是 `IsValidURL`（`utils/hook.go:97-100`），只看 scheme 与端口，不看 host 白名单。所以：

- `POST` 回 201，hook 建成。
- 拒绝只体现在投递失败的 hook task 上，走 Gitea 日志与 Web UI 的投递历史。
- `POST .../hooks/{id}/tests` 也测不出来：它只入队就回 204（`routers/api/v1/repo/hook.go:180-196`），投递是异步的。
- API 的 `Hook` 结构里**没有 last_status / 投递结果字段**（`modules/structs/hook.go:19-44`），v1.26 也没有列 hook task 的 REST 端点。

**面板无法通过 API 感知 `ALLOWED_HOST_LIST` 拒绝。**建议把它写进部署前置条件（与 `src/AGENTS.md:40` 已记录的「订阅必须含 `pull_request_sync`」同类），并依赖「面板长时间收不到 webhook」作为间接信号。

### 6.4 其余 422（swagger 未声明）

`routers/api/v1/utils/hook.go:82-102` 与 `340-355` 会回 `422 Unprocessable Entity`：

- `Invalid hook type: <type>`
- `Missing config option: url` / `Missing config option: content_type`
- `Invalid content type`
- `Invalid url`

---

## 7. 列 hook 时是否回显 secret

**不回显。**

序列化走 `services/webhook/general.go:394-425` 的 `ToHook`，`config` 只塞两个键：

```go
config := map[string]string{
    "url":          w.URL,
    "content_type": w.ContentType.Name(),
}
```

slack 类型额外加 `channel` / `username` / `icon_url` / `color`（399-405 行）。**`w.Secret` 从不写入返回值**，`api.Hook` 结构里也没有 secret 字段（`modules/structs/hook.go:19-44`）。`authorization_header` 反而会解密后回显（`general.go:407-410, 420`）。

实例探测印证 —— 目标 hook 配了 secret（本服务 `src/webhook/server.ts:103` 在验签），但 `GET .../hooks` 的 `config` 只有两个键：

```json
"config":{"url":"https://review.example.com/webhook","content_type":"json"}
```

**面板不能从 Gitea 读回已配置的 secret。**面板要展示或复用 secret，只能自己持久化；要展示「是否已配置」，也只能靠自己的记录，Gitea 侧不提供。

另注：`api.Hook.URL` 的 json 标签是 `"-"`（`modules/structs/hook.go:29`），顶层不出现 `url`；投递目标地址只在 `config.url` 里。

---

## 8. bot 对仓库的权限查询（hook 管理模块补充）

hook 端点全部挂在 `reqAdmin()` 后（第 1 节的路由注册，`api.go:1257`），注册前要先验 bot 是不是仓库 admin。查询走 `GET /api/v1/repos/{owner}/{repo}`，返回体里带当前认证用户的权限：

- `modules/structs/repo.go:88` — `Permissions *Permission \`json:"permissions,omitempty"\``；
- `modules/structs/repo.go:12-13` — `type Permission struct { Admin bool \`json:"admin"\` ... }`；
- `services/convert/repository.go:41-42` — `Admin: permissionInRepo.AccessMode >= perm.AccessModeAdmin`，即「owner 或 admin 协作者」。

bot 看不到仓库（不存在或非协作者）时该端点回 404，与「非 admin」是两种不同的缺失，拒绝话术要分开。

另注：列表分页的 `limit` 会被实例的 `API.MAX_RESPONSE_ITEMS`（默认 50）钳住，「返回不满 limit」不能当作最后一页，翻页要以空页收尾。

## 未找到依据的项

无。第 1-8 条均有 `release/v1.26` 源码依据，其中第 3、5、7 条另有目标实例的只读探测印证。
