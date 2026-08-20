/**
 * `/credentials` 书签路径上的模型服务检查表(issue #134 / #135)。读取只消费按当前会话裁剪过的
 * `/model-services`；内置候选只留在组件内存，模型字段与凭据审计字段继续按独立权限展示。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, CircleX, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Command, CommandInput, CommandList } from "@/components/ui/command";
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

type CustomDialogTarget = {
  mode: "create" | "update" | "recovery";
  service?: ModelService;
};

type ModelReferenceLocation =
  | { kind: "global" }
  | { kind: "following-global"; repositoryCount: number }
  | { kind: "repository-override"; repoId: number; owner: string; repo: string };

type ModelReference = {
  identity: string;
  locations: ModelReferenceLocation[];
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
    references.push({ identity: entry.identity, locations });
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
    const references =
      body !== null && typeof body === "object" && "references" in body
        ? parseModelReferences(body.references)
        : [];
    throw Object.assign(new Error(message), { references });
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
    service.providerState === "name-conflict"
      ? { label: "已停用", icon: CircleX, className: "bg-destructive/10 text-destructive" }
      : service.credential.state !== "verified"
        ? { label: CREDENTIAL_LABEL[service.credential.state], icon: AlertTriangle, className: "bg-warning/10 text-warning" }
        : service.directory?.state === "refresh-failed"
          ? { label: "刷新失败", icon: AlertTriangle, className: "bg-warning/10 text-warning" }
          : service.directory?.state === "discovery-failed" || service.directory?.state === "undiscovered"
            ? { label: "目录不可用", icon: CircleX, className: "bg-destructive/10 text-destructive" }
            : service.health === "healthy"
              ? { label: "正常", icon: Check, className: "bg-success/10 text-success" }
              : service.health === "disabled"
                ? { label: "已停用", icon: CircleX, className: "bg-destructive/10 text-destructive" }
                : { label: "需注意", icon: AlertTriangle, className: "bg-warning/10 text-warning" };
  const Icon = detail.icon;
  return (
    <Badge variant="secondary" className={cn("border-0", detail.className)}>
      <Icon data-icon="inline-start" />
      {detail.label}
    </Badge>
  );
}

function BuiltinCandidateDialog({
  provider,
  onClose,
}: {
  provider: BuiltinProvider;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState("");
  const credentialRef = useRef("");
  const [preview, setPreview] = useState<BuiltinPreview | null>(null);
  const [validationModel, setValidationModel] = useState("");

  const previewCandidate = useMutation({
    mutationFn: async (submittedCredential: string) =>
      responseJson<BuiltinPreview>(
        await api("/model-services/builtin/preview", {
          method: "POST",
          body: JSON.stringify({
            provider: provider.id,
            credential: submittedCredential,
            expectedVersion: provider.version,
          }),
        }),
      ),
    onSuccess: (result, submittedCredential) => {
      if (credentialRef.current !== submittedCredential) return;
      setPreview(result);
      setValidationModel(result.models[0]?.id ?? "");
    },
    onError: () => {
      setPreview(null);
      setValidationModel("");
    },
  });

  const commitCandidate = useMutation({
    mutationFn: async () =>
      responseJson<CredentialMutationResult>(
        await api("/model-services/builtin/commit", {
          method: "POST",
          body: JSON.stringify({
            provider: provider.id,
            credential,
            validationModel,
            expectedVersion: provider.version,
          }),
        }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      onClose();
    },
  });

  const busy = previewCandidate.isPending || commitCandidate.isPending;
  const error = commitCandidate.error ?? previewCandidate.error;

  const requestPreview = (): void => {
    setPreview(null);
    setValidationModel("");
    commitCandidate.reset();
    previewCandidate.mutate(credential);
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (preview === null) requestPreview();
            else {
              commitCandidate.reset();
              commitCandidate.mutate();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{provider.configured ? "更换内置 provider 凭据" : "配置内置 provider"}</DialogTitle>
            <DialogDescription>
              候选只留在当前页面内存。先用凭据预览模型目录，再选一个 model id；最终提交会重新发现目录并执行一次真实推理。
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border bg-muted px-3 py-2">
            <p className="font-mono font-medium">{provider.id}</p>
            <p className="text-xs text-muted-foreground">{provider.name}</p>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="builtin-provider-credential">模型凭据</Label>
            <Input
              id="builtin-provider-credential"
              type="password"
              autoComplete="off"
              placeholder="这家 provider 使用的 key"
              value={credential}
              required
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                credentialRef.current = next;
                setCredential(next);
                setPreview(null);
                setValidationModel("");
                previewCandidate.reset();
                commitCandidate.reset();
              }}
            />
            <p className="text-xs text-muted-foreground">只写不回显；预览不会创建服务端草稿。</p>
          </div>

          {preview === null ? null : (
            <section className="overflow-hidden rounded-md border" aria-labelledby="builtin-preview-heading">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b bg-muted px-3 py-2">
                <div>
                  <h3 id="builtin-preview-heading" className="font-medium">发现预览</h3>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono tabular-nums">{preview.models.length}</span> 个模型
                    {preview.ignoredModelCount === 0 ? null : (
                      <> · 忽略 <span className="font-mono tabular-nums">{preview.ignoredModelCount}</span> 个无效项</>
                    )}
                  </p>
                </div>
                <Badge variant="outline">未保存</Badge>
              </div>
              <dl className="grid gap-2 border-b px-3 py-2 text-xs sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="font-medium text-muted-foreground">地址</dt>
                  <dd className="break-all font-mono">{preview.target.baseUrl}</dd>
                </div>
                <div>
                  <dt className="font-medium text-muted-foreground">接口协议</dt>
                  <dd className="font-mono">{preview.target.api}</dd>
                </div>
              </dl>
              <div className="flex flex-col gap-1 px-3 py-3">
                <Label htmlFor="builtin-validation-model">验证模型</Label>
                <select
                  id="builtin-validation-model"
                  className="h-8 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                  value={validationModel}
                  required
                  disabled={busy || preview.models.length === 0}
                  onChange={(event) => {
                    setValidationModel(event.target.value);
                    commitCandidate.reset();
                  }}
                >
                  {preview.models.map((model) => (
                    <option key={model.identity} value={model.id}>
                      {model.fields.name === undefined || model.fields.name === model.id
                        ? model.id
                        : `${model.id} — ${model.fields.name}`}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">最终提交会以这里选中的 model id 做最小真实推理。</p>
              </div>
            </section>
          )}

          {error === null ? null : <p role="alert" className="text-destructive">{error.message}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button
              type={preview === null ? "submit" : "button"}
              variant={preview === null ? "default" : "outline"}
              disabled={busy || credential === ""}
              onClick={preview === null ? undefined : requestPreview}
            >
              {previewCandidate.isPending ? "正在发现…" : preview === null ? "预览模型" : "重新预览"}
            </Button>
            {preview === null ? null : (
              <Button
                type="submit"
                disabled={busy || validationModel === ""}
              >
                {commitCandidate.isPending ? "正在重新发现并验证…" : "验证并提交"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProviderSearch({ canWriteCredential }: { canWriteCredential: boolean }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [candidate, setCandidate] = useState<BuiltinProvider | null>(null);
  const [maintenance, setMaintenance] = useState<CredentialTarget | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [input]);

  const providers = useQuery({
    queryKey: ["model-services", "providers", query],
    queryFn: () =>
      fetchJson<{ providers: BuiltinProvider[] }>(
        `/model-services/providers?query=${encodeURIComponent(query)}`,
      ),
    enabled: open,
  });

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline">
            <Search />搜索内置 provider
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(440px,calc(100vw-2rem))] gap-0 p-0">
          <Command shouldFilter={false}>
            <CommandInput
              aria-label="搜索 Pi 内置 provider"
              placeholder="输入 provider 标识"
              value={input}
              onValueChange={setInput}
            />
            <CommandList>
              {providers.isPending ? (
                <div className="space-y-2 p-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : providers.isError ? (
                <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                  <p role="alert" className="text-destructive">
                    内置 provider 读不到：{(providers.error as Error).message}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={providers.isFetching}
                    onClick={() => void providers.refetch()}
                  >
                    {providers.isFetching ? "正在重试…" : "重试"}
                  </Button>
                </div>
              ) : providers.data?.providers.length === 0 ? (
                <p className="px-3 py-6 text-center text-muted-foreground">没有匹配的内置 provider。</p>
              ) : (
                <div className="divide-y p-1" role="list">
                  {providers.data?.providers.map((provider) => (
                    <div
                      key={provider.id}
                      className="flex min-w-0 items-center gap-2 rounded-sm px-2 py-2"
                      role="listitem"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-xs font-medium">{provider.id}</span>
                        <span className="truncate text-xs text-muted-foreground">{provider.name}</span>
                      </span>
                      {provider.conflict ? (
                        <Badge variant="destructive">名字冲突</Badge>
                      ) : provider.configured ? (
                        <Badge variant="secondary">已配置</Badge>
                      ) : (
                        <Badge variant="outline">未配置</Badge>
                      )}
                      {canWriteCredential && !provider.conflict ? (
                        <div className="flex shrink-0 gap-1">
                          {provider.configured && provider.version !== null ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="xs"
                              onClick={() => {
                                const version = provider.version;
                                if (version === null) return;
                                setOpen(false);
                                setCandidate(null);
                                setMaintenance({
                                  provider: provider.id,
                                  version,
                                  validationModel: undefined,
                                  models: undefined,
                                });
                              }}
                            >
                              维护
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => {
                              setOpen(false);
                              setMaintenance(null);
                              setCandidate(provider);
                            }}
                          >
                            {provider.configured ? "换凭据" : "配置"}
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </CommandList>
            {!canWriteCredential ? (
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                缺少模型凭据写权限，只能查看按权限返回的状态。
              </p>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {candidate === null ? null : (
        <BuiltinCandidateDialog
          key={`${candidate.id}:${candidate.version ?? "new"}`}
          provider={candidate}
          onClose={() => setCandidate(null)}
        />
      )}
      {maintenance === null ? null : (
        <CredentialControls
          key={`${maintenance.provider}:${maintenance.version}`}
          target={maintenance}
          dialog
          onClose={() => setMaintenance(null)}
        />
      )}
    </>
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
              接口协议：<span className={service.target.api === null ? undefined : "font-mono"}>{service.target.api ?? "未提供"}</span>
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
  const datalistId = `reverify-models-${target.provider}`;
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
        <Input
          id={inputId}
          list={target.models === undefined ? undefined : datalistId}
          className="font-mono sm:flex-1"
          placeholder="只填 model id，不带 provider 前缀"
          value={validationModel}
          disabled={reverify.isPending}
          onChange={(event) => {
            setValidationModel(event.target.value);
            setFeedback(null);
            reverify.reset();
          }}
        />
        {target.models === undefined ? null : (
          <datalist id={datalistId}>
            {target.models.map((model) => <option key={model.identity} value={model.id} />)}
          </datalist>
        )}
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
      <p className="text-xs text-muted-foreground">最终会重新发现目录，并用这个 model id 做一次最小真实推理。</p>
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
        到全局设置或对应仓库覆盖里移除引用，再回来重试当前操作。
      </p>
      <ul className="mt-3 divide-y rounded-sm border bg-background">
        {references.map((reference) => (
          <li key={reference.identity} className="px-3 py-2">
            <p className="break-all font-mono text-xs font-medium">{reference.identity}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {reference.locations.map((location, index) => (
                <li key={`${reference.identity}:${index}`}>
                  {location.kind === "global" ? (
                    "全局模型组合"
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

function CustomCandidateDialog({
  target,
  onClose,
  onCommitted,
}: {
  target: CustomDialogTarget;
  onClose: () => void;
  onCommitted: (provider: string) => void;
}) {
  const queryClient = useQueryClient();
  const service = target.service;
  const editing = target.mode === "update" && service !== undefined;
  const validationPrefix = service === undefined ? "" : `${service.provider}:`;
  const initialValidationModel =
    service?.credential.validationModel?.startsWith(validationPrefix) === true
      ? service.credential.validationModel.slice(validationPrefix.length)
      : "";
  const initialApi = service?.target?.api;
  const [provider, setProvider] = useState(editing ? service.provider : "");
  const [baseUrl, setBaseUrl] = useState(service?.target?.baseUrl ?? "");
  const [protocol, setProtocol] = useState<CustomProtocol>(
    initialApi === "openai-responses" ? "openai-responses" : "openai-completions",
  );
  const [credential, setCredential] = useState("");
  const [validationModel, setValidationModel] = useState(initialValidationModel);
  const [reconfirmedSupplements, setReconfirmedSupplements] = useState<string[]>([]);
  const [preview, setPreview] = useState<CustomPreview | null>(null);
  const [previewAttempted, setPreviewAttempted] = useState(false);
  const targetChanged =
    editing &&
    (baseUrl.trim() !== (service.target?.baseUrl ?? "") || protocol !== service.target?.api);
  const supplementModels = editing
    ? (service.models ?? []).filter((model) =>
        model.sources.includes("manual") || model.sources.includes("migration-retention"),
      )
    : [];
  const candidate = {
    provider: provider.trim(),
    baseUrl: baseUrl.trim(),
    api: protocol,
    credential,
    validationModel: validationModel.trim(),
    expectedVersion: editing ? service.version : null,
    reconfirmedSupplements,
  };
  const previewCandidate = useMutation({
    mutationFn: async () => responseJson<CustomPreview>(
      await api("/model-services/custom/preview", {
        method: "POST",
        body: JSON.stringify(candidate),
      }),
    ),
    onSuccess: (result) => {
      setPreview(result);
      setPreviewAttempted(true);
    },
    onError: () => {
      setPreview(null);
      setPreviewAttempted(true);
    },
  });
  const commitCandidate = useMutation({
    mutationFn: async () => responseJsonWithReferences<CredentialMutationResult>(
      await api("/model-services/custom/commit", {
        method: "POST",
        body: JSON.stringify(candidate),
      }),
    ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      onCommitted(result.provider);
    },
  });
  const busy = previewCandidate.isPending || commitCandidate.isPending;
  const commitError = commitCandidate.error as ModelServiceMutationError | null;
  const invalidatePreview = (): void => {
    setPreview(null);
    setPreviewAttempted(false);
    previewCandidate.reset();
    commitCandidate.reset();
  };
  const title = editing
    ? `修改 ${service.provider}`
    : target.mode === "recovery"
      ? `用新名称重建 ${service?.provider ?? "自定义服务"}`
      : "创建自定义模型服务";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            commitCandidate.reset();
            commitCandidate.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              候选只留在当前页面内存。预览只发现目录；最终提交会重新发现并执行一次真实推理，全部成功后才原子切换。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="custom-provider">provider</Label>
              <Input
                id="custom-provider"
                className="font-mono"
                value={provider}
                required
                disabled={busy || editing}
                pattern="[a-z0-9-]{1,64}"
                placeholder="例如 corp-gateway"
                onChange={(event) => { setProvider(event.target.value); invalidatePreview(); }}
              />
              <p className="text-xs text-muted-foreground">小写字母、数字与连字符；不能占用当前 Pi 内置名称。</p>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="custom-base-url">Base URL</Label>
              <Input
                id="custom-base-url"
                className="font-mono"
                type="url"
                value={baseUrl}
                required
                disabled={busy}
                placeholder="https://gateway.example/v1"
                onChange={(event) => { setBaseUrl(event.target.value); invalidatePreview(); }}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-protocol">接口协议</Label>
              <select
                id="custom-protocol"
                className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
                value={protocol}
                disabled={busy}
                onChange={(event) => {
                  setProtocol(event.target.value as CustomProtocol);
                  invalidatePreview();
                }}
              >
                <option value="openai-completions">openai-completions</option>
                <option value="openai-responses">openai-responses</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="custom-validation-model">验证模型</Label>
              <Input
                id="custom-validation-model"
                className="font-mono"
                list={preview === null ? undefined : "custom-preview-models"}
                value={validationModel}
                required
                disabled={busy}
                placeholder="只填 model id"
                onChange={(event) => { setValidationModel(event.target.value); invalidatePreview(); }}
              />
              {preview === null ? null : (
                <datalist id="custom-preview-models">
                  {preview.models.map((model) => <option key={model.identity} value={model.id} />)}
                </datalist>
              )}
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="custom-credential">新模型凭据</Label>
              <Input
                id="custom-credential"
                type="password"
                autoComplete="off"
                value={credential}
                required
                disabled={busy}
                placeholder={editing ? "轮换或切换目标都必须重新输入" : "模型服务使用的 key"}
                onChange={(event) => { setCredential(event.target.value); invalidatePreview(); }}
              />
              <p className="text-xs text-muted-foreground">只写不回显；切换地址或协议时绝不会把旧凭据发给新目标。</p>
            </div>
          </div>

          {!targetChanged || supplementModels.length === 0 ? null : (
            <fieldset className="rounded-md border px-3 py-2">
              <legend className="px-1 text-sm font-medium">重新确认带入新目标的模型补录</legend>
              <p className="mb-2 text-xs text-muted-foreground">未勾选的旧目标来源会丢弃；仍被组合引用时服务端会阻止提交并列出位置。</p>
              <div className="space-y-1.5">
                {supplementModels.map((model) => (
                  <label key={model.identity} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={reconfirmedSupplements.includes(model.identity)}
                      disabled={busy}
                      onChange={(event) => {
                        setReconfirmedSupplements((current) => event.target.checked
                          ? [...current, model.identity]
                          : current.filter((identity) => identity !== model.identity));
                        invalidatePreview();
                      }}
                    />
                    <span className="break-all font-mono text-xs">{model.identity}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {preview === null ? null : (
            <div className="rounded-md border bg-muted px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">发现预览</p>
                <Badge variant="outline">未保存</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">{preview.models.length}</span> 个模型 · 地址已规范化为{" "}
                <span className="break-all font-mono">{preview.target.baseUrl}</span>
              </p>
            </div>
          )}
          {previewCandidate.error === null ? null : (
            <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
              <p role="alert" className="text-warning">{previewCandidate.error.message}</p>
              <p className="mt-1 text-xs text-muted-foreground">仍可提交；最终真实推理成功时会以验证模型建立服务。</p>
            </div>
          )}
          {commitError === null ? null : (
            <div className="space-y-2">
              <p role="alert" className="text-destructive">{commitError.message}</p>
              <ReferenceBlockers references={commitError.references} />
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button
              type="button"
              variant={previewAttempted ? "outline" : "default"}
              disabled={busy || provider.trim() === "" || baseUrl.trim() === "" || credential === "" || validationModel.trim() === ""}
              onClick={() => {
                setPreview(null);
                setPreviewAttempted(false);
                commitCandidate.reset();
                previewCandidate.mutate();
              }}
            >
              {previewCandidate.isPending ? "正在发现…" : previewAttempted ? "重新预览" : "预览模型"}
            </Button>
            {!previewAttempted ? null : (
              <Button type="submit" disabled={busy || validationModel.trim() === ""}>
                {commitCandidate.isPending ? "正在重新发现并验证…" : editing ? "验证并切换" : "验证并创建"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomServiceControls({
  service,
  onEdit,
  onRecover,
}: {
  service: ModelService;
  onEdit: () => void;
  onRecover: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
  return (
    <section className="rounded-md border px-3 py-3" aria-labelledby={`custom-actions-${service.provider}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id={`custom-actions-${service.provider}`} className="font-medium">自定义服务维护</h3>
          <p className="text-xs text-muted-foreground">候选验证成功前，当前版本与全部来源保持不动。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {service.providerState !== "name-conflict" ? null : (
            <Button type="button" variant="outline" onClick={onRecover}>用新名称重建</Button>
          )}
          {service.providerState === "name-conflict" ? null : (
            <Button type="button" variant="outline" onClick={onEdit}>修改候选</Button>
          )}
          <Button type="button" variant="destructive" onClick={() => setConfirmingDelete(true)}>
            <Trash2 />删除服务
          </Button>
        </div>
      </div>
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

function CatalogControls({ service }: { service: ModelService }) {
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={`catalog-actions-${service.provider}`} className="font-medium">目录与模型补录</h3>
          <p className="text-xs text-muted-foreground">
            刷新只替换自动目录；补录仅记录 model id，并先执行一次真实推理。
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
      </div>

      <form
        className="mt-3 border-t pt-3"
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
      </Dialog>
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

function RuntimeSource({ source }: { source: "trusted" | "runtime-baseline" | "unknown" }) {
  const label = source === "trusted" ? "可信目录" : source === "runtime-baseline" ? "运行基线" : "未知";
  return <span className="text-muted-foreground">（{label}）</span>;
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
      <div className="overflow-x-auto">
        <table className="min-w-[940px] w-full text-left text-sm">
          <thead className="border-b text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">模型标识</th>
              <th className="px-3 py-2 font-medium">来源</th>
              <th className="px-3 py-2 font-medium">发现事实</th>
              <th className="px-3 py-2 font-medium">实际运行</th>
              <th className="px-3 py-2 font-medium">可用性</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((model) => (
              <tr key={model.identity} className={cn(!model.available && "bg-destructive/5")}>
                <td className="max-w-60 px-3 py-3 align-top">
                  <span className="break-all font-mono text-xs">{model.identity}</span>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="flex max-w-44 flex-wrap gap-1">
                    {model.sources.map((source) => (
                      <Badge key={source} variant="outline">{SOURCE_LABEL[source]}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="space-y-1 text-xs">
                    {model.discovery.name === null ? null : <p>{model.discovery.name}</p>}
                    <p>
                      上下文：{model.discovery.contextWindow === null ? (
                        <span className="text-warning">未提供</span>
                      ) : (
                        <span className="font-mono tabular-nums">{quantity(model.discovery.contextWindow)}</span>
                      )}
                    </p>
                    <p>
                      最大输出：{model.discovery.maxOutput === null ? (
                        <span className="text-warning">未提供</span>
                      ) : (
                        <span className="font-mono tabular-nums">{quantity(model.discovery.maxOutput)}</span>
                      )}
                    </p>
                    <p><CostValue cost={model.discovery.cost} /></p>
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  <div className="space-y-1 text-xs">
                    <p>
                      输入：{model.runtime.input.join(" / ")}{" "}
                      <RuntimeSource source={model.runtime.sources.input} />
                    </p>
                    <p>
                      推理：{model.runtime.reasoning ? "声明推理" : "不声明推理"}{" "}
                      <RuntimeSource source={model.runtime.sources.reasoning} />
                    </p>
                    <p>
                      上下文：<span className="font-mono tabular-nums">{quantity(model.runtime.contextWindow)}</span>{" "}
                      <RuntimeSource source={model.runtime.sources.contextWindow} />
                    </p>
                    <p>
                      最大输出：<span className="font-mono tabular-nums">{quantity(model.runtime.maxOutput)}</span>{" "}
                      <RuntimeSource source={model.runtime.sources.maxOutput} />
                    </p>
                    <p>
                      <CostValue cost={model.runtime.cost} />{" "}
                      <RuntimeSource source={model.runtime.sources.cost} />
                    </p>
                  </div>
                </td>
                <td className="px-3 py-3 align-top">
                  {model.available ? (
                    <Badge variant="secondary" className="border-0 bg-success/10 text-success">
                      <Check data-icon="inline-start" />可用
                    </Badge>
                  ) : (
                    <div className="space-y-1">
                      <Badge variant="destructive">
                        <CircleX data-icon="inline-start" />不可用
                      </Badge>
                      <p className="text-xs text-destructive">
                        {model.unavailableReasonText ?? "模型来源消失"}
                      </p>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServiceDetail({
  service,
  canReadModels,
  canWriteModels,
  canReadCredential,
  canWriteCredential,
  canWriteCustom,
  onEditCustom,
  onRecoverCustom,
}: {
  service: ModelService;
  canReadModels: boolean;
  canWriteModels: boolean;
  canReadCredential: boolean;
  canWriteCredential: boolean;
  canWriteCustom: boolean;
  onEditCustom: () => void;
  onRecoverCustom: () => void;
}) {
  return (
    <div className="min-w-0 space-y-5">
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

      {service.providerState === "name-conflict" ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
          <p className="font-medium">与 Pi 内置 provider 同名，模型服务已停用。</p>
          <p className="mt-0.5 text-xs">配置仍被保留；下一步用新名称重建，或删除这项服务。</p>
        </div>
      ) : service.directory?.failure === null || service.directory?.failure === undefined ? null : (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
          <p className="font-medium">{service.directory.failure}</p>
          <p className="mt-0.5 text-xs">
            {service.directory.state === "refresh-failed"
              ? "最近成功目录仍在使用；检查服务后可刷新自动目录。"
              : "当前没有成功的自动目录；先恢复凭据或服务，再刷新目录。"}
          </p>
        </div>
      )}

      <section aria-labelledby={`service-state-${service.provider}`}>
        <div className="mb-2">
          <h3 id={`service-state-${service.provider}`} className="text-base font-semibold">配置路径</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">按模型服务 → 模型凭据 → 模型目录依次检查；三项状态彼此独立。</p>
        </div>
        <StateRows service={service} canReadCredential={canReadCredential} />
        {canWriteCredential && service.credential.state === "unconfigured" ? (
          <p className="mt-2 rounded-sm bg-warning/10 px-3 py-2 text-xs text-warning">
            下一步：从页头搜索 <span className="font-mono">{service.provider}</span> 并配置模型凭据。
          </p>
        ) : null}
      </section>

      {canWriteCredential && service.credential.state !== "unconfigured" ? (
        <CredentialControls
          key={`${service.provider}:${service.version}`}
          target={{
            provider: service.provider,
            version: service.version,
            validationModel: service.credential.validationModel,
            models: service.models,
          }}
        />
      ) : null}

      {!canWriteCustom || service.type !== "custom" ? null : (
        <CustomServiceControls
          key={`${service.provider}:${service.version}`}
          service={service}
          onEdit={onEditCustom}
          onRecover={onRecoverCustom}
        />
      )}

      {canWriteModels ? <CatalogControls key={`${service.provider}:${service.version}`} service={service} /> : null}

      {canReadModels && service.models !== undefined ? (
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
    <div className="grid max-w-[1180px] gap-5 p-5 pb-20 lg:grid-cols-[280px_minmax(0,1fr)]">
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
  canReadModels,
  canWriteModels,
  canReadCredential,
  canWriteCredential,
}: {
  canReadModels: boolean;
  canWriteModels: boolean;
  canReadCredential: boolean;
  canWriteCredential: boolean;
}) {
  const [selectedProvider, setSelectedProvider] = useState("");
  const [customTarget, setCustomTarget] = useState<CustomDialogTarget | null>(null);
  const canWriteCustom = canWriteModels && canWriteCredential;
  const canReadServices = canReadModels || canReadCredential;
  const query = useModelServices(canReadServices);
  const services = query.data?.services ?? [];
  const selected = useMemo(
    () => services.find((service) => service.provider === selectedProvider) ?? services[0],
    [selectedProvider, services],
  );

  return (
    <>
      <PageHeader
        title="模型服务"
        description="模型服务、模型凭据与模型目录三条状态彼此独立；删除被组合引用的项目时会列出阻塞位置与下一步。"
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <ProviderSearch canWriteCredential={canWriteCredential} />
            {canWriteCustom ? (
              <Button type="button" onClick={() => setCustomTarget({ mode: "create" })}>
                新建自定义服务
              </Button>
            ) : null}
          </div>
        )}
      />
      {customTarget === null ? null : (
        <CustomCandidateDialog
          key={`${customTarget.mode}:${customTarget.service?.provider ?? "new"}:${customTarget.service?.version ?? 0}`}
          target={customTarget}
          onClose={() => setCustomTarget(null)}
          onCommitted={(provider) => {
            setSelectedProvider(provider);
            setCustomTarget(null);
          }}
        />
      )}
      {!canReadServices ? (
        <div className="max-w-[760px] p-5">
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
        <div className="max-w-[760px] p-5">
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
        <div className="max-w-[760px] p-5">
          <Card className="gap-2 px-4 py-8">
            <h2 className="text-base font-semibold">还没有模型服务</h2>
            <p className="text-muted-foreground">
              这里只列已配置或保留异常状态的服务。下一步从页头搜索 Pi 内置 provider
              {canWriteCredential ? "并配置凭据" : "查看可见状态"}；有完整写权限时也可新建自定义服务。
            </p>
          </Card>
        </div>
      ) : selected === undefined ? null : (
        <div className="grid max-w-[1180px] gap-5 p-5 pb-20 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="self-start gap-0 overflow-hidden bg-chrome p-0">
            <div className="border-b bg-muted px-3 py-2.5">
              <h2 className="font-medium">已配置服务</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">{services.length}</span> 项 · 含保留的异常状态
              </p>
            </div>
            <div className="max-h-80 divide-y overflow-y-auto lg:max-h-none">
              {services.map((service) => (
                <button
                  key={service.provider}
                  type="button"
                  aria-pressed={service.provider === selected.provider}
                  aria-current={service.provider === selected.provider ? "true" : undefined}
                  className={cn(
                    "w-full px-3 py-3 text-left transition-colors hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    service.provider === selected.provider && "bg-background",
                  )}
                  onClick={() => setSelectedProvider(service.provider)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{service.name}</span>
                    <ServiceStatus service={service} />
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{service.provider}</p>
                  {service.models === undefined || service.directory === undefined ? (
                    <p className="mt-1 text-xs text-muted-foreground">模型数量与发现时间按权限隐藏</p>
                  ) : (
                    <div className="mt-1 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span><span className="font-mono tabular-nums">{service.models.length}</span> 个模型</span>
                      <span>
                        最近成功{" "}
                        <span className={service.directory.lastSuccessAt === null ? undefined : "font-mono tabular-nums"}>{localMinute(service.directory.lastSuccessAt)}</span>
                      </span>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </Card>
          <ServiceDetail
            service={selected}
            canReadModels={canReadModels}
            canWriteModels={canWriteModels}
            canReadCredential={canReadCredential}
            canWriteCredential={canWriteCredential}
            canWriteCustom={canWriteCustom && canReadModels}
            onEditCustom={() => setCustomTarget({ mode: "update", service: selected })}
            onRecoverCustom={() => setCustomTarget({ mode: "recovery", service: selected })}
          />
        </div>
      )}
    </>
  );
}
