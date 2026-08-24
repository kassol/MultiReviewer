# Radix Themes 主导管理面板视觉系统

管理面板当前以 shadcn vendored 组件、Radix Primitives、Tailwind utility、Lucide、cmdk 与 react-day-picker 共同组成。基础组件已有 46 个定义，项目组件已有 56 个定义；主从选中、状态徽标、标签值列表、可搜索单选、弹窗和空态仍存在多份页面级实现。相同产品语义因此可能产生不同的选中、hover、focus 与响应式行为。

## Decision

### 视觉方向：发布门禁看板

- 设计方向锁定为“发布门禁看板”，方向选择 seed 为 `9d175edc`，对应七个候选方向中的第 3 项。
- “门禁”表示管理面板中的运行就绪检查。MultiReviewer 继续只发布 review 评论，不调用 check/status，也不阻断 pull request 合并。
- 首屏采用连续的 Review Run 状态行列。状态固定在行首，仓库与 pull request 是主信息，运行证据沿稳定列轨排列，行级动作固定在行尾。
- 白色检查面、冷灰框架、近黑主操作与选中行构成视觉主体。红、琥珀、绿只表示失败、需注意、正常。
- 模型服务、仓库、审查策略和访问控制沿用同一看板语法：先展示是否需要处理，再展示证据与下一步。长列表优先连续行列，卡片只承载独立任务或隔离滚动。
- 方向已经确定。Theme 参数、精确色值、组件尺寸、间距映射、圆角与断点保持候选状态，必须经过模型服务、审查策略和评审记录的代表页面原型验证。

### 视觉系统与依赖责任

- **Radix Themes 是唯一通用视觉系统。**根 React 树由 `@radix-ui/themes` 的 `Theme` 包裹，固定亮色。颜色、字号、间距、圆角、密度、面板和常用组件状态以 Theme 配置、组件 props 与 Theme tokens 为准。`web/DESIGN.md` 记录锁定方向与候选 token；候选值通过代表页面原型后才能成为实现基准。
- **Radix Themes 负责通用组件。**Button、IconButton、Badge、Callout、Card、DataList、Progress、Separator、Skeleton、Table、TextField、TextArea、Checkbox、RadioGroup、SegmentedControl、Select、AlertDialog、Dialog、Popover、ScrollArea、Tabs、TabNav、Tooltip 与布局、排版组件优先直接采用 Themes。
- **Radix Primitives 只补 Themes 的行为缺口。**Accordion、Collapsible、ToggleGroup 等由 Primitive 提供语义、键盘、焦点和受控状态，再用 Theme tokens 构成共享产品组件。Primitive 不建立第二套视觉规则；页面不得直接为同一语义各写一份 Primitive 外观。
- **Radix Icons 是唯一业务图标库。**页面与共享组件从 `@radix-ui/react-icons` 取业务图标，同一产品语义只保留一个图标决定。纯图标按钮使用 Themes IconButton 并提供可访问名称。MultiReviewer 产品标记与 favicon 继续保留品牌 SVG。
- **Tailwind 只负责页面布局。**它处理 App Shell、容器约束、主从分栏、复杂网格、局部滚动边界和 Themes 响应式 props 无法表达的布局切换。它不承担组件外观，也不覆盖 Themes 组件内部颜色、字号、圆角、hover、focus、selected、disabled、loading 或 error 状态。完成迁移后，class-variance-authority、tailwind-merge、tw-animate-css 等依赖按实际引用决定是否删除。
- **cmdk 只负责可搜索且可手填的选择行为。**仓库异步搜索与验证模型输入统一收进共享 Combobox 产品组件；外观使用 Themes TextField、Popover/Dialog、ScrollArea 和 tokens。官方 Select 足以满足需求时允许调整交互并删除 cmdk；模型标识手填与目录候选并存的能力仍需保留。
- **react-day-picker 只负责日期与区间选择逻辑。**日历外观使用 Themes 组件与 tokens。若日期窗口可在不增加非法状态的前提下改成官方组件可表达的输入方式，允许调整功能并删除 react-day-picker。

### 组件分层

- 通用视觉组件直接使用 Themes。项目不再复制一层同名 Button、Badge、Card、Input、Table、Dialog 或 Popover，仅在需要收窄产品允许值时保留薄包装。
- 共享产品组件集中表达跨页面规则。首批包括 StatusBadge、DataList、SelectableItem/MasterList、Combobox、EmptyState、ErrorState、PageHeader、PageBody、HelpTooltip 和 Disclosure。
- 领域组件继续持有领域状态与流程。ModelComposer、模型服务三步配置、ModelsTable、仓库主从页、权限矩阵和 Review Run 展示由 Themes 组件、共享产品组件与必要 Primitive 组合，不寻找虚假的同名库组件。
- 路由、TanStack Query、mutation、权限裁剪和领域草稿属于页面与领域组件。Themes 和 Primitives 只接收受控值与事件，不拥有路由、provider、tab、列表选择、模型组合或候选配置。

### 功能调整与领域不变量

