# 各家厂商的模型清单 API 现状

调研目标：查清厂商目录除 OpenRouter 之外还能接谁。对应 issue #79（地图 issue #76）。

## 证据来源

两类，正文中的数字与状态码均来自第二类：

1. **各厂商官方 API 文档**，逐条给 URL。
2. **无凭据实测**（2026-08-18，从本机直接 `GET`，不带任何 Authorization 头，20 秒超时）。响应码与首行响应体照录。

交叉参考：`src/reviewer/catalog.ts`、`src/reviewer/model-runtime.ts`、`src/panel/credential-check.ts`。

---

## 结论先行

**厂商目录这轮只接 OpenRouter，不点名第二家。**

判据是落盘那一行需要的字段。补进共用落盘 `models-store.json` 的模型必须带齐 `api` / `baseUrl` / `compat` / `cost` / `contextWindow`（`src/reviewer/model-runtime.ts:72-86`），否则 Reviewer 子进程取不到。三个门槛逐级筛：

| 门槛 | 通过的厂商 |
| --- | --- |
| 有公开的全量模型清单端点 | OpenAI、Anthropic、Google、DeepSeek、Mistral、Groq、Together、Fireworks、DashScope、火山、OpenRouter |
| 免鉴权可拉 | **只有 OpenRouter** |
| 响应自带单价与上下文窗口 | OpenRouter、Together |

三条全过的只有 OpenRouter 一家。第二家最接近的是 Together：字段齐，但要 key。

---

## 1. 无凭据实测

一次并发请求，不带 Authorization。Anthropic 那一行是本机网络不通，不是它的策略。

| Provider | 端点 | 无凭据结果 |
| --- | --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1/models` | **200，414 个模型** |
| OpenAI | `https://api.openai.com/v1/models` | 401 `Missing bearer authentication in header` |
| Anthropic | `https://api.anthropic.com/v1/models` | 本机连不上，未取到 |
| DeepSeek | `https://api.deepseek.com/models` | 401 `Authentication Fails (governor)` |
| Mistral | `https://api.mistral.ai/v1/models` | 401 `{"detail":"Invalid API Key"}` |
| Groq | `https://api.groq.com/openai/v1/models` | 401 `Invalid API Key` |
| Together | `https://api.together.xyz/v1/models` | 401 `Missing API key` |
| Moonshot | `https://api.moonshot.cn/v1/models` | 401 `Incorrect API key provided` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4/models` | 401 `Header中未收到Authorization参数` |
| xAI | `https://api.x.ai/v1/models` | 401 `unauthenticated:no-credentials` |
| DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1/models` | 401 `You didn't provide an API key` |
| 火山 | `https://ark.cn-beijing.volces.com/api/v3/models` | 401 `AuthenticationError` |
| Fireworks | `https://api.fireworks.ai/inference/v1/models` | 401 `You must provide an API key` |
| Google | `https://generativelanguage.googleapis.com/v1beta/models` | 403 `Method doesn't allow unregistered callers` |

OpenRouter 是这批里唯一一个不带凭据就给全量的。它是聚合平台，模型清单本身是它的商品目录，公开可读符合它的生意；一手厂商把清单挂在 key 之后是常态。

## 2. 响应字段

OpenRouter 实测每条含 18 个字段，选型与落盘需要的都在里面：

```
id, canonical_slug, hugging_face_id, name, created, description,
context_length, architecture, pricing, top_provider, per_request_limits,
supported_parameters, default_parameters, supported_voices,
knowledge_cutoff, expiration_date, links, reasoning
```

其余厂商按文档：

| Provider | 单价 | 上下文窗口 | 出处 |
| --- | --- | --- | --- |
| Together | 有 `pricing` | 有 `context_length` | <https://docs.together.ai/reference/models-1> |
| Groq | 无 | 有 `context_window` | <https://console.groq.com/docs/api-reference#models-list> |
| Anthropic | 无 | 有 `max_input` / `max_output` | <https://docs.anthropic.com/en/api/models-list> |
| OpenAI | 无 | 无（只有 `id` / `object` / `created` / `owned_by`） | <https://platform.openai.com/docs/api-reference/models/list> |
| DeepSeek | 无 | 无 | <https://api-docs.deepseek.com/api/list-models> |
| DashScope | 无 | 无（`/models/permissions` 查的是权限，不是目录） | <https://help.aliyun.com/zh/model-studio/> |

Moonshot、智谱、xAI、火山四家文档里没有全量清单端点，模型标识只能抄文档或控制台。

## 3. 对本项目的影响

- **单价缺失不是小事**：Review Run 的成本取自 Pi 的 `session.getSessionStats()`，定价表内置在 Pi 包里。厂商目录补进来的行如果 `cost` 留空，那一行跑出来的 Run 成本恒为零，统计上看不出花了多少钱。硬编码单价等于在本仓库维护一张会过期的价目表。
- **要 key 会调转依赖方向**：现在的目录加载不读凭据（`src/reviewer/catalog.ts:100-128`），凭据只在组装 Reviewer 时按 provider 取（ADR 0008）。接一家要 key 的厂商目录，目录加载就得反过来依赖凭据表，「还没配凭据也能看见完整目录」这条随之失效。
- **凭据本身的可信度有限**：厂商 key 的真发一次验证只认得 anthropic / openai / deepseek / openrouter 四家（`src/panel/credential-check.ts:12-33`），其余 35 家保存即算未验证。拿一把未验证的 key 去拉目录，失败时分不清是 key 不对还是厂商挂了。

结论落回同一处：一手厂商缺的模型走手填入口兜底，比为每家写一个要 key、还要外挂价目表的目录实现划算。

## 4. 未来若要接第二家

按顺序：Together（字段最全）→ Groq（缺单价）→ Anthropic（缺单价）。接之前先解决两件事：目录加载怎么拿到凭据，以及缺单价的行成本怎么算。这两件都不在 issue #76 的目的地范围内。
