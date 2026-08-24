# MultiReviewer Web 组件与交互模式盘点（迁移前基线）

> 历史资料：本文记录引入 Radix Themes 之前的 shadcn/Lucide 实现，用于追溯迁移范围。文中的“当前”均指盘点当时的代码，不代表现状；现状以 `radix-ui-current-inventory.md` 为准。

## 范围与口径

- 扫描范围是 `web/src/**/*.tsx`。当前前端声明 46 个 `components/ui` 基础组件和 56 个项目组件；计数取实际具名 React 函数，不把路由对象、常量和 `cva` 变体重复计为组件。[基础组件定义](../../web/src/components/ui/button.tsx#L44) [项目组件示例](../../web/src/credentials.tsx#L2345)
- 当前项目安装 `radix-ui` 单包、`cmdk`、`react-day-picker` 和 `lucide-react`，尚未安装 `@radix-ui/themes`。[package.json](../../web/package.json#L11-L24)
- shadcn 配置是 `radix-nova`、CSS variables、Lucide 图标；组件源码 vendored 在本仓库内。[components.json](../../web/components.json#L1-L20) [web/AGENTS.md](../../web/AGENTS.md#L24-L25)
- 初步映射标签：**直映**＝Radix Themes 或 Primitive 有同职责组件；**组合**＝用多个 Radix 组件组成产品控件；**自定义**＝保留领域组件，只用 Radix 的布局、表单或交互底座。

## 1. shadcn / Radix 基础组件

| 组件 | 定义 | 当前底座与状态/交互 | 主要调用点 | 初步映射 |
|---|---|---|---|---|
| `Button` | `components/ui/button.tsx:44` | 原生 button + Radix `Slot`；6 种视觉、8 种尺寸、focus/disabled/invalid/active。[源码](../../web/src/components/ui/button.tsx#L7-L64) | 全部表单和动作，例如模型服务页。[调用](../../web/src/credentials.tsx#L490) | 直映 Themes `Button` / `IconButton`；`asChild` 保留 Primitive `Slot` |
| `Badge` | `components/ui/badge.tsx:30` | span + `Slot`；default/secondary/destructive/outline/ghost/link，兼容链接态。[源码](../../web/src/components/ui/badge.tsx#L7-L46) | 评审状态、服务状态、模型来源。[调用](../../web/src/runs.tsx#L67-L81) [调用](../../web/src/credentials.tsx#L2062-L2071) | 直映 Themes `Badge`；产品状态色需统一变体 |
| `Input` | `components/ui/input.tsx:5` | 原生 input；hover/focus/invalid/disabled 与窄屏触控尺寸。[源码](../../web/src/components/ui/input.tsx#L5-L16) | 登录、配置、搜索、批次上限。[调用](../../web/src/login.tsx#L86-L101) [调用](../../web/src/settings.tsx#L255-L264) | 直映 Themes `TextField.Root` |
| `Label` | `components/ui/label.tsx:6` | Radix Label Primitive；disabled 由父组/peer 传播。[源码](../../web/src/components/ui/label.tsx#L6-L19) | 所有表单字段。[调用](../../web/src/credentials.tsx#L795-L834) | 直映 Themes `Text` + Primitive `Label`，优先保留 Label 语义 |
| `Card` | `components/ui/card.tsx:5` | 纯布局表面；size、边框、背景、间距变量。[源码](../../web/src/components/ui/card.tsx#L5-L21) | 全部业务页容器。[调用](../../web/src/repos.tsx#L387-L446) | 直映 Themes `Card` |
| `CardHeader` | `components/ui/card.tsx:23` | 标题区 grid/container query。[源码](../../web/src/components/ui/card.tsx#L23-L34) | 当前业务页未直接导入 | 直映 Themes 布局组合；可删除无调用包装 |
| `CardTitle` | `components/ui/card.tsx:36` | 卡片标题字号与 size 联动。[源码](../../web/src/components/ui/card.tsx#L36-L47) | 当前业务页未直接导入 | 直映 Themes `Heading` |
| `CardDescription` | `components/ui/card.tsx:49` | 次要说明文字。[源码](../../web/src/components/ui/card.tsx#L49-L57) | 当前业务页未直接导入 | 直映 Themes `Text` |
| `CardAction` | `components/ui/card.tsx:59` | 卡片右上动作槽。[源码](../../web/src/components/ui/card.tsx#L59-L70) | 当前业务页未直接导入 | 直映 Themes `Flex/Grid` |
| `CardContent` | `components/ui/card.tsx:72` | 内容内边距槽。[源码](../../web/src/components/ui/card.tsx#L72-L80) | 当前业务页未直接导入 | 直映 Themes `Box` |
| `CardFooter` | `components/ui/card.tsx:82` | 顶部分隔线、muted 背景、动作排列。[源码](../../web/src/components/ui/card.tsx#L82-L93) | 当前业务页未直接导入 | 直映 Themes `Flex` |
| `Dialog` | `components/ui/dialog.tsx:8` | Radix Dialog Root，受控/非受控状态。[源码](../../web/src/components/ui/dialog.tsx#L8-L12) | 仓库注册/删除、用户角色、模型服务配置/确认。[调用](../../web/src/repos.tsx#L518-L539) [调用](../../web/src/access-control.tsx#L378-L420) | 直映 Themes `Dialog.Root` |
| `DialogTrigger` | `components/ui/dialog.tsx:14` | Radix Trigger。[源码](../../web/src/components/ui/dialog.tsx#L14-L18) | 导出但当前调用方多用受控 Dialog | 直映 Themes `Dialog.Trigger` |
| `DialogPortal` | `components/ui/dialog.tsx:20` | Portal 容器。[源码](../../web/src/components/ui/dialog.tsx#L20-L24) | `DialogContent` 内部调用 | 直映 Themes 内建 Portal |
| `DialogClose` | `components/ui/dialog.tsx:26` | Radix Close；支持 `asChild`。[源码](../../web/src/components/ui/dialog.tsx#L26-L30) | 访问控制确认取消。[调用](../../web/src/access-control.tsx#L397-L398) | 直映 Themes `Dialog.Close` |
| `DialogOverlay` | `components/ui/dialog.tsx:32` | fixed overlay、淡入淡出、backdrop blur。[源码](../../web/src/components/ui/dialog.tsx#L32-L46) | `DialogContent` 内部调用 | 直映 Themes 内建 overlay；视觉由 Theme 控制 |
| `DialogContent` | `components/ui/dialog.tsx:48` | 居中、最大宽度、进退场动画、可选关闭按钮。[源码](../../web/src/components/ui/dialog.tsx#L48-L84) | 所有弹窗。[调用](../../web/src/credentials.tsx#L351-L406) | 直映 Themes `Dialog.Content`；大流程需自定义 size/scroll |
| `DialogHeader` | `components/ui/dialog.tsx:86` | 标题说明纵向布局。[源码](../../web/src/components/ui/dialog.tsx#L86-L94) | 全部弹窗标题区。[调用](../../web/src/repos.tsx#L519-L526) | 组合 Themes `Flex` |
| `DialogFooter` | `components/ui/dialog.tsx:96` | 响应式反向动作列，可选 Close。[源码](../../web/src/components/ui/dialog.tsx#L96-L121) | 全部弹窗动作区。[调用](../../web/src/repos.tsx#L527-L538) | 组合 Themes `Flex` + `Dialog.Close` |
| `DialogTitle` | `components/ui/dialog.tsx:123` | Radix 可访问标题。[源码](../../web/src/components/ui/dialog.tsx#L123-L137) | 所有弹窗。[调用](../../web/src/access-control.tsx#L421-L425) | 直映 Themes `Dialog.Title` |
| `DialogDescription` | `components/ui/dialog.tsx:139` | Radix 可访问说明。[源码](../../web/src/components/ui/dialog.tsx#L139-L153) | 所有确认和流程弹窗。[调用](../../web/src/credentials.tsx#L382-L387) | 直映 Themes `Dialog.Description` |
| `Popover` | `components/ui/popover.tsx:6` | Radix Popover Root。[源码](../../web/src/components/ui/popover.tsx#L6-L10) | 日期区间、验证模型组合框。[调用](../../web/src/stats.tsx#L198-L214) [调用](../../web/src/credentials.tsx#L1198-L1238) | 直映 Themes `Popover.Root` |
| `PopoverTrigger` | `components/ui/popover.tsx:12` | Radix Trigger。[源码](../../web/src/components/ui/popover.tsx#L12-L16) | 日期按钮、组合框展开按钮 | 直映 Themes `Popover.Trigger` |
| `PopoverContent` | `components/ui/popover.tsx:18` | Portal、定位、side 动画、定宽表面。[源码](../../web/src/components/ui/popover.tsx#L18-L38) | 日期、组合框内容 | 直映 Themes `Popover.Content` |
| `PopoverAnchor` | `components/ui/popover.tsx:40` | 自定义定位锚点。[源码](../../web/src/components/ui/popover.tsx#L40-L44) | 当前无调用 | 直映 Primitive `Popover.Anchor` |
| `PopoverHeader` | `components/ui/popover.tsx:46` | 自定义标题区布局。[源码](../../web/src/components/ui/popover.tsx#L46-L54) | 当前无调用 | 组合 Themes `Flex` |
| `PopoverTitle` | `components/ui/popover.tsx:56` | 自定义视觉标题，无 Primitive 语义。[源码](../../web/src/components/ui/popover.tsx#L56-L64) | 当前无调用 | 组合 Themes `Heading` |
| `PopoverDescription` | `components/ui/popover.tsx:66` | 自定义说明文字。[源码](../../web/src/components/ui/popover.tsx#L66-L77) | 当前无调用 | 组合 Themes `Text` |
| `Command` | `components/ui/command.tsx:7` | `cmdk` Root，提供命令列表状态与键盘导航。[源码](../../web/src/components/ui/command.tsx#L1-L20) | 仓库搜索、验证模型搜索。[调用](../../web/src/repos.tsx#L634-L702) [调用](../../web/src/credentials.tsx#L1214-L1237) | 组合；Radix Popover/Dialog + 自定义可搜索 listbox |
| `CommandInput` | `components/ui/command.tsx:23` | `cmdk.Input` + Lucide Search，受控搜索。[源码](../../web/src/components/ui/command.tsx#L23-L43) | 两处搜索列表 | 组合 Themes `TextField` + listbox 状态 |
| `CommandList` | `components/ui/command.tsx:45` | `cmdk.List`，最大高度和滚动。[源码](../../web/src/components/ui/command.tsx#L45-L59) | 两处搜索列表 | 组合 Themes `ScrollArea` + listbox |
| `CommandEmpty` | `components/ui/command.tsx:61` | `cmdk.Empty` 空态。[源码](../../web/src/components/ui/command.tsx#L61-L71) | 验证模型无结果。[调用](../../web/src/credentials.tsx#L1214-L1222) | 组合 Themes `Text` |
| `CommandGroup` | `components/ui/command.tsx:73` | `cmdk.Group` 分组标题。[源码](../../web/src/components/ui/command.tsx#L73-L87) | 当前无业务调用 | 组合；可用 Select/自定义 listbox 分组 |
| `CommandSeparator` | `components/ui/command.tsx:89` | `cmdk.Separator`。[源码](../../web/src/components/ui/command.tsx#L89-L100) | 当前无业务调用 | 直映 Themes `Separator` |
| `CommandItem` | `components/ui/command.tsx:102` | `cmdk.Item`，selected/disabled 状态和触控尺寸。[源码](../../web/src/components/ui/command.tsx#L102-L116) | 仓库、验证模型选项 | 组合；自定义 listbox option |
| `Calendar` | `components/ui/calendar.tsx:13` | `react-day-picker`；月份导航、区间、outside/disabled/today/selected 状态。[源码](../../web/src/components/ui/calendar.tsx#L13-L44) | 处置率日期区间。[调用](../../web/src/stats.tsx#L198-L219) | 自定义；Radix Themes 无日期逻辑，保留 day-picker 并换 Themes 外观 |
| `CalendarDayButton` | `components/ui/calendar.tsx:182` | 自定义日期按钮，焦点同步、单选/区间起中止状态。[源码](../../web/src/components/ui/calendar.tsx#L182-L218) | `Calendar` 内部 | 自定义日期行为 + Themes `IconButton/Button` 外观 |
| `Table` | `components/ui/table.tsx:7` | 原生 table 外包横向滚动容器。[源码](../../web/src/components/ui/table.tsx#L7-L20) | 处置率桌面矩阵。[调用](../../web/src/stats.tsx#L356-L411) | 直映 Themes `Table.Root` + 自定义滚动容器 |
| `TableHeader` | `components/ui/table.tsx:22` | thead + header wash。[源码](../../web/src/components/ui/table.tsx#L22-L30) | 处置率矩阵 | 直映 Themes `Table.Header` |
| `TableBody` | `components/ui/table.tsx:32` | tbody + 末行边框状态。[源码](../../web/src/components/ui/table.tsx#L32-L40) | 处置率矩阵 | 直映 Themes `Table.Body` |
| `TableFooter` | `components/ui/table.tsx:42` | tfoot + 汇总背景。[源码](../../web/src/components/ui/table.tsx#L42-L53) | 当前无调用 | 直映 Themes 表结构 |
| `TableRow` | `components/ui/table.tsx:55` | hover/focus-within/expanded/selected 状态。[源码](../../web/src/components/ui/table.tsx#L55-L66) | 处置率矩阵 | 直映 Themes `Table.Row`，补产品 selected 规则 |
| `TableHead` | `components/ui/table.tsx:68` | th、nowrap、checkbox 对齐。[源码](../../web/src/components/ui/table.tsx#L68-L79) | 处置率矩阵 | 直映 Themes `Table.ColumnHeaderCell` |
| `TableCell` | `components/ui/table.tsx:81` | td、顶对齐、自动换行。[源码](../../web/src/components/ui/table.tsx#L81-L92) | 处置率矩阵 | 直映 Themes `Table.Cell/RowHeaderCell` |
| `TableCaption` | `components/ui/table.tsx:94` | 原生 caption 样式。[源码](../../web/src/components/ui/table.tsx#L94-L105) | 当前无调用 | 组合 Themes `Text`，保留 table caption 语义 |
| `Skeleton` | `components/ui/skeleton.tsx:9` | 自定义 div pulse，占位尺寸由调用方指定，`aria-hidden`。[源码](../../web/src/components/ui/skeleton.tsx#L3-L17) | 全部读取态，例如模型服务布局。[调用](../../web/src/credentials.tsx#L2327-L2340) | 直映 Themes `Skeleton` |

## 2. 项目共享组件

| 组件 | 定义 | 主要调用点与交互 | 重复模式/初步映射 |
|---|---|---|---|
| `HelpTooltip` | `components/help-tooltip.tsx:14` | Radix Tooltip + Lucide 帮助按钮；hover、focus、触控目标、延迟打开。[源码](../../web/src/components/help-tooltip.tsx#L14-L48)；仓库/统计/模型服务/策略/访问控制复用。[调用](../../web/src/repos.tsx#L414) [调用](../../web/src/stats.tsx#L191) | 直映 Themes `Tooltip` + `IconButton`；应成为唯一帮助说明入口 |
| `Mark` | `components/mark.tsx:7` | 产品 SVG 标记；登录、改密、应用壳复用。[源码](../../web/src/components/mark.tsx#L7-L18) [调用](../../web/src/main.tsx#L126) | 自定义品牌资产，保留 SVG |
| `PageHeader` | `components/page-header.tsx:12` | sticky 页名/说明/动作槽。[源码](../../web/src/components/page-header.tsx#L12-L36)；六个业务页复用，例如评审记录。[调用](../../web/src/runs.tsx#L270-L277) | 组合 Themes `Flex/Box/Heading/Text`；统一页面骨架 |
| `PageBody` | `components/page-body.tsx:8` | `wide/form` 两档宽度、响应式内边距。[源码](../../web/src/components/page-body.tsx#L3-L23)；业务页复用。[调用](../../web/src/access-control.tsx#L215) | 组合 Themes `Container/Flex` |
| `SetupChecklist` | `setup-checklist.tsx:27` | Query 读取、错误/读取/完成/当前步骤、权限裁剪入口。[源码](../../web/src/setup-checklist.tsx#L27-L99)；壳统一挂载。[调用](../../web/src/main.tsx#L219-L225) | 自定义领域组件；内部映射 Themes `Card/Progress/Link` |
| `ModelComposer` | `components/model-composer.tsx:56` | 受控模型组合；provider 定位、查询、失效选择、搜索、最多 120 行、选中/取消。[源码](../../web/src/components/model-composer.tsx#L56-L128)；全局策略与仓库覆盖共用。[调用](../../web/src/settings.tsx#L192-L199) [调用](../../web/src/repos.tsx#L782-L790) | 自定义领域组件；用 Themes `Card/TextField/Badge/ScrollArea` + Primitive 选择语义组合 |
| `RunPill` | `runs.tsx:67` | 失败/部分失败/无可处置项/待处置/已处置状态。[源码](../../web/src/runs.tsx#L67-L109)；评审记录与仓库最近记录共用。[调用](../../web/src/repos.tsx#L905-L916) | 自定义状态规则 + Themes `Badge` |

## 3. 页面、流程与局部组件

### 应用壳、认证与访问控制

| 组件 | 定义/调用 | 状态与交互 | 初步映射 |
|---|---|---|---|
| `Shell` | `main.tsx:111`，路由根调用。[源码](../../web/src/main.tsx#L111-L217) | session、权限导航、登出、桌面侧栏/窄屏横向导航、当前页 | 自定义应用壳；Themes `Flex/Box/Link/Button`，导航选中规则自定义 |
| `BusinessPage` | `main.tsx:219`。[源码](../../web/src/main.tsx#L219-L227) | 组合 SetupChecklist 与路由页 | 自定义布局组合 |
| `ModelServicesRoutePage` | `main.tsx:245`。[源码](../../web/src/main.tsx#L245-L265) | 路由参数投影为 overview/maintenance/models | 自定义路由适配层，无视觉迁移 |
| `ZeroPermissionPage` | `main.tsx:400`。[源码](../../web/src/main.tsx#L400-L412) | 零权限空态卡片 | Themes `Card/Heading/Text` |
| `LoginPage` | `login.tsx:14`。[源码](../../web/src/login.tsx#L14-L111) | session 探测、登录/bootstrap 两种表单、busy/error | 自定义页面；Themes `Card/TextField/Button/Callout` |
| `PasswordPage` | `password.tsx:13`。[源码](../../web/src/password.tsx#L13-L78) | 新密码/确认、busy/error、完成跳转 | 自定义页面；Themes 表单组件 |
| `AccessControlPage` | `access-control.tsx:80`。[源码](../../web/src/access-control.tsx#L80-L410) | 用户/角色 Query 与 mutations、行内角色 Select、权限 checkbox、多个确认 Dialog | 自定义领域页；Themes `Table/Select/Checkbox/Dialog/Callout` 组合 |
| `CreateDialog` | `access-control.tsx:412`，页面调用 377。[源码](../../web/src/access-control.tsx#L377-L450) | 新建用户/角色共用受控 Dialog，按 kind 切表单 | 组合 Themes `Dialog/TextField/Button`；建议拆清晰表单 schema，保留一个流程壳 |

### 仓库

| 组件 | 定义/调用 | 状态与交互 | 初步映射 |
|---|---|---|---|
| `Kv` | `repos.tsx:68`，详情多次调用。[源码](../../web/src/repos.tsx#L68-L75) [调用](../../web/src/repos.tsx#L393-L417) | 标签/值两列展示 | 组合 Themes `Grid/Text`；与凭据 `StateRows` 是重复详情模式 |
| `ReposPage` | `repos.tsx:77`。[源码](../../web/src/repos.tsx#L77-L242) | 主从布局、仓库选中、注册 Dialog、读取/错误/空态 | 自定义领域页；Themes `Inset/ScrollArea/Card` + 产品 master-detail |
| `RepoDetail` | `repos.tsx:244`，页面调用 212。[源码](../../web/src/repos.tsx#L212-L223) [定义](../../web/src/repos.tsx#L244-L564) | drift 状态、轮转、移除确认、覆盖编辑、最近评审 | 自定义领域组件；内部多种 Themes 组件 |
| `RegisterModal` | `repos.tsx:576`，页面调用 230。[源码](../../web/src/repos.tsx#L230-L239) [定义](../../web/src/repos.tsx#L576-L729) | 250ms 搜索、Command 选项、不可注册原因、提交 | 组合 Dialog + 自定义异步 Combobox；与验证模型搜索重复 |
| `ReviewersEditor` | `repos.tsx:731`，详情调用 435。[源码](../../web/src/repos.tsx#L435-L444) [定义](../../web/src/repos.tsx#L731-L823) | 跟随全局/自定义两态、ModelComposer、保存/取消 | 自定义领域组件；两态优先映射 Themes `SegmentedControl/RadioGroup` |
| `RepoRuns` | `repos.tsx:825`，详情调用 510。[源码](../../web/src/repos.tsx#L510-L517) [定义](../../web/src/repos.tsx#L825-L923) | PR 号重跑表单、最近 8 轮、读取/错误/空态 | 自定义领域组件；Themes `Card/TextField/Button` |

### 评审记录与处置率

| 组件 | 定义/调用 | 状态与交互 | 初步映射 |
|---|---|---|---|
| `RunStatus` | `runs.tsx:111`，桌面/移动列表调用。[源码](../../web/src/runs.tsx#L111-L145) [调用](../../web/src/runs.tsx#L391-L391) | 成功/失败图标及 title | 自定义状态呈现 + Radix Icons/Tooltip |
| `RunModels` | `runs.tsx:147`。[源码](../../web/src/runs.tsx#L147-L191) | 模型成功/失败条数与原因 | 自定义领域呈现；Themes `Flex/Text/Badge` |
| `RunUsage` | `runs.tsx:193`。[源码](../../web/src/runs.tsx#L193-L206) | token/费用等宽数字 | Themes `Text` |
| `RunTime` | `runs.tsx:208`。[源码](../../web/src/runs.tsx#L208-L217) | 本地时间显示 | Themes `Text` |
| `RunsPage` | `runs.tsx:219`。[源码](../../web/src/runs.tsx#L219-L506) | 状态筛选、无限加载、桌面表/移动卡、重跑 mutation | 自定义领域页；筛选映射 Themes `SegmentedControl`, 列表用 `Table/Card` |
| `Bar` | `stats.tsx:79`，Rate/矩阵调用。[源码](../../web/src/stats.tsx#L79-L86) [调用](../../web/src/stats.tsx#L98) | 百分比宽度进度条 | 直映 Themes `Progress` |
| `Rate` | `stats.tsx:88`，多矩阵调用。[源码](../../web/src/stats.tsx#L88-L104) [调用](../../web/src/stats.tsx#L331-L345) | resolved/total 比率、Bar、空分母 | 自定义指标组合 + Themes `Progress/Text` |
| `SummaryRate` | `stats.tsx:124`。[源码](../../web/src/stats.tsx#L124-L153) | 近 30 天查询与骨架/百分比 | 自定义查询包装；视觉用 Themes `Text/Skeleton` |
| `StatsPage` | `stats.tsx:155`。[源码](../../web/src/stats.tsx#L155-L413) | 日期区间 Popover/Calendar、空窗、指标、桌面矩阵/移动卡 | 自定义领域页；Calendar 保留外部逻辑，其余 Themes 组合 |

### 审查策略

| 组件 | 定义/调用 | 状态与交互 | 初步映射 |
|---|---|---|---|
| `SettingsPage` | `settings.tsx:41`。[源码](../../web/src/settings.tsx#L41-L81) | Query、重试、读写权限分支、骨架 | 自定义页面壳 |
| `ReadOnlySettings` | `settings.tsx:83`。[源码](../../web/src/settings.tsx#L83-L110) | 只读模型组合与批次上限卡片 | Themes `Card/Badge/Text` |
| `SettingsForm` | `settings.tsx:112`。[源码](../../web/src/settings.tsx#L112-L282) | 模型与批次上限独立草稿/version/mutation；details 展开高级参数 | 自定义领域表单；`details` 可评估 Themes `Accordion`，输入/动作直映 |
| `ProviderPane` | `components/model-composer.tsx:301`，ModelComposer 调用 273。[源码](../../web/src/components/model-composer.tsx#L273-L292) [定义](../../web/src/components/model-composer.tsx#L301-L436) | 当前 provider 搜索、模型多选、禁用原因、截断 | 自定义复合选择器；Themes `TextField/ScrollArea/Checkbox/Badge` + roving focus 语义 |

### 模型服务

| 组件 | 定义/调用 | 状态与交互 | 初步映射 |
|---|---|---|---|
| `ServiceStatus` | `credentials.tsx:212`，provider 列表调用 2471。[源码](../../web/src/credentials.tsx#L212-L226) [调用](../../web/src/credentials.tsx#L2454-L2474) | 选中时反色；健康/凭据/目录状态 Badge | 自定义状态组合 + Themes `Badge`；选中色需与 ProviderPane 统一产品规则 |
| `ModelServiceSetupLayout` | `credentials.tsx:274`。[源码](../../web/src/credentials.tsx#L274-L423) | 三步流程 context、路由步骤、长操作锁定、关闭/离开确认、嵌套 Dialog | 自定义流程组件；Themes `Dialog/Tabs(or Stepper 自定义)/AlertDialog` 组合 |
| `ModelServiceSourcePage` | `credentials.tsx:425`。[源码](../../web/src/credentials.tsx#L425-L509) | provider 搜索、冲突/配置状态、选择内置或自定义 | 自定义来源选择；Themes `TextField/Card/RadioCards` 组合 |
| `BuiltinServiceDiscoverPage` | `credentials.tsx:511`。[源码](../../web/src/credentials.tsx#L511-L595) | 凭据输入、目录发现、阶段状态、返回/继续 | 自定义步骤表单；Themes 表单/Callout |
| `BuiltinServiceVerifyPage` | `credentials.tsx:597`。[源码](../../web/src/credentials.tsx#L597-L718) | 验证模型手填、真实推理、最终提交 | 自定义步骤表单；模型选择可复用统一 Combobox |
| `CustomServiceDiscoverPage` | `credentials.tsx:720`。[源码](../../web/src/credentials.tsx#L720-L883) | provider/base URL/协议/凭据、创建与编辑两态、发现 | 自定义步骤表单；协议适合 Themes `RadioGroup/SegmentedControl` |
| `CustomServiceVerifyPage` | `credentials.tsx:885`。[源码](../../web/src/credentials.tsx#L885-L986) | 验证模型、真实推理、引用阻塞、提交 | 自定义步骤表单；Themes 表单/Callout |
| `StateRows` | `credentials.tsx:988`，概览调用 2259。[源码](../../web/src/credentials.tsx#L988-L1097) [调用](../../web/src/credentials.tsx#L2259-L2260) | 服务、目录、凭据状态明细 | 组合 Themes `DataList/Badge`；与仓库 Kv 重复 |
| `CredentialControls` | `credentials.tsx:1099`，维护调用 2264。[源码](../../web/src/credentials.tsx#L1099-L1351) | 可编辑验证模型组合框、重新验证、配置、删除、两层确认 Dialog | 自定义领域组件；统一 Combobox + Themes `Dialog/AlertDialog` |
| `ReferenceBlockers` | `credentials.tsx:1353`，5 处错误调用。[源码](../../web/src/credentials.tsx#L1353-L1392) [调用](../../web/src/credentials.tsx#L1505) | 全局/仓库引用位置列表 | 自定义领域内容 + Themes `Callout/List` |
| `CustomServiceControls` | `credentials.tsx:1394`，维护调用 2295。[源码](../../web/src/credentials.tsx#L1394-L1551) | 改名、改配置、删除及引用阻塞 Dialog | 自定义领域组件；Themes `Dialog/AlertDialog` |
| `CatalogControls` | `credentials.tsx:1553`，维护/模型两处调用。[源码](../../web/src/credentials.tsx#L1553-L1761) [调用](../../web/src/credentials.tsx#L2299-L2310) | 刷新目录、手填模型、补录列表、删除确认 | 自定义领域组件；Themes 表单、Dialog、ScrollArea |
| `CostValue` | `credentials.tsx:1763`，发现/运行规格调用。[源码](../../web/src/credentials.tsx#L1763-L1785) [调用](../../web/src/credentials.tsx#L2035-L2052) | 未知/每百万输入输出费用格式 | 自定义格式化 + Themes `Text` |
| `ModelsTable` | `credentials.tsx:1815`，模型 tab 调用 2314。[源码](../../web/src/credentials.tsx#L1815-L2017) [调用](../../web/src/credentials.tsx#L2314) | 筛选、独立滚动、批量勾选、批量启停、桌面/移动布局 | 自定义领域数据列表；Themes `Table/Checkbox/TextField/ScrollArea/Toolbar` 组合 |
| `ModelDiscoveryDifference` | `credentials.tsx:2019`，模型行调用 2008。[源码](../../web/src/credentials.tsx#L2019-L2039) | 发现规格与运行规格有差异时 details 展开 | 自定义渐进信息；Themes `Accordion/DataList` |
| `ModelRuntimeFacts` | `credentials.tsx:2041`，模型行调用 2007。[源码](../../web/src/credentials.tsx#L2041-L2057) | 输入、推理、上下文、最大输出、费用与来源 | 组合 Themes `DataList/Badge/Text` |
| `ModelAvailability` | `credentials.tsx:2059`，模型行调用 2003。[源码](../../web/src/credentials.tsx#L2059-L2077) | 已停用或不可用状态 Badge；正常态无重复文案 | 自定义状态规则 + Themes `Badge` |
| `RunCapabilityCard` | `credentials.tsx:2079`，概览调用 2247。[源码](../../web/src/credentials.tsx#L2079-L2135) | 服务端可运行能力、能力列表、阻塞原因 | 自定义领域卡 + Themes `Card/Badge/List` |
| `ReferenceOverview` | `credentials.tsx:2137`，概览调用 2260。[源码](../../web/src/credentials.tsx#L2137-L2187) | 全局/跟随仓库/覆盖仓库引用数量与 details 展开 | 自定义领域卡；Themes `DataList/Accordion/Badge` |
| `ServiceDetail` | `credentials.tsx:2189`，主页面调用 2507。[源码](../../web/src/credentials.tsx#L2189-L2325) [调用](../../web/src/credentials.tsx#L2507-L2518) | provider 标题、overview/maintenance/models Tab、权限动作与分区内容 | 自定义领域详情；Tabs 应直映 Themes `Tabs` |
| `LoadingLayout` | `credentials.tsx:2327`，主页面读取态调用 2403。[源码](../../web/src/credentials.tsx#L2327-L2341) [调用](../../web/src/credentials.tsx#L2403) | 主从骨架布局 | 组合 Themes `Grid/Skeleton` |
| `ModelServicesPage` | `credentials.tsx:2345`。[源码](../../web/src/credentials.tsx#L2345-L2521) | provider 主从选择、空/错误/读取、添加入口、稳定路由 Tab | 自定义领域页；Themes `ScrollArea/Card/Tabs` + 产品 master-detail |

## 4. 重复交互模式与迁移边界

| 重复模式 | 现有证据 | 迁移结论 |
|---|---|---|
| 页面骨架 | `PageHeader`/`PageBody` 已被仓库、记录、统计、策略、访问控制复用。[定义](../../web/src/components/page-header.tsx#L12-L36) [调用](../../web/src/runs.tsx#L270-L279) | 用 Themes 布局组件重写内部实现，保留产品级 `PageHeader/PageBody` API |
| 主从列表选中 | 仓库列表在页内手写选中样式。[源码](../../web/src/repos.tsx#L136-L163)；模型服务另写一份。[源码](../../web/src/credentials.tsx#L2442-L2477)；ModelComposer provider 再写一份。[源码](../../web/src/components/model-composer.tsx#L201-L239) | 建立一个产品级 `MasterList`/`SelectableItem` 状态规范；视觉和 ARIA 从共享配方产生，避免页面各写 utility |
| Tab/当前位置 | 应用导航由 TanStack Link active props 实现。[源码](../../web/src/main.tsx#L132-L156)；模型详情 Tab 由三条 Link 手写下划线。[源码](../../web/src/credentials.tsx#L2208-L2237) | 页面 Tab 直映 Themes Tabs，但稳定 URL 仍由 Router 驱动；统一 current/hover/focus 语义 |
| 弹窗与确认 | 仓库 2 组、访问控制 2 组、模型服务 8 组以上受控 Dialog。[仓库](../../web/src/repos.tsx#L518-L539) [访问控制](../../web/src/access-control.tsx#L378-L450) [模型服务](../../web/src/credentials.tsx#L351-L406) | 普通表单用 `Dialog`；破坏性确认用 `AlertDialog`；大三步流程保留领域壳并统一关闭后路由状态恢复 |
| 可搜索单选 | 仓库注册使用 Dialog+Command。[源码](../../web/src/repos.tsx#L627-L702)；验证模型使用 Popover+Command。[源码](../../web/src/credentials.tsx#L1198-L1238) | 抽成可访问的 `Combobox` 产品组件；Radix 负责 Popover/Dialog/焦点，项目负责异步搜索和 option 状态 |
| 两态/筛选选择 | 仓库覆盖两态用 Button 手写。[源码](../../web/src/repos.tsx#L748-L776)；评审记录过滤片也用 Button 手写。[源码](../../web/src/runs.tsx#L281-L324) | 单选语义用 Themes `SegmentedControl` 或 `RadioGroup`；筛选/模式切换不要继续复制按钮选中类 |
| 批量勾选 | 模型页直接使用原生 checkbox 并维护 Set。[源码](../../web/src/credentials.tsx#L1815-L1895)；权限矩阵也直接使用 checkbox。[源码](../../web/src/access-control.tsx#L329-L368) | 直映 Themes/Primitive Checkbox；统一 checked/indeterminate/disabled/label 与触控区域 |
| 状态与反馈 | `Badge` 被 RunPill、服务、仓库、模型重复赋予产品状态色。[评审](../../web/src/runs.tsx#L67-L109) [服务](../../web/src/credentials.tsx#L212-L226) [仓库](../../web/src/repos.tsx#L326-L344) | 建立产品级 `StatusBadge` 枚举；Themes Badge 只承担外观，领域状态映射集中维护 |
| 详情数据列表 | 仓库 `Kv`、服务 `StateRows`、模型 `ModelRuntimeFacts` 都是标签/值结构。[仓库](../../web/src/repos.tsx#L68-L75) [服务](../../web/src/credentials.tsx#L988-L1097) [模型](../../web/src/credentials.tsx#L2041-L2057) | 统一为 Themes `DataList` 的产品包装，解决列宽、换行和窄屏规则 |
| 展开详情 | 设置用原生 `details`。[源码](../../web/src/settings.tsx#L227-L279)；模型差异与引用概览也用 `details`。[源码](../../web/src/credentials.tsx#L2019-L2039) [源码](../../web/src/credentials.tsx#L2137-L2187) | 统一评估 Themes `Accordion`；保留原生 details 需集中样式与图标规则 |
| 读取/错误/空态 | Skeleton 已共享，错误与空态仍在各页手写 Card。[模型服务](../../web/src/credentials.tsx#L2393-L2439) [仓库](../../web/src/repos.tsx#L169-L206) [统计](../../web/src/stats.tsx#L223-L304) | 保留 `Skeleton`；新增最小 `EmptyState`/`ErrorState` 产品组件，基于 Themes `Card/Callout/Button` |

## 5. 初步迁移优先级

1. 先按 ADR 0011 与 `DESIGN.md` 建立 Radix Themes 根主题、颜色/字号/间距/圆角 token 和状态映射；迁移前的代码仍由 Tailwind utility 决定具体状态。[ADR 0011](../adr/0011-radix-themes-as-panel-visual-system.md) [DESIGN.md](../../web/DESIGN.md)
2. 用 Themes 直接替换 Button、Badge、Card、TextField、Table、Skeleton、Dialog、Popover、Tooltip、Tabs、Checkbox、Select/Radio 等通用层，保留产品组件 API。
3. 先抽 `StatusBadge`、`DataList`、`SelectableItem/MasterList`、`Combobox`、`EmptyState/ErrorState` 五个重复模式，再迁页面。它们直接对应当前不一致和重复最多的代码位置。
4. `ModelComposer`、模型服务三步配置、`ModelsTable`、仓库主从页属于领域组件。保留功能和状态模型，内部改用 Themes；需要的焦点、弹层、选择和确认行为由 Primitives 承担。
5. Calendar 与异步 Combobox 无法靠单个 Themes 组件完成。Calendar 保留 `react-day-picker` 的日期逻辑；Combobox 需基于 Popover/Dialog、TextField、ScrollArea 和自定义 listbox 状态组合。最终选择应以官方能力研究为准。
