# 轮次级失败原因与 Reviewer 失败分开记

`review_run.failed` 的含义是「本轮全部 Reviewer 失败」,ADR 0016 据它决定不做自动处置与延续。轮次的失败原因目前没有自己的位置:改判中断轮次(issue #247)借 Reviewer 指定逐条写 `reviewer_outcome.failure`,零 pin 的轮次改判后原因不落任何行;Reviewer 全部成功、收尾阶段失败的轮次(发布 review 失败,ADR 0025;续跑计划不符,issue #253)则连 `failed` 都不能置 1——那会把「审查完成但没发出去」当成「模型没审」。

选定的做法:**`review_run` 加一列轮次级失败原因**,NULL 即收尾正常。它只回答「这一轮为什么没有正常收尾」,与 Reviewer 结果、`failed` 列、Finding 行互不覆盖:发布失败的轮次 Reviewer 结果与 Finding 照常落库,`failed` 仍按 Reviewer 结果算,失败原因写在这一列;改判中断轮次同时写这一列与既有的逐 pin outcome 行。轨迹多一档 Run 级事件 `run_failed`,带同一句原因。面板的轮次列表与详情读这一列。

## Considered Options

- **复用 `failed = 1`。**污染 ADR 0016 的判据:发布失败那一轮的 Reviewer 结论是有效的,下一轮不该因它而不做自动处置;统计上也把「模型审了」记成「模型没审」。
- **继续借 `reviewer_outcome.failure`。**零 pin 的轮次无行可写;Reviewer 成功后那些行已经是真实结果,不能再覆盖成失败。
- **只记轨迹事件,不落列。**轨迹记的是过程,处置与统计不读它(`CONTEXT.md` 审查轨迹);轮次列表要按失败筛选与显示原因,得有列。

## Consequences

- schema 迁移加一列;升级前的轮次为 NULL,读回即「无失败记录」。
- 启动续跑的选择条件不变(`finished_at IS NULL`);失败原因列不参与它。
- `failInterruptedRuns` 多写一列;零 pin 轮次从此也有原因。
- 面板轮次详情与时间线多一处失败原因的呈现;轮次列表能区分「完成」「Reviewer 失败」「收尾失败」三态。
