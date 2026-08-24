/**
 * `/credentials` 书签路径上的模型服务检查表(issue #134 / #135)。读取只消费按当前会话裁剪过的
 * `/model-services`；内置候选只留在组件内存，模型字段与凭据审计字段继续按独立权限展示。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useBlocker, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronDown, CircleX, RefreshCw, Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api, errorText, fetchJson } from "./api.ts";
import {
  SOURCE_LABEL,
  useModelServices,
  type ModelCost,
  type ModelCredentialState,
  type ModelDirectoryState,
  type ModelReference,
  type ModelReferenceLocation,
  type ModelRuntimeFieldSource,
  type ModelService,
  type ModelServiceHealth,
  type ModelServiceModel,
} from "./model-services.ts";


type BuiltinProvider = {
  id: string;
  name: string;
  configured: boolean;
  conflict: boolean;
  version: number | null;
};

type BuiltinPreview = {
  provider: string;
  expectedVersion: number | null;
  target: { baseUrl: string; api: string };
  models: {
    identity: string;
    provider: string;
    id: string;
    fields: { name?: string };
  }[];
  ignoredModelCount: number;
};

type CredentialMutationResult = {
  provider: string;
  version: number;
  credential: { state: "verified" };
  directory: { state: ModelDirectoryState };
};

type CredentialTarget = {
  provider: string;
  version: number;
  validationModel: string | null | undefined;
  models: readonly ModelServiceModel[] | undefined;
};

type CustomProtocol = "openai-completions" | "openai-responses";
const CUSTOM_PROTOCOL_LABEL: Record<CustomProtocol, string> = {
  "openai-completions": "Chat Completions (/chat/completions)",
  "openai-responses": "Responses (/responses)",
};
type CustomPreview = {
  provider: string;
  expectedVersion: number | null;
  target: { baseUrl: string; api: CustomProtocol };
  models: BuiltinPreview["models"];
  ignoredModelCount: number;
  current: null | {
    version: number;
    target: { baseUrl: string | null; api: string | null };
    targetChanged: boolean;
  };
};

type ModelServiceMutationError = Error & { references: ModelReference[] };
type DeleteCredentialError = ModelServiceMutationError;

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as T;
}

function parseModelReferences(value: unknown): ModelReference[] {
  if (!Array.isArray(value)) return [];
  const references: ModelReference[] = [];
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !("identity" in entry) ||
      typeof entry.identity !== "string" ||
      !("provider" in entry) ||
      typeof entry.provider !== "string" ||
      !("model" in entry) ||
      typeof entry.model !== "string" ||
      !("locations" in entry) ||
      !Array.isArray(entry.locations)
    ) continue;
    const locations: ModelReferenceLocation[] = [];
    for (const location of entry.locations) {
      if (location === null || typeof location !== "object" || !("kind" in location)) continue;
      if (location.kind === "global") locations.push({ kind: "global" });
      else if (
        location.kind === "following-global" &&
        "repositoryCount" in location &&
        typeof location.repositoryCount === "number"
      ) locations.push({ kind: "following-global", repositoryCount: location.repositoryCount });
      else if (
        location.kind === "repository-override" &&
        "repoId" in location && typeof location.repoId === "number" &&
        "owner" in location && typeof location.owner === "string" &&
        "repo" in location && typeof location.repo === "string"
      ) {
        locations.push({
          kind: "repository-override",
          repoId: location.repoId,
          owner: location.owner,
          repo: location.repo,
        });
      }
    }
    references.push({
      identity: entry.identity,
      provider: entry.provider,
      model: entry.model,
      locations,
    });
  }
  return references;
}

async function responseJsonWithReferences<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body !== null && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `请求失败(${response.status})`;
    const requestId =
      body !== null && typeof body === "object" && "requestId" in body && typeof body.requestId === "string"
        ? body.requestId
        : undefined;
    const references =
      body !== null && typeof body === "object" && "references" in body
        ? parseModelReferences(body.references)
        : [];
    throw Object.assign(
      new Error(requestId === undefined ? message : `${message}（request id：${requestId}）`),
      { references },
    );
  }
  return body as T;
}

const HEALTH_LABEL: Record<ModelServiceHealth, string> = {
  healthy: "正常",
  attention: "需注意",
  disabled: "已停用",
};
const CREDENTIAL_LABEL: Record<ModelCredentialState, string> = {
  unconfigured: "未配置",
  "pending-reverification": "待重新验证",
  verified: "已验证",
};
const DIRECTORY_LABEL: Record<ModelDirectoryState, string> = {
  undiscovered: "未发现",
  available: "可用",
  "refresh-failed": "可用，刷新失败",
  "discovery-failed": "发现失败",
};
const VERIFICATION_LABEL: Record<NonNullable<ModelService["credential"]["verificationSource"]>, string> = {
  "legacy-provider-check": "旧版 provider 检查",
  "legacy-review-run": "旧版 Review Run",
  inference: "真实推理",
};

function localMinute(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "未提供";
  const date = new Date(iso);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function quantity(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function ServiceStatus({ service }: { service: ModelService }) {
  const detail =
    service.runCapability.runnable
      ? { label: "可以运行", icon: Check, className: "bg-success/10 text-success" }
      : service.providerState === "name-conflict"
      ? { label: "已停用", icon: CircleX, className: "bg-destructive/10 text-destructive" }
      : { label: "暂时不能运行", icon: CircleX, className: "bg-destructive/10 text-destructive" };
  const Icon = detail.icon;
  return (
    <Badge variant="secondary" className={cn("border-0", detail.className)}>
      <Icon data-icon="inline-start" />
      {detail.label}
    </Badge>
  );
}

type BuiltinSetupCandidate = {
  kind: "builtin";
  provider: string;
  name: string;
  version: number | null;
  credential: string;
  preview: BuiltinPreview | null;
  validationModel: string;
};

type CustomSetupCandidate = {
  kind: "custom";
  provider: string;
  baseUrl: string;
  api: CustomProtocol;
  version: number | null;
  credential: string;
  preview: CustomPreview | null;
  discoveryError: string | null;
  validationModel: string;
  reconfirmedSupplements: string[];
};

type ModelServiceSetupCandidate = BuiltinSetupCandidate | CustomSetupCandidate;

type SetupPhase = "discovering" | "committing" | null;
type ModelServiceSetupContextValue = {
  candidate: ModelServiceSetupCandidate | null;
  setCandidate: React.Dispatch<React.SetStateAction<ModelServiceSetupCandidate | null>>;
  phase: SetupPhase;
  setPhase: React.Dispatch<React.SetStateAction<SetupPhase>>;
  transition: (navigate: () => Promise<unknown>) => void;
  finish: () => void;
};

const ModelServiceSetupContext = createContext<ModelServiceSetupContextValue | null>(null);

function useModelServiceSetup(): ModelServiceSetupContextValue {
  const value = useContext(ModelServiceSetupContext);
  if (value === null) throw new Error("模型服务配置页缺少流程上下文");
  return value;
}

export function ModelServiceSetupLayout() {
  const [candidate, setCandidate] = useState<ModelServiceSetupCandidate | null>(null);
  const [phase, setPhase] = useState<SetupPhase>(null);
  const allowExit = useRef(false);
  const dirty = candidate !== null && (
    candidate.credential !== "" ||
    candidate.preview !== null ||
    candidate.validationModel !== "" ||
    (candidate.kind === "custom" && (candidate.provider !== "" || candidate.baseUrl !== ""))
  );
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) =>
      !allowExit.current && (
        phase !== null || (dirty && !next.pathname.includes("/credentials/add"))
      ),
    enableBeforeUnload: () => phase !== null || dirty,
    withResolver: true,
  });
  const finish = (): void => {
    allowExit.current = true;
    setCandidate(null);
    setPhase(null);
  };
  const transition = (navigate: () => Promise<unknown>): void => {
    allowExit.current = true;
    setPhase(null);
    void navigate().finally(() => {
      allowExit.current = false;
    });
  };

  return (
    <ModelServiceSetupContext.Provider value={{ candidate, setCandidate, phase, setPhase, transition, finish }}>
      <PageHeader
        title="配置模型服务"
        description="选择来源、发现模型、真实验证三步完成；候选配置只留在当前页面内存。"
      />
      <div className="max-w-[900px] p-4 pb-20 sm:p-5 sm:pb-20">
        <nav className="mb-5 grid grid-cols-3 overflow-hidden rounded-md border text-center text-xs" aria-label="添加模型服务步骤">
          <span className="flex min-h-11 items-center justify-center border-r px-2 py-2 sm:min-h-0 sm:px-3">1. 选择来源</span>
          <span className="flex min-h-11 items-center justify-center border-r px-2 py-2 sm:min-h-0 sm:px-3">2. 模型发现</span>
          <span className="flex min-h-11 items-center justify-center px-2 py-2 sm:min-h-0 sm:px-3">3. 真实验证</span>
        </nav>
        <Outlet />
      </div>
      <Dialog open={blocker.status === "blocked"} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{phase === null ? "丢弃未保存的候选？" : "模型服务操作仍在进行"}</DialogTitle>
            <DialogDescription>
              {phase === null
                ? "离开会丢弃当前页面内存里的凭据、发现结果和验证模型。"
                : "请求结束前会锁定离开与丢弃动作，请等待当前阶段完成。"}
            </DialogDescription>
          </DialogHeader>
          {phase === null ? (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => blocker.reset?.()}>继续配置</Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  allowExit.current = true;
                  setCandidate(null);
                  blocker.proceed?.();
                }}
              >
                丢弃并离开
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </ModelServiceSetupContext.Provider>
  );
}

export function ModelServiceSourcePage({ canWriteCustom }: { canWriteCustom: boolean }) {
  const navigate = useNavigate();
  const { setCandidate } = useModelServiceSetup();
  const [query, setQuery] = useState("");
  const providers = useQuery({
    queryKey: ["model-services", "providers", query.trim()],
    queryFn: () => fetchJson<{ providers: BuiltinProvider[] }>(
      `/model-services/providers?query=${encodeURIComponent(query.trim())}`,
    ),
  });

  return (
    <Card className="gap-4 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold">选择模型服务来源</h2>
        <p className="mt-1 text-muted-foreground">搜索 Pi 内置 provider，或从同一入口添加自定义 provider。</p>
      </div>
      <Input
        aria-label="搜索 Pi 内置 provider"
        placeholder="输入 provider 标识或名称"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {providers.isPending ? (
        <Skeleton className="h-28" />
      ) : providers.isError ? (
        <p role="alert" className="text-destructive">内置 provider 读不到：{(providers.error as Error).message}</p>
      ) : providers.data.providers.length === 0 ? (
        <p className="text-muted-foreground">没有匹配的 Pi 内置 provider。</p>
      ) : (
        <div className="max-h-80 divide-y overflow-y-auto rounded-md border" role="list">
          {providers.data.providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className="flex min-h-11 w-full items-start gap-3 px-3 py-2 text-left hover:bg-muted/60 sm:min-h-0"
              disabled={provider.conflict}
              onClick={() => {
                setCandidate({
                  kind: "builtin",
                  provider: provider.id,
                  name: provider.name,
                  version: provider.version,
                  credential: "",
                  preview: null,
                  validationModel: "",
                });
                void navigate({
                  to: "/credentials/add/builtin/$provider/discover",
                  params: { provider: provider.id },
                });
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block break-all font-mono text-xs font-medium">{provider.id}</span>
                <span className="block break-words text-xs text-muted-foreground">{provider.name}</span>
              </span>
              {provider.conflict ? <Badge variant="destructive">名字冲突</Badge> : null}
              {provider.configured ? <Badge variant="secondary">已配置</Badge> : <Badge variant="outline">未配置</Badge>}
            </button>
          ))}
        </div>
      )}
      {canWriteCustom ? (
        <div className="border-t pt-4">
          <Button asChild variant="outline" className="max-sm:min-h-11">
            <Link to="/credentials/add/custom/discover">添加自定义 provider</Link>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function useBuiltinProvider(provider: string) {
  return useQuery({
    queryKey: ["model-services", "providers", provider],
    queryFn: async () => {
      const result = await fetchJson<{ providers: BuiltinProvider[] }>(
        `/model-services/providers?query=${encodeURIComponent(provider)}`,
      );
      return result.providers.find((entry) => entry.id === provider);
    },
  });
}

export function BuiltinServiceDiscoverPage({ provider }: { provider: string }) {
  const navigate = useNavigate();
  const metadata = useBuiltinProvider(provider);
  const { candidate, setCandidate, phase, setPhase, transition } = useModelServiceSetup();
  const credential = candidate?.kind === "builtin" && candidate.provider === provider ? candidate.credential : "";
  const preview = useMutation({
    mutationFn: async () => {
      const current = metadata.data;
      if (current === undefined) throw new Error(`Pi 没有内置 provider ${provider}`);
      return responseJson<BuiltinPreview>(await api("/model-services/builtin/preview", {
        method: "POST",
        body: JSON.stringify({ provider, credential, expectedVersion: current.version }),
      }));
    },
    onMutate: () => setPhase("discovering"),
    onSettled: () => setPhase(null),
    onSuccess: (result) => {
      const current = metadata.data!;
      setCandidate({
        kind: "builtin",
        provider,
        name: current.name,
        version: current.version,
        credential,
        preview: result,
        validationModel: result.models[0]?.id ?? "",
      });
      transition(() => navigate({ to: "/credentials/add/builtin/$provider/verify", params: { provider } }));
    },
  });

  return (
    <Card className="gap-4 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold">填写凭据并发现模型</h2>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{provider}</p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => { event.preventDefault(); preview.mutate(); }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="setup-builtin-credential">模型凭据</Label>
          <Input
            id="setup-builtin-credential"
            type="password"
            autoComplete="off"
            value={credential}
            required
            disabled={phase !== null}
            onChange={(event) => {
              const current = metadata.data;
              setCandidate({
                kind: "builtin",
                provider,
                name: current?.name ?? provider,
                version: current?.version ?? null,
                credential: event.target.value,
                preview: null,
                validationModel: "",
              });
              preview.reset();
            }}
          />
          <p className="text-xs text-muted-foreground">只留在当前页面内存；不会写入 URL、浏览器存储或服务端草稿。</p>
        </div>
        {preview.error === null ? null : <p role="alert" className="text-destructive">{preview.error.message}</p>}
        <div className="flex items-center gap-3 border-t pt-3">
          <Button asChild variant="outline">
            <Link to="/credentials/add">返回选择来源</Link>
          </Button>
          <Button type="submit" disabled={phase !== null || credential === "" || metadata.data === undefined}>
            {phase === "discovering" ? "正在发现模型…" : "发现模型"}
          </Button>
          {phase === "discovering" ? <span className="text-xs text-muted-foreground">阶段 2/3：正在请求模型目录</span> : null}
        </div>
      </form>
      {metadata.isError ? (
        <p role="alert" className="text-destructive">provider 状态读不到：{(metadata.error as Error).message}</p>
      ) : metadata.isSuccess && metadata.data === undefined ? (
        <p role="alert" className="text-destructive">Pi 没有内置 provider {provider}。</p>
      ) : null}
    </Card>
  );
}

export function BuiltinServiceVerifyPage({ provider }: { provider: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { candidate, setCandidate, phase, setPhase, finish } = useModelServiceSetup();
  const ready = candidate?.kind === "builtin" && candidate.provider === provider && candidate.preview !== null && candidate.credential !== "";
  const commit = useMutation({
    mutationFn: async () => {
      if (!ready) throw new Error("发现结果已不在当前页面内存，请重新发现模型");
      return responseJson<CredentialMutationResult>(await api("/model-services/builtin/commit", {
        method: "POST",
        body: JSON.stringify({
          provider,
          credential: candidate.credential,
          validationModel: candidate.validationModel,
          expectedVersion: candidate.version,
        }),
      }));
    },
    onMutate: () => setPhase("committing"),
    onSettled: () => setPhase(null),
    onSuccess: () => {
      const created = candidate?.version === null;
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      finish();
      if (created) {
        void navigate({ to: "/settings", search: { provider } });
      } else {
        void navigate({ to: "/credentials/$provider", params: { provider } });
      }
    },
  });

  if (!ready) {
    return (
      <Card className="gap-3 px-4 py-5">
        <h2 className="text-base font-semibold">发现结果不在当前页面内存</h2>
        <p className="text-muted-foreground">刷新和直接打开此地址不会恢复凭据或候选，请回到模型发现重新开始。</p>
        <Link
          to="/credentials/add/builtin/$provider/discover"
          params={{ provider }}
          className="w-fit underline underline-offset-4"
        >
          返回模型发现
        </Link>
      </Card>
    );
  }
  const activeCandidate = candidate!;
  const activePreview = activeCandidate.preview!;

  return (
    <Card className="gap-4 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold">选择验证模型并提交</h2>
        <p className="mt-1 text-muted-foreground">
          预览发现 <span className="font-mono tabular-nums">{activePreview.models.length}</span> 个模型；最终提交会重新发现并执行最小真实推理。
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-validation-model">验证模型</Label>
        <Input
          id="setup-validation-model"
          list="setup-validation-models"
          value={activeCandidate.validationModel}
          disabled={phase !== null}
          onChange={(event) => setCandidate({ ...activeCandidate, validationModel: event.target.value })}
        />
        <datalist id="setup-validation-models">
          {activePreview.models.map((model) => <option key={model.identity} value={model.id} />)}
        </datalist>
        <p className="text-xs text-muted-foreground">目录里没有目标模型时可手填 model id；真实推理成功后会形成模型补录。</p>
      </div>
      {commit.error === null ? null : <p role="alert" className="text-destructive">{commit.error.message}</p>}
      <div className="flex items-center gap-3 border-t pt-3">
        <Button asChild variant="outline">
          <Link to="/credentials/add/builtin/$provider/discover" params={{ provider }}>返回模型发现</Link>
        </Button>
        <Button
          type="button"
          disabled={phase !== null || activeCandidate.validationModel.trim() === ""}
          onClick={() => commit.mutate()}
        >
          {phase === "committing"
            ? "正在重新发现并验证…"
            : activeCandidate.version === null
              ? "验证并创建模型服务"
              : "验证并更新模型服务"}
        </Button>
        {phase === "committing" ? <span className="text-xs text-muted-foreground">阶段 3/3：重新发现目录并执行真实推理</span> : null}
      </div>
    </Card>
  );
}

function customSetupInitial(service: ModelService | undefined): CustomSetupCandidate {
  const validationPrefix = service === undefined ? "" : `${service.provider}:`;
  return {
    kind: "custom",
    provider: service?.provider ?? "",
    baseUrl: service?.target?.baseUrl ?? "",
    api: service?.target?.api === "openai-responses" ? "openai-responses" : "openai-completions",
    version: service?.version ?? null,
    credential: "",
    preview: null,
    discoveryError: null,
    validationModel:
      service?.credential.validationModel?.startsWith(validationPrefix) === true
        ? service.credential.validationModel.slice(validationPrefix.length)
        : "",
    reconfirmedSupplements: [],
  };
}

function useCustomSetupService(provider: string | undefined) {
  const services = useModelServices(provider !== undefined);
  return {
    ...services,
    service: provider === undefined
      ? undefined
      : services.data?.services.find((service) => service.provider === provider && service.type === "custom"),
  };
}

export function CustomServiceDiscoverPage({ provider }: { provider?: string }) {
  const navigate = useNavigate();
  const serviceQuery = useCustomSetupService(provider);
  const { candidate, setCandidate, phase, setPhase, transition } = useModelServiceSetup();
  const service = serviceQuery.service;
  const active = candidate?.kind === "custom" && (
    provider === undefined ? candidate.version === null : candidate.provider === provider
  ) ? candidate : customSetupInitial(service);
  const editing = provider !== undefined;
  const targetChanged = editing && service !== undefined && (
    active.baseUrl.trim() !== (service.target?.baseUrl ?? "") || active.api !== service.target?.api
  );
  const supplementModels = service?.models?.filter((model) =>
    model.sources.includes("manual") || model.sources.includes("migration-retention"),
  ) ?? [];
  const preview = useMutation({
    mutationFn: async () => {
      const response = await api("/model-services/custom/preview", {
        method: "POST",
        body: JSON.stringify({
          provider: active.provider.trim(),
          baseUrl: active.baseUrl.trim(),
          api: active.api,
          credential: active.credential,
          expectedVersion: active.version,
          reconfirmedSupplements: active.reconfirmedSupplements,
        }),
      });
      if (response.ok) {
        return { result: (await response.json()) as CustomPreview, failure: null };
      }
      const failure = await errorText(response);
      if (response.status === 422) return { result: null, failure };
      throw new Error(failure);
    },
    onMutate: () => setPhase("discovering"),
    onSettled: () => setPhase(null),
    onSuccess: ({ result, failure }) => {
      const next = { ...active, preview: result, discoveryError: failure };
      setCandidate(next);
      if (editing) {
        transition(() => navigate({
          to: "/credentials/add/custom/$provider/verify",
          params: { provider: active.provider },
        }));
      } else {
        transition(() => navigate({ to: "/credentials/add/custom/verify" }));
      }
    },
  });
  const update = (change: Partial<CustomSetupCandidate>): void => {
    setCandidate({ ...active, ...change, preview: null, discoveryError: null });
    preview.reset();
  };

  if (editing && serviceQuery.isPending) return <Skeleton className="h-64" />;
  if (editing && service === undefined) {
    return (
      <Card className="gap-3 px-4 py-5">
        <h2 className="text-base font-semibold">自定义模型服务不存在</h2>
        <p className="text-muted-foreground">此稳定地址对应的 provider 已删除或当前不可见。</p>
        <Link to="/credentials" className="w-fit underline underline-offset-4">返回模型服务</Link>
      </Card>
    );
  }

  return (
    <Card className="gap-4 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold">配置调用目标并发现模型</h2>
        <p className="mt-1 text-muted-foreground">发现阶段不需要验证模型；目录失败后仍可手填 model id 进入真实验证。</p>
      </div>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); preview.mutate(); }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="setup-custom-provider">provider</Label>
            <Input
              id="setup-custom-provider"
              className="font-mono"
              value={active.provider}
              required
              disabled={phase !== null || editing}
              maxLength={64}
              onChange={(event) => update({ provider: event.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="setup-custom-base-url">调用目标</Label>
            <Input
              id="setup-custom-base-url"
              className="font-mono"
              type="url"
              value={active.baseUrl}
              required
              disabled={phase !== null}
              placeholder="https://gateway.example/v1"
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-custom-protocol">接口协议</Label>
            <select
              id="setup-custom-protocol"
              className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              value={active.api}
              disabled={phase !== null}
              onChange={(event) => update({ api: event.target.value as CustomProtocol })}
            >
              <option value="openai-completions">{CUSTOM_PROTOCOL_LABEL["openai-completions"]}</option>
              <option value="openai-responses">{CUSTOM_PROTOCOL_LABEL["openai-responses"]}</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="setup-custom-credential">模型凭据</Label>
            <Input
              id="setup-custom-credential"
              type="password"
              autoComplete="off"
              value={active.credential}
              required
              disabled={phase !== null}
              onChange={(event) => update({ credential: event.target.value })}
            />
          </div>
        </div>
        {!targetChanged || supplementModels.length === 0 ? null : (
          <fieldset className="rounded-md border px-3 py-2">
            <legend className="px-1 text-sm font-medium">重新确认带入新目标的模型补录</legend>
            <p className="mb-2 text-xs text-muted-foreground">地址或协议变化后，仅带入这里明确确认的旧来源。</p>
            <div className="space-y-1.5">
              {supplementModels.map((model) => (
                <label key={model.identity} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={active.reconfirmedSupplements.includes(model.identity)}
                    disabled={phase !== null}
                    onChange={(event) => update({
                      reconfirmedSupplements: event.target.checked
                        ? [...active.reconfirmedSupplements, model.identity]
                        : active.reconfirmedSupplements.filter((identity) => identity !== model.identity),
                    })}
                  />
                  <span className="break-all font-mono text-xs">{model.identity}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {preview.error === null ? null : <p role="alert" className="text-destructive">{preview.error.message}</p>}
        <div className="flex items-center gap-3 border-t pt-3">
          <Button asChild variant="outline"><Link to={editing ? "/credentials/$provider/maintenance" : "/credentials"} params={editing ? { provider } : {}}>返回</Link></Button>
          <Button
            type="submit"
            disabled={phase !== null || active.provider.trim() === "" || active.baseUrl.trim() === "" || active.credential === ""}
          >
            {phase === "discovering" ? "正在发现模型…" : "发现模型"}
          </Button>
          {phase === "discovering" ? <span className="text-xs text-muted-foreground">阶段 2/3：正在请求模型目录</span> : null}
        </div>
      </form>
    </Card>
  );
}

export function CustomServiceVerifyPage({ provider }: { provider?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { candidate, setCandidate, phase, setPhase, finish } = useModelServiceSetup();
  const ready = candidate?.kind === "custom" && (
    provider === undefined ? candidate.version === null : candidate.provider === provider
  ) && candidate.credential !== "" && (candidate.preview !== null || candidate.discoveryError !== null);
  const active = ready ? candidate : null;
  const commit = useMutation({
    mutationFn: async () => {
      if (active === null) throw new Error("候选已不在当前页面内存，请重新执行模型发现");
      return responseJsonWithReferences<CredentialMutationResult>(await api("/model-services/custom/commit", {
        method: "POST",
        body: JSON.stringify({
          provider: active.provider,
          baseUrl: active.baseUrl,
          api: active.api,
          credential: active.credential,
          validationModel: active.validationModel.trim(),
          expectedVersion: active.version,
          reconfirmedSupplements: active.reconfirmedSupplements,
        }),
      }));
    },
    onMutate: () => setPhase("committing"),
    onSettled: () => setPhase(null),
    onSuccess: () => {
      const created = active?.version === null;
      const committedProvider = active!.provider;
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      finish();
      if (created) void navigate({ to: "/settings", search: { provider: committedProvider } });
      else void navigate({ to: "/credentials/$provider", params: { provider: committedProvider } });
    },
  });

  if (active === null) {
    const backTo = provider === undefined
      ? "/credentials/add/custom/discover" as const
      : "/credentials/add/custom/$provider/discover" as const;
    return (
      <Card className="gap-3 px-4 py-5">
        <h2 className="text-base font-semibold">发现结果不在当前页面内存</h2>
        <p className="text-muted-foreground">刷新和直接打开此地址不会恢复凭据或候选，请重新执行模型发现。</p>
        <Link to={backTo} params={provider === undefined ? {} : { provider }} className="w-fit underline underline-offset-4">返回模型发现</Link>
      </Card>
    );
  }

  return (
    <Card className="gap-4 px-4 py-4">
      <div>
        <h2 className="text-base font-semibold">选择或手填验证模型</h2>
        <p className="mt-1 text-muted-foreground">
          {active.preview === null
            ? `模型发现未完成：${active.discoveryError}`
            : `模型发现得到 ${active.preview.models.length} 个模型。`}
          最终提交会重新发现并执行最小真实推理。
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="setup-custom-validation-model">验证模型</Label>
        <Input
          id="setup-custom-validation-model"
          className="font-mono"
          list={active.preview === null ? undefined : "setup-custom-validation-models"}
          value={active.validationModel}
          disabled={phase !== null}
          placeholder="只填 model id"
          onChange={(event) => setCandidate({ ...active, validationModel: event.target.value })}
        />
        {active.preview === null ? null : (
          <datalist id="setup-custom-validation-models">
            {active.preview.models.map((model) => <option key={model.identity} value={model.id} />)}
          </datalist>
        )}
        <p className="text-xs text-muted-foreground">目录缺少目标模型时可手填；真实推理成功后会形成模型补录。</p>
      </div>
      {commit.error === null ? null : (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{commit.error.message}</p>
          <ReferenceBlockers references={(commit.error as ModelServiceMutationError).references} />
        </div>
      )}
      <div className="flex items-center gap-3 border-t pt-3">
        <Button asChild variant="outline">
          {provider === undefined
            ? <Link to="/credentials/add/custom/discover">返回模型发现</Link>
            : <Link to="/credentials/add/custom/$provider/discover" params={{ provider }}>返回模型发现</Link>}
        </Button>
        <Button
          type="button"
          disabled={phase !== null || active.validationModel.trim() === ""}
          onClick={() => commit.mutate()}
        >
          {phase === "committing" ? "正在重新发现并验证…" : active.version === null ? "验证并创建" : "验证并更新"}
        </Button>
        {phase === "committing" ? <span className="text-xs text-muted-foreground">阶段 3/3：重新发现目录并执行真实推理</span> : null}
      </div>
    </Card>
  );
}

function StateRows({ service, canReadCredential }: { service: ModelService; canReadCredential: boolean }) {
  const providerLabel =
    service.providerState === "name-conflict"
      ? "名字冲突，已停用"
      : service.providerState === "normal"
        ? "正常"
        : HEALTH_LABEL[service.health];
  return (
    <dl
      className={cn(
        "grid overflow-hidden rounded-md border sm:grid-cols-2",
        service.directory !== undefined && "xl:grid-cols-3",
      )}
      aria-label="模型服务配置状态"
    >
      <div className="border-b bg-background p-4 sm:border-r xl:border-b-0">
        <dt className="text-xs font-medium text-muted-foreground">模型服务</dt>
        <dd
          className={cn(
            "mt-1 font-medium",
            service.providerState === "name-conflict" && "text-destructive",
          )}
        >
          {providerLabel}
        </dd>
        {service.target === undefined ? (
          <p className="mt-2 text-xs text-muted-foreground">地址与接口协议按模型读权限隐藏。</p>
        ) : (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p className="break-all">
              地址：<span className={service.target.baseUrl === null ? undefined : "font-mono"}>{service.target.baseUrl ?? "未提供"}</span>
            </p>
            <p>
              接口协议：{service.type === "custom" && (
                service.target.api === "openai-completions" || service.target.api === "openai-responses"
              ) ? CUSTOM_PROTOCOL_LABEL[service.target.api] : (
                <span className={service.target.api === null ? undefined : "font-mono"}>{service.target.api ?? "未提供"}</span>
              )}
            </p>
          </div>
        )}
      </div>
      <div className={cn(
        "border-b bg-background p-4",
        service.directory === undefined ? "sm:border-b-0" : "xl:border-r xl:border-b-0",
      )}>
        <dt className="text-xs font-medium text-muted-foreground">模型凭据</dt>
        <dd
          className={cn(
            "mt-1 font-medium",
            service.credential.state !== "verified" && "text-warning",
          )}
        >
          {CREDENTIAL_LABEL[service.credential.state]}
        </dd>
        {canReadCredential ? (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p>尾 4 位：<span className={service.credential.last4 === null || service.credential.last4 === undefined ? undefined : "font-mono tabular-nums"}>{service.credential.last4 ?? "未提供"}</span></p>
            <p>更新：<span className={service.credential.updatedAt === null || service.credential.updatedAt === undefined ? undefined : "font-mono tabular-nums"}>{localMinute(service.credential.updatedAt)}</span></p>
            <p>验证：<span className={service.credential.verifiedAt === null || service.credential.verifiedAt === undefined ? undefined : "font-mono tabular-nums"}>{localMinute(service.credential.verifiedAt)}</span></p>
            <p className="break-all">
              验证模型：<span className={service.credential.validationModel === null || service.credential.validationModel === undefined ? undefined : "font-mono"}>{service.credential.validationModel ?? "未提供"}</span>
            </p>
            <p>
              验证来源：
              {service.credential.verificationSource === null || service.credential.verificationSource === undefined
                ? "未提供"
                : VERIFICATION_LABEL[service.credential.verificationSource]}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">尾四位、更新时间与验证记录按权限隐藏。</p>
        )}
      </div>
      {service.directory === undefined ? null : (
        <div className="bg-background p-4 sm:col-span-2 xl:col-span-1">
          <dt className="text-xs font-medium text-muted-foreground">模型目录</dt>
          <dd
            className={cn(
              "mt-1 font-medium",
              service.directory.state === "refresh-failed" && "text-warning",
              (service.directory.state === "undiscovered" || service.directory.state === "discovery-failed") &&
                "text-destructive",
            )}
          >
            {DIRECTORY_LABEL[service.directory.state]}
          </dd>
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            <p>最近尝试：<span className={service.directory.lastAttemptAt === null ? undefined : "font-mono tabular-nums"}>{localMinute(service.directory.lastAttemptAt)}</span></p>
            <p>最近成功：<span className={service.directory.lastSuccessAt === null ? undefined : "font-mono tabular-nums"}>{localMinute(service.directory.lastSuccessAt)}</span></p>
            {service.directory.ignoredModelCount > 0 ? (
              <p>忽略无效项：<span className="font-mono tabular-nums">{service.directory.ignoredModelCount}</span></p>
            ) : null}
          </div>
        </div>
      )}
    </dl>
  );
}

function CredentialControls({
  target,
  dialog = false,
  onClose,
}: {
  target: CredentialTarget;
  dialog?: boolean;
  onClose?: () => void;
}) {
  const queryClient = useQueryClient();
  const validationPrefix = `${target.provider}:`;
  const initialValidationModel = target.validationModel?.startsWith(validationPrefix) === true
    ? target.validationModel.slice(validationPrefix.length)
    : "";
  const [validationModel, setValidationModel] = useState(initialValidationModel);
  const [mutationVersion, setMutationVersion] = useState(target.version);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const expectedVersion = Math.max(target.version, mutationVersion);


  const reverify = useMutation({
    mutationFn: async () =>
      responseJson<CredentialMutationResult>(
        await api(`/model-services/${encodeURIComponent(target.provider)}/reverify`, {
          method: "POST",
          body: JSON.stringify({
            validationModel: validationModel.trim(),
            expectedVersion,
          }),
        }),
      ),
    onSuccess: (result) => {
      setMutationVersion(result.version);
      setFeedback({ text: `${target.provider} 已用已存凭据重新验证。`, error: false });
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
    onError: (error: Error) => setFeedback({ text: error.message, error: true }),
  });

  const removeCredential = useMutation<
    { provider: string; version: number; credential: { state: "unconfigured" } },
    DeleteCredentialError
  >({
    mutationFn: async () => {
      const response = await api(`/model-services/${encodeURIComponent(target.provider)}/credential`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion }),
      });
      const body = (await response.json().catch(() => null)) as {
        provider?: string;
        version?: number;
        credential?: { state?: string };
        error?: string;
        references?: ModelReference[];
      } | null;
      if (!response.ok) {
        throw Object.assign(
          new Error(body?.error ?? `请求失败(${response.status})`),
          { references: Array.isArray(body?.references) ? body.references : [] },
        );
      }
      return body as { provider: string; version: number; credential: { state: "unconfigured" } };
    },
    onSuccess: (result) => {
      setMutationVersion(result.version);
      setConfirmingDelete(false);
      setFeedback({ text: `${target.provider} 的模型凭据已删除。`, error: false });
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      if (dialog) onClose?.();
    },
  });

  const inputId = `reverify-model-${target.provider}`;
  const maintenanceForm = (
    <form
      className={cn("flex flex-col gap-2", !dialog && "px-3 py-3")}
      onSubmit={(event) => {
        event.preventDefault();
        setFeedback(null);
        reverify.mutate();
      }}
    >
      <Label htmlFor={inputId}>重新验证使用的 model id</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex min-w-0 flex-1">
          <Input
            id={inputId}
            className="min-w-0 rounded-r-none font-mono"
            placeholder="只填 model id，不带 provider 前缀"
            value={validationModel}
            disabled={reverify.isPending}
            onChange={(event) => {
              setValidationModel(event.target.value);
              setFeedback(null);
              reverify.reset();
            }}
          />
          <Popover open={modelPickerOpen} onOpenChange={setModelPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                className="-ml-px rounded-l-none px-2.5"
                disabled={reverify.isPending}
                aria-label="从自动发现的模型中选择"
              >
                <ChevronDown />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-[min(32rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] gap-0 p-0"
            >
              <Command>
                <CommandInput placeholder="搜索自动发现的模型" />
                <CommandList>
                  <CommandEmpty>
                    {target.models === undefined
                      ? "模型目录按权限隐藏。仍可手填 model id。"
                      : "没有匹配的模型。仍可手填 model id。"}
                  </CommandEmpty>
                  {(target.models ?? []).map((model) => (
                    <CommandItem
                      key={model.identity}
                      value={model.id}
                      keywords={model.discovery.name === null ? [] : [model.discovery.name]}
                      className="items-start whitespace-normal"
                      onSelect={() => {
                        setValidationModel(model.id);
                        setFeedback(null);
                        reverify.reset();
                        setModelPickerOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          "mt-0.5 shrink-0",
                          validationModel === model.id ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="min-w-0 break-all font-mono">{model.id}</span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <Button type="submit" disabled={reverify.isPending || validationModel.trim() === ""}>
          {reverify.isPending ? "正在验证…" : "重新验证"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={reverify.isPending}
          onClick={() => {
            setFeedback(null);
            removeCredential.reset();
            setConfirmingDelete(true);
          }}
        >
          <Trash2 />删除凭据
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">可从自动发现的模型中选择，也可手填目录外的 model id；最终会重新发现目录，并用它做一次最小真实推理。</p>
      {feedback === null ? null : (
        <p role={feedback.error ? "alert" : "status"} className={feedback.error ? "text-destructive" : "text-success"}>
          {feedback.text}
        </p>
      )}
    </form>
  );

  const deleteError = removeCredential.error;
  const deleteConfirmation = (
    <>
      <DialogHeader>
        <DialogTitle>删除 {target.provider} 的模型凭据？</DialogTitle>
        <DialogDescription>
          模型目录会保留，但没有凭据时模型不能运行。若全局组合或仓库仍在引用这家 provider，服务会拒绝删除并列出位置。
        </DialogDescription>
      </DialogHeader>
      {deleteError === null ? null : (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">{deleteError.message}</p>
          <ReferenceBlockers references={deleteError.references} />
        </div>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={removeCredential.isPending}
          onClick={() => {
            setConfirmingDelete(false);
            removeCredential.reset();
          }}
        >
          取消
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={removeCredential.isPending}
          onClick={() => removeCredential.mutate()}
        >
          {removeCredential.isPending ? "正在删除…" : "确认删除凭据"}
        </Button>
      </DialogFooter>
    </>
  );

  if (dialog) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose?.(); }}>
        <DialogContent>
          {confirmingDelete ? deleteConfirmation : (
            <>
              <DialogHeader>
                <DialogTitle>维护 {target.provider} 的模型凭据</DialogTitle>
                <DialogDescription>重新验证使用已存凭据，凭据与已存验证记录不会回到浏览器。</DialogDescription>
              </DialogHeader>
              {maintenanceForm}
            </>
          )}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <section className="overflow-hidden rounded-md border" aria-labelledby={`credential-actions-${target.provider}`}>
      <div className="border-b bg-muted px-3 py-2">
        <h3 id={`credential-actions-${target.provider}`} className="font-medium">凭据维护</h3>
        <p className="text-xs text-muted-foreground">重新验证使用已存凭据，凭据不会回到浏览器。</p>
      </div>
      {maintenanceForm}
      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          setConfirmingDelete(open);
          if (!open) removeCredential.reset();
        }}
      >
        <DialogContent>{deleteConfirmation}</DialogContent>
      </Dialog>
    </section>
  );
}

function ReferenceBlockers({ references }: { references: ModelReference[] }) {
  if (references.length === 0) return null;
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3">
      <div className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        <p className="font-medium">引用阻塞：先移除下面这些模型引用</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        到审查策略或对应仓库覆盖里移除引用，再回来重试当前操作。
      </p>
      <ul className="mt-3 divide-y rounded-sm border bg-background">
        {references.map((reference) => (
          <li key={reference.identity} className="px-3 py-2">
            <p className="break-all font-mono text-xs font-medium">{reference.identity}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {reference.locations.map((location, index) => (
                <li key={`${reference.identity}:${index}`}>
                  {location.kind === "global" ? (
                    <Link
                      to="/settings"
                      search={{ provider: reference.identity.split(":", 1)[0] }}
                      className="underline underline-offset-4"
                    >
                      去审查策略定位 provider
                    </Link>
                  ) : location.kind === "following-global" ? (
                    <><span className="font-mono tabular-nums">{location.repositoryCount}</span> 个跟随全局的仓库</>
                  ) : (
                    <>仓库覆盖 <span className="font-mono">{location.owner}/{location.repo}</span></>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CustomServiceControls({ service }: { service: ModelService }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newProvider, setNewProvider] = useState("");
  const removeService = useMutation<
    { provider: string; deleted: true },
    ModelServiceMutationError
  >({
    mutationFn: async () => responseJsonWithReferences(
      await api(`/model-services/custom/${encodeURIComponent(service.provider)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: service.version }),
      }),
    ),
    onSuccess: () => {
      setConfirmingDelete(false);
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
  });
  const renameService = useMutation<
    { provider: string; version: number },
    ModelServiceMutationError
  >({
    mutationFn: async () => responseJsonWithReferences(
      await api(`/model-services/custom/${encodeURIComponent(service.provider)}/rename`, {
        method: "POST",
        body: JSON.stringify({
          provider: newProvider.trim(),
          expectedVersion: service.version,
        }),
      }),
    ),
    onSuccess: async (result) => {
      setRenaming(false);
      await queryClient.invalidateQueries({ queryKey: ["model-services"] });
      await navigate({
        to: "/credentials/$provider/maintenance",
        params: { provider: result.provider },
      });
    },
  });
  return (
    <section className="rounded-md border px-3 py-3" aria-labelledby={`custom-actions-${service.provider}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`custom-actions-${service.provider}`} className="font-medium">自定义服务维护</h3>
          <p className="text-xs text-muted-foreground">候选验证成功前，当前版本与全部来源保持不动。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {service.providerState !== "name-conflict" ? null : (
            <Button type="button" variant="outline" onClick={() => setRenaming(true)}>迁移到新名称</Button>
          )}
          {service.providerState === "name-conflict" ? null : (
            <Button asChild variant="outline">
              <Link
                to="/credentials/add/custom/$provider/discover"
                params={{ provider: service.provider }}
              >
                修改候选
              </Link>
            </Button>
          )}
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2 />删除服务
          </Button>
        </div>
      </div>
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          setRenaming(open);
          if (!open) renameService.reset();
        }}
      >
        <DialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              renameService.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>迁移 {service.provider} 到新名称</DialogTitle>
              <DialogDescription>
                服务、全局模型组合与全部仓库覆盖会在一个事务中改名。model id 与历史审查记录保持不变。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor={`rename-provider-${service.provider}`}>新 provider</Label>
              <Input
                id={`rename-provider-${service.provider}`}
                className="font-mono"
                value={newProvider}
                required
                disabled={renameService.isPending}
                onChange={(event) => {
                  setNewProvider(event.target.value);
                  renameService.reset();
                }}
              />
              <p className="text-xs text-muted-foreground">使用 1–64 位小写字母、数字或连字符。</p>
            </div>
            {renameService.error === null ? null : (
              <div className="space-y-2">
                <p role="alert" className="text-destructive">{renameService.error.message}</p>
                <ReferenceBlockers references={renameService.error.references} />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={renameService.isPending} onClick={() => setRenaming(false)}>
                取消
              </Button>
              <Button type="submit" disabled={renameService.isPending || newProvider.trim() === ""}>
                {renameService.isPending ? "正在迁移…" : "确认迁移"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          setConfirmingDelete(open);
          if (!open) removeService.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {service.provider}？</DialogTitle>
            <DialogDescription>
              服务定义、加密凭据、当前目录与模型补录会在一个事务中删除；历史 Review Run 保留。仍被组合引用时不会删除。
            </DialogDescription>
          </DialogHeader>
          {removeService.error === null ? null : (
            <div className="space-y-2">
              <p role="alert" className="text-destructive">{removeService.error.message}</p>
              <ReferenceBlockers references={removeService.error.references} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={removeService.isPending} onClick={() => setConfirmingDelete(false)}>
              取消
            </Button>
            <Button type="button" variant="destructive" disabled={removeService.isPending} onClick={() => removeService.mutate()}>
              {removeService.isPending ? "正在删除…" : "确认删除服务"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function CatalogControls({
  service,
  section,
}: {
  service: ModelService;
  section: "maintenance" | "models";
}) {
  const queryClient = useQueryClient();
  const [model, setModel] = useState("");
  const [deleting, setDeleting] = useState<ModelServiceModel | null>(null);
  const refresh = useMutation<{ version: number }, Error>({
    mutationFn: async () => responseJson(
      await api(`/model-services/${encodeURIComponent(service.provider)}/refresh`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: service.version }),
      }),
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
  });
  const addSupplement = useMutation<{ version: number }, Error, string>({
    mutationFn: async (submittedModel) => responseJson(
      await api(`/model-services/${encodeURIComponent(service.provider)}/supplements`, {
        method: "POST",
        body: JSON.stringify({ model: submittedModel, expectedVersion: service.version }),
      }),
    ),
    onSuccess: () => {
      setModel("");
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
  });
  const removeSupplement = useMutation<
    { version: number },
    ModelServiceMutationError,
    string
  >({
    mutationFn: async (removedModel) => responseJsonWithReferences(
      await api(`/model-services/${encodeURIComponent(service.provider)}/supplements`, {
        method: "DELETE",
        body: JSON.stringify({ model: removedModel, expectedVersion: service.version }),
      }),
    ),
    onSuccess: () => {
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
  });
  const supplementalModels = (service.models ?? []).filter((entry) =>
    entry.sources.includes("manual") || entry.sources.includes("migration-retention"),
  );
  const canValidate =
    service.providerState !== "name-conflict" && service.credential.state === "verified";
  const busy = refresh.isPending || addSupplement.isPending || removeSupplement.isPending;
  const operationError = refresh.error ?? addSupplement.error;
  const inputId = `supplement-model-${service.provider}`;

  return (
    <section className="rounded-md border px-3 py-3" aria-labelledby={`catalog-actions-${service.provider}`}>
      {section === "maintenance" ? <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`catalog-actions-${service.provider}`} className="font-medium">自动目录维护</h3>
          <p className="text-xs text-muted-foreground">
            刷新只替换自动目录；失败时保留最近成功的目录快照。
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy || !canValidate}
          onClick={() => {
            addSupplement.reset();
            refresh.mutate();
          }}
        >
          <RefreshCw className={cn(refresh.isPending && "animate-spin")} />
          {refresh.isPending ? "正在刷新…" : "刷新自动目录"}
        </Button>
        {refresh.error === null ? null : (
          <p role="alert" className="basis-full text-sm text-destructive">{refresh.error.message}</p>
        )}
      </div> : null}

      {section === "models" ? <><form
        className="space-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          const submittedModel = model.trim();
          if (submittedModel === "") return;
          refresh.reset();
          addSupplement.mutate(submittedModel);
        }}
      >
        <Label htmlFor={inputId}>补录 model id</Label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <Input
            id={inputId}
            value={model}
            disabled={busy || !canValidate}
            placeholder="例如 gpt-5.2-codex"
            autoComplete="off"
            onChange={(event) => setModel(event.target.value)}
          />
          <Button type="submit" disabled={busy || !canValidate || model.trim() === ""}>
            {addSupplement.isPending ? "正在验证…" : "验证并补录"}
          </Button>
        </div>
        {!canValidate ? (
          <p className="mt-1.5 text-xs text-warning">请先恢复正常 provider 并验证模型凭据。</p>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">价格、窗口、显示名与能力不能手工填写。</p>
        )}
      </form>

      {operationError === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">{operationError.message}</p>
      )}

      <div className="mt-3 border-t pt-3">
        <p className="text-xs font-medium text-muted-foreground">
          当前补录来源 · {service.models === undefined ? (
            "按模型读权限隐藏"
          ) : (
            <span className="font-mono tabular-nums">{supplementalModels.length}</span>
          )}
        </p>
        {service.models === undefined ? (
          <p className="mt-1.5 text-sm text-muted-foreground">已有来源清单不可见；补录与刷新仍由服务端校验。</p>
        ) : supplementalModels.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted-foreground">没有模型补录或迁移保留来源。</p>
        ) : (
          <ul className="mt-2 divide-y rounded-md border">
            {supplementalModels.map((entry) => {
              const source = entry.sources.includes("manual") ? "manual" : "migration-retention";
              return (
                <li key={entry.identity} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 break-all font-mono text-xs">{entry.identity}</span>
                  <Badge variant="outline">{SOURCE_LABEL[source]}</Badge>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      removeSupplement.reset();
                      setDeleting(entry);
                    }}
                  >
                    删除来源
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDeleting(null);
          removeSupplement.reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {deleting?.identity} 的补录来源？</DialogTitle>
            <DialogDescription>
              {deleting?.sources.includes("automatic")
                ? "自动发现来源仍会保留，这个模型不会从清单消失。"
                : "这是当前唯一来源；仍被模型组合引用时，服务端会阻止删除并列出位置。"}
            </DialogDescription>
          </DialogHeader>
          {removeSupplement.error === null ? null : (
            <div className="space-y-2">
              <p role="alert" className="text-destructive">{removeSupplement.error.message}</p>
              <ReferenceBlockers references={removeSupplement.error.references} />
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={removeSupplement.isPending}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={removeSupplement.isPending || deleting === null}
              onClick={() => {
                if (deleting !== null) removeSupplement.mutate(deleting.id);
              }}
            >
              <Trash2 />{removeSupplement.isPending ? "正在删除…" : "确认删除来源"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog></> : null}
    </section>
  );
}

function CostValue({ cost }: { cost: ModelCost | null }) {
  if (cost === null) return <span className="text-warning">费用未记账</span>;
  return (
    <span>
      输入 <span className="font-mono tabular-nums">${cost.input}/M</span> · 输出{" "}
      <span className="font-mono tabular-nums">${cost.output}/M</span>
    </span>
  );
}

function fieldSourceLabel(source: ModelRuntimeFieldSource | null): string {
  return source === null
    ? "未知"
    : source === "service-interface"
      ? "服务接口"
      : source === "pi-catalog"
        ? "Pi 目录"
        : source === "service-target"
          ? "服务目标"
          : source === "runtime-baseline"
            ? "运行基线"
            : "未知";
}

function sameInput(left: readonly string[] | null, right: readonly string[]): boolean {
  return left !== null && left.length === right.length && left.every((value) => right.includes(value));
}

function sameCost(left: ModelCost | null, right: ModelCost | null): boolean {
  if (left === null || right === null) return left === right;
  if (
    left.input !== right.input ||
    left.output !== right.output ||
    left.cacheRead !== right.cacheRead ||
    left.cacheWrite !== right.cacheWrite
  ) return false;
  const leftTiers = left.tiers ?? [];
  const rightTiers = right.tiers ?? [];
  return leftTiers.length === rightTiers.length && leftTiers.every((tier, index) => {
    const other = rightTiers[index];
    return other !== undefined && tier.inputTokensAbove === other.inputTokensAbove && sameCost(tier, other);
  });
}

function discoveryDiffersFromRuntime(model: ModelServiceModel): boolean {
  return !sameInput(model.discovery.input, model.runtime.input) ||
    model.discovery.reasoning !== model.runtime.reasoning ||
    model.discovery.contextWindow !== model.runtime.contextWindow ||
    model.discovery.maxOutput !== model.runtime.maxOutput ||
    !sameCost(model.discovery.cost, model.runtime.cost);
}

function ModelsTable({ models }: { models: readonly ModelServiceModel[] }) {
  if (models.length === 0) {
    return (
      <section className="rounded-md border px-4 py-8 text-center">
        <h3 className="text-base font-semibold">还没有模型来源</h3>
        <p className="mt-1 text-muted-foreground">模型目录尚未成功发现，也没有模型补录或迁移保留。</p>
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="border-b bg-muted px-3 py-2">
        <h3 className="text-base font-semibold">模型</h3>
        <p className="text-xs text-muted-foreground">
          <span className="font-mono tabular-nums">{models.length}</span> 个合并后的模型标识
        </p>
      </div>
      <div className="divide-y xl:hidden">
        {models.map((model) => (
          <article key={model.identity} className={cn("px-3 py-4", !model.available && "bg-destructive/5")}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{model.discovery.name ?? "未提供显示名"}</p>
                <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{model.identity}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {model.sources.map((source) => (
                    <Badge key={source} variant="outline" className="whitespace-nowrap">
                      {SOURCE_LABEL[source]}
                    </Badge>
                  ))}
                </div>
              </div>
              <ModelAvailability model={model} />
            </div>
            <div className="mt-3 border-t pt-3">
              <ModelRuntimeFacts model={model} />
              <ModelDiscoveryDifference model={model} />
            </div>
          </article>
        ))}
      </div>
      <div className="hidden overflow-x-auto xl:block">
        <table className="w-full min-w-[700px] table-fixed text-left text-sm">
          <colgroup>
            <col className="w-[34%]" />
            <col className="w-[51%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead className="border-b text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">模型</th>
              <th className="px-3 py-2 font-medium">运行规格</th>
              <th className="px-3 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((model) => (
              <tr key={model.identity} className={cn(!model.available && "bg-destructive/5")}>
                <td className="px-3 py-3 align-top">
                  <p className="break-words font-medium">{model.discovery.name ?? "未提供显示名"}</p>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{model.identity}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {model.sources.map((source) => (
                      <Badge key={source} variant="outline" className="whitespace-nowrap">
                        {SOURCE_LABEL[source]}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <ModelRuntimeFacts model={model} />
                  <ModelDiscoveryDifference model={model} />
                </td>
                <td className="px-3 py-3 align-top">
                  <ModelAvailability model={model} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ModelDiscoveryDifference({ model }: { model: ModelServiceModel }) {
  if (!discoveryDiffersFromRuntime(model)) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        发现值与运行规格不同
      </summary>
      <div className="mt-2 space-y-1 border-l pl-3 text-muted-foreground">
        <p className="break-words">
          输入：{model.discovery.input === null ? <span className="text-warning">未提供</span> : model.discovery.input.join(" / ")}
          {" · "}推理：{model.discovery.reasoning === null ? <span className="text-warning">未提供</span> : model.discovery.reasoning ? "声明推理" : "不声明推理"}
        </p>
        <p>
          上下文：{model.discovery.contextWindow === null ? <span className="text-warning">未提供</span> : <span className="font-mono tabular-nums">{quantity(model.discovery.contextWindow)}</span>}
          {" · "}最大输出：{model.discovery.maxOutput === null ? <span className="text-warning">未提供</span> : <span className="font-mono tabular-nums">{quantity(model.discovery.maxOutput)}</span>}
        </p>
        <p><CostValue cost={model.discovery.cost} /></p>
      </div>
    </details>
  );
}

function ModelRuntimeFacts({ model }: { model: ModelServiceModel }) {
  const sources = [...new Set(Object.values(model.runtime.sources).map(fieldSourceLabel))];
  return (
    <div className="space-y-1 text-xs">
      <p className="break-words">
        输入：{model.runtime.input.join(" / ")}{" · "}
        推理：{model.runtime.reasoning ? "声明推理" : "不声明推理"}
      </p>
      <p>
        上下文：<span className="font-mono tabular-nums">{quantity(model.runtime.contextWindow)}</span>{" · "}
        最大输出：<span className="font-mono tabular-nums">{quantity(model.runtime.maxOutput)}</span>
      </p>
      <p className="break-words">
        <CostValue cost={model.runtime.cost} />{" · "}
        <span className="text-muted-foreground">规格来源：{sources.join(" / ")}</span>
      </p>
    </div>
  );
}

function ModelAvailability({ model }: { model: ModelServiceModel }) {
  return model.available ? (
    <Badge variant="secondary" className="shrink-0 whitespace-nowrap border-0 bg-success/10 text-success">
      <Check data-icon="inline-start" />可用
    </Badge>
  ) : (
    <div className="space-y-1">
      <Badge variant="destructive" className="whitespace-nowrap">
        <CircleX data-icon="inline-start" />不可用
      </Badge>
      <p className="max-w-64 break-words text-xs text-destructive">
        {model.unavailableReasonText ?? "模型来源消失"}
      </p>
    </div>
  );
}

export type ModelServiceTab = "overview" | "maintenance" | "models";

function RunCapabilityCard({
  service,
  canWriteModels,
  canWriteCredential,
  canWriteCustom,
}: {
  service: ModelService;
  canWriteModels: boolean;
  canWriteCredential: boolean;
  canWriteCustom: boolean;
}) {
  const capability = service.runCapability;
  const canAct =
    (capability.nextAction === "configure-credential" && canWriteCredential) ||
    (capability.nextAction === "add-model-source" && canWriteModels) ||
    (capability.nextAction === "recover-service" && canWriteCustom);
  const nextStep =
    capability.nextAction === "configure-credential"
      ? service.credential.state === "unconfigured"
        ? "到维护页配置模型凭据。"
        : "到维护页重新验证或轮换模型凭据。"
      : capability.nextAction === "add-model-source"
        ? "到维护页刷新自动目录，或到模型页补录可验证的 model id。"
        : capability.nextAction === "recover-service"
          ? "到维护页用新名称重建，或删除这项服务。"
          : null;
  return (
    <section
      className={cn(
        "rounded-md border px-4 py-4",
        capability.runnable ? "border-success/30 bg-success/5" : "border-destructive/30 bg-destructive/5",
      )}
      aria-labelledby={`run-capability-${service.provider}`}
    >
      <div className="flex items-start gap-2">
        {capability.runnable
          ? <Check className="mt-0.5 size-4 shrink-0 text-success" />
          : <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />}
        <div>
          <h3 id={`run-capability-${service.provider}`} className="font-medium">
            {capability.runnable ? "模型服务可以运行" : "模型服务暂时不能运行"}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {capability.runnable
              ? "至少一个当前模型具备已验证凭据与可运行来源。"
              : capability.reasonText ?? "当前没有可运行模型。"}
          </p>
          {!canAct || nextStep === null ? null : (
            <p className="mt-2 text-xs font-medium">下一步：{nextStep}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ReferenceOverview({ references }: { references: readonly ModelReference[] | undefined }) {
  if (references === undefined) {
    return (
      <section className="rounded-md border bg-muted/50 px-4 py-4">
        <h3 className="font-medium">组合引用按模型读权限隐藏</h3>
        <p className="mt-1 text-xs text-muted-foreground">当前会话只能查看静态服务与凭据状态。</p>
      </section>
    );
  }
  const locationCount = references.reduce(
    (count, reference) => count + reference.locations.reduce(
      (subtotal, location) => subtotal + (location.kind === "following-global" ? location.repositoryCount : 1),
      0,
    ),
    0,
  );
  return (
    <section className="rounded-md border px-4 py-4" aria-labelledby="service-references">
      <h3 id="service-references" className="font-medium">组合引用</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums">{references.length}</span> 个模型标识 ·{" "}
        <span className="font-mono tabular-nums">{locationCount}</span> 个引用位置
      </p>
      {references.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">全局模型组合与仓库覆盖都没有引用这家服务。</p>
      ) : (
        <details className="mt-3 rounded-sm border bg-background px-3 py-2">
          <summary className="cursor-pointer font-medium">展开具体位置</summary>
          <ul className="mt-3 divide-y rounded-sm border">
            {references.map((reference) => (
              <li key={reference.identity} className="px-3 py-2">
                <p className="break-all font-mono text-xs font-medium">{reference.identity}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {reference.locations.map((location, index) => (
                    <li key={`${reference.identity}:${index}`}>
                      {location.kind === "global"
                        ? "全局模型组合"
                        : location.kind === "following-global"
                          ? `${location.repositoryCount} 个跟随全局的仓库`
                          : `仓库覆盖 ${location.owner}/${location.repo}`}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ServiceDetail({
  service,
  tab,
  canReadModels,
  canWriteModels,
  canReadCredential,
  canWriteCredential,
  canWriteCustom,
}: {
  service: ModelService;
  tab: ModelServiceTab;
  canReadModels: boolean;
  canWriteModels: boolean;
  canReadCredential: boolean;
  canWriteCredential: boolean;
  canWriteCustom: boolean;
}) {
  return (
    <div className="min-w-0 space-y-5 max-sm:[&_button]:min-h-11">
      <section className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{service.name}</h2>
            <ServiceStatus service={service} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">{service.provider}</span> · {service.type === "custom" ? "自定义 provider" : "Pi 内置 provider"}
          </p>
        </div>
      </section>

      <nav className="flex gap-1 border-b" aria-label="模型服务详情">
        {(["overview", "maintenance", "models"] as const).map((candidate) => {
          if (candidate === "models" && !canReadModels && !canWriteModels) return null;
          const label = candidate === "overview" ? "概览" : candidate === "maintenance" ? "维护" : "模型";
          const to = candidate === "overview"
            ? "/credentials/$provider"
            : candidate === "maintenance"
              ? "/credentials/$provider/maintenance"
              : "/credentials/$provider/models";
          return (
            <Link
              key={candidate}
              to={to}
              params={{ provider: service.provider }}
              aria-current={tab === candidate ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center border-b-2 border-transparent px-3 py-2 font-medium text-muted-foreground sm:min-h-0",
                tab === candidate && "border-foreground text-foreground",
              )}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {tab === "overview" ? <>
        <RunCapabilityCard
          service={service}
          canWriteModels={canWriteModels}
          canWriteCredential={canWriteCredential}
          canWriteCustom={canWriteCustom}
        />
        {service.directory?.failure === null || service.directory?.failure === undefined ? null : (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
            <p className="font-medium">目录维护提醒</p>
            <p className="mt-0.5 text-xs">{service.directory.failure}</p>
          </div>
        )}
        <StateRows service={service} canReadCredential={canReadCredential} />
        <ReferenceOverview references={service.references} />
      </> : null}

      {tab === "maintenance" && canWriteCredential && service.credential.state !== "unconfigured" ? (
        <CredentialControls
          target={{
            provider: service.provider,
            version: service.version,
            validationModel: service.credential.validationModel,
            models: service.models,
          }}
        />
      ) : null}

      {tab === "maintenance" && canWriteCredential && service.type === "builtin" ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-3">
          <div>
            <h3 className="font-medium">模型凭据轮换</h3>
            <p className="text-xs text-muted-foreground">新凭据发现目录并完成真实推理后，才会推进当前版本。</p>
          </div>
          <Button asChild variant="outline">
            <Link
              to="/credentials/add/builtin/$provider/discover"
              params={{ provider: service.provider }}
            >
              {service.credential.state === "unconfigured" ? "配置凭据" : "换凭据"}
            </Link>
          </Button>
        </section>
      ) : null}

      {tab !== "maintenance" || !canWriteCustom || service.type !== "custom" ? null : (
        <CustomServiceControls service={service} />
      )}

      {tab === "maintenance" && canWriteModels ? (
        <CatalogControls service={service} section="maintenance" />
      ) : null}

      {tab === "maintenance" && !canWriteCredential && !canWriteModels && !canWriteCustom ? (
        <section className="rounded-md border bg-muted/50 px-4 py-5">
          <h3 className="font-medium">维护操作按写权限隐藏</h3>
          <p className="mt-1 text-muted-foreground">当前会话可以查看静态状态与导航，不能修改模型服务。</p>
        </section>
      ) : null}

      {tab === "models" && canWriteModels ? (
        <CatalogControls service={service} section="models" />
      ) : null}

      {tab !== "models" ? null : canReadModels && service.models !== undefined ? (
        <ModelsTable models={service.models} />
      ) : (
        <section className="rounded-md border bg-muted/50 px-4 py-5">
          <h3 className="text-base font-semibold">模型字段按权限隐藏</h3>
          <p className="mt-1 text-muted-foreground">
            当前会话可以审计模型凭据，但不能读取地址、接口协议、模型目录与模型清单。
          </p>
        </section>
      )}
    </div>
  );
}

function LoadingLayout() {
  return (
    <div className="grid max-w-[1180px] gap-5 p-4 pb-20 sm:p-5 sm:pb-20 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Card className="self-start gap-3 p-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
      <div className="space-y-5">
        <Skeleton className="h-12 w-52" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    </div>
  );
}

export function ModelServicesPage({
  provider,
  tab = "overview",
  canReadModels,
  canWriteModels,
  canReadCredential,
  canWriteCredential,
}: {
  provider?: string | undefined;
  tab?: ModelServiceTab | undefined;
  canReadModels: boolean;
  canWriteModels: boolean;
  canReadCredential: boolean;
  canWriteCredential: boolean;
}) {
  const canWriteCustom = canWriteModels && canWriteCredential;
  const canReadServices = canReadModels || canReadCredential;
  const query = useModelServices(canReadServices);
  const services = query.data?.services ?? [];
  const selected = useMemo(
    () => provider === undefined
      ? services[0]
      : services.find((service) => service.provider === provider),
    [provider, services],
  );

  return (
    <>
      <PageHeader
        title="模型服务"
        description="模型服务、模型凭据与模型目录三条状态彼此独立；删除被组合引用的项目时会列出阻塞位置与下一步。"
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {canWriteCredential ? (
              <Button asChild className="max-sm:min-h-11">
                <Link to="/credentials/add">添加模型服务</Link>
              </Button>
            ) : null}
          </div>
        )}
      />
      {!canReadServices ? (
        <div className="max-w-[760px] p-4 sm:p-5">
          <Card className="gap-2 px-4 py-5">
            <h2 className="text-base font-semibold">模型服务字段按权限隐藏</h2>
            <p className="text-muted-foreground">
              {canWriteCredential
                ? "当前会话可写模型凭据，但不能读取现有服务、目录和凭据审计字段。可从页头搜索 Pi 内置 provider 继续配置。"
                : "当前会话没有模型或凭据读取权限。页头搜索只显示按权限裁剪后的内置 provider 信息。"}
            </p>
          </Card>
        </div>
      ) : query.isPending ? (
        <LoadingLayout />
      ) : query.isError ? (
        <div className="max-w-[760px] p-4 sm:p-5">
          <Card className="gap-3 px-4 py-5">
            <div>
              <h2 className="text-base font-semibold text-destructive">模型服务读不到</h2>
              <p className="mt-1 text-muted-foreground">{(query.error as Error).message}</p>
            </div>
            <Button
              className="w-fit"
              type="button"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              {query.isFetching ? "正在重试…" : "重试"}
            </Button>
          </Card>
        </div>
      ) : services.length === 0 ? (
        <div className="max-w-[760px] p-4 sm:p-5">
          <Card className="gap-2 px-4 py-8">
            <h2 className="text-base font-semibold">还没有模型服务</h2>
            <p className="text-muted-foreground">
              这里只列已配置或保留异常状态的服务。
              {canWriteCredential ? "从页头的添加模型服务进入统一配置流程。" : "当前权限只能查看可见状态。"}
            </p>
          </Card>
        </div>
      ) : selected === undefined ? (
        <div className="max-w-[760px] p-4 sm:p-5">
          <Card className="gap-2 px-4 py-5">
            <h2 className="text-base font-semibold">模型服务不存在</h2>
            <p className="text-muted-foreground">这个稳定地址对应的 provider 已删除或当前不可见。</p>
            <Link to="/credentials" className="w-fit text-sm underline underline-offset-4">返回模型服务</Link>
          </Card>
        </div>
      ) : (
        <div className="grid max-w-[1180px] gap-5 p-4 pb-20 sm:p-5 sm:pb-20 xl:grid-cols-[340px_minmax(0,1fr)]">
          <Card className="self-start gap-0 overflow-hidden bg-chrome p-0">
            <div className="border-b bg-muted px-3 py-2.5">
              <h2 className="font-medium">已配置服务</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">{services.length}</span> 项 · 含保留的异常状态
              </p>
            </div>
            <div className="max-h-80 divide-y overflow-y-auto xl:max-h-none">
              {services.map((service) => (
                <Link
                  key={service.provider}
                  to="/credentials/$provider"
                  params={{ provider: service.provider }}
                  aria-current={service.provider === selected.provider ? "page" : undefined}
                  className={cn(
                    "block w-full px-3 py-3 text-left transition-colors hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    service.provider === selected.provider && "bg-background",
                  )}
                >
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <span className={cn("min-w-0 flex-1 break-words font-medium", service.name === service.provider && "font-mono")}>{service.name}</span>
                    <ServiceStatus service={service} />
                  </div>
                  {service.name === service.provider ? null : (
                    <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{service.provider}</p>
                  )}
                  {service.models === undefined || service.directory === undefined ? (
                    <p className="mt-1 text-xs text-muted-foreground">模型数量与发现时间按权限隐藏</p>
                  ) : (
                    <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-end gap-3 text-xs text-muted-foreground">
                      <span>
                        <span className="block text-muted-foreground">模型</span>
                        <span className="font-mono tabular-nums text-foreground">{service.models.length}</span> 个
                      </span>
                      <span className="min-w-0 text-right">
                        <span className="block">最近成功</span>
                        <span className={cn("break-words text-foreground", service.directory.lastSuccessAt === null ? undefined : "font-mono tabular-nums")}>{localMinute(service.directory.lastSuccessAt)}</span>
                      </span>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </Card>
          <ServiceDetail
            service={selected}
            tab={tab}
            canReadModels={canReadModels}
            canWriteModels={canWriteModels}
            canReadCredential={canReadCredential}
            canWriteCredential={canWriteCredential}
            canWriteCustom={canWriteCustom && canReadModels}
          />
        </div>
      )}
    </>
  );
}
