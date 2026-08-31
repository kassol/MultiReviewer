---
name: MultiReviewer
description: "以 Radix Themes 落地毛玻璃控制台方向的 MultiReviewer 审查运维面板。"
---

# MultiReviewer 管理面板设计系统

> “毛玻璃控制台”（v8）已经落地为当前实现基准。Theme 固定为亮色 blue、solid panel、medium radius 与 100% scaling；颜色、字号、圆角、阴影的唯一事实来源是 `src/styles.css` 里的 `--v8-*` 令牌。第 15 节用于部署交付验收。

## 方向契约

**THESIS** 面板是一台常驻的审查控制台：顶部一直告诉你身在哪一页、哪里有异常，下面一直是当前这件事的完整信息。信息架构与工程语义取 GitHub，材质与 finish 取 Apple。

**OWN-WORLD** 灰底浮白卡：页面底 `--v8-bg` #f5f6f8，卡面 `--v8-surface` 纯白，卡靠 1px 发丝边 `--v8-border-card` rgba(0,0,0,0.055) 加漫射阴影 `--v8-shadow-card` `0 1px 6px rgba(0,0,0,0.04)` 浮起来。顶栏、移动端 Tab 栏、命令面板与运行详情面板是半透明白 + `backdrop-filter` 毛玻璃，层级越高模糊半径越大、底色越不透明。Apple 蓝 `--v8-accent` #0071e3 是唯一主色，动作、选中、链接、图表共用它。绿 `--v8-success` #177031、琥珀 `--v8-warning-icon` #bf8700、红 `--v8-danger` #cf222e 只承载状态，一律以 soft tint 胶囊或 octicon 式图标出现，不用高饱和大色块。

**STORY** 打开面板先落在评审记录：左栏是这个账号可见的仓库，右栏是所选仓库的审查阶段列表。点一行进阶段页，读这个阶段还剩什么没处置，再下钻到某条 Finding 的 diff 或某一轮的审查轨迹。管一个仓库不离开这一页：注册在左栏顶部，配置与移除在每行的行操作里，发起范围审查与重跑 PR 在右栏头部。配置类工作（模型服务、审查策略、访问控制）在各自的页面上。⌘K 在任何页面任何焦点位置都能唤起，直接跳到目标页。

**FIRST VIEWPORT** 桌面端顶部是双层毛玻璃顶栏：上层品牌方块、面包屑、300px 宽 ⌘K 搜索入口与头像菜单；下层 underline 导航，当前项字重 650 加 3px 蓝色圆头指示条。顶栏之下整屏都是内容：首页是 264px 仓库侧栏加长列表卡，其余列表页是工具行加长列表卡，主从页是 264px 侧栏加详情。390px 下导航层收起，改成底部毛玻璃 Tab 栏；顶栏只留一行（品牌 + 搜索图标 + 头像），页面主体不变。

**FORM** 毛玻璃控制台，v8。设计稿是 12 块画板（桌面 1440×900 十一块、移动 390×844 一块），覆盖总览、运行与详情、⌘K、移动端总览、仓库、处置率、模型服务、添加模型服务向导、审查策略、访问控制、登录、修改密码。画板之间有 20 处自相矛盾，逐条定裁记在第 2.4 节。这里的“控制台”表示运行观察与配置管理；MultiReviewer 继续只发布 review 评论，不调用 check/status，也不阻断 PR 合并。

**FINISH** 未经评审、未写进文档的改动不算完成。本方向以三件事收尾：令牌落进 `src/styles.css`、本文件与 `web/AGENTS.md` 描述一致、在部署实例用 ego-browser 完成三个宽度的端到端验收。

## 1. 产品定位

MultiReviewer 管理面板服务两类用户：

- 运维人员：部署、配置模型服务、管理凭据、核对 Hook、处理故障。
- 研发负责人：查看 Review Run、Finding、处置率与审查策略。

界面应像可靠的内部控制台：信息密度高、结构稳定、状态清楚、操作可预期。视觉参考 GitHub 的信息架构与 Apple 的材质，避免营销页式装饰。

面板默认进入评审记录,它就是首页,登录即可进。首屏左栏是这个账号可见的仓库,右栏是所选仓库的审查阶段列表;看得到多少由仓库分配决定。

## 2. 技术分层

### 2.1 组件职责

- `@radix-ui/themes`：唯一通用视觉系统，负责全局 Theme、常规组件与默认交互状态。它的令牌在 `src/styles.css` 里被拉到 v8 的值上，所以组件不用逐个改样式就跟着走。
- Radix Primitives：只补齐 Themes 未覆盖的行为组件和无障碍语义。
- `@radix-ui/react-icons`：唯一业务图标库。
- 产品组件：表达 MultiReviewer 的领域结构与 v8 专有表面，例如 MasterListItem、StatusBadge、CommandPalette、PageHeader、PageBody、ModelComposer、SetupChecklist、DateRangePicker、EditableModelCombobox 与 EmptyState。
- Tailwind CSS：页面布局、容器约束、复杂响应式网格，以及 Themes 组件覆盖不到的产品专有表面（顶栏、移动端 Tab 栏、命令面板壳、运行详情面板壳、主从选中态）。这些表面只读 `@theme inline` 里映射过来的 v8 令牌，不写字面色值。

产品页面只组合组件。颜色、字号、间距、圆角、阴影与交互状态集中在令牌、Theme 和共享产品组件中定义。

### 2.2 Theme 根配置

```tsx
<Theme appearance="light" accentColor="blue" grayColor="gray"
  panelBackground="solid" radius="medium" scaling="100%">
  <App />
</Theme>
```

四个 prop 的取值由 `src/components/panel-theme.tsx` 固定，不开放给调用方：

| prop | 取值 | 为什么是这个值 |
| --- | --- | --- |
| `accentColor` | `blue` | 让 Radix 走 accent 那一族变量，具体色值再由 `styles.css` 覆写成 `--v8-accent` #0071e3。选 blue 是因为它的中性搭配灰最接近这套设计。 |
| `radius` | `medium` | 只为拿到 `--radius-thumb: 9999px`（开关与滑块是圆的）。六档圆角终值直接覆写，不靠 radius-factor 缩放——v8 的档位不是等比的（9 → 12 → 14 → 16 → 18）。 |
| `scaling` | `100%` | 避免二次缩放。字号已经按 13.5px 正文逐档定死，再乘一次会让所有档位落到非整数上。 |
| `panelBackground` | `solid` | 卡片是纯白实底。毛玻璃只属于顶栏、Tab 栏、抽屉与命令面板，那四处各自在组件里写材质。 |

当前只提供浅色模式（issue #46）。不加主题上下文、本地存储、防闪脚本或暗色变体；要加暗色那天，在 `styles.css` 里补一段媒体块重定义 `--v8-*` 即可，现在不预留任何东西。

### 2.3 毛玻璃控制台的结构规则

