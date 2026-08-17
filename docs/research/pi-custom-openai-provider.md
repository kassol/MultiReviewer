# Pi 如何登记非内置的 OpenAI-compatible provider

调研目标：查清内置表里没有的 provider 怎样进入 `ModelRuntime`、怎样带着模型被列出来并跑通；缺哪些字段会「根本列不出来」或落到本仓库的「模型不存在」。对应 issue #77。

## 证据来源

一手来源三类，正文中的 `文件:行号` 均指第一类（除非另标）：

1. **已安装的 `@earendil-works/pi-coding-agent@0.84.0`**（本仓库 pnpm 解析到的包）及其依赖 `@earendil-works/pi-ai@0.84.0` 的 `dist/` 与 `.d.ts`。路径写作包内相对路径，例如 `dist/core/provider-composer.js:48`。
2. **同包官方文档**：`docs/models.md`、`docs/custom-provider.md`、`docs/providers.md`（随包分发，非博客）。
3. **本仓库 Reviewer 运行时**：`src/reviewer/model-runtime.ts`、`catalog.ts`、`worker.ts`、`env.ts`、`pi-reviewer.ts`。

交叉参考：根 `AGENTS.md` 对 `modelsPath` / `authPath` / 远程 overlay 的既有记述；ADR 0004。

---

## 结论先行

非内置 OpenAI-compatible provider 有两条登记通道，缺一不可进入目录：

1. **写进 `models.json` 的 `providers.<id>`**（`ModelRuntime.create({ modelsPath })` 加载），或
2. **运行时 `ModelRuntime.registerProvider(id, config)` / `registerNativeProvider(provider)`**（扩展 API，见 `docs/custom-provider.md`）。

仅 `setRuntimeApiKey(providerId, key)` **不会**凭空造出 provider：`recomposeProvider` 在「无内置 / 无 models.json / 无 extension」时直接删掉该 id。

对全新 provider（无内置 base），`models` 里每一条模型在合成时都要求能解析出 **`api` 与 `baseUrl`**（provider 级或 model 级）。缺任一者合成抛错，该 provider 从目录里消失。`api` 取 `"openai-completions"`（Chat Completions，最常见的 OpenAI-compatible）；另有 `"openai-responses"` 等，走 `getApiProvider(model.api)`。

凭据没有「自定义 provider 专用环境变量名」表：内置 `envMap` 只覆盖已知 id。自定义侧靠 `models.json` 的 `apiKey`（`$ENV` / 字面量 / `!命令`）、`auth.json` 里以 provider id 为键的条目、或 SDK 的 `setRuntimeApiKey`。本仓库走最后一条，环境变量名固定为 `MULTIREVIEWER_MODEL_API_KEY`，再注入 Pi。

本仓库今天把 `modelsPath` 指到空临时目录、从不写自定义 `providers`、也不调 `registerProvider`，因此 **面板目录与子进程都只见内置（加远程 overlay）**；对未登记的 `provider:model`，`getModel` 回 `undefined`，worker 报「模型不存在」。

---

## 1. 登记通道与合成顺序

`ModelRuntime.create` 读 `modelsPath`（默认 `~/.pi/agent/models.json`；传 `null` 则不加载文件），再叠内置 provider 与扩展注册（`dist/core/model-runtime.js:76-88`）：

- `modelsPath === null` → 不加载文件；否则默认 `join(getAgentDir(), "models.json")`。
- `ModelConfig.load(modelsPath)` 得到用户配置。
- 内置表来自 `builtinProviderCatalog.builtinProviders()`，并可包上远程 catalog。
- `PI_OFFLINE` 一旦出现（任意值）即关掉联网刷新开关。

`providerIds()` 的并集是：内置 ∪ native extension ∪ **models.json 的 provider 键** ∪ extension config（`dist/core/model-runtime.js:123-129`）。

对每个 id，`recomposeProvider`（`model-runtime.js:131-156`）：

- 三者皆无 → `deleteProvider`，目录里没有这家。
- 仅有内置、无 overlay → 原样用内置。
- 否则 → `composeModelProvider(...)`；抛错则记入 `compositionErrors`，有内置 base 时回退内置，**无 base（全新自定义）则 `deleteProvider`**。

因此「根本列不出来」的直接原因是：未进 `providerIds()`，或合成失败且没有内置可回退。

`registerProvider` / `registerNativeProvider`（`model-runtime.js:544-595`）把配置放进 extension 层后同样走 `recomposeProvider`。官方文档 `docs/custom-provider.md` 说明扩展可注册完整 `Provider` 或 legacy `{ baseUrl, api, apiKey, models }` 形态。

