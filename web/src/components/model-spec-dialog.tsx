import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, Cross2Icon, CrossCircledIcon, ExclamationTriangleIcon, InfoCircledIcon } from "@radix-ui/react-icons";
import { Badge, Callout, Checkbox, Dialog, IconButton, Select, Text, TextArea, TextField } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { ModelSpecConflictResponse, ModelSpecOverrides, ModelSpecProjection } from "../../../src/contracts/model-specs.ts";
import { api } from "../api.ts";
import {
  MODEL_SPEC_FIELDS,
  modelSpecCandidateChoices,
  modelSpecDraft,
  modelSpecEditor,
  modelSpecSourceChoice,
  modelSpecTargetChanged,
  parseModelSpecDraft,
  rebaseModelSpecEditor,
  sameModelSpecOverrides,
  withModelSpecCandidate,
  withModelSpecValue,
  type ModelSpecCandidateChoice,
  type ModelSpecDraft,
  type ModelSpecEditor,
  type ModelSpecField,
} from "../lib/model-spec.ts";
import type { ModelServiceModel } from "../model-services.ts";
import { HelpTooltip } from "./help-tooltip";
import { Button } from "./theme-button";

const SPEC_FIELD_LABEL: Record<ModelSpecField, string> = {
  input: "输入类型",
  reasoning: "推理能力",
  contextWindow: "上下文窗口",
  maxTokens: "最大输出",
  thinkingLevelMap: "思考映射",
  compat: "兼容参数",
};

const SPEC_FIELD_HINT: Record<ModelSpecField, string> = {
  input: "决定模型能否接收图片。",
  reasoning: "声明这个模型支持思考；关闭思考仍可用。",
  contextWindow: "一次请求可容纳的最大 token 数。",
  maxTokens: "单次回复最多生成的 token 数。",
  thinkingLevelMap: "各思考档位对应的厂商参数；整份替换自动值。",
  compat: "厂商兼容开关；整份替换自动值。",
};

const JSON_FIELDS = new Set<ModelSpecField>(["thinkingLevelMap", "compat"]);

type SpecValue = NonNullable<ModelSpecOverrides[ModelSpecField]>;