- 顶栏取代左侧栏。左侧栏在 1440px 下要吃掉 200px 宽，而这套设计的主从页自己就有 264px 侧栏，两层侧栏并排会把详情区压到不可用。顶栏只占高度，横向宽度全部留给内容。
- 顶栏分两层：上层是身份与全局动作（品牌、面包屑、⌘K、头像），下层是 underline 导航。分开是因为导航项随权限增减，把它和品牌挤在一行会让窄屏下的品牌位置跟着跳。
- 状态、主信息、证据和动作沿稳定列轨排列。长列表用连续行列，行首是 16px 状态图标，行尾是状态徽章与 chevron。
- 失败、需注意和正常使用同一行结构。状态色、文字和图标共同表达结果，布局不因状态变化而跳动。
- 主从列表当前项在模型服务、仓库和 `ModelComposer` 中复用同一个 MasterListItem，选中态是蓝 tint 底加 3px 蓝左条，文字不反白。
- 页头只保留当前任务、必要范围和一个主要动作，随内容滚动、不粘顶：顶栏已经常驻显示当前页名，再粘一条页头就是两层重复页名压掉垂直空间。长列表页把主动作再放一份在工具行里。
- 控制台语法服务于运行观察与配置管理，不引入工业警示条、拟物仪表或阻断合并的暗示。

### 2.4 设计稿定裁与工程化调整

设计稿的 12 块画板之间有 20 处自相矛盾，逐条定裁如下。这些是落地基准，改代码前先读这张表，不要回到画板去找“原始值”。

| 矛盾 | 定裁 | 理由 |
| --- | --- | --- |
| 搜索框图标 6 页缺 1 页有 | 一律带图标 | 无图标的搜索框在毛玻璃底上认不出是可点的 |
| 通知铃铛只有总览页有 | 不做 | 没有通知后端，做出来是死按钮 |
| 内容区 1240 / 1080 两派 | 复用 `PageBody` 的 `wide` / `form` 两档 | 列表页宽、表单页窄本来就是两类页面 |
| 内容区上边距 26/24、区块 gap 18/16 | 统一 24 + 16 | 多数派 |
| 遮罩 0.20 / 0.24 | `--v8-scrim` rgba(0,0,0,0.24) | 同一语义 |
| 选中行 3px 左条的位移补偿只做了 3/4 页 | 左条改 `before` 伪元素，一律不占盒模型 | 补偿漏一处就错位；伪元素让调用方无从漏 |
| 分段控件两套尺寸 | 统一评审记录页那一版 | 同一控件不留两种规格 |
| 输入描边 0.10 / 0.12 | `--v8-border-input` rgba(0,0,0,0.1) | 登录页与业务页没有区分的理由 |
| 未选控件描边 #c7c7cc / #d2d2d7 | `--v8-text-faint` #c7c7cc | 同为“未选中控件描边” |
| 空值「—」三种灰 | `--v8-text-disabled` #a1a1a6 | 三处语义相同 |
| 次级面 0.03 / 0.04 / 0.05 | `--v8-surface-sunken` rgba(118,118,128,0.05) | 三档语义完全重叠 |
| 行分隔 0.04 / 0.05 | `--v8-border-line` rgba(0,0,0,0.05) | 同上 |
| 顶栏占位图 92px vs 实算 86px | 以真实组件为准 | 占位图是背景轮廓，不是规格 |
| 卡片圆角 12 / 14 / 16 | 保留三档：`--v8-radius-card` / `--v8-radius-card-mobile` / `--v8-radius-panel` | 桌面卡、移动卡、登录卡是三种容器尺寸 |
| Display 字体栈缺回退 | 补 `Microsoft YaHei` 与 `system-ui` | 否则 Windows 简体环境下标题掉到与正文不同的字体 |
| 运行行的模型 chip 组时有时无 | 按真实数据有无渲染 | 画板是静态样例 |
| 面包屑层级不一 | 按真实路由层级 | 同上 |
| `a:hover` 规则在画板里无处生效 | 实现里链接就是 `<a>`，规则生效 | 画板用 `span` 是画板的事 |
| 移动 5 项 vs 桌面 7 项无映射 | 前 4 个有权限项 + 「我的」收纳其余 | 导航项随权限增减，固定五项会让低权限用户看到空位、高权限用户丢入口 |
| 警告图标 #bf8700、文字 #8f6000 | 保留双色对 | 亮琥珀当文字在 tint 底上过不了 AA |

设计稿没画、但落地必须决定的：

- **移动端保留单行顶栏**（品牌 + 搜索 + 头像）。设计稿把这些放进每页的大标题行，那样每个页面都要重复实现一次头像与搜索。
- **页头不再 sticky**。理由见 2.3。
- **顶栏导航不用 Radix `TabNav`**。`TabNav` 的激活指示条是 2px 方头且铺满整个 trigger，这里要 3px 圆头、左右各内缩 12px；覆写它得深度改 Radix 内部 DOM，比自绘一个 `span` 代价大，也违反“不深度覆盖 Radix 内部 DOM”。模型服务详情页内部的分层导航仍然直接用 `TabNav`。
- **导航上没有计数徽章**。它此前只做仓库数，而仓库项随首页收口离开了导航；评审记录按 `offset` 翻页，没有总数端点，不拿第一页条数冒充总数。导航右侧只剩模型服务那一个告警点，取 `/setup-status` 的 `hasRunnableModelService`。
- **品牌图形保留现有 `Mark`**（三条错位短线，与 favicon 同图形），只套用设计稿的容器材质：26px 方块、`--v8-radius-mark` 8px、`--v8-mark-gradient` 深灰渐变、`--v8-shadow-mark`。设计稿画的勾是另一个图形，改它会让 favicon 对不上。
- **`ui/command.tsx` 与 `ui/calendar.tsx` 不改**：它们已经全部走 Radix 变量，令牌层一换就跟着走。

## 3. 设计原则

1. 健康状态优先：异常、阻塞与下一步操作应在同一视区内被识别。
2. 一种语义一种样式：当前页面、当前 Tab、主从当前项、编辑中的选择各用固定表达，见第 8 节。
3. 主色一支笔：动作、选中、链接、图表统一 `--v8-accent`；红、绿、琥珀只承载错误、成功、警告。
4. 层级来自材质与排版：卡片靠发丝边加漫射阴影浮起，浮层靠模糊半径分深度，不靠加深阴影或堆叠边框。
5. 默认状态完整：每个交互组件同时定义 hover、focus、active、selected、disabled、loading 与 invalid。
6. 内容决定宽度：长标识可截断并查看全文，页面不得产生水平滚动。
7. 操作就近：主要动作靠近作用对象，破坏性动作需要二次确认。
8. 响应式保留任务：窄屏调整布局，不删除关键状态或操作。

## 4. 颜色系统

所有色值只在 `src/styles.css` 的 `--v8-*` 原始令牌里出现一次。`.radix-themes` 块把 Radix 真正被组件消费的档位拉到这些值上，`@theme inline` 再把同一批令牌接进 Tailwind。产品代码引用令牌名或 Tailwind 类，不写字面色值，也不引用 Radix 色阶编号。

### 4.1 表面、文字与边框

