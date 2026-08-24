# MultiReviewer Web：Radix UI 当前实现清单

> 盘点日期：2026-08-24。结论来自当前 [`web/package.json`](../../web/package.json#L11-L31)、[`web/src`](../../web/src/main.tsx#L1-L49) 与 [`web/DESIGN.md`](../../web/DESIGN.md#L35-L45)。本文记录实际代码，不沿用迁移计划中的数量、文件名或待办。

## 范围与计数口径

- “具名渲染组件”指 PascalCase 的 React 函数组件。重载声明只计实现一次；`React.lazy` 路由别名、类型、Hook、普通函数和直接转出的 Themes 组件不计。
- 页面层统计 `web/src` 根目录下 9 个路由或页面 TSX；共享层统计 `web/src/components`，另计根目录的 `SetupChecklist`。
- 当前共有 **50 个页面层具名渲染组件**、**23 个共享层具名渲染组件**，合计 **73 个**。[`Button` 只是 Themes Button 的类型修正别名](../../web/src/components/theme-button.ts#L15)，`useDialogReturnFocus` 是 Hook；两者均不新增组件实现或 DOM，因此不计。
- `web/src/components` 当前有 **15 个模块**；下表逐个列出，没有未归属的共享模块。

## 1. 依赖分层

| 层 | 当前依赖 | 保留理由与代码证据 |
|---|---|---|
| 通用视觉 | `@radix-ui/themes` | 唯一通用视觉系统；Theme、表单、数据展示和浮层均直接使用。依赖见 [`package.json`](../../web/package.json#L12-L13)，唯一 Theme 配置见 [`panel-theme.tsx`](../../web/src/components/panel-theme.tsx#L5)。 |
| 行为与组合 | `radix-ui` | Themes 未覆盖的 `Collapsible` 与 `Slot`。前者用于展开详情，例如 [`runs.tsx`](../../web/src/runs.tsx#L183)；后者用于 Link/button 共用表面，[`master-list-item.tsx`](../../web/src/components/master-list-item.tsx#L49-L69)。 |
| 业务图标 | `@radix-ui/react-icons` | TSX 中全部通用图标的唯一来源；依赖见 [`package.json`](../../web/package.json#L12)。品牌标记是明确例外。 |
| 专用行为 | `cmdk`、`react-day-picker` | 分别保留搜索列表的键盘行为和日期区间行为；日期和可编辑 model id 已有单一产品入口。[`editable-model-combobox.tsx`](../../web/src/components/editable-model-combobox.tsx#L22) [`date-range-picker.tsx`](../../web/src/components/date-range-picker.tsx#L31) |
| 路由与服务端状态 | `@tanstack/react-router`、`@tanstack/react-query` | 稳定 URL、权限重定向、缓存、mutation 与失效；页面通过 `React.lazy + Suspense` 按路由加载。[`main.tsx`](../../web/src/main.tsx#L35-L49) |
| 布局与 class 合并 | Tailwind v4、`clsx`、`tailwind-merge` | Tailwind 负责壳、网格、响应式和局部滚动；`cn()` 只合并 className。[`package.json`](../../web/package.json#L16-L22) [`utils.ts`](../../web/src/lib/utils.ts#L1-L6) |
| 运行与构建 | React 19、React DOM、Vite、TypeScript | SPA 运行时和静态构建。[`package.json`](../../web/package.json#L19-L31) |

当前 `package.json` 没有零引用的 UI 依赖。`lucide-react`、`class-variance-authority` 与 `tw-animate-css` 已从依赖和锁文件移除。

## 2. 全部共享模块与归属

| 文件 | 当前职责 | 实际调用点 |
|---|---|---|
| [`date-range-picker.tsx`](../../web/src/components/date-range-picker.tsx#L31) | 受控 `{from,to}` 日期区间；内部管理 Themes Popover、双月 Calendar、本地日期转换与窄屏边界。 | 只由处置率页调用，[`stats.tsx`](../../web/src/stats.tsx#L167)。 |
| [`editable-model-combobox.tsx`](../../web/src/components/editable-model-combobox.tsx#L22) | 可手填 model id，也可在自动发现目录中搜索选择；内部组合 Themes Popover/TextField 与 cmdk。 | 模型服务发现、验证和重新验证三处，[`credentials.tsx`](../../web/src/credentials.tsx#L786) [`credentials.tsx`](../../web/src/credentials.tsx#L1101) [`credentials.tsx`](../../web/src/credentials.tsx#L1334)。 |
| [`empty-state.tsx`](../../web/src/components/empty-state.tsx#L15) | 资源为空、筛选无结果和零权限的紧凑状态；`titleAs` 保留调用点的标题层级。 | 访问控制、模型组合、仓库、模型服务、处置率和零权限页；代表调用见 [`access-control.tsx`](../../web/src/access-control.tsx#L375)、[`credentials.tsx`](../../web/src/credentials.tsx#L2146)、[`main.tsx`](../../web/src/main.tsx#L447)。 |
| [`help-tooltip.tsx`](../../web/src/components/help-tooltip.tsx#L14) | 唯一帮助说明入口；Themes Tooltip + IconButton，带可访问名称和窄屏触控尺寸。 | 访问控制、首次配置、仓库、模型组合、模型服务、处置率、审查策略；代表调用见 [`access-control.tsx`](../../web/src/access-control.tsx#L364) 与 [`settings.tsx`](../../web/src/settings.tsx#L254)。 |
| [`mark.tsx`](../../web/src/components/mark.tsx#L7) | MultiReviewer 自绘品牌标记。 | 登录、改密和应用壳；代表调用见 [`main.tsx`](../../web/src/main.tsx#L141)。 |
| [`master-list-item.tsx`](../../web/src/components/master-list-item.tsx#L49) | 主从列表当前项的唯一表面；`asChild` 路由项输出 `aria-current`，页内按钮输出 `aria-pressed`；`MasterListItemText` 管深浅表面的辅助与异常文字。 | 模型组合、仓库、模型服务：[`model-composer.tsx`](../../web/src/components/model-composer.tsx#L254) [`repos.tsx`](../../web/src/repos.tsx#L139) [`credentials.tsx`](../../web/src/credentials.tsx#L2799)。 |
| [`model-composer.tsx`](../../web/src/components/model-composer.tsx#L81) | 全局组合与仓库覆盖共用的受控两栏模型选择器；只读统一候选并回报失效选择。 | 审查策略 [`settings.tsx`](../../web/src/settings.tsx#L194)；仓库覆盖 [`repos.tsx`](../../web/src/repos.tsx#L831)。 |
| [`page-body.tsx`](../../web/src/components/page-body.tsx#L8) | `wide` / `form` 两档正文宽度、间距和页尾留白。 | 访问控制、评审记录、处置率、仓库、审查策略；代表调用见 [`runs.tsx`](../../web/src/runs.tsx#L303)。 |
| [`page-header.tsx`](../../web/src/components/page-header.tsx#L12) | 粘性页面标题、说明和唯一动作槽。 | 六个业务页；代表调用见 [`repos.tsx`](../../web/src/repos.tsx#L106) 与 [`credentials.tsx`](../../web/src/credentials.tsx#L2703)。 |
| [`panel-theme.tsx`](../../web/src/components/panel-theme.tsx#L5) | 唯一 Theme 根：亮色、gray、solid panel、small radius、95% scaling。 | 应用根 [`main.tsx`](../../web/src/main.tsx#L505)。 |
| [`status-badge.tsx`](../../web/src/components/status-badge.tsx#L41) | `neutral/success/warning/error` 四态的唯一产品出口，统一颜色、图标和深色表面变体。 | 访问控制、评审记录、模型组合、仓库、模型服务；代表调用见 [`runs.tsx`](../../web/src/runs.tsx#L75) 与 [`credentials.tsx`](../../web/src/credentials.tsx#L215)。 |
| [`theme-button.ts`](../../web/src/components/theme-button.ts#L15) | 修正 Themes 3.3.0 在 `exactOptionalPropertyTypes` 下的 `highContrast` 类型；运行时仍是原始 Radix Button。 | 业务 TSX 统一从此导入；代表调用见 [`access-control.tsx`](../../web/src/access-control.tsx#L348)。 |
| [`ui/calendar.tsx`](../../web/src/components/ui/calendar.tsx#L14) | `react-day-picker` 行为适配；月份导航用 Themes IconButton，日期用 Themes Button，窄屏单元为 44px。 | 只由 `DateRangePicker` 调用，[`date-range-picker.tsx`](../../web/src/components/date-range-picker.tsx#L60)；触控尺寸定义见 [`calendar.tsx`](../../web/src/components/ui/calendar.tsx#L33)。 |
| [`ui/command.tsx`](../../web/src/components/ui/command.tsx#L7) | cmdk 的 Root/Input/List/Empty/Group/Item 外观与触控适配；`CommandInput` 默认提供可访问名称。 | `EditableModelCombobox` [`editable-model-combobox.tsx`](../../web/src/components/editable-model-combobox.tsx#L88)；仓库搜索 [`repos.tsx`](../../web/src/repos.tsx#L662)。 |
| [`use-dialog-return-focus.ts`](../../web/src/components/use-dialog-return-focus.ts#L15) | 受控 Dialog / AlertDialog 在触发事件时记录真实元素，关闭时恢复；触发元素卸载后使用稳定后备入口。 | 访问控制、仓库、模型服务：[`access-control.tsx`](../../web/src/access-control.tsx#L76) [`repos.tsx`](../../web/src/repos.tsx#L280) [`credentials.tsx`](../../web/src/credentials.tsx#L308)。 |
| [`setup-checklist.tsx`](../../web/src/setup-checklist.tsx#L28) | 首次配置状态查询、权限裁剪和三步检查单。 | 所有业务页的共同外壳 [`main.tsx`](../../web/src/main.tsx#L266)。 |

另有两个放在页面文件中的跨页产品组件：[`RunPill`](../../web/src/runs.tsx#L72) 同时供评审记录和仓库最近记录使用，[调用点](../../web/src/repos.tsx#L969)；[`SummaryRate`](../../web/src/stats.tsx#L90) 供评审记录页头使用，[调用点](../../web/src/runs.tsx#L301)。

## 3. 页面级具名组件计数

| 文件 | 数量 | 计入名称 |
|---|---:|---|
| [`access-control.tsx`](../../web/src/access-control.tsx#L69) | 2 | `AccessControlPage`、`CreateDialog` |
| [`credentials.tsx`](../../web/src/credentials.tsx#L206) | 22 | `ServiceStatus`、6 个配置/发现/验证路由组件、`StateRows`、`CredentialControls`、`ReferenceBlockers`、`CustomServiceControls`、`CatalogControls`、`CostValue`、`ModelsTable`、`ModelDiscoveryDifference`、`ModelRuntimeFacts`、`ModelAvailability`、`RunCapabilityCard`、`ReferenceOverview`、`ServiceDetail`、`LoadingLayout`、`ModelServicesPage` |
| [`login.tsx`](../../web/src/login.tsx#L12) | 1 | `LoginPage` |
| [`main.tsx`](../../web/src/main.tsx#L55) | 5 | `PageLoading`、`Shell`、`BusinessPage`、`ModelServicesRoutePage`、`ZeroPermissionPage` |
| [`password.tsx`](../../web/src/password.tsx#L12) | 1 | `PasswordPage` |
| [`repos.tsx`](../../web/src/repos.tsx#L64) | 6 | `Kv`、`ReposPage`、`RepoDetail`、`RegisterDialogContent`、`ReviewersEditor`、`RepoRuns` |
| [`runs.tsx`](../../web/src/runs.tsx#L72) | 6 | `RunPill`、`RunStatus`、`RunModels`、`RunUsage`、`RunTime`、`RunsPage` |
| [`settings.tsx`](../../web/src/settings.tsx#L40) | 3 | `SettingsPage`、`ReadOnlySettings`、`SettingsForm` |
| [`stats.tsx`](../../web/src/stats.tsx#L49) | 4 | `Bar`、`Rate`、`SummaryRate`、`StatsPage` |
| **合计** | **50** | 页面层总数 |

共享层的 23 个由 `components/` 中 22 个具名渲染函数加 `SetupChecklist` 组成。`MasterListItem` 的两个重载声明只算一个实现；`Button` 类型别名与 `useDialogReturnFocus` 不计。项目总数是 **73**。

## 4. Radix 实际使用面

### Radix Themes

当前实际使用 **21 类** Themes 组件：

- 根与布局：`Theme`、`Box`、`Flex`、`Card`。
- 文字、状态与反馈：`Text`、`Badge`、`Callout`、`Progress`、`Skeleton`。
- 表单与选择：`Button`、`IconButton`、`TextField`、`Select`、`Checkbox`、`SegmentedControl`。
- 浮层与导航：`Dialog`、`AlertDialog`、`Popover`、`Tooltip`、`TabNav`。
- 数据表：`Table`。

Skeleton 由页面直接从 Themes 导入；源码没有 Skeleton wrapper，也没有 `styles.css` 页面级 Skeleton 覆盖。代表调用见 [`runs.tsx`](../../web/src/runs.tsx#L362) 与 [`credentials.tsx`](../../web/src/credentials.tsx#L2660)。

### Radix Primitives

`radix-ui` 单包只实际提供两类行为：

- `Collapsible.Root/Trigger/Content`：模型服务发现差异与引用、评审失败详情、批次上限、移动端统计详情。[`credentials.tsx`](../../web/src/credentials.tsx#L2329) [`runs.tsx`](../../web/src/runs.tsx#L183) [`settings.tsx`](../../web/src/settings.tsx#L241) [`stats.tsx`](../../web/src/stats.tsx#L273)
- `Slot.Root`：把统一主从选择表面组合到 Router Link 或辅助文字元素。[`master-list-item.tsx`](../../web/src/components/master-list-item.tsx#L56) [`master-list-item.tsx`](../../web/src/components/master-list-item.tsx#L91)

## 5. Radix Icons 清单

当前有 **21 个不同图标**：

| 图标 | 固定语义 | 代表调用 |
|---|---|---|
| `ArrowLeftIcon` | 返回列表 | [`repos.tsx`](../../web/src/repos.tsx#L180)、[`credentials.tsx`](../../web/src/credentials.tsx#L2861) |
| `CalendarIcon` | 日期范围 | [`date-range-picker.tsx`](../../web/src/components/date-range-picker.tsx#L47) |
| `CheckIcon` | 当前选项、能力成立 | [`editable-model-combobox.tsx`](../../web/src/components/editable-model-combobox.tsx#L106) |
| `CheckCircledIcon` | 完成、成功 | [`status-badge.tsx`](../../web/src/components/status-badge.tsx#L26) |
| `ChevronDownIcon` | 展开、下拉 | [`settings.tsx`](../../web/src/settings.tsx#L249) |
| `ChevronLeftIcon` | 上个月 | [`ui/calendar.tsx`](../../web/src/components/ui/calendar.tsx#L139) |
| `ChevronRightIcon` | 下个月 | [`ui/calendar.tsx`](../../web/src/components/ui/calendar.tsx#L145) |
| `Cross2Icon` | 关闭、移除 | [`model-composer.tsx`](../../web/src/components/model-composer.tsx#L220) |
| `CrossCircledIcon` | 失败、错误 | [`status-badge.tsx`](../../web/src/components/status-badge.tsx#L28) |
| `ExclamationTriangleIcon` | 警告、部分失败 | [`stats.tsx`](../../web/src/stats.tsx#L94) |
| `ExitIcon` | 退出登录 | [`main.tsx`](../../web/src/main.tsx#L162) |
| `InfoCircledIcon` | 中性状态 | [`status-badge.tsx`](../../web/src/components/status-badge.tsx#L24) |
| `LockClosedIcon` | 系统管理员权限说明 | [`access-control.tsx`](../../web/src/access-control.tsx#L372) |
| `MagnifyingGlassIcon` | 搜索 | [`ui/command.tsx`](../../web/src/components/ui/command.tsx#L33) |
| `MinusCircledIcon` | 已停用 | [`credentials.tsx`](../../web/src/credentials.tsx#L2374) |
| `PlusIcon` | 新建 | [`access-control.tsx`](../../web/src/access-control.tsx#L227) |
| `QuestionMarkCircledIcon` | 帮助说明 | [`help-tooltip.tsx`](../../web/src/components/help-tooltip.tsx#L31) |
| `ReloadIcon` | 刷新目录 | [`credentials.tsx`](../../web/src/credentials.tsx#L1852) |
| `ResetIcon` | 重置密码 | [`access-control.tsx`](../../web/src/access-control.tsx#L348) |
| `TrashIcon` | 删除 | [`access-control.tsx`](../../web/src/access-control.tsx#L349) |
| `UpdateIcon` | Hook 漂移、待同步 | [`repos.tsx`](../../web/src/repos.tsx#L345) |

## 6. 自绘 SVG 与浏览器原生控件

- 品牌 SVG 只有 [`Mark`](../../web/src/components/mark.tsx#L7)；favicon 使用同一三横线图形的内联 data URI，[`index.html`](../../web/index.html#L11-L18)。
- TSX 源码没有直接渲染原生 `input`、`select`、`textarea`、`details`、`dialog` 或 `progress` 控件；相应职责由 Themes、Collapsible、cmdk 与 react-day-picker 承担。
- 唯一直接渲染的浏览器原生交互控件是 [`MasterListItem` 的 `<button>`](../../web/src/components/master-list-item.tsx#L69)。这里需要和 `Slot.Root + Link` 共用同一产品表面，并输出 `aria-pressed`，保留原生按钮语义合理。

原生 `aside/nav/main/header/section/article/form/label/fieldset/legend` 只提供文档、提交与表单语义，不形成第二套视觉组件。

## 7. shadcn、Lucide 与旧实现移除证据

- 当前 [`package.json`](../../web/package.json#L11-L31) 与 `pnpm-lock.yaml` 均不含 `lucide-react`、`class-variance-authority`、`tw-animate-css` 或 shadcn 包。
- `web/src/**/*.tsx` 中不存在旧 `components/ui/button|card|dialog|badge|input|label|select|table|skeleton` 引用；当前 `components/ui` 只保留 [`calendar.tsx`](../../web/src/components/ui/calendar.tsx#L14) 与 [`command.tsx`](../../web/src/components/ui/command.tsx#L7)。
- 当前 `web/` 根目录没有 `components.json`，迁移前的 provider 专用选择项文件和导出也已移除。
- Card、Dialog、Table、TextField 和 Skeleton 由页面直接使用 Themes；通用 Button 经 [`theme-button.ts`](../../web/src/components/theme-button.ts#L15) 原样转出。

复核命令：

```sh
rg -n 'lucide-react|class-variance-authority|tw-animate-css' web/src web/package.json pnpm-lock.yaml
rg --files web/src/components/ui
rg -n '<(button|input|select|textarea|details|dialog|progress)\\b' web/src --glob '*.tsx'
```

第一条应无结果；第二条只列 Calendar 与 Command；第三条只列 `MasterListItem` 的原生 button。

## 8. 路由、主从布局与焦点返回

- 七个普通页面各自使用 `React.lazy`；模型服务七个路由入口共享同一个 `credentials.tsx` 动态模块，[`main.tsx`](../../web/src/main.tsx#L35-L49)。应用壳以 `Suspense` 提供统一加载态，[`main.tsx`](../../web/src/main.tsx#L227-L230)。
- 应用壳在 `sm=640px` 切换侧栏；仓库与模型服务的主从双栏统一在 `lg=1024px` 切换。仓库列表/详情见 [`repos.tsx`](../../web/src/repos.tsx#L115-L181)，模型服务列表/详情见 [`credentials.tsx`](../../web/src/credentials.tsx#L2780-L2865)。640–1023px 只显示列表或详情。
- 仓库列表和详情各自 `overflow-y-auto`；模型服务列表和详情也各自滚动。模型服务以 provider 路由维持稳定地址，仓库以 `selectedId=null` 表示窄屏列表态。
- 受控浮层通过 `useDialogReturnFocus` 在事件发生时记录触发元素，并在 `onCloseAutoFocus` 或成功 mutation 后恢复。当前覆盖访问控制、仓库移除、配置流离开确认、凭据维护、服务迁移/删除和手动来源删除；代表调用见 [`access-control.tsx`](../../web/src/access-control.tsx#L76-L445)、[`repos.tsx`](../../web/src/repos.tsx#L280-L550)、[`credentials.tsx`](../../web/src/credentials.tsx#L308-L488)。

## 9. DESIGN 映射与运行时验证

| DESIGN 契约 | 当前源码映射 | 状态 |
|---|---|---|
| 唯一 Theme 根与职责分层 | [`PanelTheme`](../../web/src/components/panel-theme.tsx#L5)、依赖分层见本文第 1 节 | 源码完成 |
| 页面骨架与共享状态 | [`PageHeader`](../../web/src/components/page-header.tsx#L12)、[`PageBody`](../../web/src/components/page-body.tsx#L8)、[`StatusBadge`](../../web/src/components/status-badge.tsx#L41)、[`EmptyState`](../../web/src/components/empty-state.tsx#L15) | 源码完成 |
| 主从列表当前项唯一表面 | [`MasterListItem`](../../web/src/components/master-list-item.tsx#L49) 在模型组合、仓库、模型服务三处复用 | 源码完成 |
| 模型多选、权限多选 | Themes Checkbox 见 [`model-composer.tsx`](../../web/src/components/model-composer.tsx#L413) 与 [`access-control.tsx`](../../web/src/access-control.tsx#L419) | 源码完成 |
| 专用行为单一产品入口 | [`DateRangePicker`](../../web/src/components/date-range-picker.tsx#L31)、[`EditableModelCombobox`](../../web/src/components/editable-model-combobox.tsx#L22) | 源码完成 |
| 空态与焦点返回 | [`EmptyState`](../../web/src/components/empty-state.tsx#L15)、[`useDialogReturnFocus`](../../web/src/components/use-dialog-return-focus.ts#L15) | 源码完成 |
| 图标统一 | 21 个业务图标全部来自 Radix Icons；品牌 SVG 单列 | 源码完成 |
| `lg` 主从布局与局部滚动 | 仓库、模型服务均使用 `h-full/min-h-0`、单层返回入口与两侧局部滚动 | 源码完成，需运行时确认 |
| 按路由加载 | 页面使用 `React.lazy + Suspense`，模型服务子路由共用动态模块 | 源码完成，需浏览器网络面板确认产物加载 |

仍需按 [`DESIGN.md` 部署交付验收清单](../../web/DESIGN.md#L354-L370) 在部署实例验证：

1. MasterListItem 的默认、hover、focus、Badge 组合对比度，以及主导航与 Tab 当前态。
2. 95% scaling、small radius、桌面密度和 390px 下的 44px 触控目标。
3. 仓库、模型服务、评审记录与模型组合的确定高度、局部滚动、粘性表头和批量操作栏。
4. 640–1023px 单层列表／详情和 1024px 以上双栏切换；前进、后退、刷新与返回入口。
5. 多步 Dialog 的焦点进入/返回、取消后底层 provider/Tab/滚动恢复、触发元素卸载后的后备焦点、矮屏内部滚动。
6. DateRangePicker、EditableModelCombobox 与 EmptyState 的鼠标、键盘、长内容和窄屏行为。
7. 路由分块的实际网络加载，以及加载、错误、禁用和动态反馈在真实数据下的可读性。

本清单只证明源码结构和静态映射；运行时继续按项目规范使用部署实例与 ego-browser 验收。
