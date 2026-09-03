# 审查完成与增量评审拆成独立权限格,存量角色不自动补发

「审查完成」(`POST /range-reviews/{id}/complete`)与「增量评审」(`POST /range-reviews/{id}/advance`)上线时图省事,分别搭了 `finding:dispose`(处置)与 `review:create`(发起)的便车——两者当时权限格没占全,顺手复用能跑。但这两个动作与它们借用的权限格语义并不相关:标记审查完成是终止一次范围审查、关闭容器 PR、删两条临时分支,处置的是找出的问题条目;推进比较项是给已发起的范围审查换一批 diff、开新一轮 Review Run,与「发起」是两件事——一个能发起的人不一定该有权把已有审查往前推,一个能处置问题的人也不一定该有权终止审查。权限格共用意味着这两条只能靠调整 `finding:dispose` / `review:create` 的持有面来控制,而这两格还各自绑着别的、真正相关的动作(处置找出的问题;发起新的范围审查),没法只为这两个动作单独收放。因此:新增 `review:complete`(审查完成)与 `review:advance`(增量评审)两个权限格,两条路由各自切换到对应新格,`finding:dispose` / `review:create` 不再蕴含它们,已有角色升级后不自动获得新格。

## Considered Options

- **自动给持有 `finding:dispose` / `review:create` 的存量角色补发新格。**升级瞬间行为不变,管理员无感。但补发即默认「旧权限的持有者理应继续拥有新动作」,这恰好是本次拆分想否定的假设——两个动作的适用面本就该重新评估,静默补发等于替管理员做了这个判断,且补发逻辑本身是一次性代码,过后成为死代码。
- **只拆一半,例如只拆审查完成、增量评审继续挂在 `review:create` 上。**改动更小,但增量评审同样存在「发起权限不该自动覆盖推进权限」的问题,只拆一半留下同样性质的另一个问题不管,不构成理由。
- **不新增权限格,改用 `review:create` + 仓库分配的组合判断谁能推进。**分配机制管的是「对哪个仓库有效」,不是「能做哪类操作」,把动作粒度的权限塞进分配维度会让两套机制的职责边界混起来。

## Consequences

- 权限格由 9 个增至 11 个:`repo:write`、`review:rerun`、`review:create`、`review:complete`、`review:advance`、`finding:dispose`、`knowledge:write`、`model:read`、`model:write`、`credential:read`、`credential:write`。`IMPLIED_PANEL_PERMISSIONS` / `IMPLIED_BY` 不新增条目——两个新格不被任何旧格蕴含,这是拆分本身的目的。
- 升级后,只有系统管理员(`is_system_admin` 旁路不受影响)能点这两个按钮,直到有人手动给某个角色授予 `review:complete` / `review:advance`。这段时间窗口是刻意的:逼一次「谁该有这两个权限」的人工判断,不是缺陷。
- `test/panel-range-review-advance.test.ts` 与 `test/panel-range-review-complete.test.ts` 各补一条负向测试:持有对应旧格但没有新格,请求仍是 403。
- 角色管理界面的 `PERMISSION_INFO`(`web/src/access-control.tsx`)手动维护、不随 `PANEL_PERMISSIONS` 自动生成,需要同步补两行,否则新格在 UI 上不可见、无法授予。