| 令牌 | 值 | Tailwind | 用途 |
| --- | --- | --- | --- |
| `--v8-bg` | #f5f6f8 | `bg-background` | 页面底。比卡面暗一档，是“卡片浮在灰底上”的基础 |
| `--v8-surface` | #ffffff | `bg-surface` | 卡片、模态、输入框底 |
| `--v8-surface-sunken` | rgba(118,118,128,0.05) | `bg-sunken` | 表头、合计行、分区底、行 hover |
| `--v8-fill` | rgba(118,118,128,0.12) | `bg-fill` | iOS systemFill：次要按钮、计数徽章、进度条轨道、键帽、搜索入口底 |
| `--v8-text` | #1d1d1f | `text-text` | 标题、正文、激活导航项 |
| `--v8-text-secondary` | #6e6e73 | `text-text-secondary` | 读得到的说明：未激活导航项、表单 label、面板正文 |
| `--v8-text-muted` | #86868b | `text-text-muted` | 扫得到的元信息：时间、计数、表头、卡片副标题 |
| `--v8-text-disabled` | #a1a1a6 | `text-text-disabled` | 已停用条目、划线的已处置项、占位符、⌘K 提示、KPI 分母 |
| `--v8-text-faint` | #c7c7cc | `text-text-faint` | chevron、未选控件描边、面包屑分隔符 |
| `--v8-border-card` | rgba(0,0,0,0.055) | `border-card-line` | 卡片描边。比行分隔重一点点，让卡边界在同色系里仍站得住 |
| `--v8-border-line` | rgba(0,0,0,0.05) | `border-line` | 列表行分隔、表格行线、卡内区块线 |
| `--v8-border-chrome` | rgba(0,0,0,0.07) | `border-chrome-line` | 顶栏底边、Tab 栏顶边、命令面板内部横线 |
| `--v8-border-overlay` | rgba(0,0,0,0.06) | `border-overlay-line` | 抽屉与模态的头尾线、详情内嵌卡描边 |
| `--v8-border-input` | rgba(0,0,0,0.1) | `border-input` | 输入框与描边型控件。比分隔线重一档，让人看出这里能点进去打字 |
| `--v8-neutral-dot` | #d2d2d7 | `bg-neutral-dot` | 已停用状态点、未处置项的空心圆描边 |

Tailwind preflight 把边框色置成 `currentColor`，`styles.css` 的 base 层统一回落到 `--v8-border-line`。浏览器自画的几处也接管：选区底是 accent 18% 的 `color-mix`（只染底不改字色，改字色会让选中的红字警告读不出来），滚动条是 `--v8-text` 18% 的细轨，输入光标是 `--v8-accent`。

### 4.2 Accent

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--v8-accent` | #0071e3 | 主按钮底、导航指示条、链接、进度条填充、Checkbox 选中、KPI 环、选中行左条、焦点环 |
| `--v8-accent-hover` | #0077ed | 链接与主按钮 hover（Radix `--accent-10`） |
| `--v8-accent-tint` | rgba(0,113,227,0.07) | 主从列表选中面、激活导航项的计数徽章 |
| `--v8-accent-tint-strong` | rgba(0,113,227,0.09) | commit hash chip、进行中状态底 |
| `--v8-accent-track` | rgba(0,113,227,0.14) | KPI 环形轨道 |
| `--v8-accent-focus` | rgba(0,113,227,0.12) | 焦点环外圈的填充色 |
| `--v8-accent-shadow` | rgba(0,113,227,0.35) | 主按钮投影的色 |
| `--v8-accent-gradient-from` | #6e9bf0 | 头像渐变起点，与 `--v8-accent` 组成 `--v8-avatar-gradient` |

主色从上一版的近黑换成蓝：近黑主色和深色实底选中态在同一屏里争同一种“最重”的表达，用户分不出哪个是“可点的动作”、哪个是“我当前在这里”。蓝把动作与位置收成一支笔，近黑退回纯文字色。

设计稿里有四档 accent tint（0.05 / 0.07 / 0.09 / 0.10），语义高度重叠，收敛成两档：选中面 0.07、chip 与徽章面 0.09。

### 4.3 状态色

| 状态 | 图标 / 实底 | 文字 | tint 底 | 使用位置 |
| --- | --- | --- | --- | --- |
| 成功 | `--v8-success-icon` #1a7f37 | `--v8-success` #177031 | `--v8-success-tint` rgba(26,127,55,0.1) | 已验证、已完成、正常、可运行 |
| 警告 | `--v8-warning-icon` #bf8700 | `--v8-warning` #8f6000 | `--v8-warning-tint` rgba(191,135,0,0.1) | 信息缺失、需要关注、降级运行 |
| 错误 | `--v8-danger` #cf222e | 同左 | `--v8-danger-tint` rgba(207,34,46,0.09) | 失败、不可运行、删除、无效输入 |
| 信息 | `--v8-text-muted` #86868b | 同左 | `--v8-fill` | 中性提示、未知、尚未开始 |

状态图标沿用较亮原色保持辨识度，成功与警告文字分别压到 #177031 与 #8f6000，确保在各自 tint 底上通过 AA；危险的图标与文字同色。

Radix 自带的绿 / 琥珀 / 红比这套设计艳一档，所以 `.radix-themes` 直接覆写组件真正读的那几档（3 / 9 / 10 / 11 与对应 alpha 档），StatusBadge、Callout、`color="red"` 的按钮就都跟着走，不用逐个组件改样式。

StatusBadge 是运行状态的唯一产品级出口，暴露 `neutral`、`running`、`success`、`warning`、`error` 五种语义，固定 `variant="soft"` 与 `radius="full"`。`running` 走主色蓝而不占用三档语义色——「还没有结论」既不是好也不是坏；一轮审查在结束前必须落在这一档，否则它会掉进「已处置数 / 总数」的判断，因为此时一条可处置项都还没有而显示成「无可处置项」，看上去像跑完了，并且**不开 `highContrast`**——三族语义色的目标值就落在各自的 11 档上，highContrast 会把文字推到 12 档，那是 Radix 的默认深色，不是这套设计定的色。选中行现在是浅色 tint，也不再需要 solid 变体去压深色底。来源、身份和类别等中性标签直接使用 Themes Badge，不进 StatusBadge。

状态同时使用文字或图标表达，颜色不单独承担含义。正文与背景的对比度至少达到 WCAG AA 4.5:1。

### 4.4 材质、阴影与渐变

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--v8-chrome-bg` / `--v8-chrome-blur` | rgba(255,255,255,0.72) / blur(30px) | 双层顶栏 |
| `--v8-tabbar-bg` | rgba(255,255,255,0.78) | 移动端底部 Tab 栏（同样 blur(30px)） |
| `--v8-drawer-bg` / `--v8-drawer-blur` | rgba(255,255,255,0.94) / blur(40px) | 运行详情面板 |
| `--v8-palette-bg` / `--v8-palette-blur` | rgba(255,255,255,0.9) / blur(50px) | 命令面板 |
| `--v8-scrim` | rgba(0,0,0,0.24) | 全部浮层遮罩 |
| `--v8-shadow-card` | `0 1px 6px rgba(0,0,0,0.04)` | 卡片 |
| `--v8-shadow-control` | `0 1px 4px rgba(0,0,0,0.05)` | 描边型控件、详情内嵌卡 |
| `--v8-shadow-accent` | `0 1px 4px var(--v8-accent-shadow)` | 主按钮。同色系蓝阴影，不用中性灰 |
| `--v8-shadow-accent-strong` | `0 1px 4px rgba(0,113,227,0.4)` | 蓝色实底选中项（命令面板结果项） |
| `--v8-shadow-mark` | `0 1px 3px rgba(0,0,0,0.22)` | 品牌方块 |
| `--v8-shadow-overlay` | `0 24px 80px rgba(0,0,0,0.3)` | 运行详情面板 |
| `--v8-shadow-modal` | `0 30px 90px rgba(0,0,0,0.32)` | 模态 |
| `--v8-shadow-palette` | `0 30px 90px rgba(0,0,0,0.35), inset 0 0 0 0.5px rgba(255,255,255,0.6)` | 命令面板。唯一带 inset 高光边的浮层：它悬在最上层，一道内高光才把它和背后的毛玻璃分开 |
| `--v8-shadow-focus` | `0 0 0 3px var(--v8-accent-focus)` | 输入框焦点外圈 |
| `--v8-mark-gradient` | `linear-gradient(180deg, #3c3c41 0%, #1d1d1f 100%)` | 品牌方块 |
| `--v8-avatar-gradient` | `linear-gradient(180deg, #6e9bf0 0%, #0071e3 100%)` | 用户头像 |

