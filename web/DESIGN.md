---
name: MultiReviewer
description: "发布门禁看板方向的 MultiReviewer 审查运维面板；Radix Themes 迁移前设计种子。"
---

<!-- SEED: established with the user before implementation; re-run $impeccable document once there's code to capture the actual tokens and components. -->

# MultiReviewer 管理面板设计系统

> 方向已经锁定为“发布门禁看板”。Theme 参数、精确色值、组件尺寸与断点仍是原型候选；完成第 15 节的代表页面验证后，才转为实现基准。

## 方向契约

**THESIS** 以连续的运行门禁清单呈现“当前能否顺利完成审查、哪里需要处理、处理动作在哪里”。首屏主体是可扫读的状态行列，摘要指标只作辅助信息。

**OWN-WORLD** 亮色运行看板：白色检查面、冷灰框架、近黑主操作与选中行、细分隔线、稳定列轨。红、琥珀、绿只表示失败、需注意、正常；控件采用 Radix Themes 的紧凑形态和清晰焦点。

**STORY** 操作员先扫最近 Review Run，定位失败或降级项，沿同一行读取原因并执行下一步；研发负责人再进入处置率和模型服务，对照模型产出与运行条件。每个页面先回答是否需要处理，再展开配置和历史。

**FIRST VIEWPORT** 桌面端左侧约 200px 导航，右侧由紧凑页头、筛选/状态条和占据主要高度的 6–10 条 Review Run 组成。状态位固定在行首，仓库与 PR 是主信息，时间、模型结果和费用沿稳定列轨排列；行级主要动作固定在最右侧。390px 下改为顶部导航与单列运行项，状态、主信息和动作保持首屏可达。

**FORM** 发布门禁看板，七个候选方向中的第 3 项，seed `9d175edc`。这里的“门禁”表示管理面板中的运行就绪检查；MultiReviewer 继续只发布 review 评论，不调用 check/status，也不阻断 PR 合并。

**FINISH** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 1. 产品定位

MultiReviewer 管理面板服务两类用户：

- 运维人员：部署、配置模型服务、管理凭据、核对 Hook、处理故障。
- 研发负责人：查看 Review Run、Finding、处置率与审查策略。

界面应像可靠的内部管理工具：信息密度高、结构稳定、状态清楚、操作可预期。视觉参考 GitHub、Linear 与 Vercel 的后台产品，避免营销页式装饰。

面板默认进入评审记录。首屏优先展示 Review Run、Hook 漂移与模型服务运行条件。

## 2. 技术分层

### 2.1 组件职责

- `@radix-ui/themes`：唯一通用视觉系统，负责全局 Theme、设计 token、常规组件与默认交互状态。
- Radix Primitives：只补齐 Themes 未覆盖的行为组件和无障碍语义。
- `@radix-ui/react-icons`：唯一业务图标库。
- 产品组件：表达 MultiReviewer 的领域结构，例如 ProviderSelector、ModelComposer、SetupChecklist、StatusBadge。
- Tailwind CSS：只负责页面布局、容器约束和复杂响应式网格。

产品页面只组合组件。颜色、间距、圆角、阴影与交互状态集中在 Theme 和共享产品组件中定义。

### 2.2 Theme 根配置候选

```tsx
<Theme appearance="light" accentColor="gray" grayColor="gray"
  panelBackground="solid" radius="small" scaling="95%">
  <App />
</Theme>
```

当前只提供浅色模式。以上根配置全部是原型候选；`accentColor`、`grayColor`、`panelBackground`、`radius` 与 `scaling` 的最终值需经代表页面验证，见第 15 节。

### 2.3 发布门禁看板的结构规则

- 状态、主信息、证据和动作沿稳定列轨排列。长列表优先使用连续行列，减少互不关联的卡片堆叠。
- 状态位固定在行首，行级动作固定在行尾。用户从左到右完成“判断状态 → 读取原因 → 执行动作”。
- 失败、需注意和正常使用同一行结构。状态色、文字和图标共同表达结果，布局不会因状态变化而跳动。
- 模型服务、仓库和审查策略中的 provider 复用同一个 ProviderSelector。深色选中行表示当前工作对象，Checkbox 表示批量选择。
- 页面页头只保留当前任务、必要范围和一个主要动作。解释性内容进入 HelpTooltip，关键阻塞原因保持可见。
- 看板语法服务于运行检查与配置管理，不引入工业警示条、拟物仪表或阻断合并的暗示。

