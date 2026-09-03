/**
 * 审查策略页。模型组合与三项分批上限读取同一设置快照，但各自保存：失效模型只门禁组合写入，
 * 不连坐分批上限。组合候选与仓库覆盖共用 `ModelComposer` 的模型服务投影。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircledIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Card, Skeleton, Text, TextField } from "@radix-ui/themes";
import { useState } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import {
  fromModelRef,
  modelIdentity,
  toModelRef,
  type ThinkingLevel,
} from "./model-services.ts";

type Settings = {
  reviewers: { provider: string; model: string; thinkingLevel?: ThinkingLevel }[];
  reviewersVersion: number;
  maxChangedLinesPerBatch: number;
  maxChangedLinesPerBatchSource: "default" | "custom";
  maxChangedLinesPerBatchVersion: number;
  maxParallelBatches: number;
  maxParallelBatchesSource: "default" | "custom";
  maxParallelBatchesVersion: number;
  maxFilesPerBatch: number;
  maxFilesPerBatchSource: "default" | "custom";
  maxFilesPerBatchVersion: number;
};

/** 三项分批上限同形：各自一个正整数、各自一份来源与版本，各自保存。 */
type LimitField = "maxChangedLinesPerBatch" | "maxParallelBatches" | "maxFilesPerBatch";

const LIMITS: {
  field: LimitField;
  title: string;
  help: string;
  label: string;
  inputId: string;
}[] = [
  {
    field: "maxChangedLinesPerBatch",
    title: "批次改动行上限",
    help: "批次改动行上限只影响每轮审查如何拆分改动，不会改变模型组合。",
    label: "每批最多改动行数",
    inputId: "max-changed-lines",
  },
  {
    field: "maxParallelBatches",
    title: "批次并发数",
    help: "一轮审查里同时开跑的批次数。调大缩短大改动的等待时间，也同时占用更多模型配额。",
    label: "同时在跑的批次数",
    inputId: "max-parallel-batches",
  },
  {
    field: "maxFilesPerBatch",
    title: "批次文件数上限",
    help: "一批最多包含多少个文件。文件数与改动行数任一超限即另起一批。",
    label: "每批最多文件数",
    inputId: "max-files-per-batch",
  },
];

class SettingsConflict extends Error {
  readonly latest: Settings;

