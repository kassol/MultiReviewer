# GitHub 实现暂时封存

ADR 0002 与 0005 把 GitHub 定为开发阶段的测试平台,forge adapter 因此有两个实现。到 2026-08-25 线上验证已经在 Gitea 上进行,GitHub 没有真实需求。因此封存 GitHub 实现:现有代码保留、不删除,但新增的 Forge 能力(ADR 0012 的建分支、建 PR、改状态、删分支等)只做 Gitea 实现,GitHub 侧不补,`Forge` 接口仍按 Gitea 能力定义。重新启用的条件是出现真实的 GitHub 仓库需求;届时按当时的接口补齐 GitHub 实现即可,封存期间不为它保留兼容层。

## Consequences

- 需要 GitHub 的既有测试(`MULTIREVIEWER_LIVE_PR` 对真实 GitHub PR 的验证)不再是验收依据,线上验证以 Gitea 为准。
- 新增 Forge 方法在 GitHub 实现里可以直接抛「未实现」,不算缺陷。
