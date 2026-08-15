# web/AGENTS.md

## 职责

管理面板的前端:TanStack Router + Query 的纯前端 SPA,与 JSON API 同进程部署。Vite 构建,产物(`dist/`)不进版本库,在 Docker 多阶段构建里生成,由服务经 `/assets` 与 `<前缀>/*` 提供。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `index.html` — Vite 入口。生产由服务注入前缀全局变量后返回;dev 由 `vite.config.ts` 的内联插件注入同名变量。
- `vite.config.ts` — 前缀与后端端口从仓库根的同一份 `.env` 读(`loadEnv`);dev proxy 把 `<前缀>/api` 转本机后端;注入插件 `apply: "serve"`,只在 dev 生效。
- `src/injected.ts` — 读注入全局变量的唯一代码路径,缺失当场报错并在页面写明原因。
- `src/api.ts` — 面板 API 的唯一入口,基址从注入的前缀来。
- `src/main.tsx` — 路由与壳:`/login` 一屏登录,`shell` 下挂三页(`/repos` / `/runs` / `/stats`),Router `basepath` 取注入前缀。
- `src/login.tsx` — 登录页,单 token 输入框。
- `src/repos.tsx` — 仓库页,master-detail(原型变体 A):左列表右详情,注册 / 改组合走模态框,移除用应用内确认模态(不用 `window.confirm`——原生对话框阻塞渲染线程,浏览器自动化与 dogfooding 都会被卡死),核对差异卡片的「轮转推平」调轮转端点。对变体 A 的两处显式偏离:「最近的 Review Run」表连同「输 PR 号重跑」归 issue #37 的手动重跑一并落;key 面板的「建立于」换成「代次」——代次是 ADR 0007 之后 key 真正有信息量的属性。
- `src/styles.css` — 设计令牌与组件样式,取自 prototype/panel-layout 的定稿,含暗色模式。

## 模块规范

- 前端只读注入的 `window.__MULTIREVIEWER__`,不设 `import.meta.env` 回落——分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」不该存在。注入形状必须与服务端(`src/webhook/server.ts` 的 `servePage`)逐字一致。
- Vite 保持默认绝对 base(`/`):静态资源不进前缀,构建产物与前缀无关。**注入插件永远不参与 build**——前缀烤进产物即事故。
- 构建产物是纯静态文件:服务端的运行时第三方依赖仍只有 Pi,react 全家只活在构建阶段。
- 未认证的判据是 `GET <前缀>/api/session` 非 204,壳的 `beforeLoad` 统一送去 `/login`,页面组件不各自判。
- 前端不做程序化测试(issue #26 的测试决策):布局与交互由原型定稿,逻辑压在服务端可测的注入变量与 API 契约上(`test/panel-pages.test.ts`);交付时提供手动测试步骤。

## 依赖关系

不依赖仓库里任何服务端代码;与服务端的契约只有两条:注入全局变量的形状、`<前缀>/api` 的 JSON 端点。

## 常用命令

- `pnpm --filter @multireviewer/web dev` — dev 起 Vite(另开一个终端跑 `pnpm start` 起后端,双进程)
- `pnpm --filter @multireviewer/web build` — 产出 `dist/`
- `pnpm --filter @multireviewer/web typecheck` — 前端类型检查(不在根 `pnpm check` 里,改前端后单独跑)

## 变更日志

- 2026-08-15: 落地 issue #33。脚手架从零起:Vite + React + TanStack Router/Query,登录一屏加三页顶部导航的空壳,Docker 多阶段构建。
- 2026-08-15: 落地 issue #34。仓库页按原型变体 A 落地(`src/repos.tsx` + `src/styles.css`):左列表按最近活动排序,右详情含核对差异卡片(轮转推平)、准入 key 面板(不回显,只显代次)、模型组合面板(覆盖 JSON 与配置文件同形状)、累计量。注册 / 改组合 / 移除确认全走应用内模态。真实浏览器走通注册 → 轮转 → 差异推平 → 改组合 → 移除全流程。
