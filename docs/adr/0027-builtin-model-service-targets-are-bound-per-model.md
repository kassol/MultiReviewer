# 内置模型服务的调用目标按模型绑定,版本记录目标集合

基线 067732e 把一家 Pi 内置模型服务的调用目标(接口协议 + 地址)定义为 Pi 内置表里该 provider **第一行模型**的 `api/baseUrl`(`catalog.ts` 的 `resolvePiBuiltinProviderTarget`):合成运行模型、最小真实推理、模型服务版本的目标指纹、面板投影与 Review Run 的运行计划都读这一个目标。前提是「同一家 provider 只有一种协议、一个地址」。OpenRouter 不满足这个前提:它同时供 Chat Completions 与 Anthropic Messages 两种协议的模型,Pi 0.85.0 把内置表里 OpenRouter 的首行从 `openai-completions` + `https://openrouter.ai/api/v1` 换成了 `anthropic-messages` + `https://openrouter.ai/api`(`docs/research/pi-upgrade-2026-09-05.md`)。升级后旧版本的指纹与「当前首项」不再相等,Review Run 在解密凭据之前整家判「Pi 内置目标已经变化」;而就算重新配置,所有模型仍只能走首行那一种协议。

自动目录早已按模型保存 `api/baseUrl`(`model_directory_model.api` / `base_url`,来源是 Pi 内置表、远程目录与厂商目录)。选定的做法:**调用目标按模型解析,模型服务版本记录目标集合。**

- 内置服务里一个模型的调用目标,首先是自动目录里它自己那一行保存的 `api/baseUrl`;目录里没有它、但 Pi 内置表里有它那一行时,用内置表里它自己的目标;两处都没有时,只有这一版已确认的目标恰好一个才沿用;混合协议下唯一确定不了就明确拒绝,并指向自定义模型服务——那条路径本来就要求人写明地址与协议。不猜第一项,也不开任意地址的口子。
- 内置服务的一个版本记录**去重、稳定排序后的有效 `api/baseUrl` 集合**作为目标绑定(`model_service.targets_json`),版本的目标指纹从集合算出:只有一项时就是那一项的单目标指纹,与升级前单协议版本的指纹相同;多项时对排序后的各项指纹再取摘要。候选预览展示本次要绑定的集合。模型补录绑的是该模型验证时实际用的那一个目标的指纹。
- 升级前的版本没有集合,只有当初首行的单目标指纹。这种版本只延续**能证明**的目标:拿这一版自动目录各行的目标与 Pi 当前内置表各行的目标逐个算指纹,恰好对上一个即当初绑的那一个,整版沿用它;对不上或对上多个都标「需重新验证」,凭据在模型调用前不解密。禁止拿 Pi 首项的变化自动改绑旧凭据。
- 目标只经显式候选验证(最小真实推理)与新版本提交进入绑定:新建、凭据轮换、重新验证与模型补录都会把验证到的目标写进集合。目录刷新只换目录不换绑定,刷新拉进来的新协议或新地址在这一版里是「调用目标未经验证」,不可用。
- 运行目标随模型服务版本一并固定。Review Run、规则 agent、合并 agent、基点探索与面板投影共用同一份解析(`server.ts` 的 `serviceTargetBinding` / `resolveServiceModelSource`);绑了集合的版本不问 Pi 当前内置表,只有旧版本的证明要问它。运行中的刷新与重新验证只影响之后创建的运行计划。
- 最小真实推理改用与 Review Run 相同的注册方式(`isolatedPinnedModelRuntime`,只注册这一个模型、协议按它自己的 `api`)。Pi 内置的 provider 对象是单协议派发(0.84.4 的 OpenRouter 只认 Chat Completions),直接拿它验证会把 Anthropic Messages 的模型也发成 Chat Completions,验证通过的东西与真实运行就不是同一条路。

## Considered Options

- **把 OpenRouter 拆成两家内置服务(按协议各一家)。**provider 标识是模型标识 `provider:model` 的前半段,拆家会让同一个 OpenRouter 模型出现两个标识、历史 Finding 与统计的归属跟着裂开;凭据也要粘两遍。问题在「一家一个目标」这条假设上,拆家只是把假设搬到更小的单位。
- **版本仍只记一个目标,取「多数模型的目标」或首行。**多数与首行都随目录排序和 Pi 版本变,而这一票要修的正是「目标随 Pi 首项漂移」;记一个目标也回答不了「Anthropic 协议那几行该怎么跑」。
- **目录刷新时自动把新目标并进绑定。**刷新不做推理,新目标没经过任何验证就进了版本,等于凭目录变化改绑凭据——与「禁止凭 Pi 首项变化自动改绑」是同一件事的另一种写法。刷新只换目录,绑定走重新验证。
- **升级前的版本一律标需重新验证。**存量里绝大多数是单协议 provider(deepseek、anthropic、openai 直连),它们的指纹与 Pi 当前内置表唯一的目标逐字相同,证明得了;一刀切会让每一家都要人重新点一次验证,而证据明明在库里。
- **手填的 model id 在混合协议下按第一项或让人填地址。**第一项是猜;让内置服务收任意地址等于开出第二条自定义服务通道,两条通道同一件事。自定义模型服务已经是这种模型的正路。

## Consequences

- `model_service` 多一列 `targets_json`(JSON 数组,每项 `{api, baseUrl, fingerprint}`,去重排序;自定义服务与升级前的内置版本为 NULL)。`ModelServiceRecord.targets` 读它;提交时由库算指纹并校验与 `targetFingerprint` 一致。
- `resolvePiBuiltinProviderTarget` 删除,换成逐模型的 `piBuiltinProviderTargets`;`resolveBuiltinModelTarget` 是「模型自己的目标 → 唯一目标 → 拒绝」这条链的唯一实现,发现失败的候选、模型补录与烟测共用。
- 可用性多一档原因 `target-unresolved`(调用目标未经验证),与「模型来源消失」分开报:来源在,只是这一版没绑它的目标。组合写入的库内判据(`availableModel` 的 SQL)按同一规则用 `json_each` 对集合。
- `GET /model-services` 的服务多一项 `targets`(自定义服务恰好一项,内置服务可多项,证明不了目标的旧版本为空);内置服务的 `target` 两项为 null。内置候选预览回 `targets` 而不再回单个 `target`。逐模型的 `discovery.api/baseUrl` 是该模型解出的目标,来源标 `pi-catalog`(目录里它自己那一行)或 `service-target`(整家唯一目标、自定义目标、旧版本延续的目标)。
- 存量 OpenRouter 服务(0.84.4 下建的版本,全部行走 Chat Completions)升级 Pi 后照常运行:指纹与目录行的目标对得上。刷新目录后 Anthropic 协议的行进目录但不可用,重新验证一次(随便选哪个模型)之后整份集合绑进新版本,两种协议各走各的。
- Review Run 的运行计划仍逐 Reviewer 冻结 `target` 与运行模型;`reviewerPin.target` 从此是这个模型自己的目标,同一轮里两个 OpenRouter 模型可以是两个不同的目标。
- 模型补录的目标指纹从「服务目标」变成「该模型验证用的目标」;单协议服务下两者相同,存量补录行不需要迁移。
