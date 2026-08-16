# web/AGENTS.md

## 职责

管理面板的前端:TanStack Router + Query 的纯前端 SPA,与 JSON API 同进程部署。样式走 Tailwind v4,组件走 shadcn(Radix 底座)。Vite 构建,产物(`dist/`)不进版本库,在 Docker 多阶段构建里生成,由服务经 `/assets` 与 `<前缀>/*` 提供。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `index.html` — Vite 入口。生产由服务注入前缀全局变量后返回;dev 由 `vite.config.ts` 的内联插件注入同名变量。
- `vite.config.ts` — 前缀与后端端口从仓库根的同一份 `.env` 读(`loadEnv`);dev proxy 把 `<前缀>/api` 转本机后端;注入插件 `apply: "serve"`,只在 dev 生效。
- `src/injected.ts` — 读注入全局变量的唯一代码路径,缺失当场报错并在页面写明原因。
- `src/api.ts` — 面板 API 的唯一入口,基址从注入的前缀来。
- `src/main.tsx` — 路由与壳:`/login` 一屏登录,`shell` 下挂三页(`/repos` / `/runs` / `/stats`),Router `basepath` 取注入前缀。壳是左侧栏导航加一条 38px 的信息条,四屏共用;信息条里的总处置率与逐模型处置率与处置率页同源(同一个默认窗口的 `/stats`),前端只做求和。窄视口下侧栏改成顶部横排。
- `src/login.tsx` — 登录页,单 token 输入框。
- `src/repos.tsx` — 仓库页,左列表右详情。注册 / 改组合 / 移除确认三处都是 shadcn Dialog——焦点锁、Esc、`role="dialog"` 由组件给,不自己写。**不用 `window.confirm`**:原生对话框阻塞渲染线程,浏览器自动化与 dogfooding 都会被卡死。核对差异卡片的「轮转推平」调轮转端点。key 面板显示「代次」而非建立时间——代次是 ADR 0007 之后 key 真正有信息量的属性。
- `src/components/ui/` — shadcn 生成的组件(Dialog / Button / Input / Label / Table / Badge / Card),vendored 源码,改它就是改本项目的组件。已按视觉定稿把 Card 与 Dialog 的 ring 换成边框、圆角压到 `--radius`。**不引 shadcn Sidebar**:那套带折叠、移动端抽屉、cookie 记忆,这个面板一样用不上,侧栏与分栏用 utility 手写,进度条也是两个 div。
- `src/lib/utils.ts` — shadcn 的 `cn()`,clsx 加 tailwind-merge。
- `src/styles.css` — 只有设计令牌,没有组件类。

## 模块规范