深度只由模糊半径与底色不透明度表达：层级越高，模糊越大、底色越不透明。不靠加深阴影堆层级。

## 5. 排版

### 5.1 字体

三套字体栈，全部在 `styles.css` 里定义一次：

- `--v8-font-text`（Tailwind `font-sans`）：`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`。根容器与绝大多数文字用它。
- `--v8-font-display`（`font-display`）：同上但把 `SF Pro Text` 换成 `SF Pro Display`。只用在页标题与 KPI 数字上——SF Pro Display 的字腔在 25px 以上才比 Text 好看，这是唯一区分两套栈的尺寸线。设计稿的 Display 栈漏了 `Microsoft YaHei` 与 `system-ui`，这里补齐。
- `--v8-font-mono`（`font-mono`）：`ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace`。model id、commit SHA、Key 尾号、快捷键、endpoint 用它。

**等宽字体只包数字，不包中文。** `font-mono` 会把汉字撑成等宽格，「3 轮」因此读成断开的两块；写法是 `<span className="font-mono tabular-nums">{n}</span> 轮`。

数字一律等宽：`.tabular-nums`、`th`、`td` 在 base 层统一开 `font-variant-numeric: tabular-nums`。分数、百分比与计数会随刷新变化，不等宽的话每次跳一下。时间戳与 commit hash 不在此列——前者用比例字更好读，后者本来就走等宽字体。

全局开 `-webkit-font-smoothing: antialiased`：这套设计的字重靠 590 / 650 这类可变刻度分层，不开抗锯齿的话它们在非 Retina 屏上会糊成同一档。

### 5.2 字号

字号从上一版的六档扩到十一档。控制台密度靠小字撑，整套压在 11–29px，元信息、徽章、表头、正文、按钮各要一档才不互相顶。设计稿里 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 14.5 是八档 0.5px 步进，那是逐像素目视调优的结果；落到代码里收敛掉 12.5 与 14.5——屏幕上看不出差别，却会让每个页面各写各的。

| Tailwind | 值 | line-height | 唯一职责 |
| --- | --- | --- | --- |
| `text-xs` | 11px | 1.45 | commit hash chip、快捷键、模型 chip、优先级徽章 |
| `text-sm` | 11.5px | 1.45 | 计数徽章、表头、日期分组标题、卡片副标题 |
| `text-base` | 12px | 1.5 | 元数据行、状态徽章、KPI 标签、表格单元格 |
| `text-md` | 13px | 1.5 | 按钮、搜索入口、链接、Select |
| `text-lg` | 13.5px | 1.5 | **正文基准**：根容器与列表行主标题 |
| `text-xl` | 14px | 1.45 | 面包屑当前页、命令面板结果项、登录表单 |
| `text-2xl` | 16px | 1.4 | 卡片区块标题 |
| `text-3xl` | 18px | 1.35 | 抽屉与模态标题 |
| `text-4xl` | 21px | 1.25 | 登录页品牌标题、命令面板输入行 |
| `text-5xl` | 25px | 1.2 | 桌面页标题，一页一个 |
| `text-6xl` | 29px | 1.15 | KPI 主数字 |

`body` 的基准是 13.5px / 1.5。Radix 侧对应覆写 `--font-size-1` 到 `--font-size-9`（11.5 / 13 / 13.5 / 14 / 16 / 18 / 21 / 25 / 29），正文落在 `--font-size-3`、控件落 2、徽章落 1。13.5px 是这套设计的正文，不是 14——密度差一档，整页扫读的行数就差一屏。

**不写 `text-[13px]` 这类一次性值。** 唯一的例外是移动端底部 Tab 栏的 10px 标签，它低于阶梯下界。

### 5.3 字重

SF 的可变刻度里 590 与 650 是这套设计的两个主力，标准的 500 / 700 都偏了：500 压不住一行，700 在 13px 上糊成一团。

| Tailwind | 值 | 用途 |
| --- | --- | --- |
| `font-normal` | 400 | 正文 |
| `font-medium` | 500 | 链接、次级强调、Tab 栏标签 |
| `font-semibold` | 590 | 按钮文字、面包屑当前页、计数徽章、次级标题 |
| `font-bold` | 650 | 区块标题、激活导航项、表头、主从列表选中项 |
| `font-extrabold` | 700 | 页标题、KPI 主数字 |

Radix 侧把 `--font-weight-medium` 覆写成 590、`--font-weight-bold` 覆写成 650，`Text weight="medium"` 与 `weight="bold"` 因此自动落在同一刻度上。

字距只在大字号上收：`--letter-spacing-7/8/9` 为 -0.02em / -0.022em / -0.03em，对应 21 / 25 / 29px。

## 6. 密度、间距与圆角

### 6.1 密度

- Theme 固定 `scaling="100%"`，密度由字号阶梯本身承担。
- 常规输入和按钮使用 `size="2"`；窄屏用响应式 size（`{ initial: "3", sm: "2" }`）并配 `max-sm:min-h-11`，保证触控目标至少 44px。
- 核心提交动作在窄屏用 `size="4"`。
- 表格和长列表优先紧凑行高，重要状态保持完整文字。

### 6.2 间距

这套设计没有严格 4px 栅格——设计稿的 gap 里奇数值（5 / 7 / 9 / 11 / 13）接近半数，是逐像素目视调优的结果。落地规则：

- 优先用 Tailwind 的标准 spacing（`gap-2`、`gap-3`、`gap-4`、`px-4`、`px-5`），它们覆盖多数场景。
- 设计稿明确给出、且标准档位差得出可见效果的位置，才用方括号值（例如导航项内的 `gap-[7px]`、KPI 卡的 `px-[19px] py-[17px]`、内容区区块的 `sm:gap-[18px]`）。
- 页面级容器的内边距只由 `PageBody` 提供，不在页面里各写各的。

`PageBody` 固定 `px-[18px] pt-6 pb-20 sm:px-7`：底部留白比顶部厚，滚到底时最后一张卡不该贴着窗沿。

### 6.3 圆角

圆角随容器尺寸递增，这是这套设计唯一的圆角规则。

