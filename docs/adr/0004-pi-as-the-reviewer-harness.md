# Reviewer 的底层 harness 采用 Pi

Reviewer 需要一个能非交互驱动、可绑定任意厂商模型、且能被限制为只读的 agent harness。候选中 Claude Code 的结构化输出最强,但许可是专有的且只能跑 Claude 模型,不适合一个要被其他公司自托管的开源产品;Codex CLI 的 read-only 是默认值,但接非 OpenAI 模型需要兼容层。选定 [Pi](https://github.com/earendil-works/pi)(`@earendil-works/pi-coding-agent`,MIT):内置工具为 `read, bash, edit, write, grep, find, ls`,`--tools` 与 SDK 的 `tools` 参数是允许清单,未列出的工具不会注册。

## Consequences

- Pi 以 SDK 方式嵌入编排服务,不外调 CLI。技术栈随之确定为 TypeScript / Node。
- 只读有两个层次,不可混为一谈:工具允许清单取 `["read","grep","find","ls"]`,使模型没有写入的调用路径;进程本身的文件、网络与凭据访问由执行环境约束,Pi 自身不提供权限系统。
- Pi 没有结构化输出的 schema 机制。Finding 的结构通过 `customTools` 定义一个 `report_finding` 工具来强制,Reviewer 每提出一条 Finding 即调用一次,编排层收集这些工具调用。
- 模型绑定通过每个 Reviewer 实例各自的 `--model` 或 SDK 的 `model` 参数完成,凭据可用 `modelRuntime.setRuntimeApiKey()` 在运行时注入。

## Reviewer 的执行环境

每个 Reviewer 运行在编排服务 fork 出的独立子进程中,而非编排进程本身。边界定在单个 Reviewer 而非整个服务,原因是编排进程持有 forge 凭据与全部厂商的模型凭据,而 Reviewer 读取的 PR diff 属于半可信输入——它可以携带指向 agent 的注入指令。工具允许清单使模型没有写入与执行的调用路径,凭据分割则使这条路径即便存在也取不到不属于该 Reviewer 的凭据。

- 子进程的环境变量只包含该 Reviewer 绑定的那一家厂商的模型凭据,不含 forge 凭据,也不含其他厂商的凭据。
- 子进程的工作目录指向工作副本,`report_finding` 的结果经进程间通信回传编排层。
- 子进程的退出码是 Reviewer 失败的显式信号,优先于会话内的错误检查——进程异常终止时,会话状态根本读不到。
- 需要给 Reviewer 开放 `bash` 时,隔离必须同步升级到每个 Reviewer 一个容器(egress 白名单加只读挂载)。子进程与容器的分界不在安全强度的高低,而在是否开放 `bash`。

### Considered Options

[agentOS](https://github.com/rivet-dev/agentos)(Apache-2.0)提供进程内的虚拟 POSIX 内核,每个 agent 一个 VM,网络 egress 默认拒绝,并原生支持 Pi。它被评估并否决,三条理由:

- 其 Pi 集成 `@agentos-software/pi` 钉死 `@mariozechner/pi-coding-agent@0.60.0`,该 scope 已被上游标记废弃(npm 上的提示为 `please use @earendil-works/pi-coding-agent instead going forward`),而本项目采用的 `@earendil-works` scope 仍在活跃发布。
- 其 Pi 集成经由 ACP 驱动,`customTools` 由 agentOS 内部填充,ACP 的 `NewSessionRequest` 没有宿主注入工具定义的字段,`report_finding` 因此无处挂载。绕开 ACP 意味着自行实现宿主与 VM 之间的跨边界协议并自行维护一份 adapter。
- 承载沙箱能力的 `@rivet-dev/agentos-core` 被官方声明为仅作传递依赖发布、不支持直接安装,且引入原生模块与一个独立的 sidecar 进程,与"可被其他公司简单自托管"这一目标相悖。

## 由 prototype 验证的约束

一次 spike 在 anthropic、deepseek、google、z-ai 四家厂商的模型上跑通了 `report_finding` 机制,产出 25 条结构完整的 Finding,零畸形,且全程只暴露 `read, grep, find, ls, report_finding`,fixture 文件无一被修改。原型保存在 `prototype/report-finding` 分支,细节见该分支的 `prototype/report-finding/README.md`。它确立了两条硬约束:

- **枚举字段必须在自身的 `description` 里写明允许值。** 仅用 `Type.Union` 罗列字面量时,模型会自造词汇(`critical` / `major`、`reliability` / `logic_error`),Pi 逐条拒绝,而模型连续收到校验错误也不改正,正确的 Finding 因此全部丢失。写明允许值后模型原生就用对了词。服务端另留一张归一化映射表兜底。
- **Reviewer 的失败是静默的。** 模型调用失败时 `session.prompt()` 仍正常返回,错误只出现在 `session.agent.state.errorMessage` 或最后一条消息的 `stopReason === "error"`;被拒的工具调用只表现为 `tool_execution_end` 携带 `isError`。编排层必须同时检查这两处,否则一个失效的 Reviewer 会静悄悄贡献零条 Finding,而 Review Run 看起来是完整的。

同一份 fixture 上四个模型分别给出 3、5、4、13 条 Finding,跨模型差异极大,这是去重层存在的经验依据;其中 13 条那一组包含大量低严重度的主观条目,是全面审查这一职责边界的既定代价。
