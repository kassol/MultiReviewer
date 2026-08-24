import {
  Button as RadixButton,
  type ButtonProps as RadixButtonProps,
} from "@radix-ui/themes";
import type { ForwardRefExoticComponent, RefAttributes } from "react";

/**
 * @radix-ui/themes 3.3.0 在 exactOptionalPropertyTypes 下把 highContrast 推导为 never。
 * 这里只修正声明；导出的仍是原始 Radix Themes Button，不增加组件、行为或 DOM。
 */
export type ButtonProps = Omit<RadixButtonProps, "highContrast"> & {
  highContrast?: boolean;
};

export const Button = RadixButton as ForwardRefExoticComponent<
  ButtonProps & RefAttributes<HTMLButtonElement>
>;
