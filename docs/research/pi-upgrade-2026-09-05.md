# Pi 0.85.0 与 pi-subagents 0.65.1 升级调研

日期：2026-09-05。代码基线：`7c558f83e04b5c74a92373a5a7d7412e8e5d78cc`。范围是当前仓库实际使用的 SDK、模型目录和取证子代理链路。结论基于 npm Registry、上游 tag/changelog/源码及本仓库源码；未调用收费模型，也未操作部署实例。

## 结论

可以跟进最新版，但当前不能把 `@earendil-works/pi-coding-agent` 直接从 0.84.4 升到 0.85.0。0.85.0 是 npm `latest` 指向的稳定版本，发布于 2026-09-04 10:18:05 UTC；`pi-subagents` 的稳定最新版是 0.65.1，发布于同日 23:07:53 UTC。两者都没有 prerelease dist-tag。[Pi Registry](https://registry.npmjs.org/%40earendil-works%2Fpi-coding-agent)；[pi-subagents Registry](https://registry.npmjs.org/pi-subagents)。当前仓库声明 Pi `^0.84.4`、pi-subagents 固定 `0.59.0`（`package.json:19-22`），锁文件仍固定在这两个旧版本。

只升级 Pi 和同时升级两者，需要分别判断。只升级 Pi 时，Pi 0.85.0 根入口会加载 `main`，`main` 又静态加载实验 server，而 server 引用了 `@earendil-works/pi-server`；0.85.0 的 package manifest 没有声明该依赖。[main 导入 server](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/src/main.ts#L66-L70)；[server 导入 pi-server](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/src/experimental/server.ts#L16-L23)；[缺少 pi-server 的依赖表](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/package.json#L50-L72)。因此只升级 Pi 会在 SDK 根导入阶段失败；同时升级 pi-subagents 0.65.1 已能补齐该依赖，见后文验证。

两者一起升级后仍需处理 OpenRouter 和取证契约。0.85.0 改变了 OpenRouter 内置目录首模型的协议。项目当前用 provider 的第一项模型推导整个内置 provider 的唯一 `api/baseUrl`（`src/reviewer/catalog.ts:290-308`），再用这一个目标合成全部目录模型（`src/reviewer/model-service-runtime.ts:243-290`）。离线比较两版 38 个内置 provider 后，只有 OpenRouter 改变：0.84.4 首模型目标是 `openai-completions` + `https://openrouter.ai/api/v1`，0.85.0 变成 `anthropic-messages` + `https://openrouter.ai/api`。OpenRouter 本身已有多个协议的模型，provider 级单目标假设因此失效。已有 OpenRouter 数据库快照还会与新首模型指纹不一致，Review Run 在解密凭据前直接判“Pi 内置目标已经变化”（`src/webhook/server.ts:621-649,688-721`）。适配应优先复用自动目录已经保存的模型级 `api/baseUrl`，同时明确补录模型的目标和旧服务指纹的迁移规则，再刷新并验证模型服务。

## 版本变化与可用能力

Pi 0.85.0 保留了项目使用的 `ModelRuntime`、`createAgentSession`、`SessionManager`、`SettingsManager`、`DefaultResourceLoader`、`defineTool` 和工具事件。项目用隔离的 `ModelRuntime` 注册每轮固定模型（`src/reviewer/model-runtime.ts:57-94`），用自定义只读工具、受控扩展路径和内存设置创建 session（`src/reviewer/worker-tools.ts:199-242`；`src/reviewer/worker.ts:428-471`），这些调用的类型检查可以通过。类型兼容不足以保证运行兼容：只升级 Pi 有漏包问题，两者一起升级仍有 OpenRouter 与取证契约适配项。[0.84.4…0.85.0 对比](https://github.com/earendil-works/pi/compare/v0.84.4...v0.85.0)。

下列能力在当前 0.84.4 集成中已经存在，不应算作本轮新增：七档思考档位及按 `thinkingLevelMap` 过滤（`src/config.ts:5-18,43-61`）；自定义工具和取证扩展（`src/reviewer/worker-tools.ts:71-93,227-240`）；模型目录刷新及 `compat` 透传（`src/reviewer/catalog.ts:88-115`；`src/reviewer/model-service-runtime.ts:307-340`）；input/output/cache-read/cache-write/total 五项 token 用量。Pi 还会计算 cost 等统计，项目没有把它们纳入运行结果（`src/reviewer/worker.ts:523-539`）。

0.85.0 升级并修完兼容项后可直接得到 provider 流事件、自定义 tool-call delta、OpenAI Codex SSE、NO_PROXY、代理后工具调用挂起、Qwen3.8 Flash 目录、Fireworks/Baseten 元数据和内置文件工具 `ctx.cwd` 等修复。它们位于 Pi/provider/tool 内部，不要求修改 Reviewer API。[Pi 0.85.0 changelog](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/CHANGELOG.md#L2-L31)。其中目录修复只有在面板显式发现、最小推理验证并提交新模型服务版本后才进入新 Review Run；运行中不会自动换目录（`src/reviewer/model-service-runtime.ts:307-345`；`src/reviewer/model-runtime.ts:68-94`）。

Claude 在同一会话内保持每次响应的思考投入，是 0.85.0 的新行为。上游通过 `supportsMidConvoEffort` 保存 provider effort，并在后续请求恢复控制信息，还处理思考签名不匹配，减少由此引起的持续 400。该能力仅用于明确支持它的 Claude 模型和 Anthropic Messages 传输，兼容接口不能一律开启。[模型兼容说明](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/models.md#L350-L359)。本项目的 `RuntimeModel` 会冻结 `compat`，目录加载也会透传它（`src/reviewer/model-service-runtime.ts:94-116`；`src/reviewer/catalog.ts:101-112`）。仅换包不会给已有数据库快照补字段；必须刷新并验证对应模型服务，新建的 Review Run 才能使用。当前思考档位面板本身已完整，无需另增档位。

`vllmPriority` 和 `supportsMaxOutputTokens` 是 0.85.0 新增的 compat 字段。前者发送请求的 `priority`，可让后台审查低于交互请求，但仅在 vLLM 开启优先级调度时有意义，Pi 默认目录也未设置它。后者控制是否发送 `max_output_tokens`，设为 false 可适配拒收该参数的 Responses 网关。[0.85.0 新增项](https://github.com/earendil-works/pi/releases/tag/v0.85.0)；[字段定义](https://github.com/earendil-works/pi/blob/v0.85.0/packages/ai/src/types.ts)。项目能把可信目录中的整个 `compat` 冻结进运行模型（`src/reviewer/model-service-runtime.ts:39-49,272-300`），但面板没有这两项的编辑入口。主动配置它们需要接入可信输入和校验；当前优先级低于升级兼容修复。

可恢复内存 session 需要主动接入。0.85.0 允许 `SessionManager.inMemory(cwd, { id }, entries)` 从外部保存的 entries 恢复会话。[SDK 示例](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/sdk.md#L683-L725)。本项目每批创建新内存 session（`src/reviewer/worker.ts:450-470`），Review Run 已按落库批次恢复。新能力可用于进一步减少批内重算，但需要保存完整会话 entries，并处理未完成工具调用与 Finding 重复提交；现有审查轨迹只保留工具返回长度，无法直接当作 Pi 会话恢复数据（`src/reviewer/trace-events.ts:99-116`）。仅升级不会获得批内续跑，当前暂不接入。

实施顺序为 OpenRouter 目标适配、pi-subagents 工具与用量适配，再利用 Claude 的条件能力。前两项完成后，provider/SSE/代理修复可随升级生效；使用对应 Claude 模型时，再刷新并验证模型快照。恢复内存 session、vLLM priority 面板配置目前没有明确产品需求。终端全屏、复制与渲染改进不进入本项目的 Web 面板，本轮无需接入。

## pi-subagents 兼容性

pi-subagents 0.65.1 明确修复 Pi 0.85.0 后台运行的 missing-server import，并直接依赖 `@earendil-works/pi-server@0.85.0`。[0.65.1 package.json](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/package.json#L71-L97)；[0.65.1 changelog](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/CHANGELOG.md#L4-L32)。临时副本只升级 Pi 与 pi-subagents、移除根项目的显式 pi-server 后，SDK 根导入仍成功；因此最小声明只需这两个直接依赖，pi-server 由 0.65.1 的依赖闭包提供。pi-subagents 0.59.0 的 peer range 虽允许任意 Pi 版本，上游没有承诺它兼容 0.85.0。

0.65.0 把前台子代理从独立 `pi` 进程改成父进程内的原生 `AgentSession`，后台任务才使用 detached runner；前台也不再加载 ambient extensions。[0.65.0 变更](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/CHANGELOG.md#L33-L53)。这会改变 ADR 0021 的执行体约定，需重新验证隔离与生命周期；实际耗时收益尚未测量。本项目取证默认前台、禁用内置 agent、声明 read/grep/find/ls，并显式铺入唯一 agent 定义（`src/reviewer/evidence.ts:154-230`）。项目没有导入已改名的 `pi-subagents/pi-args` 子路径，因此该改名无影响。

0.65.1 探针实际多出 `contact_supervisor`。它用于父子会话通信，没有据此获得仓库任意写能力，但超出了本项目的四工具契约。上游的 `intercomBridge.mode` 默认是 `always`，可设为 `off`（[配置解析与工具追加](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/src/intercom/intercom-bridge.ts#L82-L190)）。配置必须先于扩展加载：上游注册时读取并捕获 config（[注册代码](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/src/extension/index.ts#L417-L431)），项目却先 `reload()`、后写取证配置（`src/reviewer/worker-tools.ts:231-240`；`src/reviewer/worker.ts:428-448`）。仅增加 off 不生效；临时试验在写配置后重新加载扩展，才恢复四工具。正式适配应调整首次加载的顺序。调用参数还可覆盖桥配置（[override 调用点](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/src/runs/foreground/subagent-executor.ts#L1849-L1857)），因此还需在工具边界固定或拒绝该覆盖，才能维持严格白名单。

用量另有一个当前版本已经存在的问题。0.59.0 和 0.65.1 都会把子代理汇总 Usage 放进 subagent tool result（[0.59.0 源码](https://github.com/nicobailon/pi-subagents/blob/v0.59.0/src/runs/foreground/subagent-executor.ts#L2820-L2826)；[0.65.1 源码](https://github.com/nicobailon/pi-subagents/blob/v0.65.1/src/runs/foreground/subagent-executor.ts#L2899-L2905)），Pi 父 session 会统计工具结果携带的 Usage。项目又从 transcript 重算并加到父统计（`src/reviewer/evidence.ts:273-317`；`src/reviewer/worker.ts:486-539`），因此会重复计数。旧版对照探针已复现同样结果，这不是 0.65.1 回归；升级时应一起删掉手工补算，并用相同桩锁定“一次取证只计一次”。轨迹仍需验证 `transcriptPath` 和嵌套事件形状，因为它们是项目展示取证过程的接口。

## 建议升级顺序

1. 先修 OpenRouter 的模型级协议和地址选择，复用已有目录字段，覆盖旧快照失配、目录刷新、补录模型和真实运行计划。
2. 适配取证配置加载顺序和工具白名单，移除重复用量累计，并更新 ADR 0021 的前台执行约定。随后将 Pi 锁到 0.85.0、pi-subagents 锁到 0.65.1；依赖闭包会安装 pi-server，无需第三个直接依赖。
3. 跑完整 `pnpm check`，补充 SDK 根导入、38 个内置 provider 目标、OpenRouter 多协议、Anthropic `?beta=true` 请求及子代理轨迹/Usage 的回归检查。
4. 通过后提交锁文件；部署后在模型服务页显式刷新并验证需要的新目录版本。先观察目录差异，再提交版本；已有 Review Run 继续使用原快照。
5. 最终验收需在指定部署实例完成模型发现、最小推理与真实取证 smoke。本轮交付调研，尚未执行部署验收。

## 本地兼容验证

环境为 macOS、Node 24.14.0、pnpm 11.25.0。使用上述代码基线的临时副本，正式仓库的依赖与业务源码保持原样。所有完整检查均显式取消 `MULTIREVIEWER_SMOKE_PROVIDER`、`MULTIREVIEWER_GITEA_LIVE_PR`、`MULTIREVIEWER_LIVE_PR`，真实模型和真实 Forge 的 8 项测试跳过。

| 安装组合 | 类型检查 | 自动化测试 | SDK 根导入 |
| --- | --- | --- | --- |
| Pi 0.84.4 + pi-subagents 0.59.0 | 通过 | 766 通过、0 失败、8 跳过，共 774 | 通过 |
| 只把 Pi 升到 0.85.0 | 通过 | 311 通过、51 失败、2 跳过，共 364 | 缺 `pi-server`，失败 |
| Pi 0.85.0 + pi-subagents 0.59.0 + 显式 pi-server 0.85.0 | 通过 | 762 通过、4 失败、8 跳过，共 774 | 通过 |
| Pi 0.85.0 + pi-subagents 0.65.1，移除显式 pi-server | 通过 | 762 通过、4 失败、8 跳过，共 774 | 通过 |

只升级 Pi 时，51 个测试文件在加载模块时就失败，所以该行的总测试数较少。最小复现命令是 `node --input-type=module -e 'import("@earendil-works/pi-coding-agent")'`，错误为 `ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-server'`。另外在全新目录按最后一行的锁文件执行 `pnpm install --prod --frozen-lockfile --ignore-scripts`，SDK 根导入也通过，排除了旧安装残留补包的可能。这仍是 macOS 依赖安装验证，Docker Linux 镜像尚未验收。

补齐依赖后，两种组合的四项失败相同：

- `test/model-service-runtime.test.ts:494`：OpenRouter 目标切到 Anthropic，原 Chat Completions 响应桩被 Anthropic 解析器拒绝。
- `test/panel-model-services.test.ts:577`：同一协议变化使模型验证返回 422。
- `test/panel-model-services.test.ts:1158`：读取到的 OpenRouter 目标与旧 OpenAI 目标断言不同。
- `test/model-service-runtime.test.ts:682`：最小推理已成功，但 Anthropic 请求 URL 增加 `?beta=true`，旧完整 URL 断言失败。

前三项暴露了前述 provider 级目标假设，处理时须保护存量服务和真实运行计划，不能只换测试期望。第四项需更新请求断言，并在部署验收时确认实际代理接受新请求形状。

还使用临时 HTTP 桩执行了真实 `createPiReviewer → worker → pi-subagents → read → transcript → ReviewerOutcome` 链路。桩仅监听 `127.0.0.1`，用固定 SSE 响应驱动一次取证；断言第二次子会话请求确实带回临时文件内容、嵌套 `read` 成功且报告含 `target.txt:1`。四次合成响应声明的 token 合计为 84，其中取证子会话为 54。

- 当前组合与“仅 Pi 升级后补包”均完成读取与轨迹，子工具为 read/grep/find/ls；结果却为 138 token，恰好重复加入一次子用量。
- 两者最新版在 14 项探针检查中通过 12 项；失败为子工具增加 `contact_supervisor`、用量仍是 138。读取、返回内容、嵌套轨迹均通过。
- 临时增加 `intercomBridge.mode: "off"` 后，因配置写在扩展加载之后，结果仍是 12/14；写配置后重新加载扩展，恢复四工具，达到 13/14，剩余失败为重复计数。显式传 `intercomBridge.mode: "always"` 又恢复第五个工具，证明默认配置不足以强制白名单。

这组探针验证 SDK 与工具集成，不证明真实模型会主动取证、审查质量或生产性能。正式升级仍需保留同类回归检查，并完成部署实例验收。
