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

## 修订(2026-09-05,issue #262)

Pi 升到 0.85.0、pi-subagents 升到 0.65.1。pi-subagents 0.65 起前台子代理的执行体从「另起一个 `pi` 进程」改成「父进程内的原生 `AgentSession`」:取证子会话跑在 Reviewer 子进程里,与父会话同进程、同环境、同一份 `process.env`;它自己按 agentDir 建一份模型运行时(仍读 `<agentDir>/models.json`,凭据仍是环境变量引用),完成、取消、超时后由 pi-subagents 先发 `session_shutdown` 再 `dispose`,Reviewer 子进程收尾时显式退出,活动会话不会活过那次 Review 调用。上文「子代理跑在另一个 pi 进程里」的表述自此作废;Reviewer 与服务主进程之间的子进程隔离不变,取证子会话不越过它。

同进程带来三处要在 pi-subagents 路线内重新铺装的地方,取证契约本身(只读四件套、唯一 agent `evidence`、单层不递归、无 `report_finding`)一字未改:

- **intercom 桥默认开着,会给子会话追加 `contact_supervisor`。**它是父子会话通话用的,不在契约里。桥的开关在 `<agentDir>/extensions/subagent/config.json`,而这份 config 在扩展注册时读一次并捕获——铺装因此必须在扩展首次加载之前完成(`prepareAgentRuntime` 的 `installKit`,在模型运行时建好之后、`resourceLoader.reload()` 之前)。调用参数又能整份覆盖这份 config,所以工具边界另有一道:与 pi-subagents 同一批装进会话的进程内扩展在 `subagent` 的 `tool_call` 钩子里把 `intercomBridge` 钉成 `off`、`async` 钉成 `false`。
- **能力天花板不再走环境变量。**0.65.1 不读 `PI_SUBAGENT_CAPABILITY_CEILING_V1`,天花板改按父会话 id 登记进 pi-subagents 的进程内登记表(`globalThis[Symbol.for("pi-subagents.capability-ceiling.v1")]`),同一道 `tool_call` 钩子在派出之前登记。不登记的话,被审仓库自带的 `.pi/agents/*.md` 就派得出去——这一条由真实 SDK 回归钉住。
- **模型排除表关进会话的 agentDir。**子会话的模型调用以可重试原因失败(连接错误、429、5xx、额度)时,pi-subagents 把该模型记进一份默认 24 小时的排除表,默认落在 `os.tmpdir()/pi-subagents-uid-<uid>/`,全机同 uid 共用——一批里的一次瞬时失败会让之后每一轮的每一次取证都被拒到过期。`PI_MODEL_EXCLUSIONS_PATH` 指到这次会话的 agentDir,失败只影响这一批。这一条在 0.59.0 就成立,升级时的回归实测暴露出来。

三道锁的每一道都有反向验证:去掉任一道,对应的真实 SDK 用例失败。

## 修订(2026-09-15,issue #328)

**取证子会话的只读四件套换成 Reviewer 那一份,能力天花板放开 `denyExtensions`,由工具边界补回。**

- **起因。**Reviewer、规则 agent 与合并 agent 的 grep / find / ls 已圈在工作副本上,取证子会话没有:pi-subagents 建子会话时不带 `customTools`,四件套是 Pi 内建原版,绝对路径与 `~` 随便读。Pi 扩展的 `registerTool` 同名注册能盖过内建,但 pi-subagents 给前台子会话装扩展只认 agent 定义里的 `extensions`,而天花板的 `denyExtensions` 会把它清空;另一个入口 `setChildSessionFactory` 是 jiti 模块内的变量,本进程拿不到。
- **做法。**`<agentDir>/evidence-tools.ts` 由本项目生成,import `worker-tools.ts` 的 `sessionReadOnlyTools`,工作副本根写死;`evidence.md` 的 `extensions` 指向它;天花板 `denyExtensions: false`,`allowedTools` 与 `allowedAgents` 不动。
- **补回的那一道。**`denyExtensions` 原本挡的是被审仓库自带定义里的扩展——关掉之后,默认发现范围 `both` 下仓库 `.pi/agents` 里同名的 `evidence.md` 优先,带上 `extensions` 就在 Reviewer 进程里执行仓库的代码(真实 SDK 回归实测复现)。工具边界的钩子因此把 `agentScope` 钉成 `user`、`cwd` 在顶层与 `tasks[]` / `chain[]`(含 `parallel`)钉成工作副本,调用参数只放行派单与超时要用的几项,其余整次打回:`action` 能改写 agent 定义,`workflow` 脚本的子任务各自带发现范围与 cwd,钉不到。

## 修订(2026-09-15,pi-subagents 0.68.0)

**pi-subagents 升到 0.68.0,源码只删不加。**

