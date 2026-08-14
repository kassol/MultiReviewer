# 处置率按同一处 Finding 计,靠回填补齐

`finding.disposition` 只在落库那一刻写一次,取的是本轮匹配到的历史评论的 resolve 状态,此后再无更新。首次报出的一律记 `unknown`;人 resolve 了评论、作者也改了代码的那一条,下一轮不会被重新报出,于是永远不留下 `resolved` 行。直接拿 `finding` 表算比率,等于用一个只收录「被 resolve 但代码没改」的样本去衡量审查质量,同时又按来源行计数,让活得久的 Finding 被反复计入分母。因此处置率不建在原始行上:分母的单位是 **Finding Identity**,disposition 由一条回填链路从 Forge 补齐。

处置率是 Disposition 的派生度量,不是新的领域概念,故不在 `CONTEXT.md` 立词条。它衡量「人看过并做了结论」,不衡量「问题被修复」——resolve 状态证明不了后者。

## Considered Options

- **承认现有口径,只统计已知处置的子集。**零新增机制,但把「还没人看」与「看过不认可」混为一谈,且系统性低估那些提出的问题真被修掉了的模型——恰好是最该被选中的那些。
- **面板只展示原始计数,不展示任何比率。**回避了口径问题,也回避了面板存在的理由:多模型选型需要的就是这个比率。

## Consequences

- **回填在两个时机跑,都不新增 API 调用。**每轮 Review Run 已经读回全部历史评论及其 resolve 状态(`src/review/run.ts:326`),现在用完即弃,改为顺手回写;PR 关闭时再全量回填一次,那是最接近终态的时刻。`pull_request` 事件的 `closed` action 现在被 `src/webhook/server.ts:80` 的 `ACTIONS` 表丢弃,只需补一格映射,webhook 订阅不动。Gitea 没有 resolve / unresolve 专属事件(`docs/research/gitea-webhook-api.md:104` 枚举的 8 个 PR 事件里没有),回填只能这样拉。
- **回填以 Forge 的最新状态为准,覆盖已有值。**人先 resolve 后又 unresolve 时,库里跟着改。
- **同一处 Finding 的键是 pull request + 模型 + 文件 + 内容指纹。**指纹是全局的内容哈希,不带 pull request 限定会把不同 pull request 里的同一段代码误合并;不带模型就算不出「哪个模型靠谱」,而那是面板存在的理由。指纹算不出来的行(模型报的路径指不到文件)没有折叠键,各算一条。
- **代码一改指纹就变,于是算作新的一条。**作者改了但没改对、问题再次被报出时,分母加一。这是刻意的:那确实是一次新的、独立的处置机会。
- **fallback Finding 排除在统计之外。**落在 diff 范围外的 Finding 只能写进 review 正文,而正文没有 resolve 状态可读,`priorDispositions()` 对正文锚点一律按未处置计(`src/review/run.ts:266`)。它们的 disposition 只可能是 `unknown` 或 `unresolved`,算进分母会系统性压低数字,且对爱报 diff 外问题的模型压得更狠。要把它们摘出来,`finding` 表得记住每条当初是进了评论还是进了正文。
- **`unknown` 按 pull request 状态区分。**已关闭 pull request 上仍然 `unknown` 的进分母——到了终态还没人处置,那就是未处置;开放 pull request 上的不进,它还在流程中。`review_run` 因此要加一列记 pull request 状态,由 `closed` 回填顺手写上。
- **面板始终显示原始分子与分母,比率是附属。**`12/15 (80%)` 这种形式,读者自己判断样本够不够。不设隐藏比率的阈值——那个阈值取多少都是拍脑袋。
- **统计维度只有模型 × category 与时间窗两组。**仓库维度等多仓库真的接入再说,severity 与 category 叠加后格子太稀。时间窗按同一处 Finding **首次**报出那一轮的 `started_at` 归属:问题是那时发现的,用末次会让长期未处置的 Finding 一直往当前窗口漂,历史窗口的数还会回溯变动。
- **评审记录的留存期不能短于统计窗口。**处置率算在历史 `finding` 行上,删掉即算不出。面板的时间窗默认最近 30 天,自由起止。
