# MultiReviewer 图标与视觉符号清单（迁移前基线）

> 历史资料：本文记录迁移前的 Lucide 与浏览器原生符号，用于核对替换范围。文中的“当前”均指盘点当时的代码，不代表现状；现状以 `radix-ui-current-inventory.md` 为准。

盘点范围：`web/src/**/*`、`web/index.html`、`web/package.json`。统计基于源码静态渲染位置，不把循环产生的运行时实例数计入引用次数，也不把普通标点算作图标。

## 结论

- 当前唯一专用图标库是 `lucide-react@1.31.0`；共导入 22 个不同组件名，出现 53 个直接 JSX 渲染位置，另有 1 个按状态动态渲染位置。
- `radix-ui@1.6.7` 当前只提供 Primitive 与 `Slot`。源码没有导入 Radix 图标，依赖中也没有 `@radix-ui/react-icons`。
- 产品标记由 1 份手绘图形以 React SVG 和 favicon data URI 两种形式维护，应作为品牌资产保留。
- 浏览器仍负责 4 处 checkbox、2 处 select 和 4 处可见的 details disclosure marker；迁移到 Radix 时必须纳入组件范围。
- 源码未发现 emoji。用户可见的非文字字符只有分隔、范围、空值和加载标点，不应误迁成装饰图标。

## Lucide 清单

“次数”是直接 JSX 标签数。`ServiceStatus` 的动态图标另列，不重复计入 53。

| Lucide 图标 | 次数 | 文件与行号 | 当前用途 | Radix 迁移候选 |
|---|---:|---|---|---|
| `AlertTriangle` | 1 | `credentials.tsx:1358` | 模型引用阻塞 | `ExclamationTriangleIcon` |
| `CalendarIcon` | 1 | `stats.tsx:201` | 日期范围入口 | `CalendarIcon` |
| `Check` | 2 | `credentials.tsx:1235,2119` | 组合框当前项、服务可运行 | `CheckIcon`；服务状态可用 `CheckCircledIcon` |
| `ChevronDown` | 2 | `credentials.tsx:1207`; `stats.tsx:333` | 展开模型下拉、展开模型统计 | `ChevronDownIcon` |
| `ChevronDownIcon` | 1 | `components/ui/calendar.tsx:159` | 日历非左右方向箭头 | `ChevronDownIcon` |
| `ChevronLeftIcon` | 1 | `components/ui/calendar.tsx:148` | 上一月 | `ChevronLeftIcon` |
| `ChevronRightIcon` | 1 | `components/ui/calendar.tsx:154` | 下一月 | `ChevronRightIcon` |
| `CircleAlert` | 7 | `runs.tsx:88,119,141`; `stats.tsx:135,229`; `repos.tsx:342,389` | 部分失败、待处置、读取失败、Hook 差异 | `ExclamationTriangleIcon` 或 `ExclamationCircledIcon`；同一状态统一一种 |
| `CircleCheck` | 6 | `runs.tsx:122,131,141,292`; `repos.tsx:337,371` | 完成、无可处置项、成功反馈、Hook 正常 | `CheckCircledIcon` |
| `CircleDashed` | 1 | `repos.tsx:327` | Hook 核对中 | `UpdateIcon` 并旋转，或改用 Skeleton 文本状态 |
| `CircleHelp` | 1 | `components/help-tooltip.tsx:32` | 帮助提示触发器 | `QuestionMarkCircledIcon` |
| `CircleX` | 12 | `runs.tsx:71,114,290,302`; `repos.tsx:183,192,332,369,381,890`; `credentials.tsx:2068,2120` | 失败、错误反馈、不可用 | `CrossCircledIcon` |
| `KeyRound` | 1 | `access-control.tsx:285` | 重置密码 | `ResetIcon`；按钮已有文字时也可删除图标 |
| `LogOut` | 2 | `main.tsx:139,180` | 桌面和窄屏登出 | `ExitIcon`；两处应由同一导航动作组件输出 |
| `Plus` | 3 | `access-control.tsx:210,211,312` | 新建角色、用户 | `PlusIcon`；空态里的“新建角色”可只保留文字 |
| `RefreshCw` | 1 | `credentials.tsx:1629` | 刷新模型目录及进行中旋转 | `ReloadIcon` |
| `Search` | 1 | `credentials.tsx:1905` | 模型筛选框前缀 | `MagnifyingGlassIcon` |
| `SearchIcon` | 1 | `components/ui/command.tsx:32` | Command 搜索框前缀 | `MagnifyingGlassIcon`；与上一行统一组件名 |
| `ShieldCheck` | 1 | `access-control.tsx:299` | 系统管理员说明 | 装饰性较强，优先删除；保留时可用 `LockClosedIcon` |
| `Trash2` | 5 | `access-control.tsx:286,324`; `credentials.tsx:1262,1462,1754` | 删除用户、角色、凭据、服务、来源 | `TrashIcon`；带“删除”文字的按钮可评估删除重复图标 |
| `X` | 1 | `components/model-composer.tsx:184` | 移除已选模型的纯图标按钮 | `Cross2Icon`，保留可访问名称 |
| `XIcon` | 1 | `components/ui/dialog.tsx:75` | Dialog 右上关闭 | `Cross2Icon`，保留 `sr-only` 名称并改为中文 |

### 动态与共享调用

