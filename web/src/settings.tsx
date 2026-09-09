/**
 * 审查策略页。整页一张表单、一颗保存按钮、一个版本号(issue #301):模型、运行上限与报告
 * 等级三段读同一份设置快照,改几项点一次保存,一次写入。上限项与报告等级留空即跟随系统
 * 默认,占位符写着默认值。模型组合与后端之间的两次形状转换走 `model-services.ts` 的
 * `toModelRef` / `fromModelRef`(仓库覆盖那侧同一对函数),思考档位因此只有这一处拆装。
 */
import { useBlocker } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircledIcon, CrossCircledIcon } from "@radix-ui/react-icons";
import { AlertDialog, Callout, Card, Flex, Select, Skeleton, Text, TextField } from "@radix-ui/themes";
import { useState } from "react";

import { AuxiliaryModelPicker } from "@/components/auxiliary-model-picker";
import { HelpTooltip } from "@/components/help-tooltip";
import {
  ModelComposer,
  type ModelComposerValidity,
} from "@/components/model-composer";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/theme-button";

import { api, errorText, fetchJson } from "./api.ts";
import { sameModelRef, sameModelRefs } from "./lib/model-ref.ts";
import {
  fromModelRef,
  modelIdentity,
  THINKING_LEVEL_LABEL,
  toModelRef,
  type ModelRef,
  type ThinkingLevel,
} from "./model-services.ts";

/** 最低报告等级的三档。P0 最高，P2 即全报，是系统默认。 */
export type MinReportSeverity = "P0" | "P1" | "P2";

/** 三档的文案。审查策略页与仓库配置弹窗共用这一份，两处措辞不各写一遍。 */
export const MIN_REPORT_SEVERITY_LABEL: Record<MinReportSeverity, string> = {
  P0: "只报 P0",
  P1: "P1 及以上",
  P2: "全部报出（P2 及以上）",
};

/** 四项正整数上限同形：一个可空的数字、一颗「恢复默认」，随整页一起保存。 */
type LimitField =
  | "maxChangedLinesPerBatch"
  | "maxParallelBatches"
  | "maxFilesPerBatch"
  | "maxEvidenceCallsPerBatch";

/**
 * 审查策略的整份对象。上限四项与报告等级为 null 即跟随系统默认，默认值随 `defaults`
 * 一起回来，面板拿它当占位符——「取值来源」不再单独存一份，值空不空就是来源。
 */
type Settings = {
  reviewers: { provider: string; model: string; thinkingLevel?: ThinkingLevel }[];
  /** 辅助模型:Reviewer 之外的 agent 工作用它,null 即跟随模型组合第一个(issue #303)。 */
  auxiliaryModel: { provider: string; model: string; thinkingLevel?: ThinkingLevel } | null;
  maxChangedLinesPerBatch: number | null;
  maxParallelBatches: number | null;
  maxFilesPerBatch: number | null;
  maxEvidenceCallsPerBatch: number | null;
  minReportSeverity: MinReportSeverity | null;
  version: number;
  defaults: Record<LimitField, number> & { minReportSeverity: MinReportSeverity };
};

const LIMITS: {
  field: LimitField;
  title: string;
  help: string;
  inputId: string;
}[] = [
  {
    field: "maxChangedLinesPerBatch",
    title: "每批最多改动行数",
    help: "批次改动行上限只影响每轮审查如何拆分改动，不会改变模型组合。",
    inputId: "max-changed-lines",
  },
  {
    field: "maxParallelBatches",
    title: "同时在跑的批次数",
    help: "一轮审查里同时开跑的批次数。调大缩短大改动的等待时间，也同时占用更多模型配额。",
    inputId: "max-parallel-batches",
  },
  {
    field: "maxFilesPerBatch",
    title: "每批最多文件数",
    help: "一批最多包含多少个文件。文件数与改动行数任一超限即另起一批。",
    inputId: "max-files-per-batch",
  },
  {
    field: "maxEvidenceCallsPerBatch",
    title: "每批每模型最多取证次数",
    help: "一个模型在一批里最多派几次取证子代理。改了之后下一轮审查生效，已开跑的轮次沿用开跑时的值；单次取证内部的扇出上限不受它影响。",
    inputId: "max-evidence-calls-per-batch",
  },
];

