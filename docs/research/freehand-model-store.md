# 手填模型标识怎样才能被 Reviewer 取到

调研目标：对一个已有 provider（例如 `openrouter`），把从未出现在 Pi 内置表与 pi.dev 远程目录里的 model id 写进与 Reviewer 共用的目录落盘之后，不联网的子进程能否取到并开跑；必须带齐哪些字段；只改面板目录、不写落盘会怎样。对应 issue #78。

## 证据来源

一手来源三类，正文中的 `文件:行号` 均指前两类本仓库路径；第三类是安装版 Pi 包（版本钉在本仓库依赖上）：

1. **本仓库源码与测试**：`src/reviewer/model-runtime.ts`、`catalog.ts`、`worker.ts`，测试 `test/reviewer-model-store.test.ts`、`test/catalog-remote.test.ts`。
2. **本机一份示例 overlay**：`.cache/worktrees/pi-models/models-store.json`（形状示例，不是权威契约；权威以 Pi 类型与恢复代码为准）。
3. **安装包** `@earendil-works/pi-coding-agent@0.84.0` 与 `@earendil-works/pi-ai@0.84.0`：`FileModelsStore`、`withRemoteCatalog` / `refreshModels`、`Model` 类型、`openai-completions` 对流式请求的 `baseUrl` 用法。

交叉参考：`src/AGENTS.md` 面板与子进程共用 store 一节、`AGENTS.md` 的 `MULTIREVIEWER_CACHE_DIR` 说明。

---

## 结论先行

**能。**把完整的 `Model` 写进共用落盘 `MULTIREVIEWER_CACHE_DIR/pi-models/models-store.json` 对应 provider 条目后，不联网的 Reviewer 子进程能 `getModel` 取到并交给 `createAgentSession` 开跑。面板进程内存里的目录与子进程无关：只改面板侧目录、不写这份落盘，子进程报「模型不存在」。

取到与开跑的门槛不同：取到靠 store 恢复条件；开跑还要模型对象带齐 Pi `Model` 运行字段（至少含 `api` 与 `baseUrl`）。本仓库现有测试只断言「取到」，没有覆盖「开跑」。

---

## 1. 共用通路只有一份落盘文件

面板与子进程各自建 `ModelRuntime`，各自把 `authPath` / `modelsPath` 指进私有临时目录（避免读到宿主机 `~/.pi/agent/auth.json`）。两侧唯一共享的是绝对路径的 store：

| 侧 | 联网 | store 路径 | 代码 |
| --- | --- | --- | --- |
| 面板 `loadFromPi` | 默认可（`PI_OFFLINE` 关掉） | `modelsStorePath()` | `src/reviewer/catalog.ts:105-109,112-115` |
| Reviewer 子进程 | 从不 | 同上 | `src/reviewer/worker.ts:176-177`；`src/reviewer/model-runtime.ts:52-60` |

`modelsStorePath()` 解析为 `resolve(MULTIREVIEWER_CACHE_DIR ?? ".cache/worktrees", "pi-models/models-store.json")`，且必须是绝对路径——子进程 `cwd` 是工作副本，相对路径会指到别处（`model-runtime.ts:19-34`）。

子进程取模型：

```180:188:src/reviewer/worker.ts
  const model = modelRuntime.getModel(request.provider, request.model);
  if (!model) {
    send({
      kind: "done",
      rejectedToolCalls: 0,
      anchorRejections: 0,
      failure: `模型不存在: ${request.provider}/${request.model}${missingModelHint(storePath)}`,
    });
```

`reviewerModelRuntime` 不传 `allowModelNetwork`。`ModelRuntime.create` 因此只跑 `refresh({ allowNetwork: false })`（`pi-coding-agent/.../model-runtime.js:91-100`）。不联网不等于不读 store：见下一节。

`modelsPath` 指向的空 `models.json` 是另一条路（Pi 的自定义 provider 配置）。本服务两侧都把它指进每次新建的空临时目录（`model-runtime.ts:43-59`、`catalog.ts:102-108`），**手填模型不走这条路**；与 Reviewer 共用的只有 `models-store.json`。

---

## 2. 不联网时 Pi 怎样从 store 恢复