  constructor(latest: Settings) {
    super("当前审查策略已被其他用户修改。系统已重新加载最新版本，请确认后再次保存。");
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
      <PageBody width="form">
        <PageHeader title="审查策略" />
        {settings.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{(settings.error as Error).message}</Callout.Text>
            <Button
              className="w-fit"
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "1" }}
              disabled={settings.isFetching}
              onClick={() => void settings.refetch()}
            >
              {settings.isFetching ? "正在重试…" : "重试"}
            </Button>
          </Callout.Root>
        ) : settings.data === undefined ? (
          <div className="flex flex-col gap-5" role="status" aria-label="正在读取审查策略" aria-busy="true">
            <Skeleton aria-hidden className="h-[136px]" />
            <Skeleton aria-hidden className="h-[380px]" />
            <Skeleton aria-hidden className="h-[142px]" />
          </div>
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
      <Card size="2" className="flex flex-col gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.015em]">模型组合</h2>
          <p className="mt-0.5 text-text-muted">所有未设置覆盖的仓库使用这组模型。</p>
        </div>
        <div className="space-y-1.5">
          {settings.reviewers.map((reviewer) => (
            <div key={modelIdentity(reviewer)} className="break-all font-mono text-xs">
              {modelIdentity(reviewer)}
            </div>
          ))}
        </div>
      </Card>
      <Card size="2" className="flex flex-col gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.015em]">批次上限</h2>
          <p className="mt-0.5 text-text-muted">每轮审查如何拆分改动、同时跑几批。</p>
        </div>
        <div className="space-y-2">
          {LIMITS.map((limit) => (
            <div key={limit.field} className="flex items-baseline justify-between gap-3">
              <span className="text-text-muted">{limit.label}</span>
              <span className="font-mono text-lg font-semibold tabular-nums">
                {settings[limit.field]}
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const requestedProvider = new URLSearchParams(window.location.search).get("provider") ?? undefined;
  const [models, setModels] = useState(() => settings.reviewers.map(toModelRef));
  const [reviewersVersion, setReviewersVersion] = useState(settings.reviewersVersion);
  const [modelValidity, setModelValidity] = useState<ModelComposerValidity>({
    ready: false,
    unavailable: [],
  });
  const [modelFeedback, setModelFeedback] = useState<{
    text: string;
    isError: boolean;
  } | null>(null);

  const saveModels = useMutation({
    mutationFn: async (): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          reviewers: models.map(fromModelRef),
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
        setModels(error.latest.reviewers.map(toModelRef));
        setReviewersVersion(error.latest.reviewersVersion);
        queryClient.setQueryData(["settings"], error.latest);
      }
      setModelFeedback({ text: error.message, isError: true });
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
        {/* 保存条(§7.16 操作脚同款次级面):ModelComposer 自成一张卡,这里是页面自己的动作条,不共用卡片边界。 */}
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-card-line bg-sunken px-5 py-3">
          <Button
            type="button"
            variant="solid"
            size={{ initial: "4", sm: "2" }}
            className="shadow-accent"
            disabled={saveModels.isPending || modelSaveBlocked}
            onClick={() => {
              setModelFeedback(null);
              saveModels.mutate();
            }}
          >
            {saveModels.isPending ? "保存中…" : "保存模型组合"}
          </Button>
          {modelValidity.unavailable.length > 0 ? (
            <span className="text-danger">先恢复或移除不可用模型，再保存组合。</span>
          ) : models.length === 0 ? (
            <span className="text-danger">至少选择一个可用模型，审查配置才能就绪。</span>
          ) : !modelValidity.ready ? (
            <span className="text-text-muted">模型状态确认后即可保存组合。</span>
          ) : null}
        </div>
        {modelFeedback === null ? null : (
          <Callout.Root
            role={modelFeedback.isError ? "alert" : "status"}
            color={modelFeedback.isError ? "red" : "green"}
            size="1"
          >
            <Callout.Icon>
              {modelFeedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{modelFeedback.text}</Callout.Text>
          </Callout.Root>
        )}
      </section>

      {LIMITS.map((limit) => (
        <LimitSection key={limit.field} settings={settings} limit={limit} />
      ))}
    </div>
  );
}

/** 一项分批上限的编辑区。三项同形，各持自己的版本、来源与反馈，各自保存。 */
function LimitSection({
  settings,
  limit: { field, title, help, label, inputId },
}: {
  settings: Settings;
  limit: (typeof LIMITS)[number];
}) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(String(settings[field]));
  const [source, setSource] = useState(settings[`${field}Source`]);
  const [version, setVersion] = useState(settings[`${field}Version`]);
  const [feedback, setFeedback] = useState<{
    text: string;
    isError: boolean;
    isField: boolean;
  } | null>(null);

  const save = useMutation({
    mutationFn: async (next: number | null): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({ [field]: next, expectedVersion: version }),
      });
      if (response.status === 409) throw new SettingsConflict(await fetchJson<Settings>("/settings"));
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Settings;
    },
    onSuccess: (saved) => {
      setValue(String(saved[field]));
      setSource(saved[`${field}Source`]);
      setVersion(saved[`${field}Version`]);
      setFeedback({ text: `${title}已保存。`, isError: false, isField: false });
      queryClient.setQueryData(["settings"], saved);
    },
    onError: (error: Error) => {
      if (error instanceof SettingsConflict) {
        setValue(String(error.latest[field]));
        setSource(error.latest[`${field}Source`]);
        setVersion(error.latest[`${field}Version`]);
        queryClient.setQueryData(["settings"], error.latest);
      }
      setFeedback({ text: error.message, isError: true, isField: false });
    },
  });

  return (
    <section className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
      <div className="flex items-center gap-1.5 px-5 py-3.5">
        <h2 className="text-2xl font-bold tracking-[-0.015em]">{title}</h2>
        <HelpTooltip label={`${title}说明`} content={help} />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setFeedback(null);
          const parsed = Number(value.trim());
          if (value.trim() === "" || !Number.isInteger(parsed) || parsed <= 0) {
            setFeedback({
              text: `请输入正整数。${title}未保存。`,
              isError: true,
              isField: true,
            });
            return;
          }
          save.mutate(parsed);
        }}
      >
        <div className="space-y-3 border-t border-card-line px-5 py-4">
          <p className="text-xs text-text-muted">
            取值来源：{source === "default" ? "系统默认" : "自定义"}
          </p>
          <div className="flex max-w-sm flex-col gap-1.5">
            <Text as="label" htmlFor={inputId} size="2" weight="medium">{label}</Text>
            <TextField.Root
              id={inputId}
              size={{ initial: "3", sm: "2" }}
              color={feedback?.isField ? "red" : "gray"}
              className="min-w-0 w-40 font-mono max-sm:min-h-11"
              inputMode="numeric"
              value={value}
              aria-invalid={feedback?.isField || undefined}
              aria-describedby={feedback?.isField ? `${inputId}-error` : undefined}
              onChange={(event) => {
                setValue(event.target.value);
                setFeedback(null);
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-card-line bg-sunken px-5 py-3">
          <Button
            type="submit"
            variant="solid"
            size={{ initial: "4", sm: "2" }}
            className="shadow-accent"
            disabled={save.isPending}
          >
            {save.isPending ? "保存中…" : `保存${title}`}
          </Button>
          {source === "custom" ? (
            <Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "2" }}
              disabled={save.isPending}
              onClick={() => {
                setFeedback(null);
                save.mutate(null);
              }}
            >
              恢复系统默认
            </Button>
          ) : null}
          {feedback === null ? (
            <span className="text-xs text-text-muted">单独保存，不受模型组合可用性影响。</span>
          ) : feedback.isField ? (
            <span id={`${inputId}-error`} role="alert" className="text-danger">
              {feedback.text}
            </span>
          ) : null}
        </div>
        {feedback === null || feedback.isField ? null : (
          <Callout.Root
            role={feedback.isError ? "alert" : "status"}
            color={feedback.isError ? "red" : "green"}
            size="1"
            className="m-4 mt-0"
          >
            <Callout.Icon>
              {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
            </Callout.Icon>
            <Callout.Text>{feedback.text}</Callout.Text>
          </Callout.Root>
        )}
      </form>
    </section>
  );
}
