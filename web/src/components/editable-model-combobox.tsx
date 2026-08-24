import { CheckIcon, ChevronDownIcon } from "@radix-ui/react-icons";
import { IconButton, Popover, Text, TextField, Tooltip } from "@radix-ui/themes";
import { useEffect, useId, useRef, useState } from "react";

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type EditableModelCandidate = Readonly<{
  id: string;
  name: string | null;
}>;

type EditableModelComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  candidates: readonly EditableModelCandidate[] | undefined;
  disabled?: boolean;
  label: string;
};

/** 允许从自动发现结果选择，也始终保留目录外裸 model id 的直接输入。 */
export function EditableModelCombobox({
  value,
  onChange,
  candidates,
  disabled = false,
  label,
}: EditableModelComboboxProps) {
  const inputId = useId();
  const listId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchInput.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <Text as="label" htmlFor={inputId} size="2" weight="medium">{label}</Text>
      <div className="flex min-w-0">
        <TextField.Root
          id={inputId}
          size={{ initial: "3", sm: "2" }}
          className="min-w-0 w-full rounded-r-none font-mono max-sm:min-h-11"
          placeholder="只填 model id，不带 provider 前缀"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" || open) return;
            event.preventDefault();
            setOpen(true);
          }}
        />
        <Popover.Root open={open} onOpenChange={setOpen}>
          <Tooltip content="从自动发现的模型中选择">
            <Popover.Trigger>
              <IconButton
                type="button"
                variant="outline"
                color="gray"
                size={{ initial: "3", sm: "2" }}
                className="-ml-px rounded-l-none px-2.5 max-sm:min-h-11 max-sm:min-w-11"
                disabled={disabled}
                aria-label="从自动发现的模型中选择"
                aria-controls={listId}
                aria-expanded={open}
              >
                <ChevronDownIcon aria-hidden />
              </IconButton>
            </Popover.Trigger>
          </Tooltip>
          <Popover.Content
            align="start"
            size="1"
            width="min(32rem, calc(100vw - var(--space-4)))"
            maxWidth="calc(100vw - var(--space-4))"
            maxHeight="calc(100vh - var(--space-4))"
            className="overflow-hidden"
          >
            <Command>
              <CommandInput ref={searchInput} placeholder="搜索自动发现的模型" />
              <CommandList id={listId}>
                <CommandEmpty>
                  {candidates === undefined
                    ? "模型目录按权限隐藏。仍可手填 model id。"
                    : "没有匹配的模型。仍可手填 model id。"}
                </CommandEmpty>
                {(candidates ?? []).map((candidate) => (
                  <CommandItem
                    key={candidate.id}
                    value={candidate.id}
                    keywords={candidate.name === null ? [] : [candidate.name]}
                    className="items-start whitespace-normal"
                    onSelect={() => {
                      onChange(candidate.id);
                      setOpen(false);
                    }}
                  >
                    <CheckIcon
                      className={cn(
                        "mt-0.5 shrink-0",
                        value === candidate.id ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block break-all font-mono">{candidate.id}</span>
                      {candidate.name === null || candidate.name === candidate.id ? null : (
                        <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                          {candidate.name}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </Popover.Content>
        </Popover.Root>
      </div>
    </div>
  );
}