| 令牌 | 值 | Tailwind | 用在什么 |
| --- | --- | --- | --- |
| `--v8-radius-chip` | 5px | `rounded-chip` | commit hash chip、键帽 |
| `--v8-radius-mark` | 8px | `rounded-sm` | 品牌方块、小号输入与 Select |
| `--v8-radius-control` | 9px | `rounded-md` | 标准按钮、搜索入口、分段控件外壳、输入框 |
| `--v8-radius-card` | 12px | `rounded-lg` | 桌面卡片、通知条、详情内嵌卡 |
| `--v8-radius-card-mobile` | 14px | `rounded-xl` | 移动端卡片（写法是 `rounded-xl sm:rounded-lg`） |
| `--v8-radius-panel` | 16px | `rounded-2xl` | 登录卡、命令面板 |
| `--v8-radius-overlay` | 18px | `rounded-3xl` | 模态、运行详情面板 |

胶囊形状（状态徽章、计数徽章、模型 chip、头像、状态点）用 `rounded-full`。Radix 的 `--radius-1` 到 `--radius-6` 被直接覆写到上述终值，所以 Themes 组件跟着走，不需要为每个页面单独设置圆角。

## 7. 页面结构

### 7.1 应用外壳

外壳是一列 flex：顶栏（`shrink-0`）→ `main#panel-main-scroll`（`flex-1 overflow-auto`）→ 移动端 Tab 栏 → 命令面板。Tab 栏是同一列的兄弟节点，自己占高度，内容区不需要再留底部空白。

`sm=640px` 是外壳切换点：以上显示顶栏第二层的 underline 导航，以下隐藏它并显示底部 Tab 栏。

**顶栏第一行**：品牌方块 26px（`--v8-radius-mark`、`--v8-mark-gradient`、`--v8-shadow-mark`，内嵌 `Mark framed={false}` 的白色线条）+ 品牌名 `text-xl` `font-bold` + 面包屑分隔符 `/`（`text-text-faint`，窄屏隐藏）+ 当前页名 `text-xl` `font-semibold`（窄屏隐藏）；右侧是搜索入口与头像菜单。

**搜索入口**：`bg-fill`、`rounded-md`、`text-md`、`text-text-muted`，桌面 300px 宽并在右端显示 `⌘K` 键帽（`font-mono text-xs text-text-disabled`），窄屏收成只剩放大镜图标。`aria-keyshortcuts="Meta+K Control+K"`。

**头像菜单**：27px 圆形，`--v8-avatar-gradient` 加用户名首字母。桌面端的「修改密码」与「退出登录」都收在这里，不占 underline 导航的位置。

**移动端 Tab 栏**：`--v8-tabbar-bg` + blur(30px) + `border-chrome-line` 顶边 + `pb-[env(safe-area-inset-bottom)]`。取前 4 个有权限的页面加一个「我的」；「我的」用 DropdownMenu 收纳装不下的页面与账户动作。每项 21px 图标 + 10px 标签，激活 `text-primary` 并输出 `aria-current="page"`，未激活 `text-text-muted`。

### 7.2 页面层级

页面固定采用 `App Shell > TopBar/MobileTabBar + Page > PageHeader + PageBody > SetupChecklist + Task regions`。

`PageHeader` 左边是这一页叫什么、干什么，右边是这一页当下需要的那一个动作。标题走 Display 栈 `text-5xl` `font-extrabold` `tracking-[-0.022em]`；说明文字 `text-base` `text-text-muted` 并压在 `max-w-[68ch]` 以内，再宽读者的眼睛要横跨整屏才回到行首。

`PageBody` 只有 `wide`（`max-w-[1240px]`，列表与看板页）与 `form`（`max-w-[1080px]`，表单与矩阵页）两档。两类页面的正文列宽本来就不同，窄一档能让长表单的标签和输入不至于横跨整屏。

卡片外壳统一：`rounded-xl sm:rounded-lg border border-card-line bg-surface shadow-card`。卡片头 `px-4 pt-3.5 pb-[11px] sm:px-5`，区块标题 `text-2xl font-bold tracking-[-0.015em]`。

### 7.3 长列表与主从布局

- `lg=1024px` 是首页与模型服务主从双栏的切换点，网格是 `264px minmax(0,1fr)`。外壳仍在 `sm=640px` 切换；640–1023px 内容区继续使用列表／详情单层布局。
- 首页双栏下左右各自局部滚动；模型服务页整页跟着外壳的 `panel-main-scroll` 一起滚，列表与详情不各开滚动区。
- 单层布局先显示列表，进入详情后提供明确返回入口。首页把左栏折叠成顶部的仓库选择器，选中的仓库写在地址上；模型服务以稳定 provider 路由区分，浏览器前进、后退和刷新保持可恢复。
- 表头可粘性定位；横向滚动限制在表格自身容器内，页面不得产生水平滚动。
- 长名称和模型标识单行截断，hover/focus 时通过 Tooltip 查看全文。
- 地址、模型标识等可复制内容提供 Copy 按钮。

### 7.4 路由

外壳下挂五页：`/` 评审记录、`/stats` 处置率、`/credentials` 模型服务、`/settings` 审查策略、`/access` 访问控制，另有 `/password` 与外壳外的 `/login`。仓库注册表没有自己的页面，它是首页左栏；导航顺序即 `NAV` 数组顺序，评审记录打头、账户项收尾。

页面组件使用 `React.lazy + Suspense` 按路由分块；模型服务的七个路由入口共用同一个 `credentials.tsx` 动态模块。导航按权限过滤而不是摆禁用项，零权限时导航全藏、内容区用 `EmptyState` 说明并列出系统管理员。

## 8. 选择与导航语义

选中态按操作语义分三类，颜色各不相同，不得混用。

### 8.1 当前位置：3px 蓝色圆头指示条 + 字重 650

**顶栏 underline 导航**。激活项 `font-bold`（650）+ `text-text`，下方一条 `h-[3px] rounded-t-[3px] bg-primary mx-3` 的指示条（左右各内缩 12px）。未激活 `text-text-secondary`，hover 转 `text-text`。激活项底部 padding 相应减去指示条高度（`pb-[9px]` + 3px 对齐未激活的 `pb-3`），所以切换页面时文字基线不上下跳。

导航项右侧可挂两种标记：计数徽章（`rounded-full text-sm font-semibold tabular-nums`，激活时 `bg-accent-tint text-primary`，未激活 `bg-fill text-text-secondary`）与告警点（`size-[7px] rounded-full bg-warning-icon`，带 `role="img"` 与可访问名称）。两者只读已有查询，不为徽章新增端点。

**详情内分区导航**（模型服务的概览／维护／模型）直接使用 Themes `TabNav` 与 Router Link，它自带的指示条形态在详情层级里够用。同一页面内切换面板使用 Themes `Tabs`。弹窗打开和关闭不得改变底层 Tab 状态。

**移动端 Tab 栏**的当前项用 `text-primary` 加 `aria-current="page"`，不画指示条。

### 8.2 主从当前项：蓝 tint 底 + 3px 蓝左条 + 字重 650

`MasterListItem` 是唯一实现，模型服务、仓库与 `ModelComposer` 共用：

