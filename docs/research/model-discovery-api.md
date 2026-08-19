# 模型发现接口的可承诺边界

对应 issue #124「模型发现接口究竟能返回什么」。本文只记录一手规范、官方实现与 Pi 0.84.0 源码，结论供后续模型服务 / 模型行决策使用。

## 结论先行

1. **OpenAI 的标准契约很窄。** `GET /v1/models` 的成功体是 `{object: "list", data: [...] }`；每个模型稳定可依赖的字段是 `id`、`object: "model"`、`created`、`owned_by`。`shutdown_date` 是可选字段。官方 Node SDK 明确写着目前实际不会分页，只是为将来兼容保留分页类型。[OpenAI OpenAPI](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml) · [官方 openai-node models.ts](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts)
2. **「OpenAI-compatible」不是统一发现协议。** vLLM、Ollama、llama.cpp 都返回近似的 `list/data`，但鉴权、额外字段和故障状态各不相同；不能从兼容标签推断必须带 key、分页存在、context window 或价格存在。[vLLM 模型路由 / schema](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/api_router.py) · [Ollama 兼容说明](https://docs.ollama.com/api/openai-compatibility) · [llama.cpp 模型路由](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp)
3. **成本与上下文窗口不是 `/models` 的跨厂商保证。** 四个来源中，OpenAI 与 Ollama 的兼容模型项没有这两项；vLLM 的 `max_model_len` 和 llama.cpp 的 `meta.n_ctx` 是各自实现字段，语义也不能直接当作统一的 `contextWindow`。价格应来自厂商价目 / 人工输入，窗口应来自厂商模型文档或明确的服务配置。[OpenAI 官方模型类型](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts) · [Ollama OpenAI 类型](https://raw.githubusercontent.com/ollama/ollama/main/openai/openai.go) · [vLLM schema](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/engine/protocol.py) · [llama.cpp response](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp)
4. **Pi 的目录和任意 provider 的 `/models` 是两套机制。** Pi 0.84.0 以内置生成目录为静态模型定义，并可叠加 pi.dev 的 provider 目录；Pi 本身不会因为在 `models.json` 里配置了一个 OpenAI-compatible base URL 就替用户探测该端点。后续自动发现最多可靠地产生模型候选 `id`，其余运行时字段仍要厂商资料或手工补齐。[Pi providers/all.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/providers/all.ts) · [Pi model-runtime.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/model-runtime.ts) · [Pi provider-composer.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/provider-composer.ts)

## 1. 标准 OpenAI `/models` 契约

| 项目 | 能承诺什么 | 证据 |
| --- | --- | --- |
| 路径 / 方法 | 官方服务为 `GET https://api.openai.com/v1/models`；请求示例带 `Authorization: Bearer $OPENAI_API_KEY`。 | [OpenAI OpenAPI 的 listModels](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml) |
| 成功包络 | `object: "list"` 与 `data` 数组；每一项是 model object。 | [OpenAI OpenAPI response example](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml) |
| 每项最小字段 | `id: string`、`created: number`、`object: "model"`、`owned_by: string`；Node 官方类型只把 `shutdown_date` 标为可选。 | [openai-node Model interface](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts) |
| 分页 | 当前官方实现声明「no pagination actually occurs yet」；不要据 `data.length` 或 `has_more` 设计一套通用翻页。若未来版本加分页，应视为新契约。 | [openai-node ModelsPage 注释](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts) |
| 鉴权失败 | 官方错误指南列出 401 Invalid Authentication / Incorrect API key、403 地区限制以及 429 限流等；错误体和状态不是兼容服务可以复用的固定字符串。 | [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes) |
| 价格 / 窗口 | 标准模型类型没有 price、context-window 字段；不能由 `created`、`owned_by` 或模型 id 推断。 | [openai-node Model interface](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts) |

**可靠的跨 provider 解析底线：**若 provider 宣称严格 OpenAI models 兼容，可把 `data` 数组和每条非空 `id` 当作候选发现的最低门槛；`object` / `created` / `owned_by` 用于兼容度记录和展示，但不要把它们扩展成 Pi 的价格、窗口或能力字段。若包络、数组或 id 缺失，标为「响应不兼容」并走手填，而不是猜默认值。

## 2. 三个代表性自托管实现

### vLLM

- `GET /v1/models` 返回 `ModelList`，默认包含 `object: "list"` 与 `data`；单项 `ModelCard` 的字段为 `id`、`object: "model"`、`created`、`owned_by: "vllm"`，另有可选 `root`、`parent`、`max_model_len` 与 `permission`。[路由](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/api_router.py) · [模型服务](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/serving.py) · [schema](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/engine/protocol.py)
- 默认没有 API-key middleware；只有传入 `--api-key` 或 `VLLM_API_KEY` 时才启用鉴权。启用后只接受 `Authorization: Bearer <token>`，`/v1/models` 也在受保护的 `/v1` 前缀内，缺失 / 不匹配返回 HTTP 401 和 `{"error":"Unauthorized"}`。[middleware registration](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/serve/middleware/register.py) · [authentication middleware](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/serve/middleware/authenticate.py)
- 路由没有 `limit`、`after` 或分页游标，返回当前 base model 与已加载 LoRA 适配器；`max_model_len` 是 vLLM 自己的服务配置字段，不是 OpenAI 标准字段，且不提供价格。[路由](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/api_router.py) · [模型服务](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/serving.py)

### Ollama

- Ollama 的兼容文档要求客户端传一个 `api_key`，但明确注释为「required but ignored」；这与 OpenAI 真实 key 校验不同，发现成功不能证明凭据有效。[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- Ollama 的 OpenAI 转换层把每个模型投影为 `id`、`object`、`created`、`owned_by`，包络为 `object: "list"` + `data`。文档说明 `created` 对应模型最后修改时间，`owned_by` 默认是 `library`；没有 price 或 context-window 字段。[官方转换代码](https://raw.githubusercontent.com/ollama/ollama/main/openai/openai.go) · [兼容文档](https://docs.ollama.com/api/openai-compatibility)
- `/v1/models` 路由是一个全量列表路由，没有 OpenAI 风格游标参数；不要把 Ollama 客户端所需的占位 key 当作认证能力，也不要期待列表返回上下文窗口。[Ollama route registration](https://raw.githubusercontent.com/ollama/ollama/main/server/routes.go) · [官方转换代码](https://raw.githubusercontent.com/ollama/ollama/main/openai/openai.go)

### llama.cpp server

- 非 router 模式同时提供 `/models` 与 `/v1/models`；handler 返回 `object: "list"`、`data: [get_model_info()]`，每项至少有 `id`、`object: "model"`、`created`、`owned_by: "llamacpp"`，并附带 `meta`（包括 `n_ctx`、`n_ctx_train` 等）。router 模式还会返回多个模型及状态、架构等额外字段。[route implementation](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp) · [router implementation](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-models.cpp)
- `/models` 和 `/v1/models` 被列为 public endpoints；即使配置 `--api-key`，鉴权中间件也跳过这两个路径。模型未 ready 时，非公开端点会返回 503 `{error:{message:"Loading model", type:"unavailable_error", code:503}}`，因此调用方要区分「鉴权失败」和「暂不可用」。[server routes](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server.cpp) · [HTTP middleware](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-http.cpp)
- 列表 handler 没有分页参数；`meta.n_ctx` 是 llama.cpp 自己的运行 / slot 信息，不能跨 provider 直接当作 Pi 的 `contextWindow`，也没有单价字段。[model info response](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp)

## 3. Pi 0.84.0 实际目录行为

### 3.1 静态目录与模型字段

Pi 的统一 `Model` 类型要求 `id`、`name`、`api`、`provider`、`baseUrl`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens`；兼容性字段 `compat` 可选。[Pi types.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/types.ts)

内置 provider 由生成的 `MODELS` 数据和各 provider factory 注册；`builtinProviders()` 返回固定 provider 集合，provider 的模型是代码生成目录，不是运行时对任意厂商发 `/models`。[Pi models.generated.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/models.generated.ts) · [Pi providers/all.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/providers/all.ts)

### 3.2 pi.dev 远程叠加层

coding-agent 在创建 runtime 时（除 `radius` 外）给内置 provider 包一层 `withRemoteCatalog`；远程端点是 `GET https://pi.dev/api/models/providers/<provider-id>`，不是用户配置 provider 的 `/models`。解析器接受数组、`{models: [...] }` 或对象值集合，只筛有 `id` 的条目并补上 provider id。[Pi model-runtime.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/model-runtime.ts) · [Pi remote-catalog-provider.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/remote-catalog-provider.ts)

远程目录先恢复本地 `models-store` 缓存，再按 4 小时 freshness window 刷新；成功响应记录 `last-modified` / `ETag`，304 只推进 `checkedAt`，404/501 标记来源不可用；其他非 2xx 保留已缓存模型并报告刷新错误。也就是说，Pi 已有「上次成功目录继续可用」的模型源语义，但这是 pi.dev provider overlay 的实现，不是 OpenAI-compatible 通用保证。[Pi remote-catalog-provider.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/remote-catalog-provider.ts)

刷新流程先恢复缓存，再解析 provider credential；未配置认证的动态 provider 不会进入联网刷新，失败通过 `ModelsRefreshResult.errors` 汇总而不是让整个模型集合崩掉。`getAvailable()` 还会再次按 provider auth 过滤可用模型。[Pi models.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/models.ts)

### 3.3 自定义 provider / 手填模型

`models.json` 的 schema 允许 provider 配置 `baseUrl`、`api`、headers、compat 和 models；一个独立的 model definition 至少要能从自身或 provider / 既有模型继承 `api` 与 `baseUrl`。Pi 对省略字段使用自己的默认值（cost 默认 0、contextWindow 默认 128000、maxTokens 默认 16384），这只是 Pi 的手填 fallback，不是服务端发现得出的事实。[Pi model-config.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/model-config.ts) · [Pi provider-composer.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/provider-composer.ts)

provider-composer 只有在底层 provider 或 extension 明确提供 `refreshModels` 时才挂刷新函数；普通 `models.json` 自定义 provider 不会自动探测其 base URL。[Pi provider-composer.ts](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/coding-agent/src/core/provider-composer.ts)

## 4. 给后续决策票的硬边界

### 可跨 provider 复用的部分

- 配置 provider 的 base URL、协议类型和凭据；发一个带超时、可取消的 GET；把 HTTP 非 2xx、网络错误、超时、JSON 解析错误和缺少数组 / 非空 id 统一归为「发现失败」。OpenAI 官方错误指南覆盖 401/403/429/5xx；vLLM 和 llama.cpp 又展示了完全不同的 401/503 body，因此 UI 只应保存可展示的状态码 / 原因，不应按固定错误字符串分支。[OpenAI errors](https://developers.openai.com/api/docs/guides/error-codes) · [vLLM auth](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/serve/middleware/authenticate.py) · [llama.cpp HTTP middleware](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-http.cpp)
- 成功响应只把 `data[*].id`（及可选 name / owner / created 等原样 metadata）作为候选；未知字段保留在 provider-specific metadata 或丢弃，不映射成跨厂商能力。所有三种自托管实现都证明额外字段会变化。[vLLM schema](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/engine/protocol.py) · [Ollama model type](https://raw.githubusercontent.com/ollama/ollama/main/openai/openai.go) · [llama.cpp model info](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp)
- 没有文档化分页时只发一次请求；只有某个 provider 明确声明 `limit` / cursor / `has_more` 才实现该 provider 的 adapter。标准 OpenAI 当前不分页，vLLM / Ollama / llama.cpp 的列表 handler 也不接受分页参数。[openai-node](https://raw.githubusercontent.com/openai/openai-node/master/src/resources/models.ts) · [vLLM route](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/models/api_router.py) · [llama.cpp route](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-context.cpp)

### 必须 provider-specific 或人工补齐的部分

| 要补的字段 | 原因 | 后续票建议 |
| --- | --- | --- |
| `api` / 协议、base URL | `/models` 通常只给 id；同一个 endpoint 可能支持 chat completions、responses 或只支持其中一个。 | 由 provider 配置决定，不从返回体猜。Pi 的 `Model.api` 是必需字段。[Pi types](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/types.ts) |
| `contextWindow` / max output | OpenAI / Ollama 列表不返回；vLLM / llama.cpp 的字段是实现特有且可能是服务当前配置。 | 目录只显示「未提供」；允许手填或引用厂商文档，并记录来源 / 时间。[Pi types](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/types.ts) |
| `cost` | 四个列表契约都没有统一单价；本地 server 也不可能从模型 id 推出部署者成本。 | 价目表、网关计费 API 或人工输入；未知时不要伪造 0 为「免费」。[Pi ModelCost](https://raw.githubusercontent.com/earendil-works/pi/v0.84.0/packages/ai/src/types.ts) |
| reasoning / image / tools / compat | 这些能力在各 server 的 OpenAI 兼容列表里没有共同 schema；vLLM 的 `permission`、llama.cpp 的 `architecture` 也不是统一能力声明。 | 只在有 provider adapter / 文档证据时填；否则以试运行错误或手工覆盖为准。[vLLM schema](https://raw.githubusercontent.com/vllm-project/vllm/main/vllm/entrypoints/openai/engine/protocol.py) · [llama.cpp router](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-models.cpp) |
| 鉴权是否成功 | OpenAI 要 Bearer；vLLM 依部署参数；Ollama 忽略 key；llama.cpp 对 models 路由公开。 | 把「目录可读」与「推理凭据已验证」分成两个状态；发现 200 不能替代最小推理验证。[OpenAI OpenAPI](https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml) · [Ollama docs](https://docs.ollama.com/api/openai-compatibility) · [llama.cpp HTTP middleware](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/server-http.cpp) |

**可直接落到后续 spec 的动作：**自动刷新成功时保存 `lastSuccessfulCatalog`、时间、HTTP 状态和原始 provider metadata；临时失败保留上次成功候选并给出失败原因；没有成功目录时仍允许同 provider 手填 `id`，但把 Pi 需要的 `api/baseUrl/contextWindow/maxTokens/cost` 显式要求或标为待补，不把默认值冒充发现事实。这样既利用标准 `/models` 的候选发现，也不会把服务特有字段锁进跨 provider 数据模型。

## 5. 一手来源清单（版本）

- OpenAI OpenAPI：`master`（spec version 2.3.0，文件头）。
- OpenAI 官方 Node SDK：`master`，`src/resources/models.ts`（含「当前不分页」注释）。
- Pi：tag `v0.84.0`，与仓库安装的 `@earendil-works/pi-coding-agent` 版本一致。
- vLLM：`main`（官方文档与源码）。
- Ollama：`main`（官方兼容文档与源码）。
- llama.cpp：`master`（官方 server README 与源码）。

本文不把临时网络探测结果当成 provider 契约；实现应以上述版本化源文件和 provider 自己的文档为准。