/** 没设辅助模型时那句话:空着即用生效模型组合的第一个(ADR 0029)。 */
function followFirstReviewer(models: readonly ModelRef[]): string {
  const first = models[0];
  return first === undefined
    ? "跟随模型组合第一个"
    : `跟随模型组合第一个：${first.identity}`;
}

/** 报告等级下拉里「跟随系统默认」那一项的值。Radix `Select` 收不了空字符串。 */
const FOLLOW_DEFAULT = "default";

/** 表单里的一份草稿。上限是自由文本(空即跟随默认)，等级是三档或跟随默认。 */
type Draft = {
  models: ModelRef[];
  auxiliary: ModelRef | null;
  limits: Record<LimitField, string>;
  severity: MinReportSeverity | typeof FOLLOW_DEFAULT;
};

function draftOf(settings: Settings): Draft {
  return {
    models: settings.reviewers.map(toModelRef),
    auxiliary: settings.auxiliaryModel === null ? null : toModelRef(settings.auxiliaryModel),
    limits: {
      maxChangedLinesPerBatch: limitText(settings.maxChangedLinesPerBatch),
      maxParallelBatches: limitText(settings.maxParallelBatches),
      maxFilesPerBatch: limitText(settings.maxFilesPerBatch),
      maxEvidenceCallsPerBatch: limitText(settings.maxEvidenceCallsPerBatch),
    },
    severity: settings.minReportSeverity ?? FOLLOW_DEFAULT,
  };
}

function limitText(limit: number | null): string {
  return limit === null ? "" : String(limit);
}

/**
 * 两份草稿是不是同一份。上限比字面量：留空与显式的默认值不是同一件事；模型组合与辅助
 * 模型走 `lib/model-ref.ts` 那一份比较规则，与仓库配置弹窗同一条。
 */
function sameDraft(a: Draft, b: Draft): boolean {
  return sameModelRefs(a.models, b.models) &&
    sameModelRef(a.auxiliary, b.auxiliary) &&
    LIMITS.every(({ field }) => a.limits[field] === b.limits[field]) &&
    a.severity === b.severity;
}

/** 服务端拒了这一次保存并带回它此刻的整份对象。 */
class SettingsConflict extends Error {
  readonly latest: Settings;