| 状态 | 表现 |
| --- | --- |
| 默认 | 透明底，`text-text` 主文字，`MasterListItemText` 的 muted 辅助文字 |
| hover | `bg-sunken`，所有文字保持可读 |
| focus-visible | `ring-2 ring-inset`，色为 `--v8-accent`，并提到 `z-10` 防止被相邻行裁切 |
| selected | `bg-accent-tint` + `font-bold` + `before` 伪元素画的 3px `bg-primary` 左条 |
| selected + hover | 保持同一背景，不换色 |
| disabled | `opacity-60` + `cursor-not-allowed` |

三条硬约束：

1. **左条走 `before` 伪元素，不用 `border-left`。** 后者会把行内容推右 3px，而这个补偿只要漏一处就错位——设计稿里正是漏了一页。伪元素不进盒模型，调用方无从漏。
2. **选中优先于 hover。** 鼠标扫过一列时只有当前项保持蓝底；指到哪一项就变哪一项的话，“我选中的是哪个”这个信息在扫读过程中就丢了。
3. **文字不反白。** 上一版的深色实底选中态需要为主文字、辅助文字、异常文字各配一套反白色；蓝 tint 底让三者都沿用默认色，只有一处对比度要检查。

语义属性按行为区分：路由型列表链接通过 `asChild` 组合 Link 并输出 `aria-current="page"`，页内选择按钮输出 `aria-pressed`。

### 8.3 编辑中的选择：浅底、描边或 Checkbox

- 模型启用与批量选择使用 Checkbox，父级全选使用 indeterminate 状态；角色权限这类开了即时生效的单体开关使用 Switch。
- 已选行使用浅色强调，Checkbox 是主要选中标记。
- 固定选项单选使用 RadioGroup；紧凑模式切换使用 SegmentedControl 或单选 ToggleGroup，必选的 ToggleGroup 拦截空值。
- Switch 仅用于点击后立即生效的开关。
- 不重复展示「已选择」「可用」等与控件状态相同的文字。批量动作必须显示选中数量，并在执行后给出成功或失败反馈。

**唯一的蓝色实底选中态在命令面板**：结果项选中时整行 `bg-primary` + 白字 + `font-semibold` + `--v8-shadow-accent-strong`，图标底转 `bg-white/20`。命令面板是键盘驱动的瞬时列表，一次只有一项、选完就关，不存在与其他选中语义共屏的机会。

## 9. 交互组件状态

所有共享组件必须覆盖以下状态：

| 状态 | 规则 |
| --- | --- |
| default | 内容、边界和动作清晰 |
| hover | 强化可点击性，不改变语义色，不降低文字对比度 |
| focus-visible | 键盘焦点环清楚且不被裁切。产品表面统一 `focus-visible:ring-2 focus-visible:ring-ring/40`（`--ring` 即 `--v8-accent`）；输入类控件（TextField / TextArea / Select）统一 `outline: 3px solid var(--v8-accent-focus)` 且 offset 为 0，环落在控件**外侧**——Radix 默认的 `2px solid` 加 `-1px` offset 会把实色线压在控件内侧、紧贴输入的文字，读起来像报错高亮 |
| active | 提供按压反馈，布局不位移 |
| selected/current | 按第 8 节的三类语义表达 |
| disabled | 降低对比度，禁用交互和 hover |
| loading | 保留原尺寸，显示 Spinner，阻止重复提交 |
| invalid | 字段边界、错误文字和 `aria-describedby` 同时生效 |

设计稿是静态 mockup，没画 hover、active、disabled、loading 与错误态。这些状态一律沿用 Radix Themes 的默认行为，它们读的是已经被拉到 v8 值上的令牌，所以视觉自动一致；不为它们另写一套 utility 外观。

### 9.1 Button

- 主要动作固定为 accent 的 `solid`，每个任务区最多一个，**不开 `highContrast`**——highContrast 会把颜色推到 12 档，主按钮会从蓝变回近黑。
- 次要动作使用 `soft` / `outline` / `ghost` 配 `color="gray"`，灰色按钮**保留** `highContrast`，文字才是 `--v8-text` 而不是 `--v8-text-secondary`。
- 删除和丢弃使用 `color="red"`，并通过 AlertDialog 确认。
- 纯图标动作使用 `IconButton` 并提供 `aria-label` 与 Tooltip。
- 业务 Button 从 `components/theme-button.ts` 导入：`@radix-ui/themes` 3.3.0 在 `exactOptionalPropertyTypes` 下把 `highContrast` 推成 `never`，那里仅修正类型声明，导出的仍是原始 Button。
- 描边型控件（日期范围按钮）是 v8 专有形态：白底 + `border-input` + `shadow-control`，不是 Radix `outline` 默认的灰底块。

### 9.2 表单

- Label 始终可见，使用 `Text as="label"` 并保持 `htmlFor`/`id` 关联；placeholder 只提供输入示例。
- 文本输入使用 `TextField.Root`，搜索图标等附件进入 `TextField.Slot`。
- 帮助信息使用相邻 `HelpTooltip`，不用小标题承载说明。
- 字段错误紧邻字段显示；提交级错误使用 Callout。
- 搜索输入提供清除按钮，并保留输入焦点。
- Select 用于有限枚举。可搜索并允许手输模型标识的场景使用 `EditableModelCombobox`。

### 9.3 数据展示

- StatusBadge 只表达运行状态；Themes Badge 表达来源、身份或类别；DataList 表达少量键值详情；Table 表达可比较的多行数据。
- commit SHA 用 `font-mono text-xs` 加 `bg-accent-tint-strong text-primary` 的 chip；模型标识 chip 用 `bg-fill` 灰底，失败模型改 `bg-danger-tint text-danger`。
- 事实值和来源在同一行显示，避免为「发现事实」「实际运行」创建重复列。
- 单元格内容超过可用宽度时截断；完整内容可通过 Tooltip 或详情区读取。
- 时间一律「年-月-日 时:分」本地时区，不用 `toLocaleString()`。

## 10. 浮层

四类浮层的材质由层级决定，见 4.4。全部使用 `--v8-scrim` 遮罩。

### 10.1 Dialog

- 普通编辑和多步配置使用 Dialog。模型凭据三步配置在一个 Dialog 内完成，步骤状态属于 Dialog。
- 取消关闭时丢弃弹窗草稿，保留底层 provider、列表项、Tab、筛选和滚动位置。
- 提交成功后更新底层数据；是否切换当前项由操作结果明确决定。
- 长内容只滚动 Dialog 内容区，标题和操作区保持可见。
- 打开后聚焦首个有效操作，关闭后焦点返回触发按钮。受控浮层通过 `useDialogReturnFocus` 在触发事件发生时记录真实元素；触发元素被卸载时返回调用方提供的稳定入口。后备入口用 `visibleNavCurrentItem()`：桌面导航与移动 Tab 栏同时在 DOM 里、只靠断点显隐，`[aria-current='page']` 会命中两个，而 `focus()` 对 `display: none` 的那个静默无效。

### 10.2 运行详情面板

评审记录的运行详情是浮动面板，不是行内展开：桌面端 `md=768px` 起四边留 14px 悬浮在右侧，宽 920px（上限 `calc(100vw-28px)`），`--v8-radius-overlay` 圆角、`--v8-drawer-bg` + blur(40px) 材质、`--v8-shadow-overlay` 投影；窄屏改成 86dvh 的底部抽屉，列表上半屏保持可见，关闭与「重新运行」都落在拇指够得到的位置。面板装的是代码差异与审查证据，桌面宽度为代码保留足够上下文，窄屏则由代码列 soft wrap 适配可用宽度。

