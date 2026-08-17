/**
 * 模型多选器(issue #68)。目录来自 `GET <前缀>/api/catalog`,选项键就是模型标识
 * `provider:model`——「同一次审查里标识不得重复」因此由组件天然满足,而同一个 model id
 * 在两家 provider 下是两个不同选项,可以同时选中。
 *
 * 目录实测 39 家 provider、1153 个模型,一次全渲染会让每次输入都卡住,所以列表永远
 * 按搜索词裁剪:不搜时每家只列前几个并标出还有多少,搜到了才展开那一家。
 *
 * 没配凭据的 provider 照常显示,只是选不了,并在那一行给去凭据页的链接——不显示会让人
 * 不知道还能配哪些家,能选会让人选出一个必然跑不起来的组合。
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { fetchJson } from "../api.ts";

/** 单价,原样透出 Pi 的 `ModelCost`:每百万 token 的美元数。 */
export type CatalogCost = { input: number; output: number };

export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  cost: CatalogCost;
};

export type CatalogProvider = {
  id: string;
  name: string;
  configured: boolean;
  /** 保存凭据时这家会不会真发一次验证请求。服务端给,前端不自己列名单。 */
  verifiable: boolean;
  models: CatalogModel[];
};

/** 目录与凭据状态一次拿齐,选择器与仓库覆盖(issue #69)共用这一份查询。 */
export function useModelCatalog() {
  return useQuery({
    queryKey: ["catalog"],
    queryFn: () => fetchJson<{ providers: CatalogProvider[] }>("/catalog"),
  });
}

/** 模型标识:`provider:model`,与后端 `modelIdentity` 同一形状。 */
export function modelIdentity(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

/** 标识拆回 ReviewerSpec。provider 由所选模型直接推出,不做两级选择器。 */
export function parseModelIdentity(identity: string): { provider: string; model: string } {
  const at = identity.indexOf(":");
  return { provider: identity.slice(0, at), model: identity.slice(at + 1) };
}

/** 不搜索时每家只列这么多:一屏能看见有哪些家,比一次列全更有用。 */
const PREVIEW_PER_PROVIDER = 4;
/** 搜索时每家最多列这么多,以及全部加起来最多列这么多。 */
const MATCHES_PER_PROVIDER = 12;
const MATCHES_TOTAL = 120;

type Group = { provider: CatalogProvider; models: CatalogModel[]; hidden: number };

/** 搜索词按空格分词,每个词都要能在标识、模型名或厂商名里找到。 */
function hit(needles: string[], provider: CatalogProvider, model: CatalogModel): boolean {
  const haystack = `${provider.id}:${model.id} ${model.name} ${provider.name}`.toLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

function priceText(cost: CatalogCost): string {
  return `$${cost.input}/M 入 · $${cost.output}/M 出`;
}

function contextText(contextWindow: number): string {
  return `${Math.round(contextWindow / 1000)}K 上下文`;
}

export type ModelPickerProps = {
  providers: CatalogProvider[];
  /** 已选的模型标识,受控。 */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
};

export function ModelPicker({ providers, value, onChange, disabled }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const { groups, hiddenProviders } = useMemo((): {
    groups: Group[];
    hiddenProviders: number;
  } => {
    const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const perProvider = needles.length === 0 ? PREVIEW_PER_PROVIDER : MATCHES_PER_PROVIDER;
    const result: Group[] = [];
    let shown = 0;
    // 总量到顶之后剩下的那些家一家都列不出来,数出来告诉人,别让它们无声消失。
    let hiddenProviders = 0;
    for (const provider of providers) {
      const matched =
        needles.length === 0
          ? provider.models
          : provider.models.filter((model) => hit(needles, provider, model));
      if (matched.length === 0) continue;
      const room = Math.max(0, Math.min(perProvider, MATCHES_TOTAL - shown));
      if (room === 0) {
        hiddenProviders += 1;
        continue;
      }
      const models = matched.slice(0, room);
      shown += models.length;
      result.push({ provider, models, hidden: matched.length - models.length });
    }
    return { groups: result, hiddenProviders };
  }, [providers, query]);

  const toggle = (identity: string): void => {
    onChange(
      value.includes(identity)
        ? value.filter((item) => item !== identity)
        : [...value, identity],
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" disabled={disabled} className="w-fit">
            {value.length === 0 ? "挑模型" : `已选 ${value.length} 个模型`}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(560px,calc(100vw-2rem))] gap-0 p-0">
          {/* cmdk 自带的过滤会把 1153 个选项全渲染出来再筛,这里自己按搜索词裁剪结果。 */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="搜模型:名字、模型 id 或厂商"
              value={query}
              onValueChange={setQuery}
            />
            <CommandList className="max-h-[340px]">
              {groups.length === 0 ? (
                <p className="py-6 text-center text-muted-foreground">没有匹配的模型。</p>
              ) : null}
              {groups.map(({ provider, models, hidden }) => (
                <CommandGroup
                  key={provider.id}
                  heading={
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono">{provider.id}</span>
                      <span>{provider.name}</span>
                      {provider.configured ? null : (
                        <>
                          <span className="text-warning">未配凭据,选不了</span>
                          <Link
                            to="/credentials"
                            className="text-primary underline underline-offset-4"
                          >
                            去配凭据
                          </Link>
                        </>
                      )}
                    </span>
                  }
                >
                  {models.map((model) => {
                    const identity = `${provider.id}:${model.id}`;
                    const picked = value.includes(identity);
                    return (
                      <CommandItem
                        key={identity}
                        value={identity}
                        disabled={!provider.configured}
                        onSelect={() => toggle(identity)}
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">
                            {model.name}
                            {picked ? <span className="ml-2 text-primary">已选</span> : null}
                          </span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {identity}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {contextText(model.contextWindow)} · {priceText(model.cost)}
                        </span>
                      </CommandItem>
                    );
                  })}
                  {hidden > 0 ? (
                    <p className="px-2 py-1.5 text-xs text-muted-foreground">
                      这家还有 {hidden} 个,继续输入以缩小范围。
                    </p>
                  ) : null}
                </CommandGroup>
              ))}
              {hiddenProviders > 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  还有 {hiddenProviders} 家没列出,继续输入以缩小范围。
                </p>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {value.length === 0 ? (
        <p className="text-muted-foreground">还没选模型。</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {value.map((identity) => (
            <Badge key={identity} variant="outline" className="gap-1.5 font-mono">
              {identity}
              <button
                type="button"
                aria-label={`移除 ${identity}`}
                disabled={disabled}
                className="-mr-0.5 text-muted-foreground transition-colors hover:text-destructive"
                onClick={() => toggle(identity)}
              >
                {/* 画出来的图标,不用 `×` 这个字符:字符的粗细与基线跟不上旁边的文字。 */}
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