`Models.refresh` 对每个带 `refreshModels` 的 provider 先跑一趟 `allowNetwork: false` 的恢复，再视情况联网（`pi-ai/.../models.js:153-162`）。内置 provider 经 `withRemoteCatalog` 包装后都有 `refreshModels`（`pi-coding-agent/.../model-runtime.js:82-87`）。

`withRemoteCatalog` 的恢复逻辑（`pi-coding-agent/.../remote-catalog-provider.js:31-56`）：

1. 读 `context.stored`（即 `FileModelsStore.read(providerId)`）。
2. `remoteModels(entry, localGeneratedAt)`：若 `lastModified` 缺失，或 `lastModified <=` 内置表 `generatedAt`，返回空数组——整段 overlay 丢掉。
3. 再 `filter(model => model.provider === provider.id)`。
4. `publish({ update })` 把结果并进该 provider 的动态表（同 id 覆盖，新 id 追加；`mergeModels` 在同文件 6-15 行）。
5. `allowNetwork === false` 时到此返回，不发 HTTP。

内置表时间戳来自 `@earendil-works/pi-ai` 的 `providers/data/.manifest.json` 的 `generatedAt`（本安装版为 `2026-08-06T11:03:30.465Z`）。本仓库测试因此把 `lastModified` / `checkedAt` 写成远未来，避免随 Pi 升级被整条丢掉（`test/reviewer-model-store.test.ts:36-40,49-68`）。

`checkedAt` 只影响「4 小时内是否跳过联网重拉」（同文件 57-61 行，`REMOTE_CATALOG_REFRESH_INTERVAL_MS`）。离线恢复不看 `checkedAt`。

`FileModelsStore` 按 provider id 读写整个 JSON 对象顶层键；读写带文件锁（`pi-coding-agent/.../models-store.js:25-112`）。

本仓库已用预置 store、打桩 `fetch` 证明：子进程零对外请求即可 `getModel` 到「只在 overlay 里」的模型（`test/reviewer-model-store.test.ts:72-88`）。

---

## 3. 落盘形状与必填字段

### 3.1 Store 条目（按 provider）

类型 `ModelsStoreEntry`（`pi-ai/.../models-store.d.ts:2-13`）：

| 字段 | 恢复是否必需 | 语义 |
| --- | --- | --- |
| `models` | 是 | `Model[]` |
| `lastModified` | **是**（且必须 `>` 内置 `generatedAt`） | 远程 `Last-Modified` 的 unix ms；过旧整段丢弃 |
| `checkedAt` | 否（离线） | 上次完成远程检查的 unix ms；管 4 小时刷新窗 |
| `etag` | 否 | 远程 ETag，联网时作 `If-None-Match` |

顶层 JSON 形如 `{ "openrouter": { models, lastModified, checkedAt?, etag? }, ... }`。示例文件 `.cache/worktrees/pi-models/models-store.json` 当前有 `deepseek` / `openrouter` / `kimi-coding` 三家；`openrouter` 下约 348 条，单条字段与下表一致。

### 3.2 模型对象：取到 vs 开跑

Pi 的 `Model` 接口（`pi-ai/.../types.d.ts:661-682`）声明：

