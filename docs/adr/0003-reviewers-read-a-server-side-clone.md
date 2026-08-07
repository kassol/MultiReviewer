# Reviewer 读服务端 clone 的工作副本

Reviewer 需要打开文件、跟随调用链,取代码的方式有两种:服务端 clone 后 checkout 到目标 commit,或每次读文件都调 Gitea API。现成的 coding agent harness 其工具集普遍假设存在本地文件系统,走 API 取文件意味着为每一种 harness 重写一层工具适配,并因此限制 harness 的可选范围。因此服务端 clone 仓库并 checkout 到 Review Range 的结束 commit,Reviewer 以只读方式访问该工作副本。

## Consequences

- 服务端需要磁盘空间与仓库缓存策略,以及一份可 clone 的只读凭据。
- 只读必须由执行环境强制,不能只靠提示词约束。
- harness 的可选范围因此保持开放:任何能在本地目录上跑的 agent 都是候选。
