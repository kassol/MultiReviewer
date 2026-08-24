/**
 * 审查策略页。模型组合与批次上限读取同一设置快照，但各自保存：失效模型只门禁组合写入，
 * 不连坐批次上限。组合候选与仓库覆盖共用 `ModelComposer` 的模型服务投影。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/theme-button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import { api, errorText, fetchJson } from "./api.ts";
import { modelIdentity, parseModelIdentity } from "./model-services.ts";

type Settings = {
  reviewers: { provider: string; model: string }[];
  reviewersVersion: number;
  maxChangedLinesPerBatch: number;
  maxChangedLinesPerBatchSource: "default" | "custom";
  maxChangedLinesPerBatchVersion: number;
};

class SettingsConflict extends Error {
  readonly latest: Settings;

  constructor(latest: Settings) {
    super("这项审查策略已被其他人修改，已重新加载该项。请确认后再保存。");
    this.latest = latest;
  }
}

export function SettingsPage({ canWrite }: { canWrite: boolean }) {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<Settings>("/settings"),
  });

  return (
    <>
      <PageHeader
        title="审查策略"
        description="模型组合是所有仓库的默认值；批次上限控制每轮审查如何分批。"
      />
      <PageBody width="form">
        {settings.isError ? (
          <div className="rounded-sm bg-destructive/5 px-3 py-3 text-destructive">
            <p role="alert">{(settings.error as Error).message}</p>
            <Button
              className="mt-2"
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "1" }}
              disabled={settings.isFetching}
              onClick={() => void settings.refetch()}
            >
              {settings.isFetching ? "正在重试…" : "重试"}
            </Button>
          </div>
        ) : settings.data === undefined ? (
          <>
            <Skeleton className="h-[136px]" />
            <Skeleton className="h-[460px]" />
            <Skeleton className="h-[142px]" />
          </>
        ) : (
          // 表单以读回来的设置为初值，所以等数据到了再挂载。
          canWrite ? <SettingsForm settings={settings.data} /> : <ReadOnlySettings settings={settings.data} />
        )}
      </PageBody>
    </>
  );
}

function ReadOnlySettings({ settings }: { settings: Settings }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="gap-3 px-4">
        <div>
          <h2 className="text-base font-semibold">模型组合</h2>
          <p className="mt-0.5 text-muted-foreground">所有未设置覆盖的仓库使用这组模型。</p>
        </div>
        <div className="space-y-1.5">
          {settings.reviewers.map((reviewer) => (
            <div key={modelIdentity(reviewer)} className="break-all font-mono text-xs">
              {modelIdentity(reviewer)}
            </div>
          ))}
        </div>
      </Card>
      <Card className="gap-3 px-4">
        <div>
          <h2 className="text-base font-semibold">批次上限</h2>
          <p className="mt-0.5 text-muted-foreground">每批审查最多包含的改动行数。</p>
        </div>
        <p className="font-mono text-lg font-semibold tabular-nums">
          {settings.maxChangedLinesPerBatch}
        </p>
      </Card>
    </div>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const requestedProvider = new URLSearchParams(window.location.search).get("provider") ?? undefined;
  const [models, setModels] = useState(() => settings.reviewers.map(modelIdentity));
  const [reviewersVersion, setReviewersVersion] = useState(settings.reviewersVersion);
  const [limit, setLimit] = useState(String(settings.maxChangedLinesPerBatch));
  const [limitSource, setLimitSource] = useState(settings.maxChangedLinesPerBatchSource);
  const [limitVersion, setLimitVersion] = useState(settings.maxChangedLinesPerBatchVersion);
  const [modelValidity, setModelValidity] = useState<ModelComposerValidity>({
    ready: false,
    unavailable: [],
  });
  const [modelFeedback, setModelFeedback] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);
  const [limitFeedback, setLimitFeedback] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);

  const saveModels = useMutation({
    mutationFn: async (): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          reviewers: models.map(parseModelIdentity),
          expectedVersion: reviewersVersion,
        }),
      });
      if (response.status === 409) throw new SettingsConflict(await fetchJson<Settings>("/settings"));
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Settings;
    },
    onSuccess: (saved) => {
      setReviewersVersion(saved.reviewersVersion);
      setModelFeedback({ text: "模型组合已保存，下一次审查将使用新组合。", isError: false });
      queryClient.setQueryData(["settings"], saved);
    },
    onError: (error: Error) => {
      if (error instanceof SettingsConflict) {
        setModels(error.latest.reviewers.map(modelIdentity));
        setReviewersVersion(error.latest.reviewersVersion);
        queryClient.setQueryData(["settings"], error.latest);
      }
      setModelFeedback({ text: error.message, isError: true });
    },
  });
  const saveLimit = useMutation({
    mutationFn: async (maxChangedLinesPerBatch: number | null): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ maxChangedLinesPerBatch, expectedVersion: limitVersion }),
      });
      if (response.status === 409) throw new SettingsConflict(await fetchJson<Settings>("/settings"));
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Settings;
    },
    onSuccess: (saved) => {
      setLimit(String(saved.maxChangedLinesPerBatch));
      setLimitSource(saved.maxChangedLinesPerBatchSource);
      setLimitVersion(saved.maxChangedLinesPerBatchVersion);
      setLimitFeedback({ text: "批次上限已保存。", isError: false });
      queryClient.setQueryData(["settings"], saved);
    },
    onError: (error: Error) => {
      if (error instanceof SettingsConflict) {
        setLimit(String(error.latest.maxChangedLinesPerBatch));
        setLimitSource(error.latest.maxChangedLinesPerBatchSource);
        setLimitVersion(error.latest.maxChangedLinesPerBatchVersion);
        queryClient.setQueryData(["settings"], error.latest);
      }
      setLimitFeedback({ text: error.message, isError: true });
    },
  });

  const modelSaveBlocked = models.length === 0 || !modelValidity.ready || modelValidity.unavailable.length > 0;
  return (
    <div className="flex flex-col gap-6">
      <section className="space-y-3" aria-label="模型组合保存区">
        <ModelComposer
          value={models}
          provider={requestedProvider}
          onChange={(next) => {
            setModels(next);
            setModelFeedback(null);
          }}
          onValidityChange={setModelValidity}
        />
        <div className="flex flex-wrap items-center gap-3 rounded-sm border bg-muted/50 px-3 py-3">
          <Button
            type="button"
            variant="solid"
            highContrast
            size={{ initial: "4", sm: "2" }}
            disabled={saveModels.isPending || modelSaveBlocked}
            onClick={() => {
              setModelFeedback(null);
              saveModels.mutate();
            }}
          >
            {saveModels.isPending ? "保存中…" : "保存模型组合"}
          </Button>
          {modelValidity.unavailable.length > 0 ? (
            <span className="text-destructive">先恢复或移除不可用模型，再保存组合。</span>
          ) : models.length === 0 ? (
            <span className="text-destructive">至少选择一个可用模型，审查配置才能就绪。</span>
          ) : !modelValidity.ready ? (
            <span className="text-muted-foreground">模型状态确认后即可保存组合。</span>
          ) : modelFeedback === null ? (
            <span className="text-xs text-muted-foreground">仅保存模型组合，不会改动批次上限。</span>
          ) : (
            <span
              role={modelFeedback.isError ? "alert" : "status"}
              className={modelFeedback.isError ? "text-destructive" : "text-success"}
            >
              {modelFeedback.text}
            </span>
          )}
        </div>
      </section>

      <details className="border-t pt-5">
        <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
          批次上限
          <HelpTooltip label="批次上限说明" content="批次上限只影响每轮审查如何拆分改动，不会改变模型组合。" />
        </summary>
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            setLimitFeedback(null);
            const parsed = Number(limit.trim());
            if (limit.trim() === "" || !Number.isInteger(parsed) || parsed <= 0) {
              setLimitFeedback({ text: "批次上限要填正整数，这次没保存。", isError: true });
              return;
            }
            saveLimit.mutate(parsed);
          }}
        >
          <Card className="gap-0 overflow-hidden p-0">
            <div className="space-y-3 px-4 py-4">
              <p className="text-xs text-muted-foreground">
                取值来源：{limitSource === "default" ? "系统默认" : "自定义"}
              </p>
              <div className="flex max-w-sm flex-col gap-1.5">
                <Label htmlFor="max-changed-lines">每批最多改动行数</Label>
                <Input
                  id="max-changed-lines"
                  className="w-40 font-mono"
                  inputMode="numeric"
                  value={limit}
                  aria-invalid={limitFeedback?.isError || undefined}
                  onChange={(event) => {
                    setLimit(event.target.value);
                    setLimitFeedback(null);
                  }}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t bg-muted/50 px-4 py-3">
              <Button type="submit" variant="solid" highContrast size={{ initial: "4", sm: "2" }} disabled={saveLimit.isPending}>
                {saveLimit.isPending ? "保存中…" : "保存批次上限"}
              </Button>
              {limitSource === "custom" ? (
                <Button
                  type="button"
                  variant="outline"
                  color="gray"
                  size={{ initial: "4", sm: "2" }}
                  disabled={saveLimit.isPending}
                  onClick={() => {
                    setLimitFeedback(null);
                    saveLimit.mutate(null);
                  }}
                >
                  恢复系统默认
                </Button>
              ) : null}
              {limitFeedback === null ? (
                <span className="text-xs text-muted-foreground">单独保存，不受模型组合可用性影响。</span>
              ) : (
                <span
                  role={limitFeedback.isError ? "alert" : "status"}
                  className={limitFeedback.isError ? "text-destructive" : "text-success"}
                >
                  {limitFeedback.text}
                </span>
              )}
            </div>
          </Card>
        </form>
      </details>
    </div>
  );
}
