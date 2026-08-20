/**
 * 全局模型组合与仓库模型覆盖共用的两栏编辑器。它只消费 `GET /model-services` 的统一候选
 * 投影；模型服务、凭据、自动目录与模型补录都回模型服务页处理，这里不发任何服务写请求。
 */
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import {
  SOURCE_LABEL,
  useModelServices,
  type ModelService,
  type ModelServiceModel,
} from "../model-services.ts";

const MODELS_SHOWN = 120;
const NUMBER_FORMAT = new Intl.NumberFormat("zh-CN");
const COST_UNKNOWN_NOTE = "费用未记账";

type UnavailableSelection = {
  identity: string;
  reason: string;
  action: "/credentials";
};

export type ModelComposerValidity = {
  ready: boolean;
  unavailable: readonly UnavailableSelection[];
};

export type ModelComposerProps = {
  /** 当前模型组合，元素是完整模型标识 `provider:model`。 */
  value: string[];
  onChange: (next: string[]) => void;
  /** 调用页只用它门禁本层保存；批次上限等无关写入不得被连坐。 */
  onValidityChange?: (validity: ModelComposerValidity) => void;
};

type ProviderGroup = {
  provider: string;
  name: string;
  service: ModelService | undefined;
  models: ModelServiceModel[];
};