面板内是文件列表加逐文件 diff：每个文件一张卡，卡头写路径、新增/修改/删除、`+N −M`（增走 `--v8-success`、删走 `--v8-danger`）与这个文件的发现数，点卡头展开或收起。diff 用 `font-mono text-xs` 的三列表格——旧行号、新行号、正文，新增行整行 `--v8-success-tint`、删除行整行 `--v8-danger-tint`，hunk 头走 `--v8-surface-sunken`。Finding 卡片插在它所指的那一行下面：已处置项划线加绿勾，未处置项带优先级徽章；模型失败原因整段摊在最上面的红色 Callout 里，不折叠。

阶段详情使用同一浮层规格承载单条 Finding 的代码差异与单轮审查轨迹。Finding 列表入口使用 `FileTextIcon` 图标与动态可访问名称,Review Run 入口使用 `ReaderIcon` 加「审查轨迹」;界面不使用「看这处」「看这一轮」等依赖视觉上下文的动作名称。diff 的旧 / 新行号列固定,代码列按可用宽度 soft wrap；续行仍属于同一个逻辑行,不重复行号,缩进与空格保留,侧滑自身不产生横向滚动。移动端关闭、Forge 外链、处置和 Reviewer 展开动作的触控区域至少 44px。该 Primitive Dialog 的 Portal 固定挂到 `PanelTheme` 内的 `#panel-portal`,确保 Themes 组件继承同一套颜色、字号和圆角变量。

### 10.3 AlertDialog

删除用户、角色、仓库、模型服务和其他不可逆动作使用 AlertDialog。文案明确对象、影响和恢复方式。不使用阻塞渲染线程的 `window.confirm`。

### 10.4 命令面板

⌘K / Ctrl+K 是一级入口，顶栏常驻。快捷键监听挂在 window 上，任意页面任意焦点都能唤起。面板是 584px 宽、`--v8-radius-panel` 圆角、`--v8-palette-bg` + blur(50px)、`--v8-shadow-palette` 的 Spotlight 材质。当前只收导航跳转——这是面板里唯一一类「知道目标名字就想直接过去」的动作；触发评审、注册仓库这类动作都要先选对象，进来也只是又一次跳转。底部固定显示 ↑↓ / ↵ / esc 三条键位提示。

### 10.5 Popover 与 Tooltip

- Popover 承载锚定的交互内容，例如筛选器和日期选择。
- Tooltip 只承载简短帮助、缩略内容全文和图标名称。
- 错误、后续步骤和关键状态直接显示在页面或 Dialog 内。
- 浮层内容通过 Portal 渲染，并继承 Theme。

## 11. 反馈与状态页面

| 场景 | 组件 | 内容要求 |
| --- | --- | --- |
| 页面加载 | Skeleton | 轮廓匹配真实内容，尺寸等于它替代的那块，数据到了不跳版 |
| 局部提交 | Spinner / Button loading | 保留按钮宽度，阻止重复提交 |
| 成功 | Callout 或局部状态 | 说明完成的对象和结果 |
| 警告 | Amber Callout | 说明影响和可执行下一步 |
| 错误 | Red Callout | 说明失败对象、原因和重试入口 |
| 空数据 | EmptyState | 说明当前为空和首个可执行动作 |
| 无搜索结果 | EmptyState | 显示筛选条件和清除入口 |
| 首次配置未完成 | SetupChecklist | 三步完成状态常显，只把当前未完成步骤做成入口 |

读取中给骨架块，不给「读取中…」那行字。空态不使用装饰性大图标，保留调用点原有的 `h1`/`h2`/`h3` 标题层级。错误标题和正文避免重复。动态反馈使用合适的 live region。

设计稿里没有空状态与分页组件，最接近空态的是单元格「—」，统一用 `text-text-disabled`。

## 12. 图标规则

- 通用图标统一来自 `@radix-ui/react-icons`。
- 常规尺寸沿用 Radix 的 15×15；顶栏搜索图标 14px，移动端 Tab 图标 21px，列表行状态图标 16px。
- 产品标记保留自绘 SVG：`Mark` 是三条错位短线，三个模型各看同一段改动，与 `index.html` 里内联成 data URI 的 favicon 是同一份图形。它有两种用法——`framed`（默认，自带 `currentColor` 圆角外框）与 `framed={false}`（只出线条，供顶栏与登录页放进自己的渐变方块里；再带一层外框就是方块套方块，外框和线条同色时整枚标记会消失）。
- 装饰图标设置 `aria-hidden="true"`。
- 纯图标按钮提供 `aria-label` 与 Tooltip。
- 状态图标必须与状态文字共同出现。StatusBadge 固定四个图标：`InfoCircledIcon` / `CheckCircledIcon` / `ExclamationTriangleIcon` / `CrossCircledIcon`。
- 已有文字能完整说明动作时，删除重复图标。
- 禁止使用 Emoji 和 Unicode 图形充当操作图标。
- 文本分隔符可保留普通字符；日期范围使用「至」。

建议统一语义映射：搜索、帮助、关闭、删除、编辑、复制、刷新、返回、展开、外链各固定一个图标，页面不得自行替换同义图标。

## 13. Themes 外产品组件

按以下顺序处理 Themes 未覆盖的需求：

1. 用现有 Theme 组件组合完成。
2. 用 v8 令牌实现共享产品组件。
3. 使用 Radix Primitive 补齐行为和无障碍能力。
4. 保留必要的第三方行为库，并包装为单一产品组件。
5. 调整功能形态，控制维护成本。

当前已经实现的 Themes 外产品组件：

- `PanelTheme`：全站唯一的 Theme 实例，四个 prop 不开放给调用方。
- `MasterListItem` 与 `MasterListItemText`：用 Slot 统一路由链接和页内按钮的主从当前项，集中处理蓝 tint 选中、伪元素左条、焦点与辅助文字对比度。
- `StatusBadge`：运行状态的唯一视觉出口，五种语义映射到 Radix Gray / Blue / Green / Amber / Red（`running` 占蓝那一档）。
- `CommandPalette` 与 `useCommandPalette`：全局 ⌘K 入口与 Spotlight 材质浮层，内部复用 `ui/command`。
- `PageHeader` / `PageBody`：页头与正文容器的唯一实现，统一标题层级、正文宽度与页尾留白。
- `Mark`：产品标记，与 favicon 同图形。
- `DateRangePicker`：包装 react-day-picker、Themes Popover 与 Calendar 行为适配，外部只处理起止日期。
- `EditableModelCombobox`：包装 cmdk、Themes TextField 与 Popover，外部只处理值、候选与选择结果。
- `EmptyState`：统一资源为空、筛选无结果和零权限状态，并保留调用点原有标题层级。
- `useDialogReturnFocus` 与 `visibleNavCurrentItem`：受控浮层的焦点返回。
- `theme-button.ts`：Radix Button 的类型适配出口，不增加组件、行为或 DOM。
- `HelpTooltip`、`ModelComposer`、`SetupChecklist`：集中产品语义与跨页行为。

