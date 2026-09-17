import { Cross2Icon } from "@radix-ui/react-icons";
import { Dialog, IconButton, VisuallyHidden } from "@radix-ui/themes";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { CommandInput } from "@/components/ui/command";

export type CommandPaletteState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  setOpen: (next: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
};

/**
 * ⌘K / Ctrl+K 全局开关。监听挂在 window 上而不是某个容器上,因为面板要在任意页面、
 * 任意焦点位置都能唤起;输入框里按下时不拦截,那是用户在打字。
 */
export function useCommandPalette(): CommandPaletteState {
  const [isOpen, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen((previous) => !previous);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return {
    isOpen,
    open: useCallback(() => setOpen(true), []),
    close: useCallback(() => setOpen(false), []),
    setOpen,
    triggerRef,
  };
}

type PaletteItem = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * 命令面板。当前只收导航跳转——这是面板里唯一一类「知道目标名字就想直接过去」的
 * 动作;触发评审、注册仓库这类动作都需要先选对象,放进来只会变成又一次跳转。
 */
export function CommandPalette({
  nav,
  state,
}: {
  nav: readonly PaletteItem[];
  state: CommandPaletteState;
}) {
  const router = useRouter();
  return (
    <Dialog.Root open={state.isOpen} onOpenChange={state.setOpen}>
      <Dialog.Content
        aria-label="命令面板"
        // 窄屏顶靠视口:Themes 把 Dialog.Content 摆在一个可滚动的居中容器里(`position: relative`
        // 加外圈 24px/16px 的留白),面板因此吊在屏幕中段,软键盘一升起来候选就被盖掉。这里改成
        // `fixed` 直接脱出那个容器,贴着视口顶边铺满一行,刘海区靠 safe-area 顶部内边距让开。
        className="!top-[158px] !w-[584px] !max-w-[calc(100vw-32px)] !translate-y-0 !rounded-2xl !border-0 !bg-[color:var(--v8-palette-bg)] !p-0 !shadow-palette backdrop-blur-[50px] max-sm:!fixed max-sm:!inset-x-0 max-sm:!top-0 max-sm:!w-full max-sm:!max-w-none max-sm:!rounded-t-none max-sm:!pt-[env(safe-area-inset-top)]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => state.triggerRef.current?.focus());
        }}
      >
        <VisuallyHidden>
          <Dialog.Title>命令面板</Dialog.Title>
          <Dialog.Description>输入页面名称跳转</Dialog.Description>
        </VisuallyHidden>
        <Command className="!bg-transparent" loop>
          <CommandInput
            placeholder="跳转到…"
            aria-label="搜索页面"
            className="!h-auto !text-4xl placeholder:text-text-disabled"
            trailing={
              <Dialog.Close>
                <IconButton
                  variant="ghost"
                  color="gray"
                  size="2"
                  // 关闭键与页脚的键位提示此消彼长:触屏或窄屏上出现,鼠标宽屏上让位给 esc 提示。
                  className="hidden min-h-11 min-w-11 shrink-0 max-sm:inline-flex pointer-coarse:inline-flex"
                  aria-label="关闭命令面板"
                >
                  <Cross2Icon aria-hidden />
                </IconButton>
              </Dialog.Close>
            }
          />
          {/* 窄屏的高度上限跟着视口走:面板顶靠视口,列表最多占满搜索行之下剩下的那一段。 */}
          <CommandList className="max-h-[min(60vh,420px)] p-[9px] max-sm:max-h-[calc(100dvh-44px-env(safe-area-inset-top))]">
            <CommandEmpty className="px-3 py-6 text-center text-md text-text-muted">没有匹配的页面</CommandEmpty>
            <CommandGroup heading="页面">
              {nav.map((item) => (
                <CommandItem
                  key={item.to}
                  value={item.label}
                  onSelect={() => {
                    state.close();
                    void router.navigate({ to: item.to });
                  }}
                  className="!gap-3 !rounded-[10px] !px-[13px] !py-[9px] !text-xl data-[selected=true]:!bg-primary data-[selected=true]:!font-semibold data-[selected=true]:!text-white data-[selected=true]:!shadow-accent-strong"
                  asChild
                >
                  <Link to={item.to}>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-fill text-text-secondary group-data-[selected=true]:bg-white/20">
                      <item.icon className="size-[13px]" />
                    </span>
                    <span className="flex-1 truncate">{item.label}</span>
                  </Link>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {/* 键位提示对触屏是纯噪音,那里没有 ↑↓ 也没有 esc;关闭改由搜索行的关闭键承担。 */}
          <footer className="flex gap-4 border-t border-chrome-line px-5 py-2.5 text-sm text-text-muted pointer-coarse:hidden">
            <span><kbd className="font-mono">↑↓</kbd> 选择</span>
            <span><kbd className="font-mono">↵</kbd> 打开</span>
            <span><kbd className="font-mono">esc</kbd> 关闭</span>
          </footer>
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
}
