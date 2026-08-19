# web/AGENTS.md

## 职责

管理面板的前端:TanStack Router + Query 的纯前端 SPA,与 JSON API 同进程部署。样式走 Tailwind v4,组件走 shadcn(Radix 底座)。Vite 构建,产物(`dist/`)不进版本库,在 Docker 多阶段构建里生成,由服务经 `/assets` 与 `<前缀>/*` 提供。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `index.html` — Vite 入口。生产由服务注入前缀全局变量后返回;dev 由 `vite.config.ts` 的内联插件注入同名变量。
- `vite.config.ts` — 前缀与后端端口从仓库根的同一份 `.env` 读(`loadEnv`);dev proxy 把 `<前缀>/api` 转本机后端;注入插件 `apply: "serve"`,只在 dev 生效。
- `src/injected.ts` — 读注入全局变量的唯一代码路径,缺失当场报错并在页面写明原因。
- `src/api.ts` — 面板 API 的唯一入口,基址从注入的前缀来。
- `src/model-catalog.ts` — 模型目录:`["catalog"]` 那一份查询、目录的三个类型(`CatalogProvider` / `CatalogModel` / `CatalogCost`)、模型标识的写法(`modelIdentity` / `parseModelIdentity`),以及单价留空那一档的说法(`COST_ZERO_NOTE`)。凭据页的 provider 下拉与两栏面板共用这一份:各拉一份查询会让「已配凭据」在两处不同步,各写一句措辞会让两边漂开。**单价与上下文窗口的写法不在这里**:两者各只有一个调用点(面板的模型行那一串「上下文 · 单价」),包成函数就是单表达式包装,已在那一处就地内联。它是 `components/model-picker.tsx` 改名来的(issue #91 删掉 `ModelPicker` 之后剩下的部分既不是组件也不带 JSX,所以落在 `src/` 里、与 `api.ts` 同级)。
- `src/main.tsx` — 路由与壳:`/login` 同一屏按 session 探测结果在登录与 bootstrap 注册间切换;`/password` 是必须改密页;`shell` 下挂六页(`/repos` / `/runs` / `/stats` / `/credentials` / `/settings` / `/access`)。Router `basepath` 取注入前缀。壳按 `GET /session` 回来的权限集先过滤导航再渲染:系统管理员全开且独有访问控制页,普通用户只看得到有读权限的页;零权限时导航全藏,内容区给一张说明并列系统管理员。窄视口下侧栏改成顶部横排、可横向滚动。
- `src/session.ts` — 当前身份与权限的唯一查询,缓存 `GET <前缀>/api/session`;未认证的 401 再由壳送去 `/login`,必须改密时统一送 `/password`,页面组件不各自探测。
- `src/login.tsx` — 登录与首次注册共用的一屏。普通档是用户名加密码;零用户档多 bootstrap 口令与确认密码,注册成功后回账号登录。所有字段有可见 `<Label>`,不靠 placeholder 当标签。
- `src/password.tsx` — 用户自改密码页,走 `PUT /session/password`;必须改密的人完成后回到自己有权访问的第一页。改密保留当前会话、作废其余会话。
- `src/access-control.tsx` — 系统管理员独有的 `/access` 页,上半用户表、下半转置权限矩阵(行是权限格、列是角色)。角色多时横向滚,权限格列 sticky。用户与角色读写走 `GET/POST /users`、`PUT/DELETE /users/:username`、`POST /users/:username/reset-password` 与 `GET/POST /roles`、`PUT/DELETE /roles/:id`;改角色是行内下拉,重置密码、删用户与删角色都走 Dialog。系统管理员不进矩阵;角色从全空创建,没授角色的用户就是零权限。
- `src/components/mark.tsx` — 产品标记(三条错位短线),与 `index.html` 里内联成 data URI 的 favicon 是同一份图形。用 `currentColor` 上色。
- `src/components/ui/skeleton.tsx` — 读取中的占位块。带 `data-slot="skeleton"`,`styles.css` 的降低动效偏好那一段据此关掉呼吸动画。
- `src/repos.tsx` — 仓库页,左列表右详情。模型组合是「跟随全局 / 自定义」两态开关(issue #69):点「跟随全局」直接清覆盖,一个动作;点「自定义」把详情里那一格换成编辑态(`ReviewersEditor`),面板就是全局设置页那一个 `ModelComposer`(issue #91,两处共用一份实现),选空时保存禁用,清覆盖仍是显式的 `{"reviewers": null}`。**编辑态不做对话框**:面板固定 460px 高,而 `ui/dialog.tsx` 的对话框只给宽度档位、没有最大高度与滚动,矮屏上底部的手填框与保存按钮会落到视口外面;面板里「+ 加一家 provider」本身就是一个对话框,套进来就是对话框叠对话框。编辑态里详情那一格并成单栏(两栏面板装不进 `md:grid-cols-2` 的半宽格子),**面板外面不套 `<form>`**——它自己带着手填模型行那张表单,嵌套的 form 会让填一个 model id 顺手把覆盖一起提交了。注册与移除确认两处是 shadcn Dialog——焦点锁、Esc、`role="dialog"` 由组件给,不自己写。**不用 `window.confirm`**:原生对话框阻塞渲染线程,浏览器自动化与 dogfooding 都会被卡死。核对差异卡片的「轮转推平」调轮转端点。key 面板显示「代次」而非建立时间——代次是 ADR 0007 之后 key 真正有信息量的属性。
- `src/credentials.tsx` — 凭据页(issue #64)。每个 provider 一把 key,粘进来即验证并保存;provider 从模型目录的可搜索下拉里选,不手输,每一行标出这家配过没有、保存时验不验证(`verifiable` 由 `/catalog` 给);列表只显示 provider、是否已配、更新时间与尾 4 位,明文从不回到前端。主密钥没设时端点回 503,整页切成一张「差什么」的卡片而不是报错——那一档服务照常起,只有这一页做不了事。

- `src/settings.tsx` — 全局设置页(issue #68)。全局模型组合与批次上限,读写 `<前缀>/api/settings`。表单以读回来的设置为初值,所以数据到了才挂载(`key` 取设置本身)。模型组合的编辑整块交给 `ModelComposer`,页面只留批次上限与那一颗保存按钮;**面板不在设置那张 `<form>` 里**——它自己带着手填模型行那张表单,套进同一个 `<form>` 既是非法嵌套,也会让填一个 model id 顺手把模型组合与批次上限一起保存了。
- `src/components/model-composer.tsx` — 模型组合的两栏面板(issue #90),形态取自原型变体 C(issue #83)。接口只有 `{value, onChange}`(当前模型组合加变更回调),目录、模型行与自定义 provider 三份查询由组件自己拿,写请求也归它;模型组合本身怎么存归调用页(全局设置 `PUT /settings`,仓库覆盖 `PUT /repos/<id>/reviewers` 并带「跟随全局」那一档)。**两处共用这一份面板,没有第二份实现**(issue #91):要给其中一处加东西就加入参,不分叉。左栏是厂商列,内置与自定义 provider 同列同渲染、各显示模型数与「未配凭据」,列底部「+ 加一家 provider」开对话框走 `POST /custom-providers`(名字 / base URL / 接口协议 / 第一个 model id / key 五项一次收齐)。右栏是选中那家的内容:头一行给这家的凭据状态与端点(自定义那几家在这里删),中间是模型列表,底部固定一行手填 model id 走 `POST /model-rows`。**手填框旁边不摆 provider 下拉**:provider 不是一个要填对的字段,是当前所处的位置,摆回下拉等于把这个形态的唯一好处还回去。**搜索框只筛当前这一家**,跨厂商搜索明确放弃(issue #83 的交易)。**右栏一次最多渲染 120 行**并在截断时提示,这个数沿用换掉的那个 Popover 选择器全部加起来的上限;手填提交后把搜索词设成刚填的 model id——openrouter 一家五百多个模型,新行会落在上限之外。已选的 chips 单独一张卡放在两栏之上,自定义 provider 带来的行标「自定义」、手填的标「手填」(前者看目录的 `custom` 位,后者看 `GET /model-rows`;自定义那家的模型全是模型行,所以 `custom` 优先),单价留空的挂 `COST_ZERO_NOTE`。
  - 名字冲突那一格(issue #94):判据是 `custom && conflict` 两位同时为真——目录端点在这一档给的是 Pi **内置**那一家的 `name` 与 `models`(登记的那一家被服务端整个停用了),`custom` 仍为真是因为库里那条登记还在、删得掉。呈现分两处:左栏行内只标一句红字「名字冲突,已停用」(那一列只有 220px,两条出路塞不下),点进去右栏头一行下面一条红色横幅写全,点名 `id` 撞上内置的 `name` 并给出改名重建与删掉两条出路——删除入口就在它上面那一行。**这一档右栏那些模型按钮一律禁用**:目录给的是内置那一家的模型,而登记的那一家自带凭据、`configured` 为真,只看它这些模型就选得进组合,而服务端只按 provider 名判撞名、一律当失败处理(判据见模块规范)。**手填框的禁用判据不跟着改,仍只看 `configured`**:撞名那一档 `POST /model-rows` 由服务端回 400 并写明原因,校验不在前端复制一份(沿用 issue #88 那条约定),按现有错误样式呈现即可。
- `src/components/ui/` — shadcn 生成的组件(Dialog / Button / Input / Label / Table / Badge / Card / Command / Popover / Calendar),vendored 源码,改它就是改本项目的组件。Calendar 的底座是 `react-day-picker`;它的 `DayButton` 原样把 `locale` 透传下去,在 `exactOptionalPropertyTypes` 下过不了类型检查,改成 undefined 时不传这个属性。已按视觉定稿把 Card 与 Dialog 的 ring 换成边框、圆角压到 `--radius`。**不引 shadcn Sidebar**:那套带折叠、移动端抽屉、cookie 记忆,这个面板一样用不上,侧栏与分栏用 utility 手写,进度条也是两个 div。
- `src/lib/utils.ts` — shadcn 的 `cn()`,clsx 加 tailwind-merge。
- `src/styles.css` — 设计令牌与浏览器原生面的接管,没有组件类。令牌是品类标准件(近黑主色、白底、冷灰外壳),手艺对标 GitHub / Linear / Vercel。三层底色(`--chrome` 外壳 / `--background` 内容 / `--card` 卡片)、六档字号阶梯(xs 11 / sm 13 / base 14 / lg 16 / xl 19 / 3xl 28,body 就是 sm),以及选区、光标、滚动条与表格数字的默认样式。

## 模块规范

- 前端只读注入的 `window.__MULTIREVIEWER__`,不设 `import.meta.env` 回落——分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」不该存在。注入形状必须与服务端(`src/webhook/server.ts` 的 `servePage`)逐字一致。
- Vite 保持默认绝对 base(`/`):静态资源不进前缀,构建产物与前缀无关。**注入插件永远不参与 build**——前缀烤进产物即事故。
- 构建产物是纯静态文件:服务端的运行时第三方依赖仍只有 Pi,react 全家只活在构建阶段。
- 当前身份与权限只从 `GET <前缀>/api/session` 读取,由 `src/session.ts` 缓存一份;未认证的 401 由壳统一送去 `/login`,必须改密统一送 `/password`,页面组件不各自判。导航按权限隐藏而不是摆禁用项,但服务端 403 仍是最终授权边界。
- **模型组合的编辑界面只有一份**(issue #91):全局设置页与仓库覆盖都挂 `components/model-composer.tsx`,接口是 `{value, onChange}`;「跟随全局」那一档与「选空时保存禁用」留在页面侧,面板不掺和。要给其中一处加东西就给面板加入参,不分叉出第二份——两份实现会让「加一家 provider」在两处长得不一样。
- **撞名停用的自定义 provider,它名下的模型一个都不许选**(issue #94)。判据是 `custom && conflict`,与左栏那句红字、右栏那条红色横幅同一个。只看 `configured` 不够:目录在这一档给的是 Pi 内置同名那一家的模型,而登记的那一家自带模型凭据、`configured` 为真,于是这些模型选得进组合、也存得下去;服务端组装 Reviewer 时只按 provider 名判撞名,存进去的一律当失败处理。两者共用同一个模型标识,保存层分不出人要的是哪一个,门禁因此只能立在面板上。已经选进组合的留着不动——面板不替人删,它们按 issue #94 定下的行为在 Review Run 里失败。红色横幅要写出「先改名或删掉这一家,这些模型才选得了」这条出路。**手填框的判据不跟着改,仍只看 `configured`**:往撞名那一家下面填模型行由服务端拒收(沿用 issue #88 那条约定,校验不在前端复制一份)。
- **删掉一家自定义 provider,同时把它的模型标识从本地的模型组合里摘掉。**服务端的引用检查只看已落库的组合,所以「先把这家的模型加进本地组合、在保存组合之前删掉这一家」这条路删得成;而模型组合端点不校验目录成员,保存也会被接受,悬空的标识要到下一次 Review Run 才报缺凭据或模型不存在。两条路里选「删除成功时就地摘掉」,不选「本地还引用着就不许删」:后者与服务端那道引用检查措辞重叠,而且人得先回去改组合才能删,对人更磨人。摘掉之后提示里写明记得保存——`onChange` 只动本地状态,组合怎么存归调用页。按 provider 名一律摘,撞名那一档也不例外:那些标识虽然删完就落到内置那一家身上、跑得起来,但人当初选的是自己那个端点,留着等于把它们悄声改指内置那一家,正是 issue #94 要拦的事。
- **写样式只有 Tailwind utility 一条路。** `styles.css` 只放令牌,不许长出组件类——「这个间距该改哪一个」这个问题正是换底座要消灭的。
- **面板只做亮色一套**(issue #46)。不加主题上下文、本地存储、防闪脚本;`dark:` 变体被 `@custom-variant` 改挂到一个谁都不写的类上,等于关掉,shadcn 组件里那些 `dark:` 类因此不生效。要加暗色那天,在令牌层补一段媒体块重定义变量即可。
- 状态色是三态:`--destructive` 失败、`--warning` 需注意、`--success` 正常。后两个是自建的,shadcn 只给 `--destructive`,升级组件时要自己盯着。三态都以 `text-*` 的形式压在浅底 badge 上,改色值前先算对比度:面板出现的四种底(`#fff` / `--background` / `--muted` / `--chrome`)上都要 ≥ 4.5:1。主色是近黑,不是青,也不是蓝。
- **字号只用令牌里那六档**,不写 `text-[13px]` 这类一次性值。档位各有唯一职责:xs 元信息、sm 正文与控件、base 区块标题、lg 对话框标题与选中仓库、xl 页标题(一页一个)、3xl 只给处置率页的指标数字。
- **等宽字体只包数字,不包中文。** `font-mono` 会把汉字撑成等宽格,「3 轮」因此读成断开的两块;写法是 `<span className="font-mono tabular-nums">{n}</span> 轮`。
- 时间一律「年-月-日 时:分」本地时区,不用 `toLocaleString()`——它给的是 `8/14/2026, 6:25:21 PM`,与全站的 ISO 风格对不上。
- 读取中给骨架块,不给「读取中…」那行字:骨架保住它替代的那块内容的尺寸,数据到了不跳版。
- 前端不做程序化测试(issue #26 的测试决策):逻辑压在服务端可测的注入变量与 API 契约上(`test/panel-pages.test.ts`);交付时提供手动测试步骤。
- **手动验证在部署实例上做,不在本机 dev 双进程上做**(根 `AGENTS.md` 的全局规范)。本机没有真 Gitea、没有已注册的仓库、没有模型凭据,面板上大半的屏在那里是空的;dev 双进程留给写样式时的即时反馈,不当验收手段。

## 依赖关系

不依赖仓库里任何服务端代码;与服务端的契约只有两条:注入全局变量的形状、`<前缀>/api` 的 JSON 端点。

构建期依赖:Tailwind v4 经 `@tailwindcss/vite` 接入;组件依赖 `radix-ui`(单包)、`cmdk`(Command 的底座)、`react-day-picker`(Calendar 的底座)、`class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`、`lucide-react`。`@/` 别名在 `tsconfig.json` 的 `paths` 与 `vite.config.ts` 的 `resolve.alias` 各配一次,两处要一起改。

## 常用命令

- `pnpm --filter @multireviewer/web dev` — dev 起 Vite(另开一个终端跑 `pnpm start` 起后端,双进程)
- `pnpm --filter @multireviewer/web build` — 产出 `dist/`
- `pnpm --filter @multireviewer/web typecheck` — 前端类型检查(不在根 `pnpm check` 里,改前端后单独跑)

## 变更日志

- 2026-08-19: 落地 issue #109 / #116 的前端门禁。登录从共享 token 改为本地用户名与密码,零用户时同一屏用 bootstrap 口令注册第一个系统管理员;`GET /session` 的身份与权限由 `session.ts` 统一缓存。壳按权限隐藏六页导航,必须改密统一进 `/password`,零权限用户看到说明而不是一圈点不动的页面。新增系统管理员独有的 `/access`(`access-control.tsx`):用户表与转置的角色 × 权限格矩阵同页,支持建号、行内授角色、重置密码、删号及角色增改删;系统管理员不进角色矩阵。

- 2026-08-15: 落地 issue #33。脚手架从零起:Vite + React + TanStack Router/Query,登录一屏加三页顶部导航的空壳,Docker 多阶段构建。
- 2026-08-15: 落地 issue #34。仓库页按原型变体 A 落地(`src/repos.tsx` + `src/styles.css`):左列表按最近活动排序,右详情含核对差异卡片(轮转推平)、准入 key 面板(不回显,只显代次)、模型组合面板(覆盖 JSON 与配置文件同形状)、累计量。注册 / 改组合 / 移除确认全走应用内模态。真实浏览器走通注册 → 轮转 → 差异推平 → 改组合 → 移除全流程。
- 2026-08-16: 落地 issue #36。处置率页按原型变体 B 落地(`src/stats.tsx`):模型卡片 + 模型 × 分类矩阵,每格 `x/y (z%)` 永远带分子分母,分母 = resolved + unresolved + 已关闭 PR 上的 unknown(ADR 0006,算式在 `denominator` 一处);日期窗默认最近 30 天,空窗给文案不给空表;库体量卡片列库文件大小与全部表行数。数据全部来自 `GET <前缀>/api/stats`,前端不自己二次统计。
- 2026-08-16: 落地 issue #37。评审记录页按原型变体 C 落地(`src/runs.tsx`):顶部统计带(近 30 天总处置率 + 逐模型,与 /stats 同源,前端只做求和)、按天分组的时间流、IntersectionObserver 滚动加载更早一页;卡片上「重跑」逐条可点。仓库页补「评审记录」区块(#34 递延的 runs 表):最近 8 轮加「输 PR 号重跑」表单,两个入口共用 `rerunRequest`。`stats.tsx` 导出 `Cell` 与 `denominator` 供统计带复用。评审复核收口:分天与时分按浏览器本地时区(UTC 日在东八区会把 16:00 后的 run 归前一天);`errorText` / `fetchJson` 收进 `api.ts` 消掉三份重复;卡片在无行级合并组时显示「无可处置项」而非「无 Finding」——纯正文 Finding 的 Run 有 Finding 但无处可 resolve;仓库过滤参数过 encodeURIComponent。
- 2026-08-16: 落地 issue #55 的换底座那一趟(#57–#63)。前端换到 Tailwind v4 + shadcn(Radix 底座),按「控制台」形态重做视觉,只做亮色一套。`styles.css` 从 191 行组件样式缩成一份 `@theme` 令牌,四屏样式全部走 utility;壳换成左侧栏加 38px 信息条,评审记录页原来的统计带并进信息条;三处手写模态换 shadcn Dialog(焦点锁、Esc、`role="dialog"` 白送);`RunPill` 内部换 Badge、接口一字不改,失败与待处置分成两色。暗色媒体查询与那个从没有代码写入的 `data-theme` 守卫一并删掉,`dark:` 变体经 `@custom-variant` 关掉。行为一律不变:动手前先照现状写了一份四屏手动验收基线(41 条,贴在 issue #55),迁完逐条重跑。代价是前端产物体积从 gzip 105 kB 涨到约 130 kB,已知并接受。
- 2026-08-16: 跟进 issue #73。仓库页的模型覆盖列表改显示模型标识 `provider:model`(`src/repos.tsx`),与「跟随全局」那一侧的取值形态一致——此前覆盖那一侧显示裸 model id,同一个仓库切换覆盖前后看起来像换了模型。
- 2026-08-16: 落地 issue #64 的前端那一半。新增凭据页 `src/credentials.tsx` 并挂进壳的导航(第四项「模型凭据」)。表单只有 provider 与 key 两个框,key 用 `type="password"`;保存失败(厂商验证不过)按错误样式呈现,不混进普通提示。解不开密文的那一行显示「未配置(密文解不开,重新粘一次 key)」,与从未配过的区别只在这句话上——对人要做的动作是同一个。
- 2026-08-16: 落地 issue #66。仓库详情的「跟随全局」改读 `GET /settings`(旧的 `GET /reviewers` 已删),拿到的是 ReviewerSpec 数组,页面自己拼成模型标识 `provider:model`,与覆盖那一侧同一种展示。覆盖编辑框的说明去掉 `apiKeyEnv` 与配置文件的说法。本票只改到展示正确,组合的选择器是 issue #68 / #69。
- 2026-08-16: 落地 issue #68。新增模型多选器 `src/components/model-picker.tsx` 与全局设置页 `src/settings.tsx`(挂进壳的导航,第五项「全局设置」),装 shadcn Command(带 `cmdk`)与 Popover。选择器按 provider 分组,每个选项显示显示名、模型标识、上下文窗口与每百万 token 单价;搜索词按空格分词,在标识、模型名与厂商名里匹配。选择器只认受控的 `value/onChange` 与目录数据,写请求归页面——仓库覆盖(issue #69)要复用同一个组件。Popover 的 ring 按 Card / Dialog 的既有决定换成边框、圆角压到 `--radius`。
- 2026-08-16: 落地 issue #69。仓库详情的模型覆盖从「粘 JSON 文本域 + 留空即清除」改成显式两态开关(`src/repos.tsx`):跟随全局与自定义各是一个按钮,「一个都没选」这种既不是跟随、也不是有效覆盖的状态在界面上不存在。切到自定义时以当前生效组合(跟随态即全局组合)为初值,人从一个已知跑得起来的组合上改;自定义态下选空则保存按钮禁用。切回跟随全局直接 `PUT {"reviewers": null}`,不再进编辑框走一遍保存。选择器复用 `components/model-picker.tsx` 的 `ModelPicker`,不复制一份。注册表单的模型组合文本域一并删掉——新仓库一律跟随全局,要自定义在详情里切。服务端一行没改:覆盖的解析与组合校验照旧,非法输入仍被拒。
- 2026-08-16: 落地 issue #70。注册模态从手输 owner / repo 两个框改成搜索式下拉(`src/repos.tsx`):输关键字打 `GET <前缀>/api/repos/search`(输入停 250ms 才发,每个按键都发会让后端替浏览器打满 Gitea),列表用已装的 Command 组件、`shouldFilter={false}`——结果已经是 Gitea 按关键字搜回来的,再筛一次只会把匹配项筛掉。已注册与无 admin 权限两类照样列出、置灰,行内直接写下一步做什么(文案由服务端给,与注册被拒时的说明是同一句)。搜不到给的是「bot 还不是它的协作者,先把 bot 加进那个仓库」而不是空列表;结果被截断时提示总数并让人继续输入。手输两个框完全删除,不留兜底:bot 看不见的仓库手输进去也过不了注册时的权限检查。注册请求的 body 一字未改,仍是 `{owner, repo}`。
- 2026-08-16: 落地 issue #71。壳的侧栏底部加「登出」(`src/main.tsx`):打 `DELETE /session` 再回登录页,端点回什么都走——会话已经不该用了,留在面板上只会在下一次请求撞 401。窄视口下侧栏是横排,按钮跟在导航尾端。
- 2026-08-16: 收口 issue #56 的评审复核(前端三条)。`settings.tsx` 的批次上限提交前校验正整数:字段是自由文本,`Number("abc")` 是 NaN,JSON 里序列化成 null,而服务端把 null 当「清除这一项」——此前人看到「已保存」,配置却被悄悄删掉并回落默认值;非法时不发请求,直接给「批次上限要填正整数,这次没保存」。`repos.tsx` 的注册模态在搜索词变化时清掉选中项:选中 `foo/bar` 后改词到无结果再回车,表单会把看不见的那个仓库提交注册。`components/model-picker.tsx` 补总量截断的提示:不搜索时每家列 4 个、累计到 120 就停,约 39 家里最后几家此前无声消失,现在按「还有 N 家没列出,继续输入以缩小范围」透出,与每家那句「这家还有 N 个」同一形态。`credentials.tsx` 跟随服务端的凭据放行改动:列表按 `verified` 标出「未验证」,保存认不出的厂商时当场说清「key 写错了要等下一次 Review Run 失败才知道」,页头说明写清哪四家会真发验证请求。
- 2026-08-17: 凭据页的 provider 从手输改成可搜索的单选下拉(`src/credentials.tsx`)。选项来自 `useModelCatalog()`(与模型选择器同一份查询),Popover + Command 复用已装的组件,`shouldFilter={false}`、按标识与厂商名两样过滤——39 家一次列全,不做截断。每一行标出这家的状态:已配的写「已配,选它是覆盖」,没配的按目录新给的 `verifiable` 分成「保存时验证」与「保存但不验证」。表单底下那句「同一个 provider 保存第二次是覆盖」换成针对所选那一家的具体提示(覆盖还是新增、保存时验不验证),页头因此不再点名 anthropic / openai / deepseek / openrouter 四家——名单由服务端给。保存与删除后连 `catalog` 一起失效,否则下拉里的「已配」是旧的。凭据页其余逻辑一字未动:只写不回显、验证失败不落库、列表的「未验证」标注照旧。
- 2026-08-17: 处置率页的日期窗从两个浏览器原生日期控件换成 shadcn Calendar(`src/stats.tsx`,装 `react-day-picker`)。两个框合成一个区间选择器:窗口本来就是一对起止,分成两个控件时「起点晚于终点」这种非法窗口按得出来,区间选择器里选不出来。触发器是一颗按钮,显示 `起 → 止`,展开是 Popover 里的双月日历。日期在状态里仍是 `YYYY-MM-DD` 两个字符串,请求参数仍逐字是 `<日>T00:00:00.000Z` 与 `<日>T23:59:59.999Z`;`Date` 与字符串互转走本地年月日字段(`dayString` / `dayDate`),不经 `toISOString()`——按 UTC 转会把东八区选的日子挪前一天,与分天按浏览器本地时区那条一致。行为一律不变:默认窗仍是最近 30 天、空窗仍给文案不给空表、矩阵算法与库体量卡片一行没动。代价是前端产物体积从 gzip 157.6 kB(JS 150.0 + CSS 7.6)涨到 181.4 kB(JS 172.9 + CSS 8.5),已知并接受。
- 2026-08-17: 评审记录上的部分失败可见了。`RunPill` 扩出「部分失败」一档(`src/runs.tsx`):全挂仍是实心 `--destructive` 的「失败」,一部分模型挂掉是同色浅底的「N/M 模型失败」,`title` 带全部失败原因。三态色不变,原有三分支(failed / total===0 / resolved-total)语义一字未改,新档插在 failed 之后。评审记录页的模型行按 `failure` 分两种写法:成功的照旧「模型 条数」,失败的整行走 `--destructive` 并写「失败」,卡片底下再逐个模型写一行失败原因——要不要重跑取决于这句话(区域封禁重跑也没用,超时重跑就好),藏进 tooltip 等于让人先猜。分隔符用 `·` 不用冒号:模型标识本身是 `provider:model`。`models` 为空时的文案从「没有 Finding」改成「没有模型记录」——这一档现在是「一个模型记录都没有」,不是「跑了但没报」。两个调用点都在真实浏览器里过了:评审记录页三张卡片(部分失败 / 全部失败 / 零 Finding 成功)与仓库详情页的评审记录区块三行 pill 分别是「1/2 模型失败」「失败」「无可处置项」。
- 2026-08-17: 全面板换视觉世界。上一轮青色密控制台被否。方向是品类标准件,手艺对标 GitHub / Linear / Vercel:近黑主色、白底、冷灰外壳,圆角 6px。登录后落到评审记录。评审记录改成检查列表(状态字形 + 全部/失败/待处置/已处置过滤片 + 细线表),过滤只作用于已加载的行。
- 2026-08-18: 手动验证的场所改到部署实例(根 `AGENTS.md` 的全局规范)。本机 dev 双进程没有真 Gitea、没有已注册的仓库、没有模型凭据,仓库页与评审记录页在那里基本是空的,拿它当验收手段等于验了个空壳;dev 双进程今后只用于写样式时的即时反馈。
- 2026-08-18: 落地 spec [模型进组合的三条入口](https://github.com/kassol/MultiReviewer/issues/84) 的前端(issue #87 / #88 / #89 / #90 / #94 同一批落地)。**模型组合的编辑是一块两栏面板** `src/components/model-composer.tsx`(形态取自原型变体 C,issue #83),模型进组合的三条入口收在同一屏上:左栏是厂商列(内置那三十九家与自定义 provider 同列同渲染、各显示模型数与「未配凭据」,列底部「+ 加一家 provider」开对话框走 `POST /custom-providers`,名字 / base URL / 接口协议 / 第一个 model id / key 五项一次收齐),右栏是选中那家的内容(头一行给这家的凭据状态、端点与自定义那几家的删除入口,中间是模型列表,底部固定一行手填 model id 走 `POST /model-rows`),已选的 chips 单独一张卡放在两栏之上、标出「自定义」与「手填」两种来源。设置页上那个单一 Popover 选择器与承载它的 `components/model-picker.tsx` 就此没有;手填模型行与自定义 provider 也没有独立卡片,它们各自长在面板里那条入口该在的位置。**手填框旁边没有 provider 下拉**,这是选变体 C 的全部理由:provider 不是一个要填对的字段,是当前所处的位置。**明确接受的代价是跨厂商搜索没了**,右栏的搜索框只筛当前这一家。组件接口只有 `{value, onChange}`,三份查询与三处写请求归它自己,模型组合怎么存归调用页。右栏一次最多渲染 120 行并在截断时提示(判据沿用换掉那个选择器全部加起来的上限,1225 个模型全渲染会让每次输入都卡住);手填提交后顺手把搜索词设成刚填的 model id——openrouter 一家五百多个模型,新行会落在上限之外、提交完看不见。删掉自定义那一家时它的模型标识从本地组合里一并摘掉(判据见模块规范)。接口协议做成两态开关而不是下拉:取值只有 `openai-completions` 与 `openai-responses` 两个,下拉多一次点击换不来任何信息;权威判据在服务端(`CUSTOM_PROVIDER_APIS`),前端这份取值集只是省得人去查那两个字符串怎么拼。名字输入框 `maxLength={64}`,与服务端的 `/^[a-z0-9-]{1,64}$/` 是同一个数(POST 校验与 DELETE 路由也是它)。**校验一律不在前端复制一份**:名字的字符集、撞名与缺项都由服务端回话,前端只把五个框都填了当作可提交。面板不套在设置页那张 `<form>` 里:它自己带着手填模型行那张表单,嵌套既非法,也会让填一个 model id 顺手把整页保存掉。

  **单价留空的模型在面板上标出来**(issue #89):`CatalogModel` 多读一位 `costUnset`(服务端给),模型行右侧那串「上下文 · 单价」在这一位为真时把单价换成一句 `text-warning` 的「单价没填,费用记成零」,已选的 chips 带同一句,措辞是 `model-catalog.ts` 里的一个常量、两处不各写一遍。判据不在前端:`cost` 是 Pi 给的结果,拿 `cost.input === 0` 自己推会把内置表里一百多个真免费的模型一起标上。chips 手上只有模型标识,那一位得回目录里查,因此按目录扫出一张标识集合并随目录记忆化,不为每个 chip 重扫。手填框底下也写明这一档:那里填不了单价,填进来的行一律走默认值 0。

  **撞名停用的自定义 provider 在面板上说得清**(issue #94):`CatalogProvider` 多读一位 `conflict`(服务端给,与 `configured` / `verifiable` / `custom` 并列),判据是 `custom && conflict`——这一档目录里那条记录是**内置那一家**(撞名的不落进派生的模型配置,不然 Pi 会拿自定义那个端点覆盖它),所以 `name` 与 `models` 都是内置的,而 `custom` 仍为真是因为库里那条登记还在、面板要删得掉它。左栏那一行标一句红字「名字冲突,已停用」(220px 宽,两条出路塞不下),点进去右栏头一行下面一条红色横幅写全:撞的是内置的哪一家、这家的模型现在一个都选不了、两条出路(改名重建 / 删掉这一家)、以及已经在组合里的那些下一次审查会各留一条写明名字冲突的失败记录。删除入口本来就在右栏头一行,两条出路因此在同一屏上都够得着。这一档下模型按钮禁用、手填框仍只看 `configured`,判据见模块规范。
- 2026-08-18: 落地 issue #91。仓库详情页的模型覆盖换用同一块两栏面板(`src/repos.tsx`):`ReviewersModal` 换成 `ReviewersEditor`,里面挂的就是全局设置页那个 `ModelComposer`,两处从此没有第二份实现。**编辑态从对话框改成详情列里的一段**,判据两条:面板固定 460px 高,而 `ui/dialog.tsx` 的对话框只给宽度档位(`sm:max-w-sm` 与「加一家 provider」那张的 `sm:max-w-md`)、没有最大高度与滚动,矮屏上底部的手填框与保存按钮会落到视口外面点不到;面板里「+ 加一家 provider」本身就是一个对话框,套进覆盖对话框就是对话框叠对话框。放宽对话框等于为这一处新造一个宽度档位,而详情列本来就有 900px 可用,编辑态里把那一格并成单栏就够了。**面板外面不套 `<form>`**:原来整个编辑框包在 `<form onSubmit>` 里,直接塞面板会造成 form 嵌套,而且在右栏填一个 model id 会顺手提交覆盖(#90 交接点的那条真缺陷);编辑态里除了保存与取消再没有别的字段,所以整张表单去掉,保存改成按钮的 `onClick`。两态开关的语义一字未改:切自定义以当前生效组合为初值(跟随态即全局组合),切跟随全局仍是一个动作直接 `PUT {"reviewers": null}`,自定义态下选空时保存仍禁用并写清「点取消再点跟随全局」这条出路。覆盖的读写端点入参一字未改,仍是 `PUT /repos/<id>/reviewers` 加模型组合数组。`ModelPicker` 至此零调用方,组件删掉;`components/model-picker.tsx` 剩下的目录查询、目录类型与模型标识那两个函数改名成 `src/model-catalog.ts`(不再是 picker,也不再带 JSX,与 `api.ts` 同级),四个 import 跟着改。在仓库页加自定义 provider、手填模型行与全局设置页同一套端点、同一批查询失效(`catalog` / `model-rows` / `custom-providers` / `credentials`),因为它们本来就都在面板里。后端一行没改,`test/panel-*.test.ts` 一个字没动。视觉与交互确认走部署实例。
