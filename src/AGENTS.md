# src/AGENTS.md

## 职责

编排服务的全部源码。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `forge/` — Forge 适配层。`forge.ts` 是接口与领域类型,每个平台一个实现文件。
- `git/` — 工作副本的准备与 diff 读取,直接调用 git 命令。
- `review/` — Review Run 的编排。`run.ts` 是唯一入口 `runReview`,其余是它的内部构件。
- `reviewer/` — Reviewer 的真实实现。`pi-reviewer.ts` 在主进程侧管子进程,`worker.ts` 是子进程入口,两者只经 `protocol.ts` 定义的消息通信。

## 模块规范

- 只有 `Forge` 与 `Reviewer` 是注入边界。git 与 SQLite 直接使用实现,不加接口。
- `Forge` 接口只包含 Gitea 与 GitHub 都具备的能力(ADR 0002)。实现 GitHub 适配时不得因其能力更强而扩张接口。
- 行号一律指 head commit 中该文件的 1-indexed 行号。Gitea 的 `new_position` 与 GitHub 的 `line` 都是这个语义,接口不暴露 diff 内偏移。
- 凭据不写进 remote URL,也不落盘。每次 git 调用以 `http.extraHeader` 传入。
- 模型凭据只经 `MODEL_API_KEY_ENV` 一个环境变量进入 Reviewer 子进程,不进 IPC 消息——消息会被日志与崩溃转储带出去。
- Pi 的 `authPath`、`modelsPath` 与 agent 目录一律指向子进程私有的临时目录。默认值在 `~/.pi/agent` 下,那里的 `auth.json` 存着宿主机上配置过的每一家厂商的凭据。
- 类型只用可擦除语法(`erasableSyntaxOnly`),源码由 Node 直接运行,无构建步骤。模块内互相引用时 import 路径带 `.ts` 后缀。

## 依赖关系

`review/` 依赖 `forge/` 与 `git/` 的类型与函数。`reviewer/` 依赖 `review/` 的领域类型,反向不依赖——`runReview` 只认 `Reviewer` 接口。`forge/` 与 `git/` 互不依赖。

第三方依赖只有 Pi(`@earendil-works/pi-coding-agent`)与它的 `typebox`,且只在 `reviewer/` 内使用。

## 变更日志

- 2026-08-08: 建立 `forge/`、`git/`、`review/` 三个目录。落地 `Forge` 接口与 GitHub 实现、工作副本准备、`runReview` 骨架(issue #2)。
