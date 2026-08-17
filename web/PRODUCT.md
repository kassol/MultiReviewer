# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

主用户有两类，共用这一套面板，不拆成两个产品。

- **操作员**：部署并管理 MultiReviewer 的人。注册仓库、轮转 Key、配模型凭据与模型组合、核对 hook、看 Review Run 是否在跑。
- **团队负责人**：看处置率与模型表现，判断哪家 Reviewer 值得留。不负责日常配置，但会常来这一面。

打开面板时第一件必须做成的事是确认**服务健康**：审查在跑、hook 没漂、模型没挂。配置与质量观察排在健康之后。登录后落到评审记录（`/runs`），不再落到仓库。健康信号只留在相关页：Run 失败在评审记录，hook 在仓库，凭据在凭据页。一天打开几次，密度按扫读来。

## Product Purpose

MultiReviewer 对 pull request 做多模型并行代码审查。审查挂在 Gitea 的 PR 上，以行级 review 评论呈现。

这套面板是服务的操作面与观察面。Gitea 只给人看评论；面板回答服务本身是否健康、配置是否齐、审查质量是否站得住。成功的标准是：操作员一眼能判断该不该动手，负责人一眼能判断哪家模型在产出可处置的 Finding。

## Positioning

这是唯一能把「审查机器的健康」和「Finding 的处置」放在同一处看见的界面。Gitea 看不见 hook 代次、模型凭据、缺席 Reviewer 和按 Finding Identity 折叠的处置率；厂商控制台看不见本服务的仓库准入与 Review Run。

## Operating Context

- 目标平台是公司内部 self-host 的 Gitea；开发阶段用 GitHub 作适配层测试，面板准入只有 Gitea。
- 部署形态是 Docker。面板与 JSON API 同进程，路径挂在随机的面板前缀下；真正的门禁是 admin token 与会话 cookie。
- 界面语言是中文。领域术语以仓库根 `CONTEXT.md` 为准，代码、文案、沟通用同一套词。
- 日常场景是内网桌面浏览器；窄视口要可用，但不是主要工作面。

## Capabilities and Constraints

已有功能（信息结构与行为本轮不改，只换视觉世界）：

- 登录：admin token 换会话。
- 仓库：搜索注册、移除、Key 代次与核对 / 轮转、每仓库模型覆盖、从仓库详情重跑指定 PR。
- 评审记录：跨仓库 Review Run 时间流、部分失败可见、逐条重跑。
- 处置率：模型 × 分类矩阵，口径是 Finding Identity，每格带分子分母。
- 模型凭据：按 provider 一把，只写不回显。
- 全局设置：模型组合与批次上限。

技术约束：

- 现有栈：Vite + React 19 + TanStack Router/Query + Tailwind v4 + shadcn（Radix）。构建产物经 `/assets` 提供，产物不得含面板前缀。
- 只做亮色一套（issue #46）。
- 前端不做程序化测试（issue #26）；逻辑压在服务端契约上。
- 写样式只有 Tailwind utility 一条路；`styles.css` 只放令牌。
- 不用 `window.confirm`：原生对话框会卡住浏览器自动化。
- Key 与模型凭据的明文从不回显到前端。

未决（本轮不发明）：

- 自定义 OpenAI-compatible provider 尚未开 spec。
- OpenRouter 模型目录不全，操作员选择自行换模型，本轮不扩目录。

## Brand Commitments

- 产品名：MultiReviewer。
- 现有青色主色（`--primary: #0e7490` 及其衍生）被明确否定，新视觉世界不得沿用它当主色。
- 上一轮收成的「密控制台」视觉被判定为不够产品，本轮是换世界，不是在那套色上再抛光。
- 站在流行产品一侧：手艺上限是 GitHub、Linear、Vercel。熟悉的后台语法（侧栏、页头、表、主按钮），做到这三家的完成度。不发明新交互，不抄任何一家的布局或品牌色。

## Evidence on Hand

- 可运行的六面：登录、仓库、评审记录、处置率、模型凭据、全局设置。
- 真实部署数据在 `00-test` 上，含已注册仓库、真实 hook / 代次、Review Run 与处置率。
- 没有品牌手册、摄影、插画或营销文案。后续工作不得编造客户、证言、基准数字或定价。

## Product Principles

1. **先回答健康。** 打开面板，第一眼必须能判断审查在不在跑、hook 有没有漂、模型有没有挂。
2. **两类人共用一面。** 操作员与负责人看同一套页面；用层级把「现在要不要动手」和「哪家模型值得留」分开，不拆产品。
3. **词就是产品。** 文案只用 `CONTEXT.md` 的术语，不另造同义词。
4. **不编造。** 数字、状态、空状态都来自真实 API；缺数据就写清下一步做什么。
5. **亮色、可扫、可对照。** 只维护一套亮色；文字对比度按 WCAG AA。

## Accessibility & Inclusion

WCAG AA：正文与三态色在面板实际用到的底色上对比度 ≥ 4.5:1。