## 3. 设计原则

1. 健康状态优先：异常、阻塞与下一步操作应在同一视区内被识别。
2. 一种语义一种样式：当前页面、当前 Tab、单选、多选、运行状态各用固定表达。
3. 颜色表达状态：红、绿、琥珀只承载错误、成功、警告。
4. 层级来自排版与间距：减少嵌套卡片、分隔线和重复标题。
5. 默认状态完整：每个交互组件同时定义 hover、focus、active、selected、disabled、loading 与 invalid。
6. 内容决定宽度：长标识可截断并查看全文，页面不得产生水平滚动。
7. 操作就近：主要动作靠近作用对象，破坏性动作需要二次确认。
8. 响应式保留任务：窄屏调整布局，不删除关键状态或操作。

## 4. 颜色系统

### 4.1 中性色

以下中性色是原型候选。使用 Radix Gray scale，并通过语义 token 暴露给产品组件：

| 语义 token | 用途 | 视觉目标 |
| --- | --- | --- |
| `--app-bg` | 页面背景 | 白色 |
| `--app-chrome` | 侧栏、表头、次级区域 | 接近 `#f6f8fa` |
| `--app-panel` | 卡片、弹窗、输入框 | 白色实底 |
| `--text-primary` | 标题、正文 | 接近 `#1f2328` |
| `--text-secondary` | 元数据、说明 | 接近 `#59636e` |
| `--border-subtle` | 卡片和分组边界 | 接近 `#d0d7de` |
| `--selection-solid` | provider 单选 | 高对比近黑色 |
| `--selection-solid-text` | provider 选中文字 | 白色 |
| `--selection-solid-hover` | provider 选中项 hover | 保持深色体系并提供可见反馈 |
| `--selection-solid-muted-text` | provider 选中项辅助文字 | 在深色表面达到正文对比要求 |
| `--selection-solid-danger-text` | provider 选中项异常文字 | 在深色表面保留错误语义与正文对比 |

精确色值由 Radix token 生成，并在模型服务、审查策略和评审记录原型中验证。产品代码不直接引用色阶编号，统一引用上述语义 token。

### 4.2 状态色

以下状态色系是语义约束，具体 Radix 色阶和 contrast/highContrast 组合仍需原型验证。

| 状态 | 色系 | 使用位置 |
| --- | --- | --- |
| 成功 | Green | 已验证、已完成、正常、可运行 |
| 警告 | Amber | 信息缺失、需要关注、降级运行 |
| 错误 | Red | 失败、不可运行、删除、无效输入 |
| 信息 | Gray | 中性提示、未知、尚未开始 |

状态同时使用文字或图标表达。颜色不单独承担含义。正文与背景的对比度至少达到 WCAG AA 4.5:1。

选中 provider 内的 StatusBadge 使用对应状态色的官方 `solid` variant；默认表面使用 `soft + highContrast`。两种表面都保留状态文字与图标，深色选中背景中不回落为白色中性标签。

StatusBadge 是运行状态的唯一产品级出口，只暴露 `neutral`、`success`、`warning`、`error` 四种语义。领域组件继续决定状态属于哪一类；StatusBadge 只映射 Radix Gray、Green、Amber、Red 及固定状态图标。来源、身份和类别等中性标签直接使用 Themes Badge，不进入 StatusBadge。

## 5. 排版

### 5.1 字体

使用系统无衬线字体栈：`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`。

等宽字体仅用于模型标识、Key 尾号、commit SHA、数字指标和日志片段。

### 5.2 层级候选

以下 `size` 是原型候选，最终值以桌面扫读密度和 390px 触控验证为准。

| 层级 | Radix 组件建议 | 用途 |
| --- | --- | --- |
| 页面标题 | `Heading size="5"` | 每页唯一标题 |
| 区块标题 | `Heading size="3"` | 独立任务区 |
| 正文 | `Text size="2"` | 表单、表格、说明 |
| 元数据 | `Text size="1" color="gray"` | 时间、来源、补充信息 |
| 大指标 | `Text size="7" weight="bold"` | 处置率、计数 |