远程目录（`dist/core/remote-catalog-provider.js:40+`）只包在**已有**内置 provider 上刷增量；**不会**新增 provider id。

---

## 2. `models.json` 字段（OpenAI-compatible 最小集）

官方最小例（`docs/models.md`「Minimal Example」）：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "llama3.1:8b" }]
    }
  }
}
```

Schema 与合成强制条件：

| 字段 | 位置 | 是否强制（全新 provider） | 依据 |
| --- | --- | --- | --- |
| `providers` 根对象 | 文件 | schema 要求 | `model-config.js:178-180` |
| provider 键（任意字符串 id） | `providers` | 是：这就是 provider id | `model-config.js:238-239` |
| `baseUrl` | provider 或 model | **是**（自定义模型） | `provider-composer.js:53-55`：`baseUrl is required when defining custom models` |
| `api` | provider 或 model | **是** | `provider-composer.js:49-51`：`no "api" specified` |
| `models[].id` | model | **是** | `model-config.js:134`（`minLength: 1`） |
| `apiKey` | provider | 否（加载文件） | `docs/models.md` Provider Configuration；见第 3 节 |
| `compat` | provider 或 model | 否 | 合并进模型；OpenAI 兼容开关见 `docs/models.md`「OpenAI Compatibility」 |
| `authHeader` | provider | 否，默认 false | `provider-composer.js:192`；为 true 时另加 `Authorization: Bearer <apiKey>` |
| `headers` | provider / model | 否 | 支持 `$ENV` / `!cmd` 解析 |
| `name` | provider / model | 否；缺省用 id | `provider-composer.js:64, 327` |
| `reasoning` / `input` / `cost` / `contextWindow` / `maxTokens` | model | 否；有默认 | `provider-composer.js:68-73`（如 contextWindow 默认 128000） |

`api` 合法取值文档表（`docs/models.md` Supported APIs）：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。运行时非内置模型的流式调用走 `getApiProvider(model.api)`（`provider-composer.js:318-323`）；未注册的 api 字符串报 `No API provider registered for api: ...`。`openai-completions` 在 pi-ai 内置 API 表里（`pi-ai/dist/compat.js:108-119`）。

部分 OpenAI-compatible 服务不认 `developer` role / `reasoning_effort` 时，文档要求设：

```json
"compat": {
  "supportsDeveloperRole": false,
  "supportsReasoningEffort": false
}
```

（`docs/models.md` Minimal Example 段落后说明。）

覆盖已有内置 provider 时可以只写 `baseUrl`、不写 `models`（保留内置模型列表）。全新 id 若既无 `models` 也无 `baseUrl`/`headers`/`compat`/`modelOverrides`/`apiKey`/`oauth`，`applyModelsJson` 抛 `must specify "baseUrl", "headers", "compat", "modelOverrides", or "models"`（`provider-composer.js:86-94`）。

文件缺失（ENOENT）→ 空 Map，不算错误；解析/schema 失败 → providers 空，错误进 `ModelConfig.getError()`，最终 `ModelRuntime.getError()`（`model-config.js:209-234`，`model-runtime.js:303-313`）。

---

## 3. Auth：没有通用「环境变量名」，三条路径

内置厂商在 `pi-ai/dist/env-api-keys.js:72-108` 的 `envMap` 里有固定变量（如 `openai` → `OPENAI_API_KEY`）。**自定义 id 不在表中**：`getApiKeyEnvVars` 回 `undefined`（同文件 `109-110`）。

自定义凭据来源：

1. **`models.json` 的 `apiKey`**：字面量、`$VAR` / `${VAR}`、或 `!shell`（`docs/models.md` Value Resolution）。仅配置了 `$VAR` 而环境里没有该变量时，`/model` 可用性检查视作未配置（`provider-composer.js:212-217` 的 `check`）。
2. **`auth.json`（`authPath`）**：键是 provider id，值形如 `{ "type": "api_key", "key": "..." }`（`docs/providers.md` Auth File；实现 `dist/core/auth-storage.js`）。
3. **`ModelRuntime.setRuntimeApiKey(providerId, apiKey)`**：进程内覆盖，不写盘（`runtime-credentials.js:8-19`；`model-runtime.js:392-397`）。

合成层对非 OAuth-only 的自定义 provider 会**造出**一套 API-key auth 方法（可 `/login` 提示输入），即使 `apiKey` 字段省略（`composeApiKeyAuth`，`provider-composer.js:184-250`）。文档对应句：`apiKey` 不是加载文件的前提；未配 auth 时模型仍加载，但在 `/model` 与 `--list-models` 里保持 unavailable（`docs/models.md` Provider Configuration）。

`openai-completions` 客户端用解析后的 `apiKey` 建 OpenAI SDK client（`pi-ai/dist/api/openai-completions.js:123-128, 482+`）。`authHeader: true` 是额外再塞 Bearer 头的开关，不是 OpenAI-compatible 的默认必填。

---

## 4. 本仓库 Reviewer 实际怎么接

| 点 | 行为 | 依据 |
| --- | --- | --- |
| `modelsPath` / `authPath` | 指向子进程私有空目录下的 `models.json` / `auth.json`，避免读 `~/.pi/agent` | `model-runtime.ts:52-60`，`catalog.ts:102-109` |
| 远程 overlay | 共用 `modelsStorePath`（缓存根下 `pi-models/models-store.json`）；子进程不联网 | `model-runtime.ts:30-38, 47-50`；`catalog.ts:92-95` |
| 凭据进子进程 | 父进程剥光 KEY/TOKEN 类变量后只注入 `MULTIREVIEWER_MODEL_API_KEY` | `env.ts:14, 22-39`；`pi-reviewer.ts:76` |
| 注入 Pi | `setRuntimeApiKey(request.provider, apiKey)` | `worker.ts:178` |
| 取模型 | `getModel(provider, model)`；假值则失败文案 `模型不存在: ${provider}/${model}` + 可选 overlay 提示 | `worker.ts:180-188`；`model-runtime.ts:72-86` |
| 目录 API | `runtime.getProviders()` → 面板；同样空 `models.json` | `catalog.ts:117-128` |

当前路径**从不**向临时 `models.json` 写入自定义 `providers`，也**不**调用 `registerProvider`。因此非内置 OpenAI-compatible 端点在本服务里既不会出现在面板目录，也不会被 worker 取到——与 Pi 侧「必须先登记 provider」一致，不是单独的凭据问题。

`setRuntimeApiKey` 之后仍会 `recomposeProvider`；若该 id 从未登记，分支落到 delete（`model-runtime.js:134-137`），随后 `getModel` 仍是 `undefined`。

---

## 5. 失败形态对照

| 现象 | 条件 | 依据 |
| --- | --- | --- |
| 目录里没有这家 provider | 未写入 models.json、未 register；或合成抛错且无内置 base | `model-runtime.js:131-155` |
| 合成错误（可经 `getError()` 看到） | 自定义 model 缺 `api` / 缺 `baseUrl`；provider 条目完全空；oauth 无 baseUrl | `provider-composer.js:49-55, 82-94` |
| CLI `/model` 看不到（仍可能 `getModel` 得到对象） | 已加载但 auth 未配置 | `docs/models.md`；可用性与 `hasConfiguredAuth` |
| 本仓库「模型不存在」 | `getModel` 假：未登记、model id 不在该 provider 列表、或仅存在于面板侧远程 overlay 而子进程 store 空 | `worker.ts:180-188`；`model-runtime.ts:1-7, 72-86` |
| 请求期 `No API provider registered for api: …` | `api` 字符串不在 pi-ai 注册表 | `provider-composer.js:318-320`；`compat.js:108-119` |
| schema / 解析失败 | 整份 models.json 作废，自定义全部不进 | `model-config.js:226-234` |

「列不出来」与「模型不存在」在本仓库是同一根：`getModel` / `getProviders` 看不到该条目。Auth 缺失在本仓库会先被 `缺少模型凭据` 挡住（`worker.ts:167-170`），走不到「模型不存在」。

---

## 6. SDK 侧与文档侧的登记示例（事实摘录）

`docs/models.md`：用户文件路径默认 `~/.pi/agent/models.json`；打开 `/model` 时重载。

`docs/custom-provider.md` legacy 注册：

```typescript
pi.registerProvider("my-provider", {
  name: "My Provider",
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "openai-completions",
  models: [{ id: "my-model", name: "My Model", reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 4096 }],
});
```

`ModelRuntime` 类型暴露同等方法：`registerProvider(providerId, config: ProviderConfigInput)`（`dist/core/model-runtime.d.ts:95-96`；`ProviderConfigInput` 在 `provider-composer.d.ts:16-41`）。

`examples/sdk/02-custom-model.ts`：`getModel("my-provider", "my-model")` 注释写明 custom models 来自 `models.json`。

`examples/sdk/09-api-keys-and-oauth.ts`：自定义 `authPath` / `modelsPath`，以及 `setRuntimeApiKey("anthropic", ...)`——后者假定 provider 已存在。