export function ModelComposer({ value, onChange, onValidityChange }: ModelComposerProps) {
  const query = useModelServices();
  const [pickedProvider, setPickedProvider] = useState<string | null>(null);
  const services = query.data?.services ?? [];
  const candidates = query.data?.candidates ?? [];
  const visibleCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.available || value.includes(candidate.identity)),
    [candidates, value],
  );

  const candidateByIdentity = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.identity, candidate])),
    [candidates],
  );
  const groups = useMemo(() => {
    const serviceByProvider = new Map(services.map((service) => [service.provider, service]));
    const byProvider = new Map<string, ProviderGroup>();
    for (const service of services) {
      byProvider.set(service.provider, {
        provider: service.provider,
        name: service.name,
        service,
        models: [],
      });
    }
    for (const model of visibleCandidates) {
      let group = byProvider.get(model.provider);
      if (group === undefined) {
        const service = serviceByProvider.get(model.provider);
        group = {
          provider: model.provider,
          name: service?.name ?? model.provider,
          service,
          models: [],
        };
        byProvider.set(model.provider, group);
      }
      group.models.push(model);
    }
    for (const group of byProvider.values()) {
      group.models.sort((left, right) => left.id.localeCompare(right.id));
    }
    return [...byProvider.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider),
    );
  }, [services, visibleCandidates]);
  const selected = groups.find((group) => group.provider === pickedProvider) ?? groups[0];

  const validity = useMemo<ModelComposerValidity>(() => {
    const ready = query.isSuccess && query.data.candidates !== undefined;
    if (!ready) return { ready: false, unavailable: [] };
    const unavailable: UnavailableSelection[] = [];
    for (const identity of value) {
      const candidate = candidateByIdentity.get(identity);
      if (candidate?.available === true) continue;
      unavailable.push({
        identity,
        reason: candidate?.unavailableReasonText ?? "模型来源消失",
        action: candidate?.unavailableAction ?? "/credentials",
      });
    }
    return { ready: true, unavailable };
  }, [candidateByIdentity, query.data?.candidates, query.isSuccess, value]);
  useEffect(() => onValidityChange?.(validity), [onValidityChange, validity]);

  const toggle = (identity: string): void => {
    onChange(
      value.includes(identity)
        ? value.filter((item) => item !== identity)
        : [...value, identity],
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-2.5 px-4">
        <h2 className="text-base font-semibold">模型组合</h2>
        <p className="text-muted-foreground">
          一次审查按这几个模型各跑一遍。这里只选择模型；配置服务、凭据与模型来源请到模型服务页。
        </p>
        {value.length === 0 ? (
          <p className="text-muted-foreground">还没选模型。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {value.map((identity) => {
              const candidate = candidateByIdentity.get(identity);
              const reason =
                candidate?.available === false
                  ? candidate.unavailableReasonText ?? "模型来源消失"
                  : candidate === undefined && validity.ready
                    ? "模型来源消失"
                    : null;
              return (
                <Badge
                  key={identity}
                  variant="outline"
                  className={cn(
                    "gap-1.5 font-mono",
                    reason === null ? null : "border-destructive/40 bg-destructive/5",
                  )}
                >
                  <span className="max-w-full break-all">{identity}</span>
                  {candidate?.sources.map((source) => (
                    <span
                      key={source}
                      className="rounded-sm bg-muted px-1 font-sans text-xs text-muted-foreground"
                    >
                      {SOURCE_LABEL[source]}
                    </span>
                  ))}
                  {reason === null ? null : (
                    <span className="font-sans text-destructive">{reason}</span>
                  )}
                  <button
                    type="button"
                    aria-label={`移除 ${identity}`}
                    className="-mr-0.5 shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => toggle(identity)}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
        {validity.unavailable.length === 0 ? null : (
          <p className="text-xs text-destructive">
            不可用模型可以移除，但不能随组合再次保存。恢复服务后会按原标识自动变回可用。{" "}
            <Link to="/credentials" className="underline underline-offset-4">
              去模型服务处理
            </Link>
          </p>
        )}
      </Card>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="grid h-[460px] grid-cols-[180px_minmax(0,1fr)] sm:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col border-r border-border bg-chrome">
            <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              模型服务 <span className="font-mono tabular-nums">{groups.length}</span> 项
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {query.isPending ? (
                <div className="p-3"><Skeleton className="h-56" /></div>
              ) : (
                groups.map((group) => {
                  const available = group.models.filter((model) => model.available).length;
                  const unavailable = group.models.length - available;
                  return (
                    <button
                      key={group.provider}
                      type="button"
                      aria-pressed={group.provider === selected?.provider}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left",
                        group.provider === selected?.provider
                          ? "bg-background"
                          : "hover:bg-background/60",
                      )}
                      onClick={() => setPickedProvider(group.provider)}
                    >
                      <span className="w-full truncate font-mono">{group.provider}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono tabular-nums">{available}</span> 个可选
                        {unavailable === 0 ? null : (
                          <span className="text-destructive">
                            {" "}· <span className="font-mono tabular-nums">{unavailable}</span> 个不可用
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <Link
              to="/credentials"
              className="border-t border-border px-3 py-2.5 hover:bg-background/60"
            >
              管理模型服务
            </Link>
          </div>

          {selected === undefined ? (
            <div className="flex min-w-0 flex-col gap-2 p-3">
              {query.isPending ? (
                <Skeleton className="h-56" />
              ) : (
                <>
                  <p className="text-muted-foreground">还没有模型服务候选。</p>
                  <Link to="/credentials" className="text-primary underline underline-offset-4">
                    去配置模型服务
                  </Link>
                </>
              )}
            </div>
          ) : (
            <ProviderPane
              key={selected.provider}
              group={selected}
              value={value}
              onToggle={toggle}
            />
          )}
        </div>
      </Card>

      {query.isError ? (
        <div className="flex flex-wrap items-center gap-3 text-destructive">
          <p>模型服务候选读不到：{(query.error as Error).message}</p>
          <Button type="button" variant="outline" size="xs" onClick={() => void query.refetch()}>
            重试
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ProviderPane({
  group,
  value,
  onToggle,
}: {
  group: ProviderGroup;
  value: string[];
  onToggle: (identity: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matched = useMemo(() => {
    const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (needles.length === 0) return group.models;
    return group.models.filter((model) => {
      const haystack = `${model.id} ${model.discovery.name ?? ""}`.toLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    });
  }, [group.models, query]);
  const models = matched.slice(0, MODELS_SHOWN);
  const hidden = matched.length - models.length;

  return (
    <div className="flex min-w-0 min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-mono">{group.provider}</span>
        {group.name === group.provider ? null : (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{group.name}</span>
        )}
        <span className={cn(
          "text-xs",
          group.service?.health === "healthy" ? "text-success" : "text-warning",
          group.service?.health === "disabled" ? "text-destructive" : null,
        )}>
          {group.service === undefined
            ? "模型服务已移除"
            : group.service.providerState === "name-conflict"
              ? "名字冲突，已停用"
              : group.service.credential.state !== "verified"
                ? "模型凭据不可用"
                : group.models.some((model) => model.available)
                  ? "可选择"
                  : "没有可用模型"}
        </span>
        <Link
          to="/credentials"
          className="ml-auto shrink-0 text-xs text-primary underline underline-offset-4"
        >
          管理服务
        </Link>
      </div>

      <div className="border-b border-border px-3 py-2">
        <Input
          aria-label={`在 ${group.provider} 里搜模型`}
          placeholder={`在 ${group.provider} 里搜模型`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {models.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-6 text-center text-muted-foreground">
            <p>{group.models.length === 0 ? "这项服务还没有模型来源。" : "这项服务没有匹配的模型。"}</p>
            {group.models.length === 0 ? (
              <Link to="/credentials" className="text-primary underline underline-offset-4">
                去发现或补录模型
              </Link>
            ) : null}
          </div>
        ) : null}
        {models.map((model) => {
          const picked = value.includes(model.identity);
          const cost = model.runtime.cost;
          return (
            <div
              key={model.identity}
              className={cn(
                "flex min-w-0 items-center gap-2 border-b border-border px-3 py-2",
                model.available ? "hover:bg-muted" : "bg-destructive/5",
              )}
            >
              <button
                type="button"
                aria-pressed={picked}
                disabled={!model.available}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed"
                onClick={() => onToggle(model.identity)}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">
                    {model.discovery.name ?? model.id}
                    {picked ? <span className="ml-2 text-primary">已选</span> : null}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{model.id}</span>
                  <span className="flex flex-wrap gap-1">
                    {model.sources.map((source) => (
                      <Badge key={source} variant="outline">{SOURCE_LABEL[source]}</Badge>
                    ))}
                  </span>
                  {model.available ? null : (
                    <span className="text-xs text-destructive">
                      {model.unavailableReasonText ?? "模型来源消失"}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-right text-xs text-muted-foreground">
                  <span>{NUMBER_FORMAT.format(model.runtime.contextWindow)} 上下文</span>
                  <br />
                  {cost === null ? (
                    <span className="text-warning">{COST_UNKNOWN_NOTE}</span>
                  ) : (
                    `$${cost.input}/M 入 · $${cost.output}/M 出`
                  )}
                </span>
              </button>
              {model.available ? null : (
                <Link
                  to={model.unavailableAction ?? "/credentials"}
                  className="shrink-0 text-xs text-primary underline underline-offset-4"
                >
                  处理
                </Link>
              )}
            </div>
          );
        })}
        {hidden > 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            这项服务还有 <span className="font-mono tabular-nums">{hidden}</span> 个没列出，在上面的搜索框里缩小范围。
          </p>
        ) : null}
      </div>
    </div>
  );
}
