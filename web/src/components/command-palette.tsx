import { Dialog, VisuallyHidden } from "@radix-ui/themes";
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
        className="!top-[158px] !w-[584px] !max-w-[calc(100vw-32px)] !translate-y-0 !rounded-2xl !border-0 !bg-[color:var(--v8-palette-bg)] !p-0 !shadow-palette backdrop-blur-[50px]"
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
          />
          <CommandList className="max-h-[min(60vh,420px)] p-[9px]">
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
          <footer className="flex gap-4 border-t border-chrome-line px-5 py-2.5 text-sm text-text-muted">
            <span><kbd className="font-mono">↑↓</kbd> 选择</span>
            <span><kbd className="font-mono">↵</kbd> 打开</span>
            <span><kbd className="font-mono">esc</kbd> 关闭</span>
          </footer>
        </Command>
      </Dialog.Content>
    </Dialog.Root>
  );
}
