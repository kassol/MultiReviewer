/**
 * 全局模型组合与仓库模型覆盖共用的两栏编辑器。它只消费 `GET /model-services` 的统一候选
 * 投影；模型服务、凭据、自动目录与模型补录都回模型服务页处理，这里不发任何服务写请求。
 */
import { Link } from "@tanstack/react-router";
import { Cross2Icon } from "@radix-ui/react-icons";
import { Badge, Card, Checkbox, Skeleton, TextField } from "@radix-ui/themes";
import { useEffect, useMemo, useState } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import {
  ProviderSelectorItem,
  ProviderSelectorItemText,
} from "@/components/provider-selector-item";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
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
  /** 外部希望优先定位的 provider；省略时优先显示已选模型所属 provider。 */
  provider?: string | undefined;
  /** 调用页只用它门禁本层保存；批次上限等无关写入不得被连坐。 */
  onValidityChange?: (validity: ModelComposerValidity) => void;
};

type ProviderGroup = {
  provider: string;
  name: string;
  service: ModelService | undefined;
  models: ModelServiceModel[];
};

function ProviderAvailabilityStatus({ group }: { group: ProviderGroup }) {
  let tone: StatusTone;
  let label: string;
  if (group.service === undefined) {
    tone = "error";
    label = "模型服务已移除";
  } else if (group.service.providerState === "name-conflict") {
    tone = "error";
    label = "名字冲突，已停用";
  } else if (group.service.credential.state !== "verified") {
    tone = "error";
    label = "模型凭据不可用";
  } else if (group.models.some((model) => model.available)) {
    tone = "success";
    label = "可选择";
  } else {
    tone = "warning";
    label = "没有可用模型";
  }
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}

