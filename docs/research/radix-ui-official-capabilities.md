# Radix UI 官方能力与 MultiReviewer 迁移边界

调研日期：2026-08-24。来源只使用 Radix 官方文档与官方仓库链接。本文区分 Radix Themes、Radix Primitives 和 Radix Icons；三者是不同层级，不能用“Radix UI”一个名称代替具体依赖与责任。

## 结论

MultiReviewer 的目标架构应是：**Radix Themes 提供默认视觉、令牌和常用组件；Radix Primitives 提供 Themes 未覆盖的交互行为；Radix Icons 提供统一图标；产品专有复合组件使用同一套 Theme tokens 构建。**

依据：

- Themes 是预制样式组件库，安装包为 `@radix-ui/themes`；Primitives 是无样式、可增量采用的底层组件，官方推荐单包 `radix-ui`；Icons 是独立的 `@radix-ui/react-icons`。[Themes 安装](https://www.radix-ui.com/themes/docs/overview/getting-started) [Primitives 介绍](https://www.radix-ui.com/primitives/docs/overview/introduction) [Icons](https://www.radix-ui.com/icons)
- Themes 官方明确称组件“relatively closed”。大量覆盖样式时，应优先调整组件 props、Theme 配置或 tokens；仍无法满足时，使用 Primitives、Colors 和 Theme tokens 自建组件。[Themes Styling](https://www.radix-ui.com/themes/docs/overview/styling)
- Primitives 负责 WAI-ARIA 语义、焦点管理和键盘导航，同时把呈现完全交给应用；这适合填补 Themes 缺口，不适合作为第二套随页面自由发挥的样式来源。[Primitives Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility) [Primitives Styling](https://www.radix-ui.com/primitives/docs/guides/styling)

## 1. Radix Themes

### 1.1 安装与根节点

官方安装顺序是：

```tsx
import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";

<Theme appearance="light" accentColor="gray" grayColor="gray" radius="small" scaling="95%">
  <App />
</Theme>
```

- 必须安装 `@radix-ui/themes`、导入全局 CSS，并让 `<Theme>` 包住应用 React 树。[Getting started](https://www.radix-ui.com/themes/docs/overview/getting-started)
- `Theme` 可嵌套，子树继承父级配置；组件支持的视觉属性也可在组件上覆盖。[Theme API](https://www.radix-ui.com/themes/docs/components/theme)
- `Theme` 支持 `appearance`、`accentColor`、`grayColor`、`panelBackground`、`radius`、`scaling`、`hasBackground` 和 `asChild`。[Theme API](https://www.radix-ui.com/themes/docs/components/theme)
- 自定义 Primitive 的 Portal 默认落在根 `<Theme>` 外，会缺少 Theme tokens 与样式；官方方案是在自定义 Portal 内容内再包一层 `<Theme>`。Themes 自带的 Dialog、Popover 已处理这一点。[Themes Styling：Missing styles in portals](https://www.radix-ui.com/themes/docs/overview/styling#missing-styles-in-portals)

对 MultiReviewer：根节点应显式 `appearance="light"`，延续当前亮色产品约束；`ThemePanel` 只适合设计阶段预览，不进入生产界面。[ThemePanel](https://www.radix-ui.com/themes/docs/overview/getting-started#using-the-theme-panel)

### 1.2 官方组件清单

以下清单来自官方 Themes Components 页面。[Themes Components](https://www.radix-ui.com/themes/docs/components)

- 布局：`Box`、`Flex`、`Grid`、`Container`、`Section`。
- 排版：`Text`、`Heading`、`Blockquote`、`Code`、`Em`、`Kbd`、`Link`、`Quote`、`Strong`。
- 显示与反馈：`AspectRatio`、`Avatar`、`Badge`、`Callout`、`Card`、`DataList`、`Inset`、`Progress`、`Separator`、`Skeleton`、`Spinner`、`Table`。
- 表单与选择：`Button`、`IconButton`、`Checkbox`、`CheckboxGroup`、`CheckboxCards`、`Radio`、`RadioGroup`、`RadioCards`、`SegmentedControl`、`Select`、`Slider`、`Switch`、`TextArea`、`TextField`。
- 浮层与导航：`AlertDialog`、`ContextMenu`、`Dialog`、`DropdownMenu`、`HoverCard`、`Popover`、`ScrollArea`、`Tabs`、`TabNav`、`Tooltip`。
- 工具：`AccessibleIcon`、`Portal`、`Reset`、`Slot`、`Theme`、`VisuallyHidden`。

Themes 没有出现在官方清单中的 MultiReviewer 现有需求：Calendar/Date Picker、Command/Combobox、Accordion/Collapsible、NavigationMenu、ToggleGroup、Toast。此项是对官方清单的缺口比对；这些需求需要保留专用实现、调整功能，或使用 Primitives 自建。[Themes Components](https://www.radix-ui.com/themes/docs/components) [Primitives Components](https://www.radix-ui.com/primitives/docs/components)

### 1.3 颜色

- Themes 使用 Radix Colors 的 12 阶亮色、暗色和 alpha 色阶；accent 用于主按钮、链接等交互元素，gray 用于中性色。[Theme Color](https://www.radix-ui.com/themes/docs/theme/color)
- Theme 提供多个命名 accent 和 6 种 gray；组件可用 `color` 覆盖全局 accent。[Theme Color](https://www.radix-ui.com/themes/docs/theme/color)
- `--accent-1..12`、`--gray-1..12`、surface/indicator/track/contrast 等 CSS variables 可用于自建组件；官方允许覆盖对应变量。[Theme Color](https://www.radix-ui.com/themes/docs/theme/color)

对 MultiReviewer：近黑主操作可先验证 `accentColor="gray"` 加组件 `highContrast`。若无法达到现有 `#1f2328` 语义，应在 tokens 层一次性调整 accent/gray，禁止在页面逐个覆盖。`red`、`amber`、`green` 可继续承载失败、需注意、正常三态。

### 1.4 圆角

- Theme 的 `radius` 只有 `none | small | medium | large | full`；它是全局因子，实际圆角会根据组件语义变化。[Theme API](https://www.radix-ui.com/themes/docs/components/theme) [Radius](https://www.radix-ui.com/themes/docs/theme/radius)
- 圆角有 6 阶 CSS tokens；Button 等部分组件允许局部 `radius`，Card、Dialog、Popover 等面板继承 Theme 且没有局部 radius prop。[Radius](https://www.radix-ui.com/themes/docs/theme/radius)

对 MultiReviewer：当前“所有控件固定 6px”与 Themes 的语义化圆角模型不完全相同。新设计系统应选择 `small` 或 `medium` 作为整体形状，接受不同组件的上下文差异；确需 6px 的产品专有组件使用 `--radius-*`，避免逐页写死。

### 1.5 密度、间距和字号

- Themes 间距使用 9 阶 scale；`scaling` 会统一缩放 spacing、font size 和 line height，官方定位就是全局 UI density 控制。[Spacing](https://www.radix-ui.com/themes/docs/theme/spacing)
- `Theme.scaling` 支持 `90% | 95% | 100% | 105% | 110%`。[Theme API](https://www.radix-ui.com/themes/docs/components/theme)
- 常用组件还提供响应式 `size`：Button 为 1–4，TextField 为 1–3，Table 为 1–3。[Button](https://www.radix-ui.com/themes/docs/components/button) [Text Field](https://www.radix-ui.com/themes/docs/components/text-field) [Table](https://www.radix-ui.com/themes/docs/components/table)
- 字体可以通过 `--default-font-family`、`--heading-font-family`、`--code-font-family` 等 tokens 替换。[Typography](https://www.radix-ui.com/themes/docs/theme/typography)

对 MultiReviewer：日常高密度后台可从 `scaling="95%"` 开始原型验证，再为主要控件选择统一 size。全局 scaling 与组件 size 需要形成固定矩阵，页面不得自行用像素压缩。

### 1.6 响应式

- Themes 固定断点为 `initial 0`、`xs 520`、`sm 768`、`md 1024`、`lg 1280`、`xl 1640`，按 `min-width` 生效。[Breakpoints](https://www.radix-ui.com/themes/docs/theme/breakpoints)
- 多数组件 size 和布局 props 接受 Responsive object；Box/Flex/Grid 的 display、方向、网格和边距都可响应式设置。[Breakpoints](https://www.radix-ui.com/themes/docs/theme/breakpoints) [Layout](https://www.radix-ui.com/themes/docs/overview/layout)

对 MultiReviewer：现有 Tailwind 断点与 Themes 不同。迁移后应以 Themes 断点管理组件与主要布局；只有 Themes props 无法表达的容器行为保留项目 CSS。两套断点同时决定同一布局会产生临界宽度错位。

### 1.7 暗色

- 根 Theme 默认是 light；`appearance="dark"` 可强制暗色。[Dark mode](https://www.radix-ui.com/themes/docs/theme/dark-mode)
- 跟随系统或用户偏好时，官方建议用 class switching；与 `next-themes` 集成时不要把 `resolvedTheme` 传给 Theme，借助 class 避免初始闪烁。[Dark mode](https://www.radix-ui.com/themes/docs/theme/dark-mode)

对 MultiReviewer：当前只做亮色，应明确 `appearance="light"`，不引入主题状态或暗色 CSS。

### 1.8 Loading 与图标按钮

- Themes Button 和 IconButton 的 `loading` 会用 Spinner 替换内容、保持原尺寸并禁用按钮。[Button](https://www.radix-ui.com/themes/docs/components/button) [Icon Button](https://www.radix-ui.com/themes/docs/components/icon-button)
- IconButton 官方强烈建议提供 `aria-label` 或 `aria-labelledby`。[Icon Button](https://www.radix-ui.com/themes/docs/components/icon-button)

对 MultiReviewer：保存、删除、刷新、重跑等按钮应统一改用 `loading`，删除页面内各自拼接的“处理中…”与旋转图标；纯图标关闭、移除、帮助按钮必须在共享组件里强制可访问名称。

## 2. Radix Primitives

### 2.1 共同能力与责任边界

- 官方推荐安装 tree-shakeable 的 `radix-ui` 单包，也允许逐个安装 `@radix-ui/react-*`；分包模式需要同步升级以避免共享依赖重复。[Primitives Introduction](https://www.radix-ui.com/primitives/docs/overview/introduction)
- 适用组件默认可 uncontrolled，也可用 `value/open/checked` 与相应 change callback 受控。[Primitives Introduction](https://www.radix-ui.com/primitives/docs/overview/introduction)
- Primitives 遵循 WAI-ARIA 模式并负责常见的 role/aria、焦点和键盘导航。[Accessibility](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- Primitives 完全无样式；功能性样式也由应用负责，例如 Dialog Overlay 默认不会自行铺满视口。状态通过 `data-state`、`data-disabled`、`data-highlighted` 等属性暴露。[Styling](https://www.radix-ui.com/primitives/docs/guides/styling)
- CSS 动画可使用 `data-state`；Primitive 会等待退出动画。JS 动画需要 `forceMount` 接管卸载阶段。[Animation](https://www.radix-ui.com/primitives/docs/guides/animation)

受控状态只解决组件当前值。列表项、路由 tab 与 Dialog 背后的业务选择仍由应用状态和路由负责；关闭 Dialog 后恢复 provider/tab 必须由产品状态模型保证，Radix 不会替应用保存这些状态。此项是根据受控 API 边界作出的工程推论。

### 2.2 `asChild`

- 支持 DOM 的 Primitive parts 接受 `asChild`。启用后 Radix 不再渲染默认元素，而是克隆唯一子元素并注入行为和属性。[Composition](https://www.radix-ui.com/primitives/docs/guides/composition)
- 自定义叶子组件必须展开传入 props，并能接收/转发 ref；替换元素后，开发方继续负责元素语义、可聚焦性和键盘行为。[Composition](https://www.radix-ui.com/primitives/docs/guides/composition)
- 多个 Trigger 可以嵌套组合，例如 Tooltip.Trigger、Dialog.Trigger 与自有 Button。[Composition](https://www.radix-ui.com/primitives/docs/guides/composition)

对 MultiReviewer：TanStack Router Link 应通过 `asChild` 接入 TabNav/NavigationMenu/Trigger；共享 Button、Link 必须透传 props/ref。禁止 `asChild` 包裹 `div` 来模拟按钮。

### 2.3 目标组件能力

| Primitive | 官方能力 | MultiReviewer 用法边界 |
|---|---|---|
| Dialog | modal/non-modal；controlled/uncontrolled；modal 自动锁焦点；Title/Description 负责读屏公告；Esc 关闭并回到 Trigger；支持外部交互与自动聚焦回调。[Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) | 普通编辑弹窗。异步成功后由 controlled `open` 关闭；内容必须有 Title，Description 可显式移除。 |
| AlertDialog | 要求用户响应的模态；Action 与 Cancel 分离；遵循 Alert Dialog 模式。[Alert Dialog](https://www.radix-ui.com/primitives/docs/components/alert-dialog) | 删除用户、角色、仓库、凭据、服务等不可逆确认，替换普通 Dialog。 |
| Popover | controlled/uncontrolled；modal/non-modal；管理焦点；支持 side/align/offset、碰撞边界和可用宽高 CSS variables。[Popover](https://www.radix-ui.com/primitives/docs/components/popover) | 日期、搜索选择器、富内容浮层。列表宽度与高度使用官方 CSS variables，不手算视口。 |
| Tooltip | Provider 可统一 delay/skip delay；键盘 focus 可打开，Escape/Space/Enter 可关闭；可抽象为 content prop。[Tooltip](https://www.radix-ui.com/primitives/docs/components/tooltip) | 只放辅助说明。触发器必须可聚焦；影响决策的错误和下一步继续放正文。 |
| Tabs | controlled/uncontrolled；横/纵方向；automatic/manual activation；方向键、Home/End 完整导航。[Tabs](https://www.radix-ui.com/primitives/docs/components/tabs) | 同页内容面板。稳定 URL 的详情导航优先用 Themes TabNav，避免让 Tabs 状态和 Router 状态双向同步。 |
| Select | controlled/uncontrolled；分组、标签、禁用项、placeholder、typeahead、完整键盘和两种定位；支持表单 name/required。[Select](https://www.radix-ui.com/primitives/docs/components/select) | 替换原生 `<select>`。目录模型“可搜索且可手填”超出 Select 能力，不能硬塞。 |
| Checkbox | boolean/indeterminate；controlled/uncontrolled；表单内生成隐藏 input；Indicator 暴露三态。[Checkbox](https://www.radix-ui.com/primitives/docs/components/checkbox) | 权限矩阵与模型批量选择。被 write 包含的 read 可用 indeterminate 或 checked+disabled，但产品文案仍需说明。 |
| Switch | boolean controlled/uncontrolled；表单内生成隐藏 input；Space/Enter 切换。[Switch](https://www.radix-ui.com/primitives/docs/components/switch) | 只用于立即生效的开/关。需要保存按钮的配置继续用 Checkbox 或 SegmentedControl。 |
| ToggleGroup | single/multiple；controlled/uncontrolled；横/纵方向；roving tabindex 和方向键导航。[Toggle Group](https://www.radix-ui.com/primitives/docs/components/toggle-group) | 过滤片、互斥模式或批量按压选择；single 必须控制空值，避免再次点击清空唯一选择。 |
| ScrollArea | 保持原生滚动和键盘滚动；自绘横/纵 scrollbar；默认 hover 显示。[Scroll Area](https://www.radix-ui.com/primitives/docs/components/scroll-area) | 官方建议多数场景优先原生滚动。只在模型长列表需要统一滚动条时使用；整页和数据表保留原生 overflow。 |
| NavigationMenu | 网站导航语义；controlled value；管理 tab focus；Link 支持 active/data-active、Router Link `asChild`；官方明确它与 menubar 语义不同。[Navigation Menu](https://www.radix-ui.com/primitives/docs/components/navigation-menu) | 仅在导航有展开内容时采用。当前扁平侧栏用语义 `<nav>` + Router Link 更轻；详情路由 tab 用 TabNav。 |

### 2.4 Themes 缺口如何实现

官方给出的顺序是：先用 Themes props 和 Theme 配置，再调 tokens，最后用 Primitives + Colors + tokens 自建；大量覆盖组件内部样式说明 Themes 可能不适合该组件。[Themes Styling](https://www.radix-ui.com/themes/docs/overview/styling)

MultiReviewer 的缺口处理：

- **Calendar / Date Range**：Themes 和 Primitives 官方组件清单都没有 Calendar。保留 `react-day-picker` 作为日期算法与日历行为层，用 Theme tokens 重写外观；或调整为两个 TextField/原生日期输入。不能宣称已迁移为 Radix Calendar。[Themes Components](https://www.radix-ui.com/themes/docs/components) [Primitives Components](https://www.radix-ui.com/primitives/docs/components)
- **Command / searchable free-form model picker**：官方清单没有 Command/Combobox。Select 有 typeahead，但只选预定义项，无法同时承载搜索与手填 model id。[Select](https://www.radix-ui.com/primitives/docs/components/select) 可继续用 `cmdk` 作为行为依赖并用 Theme tokens 包装；完整自研 combobox 需要自行承担 WAI-ARIA、键盘与焦点测试。
- **Accordion / Collapsible**：Themes 无对应组件，Primitives 提供 Accordion/Collapsible。用 Primitive 行为加 Theme tokens 自建共享 Disclosure，替换 `<details>`。[Primitives Components](https://www.radix-ui.com/primitives/docs/components) [Collapsible](https://www.radix-ui.com/primitives/docs/components/collapsible)
- **NavigationMenu / ToggleGroup**：Themes 分别提供更聚焦的 TabNav 与 SegmentedControl；需要完整行为时使用 Primitives，并封装成产品组件。[Themes Components](https://www.radix-ui.com/themes/docs/components) [Primitives Components](https://www.radix-ui.com/primitives/docs/components)
- **产品标记、模型组合器、主从列表、权限矩阵**：属于产品结构，不应寻找同名库组件。使用 Box/Flex/Grid/Table、Themes 控件、Primitive 行为和统一 tokens 组合。

## 3. Radix Icons

- Radix Icons 是独立包 `@radix-ui/react-icons`，提供单独 React components，图形基准为 15×15，MIT 许可。[Radix Icons](https://www.radix-ui.com/icons)
- Themes Button 会自动为内嵌图标提供合适间距；IconButton 负责单图标按钮尺寸和 loading。[Button](https://www.radix-ui.com/themes/docs/components/button) [Icon Button](https://www.radix-ui.com/themes/docs/components/icon-button)
- 迁移映射与保留项见同目录 `radix-ui-icon-inventory.md`。产品标记与 favicon 继续作为品牌资产；业务图标统一由 Radix Icons 导出，页面禁止挑选第二个近义图标。

## 4. 从 shadcn 迁移的边界

当前 shadcn 文件是已经复制进仓库的项目源码；它们使用 Radix Primitive + Tailwind 组成视觉层。迁移到 Themes 会同时替换**组件 API、样式责任和令牌来源**，不能只改 import。

### 可直接以 Themes 为目标

- `Button` → Themes `Button` / `IconButton`，统一 variant、size、loading。
- `Input` → `TextField.Root`，前后图标进入 `TextField.Slot`。[Text Field](https://www.radix-ui.com/themes/docs/components/text-field)
- `Label` → Themes `Text`/原生 label，或 Primitive `Label`；保持可见标签。[Label Primitive](https://www.radix-ui.com/primitives/docs/components/label)
- `Badge`、`Card`、`Table`、`Skeleton`、`Popover`、`Dialog` → 对应 Themes 组件；删除本地重复 visual variants。[Themes Components](https://www.radix-ui.com/themes/docs/components)
- 原生 checkbox/select → Themes 组件；状态复杂时仍由底层 Primitive API 支持。[Checkbox Themes](https://www.radix-ui.com/themes/docs/components/checkbox) [Select Themes](https://www.radix-ui.com/themes/docs/components/select)

### 需要重构后迁移

- 破坏性确认从本地 Dialog 改为 Themes/Primitive AlertDialog。
- 稳定路由 tab 改用 Themes TabNav，并通过 `asChild` 组合 TanStack Router Link。[Tab Nav](https://www.radix-ui.com/themes/docs/components/tab-nav)
- 页面中直接写的选中、hover、focus、disabled 和 loading utility 要迁回组件 prop、Theme token 或共享产品组件；Themes 官方提醒 Tailwind 容易深入覆盖封闭组件内部，二者的定制范式可能冲突。[Themes Styling：Tailwind](https://www.radix-ui.com/themes/docs/overview/styling#tailwind)
- 自定义 Portal 必须处理 Theme 继承；浮层层级遵循官方建议，以 Portal 打开顺序管理，避免任意高 z-index。[Themes Styling](https://www.radix-ui.com/themes/docs/overview/styling#z-index-conflicts)

### 暂时保留或重新设计

- `cmdk`：Radix 无官方 Command/Combobox；先包装成产品级 SearchableModelInput，后续再决定自研或调整交互。
- `react-day-picker`：Radix 无官方 Calendar；先用 Theme tokens 包装，不做无能力依据的替换。
- Tailwind：可保留在页面布局和少量产品专有组件。Themes 组件内部不以 Tailwind 覆盖为常态；CSS 顺序和 reset 需要单独验证。[Themes Styling](https://www.radix-ui.com/themes/docs/overview/styling)
- `class-variance-authority`、`clsx`、`tailwind-merge`、`tw-animate-css`：在本地 shadcn 视觉组件全部退出后再按引用归零删除。

## 5. 对新设计系统的直接约束

1. 根 Theme 固定亮色、gray 系主色、solid panel、统一 radius 与 scaling；最终取值必须经过真实页面原型验证。
2. 常用视觉组件优先 Themes。每个产品语义只开放一组 variant/size，页面不覆盖内部状态色。
3. Themes 无能力时使用 Primitive。自建组件必须覆盖 default、hover、focus-visible、active/selected、disabled、loading、error 与窄屏。
4. 当前位置、单选、多选、开关、状态分别使用 TabNav/Tabs、Select/Radio/ToggleGroup、Checkbox、Switch、Badge/Callout；相同颜色不代表相同交互语义。
5. Dialog/Popover/Tabs 等选用 controlled 模式时，业务选择和路由仍由页面状态模型持有；关闭浮层不得重建或清空背景状态。
6. 每个纯图标按钮有可访问名称；Tooltip 只承载辅助信息。
7. 响应式以 Themes 固定断点为主；页面级复杂布局才能使用项目 CSS。
8. shadcn 与 Themes 按组件族迁移。一个组件族完成后删除对应本地 wrapper，避免两套 Button、Dialog 或选中态长期共存。

## 6. 需要原型验证的未知项

以下结论不能仅靠文档确定，需要在迁移设计稿阶段验证：

- `accentColor="gray" highContrast` 是否能稳定还原近黑主操作、反白选中行及所有 hover 对比度。
- `radius="small"` 与 `scaling="95%"` 是否达到当前 6px、高密度管理面板的阅读和触控要求。
- Themes TabNav 在窄屏横向滚动和 TanStack Router active 状态下的视觉与焦点行为。
- Themes Table 对 sticky 权限列、宽表横向滚动、移动端替代卡片的适配程度。
- `cmdk` 和 `react-day-picker` 在 Theme tokens 下能否避免形成可见的第二套控件风格。