Calendar 与 Command 留在 `components/ui` 作为第三方行为适配层，只由对应产品组件或明确的搜索场景调用。简单展开继续直接组合 Collapsible Primitive。普通局部滚动使用原生 overflow；当前没有 Toast 与 ScrollArea 产品组件，关键结果留在页面内。

禁止页面深度覆盖 Radix 内部 DOM。共享组件只暴露产品需要的少量 variant 和 size。同一语义组件只有一个实现，禁止复制。

## 14. Tailwind 使用边界

- Tailwind 负责三类东西：外壳与页面布局（分栏、网格、局部滚动边界、断点显隐）、Themes 响应式 props 表达不了的布局切换、以及 v8 专有表面的材质（顶栏、移动端 Tab 栏、命令面板壳、运行详情面板壳、主从选中态、卡片外壳）。
- 这些表面只读 `@theme inline` 映射进来的 v8 令牌（`bg-surface`、`text-text-muted`、`border-line`、`shadow-card`、`rounded-lg`…），不写字面色值。需要毛玻璃底色这类没有 Tailwind 类的令牌时，写 `bg-[color:var(--v8-tabbar-bg)]` 而不是复制 rgba。
- Theme props 与 Radix 令牌负责常规组件的颜色、字号、间距、圆角、阴影和交互状态。Primitives 负责键盘、焦点、受控状态和 ARIA 行为。
- 页面不得用 Tailwind 覆盖 Themes 组件内部的 hover、focus、selected、disabled、loading 或 invalid 状态，也不得为同一语义另写一套 utility 外观。
- 例外只有一处：命令面板与运行详情面板需要替换 Radix `Dialog.Content` 自带的定位、圆角与背景，那里用带 `!` 的 utility 覆盖 `Dialog.Content` 自身的类。这是覆盖组件根节点的公开 className，不是覆盖内部 DOM。
- 同一布局只能由 Themes 响应式 props 或 Tailwind 断点中的一套规则控制。
- **cascade layer 顺序固定为 `theme < base < radix < components < utilities`。** Radix Themes 样式必须从 `styles.css` 导入 `radix` layer，不得在 TSX 入口单独导入未分层样式，否则 `hidden` 与断点 display utility 盖不住 Card、Button、Table 的默认 display。令牌覆写本身不进任何 layer——未分层样式的优先级高于所有分层样式，天然盖过 `layer(radix)`，不需要 `!important`。新增样式入口或调整 layer 顺序时必须检查生产 CSS。

## 15. 部署交付验收清单

交付前在评审记录与模型服务两个代表页面验证（仓库注册表没有自己的页面，它的注册、配置与移除都在评审记录左栏上）：

1. 顶栏毛玻璃：滚动内容穿过顶栏时背景确实虚化，`--v8-chrome-bg` 下的文字与图标对比度仍达标；顶栏底边可见但不抢眼。
2. 导航指示条：激活项 3px 圆头蓝条左右各内缩 12px；激活与未激活切换时文字基线不上下跳；导航项上没有计数徽章；模型服务异常时琥珀点出现并有可访问名称。
3. 选中态与 hover 的组合：主从列表选中项是蓝 tint 底 + 左条 + 字重 650，鼠标扫过整列时选中项不换色，未选项 hover 是 `bg-sunken`；选中行的行内容与未选行左对齐（伪元素左条不占位）；焦点环不被相邻行裁切。
4. 移动端 Tab 栏：390px 下顶栏第二层收起、底部 Tab 栏出现；取前 4 个有权限的页面 + 「我的」；当前项蓝色并带 `aria-current`；安全区留白生效，Tab 栏不被 home indicator 压住。
5. 主按钮颜色：`accentColor="blue"` 下主按钮是 `--v8-accent` 蓝而不是近黑（确认没有误开 `highContrast`）；灰色次要按钮保留 `highContrast`，文字是 `--v8-text`；红色删除按钮走 `--v8-danger`。
6. 命令面板：任意页面、输入框内外按 ⌘K / Ctrl+K 都能唤起；毛玻璃与内高光边可见；键盘上下选择时选中项是蓝色实底反白；Esc 关闭后焦点回到触发入口。
7. 三个断点：外壳在 `sm=640px` 切换（顶栏导航 ↔ 底部 Tab 栏）；运行详情面板在 `md=768px` 切换（底部抽屉 ↔ 右侧浮动面板）；主从双栏在 `lg=1024px` 切换。确认 640–1023px 仍为单层列表／详情且无拥挤，三个宽度均无页面横向溢出。
8. 状态语义色：成功、警告、错误徽章都是 soft tint 加图标加文字；警告图标是 `--v8-warning-icon`、文字是 `--v8-warning`，两者不混。
9. 字号阶梯：页标题 25px 一页一个、KPI 数字 29px、卡片区块标题 16px、正文 13.5px；页面里没有阶梯外的一次性字号（移动端 Tab 栏 10px 除外）。
10. 长列表的可视高度、局部滚动、粘性表头和批量操作栏；多步凭据 Dialog 的宽度、内容滚动和窄屏布局。
11. DateRangePicker、EditableModelCombobox 与 Theme 组件的视觉一致性和键盘操作。
12. TabNav 与 Router Link 的当前态、前进后退和刷新恢复；受控 Dialog / AlertDialog 关闭后的焦点返回，以及触发元素卸载后的稳定后备入口。

验收同时覆盖鼠标、键盘、窄屏、长中文名称、长模型标识、加载、错误、禁用与空数据。

**验收固定在部署实例使用 ego-browser，不在本机 dev 双进程上做。** 本机没有真 Gitea、没有已注册的仓库、没有模型凭据，面板上大半的屏在那里是空的；dev 双进程只用于实现时的即时反馈，不作为验收依据。实现期在 1440px 与 390px 抓的截图同理，不构成验收结论。

2026-08-24 在部署实例完成的那次验收针对上一方向（发布门禁看板：gray accent、深色实底选中态、左侧栏），不覆盖本方向。毛玻璃控制台的端到端验收按上述 12 条重做。

## 16. 实施约束

- 页面使用 Theme props、v8 令牌和共享产品组件；避免页面级视觉变体。
- 颜色只有一份事实来源：`src/styles.css` 的 `--v8-*`。新增颜色先加令牌，再在组件里引用；页面里不出现字面色值。
- 字号只用十一档令牌，不写 `text-[13px]` 这类一次性值。
- 同一语义组件只有一个实现，MasterListItem、StatusBadge、CommandPalette、PageHeader、PageBody、DateRangePicker、EditableModelCombobox、EmptyState 禁止复制。通用错误直接使用 Themes Callout，不再包装第二套视觉组件。
- 模型组合编辑器只有一份且只负责选择；配置模型服务、凭据、发现、刷新与补录一律回模型服务页。
- 弹窗草稿与底层页面状态分开存储。关闭弹窗不得重置底层选择。
- URL 可表达的页面状态写入路由；临时编辑状态留在组件内。
- 页面组件使用 `React.lazy + Suspense` 按路由分块；同一页面模块的子路由共用一个动态模块入口。
- 新组件必须提供可访问名称、键盘行为、完整状态和响应式验证。
- 前端不做程序化测试（issue #26 的测试决策）：逻辑压在服务端可测的注入变量与 API 契约上；视觉与交互由部署实例的端到端验收覆盖。
- 视觉改动在部署实例使用 ego-browser 完成端到端验收。
