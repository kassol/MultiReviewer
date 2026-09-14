# Agent 运行镜像与工具链调研

日期：2026-09-14。范围：Pi 内建工具的外部二进制依赖、候选运行镜像、rtk、context-mode 现状复核。未改任何源码，未装任何依赖，结论均标一手来源；查不到的标「未核实」。

## 问题清单

1. Pi 内建工具（read/grep/find/ls/bash/edit/write）各依赖什么外部二进制
2. 候选运行镜像比较：现状 vs 现成 agent 沙箱镜像
3. rtk 是什么、能否接到 Pi 上
4. context-mode 现在的版本，2026-09-12 的四条不集成理由是否仍成立

---

## 1. Pi 内建工具的外部依赖

**结论**：七个工具里只有 `bash`（shell 本身）、`find`（fd）、`grep`（ripgrep）会 spawn 外部二进制；`read`/`write`/`edit`/`ls` 是纯 `node:fs` 实现，不 spawn 任何东西。

| 工具 | 依赖 | 探测顺序 | 缺失时行为 |
| --- | --- | --- | --- |
| `read`/`write`/`edit`/`ls` | 无（`node:fs/promises`） | — | 不适用 |
| `bash` | `/bin/bash` \| PATH 上的 `bash` \| `sh` | `/bin/bash` 存在则用它；否则 `which bash`；再否则退到 `sh -c`（Unix 分支） | 找不到 bash 也不报错，静默退化成 `sh`；只有 Windows 分支在三种都找不到时才抛错（`utils/shell.js:93-101`） |
| `find` | `fd`（系统 PATH 探测名 `["fd","fdfind"]`，或 Pi 自己下载到 `getBinDir()`） | `getToolPath` 先查本地工具目录，再查系统 PATH 里 `fd`/`fdfind`（`utils/tools-manager.js:75-92`） | 都没有就去 GitHub Releases 下载，10s 网络超时 + 120s 下载超时；下载失败只报 `warning`，工具执行阶段才 reject（`utils/tools-manager.js:300-342`, `core/tools/find.js:119-127`） |
| `grep` | `rg`（无 `fdfind` 式别名，只认 `rg`） | 同上 `getToolPath` 逻辑 | 同上，失败时 reject `"ripgrep (rg) is not available and could not be downloaded"`（`core/tools/grep.js:52-56`） |

关键细节：