function quantity(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function specValueText(field: ModelSpecField, value: SpecValue | null): string {
  if (value === null) return JSON_FIELDS.has(field) ? "未设置" : "未知";
  switch (field) {
    case "input":
      return (value as readonly ("text" | "image")[]).length === 0
        ? "无"
        : (value as readonly ("text" | "image")[]).join(" / ");
    case "reasoning":
      return value === true ? "声明推理" : "不声明推理";
    case "contextWindow":
    case "maxTokens":
      return `${quantity(value as number)} tokens`;
    case "thinkingLevelMap":
    case "compat":
      return `JSON · ${Object.keys(value as Record<string, unknown>).length} 个键`;
  }
}

function seedFromAutomatic(
  draft: ModelSpecDraft,
  field: ModelSpecField,
  value: SpecValue | null | undefined,
): ModelSpecDraft {
  return value === null || value === undefined ? draft : withModelSpecValue(draft, field, value);
}

function jsonDraftText(draft: ModelSpecDraft, field: ModelSpecField): string {
  return field === "thinkingLevelMap" ? draft.thinkingLevelMap : draft.compat;
}

/**
 * 模型规格弹窗(CONTEXT.md 模型规格,2026-10-27 改版)。每个字段一个「取值方式」:
 * 自动、某一组目录候选,或手动输入。自动与候选都只读展示,切到手动才出现编辑控件。
 */
export function ModelSpecDialog({ model, canWrite }: { model: ModelServiceModel; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<ModelSpecEditor | null>(null);
  const [latest, setLatest] = useState<ModelSpecProjection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const idPrefix = `${model.identity}-spec`;
  const draft = editor?.draft ?? modelSpecDraft(model);
  const parsed = parseModelSpecDraft(draft);
  const targetChanged = editor === null ? false : modelSpecTargetChanged(editor, model);
  const unchanged = editor !== null && sameModelSpecOverrides(parsed.overrides, editor.baseline.overrides);
  const overrideCount = Object.values(draft.enabled).filter(Boolean).length;
  const advancedOverrides = [draft.enabled.thinkingLevelMap, draft.enabled.compat].filter(Boolean).length;
  const saveEnabled = editor !== null && parsed.valid && !targetChanged && !unchanged && !saving;

  const reset = (): void => {
    setOpen(false);
    setEditor(null);
    setLatest(null);
    setError(null);
    setSaving(false);
    setAdvancedOpen(false);
  };

  const updateDraft = (change: (draft: ModelSpecDraft) => ModelSpecDraft): void => {
    setEditor((current) => (current === null ? current : { ...current, draft: change(current.draft) }));
  };
  const setFieldEnabled = (field: ModelSpecField, enabled: boolean): void => {
    updateDraft((draft) => ({ ...draft, enabled: { ...draft.enabled, [field]: enabled } }));
  };
  const toggleInput = (kind: "text" | "image", checked: boolean): void => {
    updateDraft((draft) => {
      const rest = draft.input.filter((value) => value !== kind);
      return { ...draft, input: checked ? [...rest, kind] : rest };
    });
  };
  const selectMode = (field: ModelSpecField, next: string, choices: readonly ModelSpecCandidateChoice[]): void => {
    if (next === "auto") {
      setFieldEnabled(field, false);
      return;
    }
    if (next === "manual") {
      updateDraft((current) => {
        const seeded = current.enabled[field]
          ? current
          : seedFromAutomatic(current, field, model.automaticEffectiveFields[field]);
        return { ...seeded, enabled: { ...seeded.enabled, [field]: true } };
      });
      return;
    }
    const choice = choices.find((entry) => entry.candidateId === next);
    if (choice !== undefined) updateDraft((current) => withModelSpecCandidate(current, field, choice.value));
  };
  const resetAll = (): void => {
    updateDraft((draft) => ({
      ...draft,
      enabled: Object.fromEntries(MODEL_SPEC_FIELDS.map((field) => [field, false])) as ModelSpecDraft["enabled"],
    }));
  };
  const formatJson = (field: "thinkingLevelMap" | "compat"): void => {
    updateDraft((draft) => {
      try {
        const value: unknown = JSON.parse(draft[field]);
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
          return { ...draft, [field]: JSON.stringify(value, null, 2) };
        }
      } catch {
        // 无效 JSON 保持原样,由字段错误提示。
      }
      return draft;
    });
  };
  const reload = (): void => {
    setEditor(modelSpecEditor(latest ?? model));
    setLatest(null);
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (editor === null || !parsed.valid || targetChanged || unchanged || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await api(
        `/model-services/${encodeURIComponent(model.provider)}/models/${encodeURIComponent(model.id)}/overrides`,
        {
          method: "PUT",
          body: JSON.stringify({ expectedVersion: editor.baseline.currentVersion, overrides: parsed.overrides }),
        },
      );
      if (response.ok) {
        await queryClient.invalidateQueries({ queryKey: ["model-services"] });
        reset();
        return;
      }
      const body = (await response.json().catch(() => null)) as (ModelSpecConflictResponse & { error?: string }) | null;
      const message = body?.error ?? `请求失败(${response.status})`;
      if (response.status === 409 && body !== null && "current" in body) {
        setLatest(body.current);
        setEditor((current) => (current === null ? current : rebaseModelSpecEditor(current, body.current)));
        setError(body.current === null
          ? `${message}；这个模型已不在当前模型服务里。`
          : `${message}；草稿原样保留，核对后再保存。`);
        return;
      }
      setError(message);
    } catch {
      setError("请求没发出去，请检查网络后重试。");
    } finally {
      setSaving(false);
    }
  };

  if (!canWrite) return null;

  const candidatesHint = model.candidates.length > 1
    ? `目录匹配到 ${model.candidates.length} 组，自动值按官方优先合成；每个字段可以改选某一组，或手动输入。`
    : model.candidates.length === 1
      ? "目录只匹配到一组，自动值取自这一组；可逐字段改成手动输入。"
      : Object.values(model.automaticFields).some((value) => value !== null)
        ? "自动值来自目录；这一版没有保留候选组，需要时逐字段手动覆盖。"
        : "目录里没有匹配到这个型号，自动值来自运行基线；需要时逐字段手动覆盖。";

  const fieldRow = (field: ModelSpecField, control: ReactNode): ReactNode => {
    const choices = modelSpecCandidateChoices(model.candidates, field);
    const mode = modelSpecSourceChoice(draft, field, choices);
    const choice = choices.find((entry) => entry.candidateId === mode);
    const overridden = draft.enabled[field];
    const manual = mode === "manual";
    const automatic = model.automaticEffectiveFields[field] ?? null;
    const fieldError = parsed.errors[field];
    return (
      <div
        key={field}
        className={cn(
          "rounded-lg border p-3 transition-colors sm:p-4",
          overridden ? "border-accent-track bg-accent-tint" : "border-line bg-surface",
        )}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-x-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Text id={`${idPrefix}-${field}`} size="2" weight="medium">{SPEC_FIELD_LABEL[field]}</Text>
              {overridden ? (
                <Badge size="1" variant="soft" color={manual ? "amber" : "blue"}>
                  {manual ? "手动" : choice?.label ?? "覆盖"}
                </Badge>
              ) : null}
            </div>
            <p className="mt-1 text-md font-medium text-text">
              自动值 <span className="font-semibold">{specValueText(field, automatic)}</span>
              {overridden && !manual && choice !== undefined ? ` · 取自 ${choice.label}：${specValueText(field, choice.value)}` : null}
              {manual ? " · 当前为手动覆盖" : null}
            </p>
            <p className="mt-0.5 hidden text-base text-text-muted sm:block">{SPEC_FIELD_HINT[field]}</p>
          </div>
          <Select.Root
            size="1"
            value={mode}
            onValueChange={(next) => selectMode(field, next, choices)}
          >
            <Select.Trigger className="w-full sm:w-auto" aria-label={`${SPEC_FIELD_LABEL[field]}的取值方式`} />
            <Select.Content>
              <Select.Item value="auto">自动</Select.Item>
              {choices.map((entry) => (
                <Select.Item key={entry.candidateId} value={entry.candidateId}>
                  {entry.label}：{specValueText(field, entry.value)}
                </Select.Item>
              ))}
              <Select.Item value="manual">手动输入</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
        {manual ? (
          <div className="mt-3">{control}</div>
        ) : JSON_FIELDS.has(field) ? (
          <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-line bg-sunken p-3 font-mono text-base leading-relaxed">
            {!overridden && automatic === null ? "未设置" : jsonDraftText(draft, field)}
          </pre>
        ) : null}
        {fieldError === undefined ? null : <p className="mt-2 text-base text-danger">{fieldError}</p>}
      </div>
    );
  };

  const section = (title: string, hint: string, children: ReactNode): ReactNode => (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Text size="2" weight="medium">{title}</Text>
        <Text size="1" className="text-text-muted">{hint}</Text>
      </div>
      {children}
    </section>
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
          return;
        }
        setEditor(modelSpecEditor(model));
        setLatest(null);
        setError(null);
        setAdvancedOpen(Object.hasOwn(model.overrides, "thinkingLevelMap") || Object.hasOwn(model.overrides, "compat"));
      }}
    >
      <Dialog.Trigger>
        <Button type="button" variant="ghost" color="gray" size={{ initial: "3", sm: "1" }}>
          编辑规格
        </Button>
      </Dialog.Trigger>
      <Dialog.Content
        aria-describedby={undefined}
        maxWidth="680px"
        maxHeight="calc(100dvh - 2rem)"
        size={{ initial: "2", sm: "3" }}
        className="flex flex-col overflow-hidden max-sm:h-[calc(100dvh_-_2rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Dialog.Title size="4" mb="0" className="flex flex-wrap items-center gap-2">
              编辑模型规格
              {overrideCount === 0 ? null : <Badge size="1" color="blue" variant="soft">{overrideCount} 项覆盖</Badge>}
              <HelpTooltip
                label="模型规格覆盖说明"
                content="每个字段默认取自动值：目录有多组候选时按官方优先合成，也可以改选某一组或手动填写。覆盖绑定这个模型此刻的调用目标；目标变了要按当前规格重载。保存只影响之后的使用，已开跑的 Review Run 与常驻会话沿用开跑时的规格。"
              />
            </Dialog.Title>
            <p className="wrap-anywhere font-mono text-base text-text-muted">{model.identity}</p>
          </div>
          <Dialog.Close>
            <IconButton variant="ghost" color="gray" size={{ initial: "3", sm: "1" }} className="shrink-0" aria-label="关闭编辑模型规格">
              <Cross2Icon aria-hidden />
            </IconButton>
          </Dialog.Close>
        </div>

        <div className="-mr-2 mt-3 flex min-h-0 flex-col gap-5 overflow-y-auto pr-2">
          {targetChanged ? (
            <Callout.Root role="alert" color="amber" size="1">
              <Callout.Icon><ExclamationTriangleIcon aria-hidden /></Callout.Icon>
              <Callout.Text>调用目标已变化或无法确认，旧草稿不能套用；请按当前规格重载后再改。</Callout.Text>
            </Callout.Root>
          ) : null}

          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-sunken p-3">
            <div className="flex min-w-0 items-start gap-2">
              <InfoCircledIcon className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0">
                <Text size="2" weight="medium">
                  {model.candidates.length > 1
                    ? `匹配到 ${model.candidates.length} 组目录候选`
                    : model.candidates.length === 1
                      ? "匹配到 1 组目录候选"
                      : "未匹配到目录候选"}
                </Text>
                <p className="mt-0.5 text-base text-text-muted">{candidatesHint}</p>
              </div>
            </div>
            {overrideCount === 0 ? null : (
              <Button type="button" variant="ghost" color="gray" size="1" onClick={resetAll}>
                全部恢复自动
              </Button>
            )}
          </div>

          {section("能力", "输入与推理", (
            <div className="flex flex-col gap-2">
              {fieldRow("input", (
                <div role="group" aria-labelledby={`${idPrefix}-input`} className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line bg-surface px-3 py-2">
                  <Text as="label" size="2" className="inline-flex items-center gap-2">
                    <Checkbox
                      size="2"
                      checked={draft.input.includes("text")}
                      onCheckedChange={(next) => toggleInput("text", next === true)}
                    />
                    文本
                  </Text>
                  <Text as="label" size="2" className="inline-flex items-center gap-2">
                    <Checkbox
                      size="2"
                      checked={draft.input.includes("image")}
                      onCheckedChange={(next) => toggleInput("image", next === true)}
                    />
                    图片
                  </Text>
                </div>
              ))}
              {fieldRow("reasoning", (
                <Text as="label" size="2" className="inline-flex w-fit items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
                  <Checkbox
                    size="2"
                    checked={draft.reasoning}
                    onCheckedChange={(next) => updateDraft((draft) => ({ ...draft, reasoning: next === true }))}
                  />
                  声明支持推理
                </Text>
              ))}
            </div>
          ))}

          {section("容量", "以 token 计", (
            <div className="flex flex-col gap-2">
              {fieldRow("contextWindow", (
                <TextField.Root
                  id={`${idPrefix}-contextWindow`}
                  aria-labelledby={`${idPrefix}-contextWindow`}
                  size="2"
                  className="font-mono"
                  inputMode="numeric"
                  value={draft.contextWindow}
                  onChange={(event) => updateDraft((draft) => ({ ...draft, contextWindow: event.target.value }))}
                >
                  <TextField.Slot side="right"><Text size="1" color="gray">tokens</Text></TextField.Slot>
                </TextField.Root>
              ))}
              {fieldRow("maxTokens", (
                <TextField.Root
                  id={`${idPrefix}-maxTokens`}
                  aria-labelledby={`${idPrefix}-maxTokens`}
                  size="2"
                  className="font-mono"
                  inputMode="numeric"
                  value={draft.maxTokens}
                  onChange={(event) => updateDraft((draft) => ({ ...draft, maxTokens: event.target.value }))}
                >
                  <TextField.Slot side="right"><Text size="1" color="gray">tokens</Text></TextField.Slot>
                </TextField.Root>
              ))}
            </div>
          ))}

          <Collapsible.Root open={advancedOpen} onOpenChange={setAdvancedOpen} className="flex flex-col gap-2">
            <Collapsible.Trigger className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 text-left">
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Text size="2" weight="medium">高级设置</Text>
                <Text size="1" className="text-text-muted">思考映射与兼容参数</Text>
                {advancedOverrides === 0 ? null : <Badge size="1" color="blue" variant="soft">已覆盖 {advancedOverrides}</Badge>}
              </span>
              <ChevronDownIcon className={cn("shrink-0 transition-transform duration-150", advancedOpen && "rotate-180")} aria-hidden />
            </Collapsible.Trigger>
            <Collapsible.Content className="collapsible-motion">
              <div className="flex flex-col gap-2 pt-2">
                {fieldRow("thinkingLevelMap", (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Text size="1" className="text-text-muted">整份替换自动值</Text>
                      <div className="flex items-center gap-2">
                        <Badge size="1" variant="soft" color={parsed.errors.thinkingLevelMap === undefined ? "green" : "red"}>
                          {parsed.errors.thinkingLevelMap === undefined ? "JSON 有效" : "JSON 无效"}
                        </Badge>
                        <Button type="button" variant="ghost" color="gray" size="1" disabled={parsed.errors.thinkingLevelMap !== undefined} onClick={() => formatJson("thinkingLevelMap")}>
                          格式化
                        </Button>
                      </div>
                    </div>
                    <TextArea
                      id={`${idPrefix}-thinkingLevelMap`}
                      aria-labelledby={`${idPrefix}-thinkingLevelMap`}
                      size="2"
                      className="font-mono"
                      rows={5}
                      value={draft.thinkingLevelMap}
                      onChange={(event) => updateDraft((draft) => ({ ...draft, thinkingLevelMap: event.target.value }))}
                    />
                  </div>
                ))}
                {fieldRow("compat", (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Text size="1" className="text-text-muted">整份替换自动值；空对象 {"{}"} 也算一次覆盖</Text>
                      <div className="flex items-center gap-2">
                        <Badge size="1" variant="soft" color={parsed.errors.compat === undefined ? "green" : "red"}>
                          {parsed.errors.compat === undefined ? "JSON 有效" : "JSON 无效"}
                        </Badge>
                        <Button type="button" variant="ghost" color="gray" size="1" disabled={parsed.errors.compat !== undefined} onClick={() => formatJson("compat")}>
                          格式化
                        </Button>
                      </div>
                    </div>
                    <TextArea
                      id={`${idPrefix}-compat`}
                      aria-labelledby={`${idPrefix}-compat`}
                      size="2"
                      className="font-mono"
                      rows={5}
                      value={draft.compat}
                      onChange={(event) => updateDraft((draft) => ({ ...draft, compat: event.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>

          {error === null ? null : (
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
        </div>

        <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <Text size="1" className="text-text-muted">
            {editor === null ? "" : `${overrideCount} 项覆盖 · ${unchanged ? "没有未保存改动" : "有未保存改动"}`}
          </Text>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {targetChanged ? (
              <Button type="button" variant="soft" color="gray" size={{ initial: "3", sm: "2" }} onClick={reload}>
                按当前规格重载
              </Button>
            ) : null}
            <Dialog.Close>
              <Button type="button" variant="outline" color="gray" size={{ initial: "3", sm: "2" }} disabled={saving}>
                取消
              </Button>
            </Dialog.Close>
            <Button
              type="button"
              variant={saveEnabled || saving ? "solid" : "outline"}
              {...(saveEnabled || saving ? {} : { color: "gray" as const })}
              size={{ initial: "3", sm: "2" }}
              className="disabled:opacity-100"
              disabled={!saveEnabled}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "保存"}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