  constructor(latest: Settings) {
    super("这一页刚被改过，你的改动尚未保存，请核对后再保存。");
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

/** 只读态把三段以静态值铺开：看得到配置，改不了。 */
function ReadOnlySettings({ settings }: { settings: Settings }) {
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card size="2" className="flex flex-col gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.015em]">模型</h2>
          <p className="mt-0.5 text-text-muted">所有未设置覆盖的仓库使用这组模型。</p>
        </div>
        <div className="space-y-1.5">
          {settings.reviewers.map((reviewer) => (
            <div key={modelIdentity(reviewer)} className="break-all font-mono text-xs">
              {modelIdentity(reviewer)}
            </div>
          ))}
        </div>
        {/* Reviewer 之外的 agent 工作用哪一处模型(issue #303)。 */}
        <div className="flex items-baseline justify-between gap-3 border-t border-card-line pt-3">
          <span className="text-text-muted">辅助模型</span>
          <span className="min-w-0 text-right">
            {settings.auxiliaryModel === null ? (
              <span className="text-text-muted">
                {followFirstReviewer(settings.reviewers.map(toModelRef))}
              </span>
            ) : (
              <>
                <span className="break-all font-mono text-xs">
                  {modelIdentity(settings.auxiliaryModel)}
                </span>
                {settings.auxiliaryModel.thinkingLevel === undefined ? null : (
                  <span className="ml-1.5 text-xs text-text-muted">
                    思考 {THINKING_LEVEL_LABEL[settings.auxiliaryModel.thinkingLevel]}
                  </span>
                )}
              </>
            )}
          </span>
        </div>
      </Card>
      <Card size="2" className="flex flex-col gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-[-0.015em]">运行上限与报告等级</h2>
          <p className="mt-0.5 text-text-muted">每轮审查如何拆分改动、同时跑几批、每批每模型最多取证几次、报到哪一档。</p>
        </div>
        <div className="space-y-2">
          {LIMITS.map((limit) => (
            <div key={limit.field} className="flex items-baseline justify-between gap-3">
              <span className="text-text-muted">{limit.title}</span>
              <span className="font-mono text-lg font-semibold tabular-nums">
                {settings[limit.field] ?? settings.defaults[limit.field]}
                {settings[limit.field] === null ? (
                  <span className="ml-1.5 font-sans text-xs font-normal text-text-muted">系统默认</span>
                ) : null}
              </span>
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-text-muted">最低报告等级</span>
            <span className="text-lg font-semibold">
              {MIN_REPORT_SEVERITY_LABEL[settings.minReportSeverity ?? settings.defaults.minReportSeverity]}
              {settings.minReportSeverity === null ? (
                <span className="ml-1.5 text-xs font-normal text-text-muted">系统默认</span>
              ) : null}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const requestedProvider = new URLSearchParams(window.location.search).get("provider") ?? undefined;
  // 基线是服务端此刻的那一份：脏状态、放弃改动与 409 之后的核对都对着它。
  const [baseline, setBaseline] = useState(settings);
  const [draft, setDraft] = useState(() => draftOf(settings));
  const [modelValidity, setModelValidity] = useState<ModelComposerValidity>({
    ready: false,
    unavailable: [],
  });
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);
  const [invalidLimits, setInvalidLimits] = useState<LimitField[]>([]);

  const dirty = !sameDraft(draft, draftOf(baseline));
  const edit = (next: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...next }));
    setFeedback(null);
  };

  const save = useMutation({
    mutationFn: async (): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          reviewers: draft.models.map(fromModelRef),
          auxiliaryModel: draft.auxiliary === null ? null : fromModelRef(draft.auxiliary),
          ...Object.fromEntries(
            LIMITS.map(({ field }) => [
              field,
              draft.limits[field].trim() === "" ? null : Number(draft.limits[field].trim()),
            ]),
          ),
          minReportSeverity: draft.severity === FOLLOW_DEFAULT ? null : draft.severity,
          expectedVersion: baseline.version,
        }),
      });
      if (response.status === 409) {
        const body = (await response.json()) as { settings: Settings };
        throw new SettingsConflict(body.settings);
      }
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Settings;
    },
    onSuccess: (saved) => {
      setBaseline(saved);
      setDraft(draftOf(saved));
      setFeedback({ text: "审查策略已保存，下一轮审查开始生效。", isError: false });
      queryClient.setQueryData(["settings"], saved);
    },
    onError: (error: Error) => {
      // 409:服务端当前值成为新基线并接受新版本号,草稿原样留着让人核对后再保存。
      if (error instanceof SettingsConflict) {
        setBaseline(error.latest);
        queryClient.setQueryData(["settings"], error.latest);
      }
      setFeedback({ text: error.message, isError: true });
    },
  });

  // 有未保存改动时,站内切页先确认,关标签页走浏览器原生提示。
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  // 组合首次配置后非空(spec #300):基线组合还是空的时候,空组合服务端照收,这一页也
  // 不因此禁用保存——那时人多半是先来把上限与等级填上。
  const emptyModelsBlocked = draft.models.length === 0 && baseline.reviewers.length > 0;
  const modelsBlocked = emptyModelsBlocked || !modelValidity.ready ||
    modelValidity.unavailable.length > 0;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        setFeedback(null);
        // 上限是自由文本:非正整数在这里就拦下,不发一个会被服务端整份拒收的请求。
        const bad = LIMITS.map(({ field }) => field).filter((field) => {
          const text = draft.limits[field].trim();
          const parsed = Number(text);
          return text !== "" && (!Number.isInteger(parsed) || parsed <= 0);
        });
        setInvalidLimits(bad);
        if (bad.length > 0) {
          setFeedback({ text: "运行上限要填正整数，留空即跟随系统默认。这次没有保存。", isError: true });
          return;
        }
        save.mutate();
      }}
    >
      <section className="space-y-3" aria-label="模型">
        <ModelComposer
          value={draft.models}
          provider={requestedProvider}
          onChange={(next) => edit({ models: next })}
          onValidityChange={setModelValidity}
        />
        {/* 辅助模型与模型组合同一段(issue #303):共用同一份候选投影与档位规则。 */}
        <div className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
          <div className="flex items-center gap-1.5 px-5 py-3.5">
            <h2 className="text-base font-semibold">辅助模型</h2>
            <HelpTooltip
              label="辅助模型说明"
              content="Reviewer 之外的全部 agent 工作用它：合并 agent、基点探索、知识整理、处置反哺与人工提议。留空即用模型组合的第一个；仓库可以在自己的配置里替换它。"
            />
          </div>
          <div className="border-t border-card-line px-5 py-4">
            <AuxiliaryModelPicker
              id="auxiliary-model"
              value={draft.auxiliary}
              emptyLabel={followFirstReviewer(draft.models)}
              onChange={(next) => edit({ auxiliary: next })}
            />
            <p className="mt-3 text-xs text-text-muted">
              留空即{followFirstReviewer(draft.models)}；改了之后下一轮 Review Run 与下一次知识任务生效。
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
        <div className="flex items-center gap-1.5 px-5 py-3.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">运行上限</h2>
          <HelpTooltip
            label="运行上限说明"
            content="每轮审查如何拆分改动、同时跑几批、每批每模型最多取证几次。留空即跟随系统默认，改了之后下一轮审查生效。"
          />
        </div>
        <div className="space-y-4 border-t border-card-line px-5 py-4">
          {LIMITS.map(({ field, title, help, inputId }) => {
            const invalid = invalidLimits.includes(field);
            return (
              <div key={field} className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <Text as="label" htmlFor={inputId} size="2" weight="medium">{title}</Text>
                  <HelpTooltip label={`${title}说明`} content={help} />
                </div>
                <Flex align="center" gap="2" wrap="wrap">
                  <TextField.Root
                    id={inputId}
                    size={{ initial: "3", sm: "2" }}
                    color={invalid ? "red" : "gray"}
                    className="min-w-0 w-40 font-mono max-sm:min-h-11"
                    inputMode="numeric"
                    placeholder={`系统默认 ${baseline.defaults[field]}`}
                    value={draft.limits[field]}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? `${inputId}-error` : undefined}
                    onChange={(event) => {
                      setInvalidLimits((current) => current.filter((entry) => entry !== field));
                      edit({ limits: { ...draft.limits, [field]: event.target.value } });
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    color="gray"
                    size={{ initial: "4", sm: "2" }}
                    disabled={draft.limits[field].trim() === ""}
                    onClick={() => {
                      setInvalidLimits((current) => current.filter((entry) => entry !== field));
                      edit({ limits: { ...draft.limits, [field]: "" } });
                    }}
                  >
                    恢复默认
                  </Button>
                </Flex>
                {invalid ? (
                  <span id={`${inputId}-error`} role="alert" className="text-danger">
                    要填正整数，留空即跟随系统默认。
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-card-line bg-surface shadow-card">
        <div className="flex items-center gap-1.5 px-5 py-3.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">报告等级</h2>
          <HelpTooltip
            label="最低报告等级说明"
            content="低于它的 Finding 不发出。它只管新报的问题：未处置的历史 Finding 照旧注入并复核，等级再低也一样。改了之后下一轮审查生效，已开跑的轮次沿用开跑时的值。"
          />
        </div>
        <div className="flex max-w-sm flex-col gap-1.5 border-t border-card-line px-5 py-4">
          <Text as="label" htmlFor="min-report-severity" size="2" weight="medium">
            报出的最低等级
          </Text>
          <Select.Root
            value={draft.severity}
            onValueChange={(next) => edit({ severity: next as Draft["severity"] })}
          >
            <Select.Trigger id="min-report-severity" className="w-full max-sm:min-h-11 sm:w-auto" />
            <Select.Content>
              <Select.Item value={FOLLOW_DEFAULT}>
                系统默认（{baseline.defaults.minReportSeverity}）
              </Select.Item>
              {(["P0", "P1", "P2"] as const).map((severity) => (
                <Select.Item key={severity} value={severity}>
                  {MIN_REPORT_SEVERITY_LABEL[severity]}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <p className="text-xs text-text-muted">
            低于它的 Finding 不发出；只管新报，未处置历史照旧复核；下一轮生效。
          </p>
        </div>
      </section>

      {/* 动作条固定在页面底部:整页只有这一处保存,脏状态与失败原因都落在这里。 */}
      <div className="sticky bottom-0 z-10 -mx-1 px-1 pb-1">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-card-line bg-sunken px-5 py-3 shadow-card">
          <Button
            type="submit"
            variant="solid"
            size={{ initial: "4", sm: "2" }}
            className="shadow-accent"
            disabled={save.isPending || !dirty || modelsBlocked}
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
          <Button
            type="button"
            variant="outline"
            color="gray"
            size={{ initial: "4", sm: "2" }}
            disabled={save.isPending || !dirty}
            onClick={() => {
              setInvalidLimits([]);
              setFeedback(null);
              setDraft(draftOf(baseline));
            }}
          >
            放弃改动
          </Button>
          {modelValidity.unavailable.length > 0 ? (
            <span className="text-danger">先恢复或移除不可用模型，再保存这一页。</span>
          ) : emptyModelsBlocked ? (
            <span className="text-danger">至少选择一个可用模型，审查配置才能就绪。</span>
          ) : !modelValidity.ready ? (
            <span className="text-text-muted">模型状态确认后即可保存。</span>
          ) : dirty ? (
            <span className="text-text-muted">有未保存改动</span>
          ) : (
            <span className="text-text-muted">与服务端当前值一致</span>
          )}
        </div>
      </div>

      {feedback === null ? null : (
        <Callout.Root
          role={feedback.isError ? "alert" : "status"}
          color={feedback.isError ? "red" : "green"}
          size="1"
        >
          <Callout.Icon>
            {feedback.isError ? <CrossCircledIcon aria-hidden /> : <CheckCircledIcon aria-hidden />}
          </Callout.Icon>
          <Callout.Text>{feedback.text}</Callout.Text>
        </Callout.Root>
      )}

      <AlertDialog.Root
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          // Esc 与点开外面都走这里:关掉即「继续编辑」,拦截解除但不放行导航。
          if (!open) blocker.reset?.();
        }}
      >
        <AlertDialog.Content maxWidth="440px" size={{ initial: "2", sm: "3" }}>
          <AlertDialog.Title size="4" mb="2">离开审查策略？</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            这一页有未保存的改动。离开会丢弃它们。
          </AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end">
            <Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "2" }}
              onClick={() => blocker.reset?.()}
            >
              继续编辑
            </Button>
            <Button
              type="button"
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              onClick={() => blocker.proceed?.()}
            >
              丢弃改动
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </form>
  );
}