`id`、`name`、`api`、`provider`、`baseUrl`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens`（另有可选 `thinkingLevelMap` / `samplingParams` / `headers` / `compat`）。

| 目的 | 最少要什么 | 依据 |
| --- | --- | --- |
| **取到**（`getModel` 非空） | 条目过 `lastModified` 门槛；模型带正确的 `provider`（等于顶层键 / provider id）与目标 `id` | 恢复过滤器 `model.provider === provider.id`（`remote-catalog-provider.js:47`）；`worker.ts:180` 只查有无 |
| **开跑**（会话真正对流式 API 发请求） | 上表整份 `Model` 运行字段齐，**尤其 `baseUrl` 与 `api`** | `openai-completions` 用 `baseURL: model.baseUrl`，并直接调用 `model.baseUrl.includes(...)`（`pi-ai/.../api/openai-completions.js:510,523,1163+`）；缺 `baseUrl` 在发请求前就会炸。`openrouter` 的 provider 工厂虽挂的是单一 `openai-completions` 实现（`pi-ai/.../providers/openrouter.js`），`api` 仍应按同家现货写成 `"openai-completions"`，与内置 / 远程行一致 |

示例落盘中一条 openrouter 现货的完整键：`api`、`baseUrl`、`compat`、`contextWindow`、`cost`、`id`、`input`、`maxTokens`、`name`、`provider`、`reasoning`（部分另有 `thinkingLevelMap`）。内置 `openrouter.json` 叶子同形。

本仓库「overlay 取到」测试写入的最小集是（`test/reviewer-model-store.test.ts:54-63`）：

`id`、`provider`、`name`、`contextWindow`、`maxTokens`、`cost`、`input`、`reasoning`——**没有 `api` / `baseUrl`**。它只证明 `getModel` 成功，不证明 `session.prompt` 能跑通。手填若要开跑，应按现货完整形状写，不要照抄该测试的最小集。

`cost` 四元组（`input` / `output` / `cacheRead` / `cacheWrite`）参与 Pi 会话用量折算；手填可填 0，但字段要在。`compat` 可选：未设时 openai-completions 会按 `provider` / `baseUrl` 自动探测（同文件 `getCompat`）。

### 3.3 写进哪一家、怎样并入

- 顶层键必须是**已有** builtin provider id（例如 `openrouter`）。`withRemoteCatalog` 只包在 builtin 列表上；没有这家就没有 `refreshModels`，store 里的条目不会被恢复进运行时。
- 应把新手填 **append / merge 进该 provider 已有的 `models` 数组**，并保留（或刷新）足够新的 `lastModified`。不要只留手填一条把现货 overlay 冲掉，除非有意如此。
- 联网刷新成功时，Pi **整段替换**该 provider 的 `persist.models` 为远程响应（`remote-catalog-provider.js:105-116`）。手填条目在下一次成功的面板远程刷新后会被抹掉，除非之后再次写入，或落在 4 小时窗内且未 `force`（窗内跳过重拉，同文件 57-61）。子进程从不联网，不会自己抹；抹发生在面板侧 `loadFromPi` / `refreshRemote`。

---

## 4. 只改面板目录、不写落盘

面板目录来源是进程内一次 `loadFromPi` 的结果，缓存在 `catalog.ts` 的模块级 `cached`（`catalog.ts:67-80,117-128`）。子进程是另一次 `fork` 出来的进程（`pi-reviewer.ts`），只读 `models-store.json`，读不到面板进程的内存。

因此：

| 操作 | 子进程结果 |
| --- | --- |
| 手填写进共用 `models-store.json`（字段合格） | `getModel` 成功；字段齐则可开跑 |
| 只改面板内存 / 只让 `/catalog` 多出一项、store 不动 | `getModel` 失败 → `模型不存在: provider/model`，并可能带上 `missingModelHint`（`worker.ts:180-188`；`model-runtime.ts:72-86`） |
| 模型组合（settings）里写了裸标识，但 store 与内置都没有 | 同上。`assertReviewerSpecs` 只校验 `provider`/`model` 非空字符串与去重（`src/config.ts:31-59`），**不查目录** |

「面板从没读过目录、store 还没落盘」时，子进程只有内置表；远程多出来的模型同样取不到——措辞指向 store（`model-runtime.ts:63-86`）。手填与远程增量走同一条物理通路。

---

## 5. 对 issue #78 三问的直接回答

1. **不联网子进程能否取到并开跑？**  
   取到：能，只要写进共用 `models-store.json` 且 `lastModified` 新于内置表、`provider` 字段匹配。开跑：能，还要模型对象带齐 `Model` 运行字段（至少 `api`、`baseUrl`，以及 name / cost / contextWindow / maxTokens / input / reasoning）。凭据仍按现有路径注入；本票不涉及凭据。

2. **必须带齐哪些字段？**  
   Store 条目：`models` + 足够新的 `lastModified`。每个模型至少：`id`、`provider`（取到）；开跑再加 `name`、`api`、`baseUrl`、`reasoning`、`input`、`cost`、`contextWindow`、`maxTokens`。照抄同 provider 现货行最稳。

3. **只改面板目录、不写落盘？**  
   子进程取不到，Review Run 在该 Reviewer 上失败，文案为「模型不存在」。
