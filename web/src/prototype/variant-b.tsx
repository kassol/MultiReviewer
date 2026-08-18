/**
 * 变体 B —— 三条入口是三张并列的卡片。
 *
 * 主张:三条入口是三件不同的事,摊开摆平比藏进一个控件诚实。第一张是目录选择器,第二张
 * 是手填(provider 下拉 + model id),第三张是自定义 provider(名字 + 地址 + key)。三张
 * 都常驻在页面上,谁都不用先落空一次才发现。
 *
 * 赌的是:操作员能一眼看懂三条路的分工。
 * 风险:页面变长,常用的那条(目录里选)被两条应急入口稀释。
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
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { CatalogProvider } from "@/components/model-picker";

import { Field, PickedList, configuredProviders, nameError, type Picked } from "./shared.tsx";

export function VariantB({
  providers,
  value,
  onChange,
}: {
  providers: CatalogProvider[];
  value: Picked[];
  onChange: (next: Picked[]) => void;
}) {
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

      <div className="grid gap-4 lg:grid-cols-3">
        <CatalogCard providers={providers} value={value} onChange={onChange} />
        <FreehandCard providers={providers} value={value} onChange={onChange} />
        <CustomCard providers={providers} value={value} onChange={onChange} />
      </div>
    </div>
  );
}

type CardProps = {
  providers: CatalogProvider[];
  value: Picked[];
  onChange: (next: Picked[]) => void;
};

function CatalogCard({ providers, value, onChange }: CardProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const needles = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return providers
      .map((provider) => ({
        provider,
        models: provider.models
          .filter((model) =>
            needles.every((needle) =>
              `${provider.id}:${model.id} ${model.name}`.toLowerCase().includes(needle),
            ),
          )
          .slice(0, needles.length === 0 ? 3 : 8),
      }))
      .filter((group) => group.models.length > 0)
      .slice(0, 8);
  }, [providers, query]);

  return (
    <Card className="gap-2.5 px-4">
      <h3 className="text-base font-semibold">从目录里选</h3>
      <p className="text-xs text-muted-foreground">
        内置加远程目录,约 1200 个模型。绝大多数时候用这个。
      </p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="w-fit">
            挑模型
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(520px,calc(100vw-2rem))] gap-0 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="搜模型" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[300px]">
              {groups.map(({ provider, models }) => (
                <CommandGroup
                  key={provider.id}
                  heading={
                    <span className="flex items-center gap-2">
                      <span className="font-mono">{provider.id}</span>
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
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Card>
  );
}

function FreehandCard({ providers, value, onChange }: CardProps) {
  const configured = configuredProviders(providers);
  const [provider, setProvider] = useState(configured[0]?.id ?? "");
  const [model, setModel] = useState("");

  return (
    <Card className="gap-2.5 px-4">
      <h3 className="text-base font-semibold">手填一个标识</h3>
      <p className="text-xs text-muted-foreground">
        厂商刚发的新模型还没进目录时用。接口地址跟这家现有模型走。
      </p>
      <div className="flex flex-col gap-1">
        <Label htmlFor="b-provider">厂商</Label>
        <select
          id="b-provider"
          className="h-9 rounded-md border bg-transparent px-3 font-mono"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {configured.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">只列已配凭据的厂商。</p>
      </div>
      <Field
        id="b-model"
        label="model id"
        mono
        value={model}
        onChange={setModel}
        placeholder="例如 deepseek-v4-turbo"
      />
      <Button
        variant="outline"
        className="w-fit"
        disabled={model.trim() === ""}
        onClick={() => {
          onChange([...value, { identity: `${provider}:${model.trim()}`, origin: "freehand" }]);
          setModel("");
        }}
      >
        加进组合
      </Button>
    </Card>
  );
}

function CustomCard({ providers, value, onChange }: CardProps) {
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const error = nameError(name, providers);

  return (
    <Card className="gap-2.5 px-4">
      <h3 className="text-base font-semibold">加一家 provider</h3>
      <p className="text-xs text-muted-foreground">
        公司网关、本地部署,任何 OpenAI 兼容的端点。
      </p>
      <Field
        id="b-name"
        label="名字"
        mono
        value={name}
        onChange={setName}
        hint={error ?? "小写字母、数字与连字符。"}
        placeholder="corp-gateway"
      />
      <Field
        id="b-base"
        label="接口地址"
        mono
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://…/v1"
      />
      <Field id="b-key" label="API key" value={key} onChange={setKey} />
      <Field id="b-first" label="第一个 model id" mono value={model} onChange={setModel} />
      <Button
        variant="outline"
        className="w-fit"
        disabled={error !== null || name === "" || baseUrl === "" || model === ""}
        onClick={() => {
          onChange([...value, { identity: `${name}:${model.trim()}`, origin: "custom" }]);
          setModel("");
        }}
      >
        加进组合
      </Button>
    </Card>
  );
}