- `find` 工具固定传 `--no-require-git`（不在仓库内时），本仓库 Dockerfile 注释称这是 **fd 9.0** 加的参数，实际是 **fd v8.7.0**（[sharkdp/fd CHANGELOG.md#v8.7.0](https://github.com/sharkdp/fd/blob/master/CHANGELOG.md)：`Add flag --no-require-git to always respect gitignore files, see #1216`）。结论不受影响——镜像钉的是 10.5.0，双向都够——但 `Dockerfile:20` 那条注释的版本号写错了。
- `bash` 工具：无默认超时（`timeout` 参数可选，不传就无限等，`core/tools/bash.js:14-25`），用 `spawn`（非 shell 二次转义），stdout/stderr 合并成一条输出流，截断阈值是 `DEFAULT_MAX_LINES=2000` 行或 `DEFAULT_MAX_BYTES=50*1024` 字节（`core/tools/truncate.js:10-11`），超限截断为「保留末尾」并把全量写临时文件。`grep` 单行截断到 500 字符（`GREP_MAX_LINE_LENGTH`，同文件）。
- `bash` 起的子进程默认 `detached` 且被 `trackDetachedChildPid` 记录，abort/超时走 `killProcessTree`（Unix 用 `process.kill(-pid, "SIGKILL")` 杀整个进程组，`utils/shell.js:169-215`）。
- 本仓库现状：`src/reviewer/session-worker.ts:114-116` 只注册了 `grep`/`find`/`ls` 三个 Pi 内建工具definitions，`read` 用自定义 `numberedReadTool`（据 `pi-subagents-0.67-2026-09-12.md`），另外挂了自研的 `sessionGitTool`（`src/reviewer/git-tool.ts:289`）；`bash`/`edit`/`write` 未注册。

---

## 2. 候选运行镜像

**结论**：只读会话（现状）继续用 `node:24-slim` + 固定版本 `fd`/`rg` 最合适——体积最小、依赖数可控、完全对齐 AGENTS.md 的三方依赖约束。若会话要写代码（需要 `bash`/`edit`/`write`），现成的「agent 沙箱」镜像没有一个能直接照搬：codex-universal 许可证缺失、claude-code devcontainer 是 Anthropic 专有商业条款、microsoft universal 体积过大且语言工具链本项目用不上——更合理的路径是在现状 slim 镜像上按需追加 `git`/编译工具，而不是换底座。

| 镜像 | 基础系统 | 体积 | 预装工具链 | amd64 | 许可证 | 更新频率 |
| --- | --- | --- | --- | --- | --- | --- |
| **现状**（本仓库 `Dockerfile`） | `node:24-slim`（Debian bookworm） | 未核实（未构建测量），基础层通常 ~200MB 量级 | git、ca-certificates、ripgrep（apt）+ fd 10.5.0（GitHub Release 静态二进制） | 是，交叉构建（`scripts/build-push.sh`） | Node 官方镜像 MIT，git/ripgrep GPL/MIT 混合，均系统包不入 npm 依赖树 | 随本仓库提交走 |
| `openai/codex-universal` | `ubuntu:24.04` | 未核实（无 Release 产物，需自行 `docker pull` 测量） | Python 3.10–3.14、Node 18/20/22/24、Rust、Go、Java、Ruby、PHP、Swift、Elixir 全套多版本工具链（[Dockerfile](https://github.com/openai/codex-universal/blob/main/Dockerfile)） | 是，`ARG TARGETARCH` 分支处理 arm64/amd64 | **无 LICENSE 文件**（`gh api repos/openai/codex-universal` 的 `license` 字段为 `null`） | 慢，最近一次 push 2026-05-02，此前 2026-03-27、2026-01-21（`gh api repos/openai/codex-universal/commits`），近 4 个月未更新 |
| `anthropics/claude-code` `.devcontainer` | `node:20`（Debian） | 未核实 | git、gh、git-delta、zsh + `@anthropic-ai/claude-code`；无 Python/Rust/Go 等语言工具链（[Dockerfile](https://github.com/anthropics/claude-code/blob/main/.devcontainer/Dockerfile)） | 未注明（随 node:20 官方镜像多架构） | `© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service.`（[LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)），非标准开源许可 | `.devcontainer/` 目录最近改动 2026-06-30（`gh api ...commits?path=.devcontainer`） |
| `mcr.microsoft.com/devcontainers/universal` | Ubuntu（`devcontainers/images` 仓库 `src/universal`） | 第三方镜像统计约 3.29GB（compressed，linux/amd64；来源非 Microsoft 一手，**未核实**） | Python/Node/TS/C++/Java/C#/F#/.NET/PHP/Go/Ruby/Conda，zsh+oh-my-zsh、nvm、rbenv、SDKMAN、内置 SSHD（[README](https://github.com/devcontainers/images/tree/main/src/universal)） | 是 | MIT（`gh api repos/devcontainers/images` 的 `license.spdx_id`） | 活跃，`src/universal` 路径最近三次改动 2026-09-10/09-01/08-27 |

判断依据：只读会话不需要任何语言工具链，`bash`/`edit`/`write` 一旦开放，首要需求是 `git`（已在现状镜像里）与足够跑 `pnpm`/`node` 脚本的环境（`node:24-slim` 本身就够），不需要 Python/Rust/Go/Java 全套——那是 codex-universal / devcontainers-universal 为通用开发场景准备的，装了大量本项目用不上的工具链，体积代价换不回收益。claude-code devcontainer 体积和工具链都贴近本项目诉求，但商业许可证挡住直接复用其 Dockerfile 内容（可以看，不能照抄条款约束下的产物）。

---

## 3. rtk

**结论**：rtk 是一个独立于任何具体 agent 的 Rust CLI 代理，核心能力在二进制里（`rtk rewrite`），要接入某个 agent 需要该 agent 有「命令改写」的挂载点——Pi 已经有官方维护的 extension 做这件事，但挂载点是 Pi 的 `bash` 工具，本项目目前没注册 `bash`，接不上。

| 项 | 内容 | 来源 |
| --- | --- | --- |
| 功能 | CLI 代理，拦截/改写 shell 命令（如 `git status` → `rtk git status`），把命令输出在 Rust 层过滤压缩后再喂给 agent，声称减少 60–90% token | [rtk-ai/rtk README](https://github.com/rtk-ai/rtk) |
| 许可证 | Apache-2.0 | `gh api repos/rtk-ai/rtk` 的 `license.spdx_id`，及仓库 `LICENSE` 文件开头 `Apache License Version 2.0, January 2004` |
| 语言与分发 | Rust，单文件二进制零依赖；Homebrew / winget / 各平台预编译包 | README |
| 接入面 | 分层：Claude Code 等走 hook（PreToolUse，改写 bash 命令）；Pi 走**官方维护的 TypeScript extension** `@rsrini/pi-rtk`（[pi.dev/packages/@rsrini/pi-rtk](https://pi.dev/packages/@rsrini/pi-rtk)），装在 `.pi/extensions/rtk.ts` 或 `~/.pi/agent/extensions/rtk.ts` | rtk `hooks/pi/README.md`（[raw](https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/pi/README.md)）+ pi.dev 包页 |
| Pi 挂载点细节 | extension 订阅 Pi 的 `tool_call` 事件，只筛 `bash` 工具（`isBashToolCallEvent` 守卫），把 bash 命令重写成 `rtk` 前缀等价命令再放行；不拦截 `grep`/`find`/`read`；不做权限控制，"Permission gating is intentionally out of scope" | rtk `hooks/pi/README.md` |
| 是否需要联网 | 不需要；extension 通过 `pi.exec` 调用本机已装的 `rtk` 二进制（要求 ≥0.23.0），二进制本身另行安装 | 同上 |

**判断**：本项目 Reviewer/Agent 会话现在没有 `bash` 工具（`src/reviewer/session-worker.ts:114-116` 只有 grep/find/ls），`grep`/`find` 走的是 Pi 内建实现，不是 shell 命令，rtk 的挂载点（拦 `bash` 工具调用）压根没有信号可拦——**现在接不上**。若未来开放 `bash` 工具：接入方式是装 `@rsrini/pi-rtk` extension（纯 npm 包，不动 Pi 内核），收益取决于会话里 `bash` 输出占多大比例的上下文——本项目审查场景的大头是 `grep`/`find`/`read`，不是跑测试/构建命令，rtk 只优化后者，收益上限有限；且引入它会打破 AGENTS.md 的「运行时第三方依赖只有三个」（`typebox`/`pi-subagents`/隐含的 `pi-server`）约束，要不要破例是决策题，不在本文范围。

---

## 4. context-mode 现状复核

**结论**：npm `latest` 仍是 **1.0.169**（`registry.npmjs.org/context-mode` 的 `dist-tags.latest`），与 2026-09-12 评估的版本**完全相同**，两天内无新发布。四条不集成理由逐条复核如下，全部仍成立；若会话变可写，第一条（破坏只读）会松动，其余三条不会。

| 原理由 | 现状 | 依据 |
| --- | --- | --- |
| ① `ctx_execute` 子进程跑任意代码，打破只读 | 仍成立：`ctx_execute`/`ctx_execute_file`/`ctx_batch_execute` 在隔离子进程里跑 12 种语言运行时代码，"Each ctx_execute call spawns an isolated subprocess...runs your code" | [mksglu/context-mode README](https://github.com/mksglu/context-mode) |
| ② `context`/`tool_call` hook 改写 system prompt | 仍成立但机制变了：v1.0.163（2026-09-12 之前发布，已含在当前 1.0.169 里）的 PR #822 把 Pi 平台从「直接改写 systemPrompt」换成「走 `context` hook 注入，以保住 provider 的 prefix cache」——本质仍是往上下文里塞路由指令，只是不再暴力替换 `systemPrompt` 字符串 | 搜索结果引用 PR #822 描述："stops mutating systemPrompt; inject via context hook to preserve the provider prefix cache"（**二手转述，未直接读到 PR 原文或对应源码文件，标记未核实**） |
| ③ 许可证 Elastic-2.0 + `better-sqlite3` + MCP 子进程违反依赖约束 | 仍成立：npm `registry.npmjs.org` 上 1.0.169 的 `license` 字段是 `Elastic-2.0`（评审复核 2026-09-14 直接查得），仓库 `LICENSE` 文件同为 **Elastic License 2.0**（"Elastic License 2.0 (ELv2), Copyright 2026 Mert Koseoglu"），README 徽章也标 `License: ELv2`；GitHub 侧 `license.spdx_id` 返回 `NOASSERTION`（无法识别为标准 SPDX 许可证，与 ELv2 非开源批准许可证的性质一致）。依赖里 `better-sqlite3@^12.6.2` 与 `@modelcontextprotocol/sdk@^1.26.0` 均在 1.0.169 里确认存在 | `registry.npmjs.org/context-mode`；[GitHub LICENSE](https://github.com/mksglu/context-mode/blob/main/LICENSE)；`gh api repos/mksglu/context-mode` |
| ④ context-mode 要解决的「上下文压缩」问题，本项目已经用自己的机制解了，没有引入它的必要 | 仍成立：取证子会话有每批每模型的次数预算 `EVIDENCE_SESSION_BUDGET`（`src/reviewer/evidence.ts:65-66`，ADR 0021），读文件走自定义 `numberedReadTool`（`src/reviewer/worker.ts:39,628`），Pi 内建 `read`/`grep`/`find` 本身也自带行数/字节截断（`DEFAULT_MAX_LINES=2000`、`DEFAULT_MAX_BYTES=50KB`，见问题 1）。这套组合已经覆盖 context-mode 要解决的「工具输出撑爆上下文」问题，架构未变 | `src/reviewer/evidence.ts:65-66`；`src/reviewer/worker.ts:39,628` |

**若会话变可写**：一旦 Reviewer/Agent 会话本身注册了 `bash`/`edit`/`write`，「`ctx_execute` 打破只读」这条理由自动失效——会话已经能任意执行代码，context-mode 的子进程沙箱不再是新增的风险面，甚至可能比裸 `bash` 更受控（有隔离边界）。但理由 ③（许可证 + 依赖数）是硬约束，理由 ②（上下文注入）是架构问题，理由 ④（重复造轮子）是需求问题，三条都与会话是否可写无关，不会松动。

**未核实项**：

1. PR #822（Pi 的 systemPrompt→context hook 切换）的具体源码/diff 未直接读到，只有二手转述。
2. 现状镜像与 codex-universal / claude-code devcontainer / devcontainers-universal 的实际构建体积（GB）均未实测。
3. devcontainers-universal 的 3.29GB 数据来自第三方镜像仓库（`ybor/devcontainer`），非 Microsoft 一手来源。

---

## 对本项目的建议

- Q1 的唯一行动项：`Dockerfile:20` 注释里的 fd 版本号（"9.0"）与 sharkdp/fd 官方 CHANGELOG（8.7.0）不符，建议顺手改成 8.7.0，不影响功能结论。
- Q2：只读会话继续用现状 `node:24-slim`，符合体积与依赖约束；写代码会话若立项，方向是在现状镜像上加 `bash` 需要的最小工具集（不是换成通用开发镜像），因为三个候选镜像分别有许可证不明、专有条款、体积/工具链过剩三个问题之一。
- Q3：rtk 现在没有可拦截的信号（本项目没注册 `bash` 工具），暂时接不上；写代码会话立项后再评估是否值得为它破例三方依赖约束。
- Q4：不集成的结论不变，四条理由仍全部成立；写代码会话立项会让理由①的权重下降，但②③④依然拦得住。
