/**
 * 变体 C —— 先选厂商,再选模型。两级。
 *
 * 主张:三条入口其实是同一棵树上的两层。左边一列是厂商(内置 39 家加自定义的,同一个列表,
 * 底部一颗「+ 加一家」);右边是选中那家的模型列表,底部固定一行「手填一个 model id」。
 * 手填因此天然只出现在已选定的那一家下面,「填进哪一家」这个问题在界面上不存在。
 *
 * 赌的是:两级导航比一个大搜索框更能表达「自定义 provider 与内置的是同一类东西」。
 * 风险:找一个记不住厂商的模型时要多点一步,跨厂商搜索被牺牲。
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CatalogProvider } from "@/components/model-picker";

import { Field, PickedList, nameError, type Picked } from "./shared.tsx";

export function VariantC({
  providers,
  value,
  onChange,
}: {
  providers: CatalogProvider[];
  value: Picked[];
  onChange: (next: Picked[]) => void;
}) {
  // 目录是异步来的,首帧 providers 还是空数组,所以选中项不能只在初值里定一次。
  const [picked, setPicked] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [freehand, setFreehand] = useState("");
  const [customOpen, setCustomOpen] = useState(false);

  const selected = picked ?? providers[0]?.id ?? "";
  const provider = providers.find((entry) => entry.id === selected);
  const models = (provider?.models ?? [])
    .filter((model) =>
      `${model.id} ${model.name}`.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice(0, 40);

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-2.5 px-4">
        <h2 className="text-base font-semibold">模型组合</h2>
        <p className="text-muted-foreground">一次审查按这几个模型各跑一遍。</p>
        <PickedList
          value={value}
          onRemove={(identity) => onChange(value.filter((item) => item.identity !== identity))}
        />
      </Card>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="grid min-h-[420px] grid-cols-[220px_1fr]">
          <div className="flex flex-col border-r bg-chrome">
            <p className="border-b px-3 py-2 text-xs text-muted-foreground">厂商</p>
            <div className="flex-1 overflow-y-auto">
              {providers.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left ${
                    entry.id === selected ? "bg-background" : "hover:bg-background/60"
                  }`}
                  onClick={() => {
                    setPicked(entry.id);
                    setQuery("");
                  }}
                >
                  <span className="font-mono">{entry.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {entry.models.length} 个模型
                    {entry.configured ? "" : " · 未配凭据"}
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="border-t px-3 py-2.5 text-left hover:bg-background/60"
              onClick={() => setCustomOpen(true)}
            >
              + 加一家 provider
            </button>
          </div>

          <div className="flex flex-col">
            <div className="border-b px-3 py-2">
              <Input
                className="h-8"
                placeholder={`在 ${selected} 里搜模型`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {models.map((model) => {
                const identity = `${selected}:${model.id}`;
                const picked = value.some((item) => item.identity === identity);
                return (
                  <button
                    key={identity}
                    type="button"
                    disabled={provider?.configured !== true}
                    className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left hover:bg-muted disabled:opacity-45"
                    onClick={() => {
                      onChange(
                        picked
                          ? value.filter((item) => item.identity !== identity)
                          : [...value, { identity, origin: "catalog" }],
                      );
                    }}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{model.name}</span>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {model.id}
                      </span>
                    </span>
                    {picked ? <span className="text-primary">已选</span> : null}
                  </button>
                );
              })}
            </div>

            <div className="flex items-end gap-2 border-t p-3">
              <div className="flex-1">
                <Field
                  id="c-freehand"
                  label={`手填一个 ${selected} 的 model id`}
                  mono
                  value={freehand}
                  onChange={setFreehand}
                  hint={
                    provider?.configured === true
                      ? "目录里还没有的新模型直接填进来。单价留空则成本记零。"
                      : "这家还没配凭据,填了也跑不起来。"
                  }
                />
              </div>
              <Button
                variant="outline"
                disabled={freehand.trim() === "" || provider?.configured !== true}
                onClick={() => {
                  onChange([
                    ...value,
                    { identity: `${selected}:${freehand.trim()}`, origin: "freehand" },
                  ]);
                  setFreehand("");
                }}
              >
                加进组合
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <CustomProviderDialog
        open={customOpen}
        providers={providers}
        onClose={() => setCustomOpen(false)}
        onAdd={(identity) => {
          onChange([...value, { identity, origin: "custom" }]);
          setCustomOpen(false);
        }}
      />
    </div>
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
          <DialogTitle>加一家 provider</DialogTitle>
          <DialogDescription>
            加完它会出现在左边那一列里,和内置的那些家排在一起。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field
            id="c-name"
            label="名字"
            mono
            value={name}
            onChange={setName}
            hint={error ?? "小写字母、数字与连字符。"}
            placeholder="corp-gateway"
          />
          <Field
            id="c-base"
            label="接口地址"
            mono
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="https://…/v1"
          />
          <Field id="c-key" label="API key" value={key} onChange={setKey} />
          <Field id="c-first" label="第一个 model id" mono value={model} onChange={setModel} />
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
