# web/AGENTS.md

## 职责

管理面板的前端:TanStack Router + Query 的纯前端 SPA,与 JSON API 同进程部署。样式走 Tailwind v4,组件走 shadcn(Radix 底座)。Vite 构建,产物(`dist/`)不进版本库,在 Docker 多阶段构建里生成,由服务经 `/assets` 与 `<前缀>/*` 提供。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `index.html` — Vite 入口。生产由服务注入前缀全局变量后返回;dev 由 `vite.config.ts` 的内联插件注入同名变量。
- `vite.config.ts` — 前缀与后端端口从仓库根的同一份 `.env` 读(`loadEnv`);dev proxy 把 `<前缀>/api` 转本机后端;注入插件 `apply: "serve"`,只在 dev 生效。
- `src/injected.ts` — 读注入全局变量的唯一代码路径,缺失当场报错并在页面写明原因。
- `src/api.ts` — 面板 API 的唯一入口,基址从注入的前缀来。
- `src/main.tsx` — 路由与壳:`/login` 一屏登录,`shell` 下挂五页(`/repos` / `/runs` / `/stats` / `/credentials` / `/settings`),`/` 与登录成功落到 `/runs`。Router `basepath` 取注入前缀。壳只管导航:左侧栏走 `--chrome`,当前项是白底细线盒子并带 `aria-current="page"`。窄视口下侧栏改成顶部横排、可横向滚动。
- `src/login.tsx` — 登录页,单 token 输入框(有可见 `<Label>`,不靠 placeholder 当标签),整屏居中的一张卡片加产品标记。
- `src/components/page-header.tsx` — 五页共用的页头。左边是页名与一句说明(压在 68ch 内),右边 `actions` 放这一页当下需要的那一个东西(注册按钮 / 时间窗 / 总处置率)。粘在滚动容器顶上。
- `src/components/mark.tsx` — 产品标记(三条错位短线),与 `index.html` 里内联成 data URI 的 favicon 是同一份图形。用 `currentColor` 上色。
- `src/components/ui/skeleton.tsx` — 读取中的占位块。带 `data-slot="skeleton"`,`styles.css` 的降低动效偏好那一段据此关掉呼吸动画。
- `src/repos.tsx` — 仓库页,左列表右详情。模型组合是「跟随全局 / 自定义」两态开关(issue #69):点「跟随全局」直接清覆盖,一个动作;点「自定义」开编辑框,选择器是全局设置页那一个 `ModelPicker`,初值取当前生效的组合。注册 / 改组合 / 移除确认三处都是 shadcn Dialog——焦点锁、Esc、`role="dialog"` 由组件给,不自己写。**不用 `window.confirm`**:原生对话框阻塞渲染线程,浏览器自动化与 dogfooding 都会被卡死。核对差异卡片的「轮转推平」调轮转端点。key 面板显示「代次」而非建立时间——代次是 ADR 0007 之后 key 真正有信息量的属性。
- `src/credentials.tsx` — 凭据页(issue #64)。每个 provider 一把 key,粘进来即验证并保存;provider 从模型目录的可搜索下拉里选,不手输,每一行标出这家配过没有、保存时验不验证(`verifiable` 由 `/catalog` 给);列表只显示 provider、是否已配、更新时间与尾 4 位,明文从不回到前端。主密钥没设时端点回 503,整页切成一张「差什么」的卡片而不是报错——那一档服务照常起,只有这一页做不了事。

- `src/settings.tsx` — 全局设置页(issue #68)。全局模型组合与批次上限,读写 `<前缀>/api/settings`。表单以读回来的设置为初值,所以数据到了才挂载(`key` 取设置本身)。
- `src/components/model-picker.tsx` — 模型多选器。目录来自 `<前缀>/api/catalog`(`useModelCatalog()` 一并导出,仓库覆盖那一票复用同一份查询),选项键就是模型标识 `provider:model`——「同一次审查里标识不得重复」因此由组件天然满足,同 id 跨 provider 的两项是两个选项。接口是受控的 `{providers, value, onChange, disabled?}`,自己不发写请求。**列表永远按搜索词裁剪**:目录有 1153 个模型,全渲染会让每次输入都卡住,所以 cmdk 的自带过滤关掉(`shouldFilter={false}`),不搜时每家只列 4 个并标出还有多少,搜索时每家最多 12 个、全部加起来最多 120 个。没配凭据的 provider 照常显示,只是 `disabled`,那一行给去凭据页的链接。
- `src/components/ui/` — shadcn 生成的组件(Dialog / Button / Input / Label / Table / Badge / Card / Command / Popover / Calendar),vendored 源码,改它就是改本项目的组件。Calendar 的底座是 `react-day-picker`;它的 `DayButton` 原样把 `locale` 透传下去,在 `exactOptionalPropertyTypes` 下过不了类型检查,改成 undefined 时不传这个属性。已按视觉定稿把 Card 与 Dialog 的 ring 换成边框、圆角压到 `--radius`。**不引 shadcn Sidebar**:那套带折叠、移动端抽屉、cookie 记忆,这个面板一样用不上,侧栏与分栏用 utility 手写,进度条也是两个 div。
- `src/lib/utils.ts` — shadcn 的 `cn()`,clsx 加 tailwind-merge。
- `src/styles.css` — 设计令牌与浏览器原生面的接管,没有组件类。令牌是品类标准件(近黑主色、白底、冷灰外壳),手艺对标 GitHub / Linear / Vercel。三层底色(`--chrome` 外壳 / `--background` 内容 / `--card` 卡片)、六档字号阶梯(xs 11 / sm 13 / base 14 / lg 16 / xl 19 / 3xl 28,body 就是 sm),以及选区、光标、滚动条与表格数字的默认样式。

## 模块规范

- 前端只读注入的 `window.__MULTIREVIEWER__`,不设 `import.meta.env` 回落——分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」不该存在。注入形状必须与服务端(`src/webhook/server.ts` 的 `servePage`)逐字一致。
- Vite 保持默认绝对 base(`/`):静态资源不进前缀,构建产物与前缀无关。**注入插件永远不参与 build**——前缀烤进产物即事故。
- 构建产物是纯静态文件:服务端的运行时第三方依赖仍只有 Pi,react 全家只活在构建阶段。
- 未认证的判据是 `GET <前缀>/api/session` 非 204,壳的 `beforeLoad` 统一送去 `/login`,页面组件不各自判。
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
