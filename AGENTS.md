# AGENTS.md

## 项目概述

MultiReviewer:基于真实 Coding Agent 的多模型并行 PR 智能审查工具。首个目标平台为 self-hosted Gitea,后续扩展 GitHub。核心差异:Agent 驱动(可打开文件、探索上下文)+ 多模型交叉验证降误报 + 增量可收敛审查。

产品与架构草案见 `docs/idea.md`。

## 技术栈

未定,待 grilling / spec 阶段确定。

## 目录索引

- `docs/` — 设计文档。`idea.md` 为初始产品与架构草案。

## 常用命令

暂无。

## 全局规范

- 领域术语以本文件与 `CONTEXT.md`(建立后)定义为准,代码、注释、沟通全程统一
- commit message 用英文,简洁描述变更意图

## 变更日志

- 2026-08-07: 项目初始化。git init,收录初始想法文档 `docs/idea.md`,创建 GitHub public repo。
