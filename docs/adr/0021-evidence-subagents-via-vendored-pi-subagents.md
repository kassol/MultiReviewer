# 取证子代理:vendor pi-subagents,对空 agentDir 开受控例外

十轮评审复盘里的误报五类根因(未查全局拦截器就断言无认证、未 grep 就断言注解存在、未读持久化调用就断言落库、未考虑发版状态、控制流没读完)共享同一个形状:断言依赖没读过的代码。治它分两层:system prompt 加通用证据链纪律(跨文件的因果主张必须先取证),项目特有判据由知识集的事实注入承载(ADR 0020)。取证的执行体是子代理——它同时买到并行与容量:调用链取证要读大量变更外代码,全部塞进 Reviewer 单会话会吃穿上下文。

Pi 本体不内建 subagent,官方注册表包 pi-subagents 以扩展形态提供完整能力(自定义 agent 锁工具面、递归防护、spawn 预算、后台运行、运行产物)。MultiReviewer 采用它而不自写:把包 vendor 进镜像,每次建 Reviewer 会话时与自定义取证 agent 定义一起铺进该会话的临时 agentDir。这对「空 agentDir 隔绝宿主扩展」的既有隔离模型开一个受控例外:铺进去的内容由镜像构建时固定,不来自宿主机运行环境,隔离所防的「宿主全局扩展与凭据渗入」仍然成立。

取证子代理的约束:禁用 pi-subagents 全部内置 agent(worker 能写文件、researcher 要联网,审查环境不该有),只铺一个自定义取证 agent——只读四件套(read/grep/find/ls)、与 Reviewer 同模型同凭据同思考档位、工具面里没有取证工具本身(单层,天然不递归)、没有 report_finding(取证只交证据,报不报由 Reviewer 裁决)。`maxSubagentSpawnsPerRun` 收紧到 8:取证是针对存疑 Finding 的定向动作,单轮超过 8 次说明在滥派。子会话全量接入审查轨迹,嵌套呈现,面板可展开取证过程。

## Considered Options

- **只靠 prompt 纪律,不派子代理。**纪律解决「要不要核」,解决不了「核得动」:长调用链的取证量单会话装不下,也无并行可言。
- **自写 customTool 进程内嵌套 createAgentSession。**零新依赖、不动隔离模型,但超时、输出截断、并发控制、观测产物全要自建自维护,而这些恰是 pi-subagents 已经打磨的部分。
- **装社区 npm fork(@tintinweb 等)。**与官方注册表包同源,舍源头取分叉没有理由。

## Consequences

- 镜像构建新增 vendor 步骤;pi-subagents 跟版策略同 Pi 本体:按需升级、过差异、跑全量测试。
- 取证半径与落点分离成为明文约束:子代理可读全仓库,`report_finding` 的锚点必须落在 diff hunk 内(锚定收敛,见 ADR 0006 修订附记),锚不进的打回重锚,仍不进则丢弃并记轨迹,原 body 降级路径退役。
- 子会话 token 用量并入所属 Reviewer 的统计。
- 审查轨迹的事件模型要容纳嵌套来源(取证子会话),面板轨迹视图相应扩展。