页面标题保持短句。字段已经表达含义时，不再添加重复的小标题。补充解释放入 HelpTooltip。

## 6. 密度、间距与圆角

### 6.1 密度候选

- 默认从 `scaling="95%"` 候选值开始验证桌面端高密度扫描，并与 `90%` 对照。
- 常规输入和按钮暂用 `size="2"` 候选值。
- 核心提交动作暂用 `size="3"` 候选值。
- 窄屏上的主要触控目标高度至少 44px，可通过响应式 size 或外层点击区域实现。
- 表格和长列表优先紧凑行高，重要状态保持完整文字。

### 6.2 间距候选

使用 Radix 九级 spacing scale。候选映射为：图标与文字用 `space-1/2`，同组字段用 `space-3`，卡片内部用 `space-4`，相邻任务区用 `space-5`，页面区块用 `space-6`。`space-7` 至 `space-9` 只用于页面级留白。原型验证后固定映射，页面不得自行创建任意间距值。

### 6.3 圆角与阴影候选

- Theme 从 `radius="small"` 候选值开始，并与 `medium` 对照。
- 表单、按钮、卡片、弹窗沿用组件默认的上下文圆角。
- 卡片采用实底和细边框，常态不加阴影。
- Dialog、Popover、Tooltip 可使用 Radix 默认浮层阴影。
- 禁止为每个页面单独设置圆角。

## 7. 页面结构

### 7.1 应用外壳

- `md=1024px` 暂作为候选切换点：以上使用左侧固定宽度导航，以下使用顶部横向导航和单列内容。
- 页面 Header 可保持粘性，包含标题、必要说明和主要动作。
- 内容区左对齐；宽表和主从工作区使用宽版容器，表单使用窄版容器。
- 超宽屏保留合理最大宽度，避免行长随视口无限增长。

### 7.2 页面层级

页面固定采用 `App Shell > Navigation + Page > PageHeader + PageBody > Feedback/SetupChecklist + Task regions`。同一任务区内优先使用留白分组。Card 用于形成独立边界、承载操作或隔离滚动区域。

### 7.3 长列表与主从布局

- Review Run、模型和仓库列表使用明确的局部滚动区域，避免整个页面随长列表持续增长。
- 桌面主从布局中，左侧选择列表和右侧详情各自管理滚动。
- 窄屏先显示列表，进入详情后提供明确返回入口。
- 表头可粘性定位；批量操作栏跟随当前选择，不遮挡列表内容。
- 长名称和模型标识单行截断，hover/focus 时通过 Tooltip 查看全文。
- 地址、模型标识等可复制内容提供 Copy 按钮。

## 8. 选择与导航语义

### 8.1 主导航

主导航表示当前页面。当前项使用白色内嵌面、细边界和高对比文字，并设置 `aria-current="page"`。hover 使用浅灰背景，保持文字清晰。

### 8.2 Tab

- 稳定 URL 的详情分区使用 Theme `TabNav` 与 Router Link。
- 同一页面内切换面板使用 Theme `Tabs`。
- 当前 Tab 使用下划线和加重文字。
- 弹窗打开和关闭不得改变底层 Tab 状态。

### 8.3 Provider 单选

ProviderSelector 是共享产品组件。模型服务页和审查策略中的 provider 必须使用同一视觉规则：

| 状态 | 表现 |
| --- | --- |
| 默认 | 透明或白色背景，高对比主文字，次级元数据 |
| hover | 浅灰背景，所有文字保持可读 |
| focus-visible | 清晰的外侧焦点环 |
| selected | 高对比近黑实底，主文字与元数据改为白色 |
| selected + hover | 保持深色体系，只提高或降低一档明度 |
| disabled | 降低对比度，禁止 pointer 反馈 |

选中态不使用浅灰底。选中行的 hover 不得切回浅色。服务状态通过 Badge 表达，避免重复“可运行”等正文。

两处组件的视觉保持一致，语义属性按行为区分：

- 路由型 provider 链接使用 `aria-current`。
- 编辑器中的 provider 按钮使用单选语义和 `aria-pressed`，或使用合适的单选 Primitive。

实现统一由 `src/components/provider-selector-item.tsx` 承担。路由项通过 `asChild` 组合 Link，页内项渲染 button；组件集中处理深色选中、深色 hover、焦点、辅助文字和异常文字对比度。模型行与 Checkbox 多选继续使用浅色选择反馈。

