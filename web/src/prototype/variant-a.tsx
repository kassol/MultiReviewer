/**
 * 变体 A —— 一个选择器吃下三条入口。
 *
 * 主张:操作员的动作只有一个,「往组合里加一个模型」。所以入口只有那颗「挑模型」按钮,
 * 三条路都在弹层里。目录列表是主体;搜不到时列表底部长出「手填这个标识」那一行,把搜索
 * 词直接当 model id 用;弹层最底下固定一条「加一家自定义 provider」。
 *
 * 赌的是:手填与自定义都是目录落空之后的补救,让它们出现在落空的那一刻最省事。
 * 风险:两条补救入口藏在弹层里,没落空过的人不知道它们存在。
 */
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CatalogProvider } from "@/components/model-picker";

import { Field, PickedList, configuredProviders, nameError, type Picked } from "./shared.tsx";

export function VariantA({
  providers,
  value,
  onChange,
}: {
  providers: CatalogProvider[];
  value: Picked[];
  onChange: (next: Picked[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [freehandFor, setFreehandFor] = useState<CatalogProvider | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  const groups = useMemo(() => {
    const needles = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return providers
      .map((provider) => ({
        provider,
        models: provider.models
          .filter((model) =>
            needles.every((needle) =>
              `${provider.id}:${model.id} ${model.name} ${provider.name}`
                .toLowerCase()
                .includes(needle),
            ),
          )
          .slice(0, needles.length === 0 ? 3 : 8),
      }))
      .filter((group) => group.models.length > 0)
      .slice(0, 8);
  }, [providers, query]);

  const empty = groups.length === 0 && query.trim() !== "";

  return (
    <Card className="gap-2.5 px-4">
      <h2 className="text-base font-semibold">模型组合</h2>
      <p className="text-muted-foreground">
        一次审查按这几个模型各跑一遍。搜不到的可以手填,厂商不在列表里可以自己加一家。
      </p>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-fit">
            {value.length === 0 ? "挑模型" : `已选 ${value.length} 个模型`}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(560px,calc(100vw-2rem))] gap-0 p-0">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="搜模型:名字、模型 id 或厂商"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-[300px]">
              {groups.map(({ provider, models }) => (
                <CommandGroup
                  key={provider.id}
                  heading={
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{provider.id}</span>
                      <span>{provider.name}</span>
                      {provider.configured ? null : (
                        <span className="text-warning">未配凭据,选不了</span>
                      )}
                    </span>
                  }
                >
                  {models.map((model) => {
                    const identity = `${provider.id}:${model.id}`;
                    return (
                      <CommandItem
                        key={identity}
                        value={identity}
                        disabled={!provider.configured}
                        onSelect={() => {
                          onChange(
                            value.some((item) => item.identity === identity)
                              ? value.filter((item) => item.identity !== identity)
                              : [...value, { identity, origin: "catalog" }],
                          );
                        }}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{model.name}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {identity}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}

              {empty ? (
                <div className="border-t p-3">
                  <p className="text-muted-foreground">
                    目录里没有 <span className="font-mono">{query}</span>。
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {configuredProviders(providers)
                      .slice(0, 4)
                      .map((provider) => (
                        <Button
                          key={provider.id}
                          size="sm"
                          variant="outline"
                          className="font-mono"
                          onClick={() => {
                            setFreehandFor(provider);
                            setOpen(false);
                          }}
                        >
                          手填进 {provider.id}
                        </Button>
                      ))}
                  </div>
                </div>
              ) : null}
            </CommandList>

            <div className="border-t p-2">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setCustomOpen(true);
                  setOpen(false);
                }}
              >
                + 加一家自定义 provider
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      <PickedList
        value={value}
        onRemove={(identity) => onChange(value.filter((item) => item.identity !== identity))}
      />

      <FreehandDialog
        provider={freehandFor}
        onClose={() => setFreehandFor(null)}
        onAdd={(identity) => {
          onChange([...value, { identity, origin: "freehand" }]);
          setFreehandFor(null);
        }}
        initialId={query}
      />
      <CustomProviderDialog
        open={customOpen}
        providers={providers}
        onClose={() => setCustomOpen(false)}
        onAdd={(identity) => {
          onChange([...value, { identity, origin: "custom" }]);
          setCustomOpen(false);
        }}
      />
    </Card>
  );
}

function FreehandDialog({
  provider,
  initialId,
  onClose,
  onAdd,
}: {
  provider: CatalogProvider | null;
  initialId: string;
  onClose: () => void;
  onAdd: (identity: string) => void;
}) {
  const [id, setId] = useState(initialId);
  const [cost, setCost] = useState("");

  return (
    <Dialog open={provider !== null} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手填一个模型标识</DialogTitle>
          <DialogDescription>
            填进 <span className="font-mono">{provider?.id}</span>。接口地址与协议跟这家现有的
            模型走,只要填 model id。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field
            id="a-model-id"
            label="model id"
            mono
            value={id}
            onChange={setId}
            placeholder="例如 deepseek-v4-turbo"
          />
          <Field
            id="a-cost"
            label="单价(选填)"
            hint="留空不影响审查,只是这个模型的成本会记为零。"
            value={cost}
            onChange={setCost}
            placeholder="每百万 token,入/出"
          />
        </div>
        <DialogFooter>
          <Button disabled={id.trim() === ""} onClick={() => onAdd(`${provider?.id}:${id.trim()}`)}>
            加进组合
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomProviderDialog({
  open,
  providers,
  onClose,
  onAdd,
}: {
  open: boolean;
  providers: CatalogProvider[];
  onClose: () => void;
  onAdd: (identity: string) => void;
}) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const error = nameError(name, providers);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>加一家自定义 provider</DialogTitle>
          <DialogDescription>
            任何 OpenAI 兼容的端点。名字由你起,一个名字对应一个地址与一把 key。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field
            id="a-name"
            label="名字"
            mono
            value={name}
            onChange={setName}
            hint={error ?? "小写字母、数字与连字符。它会出现在模型标识的前半段。"}
            placeholder="例如 corp-gateway"
          />
          <Field
            id="a-base"
            label="接口地址"
            mono
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://gateway.corp.internal/v1"
          />
          <Field id="a-key" label="API key" value={key} onChange={setKey} />
          <Field
            id="a-first-model"
            label="第一个 model id"
            mono
            value={model}
            onChange={setModel}
            hint="新加的一家还没有现成模型,所以要给一个。之后可以再手填更多。"
          />
        </div>
        <DialogFooter>
          <Button
            disabled={error !== null || name === "" || baseUrl === "" || model === ""}
            onClick={() => onAdd(`${name}:${model.trim()}`)}
          >
            加进组合
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
