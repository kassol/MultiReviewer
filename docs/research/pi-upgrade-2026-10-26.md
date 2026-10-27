# Pi 1.4.0 与 pi-subagents 0.82.1 升级核查

日期：2026-10-26。范围：npm 发布包、项目实际调用点、自动化回归及部署后的目录与真实推理验证。

## 版本与来源

- `@earendil-works/pi-coding-agent`：1.3.0 → 1.4.0，npm latest，发布于 `2026-10-21T22:48:58.431Z`。Pi 子包收敛到 1.4.0。
- `pi-subagents`：0.79.2 → 0.82.1，npm latest，发布于 `2026-10-25T06:30:17.462Z`。核查时仍不足 24 小时，因此 pnpm 发布年龄豁免换为精确 `pi-subagents@0.82.1`。
- 一手输入：[Pi npm 元数据](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent)、[pi-subagents npm 元数据](https://registry.npmjs.org/pi-subagents)、[Pi 上游](https://github.com/earendil-works/pi)、[pi-subagents 上游](https://github.com/nicobailon/pi-subagents)。下文源码路径均相对于对应精确版本的 npm 发布包，核对实际发布产物而非仅依据 changelog。

## 必需兼容修复

pi-subagents 自 0.81 起将包入口移到 `bundle/index.js`。本项目 `src/reviewer/evidence.ts` 的 `vendoredSubagentsPath()` 原先取入口的 dirname，升级后会返回 `bundle/`，资源加载器因找不到其中的 `package.json` 而失败。

改为 Node 原生 `findPackageJSON("pi-subagents", import.meta.url)` 定位清单，再取包根。现有 `test/reviewer-evidence.test.ts` 的 vendor 包根用例在原实现上以 `ENOENT …/bundle/package.json` 失败；修复后相关套件通过。

0.82.1 的 bundle 与未打包执行器仍通过 `globalThis[Symbol.for("pi-subagents.capability-ceiling.v1")]` 共享能力天花板。真实 SDK 回归覆盖子代理工具限制、上下文文件隔离、全文报告返回及会话工具面。其 pi-ai peer 下限变为 `>=1.2.0`，Pi 1.4.0 满足。

## 行为核查

- Pi `dist/core/session-manager.js`、`dist/core/resource-loader.js`、`dist/core/extensions/runner.js` 与 1.3.0 逐字相同；会话条目格式不变。
- Pi 压缩摘要取消按 reserveTokens 的固定比例限制输出，改用模型输出上限。本项目开启自动压缩的 Agent 会话会受影响，摘要可能更长；Reviewer 等一次性链路关闭自动压缩。
- Pi 恢复失败尝试时按工具调用 ID 找配对结果，避免截断恢复后残留孤立工具结果；grep 增加 `--no-config`，宿主 ripgrep 配置不再影响结果。
- Pi 扩展可重试错误到 upstream、stream disconnected 等，并减少错误文本中请求 ID 或字节数偶含 429/500 时的误判。本项目十次重试设置保留。
- SDK 请求身份改由 `getClientIdentity` 提供，User-Agent 与受 telemetry 设置控制的 attribution 行为有变。没有做真实网关请求头验收，不能据此声称全部请求正文与头逐字不变。
- 两版内置目录共 1714 → 1713 行；共有模型的 api/baseUrl 无变化，删除 60 行，对应 58 个唯一的 provider＋id 键。部署实例当前模型组合及辅助模型未命中这批删除项。新增 compat 键 `imageInput`、`sendImageOptInHeader` 属 classifier，本项目仅注册 chat。DeepSeek 元数据匹配另行调查。

## 自定义模型发现与模型规格覆盖的现行规则

同日的 DeepSeek → OpenCode 特判已删除。自定义发现从服务 `/models` 取得 ID 与名称,优先采用 Pi 目录字段,读取 Pi 时使用 `allowNetwork: false`。**先选统一候选集合,再在集合内逐字段应用来源优先级**(`src/reviewer/model-service-runtime.ts:278`、`:308`、`:362`):全目录完整 ID 相等的集合非空即用它;为空才按双方 ID 的最后一个 `/` 之后的末段精确匹配。官方裸 ID 不能越过其他 provider 的完整 ID。已确认的逐字段优先级为:

1. 官方厂商目录(GPT/o-series → `openai`,Claude → `anthropic`,Gemini → `google`;其余按裸 ID 的 provider 前缀推断,多个命中取最长前缀,`src/reviewer/model-service-runtime.ts:268`);
2. id 自带厂商路径时,同名 provider(`deepseek/…` 对 `deepseek`);
3. 同一集合内的其余候选。

各来源内多条候选按两套判据合成(`src/reviewer/model-service-runtime.ts:376`):名字、`reasoning`、`contextWindow`、`maxTokens` 与思考映射取**多数**,并列即未知;`input` 与 `compat` 要**全体一致**,`compat` 缺项同样算不一致。前者描述模型自己的规格,转售家的容量可能是本站服务上限;后者描述请求行为,抄错会使请求形状不兼容,输入类型标错则直接是一次失败的请求。名称按服务的 `display_name` / `name`、Pi 名称、model id 递降,显示名不参与能力匹配。Pi 目录的读取入口是 `catalog.ts` 的 `loadPiCatalog`(一次运行时加载读出全部 provider),`loadPiProviderCatalog` 在它上面按 provider 查找。

路径 provider 的逐字段补缺已在源码收口:`src/reviewer/model-service-runtime.ts:369` 先合成其余候选,再按字段覆盖路径 provider 与官方的有效值;各层缺失或无法合成的字段继续沿用下一层。此处仅确认代码事实,检查结果由主会话填写。

Pi 未提供的四个基础字段再由 `https://models.dev/api.json` 兜底:`input`(text/image)、`reasoning`、`contextWindow`、`maxTokens`。先跨全部 provider 按完整 ID 精确匹配;完整 ID 没有候选时,才按双方 ID 的最后一个 `/` 之后的末段精确匹配。同一候选集合内逐字段忽略缺失与非法值,优先取官方有效值;该字段没有官方有效值才取全部候选中的有效值,所选有效值全部一致才采用,冲突保持未知;已由 Pi 提供的字段不覆盖(`src/reviewer/model-service-runtime.ts:465`)。采用字段的来源标为 `models-dev`。

一次发现仅在四字段有缺项时按需请求一次 models.dev,共用发现的超时信号。`PI_OFFLINE` 已设置或 `allowNetwork: false` 时不发补缺请求;网络失败、非成功响应或目录无效时保留已发现的模型,未知字段在运行时套运行基线。models.dev 的协议、地址、compat 与思考映射不采纳;**自动发现**的思考映射与 compat 只取 Pi,自定义调用目标取操作员配置。已有目录快照需显式刷新才更新。

**模型规格覆盖**允许手动指定 `input`、`reasoning`、`contextWindow`、`maxTokens`、`thinkingLevelMap`、`compat` 六字段,合成时逐字段优先于自动值,来源标为 `manual-override`(`src/reviewer/model-spec-overrides.ts:8`、`:65`)。提交整份覆盖,省略某字段即恢复自动;空的思考映射或 compat 对象保留为显式覆盖(`src/contracts/model-specs.ts:1`)。思考映射与 compat 按固定 Pi 版本的公开 schema 校验并拒绝未知键(`src/reviewer/model-spec-overrides.ts:22`、`:51`);手动 compat 合成时保留原值,自动 compat 仍过自定义网关参数剥除(`src/reviewer/model-service-runtime.ts:553`)。

覆盖按模型及实际调用目标指纹读取(`src/webhook/server.ts:799`),同目标的目录刷新与凭据轮换保留。内置服务已绑定目标集合时,自动目录与模型补录同时缺席、原目标指纹仍在绑定集合内,覆盖继续留存在库中(`src/review/store/repos.ts:848`);来源缺席期间暂停应用,来源恢复并解析到原目标后继续应用。来源解析只认自动目录与模型补录(`src/review/store/shared.ts:311`、`src/webhook/server.ts:763`),留存覆盖不充当来源;运行计划在来源缺席时不给调用目标,规格合成在应用覆盖前即失败(`src/webhook/server.ts:817`、`:879`),覆盖写入也回 `unknown-model`(`src/review/store/repos.ts:1367`)。模型改指另一个已绑定目标、目录行指向未绑定目标且无可用补录、或来源缺席时原目标从绑定集合移除,都会清除覆盖,日后切回也不恢复(`src/review/store/repos.ts:841`)。四条回归分别覆盖缺席留存与恢复、上述三种清除及切回不复活(`test/model-service-persistence.test.ts:334`、`:375`);缺席用例同时断言已有引用阻止来源消失、留存覆盖不能建立新引用。本次只读断言,未运行测试。

覆盖写入核对服务版本与当前目标,成功后将服务与目录版本一起推进(`src/review/store/repos.ts:1359`)。运行规格冻结已在源码接入:`src/config.ts:157` 显式投影非秘密 pin,`src/review/store/runs.ts:336` 与 `:341` 分别保存辅助模型与 Reviewer 的规格;`src/webhook/server.ts:1073` 恢复规格前校验当前服务版本与调用目标以取得凭据,`:10798` 接入启动续跑。会话的复用键包含完整运行模型与思考档位(`src/webhook/agent-session.ts:527`),规格变化后收拢旧进程并落系统消息再重建(`:1458`)。此处仅确认代码事实,尚待主会话完成检查与部署验收。

2026-10-26 此前全目录匹配版本的只读验证结果(本段为历史记录,未重新验证上述逐字段优先与覆盖功能):`deepseek-v4.1-flash` 在 Pi 1.4.0 的 `opencode`、`opencode-go`、`qwen-token-plan`、`qwen-token-plan-cn` 与 `radius` 下都有完整 id 相同的行,因此全目录匹配直接命中,四个基础字段不再需要 models.dev(一次发现只剩服务 `/models` 那一个请求)。`maxTokens` 按多数取 384,000(radius 那一行是 32,768),上下文 1,000,000,输入 text/image,思考映射取多数那一份,合成后支持档位为 low / high / max;`compat` 因各家给出不同的 `thinkingFormat` 而不采纳。运行基线定义见 `src/reviewer/model-service-runtime.ts` 的 `MODEL_RUNTIME_BASELINE`。当时主会话经面板 API 只读确认:线上目标服务没有任何模型组合或辅助模型引用。

历史记录:同日上一轮曾为精确 ID `deepseek-v4.1-flash` 指定 Pi 的 opencode 来源,并完成 17 条独立回归、部署后显式刷新与最小真实推理验收,得到百万上下文、384k 输出及 low / high / max;随后改成「只查三家官方目录 + models.dev 通用补缺」,那条路径对 DeepSeek 取不到容量,本轮再改成全目录匹配。下文保留各轮的验证记录,它们只证明当时那一版。

## 前台运行历史的新落盘

0.82.1 `src/runs/foreground/subagent-executor.js:3801` 与 `:4019` 在运行起止记录历史；`foreground-history.js:188` 写入 `DIRS.results/foreground-history/<runId>.json`。`src/shared/types.js:106` 优先读取 `PI_SUBAGENTS_TEMP_ROOT`，缺省使用系统临时目录下按用户划分的 `pi-subagents-<scope>/async-subagent-results`。本次在 `installSubagentKit`、扩展首次导入之前将变量绑定私有 agentDir;父进程创建并注入该目录,worker 复用,父进程等子进程关闭之后删除。

历史含任务上下文、模型、状态、产物与 transcript 路径；没有产物路径时可内联最多 64 KiB 尾部输出（`foreground-history.js:24–60`）。默认保留 50 条，仍可能运行的记录不被裁掉（`:10`、`:166–200`）。真实 SDK 回归确认取证与会话子代理的任务历史和报告落在私有目录,退出或回收后删除;受控 worker 回归另覆盖子进程强杀。父进程自身被强杀时仍可能留下临时目录,本次未增加启动清扫。

## 上轮升级与特判版本的历史验证

以下均为通用 models.dev 补缺改动之前已完成的历史记录,不作为本轮最终实现的全量检查或部署完成证明。

- `pnpm typecheck` 通过。
- 真实本机 PostgreSQL 上，9 个文件共 86 条通过、0 跳过：`reviewer-evidence`、`reviewer-evidence-session`、`agent-session-subprocess`、`reviewer-verdict-nudge`、`model-service-runtime`、`model-service-catalog`、`model-service-targets`、`worker-tools`、`reviewer-turn-trace`（均为 `test/*.test.ts`）。
- `npx -y pnpm@11.21.0 install --frozen-lockfile --lockfile-only` 通过，覆盖镜像使用的 pnpm 主版本与发布年龄校验。
- 全量 `pnpm check` 通过:后端 1236 条通过、10 条凭据门控用例跳过、0 失败;前端纯函数 114 条通过、0 失败。后端耗时约 254 秒。
- 正式镜像 `2026.10.26-1-dirty` 构建并部署完成,摘要 `sha256:76b7ff7bad9f20aed4e5067c7d63e29f062760c02d3f3affbf6c1a60d70717aa`。运行版本为 Node 24.22.1、内置 undici 7.30.1、Pi 1.4.0、pi-subagents 0.82.1,架构 amd64;启动与 HTTP 检查通过。
- 目标服务显式刷新后,`deepseek-v4.1-flash` 的可信字段来源为 `pi-catalog`,运行投影为上下文 1,000,000、最大输出 384,000、文本与图片输入、low / high / max;维护页以该型号重新验证成功。
- 真实 Reviewer 与取证验收 Run 169 于 03:07:39 UTC 正常完成,耗时约 123 秒,`failed=false`、`failure=null`。GPT 与 Claude 的失败字段均为空,分别使用 169,529 与 75,961 tokens;合并 agent 使用 10,382 tokens。三次取证均 `isError=false`,报告长度分别为 620、1,385、533 字符,嵌套工具调用分别为 7、5、16 次;报告含 file:line 证据。Claude 三次 502 经自动重试恢复。轨迹末尾为 `review_posted`(1 条 Finding)与 `run_finished`。浏览器 TaskSpace 已清理。

## 通用补缺版本的验证(已被全目录匹配取代)

这一节的结论只属于「只查三家官方目录 + models.dev 通用补缺」那一版:DeepSeek 的容量在那条路径上取不到。后续规则与此前只读验证见「自定义模型发现与模型规格覆盖的现行规则」,专项回归在 `test/model-service-runtime.test.ts`。

- 全量 `pnpm check` 通过:后端 1,239 条通过、10 条门控用例跳过、0 失败,耗时约 219 秒;前端纯函数 114 条通过、0 失败。模型服务公共测试桩单独识别 models.dev 请求并返回空目录,原有调用目标、凭据与并发提交断言保持不变。
- 镜像 `2026.10.26-2-dirty` 已部署,摘要 `sha256:f0d2ff89b13fd5e61dae6aa6b413c1180e0bdcab7460b4e5bc23e594ef1999f6`。两份生产源码与工作区一致,前端产物含 models.dev 来源标签。Node 24.22.1、内置 undici 7.30.1、Pi 1.4.0、pi-subagents 0.82.1。容器正常运行、重启次数 0,会话端点正常返回未认证状态,启动日志无错误。
- 部署后显式刷新目标自定义服务,`deepseek-v4.1-flash` 的 input 与 reasoning 来源均为 `models-dev`,contextWindow 与 maxOutput 为未知,运行投影为 128,000 / 16,000 且来源为 `runtime-baseline`,档位为 off / minimal / low / medium / high。模型页可见「models.dev / 运行基线」说明。
- 维护页用该型号与已存凭据重新验证,页面返回「已用已存凭据重新验证」。目标服务无模型组合或辅助模型引用。浏览器 TaskSpace 已关闭。本轮没有另开真实 Review Run;Reviewer 与取证的升级验证见上一轮历史记录。
- 补缺请求失败时发现仍可成功,显式刷新可能将旧补缺字段退回未知与运行基线;当前规则不保留上一次成功补缺的字段。

## 规格覆盖版本的定向验证

- PostgreSQL 定向回归 `agent-session-rebuild`、`restart-recovery`、`run-resume`、`merge-agent` 共 86 条通过、0 跳过，耗时 38.96 秒。覆盖常驻会话规格变化后的重建、Reviewer 与辅助模型冻结规格的重启恢复。
- `pnpm typecheck` 通过；`panel-model-services` 与 `model-service-review-run` 共 42 条通过，耗时约 13.36 秒。普通 Review Run 的六字段冻结回归验证运行中两批使用旧规格、下一轮两批使用新规格。
- `model-service-persistence` 15 条通过，覆盖来源缺席后恢复、已绑定目标之间切换、目录改指未绑定目标及移除原绑定；换目标后切回不会恢复已清除的覆盖。
- 后端复核的两项缺陷已修复，66 条定向回归、`pnpm typecheck` 与改动文件的 `git diff --check` 通过。Responses 最小推理通过最终 `onPayload` 保留 1–15 的实际输出上限，回归逐项验证 1–17；发现失败后的内置提交、自定义重验与自定义提交先选定实际保留的自动字段，再叠加目标绑定覆盖，四入口回归核对验证请求与提交快照一致。
- pnpm 11.21.0 的 frozen lockfile 校验通过。上述均为最终前端与全量检查之前的定向结果，发布与端到端验收尚待完成。
- 此前三项会话超时在本次 86 条定向回归中未复现，根因仍未确定；本次通过不能证明这些超时已经修复。
- 规格覆盖后端的最终 `pnpm check` 通过:后端 1,270 条(1,260 通过、10 条门控跳过、0 失败),耗时 210.44 秒;前端既有纯函数 114 条通过。此时规格编辑弹窗仍在收尾,最终前端检查与部署验收另记。
- Store 依赖方向收口后,主会话补跑 `pnpm typecheck` 与 `model-service-persistence`、`panel-model-services`:55 条通过、0 失败、0 跳过,耗时 13.82 秒。Store 仅类型引用覆盖契约,HTTP 边界继续完整校验六字段;回归覆盖写权限、斜杠 ID、非法输入零写入、带当前投影的 409 与空覆盖恢复自动。运行字段来源文档已补列 `manual-override`。
- 独立后端只读复核未发现可证实缺陷,范围为候选匹配与字段优先级、六字段校验及目标绑定生命周期、完整运行规格冻结恢复、常驻会话重建与 Responses 最终输出上限。主会话另核对 `store/runs.ts` 的 Reviewer pin 与辅助模型写入、`webhook/server.ts` 的续跑恢复、`webhook/agent-session.ts` 的完整规格比较及重建顺序、`model-service-runtime.ts` 的最终 `onPayload` 修正。此结论限于静态代码与安装版 Pi 调用链,不代替部署验收。
- 前端六字段编辑弹窗完成:`web/src/lib/model-spec.ts` 承载草稿、稀疏提交、原样保存判定、409 换基线与目标变化保护(6 条单测),模型页每行运行规格下挂「编辑规格」Dialog(六字段各一枚「手动覆盖」勾选,勾上的才提交,`false` 与空对象照实提交);保存成功即关窗,草稿与基线一致时保存禁用;409 换基线不换草稿,调用目标变了封住保存只给「按当前规格重载」。字段来源多一档 `manual-override`,行上写明已覆盖项数。`pnpm --filter ./web typecheck`、`test`(120 条通过)与 `build` 通过,`impeccable detect` 在三个改动文件上无命中。部署实例上已验证:显式刷新目录后目标型号取到 1,000,000 / 384,000 与「Pi 目录」来源;非法容量禁保存、覆盖保存与重载保留、取消不写、清空恢复自动,409 保留草稿并可在重试后保存。

## 未处理风险

pi-subagents 已依赖 undici 8.12.3，Pi coding-agent 1.4.0 仍带 undici 8.10.2，锁文件中两版并存。[GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) 的修复下限是 8.12.2 / 7.30.1：恶意服务返回超过五层 content-encoding 并提前断开，可使受影响的 fetch 因未处理流错误退出，捕获 fetch rejection 也不能阻止。

当前普通 API key 路径保留 Node 的 global fetch。`src/reviewer/worker-tools.ts` 调 `createAgentSession`，未注入 fetch；Pi `dist/core/sdk.js:17` → `settings-manager.js:8` → `http-dispatcher.js:2` 会加载 npm undici，其 `lib/global.js:14–15` 可初始化全局 dispatcher，但替换 fetch 的 `undici.install()` 在 `configureHttpDispatcher()` 内(`http-dispatcher.js:68–95`)，当前 SDK 与强制前台的子代理链没有调用它。dispatcher 与 fetch 是两层，不能据此声称 npm undici 完全不可达，也不能用 npm override 代替 Node 内置 fetch 的修复。

部署实例原有 Node 24.22.0 内置 undici 7.29.1，包含受影响的解压错误分支。[Node 24.22.1 正式安全发布](https://nodejs.org/en/blog/release/v24.22.1) 已将内置 undici 升到 7.30.1；当前官方 `node:24-slim` 已指向该版。本次发版需刷新基础镜像，并在产物与部署容器核对 `process.version` / `process.versions.undici`。未向线上发送恶意响应，未证明现有模型网关触发过该缺陷；未添加 npm override。

本机构建准备已用 `docker buildx build --platform linux/amd64 --pull` 刷新当前 builder 的基础层，运行版本断言得到 `linux / x64 / v24.22.1 / 7.30.1`；随后不带 `--pull` 再构建命中同一缓存且断言通过。基础镜像摘要为 `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`。临时验证镜像已删除。正式产物与部署版本均已核对为上述 Node / undici 版本。

## 交付与验收结果

- 后端最终全量已通过(1,260 通过、10 条门控跳过、0 失败);前端 `typecheck` / `test`(120 条)/ `build` 通过,`test/panel-frontend-bundle.test.ts` 通过。三项会话超时仍未定因,当前通过不证明它们已修。
- 正式镜像 `2026.10.27-2-dirty` 已部署到 00-test,摘要 `sha256:ff64f7e1bde2290fcb26386c7bad8d08e8a126831ec79d93afe5b887033034c9`。容器 `running`、重启 0、迁移记录 2、`model_service_model_state.overrides_json`(`jsonb`、可空)已就位;Node 24.22.1 / 内置 undici 7.30.1、Pi 1.4.0、pi-subagents 0.82.1、amd64。近十分钟日志错误 0 行,无在跑轮次。三份 `bak-20261026-model-overrides` 大小未变;两份更早的 `.env` 备份按「一类只留最新一份」清掉。
- 目录刷新后,`sub2api-opencode:deepseek-v4.1-flash` 取到 1,000,000 / 384,000、文本与图片输入、「Pi 目录」单一来源,models.dev 不再参与;维护页用已存凭据重新验证成功。
- 规格编辑弹窗在部署实例上验过:未改动时保存禁用;容量填 `0` 就地报错并禁保存;覆盖最大输出 300,000 保存后关窗、行上显示「已手动覆盖 1 项」、刷新后保留;取消勾选保存即回到自动值;409 时提示「模型服务版本已变化…草稿原样保留」、值未丢、再次保存成功。390×844 下弹窗 358×710、无横向溢出、内容区自身滚动。
- 真实 Review Run:Run 172 用 `sub2api-opencode:deepseek-v4.1-flash` 完成(122,861 tokens,1 批,43 条轨迹事件,`run_finished` 为正常收尾);轮次 pin 冻结了上下文 1,000,000、最大输出 384,000 与文本 / 图片输入。零新报出——该轮把 14 条历史逐条复核为 `present`,未重报。Run 170 / 171 因两个上游网关 503(`No available accounts` / `Service temporarily unavailable`)整轮失败,与本次改动无关;验收期间临时把全局组合切成同一家 opencode 型号,跑完已原样恢复为 `claude-opus-5-5` 与 `gpt-6.1-sol`(版本推进到 17),覆盖保持清空。

## 2026-10-27 干净发版与目录候选组

- **发版流程纠正**。`scripts/build-push.sh` 在工作区有未提交改动时给版本 tag 加 `-dirty`。`2026.10.27-2-dirty` 就是这样构建出来的;同一份源码先提交(`4efa95b`)再构建,得到干净的 `2026.10.27-3`(摘要 `sha256:9618c9ff397858f21b5df68b2375616d7cef3e6cb244adf117f4d170f40f7715`),内容与 `-2-dirty` 相同。之后候选组与子代理模型放行的改动提交为 `845658c`,再构建干净镜像 `2026.10.27-4`(摘要 `sha256:ab860c3b4ccad724ffdd938fa752de334f244965eb960a7bb376a55aee8164c7`,镜像 label `org.opencontainers.image.revision` = `845658cc6bc4ced6cff8bdd0a558ecf58a4b8cd3`)。
- **部署**。00-test 已指向 `2026.10.27-4`,容器 `running`、重启 0、Node 24.22.1 / undici 7.30.1 / Pi 1.4.0 / pi-subagents 0.82.1 / amd64;迁移记录 3,`model_directory_model.candidates_json`(`jsonb`、可空)就位;启动监听成功,近十分钟错误日志 0 行,无在跑轮次。三份 `bak-20261026-model-overrides` 备份大小未变。
- **候选组**。显式刷新 `sub2api-opencode` 目录(服务版本推进到 18)后,`deepseek-v4.1-flash` 回 5 组候选:`opencode`、`opencode-go`、`qwen-token-plan`、`qwen-token-plan-cn`、`radius`。输入、推理与上下文五组一致(1,000,000),最大输出分两档(前四组 384,000,`radius` 32,768),思考映射与 compat 也各有差异;没有匹配到官方厂商行,因此五组都不带官方标记,自动值按多数合成。
- **面板验收**。「编辑规格」弹窗顶部显示「目录匹配到 5 组」;只有存在不同值的字段出现「值来源」——最大输出、思考映射、兼容参数,输入 / 推理 / 上下文不出现。最大输出下拉的选项是「自动(官方优先)」「opencode:384,000」「radius:32,768」「手动输入」(后四组里三组同值,合并成一项)。选 `radius:32,768` 保存后覆盖写成 `{maxTokens:32768}`(服务版本 19),重新打开时下拉仍停在 `radius:32,768`;改回「自动」保存后覆盖清空、生效值回到 384,000(服务版本 20)。390×844 下弹窗保持 358×710、无横向溢出。
- **真实链路**。维护页用已存凭据重新验证 `deepseek-v4.1-flash` 成功(一次最小真实推理)。临时把全局组合切成该型号(high),对 `zhangxu/review#66` 发起只复核重跑,Run 173 完成:70,367 tokens,0 条新报出,轮次 pin 冻结 1,000,000 / 384,000 与文本 / 图片输入。组合随后恢复为 `claude-opus-5-5` + `gpt-6.1-sol`(high),设置版本推进到 20。
- **503 的成因**。此前 Run 170 / 171 的 `Service temporarily unavailable` 与 `No available accounts` 经确认为两个网关额度用尽,不是代码缺陷。

## 2026-10-27 更正:子代理模型继承

「「子代理默认继承主会话模型,显式指定才换」属 OpenChamber 会话侧的调用规则,不在 MultiReviewer 产品内。产品侧 `evidence.ts` 对 `subagent` 调用放行 `model` 的改动已撤回(`cebef70`),取证子代理仍只继承父会话模型。OpenChamber 的 `general` / `explore` 两个 agent 本就没有绑定模型,子会话按父会话模型创建;近两日的不一致来自派单时按任务难度显式传了 `model`。全局 AGENTS 的派单规则已改为「默认不传 `model`,继承主会话模型与档位;只有 Sir 明确指定时才传」。最终镜像 `2026.10.27-5`(摘要 `sha256:c94c2eb7fc8f9922e630477f8342279bb231907e514ab0f70bb6d453cf5fbd53`)已部署,迁移记录 3。