### 8.4 单选与模式切换

- 固定选项单选使用 RadioGroup。
- 紧凑模式切换使用 SegmentedControl 或单选 ToggleGroup。
- 必选的单选 ToggleGroup 拦截空值，保证始终有一个选项。
- Switch 仅用于点击后立即生效的开关。

### 8.5 多选与批量管理

- 模型启用、批量选择和权限矩阵使用 Checkbox。
- 父级全选使用 indeterminate 状态。
- 已选行使用浅色强调；Checkbox 是主要选中标记。
- 不重复展示“已选择”“可用”等与控件状态相同的文字。
- 批量动作必须显示选中数量，并在执行后给出成功或失败反馈。

## 9. 交互组件状态

所有共享组件必须覆盖以下状态：

| 状态 | 规则 |
| --- | --- |
| default | 内容、边界和动作清晰 |
| hover | 强化可点击性，不改变语义色，不降低文字对比度 |
| focus-visible | 键盘焦点环清楚且不被裁切 |
| active | 提供按压反馈，布局不位移 |
| selected/current | 按第 8 节的固定语义表达 |
| disabled | 降低对比度，禁用交互和 hover |
| loading | 保留原尺寸，显示 Spinner，阻止重复提交 |
| invalid | 字段边界、错误文字和 `aria-describedby` 同时生效 |

### 9.1 Button

- 主要动作使用 Solid 高对比按钮，每个任务区最多一个；次要动作使用 Soft、Surface 或 Outline；低优先动作使用 Ghost。
- 删除和不可逆动作使用 Red，并通过 AlertDialog 确认。仅图标按钮必须提供可访问名称和 Tooltip。

### 9.2 表单

- Label 始终可见；placeholder 只提供输入示例。
- 帮助信息使用相邻 HelpTooltip，不用小标题承载说明。
- 字段错误紧邻字段显示；提交级错误使用 Callout。
- 搜索输入提供清除按钮，并保留输入焦点。
- Select 用于有限枚举。可搜索并允许手输模型标识的场景使用统一 Combobox 产品组件。

### 9.3 数据展示

- StatusBadge 只表达运行状态；Themes Badge 表达来源、身份或类别；DataList 表达少量键值详情；Table 表达可比较的多行数据。
- 事实值和来源在同一行显示，避免为“发现事实”“实际运行”创建重复列。
- 单元格内容超过可用宽度时截断；完整内容可通过 Tooltip 或详情区读取。

## 10. 浮层

### 10.1 Dialog

- 普通编辑和多步配置使用 Dialog。
- 模型凭据三步配置在一个 Dialog 内完成，步骤状态属于 Dialog。
- 取消关闭时丢弃弹窗草稿，保留底层 provider、列表项、Tab、筛选和滚动位置。
- 提交成功后更新底层数据；是否切换当前项由操作结果明确决定。
- 长内容只滚动 Dialog 内容区，标题和操作区保持可见。
- 打开后聚焦首个有效操作，关闭后焦点返回触发按钮。

### 10.2 AlertDialog

删除用户、角色、仓库、模型服务和其他不可逆动作使用 AlertDialog。文案明确对象、影响和恢复方式。

### 10.3 Popover 与 Tooltip

- Popover 承载锚定的交互内容，例如筛选器和日期选择。
- Tooltip 只承载简短帮助、缩略内容全文和图标名称。
- 错误、后续步骤和关键状态直接显示在页面或 Dialog 内。
- 浮层内容通过 Portal 渲染，并继承 Theme。

## 11. 反馈与状态页面

| 场景 | 组件 | 内容要求 |
| --- | --- | --- |
| 页面加载 | Skeleton | 轮廓匹配真实内容，减少跳动 |
| 局部提交 | Spinner / Button loading | 保留按钮宽度，阻止重复提交 |
| 成功 | Callout 或局部状态 | 说明完成的对象和结果 |
| 警告 | Amber Callout | 说明影响和可执行下一步 |
| 错误 | Red Callout / ErrorState | 说明失败对象、原因和重试入口 |
| 空数据 | EmptyState | 说明当前为空和首个可执行动作 |
| 无搜索结果 | EmptyState | 显示筛选条件和清除入口 |

