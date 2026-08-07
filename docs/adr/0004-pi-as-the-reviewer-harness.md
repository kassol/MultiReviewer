# Reviewer 的底层 harness 采用 Pi

Reviewer 需要一个能非交互驱动、可绑定任意厂商模型、且能被限制为只读的 agent harness。候选中 Claude Code 的结构化输出最强,但许可是专有的且只能跑 Claude 模型,不适合一个要被其他公司自托管的开源产品;Codex CLI 的 read-only 是默认值,但接非 OpenAI 模型需要兼容层。选定 [Pi](https://github.com/earendil-works/pi)(`@earendil-works/pi-coding-agent`,MIT):内置工具为 `read, bash, edit, write, grep, find, ls`,`--tools` 与 SDK 的 `tools` 参数是允许清单,未列出的工具不会注册。

## Consequences

- 技术栈随之确定为 TypeScript / Node,以便直接嵌入 Pi 的 SDK。
- 只读有两个层次,不可混为一谈:工具允许清单取 `["read","grep","find","ls"]`,使模型没有写入的调用路径;进程本身的文件、网络与凭据访问由容器约束,Pi 自身不提供权限系统。
- Pi 没有结构化输出的 schema 机制。Finding 的结构通过 `customTools` 定义一个 `report_finding` 工具来强制,Reviewer 每提出一条 Finding 即调用一次,编排层收集这些工具调用。
- 模型绑定通过每个 Reviewer 实例各自的 `--model` 或 SDK 的 `model` 参数完成,凭据可用 `modelRuntime.setRuntimeApiKey()` 在运行时注入。