- **为什么是这一版。**0.67.0 的 `getHostBuiltinToolNames` 只认宿主注册表里来源为 `builtin` 的工具,Reviewer 自定义的同名 `read` 把那一条的来源改成 `sdk`,取证子会话的 `read` 会被静默剪掉(`docs/research/pi-subagents-0.67-2026-09-12.md`),因此跳过 0.67.0。0.68.0 把判定改成「来源是 builtin,或名字在 Pi 内建八件套里」(`src/runs/shared/child-tool-plan.ts:360`),四件套原样进子会话。issue #328 的扩展注入路径(agent 定义的 `extensions`、`pi.registerTool` 同名覆盖)在 0.68 下不变,真实 SDK 回归全部通过。
- **排除表一条作废。**0.68 删掉了 `fallbackModels`、同次启动内的模型切换与持久化模型排除表,`PI_MODEL_EXCLUSIONS_PATH` 在包内已无引用;上文 2026-09-05 修订里「模型排除表关进会话的 agentDir」那一条随之失效,`installEvidenceKit` 不再设它。一次瞬时失败只作废那一次取证,这是上游现在的默认行为。
- **不再捆绑 `pi-server`。**Pi 0.85.1 的根入口不引用它,0.68 也不再带,它与 `pi-protocol` 退出依赖树;只有后台子会话用得到,本项目一律前台。
- **未变。**spawn 预算两个环境变量、能力天花板登记表键、`intercomBridge` 校验、`disableBuiltins`、`asyncByDefault` 在 0.68 源码里全部仍在;包发布的仍是未编译的 `.ts`(changelog 声称改发编译产物,tarball 里没有),本进程不能直接 import 的约束不变。

## 修订(2026-09-20,pi-subagents 0.70.0)

**包改发编译产物,能力天花板换成上游的官方接口。**

- **包形态。**0.70.0 的 npm 包只有 `.js` + `.d.ts` + `.map`,`pi.extensions` 入口从 `./index.ts` 变 `./index.js`。`vendoredSubagentsPath()` 仍解析到包根,Pi 的资源加载器照常吃得下,真实 SDK 回归全部通过;Pi 不再经 jiti 转译扩展,每个 Reviewer 子进程与会话子进程各省一次入口加载。
- **天花板改走官方接口。**上一条修订里「入口是 `node_modules` 里的 `.ts`,本进程导入不了,只能直接写 `globalThis` 那张表」随之作废:`evidence.ts` 改 import `pi-subagents/capability-ceiling` 的 `registerSubagentCapabilityCeiling`,登记项与手写那份逐字同形。官方接口每次调用发一枚新令牌(手写那份用 `Symbol.for` 复用同一枚),而登记发生在 `subagent` 的每一次调用上,因此按会话 id 记住句柄、只登记一次。
- **句柄的 `dispose()` 不接。**两条链路的会话都住在只服务它一个会话的子进程里,会话收尾的下一步就是 `process.exit(0)`,登记表随进程一起没;`AgentSession.dispose()` 不发 `session_shutdown`,扩展里也钩不到会话结束。为它另铺一条生命周期没有收益。
- **`hostAvailableBuiltins` 整层删除。**0.67 那类「宿主同名工具让子会话的 `read` 被静默剪掉」的成因结构性消失,上一条修订里跳过 0.67.0 的理由不再适用于之后的版本。
- **未变。**只读四件套的扩展注入、`denyExtensions: false` 加工具边界补回的那一道、两道 spawn 预算、`intercomBridge` 校验、`disableBuiltins`、`asyncByDefault`、`transcriptPath` 与 `acceptance: none` 在 0.70 下逐项同形。


## 修订(2026-09-20,issue #404)

**放行清单外的参数改为剥掉后放行,不再整次打回。**

- **起因。**模型看得到 pi-subagents 工具的完整 schema,第一次调用常带 `action` / `capabilities` 之类清单外的键;打回之后它去掉那几项重试一遍就过,每次取证白花一趟往返。
- **做法。**`pinSubagentCall` / `pinItem` 在顶层、`tasks[]` 每项、`chain[]` 每步及其 `parallel` 上只留放行清单里的键,其余丢弃,再钉上那四项,调用照常派出;被剥的键名随钉好的参数一起回出来。
- **安全性等价。**被剥的键到不了 pi-subagents,这与打回拦下的是同一批入口;钉死的 `intercomBridge` / `async` / `agentScope` / `cwd` 与各层 cwd 的钉法一格未动,能力天花板也未动。
- **可见性。**审查轨迹记的 `args` 取自 `tool_execution_start`,那一帧带的是模型写下的原始参数、在工具边界的钩子之前就发出去了,被剥的键因此照样看得见。
