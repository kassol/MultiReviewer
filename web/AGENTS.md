# web/AGENTS.md

## 职责

管理面板的前端:TanStack Router + Query 的纯前端 SPA,与 JSON API 同进程部署。Radix Themes 是通用视觉系统,Radix Primitives 补行为,Radix Icons 统一业务图标,Tailwind v4 只处理复杂布局；cmdk 与 react-day-picker 保留搜索组合框和日期范围的专用行为。Vite 构建,产物(`dist/`)不进版本库,在 Docker 多阶段构建里生成,由服务经 `/assets` 与 `<前缀>/*` 提供。领域术语以根目录 `CONTEXT.md` 为准。

## 目录结构

- `index.html` — Vite 入口。生产由服务注入前缀全局变量后返回;dev 由 `vite.config.ts` 的内联插件注入同名变量。
- `vite.config.ts` — 前缀与后端端口从仓库根的同一份 `.env` 读(`loadEnv`);dev proxy 把 `<前缀>/api` 转本机后端;注入插件 `apply: "serve"`,只在 dev 生效。
- `src/injected.ts` — 读注入全局变量的唯一代码路径,缺失当场报错并在页面写明原因。
- `src/api.ts` — 面板 API 的唯一入口,基址从注入的前缀来。`apiUrl(path)` 给出同一份绝对路径,供 `EventSource` 这类只收 URL、进不了 `api()` 封装的调用点用——「API 装在哪个前缀下」仍然只写一次。
- `src/model-services.ts` — `GET /model-services` 的共享查询与前端契约。模型服务页、全局模型组合和仓库覆盖只消费这一份按权限裁剪的投影;候选按完整 `provider:model` 标识合并来源并携带服务端可用性结论。模型发现事实逐字段带 `service-interface`、`pi-catalog` 或 `service-target` 来源；实际运行字段还可能来自 `runtime-baseline` 或为 `unknown`。模型页以实际运行规格为主并将字段来源去重成一条说明，发现值有差异时才展开显示。服务详情另读服务级运行能力与组合引用位置,前端不从目录状态重复推断。
- `src/main.tsx` — 路由与壳:`/login` 同一屏按 session 探测结果在登录与 bootstrap 注册间切换;`/password` 是必须改密页;`shell` 下挂七页(`/` 总览 / `/runs` / `/repos` / `/stats` / `/credentials` / `/settings` / `/access`),外加不进导航的阶段详情 `/stages/$stageId`(issue #175:它是从评审记录点进去的一个阶段,不是一张并列的页;路径参数就是 `GET /stages` 行上的阶段标识,里面的斜杠由 TanStack Router 自己编码成一段;顶栏面包屑在这个地址上显示「评审记录」,与页顶那个唯一的返回一致,issue #189)。默认进入总览;无 `review:read` 时按导航顺序进入下一个可见页,一个权限都没有时留在 `/` 上显示零权限说明。`/credentials` 是模型服务总入口;`/credentials/:provider`、`/credentials/:provider/maintenance`、`/credentials/:provider/models` 分别是服务概览、维护与模型的稳定地址。配置流以 `/credentials/add` 为父地址:内置 provider 用 `builtin/:provider/discover|verify`,自定义创建用 `custom/discover|verify`,自定义修改用 `custom/:provider/discover|verify`;自定义子路由同时要求模型写与凭据写。页面组件使用 `React.lazy + Suspense` 按路由分块，模型服务的七个路由入口共用同一个 `credentials.tsx` 动态模块。Router `basepath` 取注入前缀。壳按 `GET /session` 回来的有效权限先过滤导航再渲染:系统管理员全开且独有访问控制页,普通用户只看得到有读权限的页;页面按写权限决定是否渲染保存、刷新、凭据、删除与重跑控件;零权限时导航全藏,内容区使用 `EmptyState` 说明并列系统管理员。所有业务页在实例启用前显示同一首次配置检查单;任一成功写请求会立即让状态查询失效并刷新。壳是双层毛玻璃顶栏:上层品牌、面包屑、⌘K 搜索入口与头像菜单,下层 underline 导航(激活项字重 650 + 3px 蓝色圆头指示条,指示条左右各内缩 12px)。导航项右侧的计数与告警点只读已有查询:仓库数取 `/repos` 数组长度,模型服务的琥珀点取 `/setup-status` 的 `hasRunnableModelService`;评审记录没有总数端点(`/stages` 按 `offset` 翻页,不给总数),因此不显示计数,不拿第一页条数冒充总数。窄视口收起导航层,改成底部毛玻璃 Tab 栏——设计稿画的是固定五项,实现取前四个有权限的页面加一个「我的」,因为导航项随权限增减,固定五项会让低权限用户看到空位、高权限用户丢掉入口。
- `src/session.ts` — 当前身份与权限的唯一查询,缓存 `GET <前缀>/api/session`,并从中取 Forge 的 web 基址(`giteaUrl`)。`pullRequestUrl()` 是拼 pull request 地址的唯一出口:处置只发生在 Forge 上,面板里每一处「还有多少条没处置」都要能凭它点过去,拿不到基址时调用方不渲染链接。未认证的 401 再由壳送去 `/login`,必须改密时统一送 `/password`,页面组件不各自探测。
- `src/setup-checklist.tsx` — 首次配置状态与检查单的唯一实现。它读取认证的 `GET /setup-status`,始终显示三步完成状态,只把当前未完成步骤做成入口;入口再按当前会话的有效写权限裁剪。实例启用后整块隐藏。
- `src/login.tsx` — 登录与首次注册共用的一屏。普通档是用户名加密码;零用户档多 bootstrap 口令与确认密码,注册成功后回账号登录。所有字段使用 Themes `Text as="label"` 的可见标签,不靠 placeholder 当标签。
- `src/password.tsx` — 用户自改密码页,走 `PUT /session/password`;必须改密的人完成后回到自己有权访问的第一页。改密保留当前会话、作废其余会话。
- `src/access-control.tsx` — 系统管理员独有的 `/access` 页,上半用户表、下半转置权限矩阵(行是权限、列是角色)。两张表直接使用 Themes Table,横向滚动限制在各自容器内,首列保持粘性；角色多时权限矩阵继续横向滚。用户与角色读写走 `GET/POST /users`、`PUT/DELETE /users/:username`、`POST /users/:username/reset-password` 与 `GET/POST /roles`、`PUT/DELETE /roles/:id`;改角色是行内下拉,新建用户与角色使用 Themes Dialog,重置密码、删除用户与删除角色使用 Themes AlertDialog。三类 write 生效时对应 read 显示为已包含且不可单独移除,`review:rerun` 仍是独立权限。系统管理员不进矩阵;角色创建时不包含任何权限,未分配角色的用户就是零权限。
- `src/overview.tsx` — `/` 总览页。KPI 卡加最近运行与模型健康,数据全部复用各业务页已有的 queryKey,不新增后端端点;拿不到历史值的同比信息直接不渲染,不造假数。
- `src/components/command-palette.tsx` — 全局 ⌘K / Ctrl+K 命令面板。快捷键监听挂在 window 上,任意页面任意焦点都能唤起;当前只收导航跳转,触发评审、注册仓库这类要先选对象的动作不进来,进来也只是又一次跳转。内部复用 `ui/command`,选中项按设计稿改成蓝色实底反白。
- `src/components/page-header.tsx` — 业务页页头。标题走 Display 字体栈 25px/700,随内容滚动、不粘顶:顶栏已经常驻显示当前页名,再粘一条页头就是两层重复页名压掉垂直空间。
- `src/components/mark.tsx` — 产品标记(三条错位短线),与 `index.html` 里内联成 data URI 的 favicon 是同一份图形。用 `currentColor` 上色。
- `src/components/panel-theme.tsx` — Radix Theme 根配置的唯一实现。固定亮色、blue accent、solid panel、medium radius 与 100% scaling。四个取值都不开放给调用方:accent 走 blue 那一族变量再由 `styles.css` 覆写成 `#0071e3`;radius 取 medium 只为拿到圆形滑块,六档圆角终值同样在 `styles.css` 里直接覆写;scaling 固定 100% 避免字号被二次缩放。
- `src/components/help-tooltip.tsx` — 统一的帮助提示入口。基于 Radix Themes Tooltip、IconButton 与 Radix Icons,图标按钮可键盘访问,窄屏保留触控尺寸。
- `src/components/status-badge.tsx` — 跨页面运行状态的唯一视觉出口。领域组件只传 `neutral` / `success` / `warning` / `error` 与文字；组件统一 Radix Themes Badge 的色系、variant 和状态图标,圆角固定 full。选中行是浅色 tint 底,徽章保持 soft,不再需要 solid 变体来压深色底。来源、身份和类别直接使用 Themes Badge。
- `src/components/master-list-item.tsx` — 主从列表当前项的唯一交互表面。模型服务、仓库与 `ModelComposer` 共用同一套选中态:蓝色 tint 底 + 3px 蓝色左条 + 字重提到 650,文字不反白。左条走 `before` 伪元素而不是 `border-left`,不进盒模型,选中行与未选中行的内容仍然左对齐,调用方不必逐处补 3px padding。选中优先于 hover,选中项悬停不换色。路由项用 `asChild` 组合 Link 并输出 `aria-current="true"`,页内项输出 button 与 `aria-pressed`。模型行和 Checkbox 多选不使用这套选中状态。
- `src/components/commit-chip.tsx` — commit hash 的统一表面:等宽加蓝 tint 的短 SHA。评审记录、阶段详情与总览共用这一份,不各写一遍同样的 chip 类。
- `src/components/date-range-picker.tsx` — 日期范围的唯一产品入口。内部组合 Themes Popover 与 `ui/calendar`,负责本地日期转换、双月范围和窄屏边界；页面只读写 `{from,to}`。
- `src/components/editable-model-combobox.tsx` — 可搜索且可手填 model id 的唯一产品入口。内部组合 Themes TextField/Popover 与 `ui/command`,自动发现候选可选，目录外裸 model id 始终可输入。
- `src/components/empty-state.tsx` — 资源为空、筛选无结果和零权限状态的统一实现。保留原有 `h1` / `h2` / `h3` / 正文层级，不使用装饰性大图标。
- `src/components/use-dialog-return-focus.ts` — 受控 Dialog / AlertDialog 的焦点返回工具。触发事件发生时记录真实元素，关闭时恢复；触发元素卸载后使用调用方提供的稳定入口，不在弹窗打开后的 effect 中推断焦点来源。
- `src/components/theme-button.ts` — Radix Themes `Button` 的集中类型适配出口。`@radix-ui/themes` 3.3.0 在 `exactOptionalPropertyTypes` 下把 `highContrast` 推成 `never`;这里仅把它修正为可选 boolean,导出的仍是原始 Button,不增加组件、行为或 DOM。业务 Button 从此处导入,IconButton 继续直接使用 Themes。主要动作固定为 accent 的 `solid`,**不开 `highContrast`**——三族语义色与 accent 的目标值都落在各自的 11 档上,highContrast 会把颜色推到 12 档,那是 Radix 的默认深色,主按钮会从蓝变回近黑。次要动作使用 `soft` / `outline` / `ghost` 配 `color="gray"`,灰色按钮**保留** `highContrast`(文字才是 `#1d1d1f` 而不是 `#6e6e73`);删除和丢弃使用 `red`;纯图标动作使用 `IconButton` 并提供 `aria-label`。
- `src/components/page-body.tsx` — 业务页正文容器。`wide` 与 `form` 两档统一最大宽度、窄屏内边距和页尾留白;主从页只在详情栏复用,不改变分栏结构。
- `src/repos.tsx` — 仓库页,左列表右详情。`lg=1024px` 起双栏，列表和详情各自局部滚动；更窄时只显示一层，进入详情后提供返回仓库列表入口。模型覆盖是「跟随全局 / 自定义」两态:点「跟随全局」直接清覆盖;点「自定义」在详情内挂与审查策略共用的 `ModelComposer`,以当前生效组合为初值。不可用的既有选择可移除但不得随覆盖再次保存;服务端仍作最终校验。编辑态并成单栏容纳 460px 高的两栏选择器,不套对话框或外层表单。审查配置就绪前注册按钮禁用并指向审查策略,状态失效时已开的注册框随即卸载。注册使用 Themes Dialog,移除确认使用 Themes AlertDialog,不用阻塞渲染线程的 `window.confirm`。详情头部除 Hook 核对徽章外还有**工作副本徽章**(issue #184):准备中 / 就绪 / 准备失败 / 未准备四档,取 `RepoRow.worktree.state`。后两档下面跟一段说明——失败给服务端记下的原因与时刻,未准备(升级前注册的仓库)说清备好之后能省掉什么;两档都带「准备工作副本」按钮(`canWrite`,打 `POST /repos/{id}/worktree`)。列表查询在有仓库处于准备中时每 5 秒续查,全部有结果即停。详情里的「评审记录」区块**不再自己列审查阶段**(issue #189):列表只有一份,仓库是它的过滤条件,这里只剩一个指向 `/runs?owner=&repo=` 的链接;卡头的「发起范围审查」(`canCreate`,issue #177,仓库预填)与「输 PR 号重跑」原样留着,`repo-stages` 那份查询与它的失效调用一起清掉。
- `src/runs.tsx` — 评审记录页:阶段列表与状态、来源两个筛选。页头除总处置率外挂「发起范围审查」入口(`canCreate`,即 `review:create`,issue #177),表单是共用的 `range-review-launch.tsx`,全局入口不预填仓库,发起结果落在页头下面那一条提示里。**列表的每一行是一个审查阶段**(issue #174,读 `GET /stages`):`owner/repo` 加名字(导出的 `stageLabel`:有标题显示标题,没有的显示 `#编号`——pull request 用它的 PR 号,范围审查用它自己的标识,容器 PR 的序号不露面)、来源标记(导出的 `StageSourceBadge`)、最新一轮的时间、阶段汇总三个数(`StageCounts`:待处置 / 已处置 / 已修复)与状态徽章(`StageStatusBadge`:进行中 / 已结束)。**筛选与分页都在服务端**:状态与来源两个 `SegmentedControl` 各自写进地址(`?status=` / `?source=`,默认都是全部,切换用 `replace`,否则点几下分段控件就把历史塞满),仓库那一档是地址上的一对 `?owner=&repo=`(issue #189,两个都在才算数——只给半个键服务端 400),它没有分段控件可摆,只显示当前这一个并给「清除」;翻页按响应里的 `nextOffset` 递进 `?offset=`,仍由 IntersectionObserver 滚到底自动取下一页。三个过滤在点开一行时一起带进阶段页的地址,阶段页那个唯一的返回据此回到同一片列表。列表里只要还有没跑完的最新一轮(`latestRunFinishedAt` 为 null)就每 10 秒续查,跑完即停。**点开一行是跳到那个阶段自己的地址**(issue #175):行是 `MasterListItem asChild` 套一个指向 `/stages/$stageId` 的 `Link`,这一页因此不再有详情抽屉、`?run=` 与 `?file=`,轮次详情整块搬到 `stage-detail.tsx`。`RunItem` / `RunFinding` / `StageItem` / `UsageSummary` 四个契约类型与 `runStatus`、`disposedCount`、`rerunRequest` 从这里导出(`stagesPath` 只有本页在用,不导出),时间格式化走 `lib/time.ts`。
- `src/stage-detail.tsx` — 审查阶段的详情页(issue #175,`/stages/$stageId`),两种来源共用这一页。读 `GET /stages/{stageId}` 拿阶段那一行(名字、来源、状态、三个数)与按代码推进分组的时间线;地址里的阶段标识原样发给接口,只做一次 `encodeURIComponent`。**只有一种视图**(issue #189):正文整块交给 `stage-summary.tsx`,顶上三个数与两个筛选都在,时间线用它的 `timeline` 渲染入口换成分组版——pull request 阶段一组是一个 head commit,范围审查一组是一个比较项(组上多一行推的人与时刻),组与组内都是新的在前;还没跑过的比较项照样占一行,写明它还没跑。**下钻只有侧滑**,在同一路由上由查询参数驱动:`?finding=` 是那条 Finding 所在文件的 diff(`FindingDrawer` 复用 `run-diff.tsx` 的 `FilePatch`,取的是**这个阶段最新一轮**的 patch——`GET /stages/{stageId}` 行上的 `latestRunId`,不是这条 Finding 最近一次被报出的那一轮:侧滑回答的是「现在的代码里这处是什么样」),`?trace=` 是那一轮的审查轨迹(`RoundDrawer` 先读 `GET /runs/{id}` 再挂 `run-trace.tsx`,头部是结论徽章、commit、触发来源、开跑时刻与耗时,头部之下是失败模型的原因逐条摊开与这一轮的 token 用量一行,末尾留「去 pull request 看原版」)。两者互斥、都写在地址上,开与关都走 `replace`——它是这一页里的一次下钻,不该往浏览器历史里塞一条。侧滑容器 `StageDrawer` 用 `radix-ui` 的 `Dialog` 原语自绘:Themes 的 Dialog 是居中模态,改成侧边抽屉得深度覆写它的内部 DOM。关闭后的焦点由 `useDialogReturnFocus` 的 `captureBubblingLink` 还给点开它的那一行。**页顶只有一个返回**,指向 `/runs` 并带上地址里原样存着的 `owner` / `repo` / `status` / `source`——阶段页自己不读这四格,只负责把来时那份列表的过滤交还回去,没有时就是无过滤的列表。旧地址上的 `?run=` 与 `?round=` 都没有读者,带着它们进来就是一张普通的阶段页。**这个阶段的动作都在页头**(issue #176):重跑两种来源都有(`review:rerun`),pull request 阶段在最新 head 上再跑一轮、范围审查阶段在当前比较项上再跑一轮,走的是同一个 `POST /rerun`(`runs.tsx` 导出的 `rerunRequest` 与 `rerunRangeReviewRequest`);范围审查阶段另有推进比较项(`review:create`)与审查完成(`finding:dispose`),组件是 `range-review-actions.tsx`。记录来自 `GET /stages/{stageId}` 多带的 `rangeReview` 那一格,状态不是进行中时三个动作全部禁用——服务端也一律拒绝。触发结果与失败原因落在页头下面那一条提示里。
- `src/run-diff.tsx` — 一条 Finding 那个文件的 diff 与 Finding 卡片两件,Finding 侧滑与阶段页的列表共用(issue #189)。`FilePatch` 只读 `GET /runs/{id}/diff?file=` 那一个文件的 unified diff:侧滑回答的是「这条 Finding 指的是哪几行代码」,整轮几百个文件的列表在这里没有用处(`GET /runs/{id}/diff` 的文件列表因此前端不再调用,端点本身没动)。unified diff 自己解析(`parseUnifiedDiff`),不引第三方:要的只是「每一行属于哪一侧、行号是多少」,而 Finding 锚定只用新侧行号。同文件的 Finding 各挂在自己锚定的那一行下面,`focusFindingId` 那一条滚到视野正中并加浅蓝底。**锚不上的写明原因**:patch 是空的就是这个文件不在这一轮的改动里,有 patch 而行号不在其中就是落在 diff 之外,只在 review 正文里的那些由卡片自己说明;历史轮次的工作副本被清掉时服务端回 409,那句话与卡片一起摊在这里。Finding 卡片:正文、严重度、类别、**全部归属模型**(一条 Finding 由几个 Reviewer 报出就列几个,ADR 0015)与跳到 Forge 看原评论的链接,有 `finding:dispose` 时行内 resolve / unresolve 并可填处置备注,处置成功让 `stages` 列表、`stage-detail`、`run` 那一轮与 `stage-summary` 一起失效——阶段页头部的三个数、列表行上的三个数与阶段汇总读的是同一批 finding 行,只改本地状态几个数字会对不上。承载这张卡片的 `FindingRow` 导出给阶段汇总复用:同一条 Finding 在两处显示成同一个样子,处置也是同一个动作。已处置的正文划线加绿勾,未处置的带优先级徽章;「已修复」自动处置(`disposition` 为 `fixed`)同样按已处置呈现,署名那一行写「已修复 · 自动处置」而不是人名——它的 `disposedBy` 为空。撤回入口照给:人撤回之后这一条就是人工处置,自动规则不再碰它。「已延续」(`disposition` 为 `continued`,CONTEXT.md)是第三种样子:正文只压暗不划线,多一行说明这处代码已改写、同一条由后面的轮次在新位置接着跟,行内不给处置动作——要处置的是新位置那一条;它既不是处置也不是待处置,处置状态那个筛选两档都不收它,只在「全部」下作为历史出现。承接来的那一行反过来显示一枚「延续自上一处评论」的链接(`continuedFrom`,指向旧评论在 Forge 上的地址)。把锚不上的卡片藏起来等于把一条真实的 Finding 从面板上抹掉,所以它们照样列出、只多一句原因。
- `src/run-trace.tsx` — Review Run 的审查轨迹视图(CONTEXT.md 审查轨迹,issue #171),阶段页的轮次侧滑用这一份。历史由 `GET /runs/{id}/trace` 一次取全并按 `seq` 升序,进行中的那一轮再用浏览器原生 `EventSource` 订阅 `GET /runs/{id}/trace/stream`,增量经 `queryClient.setQueryData` 追加进同一份查询缓存——两条来源写同一个数组,页面因此不必区分「这条是取回来的还是推过来的」。**首次订阅用 `?after=<最后的 seq>`**:原生 `EventSource` 不能给首个请求设 `Last-Event-ID`,查询参数表达同一个语义(后端两种都接受),之后浏览器自动重连时自己带 `Last-Event-ID`,断线那几秒的事件不丢。收到 `event: end` 即关闭连接并让 `stages` / `stage-detail` / `run` 三份投影各刷新一次(面板头部跟着从「运行中」变过来,不必等下一次 10 秒轮询);组件卸载一律 `source.close()`。连接状态四档:建连时是「正在连接实时轨迹…」,`open` 事件到了才是「实时接收中」——握手成功与否只有 `open` 说了算,建连瞬间就标「接收中」会在服务端没把头发出来时说谎;`onerror` 时按 `readyState` 分「正在重连」与「未连接」。历史那份查询 `staleTime` 设为无穷:事件只增不改,不设的话窗口重新聚焦会用一份旧快照把推过来的增量整片盖掉;同一个 `seq` 只留一条,重连回放重叠的那几条不会显示两遍。布局按 issue #171 的第 12 条:**轮次级里程碑单独一段列在最上面**(工作副本就绪、第 N/M 批起止与文件、Finding 合并、评论已发、本轮结束),**每个 Reviewer 一个可展开块**,块内按 `seq` 列它的 `assistant_message`(全文,不截断)、`tool_call`(工具名 + 一行参数摘要,点摘要展开完整参数;只显示返回长度,正文不入轨迹)、`reviewer_failed`(红色 Callout)与 `reviewer_finished`(条数、被拒次数、用量)。Reviewer 块默认折叠,失败的那个与整轮只有一个 Reviewer 时默认展开——一轮几个模型各刷几十条事件,全摊开等于让人先滚过别人的过程。`finding_merged` 列出成员(Reviewer、行号、标题)与判据(同一行,或相距几行 + 相似度百分比,ADR 0015);没有合并的 Finding 不产生这条事件,轨迹里也就没有它。**payload 的每个字段读之前先验形状,认不出的 `kind` 按原样摊出 JSON**:后端加一种事件不该让面板白屏,也不该把一条真实事件藏起来。已结束的轮次只取 `/trace`,不开 SSE;历史轮次返回空列表时给一句空状态说明。
- `src/stage-summary.tsx` — 阶段汇总的唯一实现(CONTEXT.md 审查阶段,issue #168)。读 `GET /stage-summary`,范围审查按 id、PR 按 owner/repo/序号,两条链路显示成同一个样子。顶部三个计数(待处置 / 人工已处置 / 已修复)同时是筛选按钮,另有处置状态与文件两个 `Select`;每条 Finding 的卡片直接复用 `run-diff.tsx` 的 `FindingRow`(行内处置走既有接口),卡头写文件与行、第几轮首次报出与最近一次,整块卡头就是打开 Finding 侧滑的那个链接(`?finding=<id>`,`replace`,issue #189;阶段标识由导出的 `stageIdOf` 从 scope 拼出,与 `GET /stages` 行上的那个同一格式)。查询键首段固定 `stage-summary`,处置成功后整片失效;导出的 `useStageSummary` 让阶段页正文与 Finding 侧滑读同一份缓存——侧滑要的「这条 Finding 在哪个文件、同文件还有哪几条」就在这份里,不再多发一次请求。时间线默认平铺,阶段详情页用 `timeline` 这个渲染入口把它按代码推进分组;另导出 `runScope`(一轮属于哪个阶段)给总览拼详情地址用;一轮的五个数由导出的 `StageRound` 画,为零的不列。
- `src/commit-picker.tsx` — commit 选择器(issue #178):分支下拉加这条分支的提交列表,点行上的按钮把那个 commit 设成 base 或比较项,人不再手输 sha。读 `GET /repo-branches` 与 `GET /repo-commits`(`useInfiniteQuery` 按 `nextOffset` 翻页,「加载更多」是个按钮,不做滚动自动加载——它装在对话框里,外面还有一层滚动)。分支没选过就是仓库默认分支;两端各自记的是 sha,分支只是找它的路径,选完 base 换一条分支再选比较项不影响已选的 base。`baseLocked` 是推进比较项那一档(issue #179):只出现「设为比较项」,并且把调用方给的 base 一起发给 `GET /repo-commits`,回来的 `descendsFromBase` 为 false 的行整行压暗、按钮不可点——那样的比较项服务端本来就会拒。base 与分支一同进查询键,换一条分支拿到的仍是按同一个 base 标好的一页;发起那一档不发 base,两端都还在挑,任何一条提交都可能被设成 base。换仓库时由调用方换 `key` 整块重来。
- `src/range-review-launch.tsx` — 「发起范围审查」入口(issue #177):一个按钮加它的表单,评审记录页头与仓库页共用同一份——两处发起的是同一件事,表单只该有一种样子。给了 `repo` 就是仓库页那一档,仓库预填且不再出现仓库选择。字段是标题、base 与比较项,标题必填(服务端也拒空)。**base 与比较项从 `commit-picker.tsx` 里点选**(issue #178),手输框已删;表单只记两个 sha,顶上一行「已选」把它们的短 sha 显示出来。**base 由服务端预填**:选定仓库后读 `GET /range-reviews/prefill`,拿同仓库最近一个审查完成的范围审查的最终比较项;人自己动过 base 就不再覆盖,换仓库时预填与提醒一起重来。同一 base 已有进行中那一档不当错误提示——服务端 409 带 `needsConfirmation` 时把提交按钮换成「仍然发起」,再点一次带 `confirm: true` 重发。发起成功让 `stages` 那份列表失效一次(列表只有这一份,issue #189)。
- `src/range-review-actions.tsx` — 一个范围审查阶段的两个动作(issue #176):`AdvanceAction` 推进比较项(对话框里装 `commit-picker.tsx` 的 `baseLocked` 那一档,issue #179:base 与当前比较项、新选的比较项都只以短 sha 显示,手输框已删,非 base 后代的行置灰)与 `CompleteAction` 标记审查完成(AlertDialog 二次确认,写明容器 PR 会关、分支会删、未处置的 Finding 怎么算)。入口只有阶段详情页的页头(issue #180 删掉范围审查页之后就这一处),`disabled` 那一格给已经审查完成的阶段用。`RangeReview` 契约类型也从这里导出;动作成功后按 `stage-detail` / `stage-summary` 两段整片失效,阶段详情的两份查询回来时看到的都是新状态。
- `src/stats.tsx` — 处置率页。页顶的用量卡只读 token 与运行次数(issue #188 下线计费之后,总 token 是这一页的主读数,输入 / 输出 / 缓存读 / 缓存写压在它下面一行,运行次数在右侧);日期范围只调用受控 `DateRangePicker`；桌面仓库 × 分类矩阵使用 Themes `Table` 与粘性仓库列，窄屏逐仓库详情使用 Collapsible，保持 Finding Identity 统计口径、范围选择与移动端可访问性。分子是人工与自动之和(`disposed`),分母加上自动那一列后口径不变(`denominator`);「已延续」在服务端就退出了统计,前端不必也不该再补一档;人工 / 自动的拆分列在「按仓库统计」那一段,矩阵里仍是一个合计比率——每格再拆两列会让矩阵没法读。模型那一维只剩页尾一段「模型参与条数」,直接列 `models[]` 里的数,前端不由 cells 反推——处置率不按模型分列(ADR 0015)。只有 `Cell` 类型导出供总览页复用;总览页的 `denominator` 与仓库名拼接都是自己复制的一行,避免把日期选择器那一整块拽进首屏分块。
- `src/credentials.tsx` — 模型服务主从页。`lg=1024px` 起 `264px minmax(0,1fr)` 双栏，整页跟着壳里的 `panel-main-scroll` 一起滚，列表与详情不各开滚动区；640–1023px 仍只显示列表或详情，详情地址提供返回模型服务列表入口。左侧只列已配置或异常保留的服务;右侧按概览、维护、模型三个稳定地址分层,详情导航直接使用 Themes `TabNav`。概览以服务端运行能力为主状态,目录失败作次级提醒,组合引用直接列出全局、跟随全局仓库数与具体仓库覆盖,不折叠;维护收凭据轮换、地址／协议调整、目录刷新与删除,`name-conflict` 自定义服务在这里原子迁移到新名称并跳到新的稳定地址,普通服务不显示改名入口;重新验证的 model id 统一使用 `EditableModelCombobox`,可选自动发现模型且手填路径始终保留。模型页用模型、运行规格、状态三列展示；调用目标不在每行重复，发现值只在与运行规格不同时用 Collapsible 展开。唯一添加入口同时承载 Pi 内置 provider 搜索与自定义 provider;内置、自定义创建和两类既有服务修改共用来源、模型发现、真实推理三步页。自定义发现先收 provider、调用目标、协议与凭据,协议显示产品名称但提交现有运行时枚举;发现失败或目录缺项仍可在验证页手填 model id。凭据与候选只留流程页内存,刷新不会恢复;未保存离开走应用确认并注册浏览器关闭警告,长操作显示阶段并锁住导航。最终提交重新发现并做最小真实推理;新建成功进入对应服务详情,修改成功回服务概览,两者都不写模型组合。读字段和动作按 `model:*` / `credential:*` 独立权限裁剪,前端从不接收明文或密文。

- `src/settings.tsx` — `/settings` 上的审查策略页。全局模型组合与批次上限各持独立版本、分别保存;409 只恢复冲突项,保留另一项草稿。批次上限直接铺在卡片里,并显示系统默认/自定义来源。
- `src/components/model-composer.tsx` — 全局组合与仓库覆盖共用的唯一模型选择器。接口是 `{value, onChange, provider?, onValidityChange}`;外部 provider 优先定位,没有传入时优先显示已选模型所属 provider。它只读 `GET /model-services` 的统一候选,不创建 provider、不处理凭据、不刷新目录、不补录模型。左栏按服务分组,右栏筛当前服务模型;模型行使用 Themes Checkbox 作为唯一选择控件,整行标签可点击并以浅色反馈选中。已选但失效的模型保留稳定原因与「去模型服务处理」入口,允许移除但通知调用页禁止原样保存。一次最多渲染当前服务的 120 行。
- `src/components/ui/` — 允许保留的专用行为组件(Command / Calendar)。Command 只封装 cmdk 的搜索与键盘行为,外观直接读取 Radix Theme token；`EditableModelCombobox` 和仓库搜索复用它。Calendar 只保留 `react-day-picker` 的日期行为,月份导航使用 Themes `IconButton`,日期使用 Themes `Button`,外观读取 Theme token,且只由 `DateRangePicker` 调用;`locale` 为 undefined 时不显式传给 `DayButton`,以兼容 `exactOptionalPropertyTypes`。Button、Input、Label、Badge、Card、Skeleton、Table、Dialog 与 Popover wrapper 已删除。顶栏、底部 Tab 栏与分栏用 utility 实现,不引入带折叠、移动端抽屉和 cookie 记忆的通用 Sidebar。
- `src/lib/time.ts` — 本地时区时间格式化的唯一实现:`localDay`(年-月-日)、`localClock`(时:分)、拼起来的 `localMinute`,以及只给审查轨迹用的 `localSecond`(时:分:秒)——一轮里几十条事件都落在同一两分钟内,只到分钟会让整列时间戳读成一串相同的数。评审记录、范围审查、访问控制与 diff 视图共用,不各带一份 `padStart`。
- `src/lib/utils.ts` — className 合并工具 `cn()`,由 clsx 与 tailwind-merge 实现。
- `src/styles.css` — 样式入口与 Radix Theme token 到产品语义 token、Tailwind token 的映射。cascade layer 顺序固定为 `theme < base < radix < components < utilities`;Tailwind 由自身 layer 输出,Radix Themes 样式统一导入 `radix` layer,保证响应式 display utility 能覆盖组件默认 display。其余只接管浏览器原生面,没有页面组件类。一套 `--v8-*` 原始令牌(表面、文字四档、边框、accent 蓝与四档 tint、iOS systemFill 叠加、语义色、毛玻璃材质、三层阴影、七档圆角、三套字体栈)是全站唯一的颜色事实来源;`.radix-themes` 块把 Radix 真正被组件消费的那些档位(gray 1–12、accent 1–12、green/amber/red 的 3/9/10/11、focus、radius 1–6、font-size 1–9、font-weight、shadow 1–6)拉到这些值上,组件因此不用逐个改样式;`@theme inline` 再把同一批令牌接进 Tailwind。字号阶梯十一档(xs 11 / sm 11.5 / base 12 / md 13 / lg 13.5 / xl 14 / 2xl 16 / 3xl 18 / 4xl 21 / 5xl 25 / 6xl 29,body 就是 lg 13.5)。本文件的声明不进任何 layer——未分层样式优先级高于所有 layer,天然盖过 `layer(radix)`,不需要 `!important`。其余只接管选区、光标、滚动条与表格数字这些浏览器原生面,没有页面组件类。

## 模块规范

- 前端只读注入的 `window.__MULTIREVIEWER__`,不设 `import.meta.env` 回落——分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」不该存在。注入形状必须与服务端(`src/webhook/server.ts` 的 `servePage`)逐字一致。
- Vite 保持默认绝对 base(`/`):静态资源不进前缀,构建产物与前缀无关。**注入插件永远不参与 build**——前缀烤进产物即事故。
- 构建产物是纯静态文件:服务端的运行时第三方依赖仍只有 Pi,react 全家只活在构建阶段。
- 当前身份与权限只从 `GET <前缀>/api/session` 读取,由 `src/session.ts` 缓存一份;未认证的 401 由壳统一送去 `/login`,必须改密统一送 `/password`,页面组件不各自判。导航按权限隐藏而不是摆禁用项,但服务端 403 仍是最终授权边界。
- **模型组合编辑器只有一份且只负责选择。**审查策略与仓库覆盖都挂 `components/model-composer.tsx`;配置模型服务、凭据、发现、刷新与补录一律回模型服务页,组合编辑器不得再长出第二条写链。
- **失效的已选模型不静默消失。**`GET /model-services` 给稳定原因与处理入口,编辑器原样显示并允许移除;调用页只门禁这一次组合保存。批次上限等无关设置仍可独立提交,最终门禁以服务端同一模型服务投影为准。
- **模型服务字段与动作按权限裁剪。**`model:read` 才看目标、目录、模型、来源和可用性,`credential:read` 才看凭据审计字段;候选与错误响应不得含明文、密文或主密钥材料。前端只依据返回字段展示,不复制服务端 provider、引用或版本竞争判据。
- **通用视觉只有 Radix Themes 一条路。**颜色、字号、间距、圆角及组件状态使用 Theme 配置、组件 props 与 Theme tokens；Radix Primitives 只补行为；Tailwind 只处理 Themes 响应式能力无法表达的复杂布局和产品专有结构。页面不得深度覆盖 Radix 内部 DOM,也不得为同一语义另写一套 utility 外观。
- **响应式显隐依赖固定 cascade layer。**Radix Themes 必须从 `styles.css` 导入 `radix` layer,不得在 TSX 入口单独导入未分层样式；`hidden` 与断点 display utility 才能稳定覆盖 Card、Button、Table 等组件的默认 display。新增样式入口或调整 layer 顺序时必须检查生产 CSS。
- **文本输入与字段标签直接使用 Themes。**文本输入使用 `TextField.Root`,搜索图标等附件进入 `TextField.Slot`;可见或视觉隐藏的字段标签使用 `Text as="label"` 并保持 `htmlFor`/`id` 关联。输入在窄视口使用响应式 size 和最小触控高度；组合框只复用输入外观,其受控值、候选和键盘行为继续由领域组件持有。
- **有限枚举与多选直接使用 Themes。**有限枚举使用 `Select`,权限矩阵、模型批量选择和补录确认使用 `Checkbox`;点击区域通过可见标签或可访问名称关联。批量全选必须呈现部分选中的 indeterminate 状态。允许搜索和手填的 model id 使用统一的可编辑组合框，保留目录搜索、键盘选择和直接输入裸 model id。
- **输入类控件的焦点态是外侧一圈淡蓝环,不是 Radix 默认的内侧实线。**Radix 给 TextField / TextArea / Select 画的是 `outline: 2px solid` 加 `outline-offset: -1px`——实色线压在控件内侧、紧贴输入的文字,看起来像报错高亮。`styles.css` 统一改成 `outline: 3px solid var(--v8-accent-focus)`、offset 0,环落在控件外侧。这条写在设计系统层,页面不再各自处理焦点样式。
- **说明性文字按设计稿口径给,不写页头描述。**设计稿里没有任何超过十五字的说明句;页名已经出现在顶栏面包屑里,标题下面再写一行"这一页是干什么的"是重复。需要解释规则或后果时用 `HelpTooltip` 挂在标题旁,按需展开。空状态里指路下一步动作的句子保留——那是用户当下唯一能读到的指引。
- **面板只做亮色一套**(issue #46)。`PanelTheme` 明确固定 `appearance="light"`;不加主题上下文、本地存储、防闪脚本或暗色变体。需要暗色时先在设计系统中补齐完整 token 与组件状态,再引入主题切换。
- **状态 Badge 只走 `StatusBadge`.** 它固定 neutral / running / success / warning / error 到 Radix Gray / Blue / Green / Amber / Red,固定 `soft` 与 full 圆角,不开 `highContrast`;running 走主色,因为「还没有结论」既不是好也不是坏,不该占用三档语义色里的任何一个;颜色、文字与图标共同表达状态。来源、身份和类别直接使用 Themes Badge。页面不得再给 Badge 添加 `bg-success` / `bg-warning` / `bg-destructive` 等状态类。**主色是蓝 `#0071e3`**,不是近黑,也不是青。警告是唯一的双色对:图标与状态点用 `#bf8700`,文字压到 `#9a6700`——亮琥珀当文字在白底上过不了 AA。
- **选中态按操作语义分三类。**主导航和 tab 表示当前位置,用 3px 蓝色圆头指示条加字重 650；仓库、模型服务和 `ModelComposer` 的 `MasterListItem` 使用同一套蓝色 tint 底加 3px 蓝色左条,文字不反白,选中项 hover 保持同一背景；模型行、命令菜单和批量勾选属于编辑中的选择,使用浅底、描边或 Checkbox。左条一律走伪元素,不用 `border-left`——后者会把行内容推右 3px,而这个补偿只要漏一处就错位。受控弹窗通过 `useDialogReturnFocus` 记录真实触发元素；关闭必须保留底层列表项与 tab,并把焦点还给触发入口或稳定后备入口。任何选中态都要单独检查 hover、focus 与辅助文字对比度。
- **字号只用令牌里那十一档**,不写 `text-[13px]` 这类一次性值。档位各有唯一职责:xs 11 短 SHA 与快捷键、sm 11.5 计数徽章与表头、base 12 元信息与状态徽章、md 13 按钮与控件、lg 13.5 正文基准、xl 14 面包屑当前页与命令面板结果、2xl 16 卡片区块标题、3xl 18 抽屉与模态标题、4xl 21 登录页品牌标题、5xl 25 页标题(一页一个)、6xl 29 KPI 数字。设计稿里 0.5px 步进的八档密度是逐像素目视调优的结果,落到代码里收敛掉——屏幕上看不出来,却会让每个页面各写各的。
- **等宽字体只包数字,不包中文。** `font-mono` 会把汉字撑成等宽格,「3 轮」因此读成断开的两块;写法是 `<span className="font-mono tabular-nums">{n}</span> 轮`。
- 时间一律「年-月-日 时:分」本地时区,不用 `toLocaleString()`——它给的是 `8/14/2026, 6:25:21 PM`,与全站的 ISO 风格对不上。
- 读取中给骨架块,不给「读取中…」那行字:骨架保住它替代的那块内容的尺寸,数据到了不跳版。
- **一个审查阶段只有一份列表、一个入口、一个返回**(issue #189)。评审记录是 `/runs` 这一份,仓库只是它的过滤条件;阶段页是 `/stages/<阶段标识>` 这一张,只有一种视图;下钻只有侧滑,开在同一路由的查询参数上。不再开第二份列表、第二种阶段视图或第二个返回——同一个阶段有两个入口时,页顶那个返回必然把一半人送错地方。
- 前端不做程序化测试(issue #26 的测试决策):逻辑压在服务端可测的注入变量与 API 契约上(`test/panel-pages.test.ts`);视觉与交互由部署实例的端到端验收覆盖。
- **端到端验收固定在部署实例使用 ego-browser,不在本机 dev 双进程上做**(根 `AGENTS.md` 的全局规范)。本机没有真 Gitea、没有已注册的仓库、没有模型凭据,面板上大半的屏在那里是空的;dev 双进程只用于实现时的即时反馈,不作为验收依据。

## 依赖关系

不依赖仓库里任何服务端代码;与服务端的契约只有两条:注入全局变量的形状、`<前缀>/api` 的 JSON 端点。

当前构建期依赖是 `@radix-ui/themes`、`@radix-ui/react-icons`、Tailwind v4、`radix-ui` 单包、cmdk、react-day-picker、clsx 与 tailwind-merge。业务图标只从 `@radix-ui/react-icons` 导入；产品标记与 favicon 保留自绘 SVG。cmdk 与 react-day-picker 只在统一产品组件仍需要对应行为时保留。`@/` 别名在 `tsconfig.json` 的 `paths` 与 `vite.config.ts` 的 `resolve.alias` 各配一次,两处要一起改。

## 常用命令

- `pnpm --filter @multireviewer/web dev` — dev 起 Vite(另开一个终端跑 `pnpm start` 起后端,双进程)
- `pnpm --filter @multireviewer/web build` — 产出 `dist/`
- `pnpm --filter @multireviewer/web typecheck` — 前端类型检查(不在根 `pnpm check` 里,改前端后单独跑)

## 视觉规范

2026-08-24 定稿的整体重设计方向，设计稿见 Claude Artifact「MultiReviewer Radix 重设计」（版本 v7-all-pages，三页十二块画板全页覆盖：核心 = 总览、运行+详情、⌘K、移动端总览；业务页 = 仓库、处置率、模型服务、添加模型服务向导；配置与账户 = 审查策略、访问控制、登录、修改密码。画板内文案按真实产品口径精简，不含说明性注释）。原则：信息架构与工程语义取 GitHub，材质与 finish 取 Apple。本节已全量落地，令牌实现在 `src/styles.css`，壳在 `src/main.tsx`。

### Token

- 底色：内容区 `#f5f6f8`，卡面纯白；顶栏与移动端 Tab 栏用半透明白 + backdrop blur（毛玻璃）。
- 主色一支笔：动作 / 选中 / 图表 / 链接统一 `#0071e3`（在 Radix Themes 下配 `accentColor="blue"` 并以 token 覆盖到该值）；不再使用近黑主色与深色实底选中态。
- 毛玻璃要有东西可模糊：顶栏与移动端 Tab 栏必须**放在滚动容器内**并 `sticky`，不能挂在容器外面当兄弟节点——那样内容永远不从它们底下经过，`backdrop-filter` 背后只剩页面底色，顶栏就是一块纯白平板。
- 语义色的文字档比设计稿深一级：绿 `#177031`、琥珀 `#8f6000`。设计稿的 `#1a7f37` / `#9a6700` 是按纯白底算的，而徽章文字压在 10% 的同色 tint 上，对比度掉到 4.47 与 4.40，都在 AA 门槛下。图标与实心底仍用原色，两族都是双色对。
- 状态语义色（低饱和）：success `#1a7f37` / warning `#bf8700`（文字用 `#9a6700`）/ error `#cf222e` / 进行中用主色蓝；呈现统一为 soft tint 胶囊（约 9% 透明度同色底 + 深色同色文字）或 16px octicon 式图标（✓ 圆 / ✕ 圆 / ⚠ 三角 / 实心点），不用高饱和大色块。
- 圆角：卡片 12–14px、控件 9px、chip/胶囊 999px（Radix Themes `radius="medium"` 起步，卡面用 Card 的 surface 覆盖）。
- 边框与阴影：卡面 1px `rgba(0,0,0,0.055)` 发丝边 + `0 1px 6px rgba(0,0,0,0.04)` 漫射阴影；行分隔 `rgba(0,0,0,0.05)`。
- 字体：系统栈（Mac 渲染 SF Pro）；页级大标题 25px/700/紧字距，卡标题 16px/650，正文 13.5px；数字一律 `tabular-nums`，KPI 数字 29px/700。字号档位仍走 token，不写一次性值。

### 结构与组件映射

- 壳：左侧栏取消，改双层顶栏——上层面包屑（产品标记 / 页名）+ ⌘K 搜索框 + 账号区，下层横向导航：当前项加粗 + 蓝色圆头短下划线；「仓库」带计数胶囊，「模型服务」异常时带琥珀圆点。窄屏导航改移动端底部 Tab 栏（毛玻璃）。**顶栏导航没有用 Radix `TabNav`**：它的指示条是 2px 方头且铺满整个 trigger，而这里要 3px 圆头、左右各内缩 12px；改它得深度覆写 Radix 内部 DOM，比自绘一个 `span` 代价大，也违反「不深度覆盖 Radix 内部 DOM」那条。模型服务详情页内部的分层导航仍然直接用 `TabNav`。
- 总览页（新增路由）：KPI 四卡（今日运行 / 待处置发现 / 七日处置率 + 活动圆环 / 模型健康圆点组）+ 最近运行列表 + 模型服务健康与逐仓库处置率侧栏。
- 运行详情：从行内展开改为右侧浮动面板（四边留 14px、18px 圆角、毛玻璃、桌面 920px 宽），内部是这一轮的完整 diff——每个文件一张卡（卡头写路径、状态、`+N −M` 与发现数，点开才取内容），Finding 卡片插在它所指的那一行下面：已处置划线 + 绿 ✓，未处置带 P1/P2 严重度胶囊，模型失败原因整段摊在顶部的红色 Callout 里；底部「重新运行 / 去 pull request 看原版」动作条。
- ⌘K：cmdk 升为一级入口（顶栏常驻）。面板用 Spotlight 材质（blur + 16px 圆角），保留 `>` 命令前缀与「动作 / 跳转」分组，选中项蓝色实底反白。
- 筛选：SegmentedControl 保持 iOS 形态（灰底 + 白色浮起选中片）。
- 短 SHA 用 mono 字体 + 蓝色 tint chip；模型 chip 用灰 tint 胶囊 mono，失败模型红 tint。
- 选中态三分类语义保留，颜色改为：当前位置 = 蓝下划线 / 加粗；主从列表当前项 = 蓝色 tint 底 + 3px 蓝色左条（替代深色实底反白）；编辑中选择不变（浅底 / 描边 / Checkbox）。弹窗关闭恢复底层项与 tab 等交互约束全部沿用。`aria-current="page"` 只给导航用(顶栏导航项、详情 TabNav);主从列表的当前项用 `aria-current="true"`——它是列表里的当前项,不是当前页面,写成 `page` 会让模型服务这类页面同时报出三个「当前页面」。

## 变更日志

- 2026-08-26: 落地 issue #191(spec #190)的面板部分。`access-control.tsx`:`User` 多一个 `repoIds`,新增 `AssignableRepo` 与 `["repos"]` 查询(读 `GET <前缀>/api/repos`,访问控制页只有系统管理员进得来,拿到的就是全部仓库),新增 `RepoChecklist`(仓库多选,勾选框列表,一个仓库都没注册时给一句说明)。新建用户弹窗多一段「分配仓库」,创建时把 `repoIds` 一起发出去;用户表在「角色」与「创建」之间多一列「已分配仓库」,系统管理员显示「全部仓库」,普通用户显示数量并点开分配弹窗(保存打 `PUT /users/{name}`,带上这个人现有的显示名与角色)。`session.ts` 的 `PanelSession` 多一个 `repoIds`(系统管理员是 null);这一票只落类型,零分配空态与按分配过滤是后续的票。
- 2026-08-26: 落地 issue #189。**导航收成三层:列表 → 阶段页 → 侧滑**。`runs.tsx` 多收一个仓库过滤(地址上一对 `?owner=&repo=`,进查询键与 `stagesPath`,显示当前仓库并给「清除」),点开一行时把三个过滤一起带进阶段页的地址。`repos.tsx` 的评审记录区块删掉内嵌列表与 `repo-stages` 那份查询,只剩一个指向 `/runs?owner=&repo=` 的链接,发起与重跑两个入口不动。`stage-detail.tsx` 删掉轮次视图整块(`StageRunView` / `RunBody`、「本轮 diff / 审查轨迹」分段控件、「回到阶段汇总」按钮、处置进度条、`?run=` 与 `?file=`),换成两个侧滑:`FindingDrawer`(`?finding=`)与 `RoundDrawer`(`?trace=`),容器 `StageDrawer` 用 `radix-ui` 的 `Dialog` 原语自绘侧边抽屉(`Dialog.Portal` 里挂 `Overlay` + `Content`,遮罩走 `bg-scrim`,关闭按钮的可访问名是「关闭 <侧滑标题>」)——Themes 的 Dialog 是居中模态,改它得深度覆写内部 DOM。Finding 侧滑取的是**这个阶段最新一轮**的 patch(`latestRunId`);轮次侧滑保留失败模型的原因逐条摊开与这一轮的 token 用量一行(issue #188 的口径),两样都摆在头部之下、轨迹之上。页顶那个返回改成带上地址里存着的列表过滤,`main.tsx` 的面包屑在 `/stages` 上跟着停在「评审记录」。`run-diff.tsx` 的 `RunDiff` / `FileSection` / `DiffFile` / 三个筛选 `Select` 全删——历史轮次的 diff 浏览这一票明确取消,整轮的文件列表没有第二个消费者;留下的 `FindingRow` 与新的 `FilePatch`(单文件 patch、锚定行滚到视野正中并高亮、锚不上的写明原因)供侧滑与列表共用。取不到 patch(工作副本被清的 409 在内)与另外三种锚不上同口径:一句中性说明加照常显示的 Finding 卡片,不再是红色 error Callout。`FindingRow` 的已延续三处分支一并删掉——汇总接口已经把已延续过滤掉,这个组件的三个调用方都读那份汇总,分支到不了;承接那条的「延续自上一处评论」链接留着。`stage-summary.tsx` 的「去最新一轮 diff」链接换成整块卡头打开 Finding 侧滑,只服务于旧链路的 `onJumpToRun` 一起删;新导出 `useStageSummary`,阶段页正文与侧滑共用同一份缓存。处置与轨迹结束时失效的那一串里 `repo-stages` 换成 `stage-detail`:仓库列表没有了,而阶段页头部那三个数就在 `stage-detail` 里。`overview.tsx` 最近运行那一行的链接改成不带查询参数的纯阶段页:总览不在这一票的范围里,从它点进去不该直接弹开侧滑。**服务端一个接口没改**。
- 2026-08-26: 落地 issue #188 的面板部分。`src/usage-cost.ts` 删除(`costPresentation` 与 `CostPresentation` 没有第二个用途),`UsageSummary` 改由 `runs.tsx` 导出、只有 token 五列。`stats.tsx` 页顶的卡从「时间范围费用」换成「时间范围 tokens」:总 token 走 6xl 主读数,四个分项在它下面一行,右侧是运行次数(`/stats` 的 `usage.runs`)。`stage-detail.tsx` 的轮次末尾删掉「成本」与它的警告句,只留 token 一行。`model-services.ts` 的 `ModelCost` 与 discovery / runtime 两处的 `cost` 字段、`credentials.tsx` 的 `CostValue` 与 `sameCost`、`model-composer.tsx` 模型行上的单价与「费用未记账」全部删除;模型行右侧只剩上下文。评审复核后 `stats.tsx` 不再自带一份同名类型,改为 `UsageStats = UsageSummary & { runs }`,`UsageSummary` 从 `runs.tsx` 引入。
- 2026-08-26: 落地 issue #184 的面板部分。`RepoRow` 多一个 `worktree`(`state` / `failure` / `checkedAt`),仓库详情头部加工作副本徽章,失败与未准备两档给出原因与「准备工作副本」按钮,`repos` 查询在有仓库准备中时每 5 秒续查。其余区块一行没动。
- 2026-08-26: 落地 issue #185 的面板部分。`range-review-actions.tsx` 里 `RangeReview` 契约类型的注释改指它实际的来源——`GET <前缀>/api/stages/{stageId}` 的 `rangeReview` 那一格(服务端把 `GET /range-reviews` 与 `GET /range-reviews/{id}` 删了)。本文档里 `run-diff.tsx` 处置成功与 `run-trace.tsx` 轨迹结束时的失效清单还写着 `range-review` 那一份查询,代码在 issue #180 就已经去掉,文字跟着改成现状。组件代码一行未动。

- 2026-08-26: spec #172 落地后的评审与线上验证修补。仓库页评审记录行改用 `lib/time` 的 `localMinute` 并补上来源标记(此前打的是 UTC 切片,与 `/runs` 同一行差 8 小时)。`commit-picker.tsx`:提交列表等分支重取(服务端 fetch 发生在那一步)回来再发、并把重取时刻带进查询键,重开选择器能看到刚推的 commit;`Select` 的受控值从占位 `""` 变成默认分支时 Radix 会回调一次 `""`,现在把它当「没选」而不是选了空分支——此前整页新加载后分支卡在「读取分支中…」、提交列表报「branch 要给」。`stage-detail.tsx`:重跑与推进都是 202 就回、新一轮要等工作副本就绪才落库,只按「有未完成轮次」续查永远启动不了;动作成功后先按 90 秒窗口续查,刚推进、还没有轮次的比较项也算要续查,轮次一出现就接回按状态续查。

- 2026-08-25: 落地 issue #180 的面板部分。**范围审查页删掉了**:`/range-reviews` 路由、`NAV` 里的「范围审查」项(连同只它在用的 `LayersIcon`)与 `src/range-reviews.tsx` 一起没了,旧地址不做跳转,交给路由的常规未找到。`src/components/detail-panel.tsx` 跟着删——评审记录在 issue #175 之后就不用它了,范围审查页是它最后的消费者。查询键也清掉:`RANGE_REVIEWS_QUERY_KEY`(`["range-reviews"]`)与 `["range-review", id]` 在页面删掉之后没有读者,`range-review-actions.tsx` 的 `refreshRangeReview` 只剩 `stage-detail` / `stage-summary` 两段,`range-review-launch.tsx` 发起成功后只失效 `stages` / `repo-stages`,`run-diff.tsx` 与 `run-trace.tsx` 处置和轨迹结束时要失效的那一串里去掉 `["range-review"]`。`range-review-launch.tsx` 与 `range-review-actions.tsx` 两个组件本身没动,入口分别只剩评审记录页头 / 仓库页评审记录区块与阶段详情页页头。

- 2026-08-25: 落地 issue #179 的面板部分。推进比较项不再手输 sha:`range-review-actions.tsx` 的推进对话框换成 `commit-picker.tsx` 的 `baseLocked` 那一档,base 显示为锁定的短 sha,人只选新的比较项(选中的也以短 sha 显示在 base 与当前比较项旁边)。选择器在这一档把 base 一起发给 `GET /repo-commits`,`descendsFromBase` 为 false 的行整行压暗、「设为比较项」不可点;base 进了查询键,切换分支后按同一个 base 重新标记,作者 rebase 到另一条从 base 分出去的分支上的 commit 照样选得到。提交按钮在选出比较项之前禁用。范围审查页与阶段详情页共用同一个组件,两处推进入口一起改。服务端的后代校验一字未改。

- 2026-08-25: 落地 issue #176 的面板部分。**一个阶段的动作都收进它的详情页**:`stage-detail.tsx` 的页头多了重跑、推进比较项与审查完成三个按钮。推进与审查完成从 `range-reviews.tsx` 搬进新的 `src/range-review-actions.tsx`(`AdvanceAction` / `CompleteAction`,连同 `RangeReview` 类型与 `RANGE_REVIEWS_QUERY_KEY`),两个页面共用同一份实现,行为与原页面一致——推进本票仍是手输 sha,#179 再换 commit 选择器。重跑两种来源同一个按钮:pull request 阶段发 `{owner, repo, pullNumber}`,范围审查阶段发 `{rangeReviewId}`(`runs.tsx` 新增 `rerunRangeReviewRequest`)。按钮按权限出现(重跑 `review:rerun`、推进 `review:create`、完成 `finding:dispose`,`main.tsx` 把这三格传进页面),范围审查状态不是进行中时三个都禁用,记录读的是 `GET /stages/{stageId}` 多带的 `rangeReview`。范围审查页仍在(issue #180 删),只是不再自己实现这两个动作。
- 2026-08-25: 落地 issue #178 的面板部分。发起范围审查不再手输 sha:新增 `src/commit-picker.tsx`(分支下拉 + 提交列表 + 「加载更多」),`range-review-launch.tsx` 的两个手输框换成它,表单只留标题一个输入框。分支下拉默认选中仓库默认分支;提交行显示短 sha、提交信息首行、作者与时间,行上的按钮分别把它设成 base 或比较项,已经是某一端的 commit 不再出现那个角色的按钮。#177 的 base 预填照旧生效——预填的是一个 sha,未必在当前分支的第一页里,以「已选 base」显示即可。换仓库时选择器整块重来(`key`),比较项跟着清空。选择器为 issue #179 留了 `baseLocked`,本票不实现非后代置灰。

- 2026-08-25: 落地 issue #177 的面板部分。发起范围审查的表单从 `range-reviews.tsx` 搬进新的 `src/range-review-launch.tsx`,连按钮一起对外只有一个 `RangeReviewLaunch`:评审记录页头(`runs.tsx`,先选仓库)、仓库页评审记录区块的卡头(`repos.tsx`,仓库预填)与范围审查页共用它,三处只有一份实现。表单多一个必填的标题字段,base 打开时按 `GET /range-reviews/prefill` 预填(人动过就不再覆盖,换仓库时重来)。两处新入口都按 `review:create` 裁剪,`main.tsx` 把这一格传给 `RunsPage` 与 `ReposPage`。范围审查页的列表行与详情头部改用标题作名字,旧记录显示 `#编号`。

- 2026-08-25: 落地 issue #175 的面板部分。**审查阶段有了自己的地址**:新增 `/stages/$stageId` 路由与 `src/stage-detail.tsx`,两种来源共用一页——默认是阶段汇总(复用 `stage-summary.tsx`,三个数与筛选照旧),时间线换成按代码推进分组(pull request 按 head commit,范围审查按比较项,数据来自新增的 `GET /stages/{stageId}`,前端不拼多次请求),点某一轮切到那一轮的 diff 与审查轨迹,轮次记在 `?run=`,刷新仍停在它。评审记录页与仓库页的评审记录区块**点开一行改成跳这个地址**,两页的详情抽屉随之删掉:`RunDetailPanelById` / `RunDetailPanel` 与只服务于抽屉的 `RunPill`、`runBadge`、`triggerLabel`、`RunSourceBadge`、`runDuration`、`data-run-id` / `data-filter-*` 命中与列表页的 `?run=` / `?file=` 一并清掉,重跑入口暂时只剩仓库页那一处(issue #176 把它搬进详情页)。`runs.tsx` 因此不再 import `run-diff` / `run-trace` / `stage-summary`,详情那几块独立成 `stage-detail` 分块。阶段汇总的「去最新一轮 diff」与总览「最近运行」的行都改指新地址(`stage-summary.tsx` 导出 `stageIdOf` 与 `runScope`,阶段标识只拼这一处)。范围审查页此票不动:它的推进与审查完成入口还挂在自己的详情抽屉上,由 issue #176 搬走。

- 2026-08-25: 落地 issue #174 的面板部分。评审记录页与仓库页的评审记录区块都改读 `GET /stages`,**一行一个审查阶段**:来源标记、名字(`stageLabel`)、最新一轮时间、阶段汇总三个数与进行中 / 已结束的状态徽章。结论筛选(全部 / 失败 / 待处置 / 已处置,只筛已加载的那几页)换成服务端的状态与来源两个筛选,各自写进地址;翻页从 `?before=` 游标换成 `?offset=`。点开一行打开这个阶段最新一轮:新增导出的 `RunDetailPanelById` 按 `latestRunId` 读 `GET /runs/{id}`,评审记录页与仓库页共用它,`RunDetailPanel` 自身与 diff / 阶段汇总 / 轨迹三个视图一行没动。查询键随之改名(`runs` → `stages`,`repo-runs` → `repo-stages`,打开的那一轮是 `run`),处置与轨迹结束时失效的那几片跟着改。`runLabel` 与只服务于结论筛选的 `runBucket` / `RunStatus` / `rowBadge` / `RunModelChips` 删掉,不留孤儿;总览的「待处置发现」改指 `/runs?status=active`。按天分组的时间流不再成立(一行是阶段不是轮次),列表改成平铺。范围审查页此票不动。

- 2026-08-25: 落地 issue #173 的面板部分。`RunItem` 多一个 `title`(被审 pull request 的标题快照,可为 null),`runs.tsx` 导出 `runLabel` 并用在评审记录列表行上,仓库页的评审记录行改用同一个函数:有标题的行显示标题,没有的照旧是 `#编号`。详情面板的头部与其余呈现一行没动。

- 2026-08-25: 落地 issue #171 的面板部分。运行详情面板的分段控件多一档「审查轨迹」(两条链路都有;「阶段汇总」仍只给 PR 触发的那一轮),正文换成新增的 `src/run-trace.tsx`:轮次级里程碑列在最上面一段,每个 Reviewer 一个可展开块按 `seq` 列自己的文本、工具调用、失败与收尾。进行中的轮次先取 `/trace` 补历史、再用原生 `EventSource` 接 `/trace/stream?after=<最后的 seq>`,增量 `setQueryData` 追加到同一份缓存,收到 `end` 关闭连接并让三份轮次投影各刷新一次,卸载即断开;已结束的只取 `/trace`。`api.ts` 抽出 `apiUrl(path)` 给 `EventSource` 用(前缀仍只写一次),`lib/time.ts` 加 `localSecond`(轨迹是全站唯一带秒的地方)。不加依赖,`run-diff.tsx` 与阶段汇总一行没动。

- 2026-08-25: 落地 issue #168 的面板部分。**范围审查详情的主视图变成阶段汇总**:整个阶段按 Finding Identity 汇总成一份列表,每条显示当前状态、严重度、分类、正文、归属模型、第几轮首次报出与最近一次、备注与处置署名,顶上是待处置 / 人工已处置 / 已修复三个计数(点一下即按它筛),另可按文件筛;一条 Finding 既能外链到 Forge 上最新那条评论,也能跳到最新一轮的 diff 位置,处置就在卡片里做、做完汇总立刻跟着变。轮次降为时间线,仍按比较项分组,每轮只标本轮的新报出 / 折叠 / 已修复 / 已延续 / 漏复核。PR 触发的轮次详情多一个「本轮 diff / 阶段汇总」开关,评审记录页与仓库页因此一次都有了同样的入口。新增 `src/stage-summary.tsx`,Finding 卡片与处置动作直接复用 diff 视图那一份,不另写一套。

- 2026-08-25: 落地 issue #169 的面板部分。处置率不再按模型分列(ADR 0015):`Cell` 的 `model` 换成 `owner` / `repo`,「按模型统计」改成「按仓库统计」、矩阵改成「仓库与分类」(行头、粘性列、合计行与 caption 一并换),页尾新增一段「模型参与条数」直接列服务端回的 `models[]`。总览页右栏的「各模型处置率」改成「各仓库处置率」,`ModelRates` 改名 `RepoRates` 并按 `owner/repo` 分组;它仍不 import 处置率页的模块,仓库名与 `denominator` 一样在本地拼一行。评审记录页头部的 `SummaryRate` 是全部 cell 求和,口径随服务端走,这次一行没动。

- 2026-08-25: 落地 issue #167 的面板部分。`RunFinding` 的 `disposition` 加第五档 `continued`(「已延续」),并多一个 `continuedFrom`(承接来的那条旧评论地址)。`run-diff.tsx` 新增 `findingContinued`:已延续的那一行正文压暗但不划线,多一行说明并收起处置动作,处置状态筛选的两档都不收它(只在「全部」下出现)——它既不是处置,也不该继续挂在待处置里等人去点;承接它的那一行显示「延续自上一处评论」的外链。进度条与各处「x/y」的口径不动:服务端已经把已延续从每轮的计数里去掉了。

- 2026-08-25: 落地 issue #164 的面板部分。一条 Finding 可以由几个模型报出(ADR 0015):`RunFinding` 的 `model` 换成 `models: string[]`,diff 卡片把归属逐个列出、按模型筛选改成 `models.includes(...)`。处置值 `changed` 改名 `fixed`:`RunItem` 与处置率页 `Cell` 的字段跟着改,`disposedCount` / `denominator` / `disposed` 与总览页那份复制的口径不变,自动处置那行的措辞从「代码已改动 · 自动处置」改成「已修复 · 自动处置」,处置率页的 tooltip 同步。只换名不换义:判据仍是指纹规则,由后续票换成复核结论。

- 2026-08-25: 收掉面板上的三处重复。主从详情面板的外壳抽成 `src/components/detail-panel.tsx`,评审记录与范围审查共用一份:两页此前逐字相同的 400 字符 `Dialog.Content` className 与同构 header 只差桌面宽度,现在宽度是 `wide` / `narrow` 两档 prop(920 / 464)。commit chip 收进 `src/components/commit-chip.tsx`,总览页那份内联写法一并换掉。`localDay` / `localClock` / `localMinute` 收进 `src/lib/time.ts`(`localMinute` 由前两个拼出来),`runs.tsx` 不再导出时间函数,访问控制与范围审查各自那份副本删掉——共享位置只有日期算术,不牵日期选择器这类重依赖,分块反而少了一点。`run-diff.tsx` 的 `parseUnifiedDiff` 与 `FindingRow` 没有第二个消费者,去掉 `export`。DOM 结构、className、可访问名称与行为一律不变。

- 2026-08-25: 落地 issue #160 的面板部分。Review Run 详情重做成完整 diff 视图:新增 `src/run-diff.tsx`(文件列表 + 逐文件懒加载的 unified diff + 自己写的 `parseUnifiedDiff` + Finding 行内锚定与处置 + 按文件 / 模型 / 处置状态三个筛选),`src/runs.tsx` 的详情面板正文整块换成它,原先按模型分组的 Finding 列表删掉、不留两套;`FindingRow` 与处置请求一并搬进 `run-diff.tsx`,`localDay` / `localClock` 从 `runs.tsx` 导出共用。详情面板桌面宽度从 464px 改到 920px(`DESIGN.md` 10.2 同步):装的是 diff,一行代码在 464px 里要折三四次。模型失败原因从模型卡片挪到视图顶部的红色 Callout,仍然整段摊开。

- 2026-08-25: 落地 issue #159 的面板部分。人工处置与「已改动」自动处置分开显示(ADR 0013)。`RunItem` 多一个 `changed`,新增 `disposedCount()`(人工 + 自动)作为进度、结论徽章与四处「x/y」计数的唯一口径,总览、仓库页与范围审查详情一并改读它;运行详情的进度条拆成两段(人工走主色,自动走 40% 主色),自动那一列非零时下面多一行「人工 x · 自动 y」。Finding 行认第四档 `changed`:按已处置呈现,署名行写「代码已改动 · 自动处置」加处置时刻。处置率页 `Cell` 多一个 `changed`,`denominator` 与新增的 `disposed` 一起把分子改成人工 + 自动,「按模型统计」每行多一行人工 / 自动拆分;总览页那份复制的 `denominator` / `rate` 同步。

- 2026-08-25: 落地 issue #158 的面板部分。范围审查详情面板底部多一颗「审查完成」,走 AlertDialog 二次确认(与移除仓库同一套做法),文案写明容器 pull request 会关、两条分支会删、未处置的 Finding 按未处置计入处置率,以及「Finding 与备注仍然看得到、同一个 base 可以再开一个」。入口按 `finding:dispose` 与「进行中」两个条件裁剪;完成之后推进入口一并消失,详情里多一行完成人与完成时刻。

- 2026-08-25: 落地 issue #157 的面板部分。范围审查详情面板底部多一颗「推进比较项」:填新的 commit sha,服务端推容器 PR 的 head 分支并跑新一轮。入口按 `review:create` 与「进行中」两个条件裁剪,已完成或发起失败的记录看不到它。详情里的「轮次」改成「比较项」:历次比较项倒序排,每一个下面挂它对应的那些轮次(按 head 认),发起时填的那个也在内。

- 2026-08-25: 落地 issue #156 的面板部分。评审记录的运行详情面板里能直接处置 Finding:模型卡片下逐条列出正文、严重度、类别、文件与行与「看 Forge 原评论」的链接,行内 resolve / unresolve 并可填一条处置备注,处置人与时刻显示在条目上。动作按新权限格 `finding:dispose` 裁剪,没有这一格时行内不渲染任何处置控件。处置成功后让三份轮次查询失效,列表与处置进度条不刷新即更新。面板底部那颗按钮改叫「去 pull request 看原版」——处置已经在面板里做,那一格只剩看上下文。访问控制的权限矩阵多一行「评审 · 处置」。

- 2026-08-25: 落地 issue #155 的面板部分。新增「范围审查」页与导航项(`/range-reviews`,`review:read` 可见):列表 + 发起表单 + 详情(base、当前比较项、轮次、容器 PR 出口)。发起入口按新权限格 `review:create` 裁剪,没有这一格时页头不渲染按钮、空态直接写明缺哪一格。同一 base 已有进行中的那一档做成二次确认,不做成错误。评审记录页的轮次多一枚「范围审查」徽章区分来源。访问控制的权限矩阵多一行「评审 · 发起」。

- 2026-08-25: 清掉复述与无意义折叠。**说过的话不再说第二遍**:仓库详情的准入 Key 不再重复页头徽章已报的 hook 状态,模型组合说明只在可写时出现(只读态 Kv 标签已经说了跟随全局还是本仓库覆盖),权限矩阵的管理员说明压到一句。**指路型文案删掉**:「选择左侧」「从页头」「先从下方」这类句子只在复述旁边控件上的字。**折叠只留下有理由的**:组合引用与批次上限直接铺开,窄屏统计与模型发现差异保持折叠。**部分失败只画一个警告**:失败原因的 Tooltip 挂到结论徽章上,徽章本身已经是警告样式。**换页不再横跳**:路由骨架跟着目标页选 wide/form 列宽,与随后渲染的正文占同一条内容轨。
- 2026-08-24: 面板从「能看」推进到「能顺着做完」。**处置的出口补齐**:`/session` 返回 Forge web 基址,运行详情多一颗「去 pull request 处置」,仓库页的 PR 号可点——处置只在 Forge 上发生,在此之前面板报出的每一个待处置数都是点不进去的死数字。**总览的指标接上了去处**:待处置发现进已筛好的评审记录,今日运行进记录列表,模型健康进模型服务页;打开哪一轮与筛选哪一片进地址,链接可分享、后退键可收起。**未结束的轮次显形**:原先它会掉进「已处置数/总数」的判断而显示成「无可处置项」,看起来像跑完了;现在 StatusBadge 多一档走主色的 running,列表在有轮次未结束时自动续查。**首次配置有了收尾**:注册仓库不再静默关窗,而是说清楚接下来向它推 pull request 就会开始审查。同时清掉面板上的内部实现:`Pi` 这个 harness 名(7 处)、库文件大小与 19 张表行数的「数据存储」区块、以及复述旁边控件的说明句。

- 2026-08-24: 管理面板落地 v8「毛玻璃控制台」视觉方向,「视觉规范」一节从待实施转为现行。令牌层重写:`--v8-*` 原始令牌是唯一颜色事实来源,再把 Radix 真正被组件消费的档位(灰阶、accent、green/amber/red、focus、radius、font-size、font-weight、shadow)拉到这些值上,组件不用逐个改样式;`PanelTheme` 换成 blue accent、medium radius、100% scaling。左侧栏改双层毛玻璃顶栏加 underline 导航,窄屏换底部 Tab 栏(前四个有权限的页面加一个「我的」);新增 `/` 总览页与全局 ⌘K 命令面板。主从选中态从深色实底反白改成蓝色 tint 底加 3px 蓝左条,左条走伪元素不占盒模型;主按钮去掉 `highContrast`——它会把 accent 推到 12 档,主按钮会从蓝变回近黑;字号阶梯从六档扩到十一档。九个页面与五个共享组件全部按设计稿重做,数据流、queryKey、状态机、权限判断与文案含义未变,`aria` 属性从 140 处增至 233 处。

- 2026-08-24: 定稿视觉规范 v6（GitHub 信息架构 × Apple 材质），新增「视觉规范 v6」一节记录 token、结构与组件映射；落地前现行选中态 / StatusBadge / 近黑主色条目继续生效。设计稿经 v1–v6 六轮迭代，历史版本在同一 Artifact 的版本记录中。

- 2026-08-24: 修复 Radix Themes 未分层样式覆盖 Tailwind 响应式显隐。样式入口声明 `theme < base < radix < components < utilities` 并把 Radix 样式导入 `radix` layer；Card、Button、Table 上的 `hidden` 与断点 display utility 恢复预期。模型服务返回列表链接补精确路由匹配，详情地址不再误标当前。

- 2026-08-24: 完成 Radix 迁移后的产品组件与页面结构收口。主从列表统一为 `MasterListItem`;日期范围、可编辑 model id 与空态分别收进 `DateRangePicker`、`EditableModelCombobox`、`EmptyState`;受控浮层通过 `useDialogReturnFocus` 恢复真实触发点。页面按路由分块，仓库与模型服务在 `lg` 起使用双栏和两侧局部滚动，640–1023px 保持列表／详情单层切换。部署实例已用 ego-browser 完成 2056px、768px 与 390px 端到端验收。

- 2026-08-24: 修复 Themes `IconButton` 自身定位规则覆盖 utility 定位造成的弹窗关闭按钮错位。五处弹窗统一由外层容器定位右上角，IconButton 只负责按钮外观与触控尺寸。

- 2026-08-24: 路由型模型服务配置弹窗补齐返回上下文,取消、关闭与丢弃后恢复 provider、Tab、服务列表及主内容滚动位置；新建用户、角色与自定义 provider 改名弹窗关闭后清空草稿和提交状态。

- 2026-08-24: `ModelComposer` 模型行使用 Themes Checkbox 作为唯一选择控件,整行可点并保留浅色选中反馈；面板默认入口调整为评审记录,无对应权限时进入下一个可见页。同步清理迁移完成后失真的暗色、依赖与 shadcn 说明。

- 2026-08-24: 清理 Radix 迁移后的零引用依赖：移除 `class-variance-authority` 与 `tw-animate-css`，删除已无调用方的动画导入和暗色变体守卫；保留 `cmdk`、`react-day-picker` 与 `radix-ui` 的专用行为层。

- 2026-08-24: 模型服务页完成浮层与导航迁移。重新验证统一使用 `EditableModelCombobox` 保留 cmdk 搜索和手填;详情稳定地址改用 Themes `TabNav`,发现差异与组合引用改用 Collapsible；旧 Popover wrapper 删除,关闭浮层与弹窗不改当前 provider 和 Tab。

- 2026-08-24: 处置率页完成 Radix 页面级迁移。日期范围改用受控 `DateRangePicker`,双月区间行为保留在其内部 Calendar；移动端模型矩阵改用 Collapsible,桌面 Themes `Table`、统计口径与窄屏布局保持不变。

- 2026-08-24: 审查策略页的批次上限改用 Radix Collapsible，默认折叠并保留帮助提示、键盘操作、独立保存与版本冲突恢复。

- 2026-08-24: 评审记录页完成 Radix 页面级迁移。结论筛选使用 Themes `SegmentedControl`,桌面记录表使用 Themes `Table`,模型失败原因使用 Collapsible；筛选范围、日期分组、无限加载、重跑权限和窄屏记录布局保持不变。

- 2026-08-24: Dialog 组件族迁移到 Radix Themes。新建、注册、迁移和三步模型服务配置直接使用 Themes `Dialog`;删除、密码重置、丢弃与离开确认使用 `AlertDialog`;长引用清单与三步内容在弹窗内部滚动,关闭后保留底层列表、provider 与 Tab;旧 shadcn Dialog wrapper 删除。

- 2026-08-24: 统计表格迁移到 Radix Themes。统计矩阵直接使用 `Table`，保留横向局部滚动、粘性模型列、语义 caption、数值布局和移动端折叠展示；旧 shadcn Table wrapper 删除。

- 2026-08-24: 原生表单选择控件迁移到 Radix Themes。访问控制的角色分配改用 `Select`,权限矩阵与模型服务的补录确认、批量选择改用 `Checkbox`,批量全选补齐 indeterminate 状态；允许搜索和手填的 model id 继续保留 datalist。

- 2026-08-24: Skeleton 组件族迁移到 Radix Themes。全部读取占位块直接使用官方 `Skeleton` 并保留原有尺寸与布局；旧 shadcn Skeleton wrapper 与页面级 Skeleton 覆盖删除。

- 2026-08-24: Card 组件族迁移到 Radix Themes。独立任务卡直接使用 Themes `Card` 的 size 与 surface，表格、模型服务和模型组合的局部滚动区域通过紧凑 Card 保留全宽内容；审查配置与 Hook 配置的警告改用 Themes `Callout`，旧 shadcn Card wrapper 删除。

- 2026-08-24: Badge/StatusBadge 组件族迁移到 Radix Themes。来源、身份和类别直接使用官方 Badge；Review Run、Hook、模型服务、模型凭据、模型目录和模型可用性统一使用四态 StatusBadge 并保留文字与状态图标。provider 深色选中行使用对应状态色的 solid Badge,旧 shadcn Badge wrapper 与页面状态色配方删除。

- 2026-08-24: TextField/Label 组件族迁移到 Radix Themes。认证、访问控制、仓库重跑、审查策略、模型服务与模型组合共 25 个文本输入改用 `TextField.Root`;字段标签改用 `Text as="label"`,搜索图标改用 `TextField.Slot`,保留 datalist、受控值、表单属性、等宽字段、组合按钮连接和窄屏触控尺寸,旧 Input/Label wrapper 删除。

- 2026-08-24: Button/IconButton 组件族迁移到 Radix Themes。业务主操作、次要动作和破坏性动作改用官方 variant、color、size 与 highContrast prop；纯图标动作使用 IconButton 并保留可访问名称；Calendar 移除 `buttonVariants` 依赖，旧 shadcn Button wrapper 删除。

- 2026-08-24: 全部业务图标从 Lucide 迁移到 Radix Icons。搜索、关闭、展开、状态、刷新、登出、删除和新增动作各固定一个 Radix 图标；保留状态文字、可访问名称、加载旋转和产品 SVG，移除 `lucide-react` 依赖。

- 2026-08-24: 完成 Radix Themes 第一批基础接入。React 根固定为亮色 gray、solid panel、small radius 与 95% scaling；Theme token 映射到迁移期 Tailwind 语义名,现有 Dialog 与 Popover Portal 显式继承 Theme。HelpTooltip 改用 Themes Tooltip、IconButton 与 Radix Icons。

- 2026-08-24: 选定“发布门禁看板”为 Radix Themes 迁移的视觉方向。`MasterListItem` 在模型服务、仓库与审查策略中统一使用深色实底选中态；模型行、多选与命令项继续使用浅色编辑选择。端到端验收固定使用部署实例与 ego-browser。本条取代同日“审查策略 Provider 保持浅色”的旧视觉限制。

- 2026-08-24: 全面核对选中态。主导航、主从列表、tab、筛选器、模型组合、命令菜单、日期区间与批量勾选按各自语义保持不同层级；修复模型服务与仓库选中行 hover 后底色变浅、反白文字失去对比度，主导航激活文字仍落在次要色，以及子路由同时把“概览”和当前 tab 标成选中的问题。弹窗返回时的 provider/tab 保留写成全局约束。

- 2026-08-24: 修正选中态改动范围。审查策略的 `ModelComposer` 恢复原有浅色选中样式；实心主色选中态只用于模型服务 provider 列表与仓库列表。模型服务配置弹窗关闭时同时恢复原 provider 与维护页 tab。

- 2026-08-24: 收敛模型服务状态展示。正常服务不再重复显示“可以运行”，模型列表隐藏重复的“可用”徽标，只保留停用与异常提示；模型组合编辑器为当前 provider 和已选模型增加明确高亮。配置弹窗从服务详情打开时，取消或丢弃会返回原服务，不再回到第一项。

- 2026-08-24: 模型服务模型页改为可筛选的两栏清单。模型清单在独立可视区域内滚动，模型名称、标识、来源与可用性合并到左侧，运行规格与来源放到右侧；完整发现差异仍按需展开，页面不再随模型数量持续拉长。服务侧栏的 provider 名称改为单行截断，窄屏不再被状态徽标挤断。

- 2026-08-24: 继续收敛标题层级。仓库统计去掉无信息量的“累计”标题,审查策略把批次上限作为唯一展开标题,模型列表改为数量栏,只读状态改用简短提示语。

- 2026-08-24: 统一业务页面的产品术语与说明层级。登录、改密、首次配置、仓库、评审记录、处置率和审查策略页面移除口语化文案；重复说明改为信息图标悬浮提示，图标使用 Lucide。

- 2026-08-24: 精简访问控制页文案与权限矩阵。统一使用“新建用户”“删除用户”“未分配角色”“授予权限”等产品术语,隐藏权限内部标识,把管理员和权限说明收进可键盘访问的 HelpTooltip,交互图标统一使用 Lucide。

- 2026-08-24: 模型页桌面表格收为模型、运行规格、状态三列；窄屏同步使用单块运行规格。模型显示名、标识和来源合并展示，运行字段来源去重成一条说明；发现值仅在与运行规格不同时渐进展开。
- 2026-08-24: 维护页的凭据重新验证把原生 `datalist` 换成可编辑组合框。自动发现模型可展开、搜索、键盘选择，点选只写入裸 model id；目录外 model id 继续可手填。
- 2026-08-24: 模型页为自动发现事实和实际运行的每个字段显示服务端来源：服务接口、Pi 目录、服务目标、运行基线或未知；前端不再把这些来源压成“可信目录”。
- 2026-08-21: 统一业务页布局与窄屏可用性。仓库详情、评审记录、处置率、审查策略和访问控制复用 `PageBody`;评审记录在 `xl` 以下改按日期分组的信息卡,失败原因可展开全文;模型服务主从布局在 `xl` 启用,更窄时改上下布局,模型事实改逐项卡片;处置率矩阵在 `lg` 以下改逐模型展开。窄屏导航明确提示横向滑动,按钮、输入、命令项与权限控件的触控目标统一到至少 44px;横向数据表限制在各自滚动容器内。长标识改为换行或提供完整标题,清除权限矩阵的一次性字号与原生下拉视觉漂移。
- 2026-08-20: 落地 issue #149。冲突自定义服务的维护页将旧“用新名称重建”替换为原子迁移对话框;成功后刷新统一模型服务投影并导航到新 provider 的维护地址,缺失引用按现有位置组件完整展开。普通服务仍只有候选修改与删除。
- 2026-08-20: 落地 issue #150。所有业务页共用三步首次配置检查单,实例启用后隐藏;当前步骤入口按有效写权限显示。成功写请求统一刷新状态,审查配置未就绪时仓库页禁用注册并给出处理入口。
- 2026-08-20: 落地 issue #144 的有效权限与只读配置面。角色矩阵显示三类 write 包含对应 read;仓库、评审记录、模型服务与审查策略按写权限移除写控件,保留静态值。`review:read` 不再自行显示重跑控件,仓库页把记录读取与手动重跑分别门禁。

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

  **撞名停用的自定义 provider 在面板上说得清**(issue #94):`CatalogProvider` 多读一位 `conflict`(服务端给,与 `configured` / `verifiable` / `custom` 并列),判据是 `custom && conflict`——这一档目录里那条记录是**内置那一家**(撞名的不落进派生的模型配置,不然 Pi 会拿自定义那个端点覆盖它),所以 `name` 与 `models` 都是内置的,而 `custom` 仍为真是因为库里那条登记还在、面板要删得掉它。左栏那一行标一句红字「名字冲突,已停用」(220px 宽,两条出路塞不下),点进去右栏头一行下面一条红色横幅写全:撞的是内置的哪一家、这家的模型现在一个都选不了、两条出路（原子改名或删除这一家）、以及已经在组合里的那些下一次审查会各留一条写明名字冲突的失败记录。issue #149 已把恢复入口改为原子改名;删除入口继续保留。这一档下模型按钮禁用、手填框仍只看 `configured`,判据见模块规范。
- 2026-08-18: 落地 issue #91。仓库详情页的模型覆盖换用同一块两栏面板(`src/repos.tsx`):`ReviewersModal` 换成 `ReviewersEditor`,里面挂的就是全局设置页那个 `ModelComposer`,两处从此没有第二份实现。**编辑态从对话框改成详情列里的一段**,判据两条:面板固定 460px 高,而 `ui/dialog.tsx` 的对话框只给宽度档位(`sm:max-w-sm` 与「加一家 provider」那张的 `sm:max-w-md`)、没有最大高度与滚动,矮屏上底部的手填框与保存按钮会落到视口外面点不到;面板里「+ 加一家 provider」本身就是一个对话框,套进覆盖对话框就是对话框叠对话框。放宽对话框等于为这一处新造一个宽度档位,而详情列本来就有 900px 可用,编辑态里把那一格并成单栏就够了。**面板外面不套 `<form>`**:原来整个编辑框包在 `<form onSubmit>` 里,直接塞面板会造成 form 嵌套,而且在右栏填一个 model id 会顺手提交覆盖(#90 交接点的那条真缺陷);编辑态里除了保存与取消再没有别的字段,所以整张表单去掉,保存改成按钮的 `onClick`。两态开关的语义一字未改:切自定义以当前生效组合为初值(跟随态即全局组合),切跟随全局仍是一个动作直接 `PUT {"reviewers": null}`,自定义态下选空时保存仍禁用并写清「点取消再点跟随全局」这条出路。覆盖的读写端点入参一字未改,仍是 `PUT /repos/<id>/reviewers` 加模型组合数组。`ModelPicker` 至此零调用方,组件删掉;`components/model-picker.tsx` 剩下的目录查询、目录类型与模型标识那两个函数改名成 `src/model-catalog.ts`(不再是 picker,也不再带 JSX,与 `api.ts` 同级),四个 import 跟着改。在仓库页加自定义 provider、手填模型行与全局设置页同一套端点、同一批查询失效(`catalog` / `model-rows` / `custom-providers` / `credentials`),因为它们本来就都在面板里。后端一行没改,`test/panel-*.test.ts` 一个字没动。视觉与交互确认走部署实例。
- 2026-08-20: 落地 issue #141 clean cutover。删除旧 catalog / credential / model-row / custom-provider 客户端与写入口;`/credentials` 仅按已批准书签路径承载模型服务页。模型服务页与唯一 `ModelComposer` 共用 `/model-services` 投影,组合编辑器退回纯选择职责并保留失效选择的原因与处理入口。
- 2026-08-20: 全面精修管理面板现有页面。应用壳补齐桌面账号区与窄屏横向导航;登录、改密、仓库、评审记录、处置率、模型服务、全局设置和访问控制统一了页头、留白、表格、表单、状态反馈与空态。评审记录按日期分隔并压缩失败原因,长表格只在自身容器横向滚动;仓库主从区、模型服务详情与 `ModelComposer` 在窄屏改为纵向结构。业务 API、权限、状态判据、统计口径和提交语义保持不变。部署实例已按桌面与窄屏两档走查全部页面。
- 2026-08-20: 落地 issue #145。导航与页头统一为「审查策略」并保留 `/settings`;模型组合和批次上限按各自版本独立保存,409 只恢复冲突项。高级参数默认折叠,批次上限显示默认/自定义来源并提供恢复默认。模型服务引用阻塞可携 provider 定位到 `ModelComposer`;未传 provider 时优先显示已选模型所属服务。
- 2026-08-20: 落地 issue #146。模型服务详情拆成概览、维护、模型三条稳定路由;概览展示服务端运行能力、次级目录提醒和可展开引用位置。维护与模型写入口分区,只读会话只见静态信息和导航;空且未引用的内置 provider 只留搜索入口。对话框开关不再复用详情维护组件的身份,维护区保持单份。
- 2026-08-20: 落地 issue #147。模型服务页只留一个添加入口;内置 provider 配置拆为来源、模型发现、真实推理三条稳定地址,候选与凭据只存流程页内存。未保存离开有应用确认和浏览器关闭警告,长操作显示阶段并锁导航;模型组合保持原值。新建成功后的入口后续统一为对应服务详情。自定义候选沿用同一入口与离开保护。
- 2026-08-20: 落地 issue #148。自定义 provider 创建与修改从对话框迁入同一三步配置页,模型发现不再要求预填验证模型;发现失败或目录缺项可手填 model id 完成真实推理。协议显示 Chat Completions 与 Responses 的实际路径;内置和自定义维护都走稳定配置地址,共享离开与长操作保护。
- 2026-08-20: 部署验收补齐模型服务最终提交的 request id 展示。带引用位置的错误解析保留服务端 `requestId`,页面可直接用同一编号关联服务日志。
- 2026-08-20: 完成 issue #151 的部署面板验收。桌面与 390px 窄屏走通模型服务、三步候选、审查策略和访问控制;维护页往返后每个维护区仍只渲染一份。空模型组合无法保存,陈旧写只恢复冲突项,三类写权限在矩阵中明确包含对应读权限,`review:rerun` 保持独立。
- 2026-08-24: 模型服务三步配置改为受控弹窗，保留稳定路由、离开保护和步骤提示；凭据验证模型改用自然换行。模型页增加筛选结果批量启用/停用，停用模型在列表中保留状态但从审查策略候选中隐藏。