- 允许为 Radix 官方组件的能力合理调整信息架构、控件形态、动作位置、筛选方式、展开方式和窄屏布局。设计优先使用官方组件的默认交互与可访问行为，减少专用变体。
- 调整不得改变 API 契约、权限格判据、稳定路由、模型服务版本原子切换、候选配置生命周期、模型组合保存判据、仓库模型覆盖语义、版本冲突处理、Review Run 与 Disposition 口径。
- 模型服务配置仍按来源、模型发现、真实推理推进；失败不替换当前模型服务版本。全局模型组合保存时仍至少包含一个可用模型。模型组合与分批上限仍独立保存。
- 弹窗关闭后必须保留打开前的 provider、列表项、tab 与页面草稿。路由型 tab 继续由 TanStack Router URL 驱动；同页非路由面板才使用 Tabs 自身状态。
- 已选但失效的模型继续显示稳定原因并允许移除。模型停用继续影响审查策略候选，不删除模型服务中的状态记录。

### 分批迁移

1. **设计系统与根主题。**按“发布门禁看板”方向建立代表页面原型，验证 Theme 配置、颜色语义、字号、密度、圆角、响应式、组件状态和产品组件规则；验证通过后接入 Themes CSS、根 Theme 与 Radix Icons，并将确认值回写 `web/DESIGN.md`。
2. **视觉基础族。**迁移排版、布局、Button/IconButton、Badge/StatusBadge、Card、Callout、Skeleton、Progress、Separator、DataList 和空态/错误态。
3. **表单与选择族。**迁移 TextField、TextArea、Label、Checkbox、RadioGroup、SegmentedControl、Select；统一 native checkbox/select 与页面手写两态按钮。
4. **浮层与导航族。**迁移 Dialog、AlertDialog、Popover、Tooltip、TabNav/Tabs、Disclosure；统一关闭、焦点恢复、路由 tab 和破坏性确认。
5. **复杂列表族。**迁移 Table、ScrollArea、主从列表、Combobox、Calendar、ModelsTable 和权限矩阵，验证长内容、批量选择与独立滚动。
6. **页面族。**按认证与壳、评审记录与处置率、仓库、审查策略、模型服务、访问控制依次迁移；每批保持页面完整可用。

一个组件族开始迁移后，同批完成全部调用方替换并删除旧 wrapper、旧 utility 配方和无引用依赖。过渡适配器可以短期保留现有调用 API，适配器内部只能有一套实现。两套 Button、Dialog、Tab、选中行或状态徽标不得跨批次长期共存。

### 可访问性与响应式

- 优先使用 Themes 与 Primitives 提供的 WAI-ARIA 语义、键盘导航、焦点管理、类型提前选择和 modal 行为。自定义组合必须补齐名称、role、状态、键盘操作、焦点进入与返回。
- Dialog 必须有可访问标题；破坏性确认使用 AlertDialog；Tooltip 只承载辅助信息；影响决策的错误、阻塞原因和下一步保持可见正文。
- IconButton 必须有 `aria-label` 或 `aria-labelledby`。装饰图标隐藏于辅助技术。颜色不能成为唯一状态信号。
- 组件和主要布局以 Themes 固定断点与响应式 props 为主。项目 CSS 只补复杂布局。同一布局不得同时由 Themes 与 Tailwind 两套断点决定。
- 390px 窄屏必须保持业务动作可达、触控目标可用、文字可读。整页不得因长模型标识、表格或主从布局产生横向溢出；确需横向滚动时限制在明确的数据容器内。

### 验收

- 每个组件族完成后运行前端 typecheck、build 与项目自动化测试。程序测试覆盖 API、状态与领域不变量，视觉和交互验收走部署实例。
- 部署实例的端到端验收固定使用 ego-browser。每批至少覆盖桌面与 390px、鼠标 hover、键盘 focus/操作、selected、disabled、loading、error、弹窗 Esc/取消/提交、焦点返回、背景列表与 tab 状态保留、路由前进后退、长内容和滚动边界。
- 组件族验收同时检查无障碍名称、唯一当前项、状态非纯颜色表达、对比度、减少动效偏好和 Portal 内 Theme 样式继承。
- 页面族全部迁移后，用 ego-browser 走通登录、改密、仓库、评审记录、处置率、模型服务三步配置、审查策略和访问控制的主要路径，再删除迁移期兼容代码。

## Consequences

管理面板的默认视觉、状态和响应式规则集中到 Radix Themes；Radix Primitives 负责官方视觉组件未覆盖的行为，Radix Icons 统一业务符号。页面保留领域状态与路由控制，组件库替换不会把 provider、tab 或候选配置生命周期藏进视觉组件。

迁移会同时改变组件 API、CSS 责任和依赖，无法通过批量替换 import 完成。分批按组件族完成可将风险限制在可验收范围内；禁止同族双实现会增加单批改动范围，也会阻止新旧交互长期分叉。

Themes 的封闭视觉模型会减少逐页定制。部分现有控件会采用官方组件形态，Calendar 与可搜索手填选择仍保留专用行为层。功能调整以领域不变量为边界，UI 迁移不得改变审查与配置语义。

Tailwind 继续存在于页面布局层，短期内与 Themes CSS 共存。CSS 加载顺序、reset、Portal Theme 继承、断点和 bundle 体积需要在首批原型与每批构建中核对。最终依赖清理由实际引用决定，不以迁移名义提前删除仍承担行为的 cmdk 或 react-day-picker。