export function ModelComposer({ value, onChange, provider, onValidityChange }: ModelComposerProps) {
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
  const selectedProvider = pickedProvider ?? provider ?? value[0]?.split(":", 1)[0];
  const selected = groups.find((group) => group.provider === selectedProvider) ?? groups[0];

  const validity = useMemo<ModelComposerValidity>(() => {
    const ready = query.isSuccess && query.data.candidates !== undefined;
    if (!ready) return { ready: false, unavailable: [] };
    const unavailable: UnavailableSelection[] = [];
    for (const identity of value) {
      const candidate = candidateByIdentity.get(identity);
      if (candidate?.available === true) continue;
      unavailable.push({
        identity,
        reason: candidate?.unavailableReasonText ?? "模型不可用",
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
      <Card size="2" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="text-base font-semibold">模型组合</h2>
              <HelpTooltip label="模型组合说明" content="每轮审查会分别调用组合中的模型。模型服务、凭据和模型目录请在模型服务页管理。" />
            </div>
          </div>
          <Link to="/credentials" className="shrink-0 text-xs underline underline-offset-4">
            管理模型服务
          </Link>
        </div>
        {value.length === 0 ? (
          <div className="rounded-sm bg-muted px-3 py-3 text-muted-foreground">
            还没选模型。先从下方选择服务，再加入可用模型。
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2" aria-label="已选模型" role="list">
            {value.map((identity) => {
              const candidate = candidateByIdentity.get(identity);
              const reason =
                candidate?.available === false
                  ? candidate.unavailableReasonText ?? "模型不可用"
                  : candidate === undefined && validity.ready
                    ? "模型不可用"
                    : null;
              return (
                <div
                  role="listitem"
                  key={identity}
                  className={cn(
                    "flex min-w-0 items-start gap-2 rounded-sm border bg-background px-3 py-2",
                    reason === null ? null : "border-destructive/40 bg-destructive/5",
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="break-all font-mono text-xs font-medium">{identity}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      {candidate?.sources.map((source) => (
                        <Badge key={source} color="gray" variant="outline">{SOURCE_LABEL[source]}</Badge>
                      ))}
                      {reason === null ? null : (
                        <span className="text-xs text-destructive">{reason}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label={`移除 ${identity}`}
                    className="-mr-1 flex size-6 shrink-0 touch-manipulation items-center justify-center rounded-sm text-muted-foreground transition-colors max-sm:size-11 hover:bg-muted hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => toggle(identity)}
                  >
                    <Cross2Icon className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {validity.unavailable.length === 0 ? null : (
          <div className="rounded-sm bg-destructive/5 px-3 py-2 text-xs text-destructive">
            不可用模型可以移除，但不能随组合再次保存。服务恢复后会按原标识自动变为可用。{" "}
            <Link to="/credentials" className="font-medium underline underline-offset-4">
              去模型服务处理
            </Link>
          </div>
        )}
      </Card>

      <Card size="1" className="overflow-hidden">
        <div className="-m-3 flex h-[460px] min-w-0 flex-col sm:grid sm:grid-cols-[220px_minmax(0,1fr)]">
          <div className="flex h-40 min-h-0 shrink-0 flex-col border-b border-border bg-chrome sm:h-auto sm:border-r sm:border-b-0">
            <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              模型服务 <span className="font-mono tabular-nums">{groups.length}</span> 项
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {query.isPending ? (
                <div className="p-3"><Skeleton className="h-20" /></div>
              ) : query.isError ? (
                <p className="px-3 py-4 text-xs text-destructive">可选模型暂不可用。</p>
              ) : groups.length === 0 ? (
                <p className="px-3 py-4 text-xs text-muted-foreground">没有可选择的服务。</p>
              ) : (
                groups.map((group) => {
                  const available = group.models.filter((model) => model.available).length;
                  const unavailable = group.models.length - available;
                  return (
                    <ProviderSelectorItem
                      key={group.provider}
                      selected={group.provider === selected?.provider}
                      className="flex flex-col items-start gap-0.5 border-b border-border px-3 py-2 last:border-b-0"
                      onClick={() => setPickedProvider(group.provider)}
                    >
                      <span className="w-full break-all font-mono font-medium">{group.provider}</span>
                      <ProviderSelectorItemText className="text-xs">
                        <span className="font-mono tabular-nums">{available}</span> 个可选
                        {unavailable === 0 ? null : (
                          <ProviderSelectorItemText tone="danger">
                            {" "}· <span className="font-mono tabular-nums">{unavailable}</span> 个不可用
                          </ProviderSelectorItemText>
                        )}
                      </ProviderSelectorItemText>
                    </ProviderSelectorItem>
                  );
                })
              )}
            </div>
            <Link
              to="/credentials"
              className="border-t border-border px-3 py-2 text-xs font-medium hover:bg-background/60"
            >
              配置或修复服务
            </Link>
          </div>

          {selected === undefined ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-4">
              {query.isPending ? (
                <Skeleton className="h-40" />
              ) : query.isError ? (
                <>
                  <p className="font-medium text-destructive">可选模型暂不可用</p>
                  <p className="text-muted-foreground">修复下方读取错误并重试后，才能继续选择或保存。</p>
                </>
              ) : (
                <>
                  <p className="font-medium">暂无可选模型</p>
                  <p className="text-muted-foreground">先配置模型服务、凭据并完成模型发现，再回到这里选择。</p>
                  <Link to="/credentials" className="w-fit underline underline-offset-4">
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
        <div className="flex flex-wrap items-center gap-3 rounded-sm bg-destructive/5 px-3 py-2 text-destructive">
          <p role="alert">模型列表读取失败：{(query.error as Error).message}</p>
          <Button
            type="button"
            variant="outline"
            color="gray"
            size={{ initial: "4", sm: "1" }}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "正在重试…" : "重试"}
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <span className="min-w-0 break-all font-mono font-medium">{group.provider}</span>
        {group.name === group.provider ? null : (
          <span className="min-w-0 break-words text-xs text-muted-foreground">{group.name}</span>
        )}
        <ProviderAvailabilityStatus group={group} />
        <Link
          to="/credentials"
          className="ml-auto shrink-0 text-xs font-medium underline underline-offset-4"
        >
          管理服务
        </Link>
      </div>

      <div className="border-b border-border bg-muted/50 px-3 py-2">
        <TextField.Root
          size={{ initial: "3", sm: "2" }}
          className="min-w-0 w-full max-sm:min-h-11"
          aria-label={`在 ${group.provider} 里搜模型`}
          placeholder={`在 ${group.provider} 里搜模型`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
          {query.trim() === "" ? "当前服务" : "搜索结果"}共{" "}
          <span className="font-mono tabular-nums">{matched.length}</span> 个
          {hidden > 0 ? (
            <>，只列前 <span className="font-mono tabular-nums">{MODELS_SHOWN}</span> 个，请继续缩小范围</>
          ) : null}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {models.length === 0 ? (
          <div className="flex flex-col items-start gap-1.5 px-4 py-6 text-muted-foreground">
            <p className="font-medium text-foreground">
              {group.models.length === 0 ? "这项服务还没有可用模型" : "没有匹配的模型"}
            </p>
            <p>
              {group.models.length === 0
                ? "先去模型服务发现目录或手动添加模型。"
                : "换一个模型名称或 model id 继续搜索。"}
            </p>
            {group.models.length === 0 ? (
              <Link to="/credentials" className="font-medium text-primary underline underline-offset-4">
                去发现或手动添加模型
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
                "flex min-w-0 items-start gap-2 border-b border-border px-3 py-2 transition-colors",
                model.available && picked ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : null,
                model.available && !picked ? "hover:bg-muted/60" : null,
                !model.available ? "bg-destructive/5" : null,
              )}
            >
              <label
                className={cn(
                  "flex min-w-0 flex-1 items-start gap-2",
                  model.available ? "cursor-pointer" : "cursor-not-allowed opacity-70",
                )}
              >
                <Checkbox
                  checked={picked}
                  disabled={!model.available}
                  aria-label={`选择 ${model.identity}`}
                  className="mt-0.5 shrink-0"
                  onCheckedChange={(checked) => {
                    if (typeof checked === "boolean" && checked !== picked) {
                      onToggle(model.identity);
                    }
                  }}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words font-medium">
                      {model.discovery.name ?? model.id}
                    </span>
                    <span className="break-all font-mono text-xs text-muted-foreground">{model.id}</span>
                    <span className="flex flex-wrap gap-1">
                      {model.sources.map((source) => (
                        <Badge key={source} color="gray" variant="outline">{SOURCE_LABEL[source]}</Badge>
                      ))}
                    </span>
                    {model.available ? null : (
                      <span className="text-xs text-destructive">
                        {model.unavailableReasonText ?? "模型不可用"}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-left text-xs text-muted-foreground sm:text-right">
                    <span><span className="font-mono tabular-nums">{NUMBER_FORMAT.format(model.runtime.contextWindow)}</span> 上下文</span>
                    <br />
                    {cost === null ? (
                      <span className="text-warning">{COST_UNKNOWN_NOTE}</span>
                    ) : (
                      <span>
                        <span className="font-mono tabular-nums">${cost.input}/M</span> 入 ·{" "}
                        <span className="font-mono tabular-nums">${cost.output}/M</span> 出
                      </span>
                    )}
                  </span>
                </span>
              </label>
              {model.available ? null : (
                <Link
                  to={model.unavailableAction ?? "/credentials"}
                  className="shrink-0 text-xs font-medium underline underline-offset-4"
                >
                  处理
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