- `credentials.tsx:215-225` 在 `ServiceStatus` 中按状态选择 `Check` 或 `CircleX`，这是 1 个动态渲染位置；组件在 `credentials.tsx:2471` 调用。
- `HelpTooltip` 的 `CircleHelp` 由 13 个调用位置共享：`access-control.tsx:301,341`、`components/model-composer.tsx:137`、`credentials.tsx:1336,1443,1617,1649,2279,2378`、`repos.tsx:414`、`settings.tsx:234`、`setup-checklist.tsx:90`、`stats.tsx:191`。
- `Dialog` 的 `XIcon` 由 12 个 `DialogContent` 共享：`access-control.tsx:379,421`、`credentials.tsx:352,382,394,1316,1347,1473,1526,1722`、`repos.tsx:519,628`。
- `Command` 的 `SearchIcon` 由 2 个 `CommandInput` 共享：`credentials.tsx:1215`、`repos.tsx:635`。
- Calendar 的三个 Chevron 由 `react-day-picker` 的 `Chevron` 槽统一输出，调用入口在 `stats.tsx:208`。

## Radix、手绘与内联图形

### Radix 当前状态

- `radix-ui` 的视觉相关导入只有 Primitive 和 `Slot`：`components/help-tooltip.tsx:3`、`components/ui/dialog.tsx:2`、`label.tsx:2`、`popover.tsx:2`、`badge.tsx:3`、`button.tsx:3`。
- 没有 Radix 图标导入。`radix-ui` Primitive 本身不替业务界面提供上述图标。
- 迁移需要显式增加 `@radix-ui/react-icons`，并在共享组件层完成映射，避免页面继续自由选择近义图标。

### 品牌与自绘

| 图形 | 位置 | 引用/副本 | 处置 |
|---|---|---:|---|
| MultiReviewer 三条错位短线 | `components/mark.tsx:9-16` | `<Mark>` 3 处：`login.tsx:73`、`main.tsx:126`、`password.tsx:51` | 保留品牌 SVG；不换成通用图标 |
| 同款 favicon | `index.html:15-18` | 1 个 SVG data URI | 保留；后续从同一源文件生成，消除两份坐标数据 |

源码中没有其他 `<svg>`、SVG path、图片 data URI、CSS `background-image` 或 `mask-image`。

## 浏览器原生视觉符号

| 类型 | 位置 | 数量 | Radix 迁移建议 |
|---|---|---:|---|
| checkbox 勾选 | `access-control.tsx:353`; `credentials.tsx:853,1920,1980` | 4 | 使用 Radix Checkbox；勾选与不确定态分别由 `CheckIcon`、`MinusIcon` 输出 |
| select 下拉箭头 | `access-control.tsx:269`; `credentials.tsx:821` | 2 | 使用 Radix Select，统一 Trigger、Content、Item 和 Chevron |
| details 展开标记 | `runs.tsx:174`; `credentials.tsx:2022,2163`; `settings.tsx:231` | 4 | 使用 Radix Collapsible 或 Accordion；统一 `ChevronDownIcon` 与开合动画 |
| details 自绘展开箭头 | `stats.tsx:323-333` | 1 | 同上；当前已隐藏原生 marker 并用 Lucide Chevron |
| 无序列表圆点 | `credentials.tsx:1368,2169` | 2 个列表样式 | 保留语义列表与原生圆点，无需图标组件 |
| 处置率进度条 | `stats.tsx:81-84` | 1 个共享渲染位置 | 保留自绘数据图形；它有配套数值并已 `aria-hidden` |

## Unicode 与文本符号

- `→`：`stats.tsx:203`，日期范围分隔。建议改为文字“至”，让语义和读屏结果一致；无需图标。
- `·`：`runs.tsx:182,214,275`、`repos.tsx:157-158,909,911`、`components/model-composer.tsx:236,430`、`credentials.tsx:1677,1767,2029,2033,2157,2214,2446`。全部是紧凑元信息分隔符，保留为排版字符。
- `—`：`access-control.tsx:264`、`stats.tsx:257,343,394`。表示空值；保留前应统一可访问文案，关键字段可改为“暂无”。
- `…`：分布在登录、读取、发现、保存、删除、刷新和重跑的进行中文案中。它是中文省略标点，保留为文字；等待反馈应由按钮禁用、Skeleton 或进度状态共同表达。
- 源码未发现 emoji、Unicode 勾叉、警告符号或三角形箭头。

## 迁移分组

1. **直接迁移到 Radix Icons**：Chevron、Calendar、Check、Cross、Alert、Help、Exit、Plus、Reload、Search、Trash、模型 chip 移除与 Dialog 关闭。
2. **先统一语义再迁移**：`CircleAlert`/`AlertTriangle`、`CircleCheck`/`Check`、`CircleX`/`X`/`XIcon`、`Search`/`SearchIcon`。每组当前同时存在多个近义名称。
3. **迁移到 Radix Primitive**：原生 checkbox、select、details；图标应由对应共享组件内部管理。
4. **保留**：产品标记、favicon、进度条、列表圆点、元信息分隔点。
5. **删除或文字化候选**：系统管理员说明的 `ShieldCheck`；带完整动作文字的 Key/Plus/Trash；日期范围 `→`；空值 `—` 在关键字段改为“暂无”。

迁移验收应以“一个产品语义只有一个共享图标决策”为准，同时核对 hover、focus、disabled、loading、`aria-label` 与高对比度状态，避免只完成依赖替换。
