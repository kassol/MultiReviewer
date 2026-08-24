import { Theme, type ThemeProps } from "@radix-ui/themes";

type PanelThemeProps = Pick<ThemeProps, "asChild" | "children">;

export function PanelTheme({ asChild = false, children }: PanelThemeProps) {
  return (
    <Theme
      appearance="light"
      accentColor="gray"
      grayColor="gray"
      panelBackground="solid"
      radius="small"
      scaling="95%"
      asChild={asChild}
    >
      {children}
    </Theme>
  );
}