- 前端只读注入的 `window.__MULTIREVIEWER__`,不设 `import.meta.env` 回落——分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」不该存在。注入形状必须与服务端(`src/webhook/server.ts` 的 `servePage`)逐字一致。
- Vite 保持默认绝对 base(`/`):静态资源不进前缀,构建产物与前缀无关。**注入插件永远不参与 build**——前缀烤进产物即事故。
- 构建产物是纯静态文件:服务端的运行时第三方依赖仍只有 Pi,react 全家只活在构建阶段。
- 未认证的判据是 `GET <前缀>/api/session` 非 204,壳的 `beforeLoad` 统一送去 `/login`,页面组件不各自判。
- **写样式只有 Tailwind utility 一条路。** `styles.css` 只放令牌,不许长出组件类——「这个间距该改哪一个」这个问题正是换底座要消灭的。
- **面板只做亮色一套**(issue #46)。不加主题上下文、本地存储、防闪脚本;`dark:` 变体被 `@custom-variant` 改挂到一个谁都不写的类上,等于关掉,shadcn 组件里那些 `dark:` 类因此不生效。要加暗色那天,在令牌层补一段媒体块重定义变量即可。
- 状态色是三态:`--destructive` 失败、`--warning` 需注意、`--success` 正常。后两个是自建的,shadcn 只给 `--destructive`,升级组件时要自己盯着。
- 前端不做程序化测试(issue #26 的测试决策):布局与交互由原型定稿,逻辑压在服务端可测的注入变量与 API 契约上(`test/panel-pages.test.ts`);交付时提供手动测试步骤。

## 依赖关系

不依赖仓库里任何服务端代码;与服务端的契约只有两条:注入全局变量的形状、`<前缀>/api` 的 JSON 端点。

构建期依赖:Tailwind v4 经 `@tailwindcss/vite` 接入;组件依赖 `radix-ui`(单包)、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`、`lucide-react`。`@/` 别名在 `tsconfig.json` 的 `paths` 与 `vite.config.ts` 的 `resolve.alias` 各配一次,两处要一起改。

## 常用命令

- `pnpm --filter @multireviewer/web dev` — dev 起 Vite(另开一个终端跑 `pnpm start` 起后端,双进程)
- `pnpm --filter @multireviewer/web build` — 产出 `dist/`
- `pnpm --filter @multireviewer/web typecheck` — 前端类型检查(不在根 `pnpm check` 里,改前端后单独跑)

## 变更日志

- 2026-08-15: 落地 issue #33。脚手架从零起:Vite + React + TanStack Router/Query,登录一屏加三页顶部导航的空壳,Docker 多阶段构建。
- 2026-08-15: 落地 issue #34。仓库页按原型变体 A 落地(`src/repos.tsx` + `src/styles.css`):左列表按最近活动排序,右详情含核对差异卡片(轮转推平)、准入 key 面板(不回显,只显代次)、模型组合面板(覆盖 JSON 与配置文件同形状)、累计量。注册 / 改组合 / 移除确认全走应用内模态。真实浏览器走通注册 → 轮转 → 差异推平 → 改组合 → 移除全流程。
- 2026-08-16: 落地 issue #36。处置率页按原型变体 B 落地(`src/stats.tsx`):模型卡片 + 模型 × 分类矩阵,每格 `x/y (z%)` 永远带分子分母,分母 = resolved + unresolved + 已关闭 PR 上的 unknown(ADR 0006,算式在 `denominator` 一处);日期窗默认最近 30 天,空窗给文案不给空表;库体量卡片列库文件大小与全部表行数。数据全部来自 `GET <前缀>/api/stats`,前端不自己二次统计。
- 2026-08-16: 落地 issue #37。评审记录页按原型变体 C 落地(`src/runs.tsx`):顶部统计带(近 30 天总处置率 + 逐模型,与 /stats 同源,前端只做求和)、按天分组的时间流、IntersectionObserver 滚动加载更早一页;卡片上「重跑」逐条可点。仓库页补「评审记录」区块(#34 递延的 runs 表):最近 8 轮加「输 PR 号重跑」表单,两个入口共用 `rerunRequest`。`stats.tsx` 导出 `Cell` 与 `denominator` 供统计带复用。评审复核收口:分天与时分按浏览器本地时区(UTC 日在东八区会把 16:00 后的 run 归前一天);`errorText` / `fetchJson` 收进 `api.ts` 消掉三份重复;卡片在无行级合并组时显示「无可处置项」而非「无 Finding」——纯正文 Finding 的 Run 有 Finding 但无处可 resolve;仓库过滤参数过 encodeURIComponent。
- 2026-08-16: 落地 issue #55 的换底座那一趟(#57–#63)。前端换到 Tailwind v4 + shadcn(Radix 底座),按「控制台」形态重做视觉,只做亮色一套。`styles.css` 从 191 行组件样式缩成一份 `@theme` 令牌,四屏样式全部走 utility;壳换成左侧栏加 38px 信息条,评审记录页原来的统计带并进信息条;三处手写模态换 shadcn Dialog(焦点锁、Esc、`role="dialog"` 白送);`RunPill` 内部换 Badge、接口一字不改,失败与待处置分成两色。暗色媒体查询与那个从没有代码写入的 `data-theme` 守卫一并删掉,`dark:` 变体经 `@custom-variant` 关掉。行为一律不变:动手前先照现状写了一份四屏手动验收基线(41 条,贴在 issue #55),迁完逐条重跑。代价是前端产物体积从 gzip 105 kB 涨到约 130 kB,已知并接受。
