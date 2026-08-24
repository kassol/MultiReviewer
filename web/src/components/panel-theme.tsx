import { Theme, type ThemeProps } from "@radix-ui/themes";

type PanelThemeProps = Pick<ThemeProps, "asChild" | "children">;

/**
 * 全站唯一的 Theme 实例。四个 prop 的取值都由 v8 设计定死,不开放给调用方:
 *
 * - `accentColor="blue"` 让 Radix 走 accent 那一族变量,具体色值在 styles.css 里被
 *   覆写成 Apple 蓝 `#0071e3`——选 blue 而不是别的,是因为它的中性搭配灰最接近。
 * - `radius="medium"` 只为拿到 `--radius-thumb: 9999px`(开关与滑块是圆的);六档
 *   圆角终值同样在 styles.css 里直接覆写,不靠 radius-factor 缩放。
 * - `scaling="100%"` 避免二次缩放:字号已经按 13.5px 正文逐档定死了。
 * - `panelBackground="solid"` 卡片是纯白实底;毛玻璃只属于顶栏、抽屉与命令面板,
 *   那三处各自在组件里写材质。
 */
export function PanelTheme({ asChild = false, children }: PanelThemeProps) {
  return (
    <Theme
      appearance="light"
      accentColor="blue"
      grayColor="gray"
      panelBackground="solid"
      radius="medium"
      scaling="100%"
      asChild={asChild}
    >
      {children}
    </Theme>
  );
}