空态不使用装饰性大图标。错误标题和正文避免重复。动态反馈使用合适的 live region。

## 12. 图标规则

- 通用图标统一来自 `@radix-ui/react-icons`。
- 常规尺寸使用 15×15；大图标只用于真正需要强化识别的状态。
- 产品品牌标识保留现有自绘 SVG。
- 装饰图标设置 `aria-hidden="true"`。
- 纯图标按钮提供 `aria-label` 与 Tooltip。
- 状态图标必须与状态文字共同出现。
- 已有文字能完整说明动作时，删除重复图标。
- 禁止使用 Emoji 和 Unicode 图形充当操作图标。
- 文本分隔符可保留普通字符；日期范围使用“至”。

建议统一语义映射：搜索、帮助、关闭、删除、编辑、复制、刷新、返回、展开、外链各固定一个图标，页面不得自行替换同义图标。

## 13. Radix 缺口实现原则

按以下顺序处理 Themes 未覆盖的需求：

1. 用现有 Theme 组件组合完成。
2. 用 Theme token 实现共享产品组件。
3. 使用 Radix Primitive 补齐行为和无障碍能力。
4. 保留必要的第三方行为库，并包装为单一产品组件。
5. 调整功能形态，控制维护成本。

当前明确缺口：

- 日期选择：保留日期行为库，使用 Theme token 重做外观，并封装为 DatePicker。
- 可搜索且可手输的模型标识：暂由统一 Combobox 包装现有行为库。
- 展开详情：使用 Collapsible 或 Accordion Primitive 封装 Disclosure。
- Toast：仅用于操作完成后的短暂通知；关键结果仍留在页面内。
- ScrollArea：只用于需要自定义滚动行为的局部区域，普通页面和表格优先原生 overflow。

禁止页面深度覆盖 Radix 内部 DOM。共享组件只暴露产品需要的少量 variant 和 size。

## 14. Tailwind 使用边界

- Tailwind 只负责 App Shell、页面容器、主从分栏、复杂网格、局部滚动边界和无法由 Themes 响应式 props 表达的布局切换。
- Theme props 与 Theme tokens 负责组件颜色、字号、间距、圆角、阴影和交互状态。
- Primitives 负责键盘、焦点、受控状态和 ARIA 行为；其外观使用 Theme tokens。
- 页面不得用 Tailwind 覆盖 Themes 组件内部的 hover、focus、selected、disabled、loading 或 invalid 状态。
- 同一布局只能由 Themes 响应式 props 或 Tailwind 断点中的一套规则控制。

## 15. 原型验证清单

以下值进入全量迁移前必须在模型服务、审查策略、评审记录三个代表页面做原型验证：

1. `accentColor="gray"` 能否同时满足主按钮、焦点环和选中 provider 的对比度。
2. `radius="small"` 与 `radius="medium"` 在 Card、Dialog、输入框中的一致性。
3. `scaling="95%"` 与 `90%` 的桌面信息密度，以及窄屏触控尺寸。
4. ProviderSelector 深色选中态在默认、hover、focus、Badge 组合下的可读性。
5. `md=1024px` 作为侧栏和主从布局切换点是否产生拥挤。
6. 长模型列表的可视高度、局部滚动、粘性表头和批量操作栏。
7. 多步凭据 Dialog 的宽度、内容滚动和窄屏布局。
8. DatePicker、Combobox 与 Theme 组件的视觉一致性和键盘操作。
9. TabNav 与 Router Link 的当前态、前进后退和刷新恢复。

原型验收同时覆盖鼠标、键盘、窄屏、长中文名称、长模型标识、加载、错误、禁用与空数据。

## 16. 实施约束

- 页面使用 Theme props 和共享产品组件；避免页面级视觉变体。
- 同一语义组件只有一个实现，ProviderSelector、StatusBadge、Combobox、EmptyState、ErrorState 禁止复制。
- 弹窗草稿与底层页面状态分开存储。关闭弹窗不得重置底层选择。
- URL 可表达的页面状态写入路由；临时编辑状态留在组件内。
- 新组件必须提供可访问名称、键盘行为、完整状态和响应式验证。
- 视觉改动在部署实例使用 ego-browser 完成端到端验收。
