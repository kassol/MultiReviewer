# Reviewer 的底层 harness 采用 Pi

Reviewer 需要一个能非交互驱动、可绑定任意厂商模型、且能被限制为只读的 agent harness。候选中 Claude Code 的结构化输出最强,但许可是专有的且只能跑 Claude 模型,不适合一个要被其他公司自托管的开源产品;Codex CLI 的 read-only 是默认值,但接非 OpenAI 模型需要兼容层。选定 [Pi](https://github.com/earendil-works/pi)(`@earendil-works/pi-coding-agent`,MIT):内置工具为 `read, bash, edit, write, grep, find, ls`,`--tools` 与 SDK 的 `tools` 参数是允许清单,未列出的工具不会注册。

## Consequences

- Pi 以 SDK 方式嵌入编排服务,不外调 CLI。技术栈随之确定为 TypeScript / Node。所有 Reviewer 运行在编排进程内,进程级隔离由整个服务所在的容器提供。
- 只读有两个层次,不可混为一谈:工具允许清单取 `["read","grep","find","ls"]`,使模型没有写入的调用路径;进程本身的文件、网络与凭据访问由容器约束,Pi 自身不提供权限系统。
- Pi 没有结构化输出的 schema 机制。Finding 的结构通过 `customTools` 定义一个 `report_finding` 工具来强制,Reviewer 每提出一条 Finding 即调用一次,编排层收集这些工具调用。
- 模型绑定通过每个 Reviewer 实例各自的 `--model` 或 SDK 的 `model` 参数完成,凭据可用 `modelRuntime.setRuntimeApiKey()` 在运行时注入。

## 由 prototype 验证的约束

一次 spike 在 anthropic、deepseek、google、z-ai 四家厂商的模型上跑通了 `report_finding` 机制,产出 25 条结构完整的 Finding,零畸形,且全程只暴露 `read, grep, find, ls, report_finding`,fixture 文件无一被修改。原型保存在 `prototype/report-finding` 分支,细节见该分支的 `prototype/report-finding/README.md`。它确立了两条硬约束:

- **枚举字段必须在自身的 `description` 里写明允许值。** 仅用 `Type.Union` 罗列字面量时,模型会自造词汇(`critical` / `major`、`reliability` / `logic_error`),Pi 逐条拒绝,而模型连续收到校验错误也不改正,正确的 Finding 因此全部丢失。写明允许值后模型原生就用对了词。服务端另留一张归一化映射表兜底。
- **Reviewer 的失败是静默的。** 模型调用失败时 `session.prompt()` 仍正常返回,错误只出现在 `session.agent.state.errorMessage` 或最后一条消息的 `stopReason === "error"`;被拒的工具调用只表现为 `tool_execution_end` 携带 `isError`。编排层必须同时检查这两处,否则一个失效的 Reviewer 会静悄悄贡献零条 Finding,而 Review Run 看起来是完整的。

同一份 fixture 上四个模型分别给出 3、5、4、13 条 Finding,跨模型差异极大,这是去重层存在的经验依据;其中 13 条那一组包含大量低严重度的主观条目,是全面审查这一职责边界的既定代价。
