# 取证子代理:vendor pi-subagents,对空 agentDir 开受控例外

十轮评审复盘里的误报五类根因(未查全局拦截器就断言无认证、未 grep 就断言注解存在、未读持久化调用就断言落库、未考虑发版状态、控制流没读完)共享同一个形状:断言依赖没读过的代码。治它分两层:system prompt 加通用证据链纪律(跨文件的因果主张必须先取证),项目特有判据由知识集的事实注入承载(ADR 0020)。取证的执行体是子代理——它同时买到并行与容量:调用链取证要读大量变更外代码,全部塞进 Reviewer 单会话会吃穿上下文。

Pi 本体不内建 subagent,官方注册表包 pi-subagents 以扩展形态提供完整能力(自定义 agent 锁工具面、递归防护、spawn 预算、后台运行、运行产物)。MultiReviewer 采用它而不自写:把包 vendor 进镜像,每次建 Reviewer 会话时与自定义取证 agent 定义一起铺进该会话的临时 agentDir。这对「空 agentDir 隔绝宿主扩展」的既有隔离模型开一个受控例外:铺进去的内容由镜像构建时固定,不来自宿主机运行环境,隔离所防的「宿主全局扩展与凭据渗入」仍然成立。

取证子代理的约束:禁用 pi-subagents 全部内置 agent(worker 能写文件、researcher 要联网,审查环境不该有),只铺一个自定义取证 agent——只读四件套(read/grep/find/ls)、与 Reviewer 同模型同凭据同思考档位、工具面里没有取证工具本身(单层,天然不递归)、没有 report_finding(取证只交证据,报不报由 Reviewer 裁决)。`maxSubagentSpawnsPerRun` 收紧到 8,作用域是一个 Reviewer 子进程的一次会话(即一个批次):Reviewer 按批次各起一个进程,一轮 Review Run 的总取证上限因此是 8 × 批次数 × Reviewer 数——有界且与工作量成正比,预算防的是单会话滥派,不是跨批次的总量配额。子会话全量接入审查轨迹,嵌套呈现,面板可展开取证过程。

## Considered Options

- **只靠 prompt 纪律,不派子代理。**纪律解决「要不要核」,解决不了「核得动」:长调用链的取证量单会话装不下,也无并行可言。
- **自写 customTool 进程内嵌套 createAgentSession。**零新依赖、不动隔离模型,但超时、输出截断、并发控制、观测产物全要自建自维护,而这些恰是 pi-subagents 已经打磨的部分。
- **装社区 npm fork(@tintinweb 等)。**与官方注册表包同源,舍源头取分叉没有理由。

## Consequences

- pi-subagents 是取证子代理的唯一实现路线,Considered Options 里的自写方案不是退路(评审复核 2026-08-31):headless SDK 会话下的加载验证若不成立,该实现阻塞并回到决策,允许在 pi-subagents 路线内调整铺装方式反复尝试,不自动改道任何替代实现。
- vendor 的实现形态是普通运行时依赖(package.json 钉版),镜像里既有的 `pnpm install --prod --frozen-lockfile` 即完成装载,运行时不联网装包;不需要单独的镜像构建步骤。pi-subagents 跟版策略同 Pi 本体:按需升级、过差异、跑全量测试。
- 取证半径与落点分离成为明文约束:子代理可读全仓库,`report_finding` 的锚点必须落在 diff hunk 内(锚定收敛,见 ADR 0006 修订附记),锚不进的打回重锚,仍不进则丢弃并记轨迹,原 body 降级路径退役。
- 子会话 token 用量并入所属 Reviewer 的统计。
- 审查轨迹的事件模型要容纳嵌套来源(取证子会话),面板轨迹视图相应扩展。

## 修订(2026-09-03)

上文「`maxSubagentSpawnsPerRun` 收紧到 8,作用域是一个 Reviewer 子进程的一次会话(即一个批次),一轮 Review Run 的总取证上限因此是 8 × 批次数 × Reviewer 数」不成立。pi-subagents 里 `maxSubagentSpawnsPerRun`(`PI_SUBAGENT_MAX_SPAWNS_PER_RUN`)限的是一次 `subagent` 调用内部的 fan-out——一个 run tree 的累计子任务数,每次调用重新计数;一个父会话的累计派单总量由 `maxSubagentSpawnsPerSession`(`PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`)管,本项目此前未设,默认不限。线上 Review Run #54 因此每批每模型可无限次串行取证:`gpt-5.6-sol` 一轮派出 79 次,串行等待累计 151 分钟,占它总耗时的一半。

两道上限自此分工明确(issue #231):会话级 `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = 3` 管总量,作用域是一个 Reviewer 子进程的一次会话,即每批每模型最多派 3 次取证,一轮 Review Run 的总取证上限是 3 × 批次数 × Reviewer 数;单次调用的 `PI_SUBAGENT_MAX_SPAWNS_PER_RUN = 8` 保留,管的是一次调用扇出多宽。名额稀缺是模型要知道的事,系统提示的取证段因此写明:名额有限,留给最高严重度、且不读对方代码就不能成立的主张。

## 修订(2026-09-05)

会话级上限改为审查策略的一项(issue #258):「每批每模型取证上限」与分批上限、批次并发数并列,正整数、各自保存各自版本,系统默认仍是 3——上文的 `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION = 3` 从此读作「默认 3」。Review Run 开跑时把它与其余上限在同一次读事务里冻进运行计划,Reviewer 子进程按计划里的值设会话上限;中途改设置只影响下一轮。单次调用的 `PI_SUBAGENT_MAX_SPAWNS_PER_RUN = 8` 不进策略,保持写死。改成可调的理由:合理值只能实测——线上 Run #66 / #67 里 sol 每批固定想派 4 次,第 4 次撞上限,opus 一轮只派 1 次,写死的 3 无从验证是紧是松。
