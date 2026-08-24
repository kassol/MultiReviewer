/**
 * `/credentials` 书签路径上的模型服务检查表(issue #134 / #135)。读取只消费按当前会话裁剪过的
 * `/model-services`；内置候选只留在组件内存，模型字段与凭据审计字段继续按独立权限展示。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useBlocker, useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, Cross2Icon, CrossCircledIcon, ExclamationTriangleIcon, InfoCircledIcon, MagnifyingGlassIcon, MinusCircledIcon, ReloadIcon, TrashIcon } from "@radix-ui/react-icons";
import { AlertDialog, Badge, Callout, Checkbox, Dialog, Flex, IconButton, Select, Skeleton, TabNav, Text, TextField, Tooltip } from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";

import { HelpTooltip } from "@/components/help-tooltip";
import { EditableModelCombobox } from "@/components/editable-model-combobox";
import { EmptyState } from "@/components/empty-state";
import { PageBody } from "@/components/page-body";
import { PageHeader } from "@/components/page-header";
import {
  MasterListItem,
  MasterListItemText,
} from "@/components/master-list-item";
import { StatusBadge, type StatusTone } from "@/components/status-badge";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus, visibleNavCurrentItem } from "@/components/use-dialog-return-focus";
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
  "legacy-provider-check": "历史服务检查",
  "legacy-review-run": "历史审查记录",
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

/**
 * 卡壳。Themes 的 Card 把圆角画在伪元素上,而这套设计的卡片圆角随视口在 14 / 12 之间
 * 换档,只改根元素的话边框与底色的圆角会错开;列表卡还要求零内边距加逐行分隔。所以
 * 壳走 utility + 令牌,壳里的通用件(徽章、输入、按钮、骨架)仍是 Themes 组件。
 */
function CardShell({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-card-line bg-surface shadow-card sm:rounded-lg",
        className,
      )}
      {...props}
    />
  );
}

/** 卡头:左边这张卡叫什么,右边是它当下的计数或那一个动作。 */
function CardHeader({
  id,
  title,
  help,
  meta,
  action,
}: {
  id?: string;
  title: ReactNode;
  help?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3.5 pb-[11px] sm:px-5">
      <div className="flex min-w-0 items-center gap-1.5">
        <h3 id={id} className="min-w-0 text-2xl font-bold tracking-[-0.015em]">{title}</h3>
        {help}
      </div>
      {meta === undefined ? null : <span className="shrink-0 text-base text-text-muted">{meta}</span>}
      {action}
    </div>
  );
}

/** 卡内分区。与卡头之间用一条行线断开,左右内边距与卡头对齐。 */
function CardSection({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("border-t border-line px-4 py-3.5 sm:px-5", className)} {...props} />;
}

/** 信息网格。设计稿的凭据卡就是这三列;窄屏降两列、再窄一列,值本身不换行。 */
function InfoGrid({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-3", className)} {...props} />;
}

function InfoField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm text-text-muted">{label}</span>
      <span className="min-w-0 text-lg">{children}</span>
    </div>
  );
}

/** 等宽值。缺字段时退回正文字体——「未提供」不是一段 id,不该按 id 排版。 */
function MonoValue({ value }: { value: string | null | undefined }) {
  return value === null || value === undefined ? (
    <span className="text-text-muted">未提供</span>
  ) : (
    <span className="break-all font-mono text-base">{value}</span>
  );
}

const NOTICE_TONE = {
  warning: { shell: "border-warning-icon/20 bg-warning-tint", icon: "text-warning-icon", title: "text-warning" },
  danger: { shell: "border-danger/20 bg-danger-tint", icon: "text-danger", title: "text-danger" },
  neutral: { shell: "border-card-line bg-sunken", icon: "text-text-muted", title: "text-text" },
} as const;

/**
 * 行内通知条。设计稿只画了警告一档,危险与中性沿用同一结构换语义色:这三条在页面上
 * 承担的都是「状态说明 + 下一步」,分档只交给颜色,结构不跟着分叉。
 */
function NoticeBar({
  tone,
  icon: Icon,
  title,
  titleId,
  children,
}: {
  tone: keyof typeof NOTICE_TONE;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: ReactNode;
  titleId?: string;
  children?: ReactNode;
}) {
  const style = NOTICE_TONE[tone];
  return (
    <section
      aria-labelledby={titleId}
      className={cn("flex items-start gap-2.5 rounded-lg border px-[18px] py-3", style.shell)}
    >
      <Icon aria-hidden className={cn("mt-0.5 size-[15px] shrink-0", style.icon)} />
      <div className="flex min-w-0 flex-col gap-px">
        <h3 id={titleId} className={cn("text-md font-semibold", style.title)}>{title}</h3>
        {children === undefined ? null : <div className="text-base text-text-secondary">{children}</div>}
      </div>
    </section>
  );
}

/** 来源、身份、类别一律走 Themes Badge;等宽只包 model id 与 provider 这类标识。 */
function SourceBadge({ children }: { children: ReactNode }) {
  return (
    <Badge color="gray" variant="soft" radius="full" size="1">
      {children}
    </Badge>
  );
}

const SERVICE_STATUS_TONE = {
  success: { dot: "bg-success", text: "text-success" },
  disabled: { dot: "bg-neutral-dot", text: "text-text-disabled" },
  error: { dot: "bg-danger", text: "text-danger" },
} as const;

/**
 * 服务列表行的状态。判据不变(能不能跑 → 是不是名字冲突),只把徽章换成设计稿的圆点
 * 加文字:264px 的侧栏里,一枚实心徽章会把服务名挤到只剩两个字。
 */
function serviceStatus(service: ModelService): {
  label: string;
  tone: keyof typeof SERVICE_STATUS_TONE;
} {
  if (service.runCapability.runnable) return { label: "正常", tone: "success" };
  if (service.providerState === "name-conflict") return { label: "已停用", tone: "disabled" };
  return { label: "需处理", tone: "error" };
}

function ServiceStatus({ service }: { service: ModelService }) {
  const status = serviceStatus(service);
  const style = SERVICE_STATUS_TONE[status.tone];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-sm font-semibold", style.text)}>
      <span aria-hidden className={cn("size-[7px] rounded-full", style.dot)} />
      {status.label}
    </span>
  );
}

const SETUP_STEPS = ["选择来源", "模型发现", "真实验证"] as const;

/**
 * 三步指示条。已完成用绿勾、当前用实心蓝、未来用灰底数字,连接线跟着前一步的完成度
 * 变色。窄屏只保留当前步的文字:三段中文标题在 390px 上会把圆点挤成一条竖排。
 */
function StepRail({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2.5" aria-label="配置模型服务步骤">
      {SETUP_STEPS.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <Fragment key={label}>
            {index === 0 ? null : (
              <li
                aria-hidden
                className={cn("h-0.5 min-w-2 flex-1 rounded-full", done ? "bg-success/35" : "bg-fill")}
              />
            )}
            <li
              aria-current={active ? "step" : undefined}
              className="flex shrink-0 items-center gap-2"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-[22px] shrink-0 items-center justify-center rounded-full text-sm font-bold",
                  done && "bg-success-tint text-success",
                  active && "bg-primary text-white shadow-accent",
                  !done && !active && "bg-fill text-text-muted",
                )}
              >
                {done ? <CheckIcon className="size-3" /> : step}
              </span>
              <span
                className={cn(
                  "text-base",
                  active ? "font-bold" : done ? "font-medium text-success" : "text-text-muted",
                  active ? null : "max-sm:hidden",
                )}
              >
                {label}
              </span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** 向导正文。模态自己不留内边距,正文与页脚各自铺满模态宽度。 */
function SetupBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-col gap-3.5 px-5 py-[18px] sm:px-7", className)} {...props} />;
}

/**
 * 向导页脚。左边是当前阶段说明,右边是这一步的两个动作。它粘在模态底部:内容长到要
 * 滚时,「继续」不该跟着滚出视野。
 */
function SetupFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 mt-auto bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-overlay-line bg-sunken px-5 py-[15px] sm:px-7">
        <span className="min-w-0 text-base text-text-muted">{note}</span>
        <div className="flex flex-wrap items-center gap-2.5 max-sm:w-full">{children}</div>
      </div>
    </div>
  );
}

/** 向导里「刷新页面就没了」的那一屏,三个入口共用。 */
function SetupExpired({ children }: { children: ReactNode }) {
  return (
    <SetupBody>
      <CardShell className="gap-1.5 px-4 py-4 sm:px-5">
        <h2 className="text-2xl font-bold tracking-[-0.015em]">配置已过期</h2>
        <p className="text-text-secondary">
          刷新或直接打开此地址不会恢复凭据和目录结果，请重新配置模型服务。
        </p>
        <div className="pt-1.5">{children}</div>
      </CardShell>
    </SetupBody>
  );
}

/** 主从栅格。264px 定宽侧栏 + 自适应详情,窄屏改单列各占满宽。 */
const MASTER_DETAIL_COLUMNS = "lg:grid-cols-[264px_minmax(0,1fr)] lg:items-start lg:gap-[18px]";

/** 模型行三列:模型、运行规格、状态。列宽只在 xl 起生效,更窄时行内纵向堆叠。 */
const MODEL_ROW_COLUMNS = "xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)_110px]";

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
type ModelServiceReturnFocus = "add-service" | "configure-builtin" | "configure-custom";
type ModelServiceReturnSearch = {
  returnProvider?: string;
  returnTab?: ModelServiceTab;
  returnFocus: ModelServiceReturnFocus;
  returnServiceScroll: number;
  returnMainScroll: number;
};

function scrollValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function modelServiceStableFocus(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[aria-label='模型服务详情'] [aria-current='page']")
    ?? document.querySelector<HTMLElement>("[data-slot='master-list-item'][aria-current='true']")
    ?? document.getElementById("add-model-service-trigger");
}

function modelServiceReturnSearch(
  provider: string | undefined,
  tab: ModelServiceTab,
  returnFocus: ModelServiceReturnFocus,
): ModelServiceReturnSearch {
  const serviceList = document.getElementById("model-service-list-scroll");
  const main = document.getElementById("model-service-detail-scroll")
    ?? document.getElementById("panel-main-scroll");
  return {
    ...(provider === undefined ? {} : { returnProvider: provider, returnTab: tab }),
    returnFocus,
    returnServiceScroll: serviceList?.scrollTop ?? 0,
    returnMainScroll: main?.scrollTop ?? 0,
  };
}

type ModelServiceSetupContextValue = {
  candidate: ModelServiceSetupCandidate | null;
  setCandidate: React.Dispatch<React.SetStateAction<ModelServiceSetupCandidate | null>>;
  phase: SetupPhase;
  setPhase: React.Dispatch<React.SetStateAction<SetupPhase>>;
  transition: (navigate: () => Promise<unknown>) => void;
  requestClose: () => void;
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
  const [closeRequested, setCloseRequested] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const allowExit = useRef(false);
  const confirmationFocus = useDialogReturnFocus(() =>
    document.getElementById("model-service-setup-close")
      ?? visibleNavCurrentItem(),
  );
  const search = typeof location.search === "object" && location.search !== null
    ? location.search as Record<string, unknown>
    : {};
  const returnProvider =
    typeof search.returnProvider === "string"
      ? search.returnProvider
      : undefined;
  const returnTab =
    search.returnTab === "maintenance" || search.returnTab === "models" || search.returnTab === "overview"
      ? search.returnTab
      : "overview";
  const returnServiceScroll = scrollValue(search.returnServiceScroll);
  const returnMainScroll = scrollValue(search.returnMainScroll);
  const returnFocus: ModelServiceReturnFocus =
    search.returnFocus === "configure-builtin" || search.returnFocus === "configure-custom"
      ? search.returnFocus
      : "add-service";
  const restoreScroll = (): void => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (returnMainScroll !== undefined) {
          const main = document.getElementById("model-service-detail-scroll")
            ?? document.getElementById("panel-main-scroll");
          if (main !== null) main.scrollTop = returnMainScroll;
        }
        if (returnServiceScroll !== undefined) {
          const serviceList = document.getElementById("model-service-list-scroll");
          if (serviceList !== null) serviceList.scrollTop = returnServiceScroll;
        }
        const focusId = returnFocus === "add-service" || returnProvider === undefined
          ? "add-model-service-trigger"
          : `${returnFocus}-${returnProvider}`;
        document.getElementById(focusId)?.focus();
      });
    });
  };
  const navigateBack = async (): Promise<void> => {
    if (returnProvider === undefined) {
      await navigate({ to: "/credentials" });
      restoreScroll();
      return;
    }
    if (returnTab === "maintenance") {
      await navigate({ to: "/credentials/$provider/maintenance", params: { provider: returnProvider } });
      restoreScroll();
      return;
    }
    if (returnTab === "models") {
      await navigate({ to: "/credentials/$provider/models", params: { provider: returnProvider } });
      restoreScroll();
      return;
    }
    await navigate({ to: "/credentials/$provider", params: { provider: returnProvider } });
    restoreScroll();
  };
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
  const currentStep = location.pathname.endsWith("/verify") ? 3 : location.pathname.endsWith("/discover") ? 2 : 1;
  const closeSetup = (): void => {
    if (phase !== null) return;
    if (dirty) {
      setCloseRequested(true);
      return;
    }
    allowExit.current = true;
    void navigateBack().finally(() => {
      allowExit.current = false;
    });
  };
  const discardAndClose = (): void => {
    allowExit.current = true;
    setCandidate(null);
    setCloseRequested(false);
    void navigateBack().finally(() => {
      allowExit.current = false;
    });
  };

  return (
    <ModelServiceSetupContext.Provider value={{ candidate, setCandidate, phase, setPhase, transition, requestClose: closeSetup, finish }}>
      <Dialog.Root open onOpenChange={(open) => { if (!open) closeSetup(); }}>
        <Dialog.Content
          maxWidth={{ initial: "100%", sm: "720px" }}
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          // 模态自己不留内边距:头、体、脚三段各自铺满 720px 宽,页脚才能像设计稿那样通栏。
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl p-0 shadow-modal sm:rounded-3xl"
          aria-busy={phase !== null}
          onEscapeKeyDown={(event) => { if (dirty || phase !== null) event.preventDefault(); }}
          onClickCapture={confirmationFocus.captureBubblingLink}
        >
          <div className="flex shrink-0 flex-col gap-4 border-b border-overlay-line px-5 pt-6 pb-[18px] sm:px-7">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Dialog.Title size="6" mb="0" className="font-extrabold tracking-[-0.02em]">配置模型服务</Dialog.Title>
                <Dialog.Description size="2" color="gray">未提交内容只保留在当前页面。</Dialog.Description>
              </div>
              <Tooltip content="关闭配置模型服务">
                <Dialog.Close>
                  <IconButton
                    id="model-service-setup-close"
                    variant="soft"
                    color="gray"
                    radius="full"
                    size={{ initial: "3", sm: "2" }}
                    className="shrink-0 max-sm:min-h-11 max-sm:min-w-11"
                    aria-label="关闭配置模型服务"
                    onClick={confirmationFocus.captureTrigger}
                  >
                    <Cross2Icon aria-hidden />
                  </IconButton>
                </Dialog.Close>
              </Tooltip>
            </div>
            <StepRail current={currentStep} />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"><Outlet /></div>
        </Dialog.Content>
      </Dialog.Root>
      <AlertDialog.Root open={closeRequested} onOpenChange={setCloseRequested}>
        <AlertDialog.Content
          maxWidth="440px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={confirmationFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="6" mb="2" className="font-extrabold tracking-[-0.02em]">丢弃未保存的配置？</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">关闭会丢弃当前页面中的凭据、目录结果和验证模型。</AlertDialog.Description>
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
            <AlertDialog.Cancel><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>继续配置</Button></AlertDialog.Cancel>
            <AlertDialog.Action><Button type="button" variant="solid" color="red" size={{ initial: "4", sm: "2" }} onClick={discardAndClose}>丢弃并关闭</Button></AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root open={blocker.status === "blocked"} onOpenChange={(open) => { if (!open) blocker.reset?.(); }}>
        <AlertDialog.Content
          maxWidth="440px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={confirmationFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="6" mb="2" className="font-extrabold tracking-[-0.02em]">{phase === null ? "丢弃未保存的配置？" : "模型服务操作仍在进行"}</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
              {phase === null
                ? "离开会丢弃当前页面中的凭据、目录结果和验证模型。"
                : "请求结束前会锁定离开与丢弃动作，请等待当前阶段完成。"}
          </AlertDialog.Description>
          {phase === null ? (
            <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
              <AlertDialog.Cancel><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>继续配置</Button></AlertDialog.Cancel>
              <AlertDialog.Action><Button
                type="button"
                variant="solid"
                color="red"
                size={{ initial: "4", sm: "2" }}
                onClick={() => {
                  allowExit.current = true;
                  setCandidate(null);
                  blocker.proceed?.();
                }}
              >
                丢弃并离开
              </Button></AlertDialog.Action>
            </Flex>
          ) : (
            <Flex mt="4" justify="end">
              <AlertDialog.Cancel><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>返回配置</Button></AlertDialog.Cancel>
            </Flex>
          )}
        </AlertDialog.Content>
      </AlertDialog.Root>
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
    <>
      <SetupBody aria-busy={providers.isPending}>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">选择模型服务来源</h2>
          <p className="text-text-secondary">搜索预置的 provider；要用自己的调用地址就选下方的自定义。</p>
        </div>
        <TextField.Root
          size={{ initial: "3", sm: "2" }}
          className="w-full min-w-0 max-sm:min-h-11"
          aria-label="搜索预置的 provider"
          placeholder="输入 provider 标识或名称"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        >
          <TextField.Slot side="left">
            <MagnifyingGlassIcon aria-hidden="true" />
          </TextField.Slot>
        </TextField.Root>
        {providers.isPending ? (
          <div role="status" aria-live="polite" aria-busy="true">
            <span className="sr-only">正在加载预置的 provider</span>
            <Skeleton aria-hidden className="h-28" />
          </div>
        ) : providers.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>内置模型服务加载失败：{(providers.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : providers.data.providers.length === 0 ? (
          <EmptyState title="没有匹配的 provider" className="py-2" />
        ) : (
          <div
            className="flex max-h-80 flex-col divide-y divide-line overflow-x-hidden overflow-y-auto rounded-lg border border-overlay-line"
            role="list"
          >
            {providers.data.providers.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="ghost"
                color="gray"
                radius="none"
                size="3"
                className="h-auto min-h-11 w-full justify-start gap-3 px-4 py-[11px] text-left sm:min-h-0"
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
                    search: true,
                  });
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block break-all font-mono text-base font-medium">{provider.id}</span>
                  <span className="block break-words text-sm text-text-muted">{provider.name}</span>
                </span>
                {provider.conflict ? <StatusBadge tone="error">名字冲突</StatusBadge> : null}
                {provider.configured ? <StatusBadge tone="success">已配置</StatusBadge> : <StatusBadge tone="neutral">未配置</StatusBadge>}
              </Button>
            ))}
          </div>
        )}
      </SetupBody>
      <SetupFooter>
        {canWriteCustom ? (
          <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
            <Link to="/credentials/add/custom/discover" search={true}>添加自定义 provider</Link>
          </Button>
        ) : null}
      </SetupFooter>
    </>
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
      transition(() => navigate({
        to: "/credentials/add/builtin/$provider/verify",
        params: { provider },
        search: true,
      }));
    },
  });

  return (
    // 表单包住正文和页脚:提交按钮留在页脚里,回车提交和按钮提交仍是同一条路径。
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={metadata.isPending || preview.isPending}
      onSubmit={(event) => { event.preventDefault(); preview.mutate(); }}
    >
      <SetupBody>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">填写凭据并发现模型</h2>
          <p className="font-mono text-base text-text-muted">{provider}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Text as="label" htmlFor="setup-builtin-credential" size="2" weight="medium" color="gray">模型凭据</Text>
          <TextField.Root
            id="setup-builtin-credential"
            type="password"
            size={{ initial: "3", sm: "2" }}
            className="w-full min-w-0 max-sm:min-h-11"
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
          <p className="text-base text-text-muted">只留在当前页面内存；不会写入 URL、浏览器存储或服务端草稿。</p>
        </div>
        {preview.error === null ? null : (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{preview.error.message}</Callout.Text>
          </Callout.Root>
        )}
        {metadata.isError ? (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>模型服务状态加载失败：{(metadata.error as Error).message}</Callout.Text>
          </Callout.Root>
        ) : metadata.isSuccess && metadata.data === undefined ? (
          <p role="alert" className="text-danger">Pi 没有内置 provider {provider}。</p>
        ) : null}
      </SetupBody>
      <SetupFooter note={phase === "discovering" ? "阶段 2/3：正在请求模型目录" : undefined}>
        <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
          <Link to="/credentials/add" search={true}>返回选择来源</Link>
        </Button>
        <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={phase !== null || credential === "" || metadata.data === undefined}>
          {phase === "discovering" ? "正在发现模型…" : "发现模型"}
        </Button>
      </SetupFooter>
    </form>
  );
}

/**
 * 发现结果清单。它只呈现这一次发现拿回来的 model id 与显示名——预览响应里没有上下文
 * 窗口和单价,所以设计稿那两栏元信息在这里不画,不拿运行基线的数字冒充发现结果。
 * 选中行跟着验证模型走:验证模型是在下面的组合框里选的,这里只做回显。
 */
function DiscoveredModels({
  models,
  selected,
}: {
  models: BuiltinPreview["models"];
  selected: string;
}) {
  if (models.length === 0) return null;
  return (
    <div className="flex max-h-64 flex-col overflow-x-hidden overflow-y-auto rounded-lg border border-overlay-line">
      {models.map((model) => {
        const active = model.id === selected.trim();
        return (
          <div
            key={model.identity}
            className={cn(
              "flex items-center gap-3 border-t border-line px-4 py-[11px] first:border-t-0",
              active && "bg-accent-tint",
            )}
          >
            {active ? (
              <CheckIcon aria-label="当前验证模型" className="size-3.5 shrink-0 text-primary" />
            ) : (
              <span aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 break-all font-mono text-base">{model.id}</span>
            {model.fields.name === undefined ? null : (
              <span className="shrink-0 text-sm text-text-muted">{model.fields.name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function BuiltinServiceVerifyPage({ provider }: { provider: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { candidate, setCandidate, phase, setPhase, finish } = useModelServiceSetup();
  const ready = candidate?.kind === "builtin" && candidate.provider === provider && candidate.preview !== null && candidate.credential !== "";
  const commit = useMutation({
    mutationFn: async () => {
      if (!ready) throw new Error("配置已过期，请重新配置模型服务。");
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
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      finish();
      void navigate({ to: "/credentials/$provider", params: { provider } });
    },
  });

  if (!ready) {
    return (
      <SetupExpired>
        <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
          <Link to="/credentials/add/builtin/$provider/discover" params={{ provider }} search={true}>
            返回模型发现
          </Link>
        </Button>
      </SetupExpired>
    );
  }
  const activeCandidate = candidate!;
  const activePreview = activeCandidate.preview!;

  return (
    <>
      <SetupBody>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">选择验证模型</h2>
          <p className="text-text-secondary">
            预览发现 <span className="font-mono tabular-nums">{activePreview.models.length}</span> 个模型；最终提交会重新发现并执行最小真实推理。
          </p>
        </div>
        <DiscoveredModels models={activePreview.models} selected={activeCandidate.validationModel} />
        <div className="flex flex-col gap-1.5">
          <EditableModelCombobox
            label="验证模型"
            value={activeCandidate.validationModel}
            disabled={phase !== null}
            candidates={activePreview.models.map((model) => ({
              id: model.id,
              name: model.fields.name ?? null,
            }))}
            onChange={(validationModel) => setCandidate({ ...activeCandidate, validationModel })}
          />
          <p className="text-base text-text-muted">目录里没有目标模型时可手填 model id；真实推理成功后会加入手动来源。</p>
        </div>
        {commit.error === null ? null : (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{commit.error.message}</Callout.Text>
          </Callout.Root>
        )}
      </SetupBody>
      <SetupFooter note={phase === "committing" ? "阶段 3/3：重新发现目录并执行真实推理" : undefined}>
        <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
          <Link to="/credentials/add/builtin/$provider/discover" params={{ provider }} search={true}>返回模型发现</Link>
        </Button>
        <Button
          type="button"
          variant="solid"
          size={{ initial: "4", sm: "2" }}
          disabled={phase !== null || activeCandidate.validationModel.trim() === ""}
          onClick={() => commit.mutate()}
        >
          {phase === "committing"
            ? "正在重新发现并验证…"
            : activeCandidate.version === null
              ? "验证并创建模型服务"
              : "验证并更新模型服务"}
        </Button>
      </SetupFooter>
    </>
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
  const { candidate, setCandidate, phase, setPhase, transition, requestClose } = useModelServiceSetup();
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
          search: true,
        }));
      } else {
        transition(() => navigate({ to: "/credentials/add/custom/verify", search: true }));
      }
    },
  });
  const update = (change: Partial<CustomSetupCandidate>): void => {
    setCandidate({ ...active, ...change, preview: null, discoveryError: null });
    preview.reset();
  };

  if (editing && serviceQuery.isPending) return (
    <SetupBody role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">正在加载自定义模型服务</span>
      <Skeleton className="h-64" />
    </SetupBody>
  );
  if (editing && service === undefined) {
    return (
      <SetupBody>
        <CardShell className="gap-1.5 px-4 py-4 sm:px-5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">自定义模型服务不存在</h2>
          <p className="text-text-secondary">此稳定地址对应的 provider 已删除或当前不可见。</p>
          <div className="pt-1.5">
            <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
              <Link to="/credentials">返回模型服务</Link>
            </Button>
          </div>
        </CardShell>
      </SetupBody>
    );
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={preview.isPending}
      onSubmit={(event) => { event.preventDefault(); preview.mutate(); }}
    >
      <SetupBody>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">配置调用目标并发现模型</h2>
          <p className="text-text-secondary">发现阶段不需要验证模型；目录失败后仍可手填 model id 进入真实验证。</p>
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Text as="label" htmlFor="setup-custom-provider" size="2" weight="medium" color="gray">provider</Text>
            <TextField.Root
              id="setup-custom-provider"
              size={{ initial: "3", sm: "2" }}
              className="w-full min-w-0 font-mono max-sm:min-h-11"
              value={active.provider}
              required
              disabled={phase !== null || editing}
              maxLength={64}
              onChange={(event) => update({ provider: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Text as="label" htmlFor="setup-custom-base-url" size="2" weight="medium" color="gray">调用目标</Text>
            <TextField.Root
              id="setup-custom-base-url"
              size={{ initial: "3", sm: "2" }}
              className="w-full min-w-0 font-mono max-sm:min-h-11"
              type="url"
              value={active.baseUrl}
              required
              disabled={phase !== null}
              placeholder="https://gateway.example/v1"
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Text as="label" htmlFor="setup-custom-protocol" size="2" weight="medium" color="gray">接口协议</Text>
            <Select.Root
              size={{ initial: "3", sm: "2" }}
              value={active.api}
              disabled={phase !== null}
              onValueChange={(value) => update({ api: value as CustomProtocol })}
            >
              <Select.Trigger id="setup-custom-protocol" className="w-full min-w-0 max-sm:min-h-11" />
              <Select.Content position="popper" color="gray">
                <Select.Item value="openai-completions">{CUSTOM_PROTOCOL_LABEL["openai-completions"]}</Select.Item>
                <Select.Item value="openai-responses">{CUSTOM_PROTOCOL_LABEL["openai-responses"]}</Select.Item>
              </Select.Content>
            </Select.Root>
          </div>
          <div className="flex flex-col gap-1.5">
            <Text as="label" htmlFor="setup-custom-credential" size="2" weight="medium" color="gray">模型凭据</Text>
            <TextField.Root
              id="setup-custom-credential"
              type="password"
              size={{ initial: "3", sm: "2" }}
              className="w-full min-w-0 max-sm:min-h-11"
              autoComplete="off"
              value={active.credential}
              required
              disabled={phase !== null}
              onChange={(event) => update({ credential: event.target.value })}
            />
          </div>
        </div>
        {!targetChanged || supplementModels.length === 0 ? null : (
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="text-md font-semibold text-text-secondary">重新确认带入新目标的模型</legend>
            <p className="text-base text-text-muted">地址或协议变化后，只带入你确认的旧模型来源。</p>
            {/* 勾选行整行可点:复选框只有 15px,单靠它命中在触摸屏上必然误点。 */}
            <div className="mt-1 flex flex-col overflow-hidden rounded-lg border border-overlay-line">
              {supplementModels.map((model) => {
                const checked = active.reconfirmedSupplements.includes(model.identity);
                return (
                  <Text
                    as="label"
                    size="2"
                    key={model.identity}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-3 border-t border-line px-4 py-[11px] first:border-t-0 sm:min-h-0",
                      checked && "bg-accent-tint",
                    )}
                  >
                    <Checkbox
                      size="2"
                      checked={checked}
                      disabled={phase !== null}
                      onCheckedChange={(next) => update({
                        reconfirmedSupplements: next === true
                          ? [...active.reconfirmedSupplements, model.identity]
                          : active.reconfirmedSupplements.filter((identity) => identity !== model.identity),
                      })}
                    />
                    <span className="min-w-0 flex-1 break-all font-mono text-base">{model.identity}</span>
                  </Text>
                );
              })}
            </div>
          </fieldset>
        )}
        {preview.error === null ? null : (
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{preview.error.message}</Callout.Text>
          </Callout.Root>
        )}
      </SetupBody>
      <SetupFooter note={phase === "discovering" ? "阶段 2/3：正在请求模型目录" : undefined}>
        <Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }} onClick={requestClose}>返回</Button>
        <Button
          type="submit"
          variant="solid"
          size={{ initial: "4", sm: "2" }}
          disabled={phase !== null || active.provider.trim() === "" || active.baseUrl.trim() === "" || active.credential === ""}
        >
          {phase === "discovering" ? "正在发现模型…" : "发现模型"}
        </Button>
      </SetupFooter>
    </form>
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
      if (active === null) throw new Error("配置已过期，请重新配置模型服务。");
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
      const committedProvider = active!.provider;
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
      finish();
      void navigate({ to: "/credentials/$provider", params: { provider: committedProvider } });
    },
  });

  if (active === null) {
    return (
      <SetupExpired>
        <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
          {provider === undefined
            ? <Link to="/credentials/add/custom/discover" search={true}>返回模型发现</Link>
            : <Link to="/credentials/add/custom/$provider/discover" params={{ provider }} search={true}>返回模型发现</Link>}
        </Button>
      </SetupExpired>
    );
  }

  return (
    <>
      <SetupBody>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">选择或手填验证模型</h2>
          <p className="text-text-secondary">
            {active.preview === null
              ? `模型发现未完成：${active.discoveryError}`
              : `模型发现得到 ${active.preview.models.length} 个模型。`}
            最终提交会重新发现并执行最小真实推理。
          </p>
        </div>
        {active.preview === null ? null : (
          <DiscoveredModels models={active.preview.models} selected={active.validationModel} />
        )}
        <div className="flex flex-col gap-1.5">
          <EditableModelCombobox
            label="验证模型"
            value={active.validationModel}
            disabled={phase !== null}
            candidates={(active.preview?.models ?? []).map((model) => ({
              id: model.id,
              name: model.fields.name ?? null,
            }))}
            onChange={(validationModel) => setCandidate({ ...active, validationModel })}
          />
          <p className="text-base text-text-muted">目录缺少目标模型时可手填；真实推理成功后会加入手动来源。</p>
        </div>
        {commit.error === null ? null : (
          <div className="flex flex-col gap-2">
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{commit.error.message}</Callout.Text>
            </Callout.Root>
            <ReferenceBlockers references={(commit.error as ModelServiceMutationError).references} />
          </div>
        )}
      </SetupBody>
      <SetupFooter note={phase === "committing" ? "阶段 3/3：重新发现目录并执行真实推理" : undefined}>
        <Button asChild variant="outline" color="gray" size={{ initial: "4", sm: "2" }}>
          {provider === undefined
            ? <Link to="/credentials/add/custom/discover" search={true}>返回模型发现</Link>
            : <Link to="/credentials/add/custom/$provider/discover" params={{ provider }} search={true}>返回模型发现</Link>}
        </Button>
        <Button
          type="button"
          variant="solid"
          size={{ initial: "4", sm: "2" }}
          disabled={phase !== null || active.validationModel.trim() === ""}
          onClick={() => commit.mutate()}
        >
          {phase === "committing" ? "正在重新发现并验证…" : active.version === null ? "验证并创建" : "验证并更新"}
        </Button>
      </SetupFooter>
    </>
  );
}

/**
 * 概览的三张状态卡:服务、凭据、目录。设计稿只画了凭据卡,另外两张沿用同一张卡的骨架
 * ——卡头放语义徽章,卡身放三列信息。字段按权限缺席时整块换成一句说明,不留空格子。
 */
function StateRows({ service, canReadCredential }: { service: ModelService; canReadCredential: boolean }) {
  const providerLabel =
    service.providerState === "name-conflict"
      ? "名字冲突，已停用"
      : service.providerState === "normal"
        ? "正常"
        : HEALTH_LABEL[service.health];
  const providerTone: StatusTone = service.providerState === "name-conflict"
    ? "error"
    : service.providerState === "normal"
      ? "success"
      : service.health === "healthy"
        ? "success"
        : service.health === "attention"
          ? "warning"
          : "error";
  const credentialTone: StatusTone = service.credential.state === "verified" ? "success" : "warning";
  const directoryTone: StatusTone | null = service.directory === undefined
    ? null
    : service.directory.state === "available"
      ? "success"
      : service.directory.state === "refresh-failed"
        ? "warning"
        : "error";
  return (
    <>
      <CardShell aria-labelledby={`service-state-${service.provider}`}>
        <CardHeader
          id={`service-state-${service.provider}`}
          title="模型服务"
          action={<StatusBadge tone={providerTone}>{providerLabel}</StatusBadge>}
        />
        <CardSection>
          {service.target === undefined ? (
            <p className="text-base text-text-muted">地址与接口协议按模型读权限隐藏。</p>
          ) : (
            <InfoGrid>
              <InfoField label="调用目标"><MonoValue value={service.target.baseUrl} /></InfoField>
              <InfoField label="接口协议">
                {service.type === "custom" && (
                  service.target.api === "openai-completions" || service.target.api === "openai-responses"
                ) ? CUSTOM_PROTOCOL_LABEL[service.target.api] : <MonoValue value={service.target.api} />}
              </InfoField>
            </InfoGrid>
          )}
        </CardSection>
      </CardShell>

      <CardShell aria-labelledby={`credential-state-${service.provider}`}>
        <CardHeader
          id={`credential-state-${service.provider}`}
          title="模型凭据"
          action={<StatusBadge tone={credentialTone}>{CREDENTIAL_LABEL[service.credential.state]}</StatusBadge>}
        />
        <CardSection>
          {canReadCredential ? (
            <InfoGrid>
              <InfoField label="尾 4 位">
                {service.credential.last4 === null || service.credential.last4 === undefined
                  ? <span className="text-text-muted">未提供</span>
                  : <span className="font-mono text-base tabular-nums">{service.credential.last4}</span>}
              </InfoField>
              {/* 时间戳走比例字:等宽把「2026-08-24 08:15」拉成一条比 model id 还长的格栅。 */}
              <InfoField label="更新"><span className="tabular-nums">{localMinute(service.credential.updatedAt)}</span></InfoField>
              <InfoField label="上次验证"><span className="tabular-nums">{localMinute(service.credential.verifiedAt)}</span></InfoField>
              <InfoField label="验证模型">
                <span className="block max-w-full overflow-x-auto whitespace-nowrap">
                  <MonoValue value={service.credential.validationModel} />
                </span>
              </InfoField>
              <InfoField label="验证方式">
                {service.credential.verificationSource === null || service.credential.verificationSource === undefined
                  ? <span className="text-text-muted">未提供</span>
                  : VERIFICATION_LABEL[service.credential.verificationSource]}
              </InfoField>
            </InfoGrid>
          ) : (
            <p className="text-base text-text-muted">尾四位、更新时间与验证记录按权限隐藏。</p>
          )}
        </CardSection>
      </CardShell>

      {service.directory === undefined ? null : (
        <CardShell aria-labelledby={`directory-state-${service.provider}`}>
          <CardHeader
            id={`directory-state-${service.provider}`}
            title="模型目录"
            action={<StatusBadge tone={directoryTone ?? "neutral"}>{DIRECTORY_LABEL[service.directory.state]}</StatusBadge>}
          />
          <CardSection>
            <InfoGrid>
              <InfoField label="最近尝试"><span className="tabular-nums">{localMinute(service.directory.lastAttemptAt)}</span></InfoField>
              <InfoField label="最近成功"><span className="tabular-nums">{localMinute(service.directory.lastSuccessAt)}</span></InfoField>
              {service.directory.ignoredModelCount > 0 ? (
                <InfoField label="忽略无效项">
                  <span className="font-mono tabular-nums">{service.directory.ignoredModelCount}</span>
                </InfoField>
              ) : null}
            </InfoGrid>
          </CardSection>
        </CardShell>
      )}
    </>
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
  const dialogFocus = useDialogReturnFocus(modelServiceStableFocus);
  const deleteFocus = useDialogReturnFocus(modelServiceStableFocus);
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
      void queryClient.invalidateQueries({ queryKey: ["model-services"] }).then(() => {
        deleteFocus.restoreFocus();
      });
      if (dialog) onClose?.();
    },
  });

  const maintenanceForm = (
    <form
      className={cn("flex flex-col gap-2.5", !dialog && "border-t border-line px-4 pt-3.5 pb-4 sm:px-5")}
      onSubmit={(event) => {
        event.preventDefault();
        setFeedback(null);
        reverify.mutate();
      }}
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
        <EditableModelCombobox
          label="重新验证使用的 model id"
          value={validationModel}
          disabled={reverify.isPending}
          candidates={target.models?.map((model) => ({
            id: model.id,
            name: model.discovery.name,
          }))}
          onChange={(modelId) => {
            setValidationModel(modelId);
            setFeedback(null);
            reverify.reset();
          }}
        />
        <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={reverify.isPending || validationModel.trim() === ""}>
          {reverify.isPending ? "正在验证…" : "重新验证"}
        </Button>
        <Button
          type="button"
          variant="solid"
          color="red"
          size={{ initial: "4", sm: "2" }}
          disabled={reverify.isPending}
          onClick={(event) => {
            deleteFocus.captureTrigger(event);
            setFeedback(null);
            removeCredential.reset();
            setConfirmingDelete(true);
          }}
        >
          <TrashIcon />删除凭据
        </Button>
      </div>
      <p className="text-base text-text-muted">可从自动发现的模型中选择，也可手填目录外的 model id；提交时会重新发现目录并执行一次最小真实推理。</p>
      {feedback === null ? null : (
        <Callout.Root
          role={feedback.error ? "alert" : "status"}
          color={feedback.error ? "red" : "green"}
          size="1"
        >
          <Callout.Icon>
            {feedback.error ? <CrossCircledIcon aria-hidden /> : <CheckIcon aria-hidden />}
          </Callout.Icon>
          <Callout.Text>{feedback.text}</Callout.Text>
        </Callout.Root>
      )}
    </form>
  );

  const deleteError = removeCredential.error;
  const deleteConfirmation = (
    <>
      <AlertDialog.Title size="6" mb="2" className="break-words font-extrabold tracking-[-0.02em]">删除 {target.provider} 的模型凭据？</AlertDialog.Title>
      <AlertDialog.Description size="2" color="gray">
        模型目录会保留，但没有凭据时模型不能运行。若全局组合或仓库仍在引用这家 provider，服务会拒绝删除并列出位置。
      </AlertDialog.Description>
      {deleteError === null ? null : (
        <div className="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto">
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{deleteError.message}</Callout.Text>
          </Callout.Root>
          <ReferenceBlockers references={deleteError.references} />
        </div>
      )}
      <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }} className="shrink-0">
        <AlertDialog.Cancel><Button
          type="button"
          variant="outline"
          color="gray"
          size={{ initial: "4", sm: "2" }}
          disabled={removeCredential.isPending}
        >
          取消
        </Button></AlertDialog.Cancel>
        <Button
          type="button"
          variant="solid"
          color="red"
          size={{ initial: "4", sm: "2" }}
          disabled={removeCredential.isPending}
          onClick={() => removeCredential.mutate()}
        >
          {removeCredential.isPending ? "正在删除…" : "确认删除凭据"}
        </Button>
      </Flex>
    </>
  );

  if (dialog) {
    return (
      <>
        <Dialog.Root open onOpenChange={(open) => { if (!open) onClose?.(); }}>
          <Dialog.Content
            maxWidth="640px"
            maxHeight="calc(100dvh - 2rem)"
            size={{ initial: "2", sm: "3" }}
            className="rounded-2xl shadow-modal sm:rounded-3xl"
            onCloseAutoFocus={dialogFocus.onCloseAutoFocus}
          >
            <div className="pr-9">
              <Dialog.Title size="6" mb="2" className="break-words font-extrabold tracking-[-0.02em]">维护 {target.provider} 的模型凭据</Dialog.Title>
              <Dialog.Description size="2" color="gray">重新验证使用已存凭据，凭据与已存验证记录不会回到浏览器。</Dialog.Description>
            </div>
            <div className="mt-4">{maintenanceForm}</div>
            <div className="absolute top-3 right-3">
              <Tooltip content="关闭凭据维护">
                <Dialog.Close>
                  <IconButton
                    variant="soft"
                    color="gray"
                    radius="full"
                    size={{ initial: "3", sm: "2" }}
                    className="max-sm:min-h-11 max-sm:min-w-11"
                    aria-label="关闭凭据维护"
                  >
                    <Cross2Icon aria-hidden />
                  </IconButton>
                </Dialog.Close>
              </Tooltip>
            </div>
          </Dialog.Content>
        </Dialog.Root>
        <AlertDialog.Root
          open={confirmingDelete}
          onOpenChange={(open) => {
            setConfirmingDelete(open);
            if (!open) removeCredential.reset();
          }}
        >
          <AlertDialog.Content
            maxWidth="520px"
            maxHeight="calc(100dvh - 2rem)"
            size={{ initial: "2", sm: "3" }}
            className="flex min-h-0 flex-col overflow-hidden rounded-2xl shadow-modal sm:rounded-3xl"
            onCloseAutoFocus={deleteFocus.onCloseAutoFocus}
          >
            {deleteConfirmation}
          </AlertDialog.Content>
        </AlertDialog.Root>
      </>
    );
  }

  return (
    <CardShell className="overflow-hidden" aria-labelledby={`credential-actions-${target.provider}`}>
      <CardHeader
        id={`credential-actions-${target.provider}`}
        title="凭据维护"
        help={<HelpTooltip label="凭据维护说明" content="重新验证会使用已保存的凭据，凭据不会回到浏览器。" />}
      />
      {maintenanceForm}
      <AlertDialog.Root
        open={confirmingDelete}
        onOpenChange={(open) => {
          setConfirmingDelete(open);
          if (!open) removeCredential.reset();
        }}
      >
        <AlertDialog.Content
          maxWidth="520px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={deleteFocus.onCloseAutoFocus}
        >
          {deleteConfirmation}
        </AlertDialog.Content>
      </AlertDialog.Root>
    </CardShell>
  );
}

/** 引用阻塞清单。它总是跟在一条红色 Callout 后面,所以自己只做「先去哪儿删」的清单。 */
function ReferenceBlockers({ references }: { references: ModelReference[] }) {
  if (references.length === 0) return null;
  return (
    <section className="rounded-lg border border-danger/20 bg-danger-tint px-4 py-3.5">
      <div className="flex items-center gap-2 text-danger">
        <ExclamationTriangleIcon className="size-4 shrink-0" aria-hidden />
        <p className="font-semibold">引用阻塞：先移除下面这些模型引用</p>
      </div>
      <p className="mt-1 text-base text-text-muted">
        到审查策略或对应仓库覆盖里移除引用，再回来重试当前操作。
      </p>
      <ul className="mt-3 flex flex-col overflow-hidden rounded-md border border-card-line bg-surface">
        {references.map((reference) => (
          <li key={reference.identity} className="border-t border-line px-3 py-2 first:border-t-0">
            <p className="break-all font-mono text-base font-medium">{reference.identity}</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-base text-text-muted">
              {reference.locations.map((location, index) => (
                <li key={`${reference.identity}:${index}`}>
                  {location.kind === "global" ? (
                    <Link
                      to="/settings"
                      search={{ provider: reference.identity.split(":", 1)[0] }}
                      className="text-primary underline underline-offset-4"
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
    </section>
  );
}

function CustomServiceControls({
  service,
  onModify,
}: {
  service: ModelService;
  onModify: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newProvider, setNewProvider] = useState("");
  const renameFocus = useDialogReturnFocus(modelServiceStableFocus);
  const deleteFocus = useDialogReturnFocus(modelServiceStableFocus);
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
      void queryClient.invalidateQueries({ queryKey: ["model-services"] }).then(() => {
        deleteFocus.restoreFocus();
      });
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
      setNewProvider("");
      await queryClient.invalidateQueries({ queryKey: ["model-services"] });
      await navigate({
        to: "/credentials/$provider/maintenance",
        params: { provider: result.provider },
      });
      renameFocus.restoreFocus();
    },
  });
  const openRename = (): void => {
    setNewProvider("");
    renameService.reset();
    setRenaming(true);
  };
  const closeRename = (): void => {
    setRenaming(false);
    setNewProvider("");
    renameService.reset();
  };
  return (
    <CardShell aria-labelledby={`custom-actions-${service.provider}`}>
      <CardHeader
        id={`custom-actions-${service.provider}`}
        title="服务配置"
        help={<HelpTooltip label="服务配置说明" content="新配置验证成功前，当前版本与已有模型来源保持不动。" />}
        action={
          <div className="flex flex-wrap gap-2.5">
            {service.providerState !== "name-conflict" ? null : (
              <Button
                type="button"
                variant="outline"
                color="gray"
                size={{ initial: "4", sm: "2" }}
                onClick={(event) => {
                  renameFocus.captureTrigger(event);
                  openRename();
                }}
              >
                迁移到新名称
              </Button>
            )}
            {service.providerState === "name-conflict" ? null : (
              <Button
                id={`configure-custom-${service.provider}`}
                type="button"
                variant="outline"
                color="gray"
                size={{ initial: "4", sm: "2" }}
                onClick={onModify}
              >
                修改配置
              </Button>
            )}
            <Button
              type="button"
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              onClick={(event) => {
                deleteFocus.captureTrigger(event);
                setConfirmingDelete(true);
              }}
            >
              <TrashIcon />删除服务
            </Button>
          </div>
        }
      />
      <Dialog.Root
        open={renaming}
        onOpenChange={(open) => {
          if (!open) closeRename();
        }}
      >
        <Dialog.Content
          maxWidth="520px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={renameFocus.onCloseAutoFocus}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              renameService.mutate();
            }}
          >
            <div className="pr-9">
              <Dialog.Title size="6" mb="2" className="break-words font-extrabold tracking-[-0.02em]">迁移 {service.provider} 到新名称</Dialog.Title>
              <Dialog.Description size="2" color="gray">
                服务、全局模型组合与全部仓库覆盖会在一个事务中改名。model id 与历史审查记录保持不变。
              </Dialog.Description>
            </div>
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor={`rename-provider-${service.provider}`} size="2" weight="medium" color="gray">新 provider</Text>
              <TextField.Root
                id={`rename-provider-${service.provider}`}
                size={{ initial: "3", sm: "2" }}
                className="w-full min-w-0 font-mono max-sm:min-h-11"
                value={newProvider}
                required
                disabled={renameService.isPending}
                onChange={(event) => {
                  setNewProvider(event.target.value);
                  renameService.reset();
                }}
              />
              <p className="text-base text-text-muted">使用 1–64 位小写字母、数字或连字符。</p>
            </div>
            {renameService.error === null ? null : (
              <div className="flex flex-col gap-2">
                <p role="alert" className="text-danger">{renameService.error.message}</p>
                <ReferenceBlockers references={renameService.error.references} />
              </div>
            )}
            <Flex gap="3" justify="end" direction={{ initial: "column-reverse", sm: "row" }}>
              <Dialog.Close><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }} disabled={renameService.isPending}>
                取消
              </Button></Dialog.Close>
              <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={renameService.isPending || newProvider.trim() === ""}>
                {renameService.isPending ? "正在迁移…" : "确认迁移"}
              </Button>
            </Flex>
          </form>
          <div className="absolute top-3 right-3">
            <Tooltip content="关闭服务迁移">
              <Dialog.Close>
                <IconButton
                  variant="soft"
                  color="gray"
                  radius="full"
                  size={{ initial: "3", sm: "2" }}
                  className="max-sm:min-h-11 max-sm:min-w-11"
                  aria-label="关闭服务迁移"
                >
                  <Cross2Icon aria-hidden />
                </IconButton>
              </Dialog.Close>
            </Tooltip>
          </div>
        </Dialog.Content>
      </Dialog.Root>
      <AlertDialog.Root
        open={confirmingDelete}
        onOpenChange={(open) => {
          setConfirmingDelete(open);
          if (!open) removeService.reset();
        }}
      >
        <AlertDialog.Content
          maxWidth="520px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={deleteFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="6" mb="2" className="break-words font-extrabold tracking-[-0.02em]">删除 {service.provider}？</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            服务定义、加密凭据、当前目录与手动模型来源会在一个事务中删除；历史审查记录保留。仍被模型组合引用时不会删除。
          </AlertDialog.Description>
          {removeService.error === null ? null : (
            <div className="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto">
              <Callout.Root role="alert" color="red" size="1">
                <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                <Callout.Text>{removeService.error.message}</Callout.Text>
              </Callout.Root>
              <ReferenceBlockers references={removeService.error.references} />
            </div>
          )}
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }} className="shrink-0">
            <AlertDialog.Cancel><Button type="button" variant="outline" color="gray" size={{ initial: "4", sm: "2" }} disabled={removeService.isPending}>
              取消
            </Button></AlertDialog.Cancel>
            <Button type="button" variant="solid" color="red" size={{ initial: "4", sm: "2" }} disabled={removeService.isPending} onClick={() => removeService.mutate()}>
              {removeService.isPending ? "正在删除…" : "确认删除服务"}
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </CardShell>
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
  const inputId = `supplement-model-${service.provider}`;
  const deleteFocus = useDialogReturnFocus(() => document.getElementById(inputId));
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
      void queryClient.invalidateQueries({ queryKey: ["model-services"] }).then(() => {
        deleteFocus.restoreFocus();
      });
    },
  });
  const supplementalModels = (service.models ?? []).filter((entry) =>
    entry.sources.includes("manual") || entry.sources.includes("migration-retention"),
  );
  const canValidate =
    service.providerState !== "name-conflict" && service.credential.state === "verified";
  const busy = refresh.isPending || addSupplement.isPending || removeSupplement.isPending;
  const operationError = refresh.error ?? addSupplement.error;

  return (
    <CardShell aria-labelledby={`catalog-actions-${service.provider}`}>
      {section === "maintenance" ? <>
        <CardHeader
          id={`catalog-actions-${service.provider}`}
          title="模型目录"
          help={<HelpTooltip label="模型目录说明" content="刷新只替换自动发现的目录；刷新失败时保留最近一次成功的结果。" />}
          action={
            <Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "2" }}
              disabled={busy || !canValidate}
              onClick={() => {
                addSupplement.reset();
                refresh.mutate();
              }}
            >
              <ReloadIcon className={cn(refresh.isPending && "animate-spin")} />
              {refresh.isPending ? "正在刷新…" : "刷新自动目录"}
            </Button>
          }
        />
        {refresh.error === null ? null : (
          <CardSection>
            <Callout.Root role="alert" color="red" size="1">
              <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
              <Callout.Text>{refresh.error.message}</Callout.Text>
            </Callout.Root>
          </CardSection>
        )}
      </> : null}

      {section === "models" ? <><form
        className="flex flex-col gap-1.5 px-4 pt-3.5 pb-4 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          const submittedModel = model.trim();
          if (submittedModel === "") return;
          refresh.reset();
          addSupplement.mutate(submittedModel);
        }}
      >
        <div className="flex items-center gap-1.5">
          {/* label 兼作这张卡的可访问名称:models 分支没有卡头,壳上的 aria-labelledby 指向它。 */}
          <Text as="label" id={`catalog-actions-${service.provider}`} htmlFor={inputId} size="2" weight="medium">手动添加模型</Text>
          <HelpTooltip label="手动添加模型说明" content="只需填写模型 ID。显示名、价格、上下文窗口和能力信息由目录或运行基线提供。" />
        </div>
        <div className="flex flex-col gap-2.5 sm:flex-row">
          <TextField.Root
            id={inputId}
            size={{ initial: "3", sm: "2" }}
            className="w-full min-w-0 font-mono max-sm:min-h-11"
            value={model}
            disabled={busy || !canValidate}
            placeholder="例如 gpt-5.2-codex"
            autoComplete="off"
            onChange={(event) => setModel(event.target.value)}
          />
          <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} disabled={busy || !canValidate || model.trim() === ""}>
            {addSupplement.isPending ? "正在验证…" : "验证并添加"}
          </Button>
        </div>
        {!canValidate ? (
          <p className="text-base text-warning">请先恢复正常 provider 并验证模型凭据。</p>
        ) : (
          <p className="text-base text-text-muted">价格、窗口、显示名与能力不能手工填写。</p>
        )}
        {operationError === null ? null : (
          <Callout.Root role="alert" color="red" size="1" className="mt-1.5">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{operationError.message}</Callout.Text>
          </Callout.Root>
        )}
      </form>

      <CardSection className="py-0">
        <p className="py-3.5 text-base font-medium text-text-muted">
          当前手动来源 · {service.models === undefined ? (
            "按模型读权限隐藏"
          ) : (
            <span className="font-mono tabular-nums">{supplementalModels.length}</span>
          )}
        </p>
        {service.models === undefined ? (
          <p className="pb-3.5 text-text-muted">已有来源清单不可见；手动添加和刷新仍由服务端校验。</p>
        ) : supplementalModels.length === 0 ? (
          <EmptyState title="没有手动添加或迁移保留的模型来源" className="pt-0 pb-3.5" />
        ) : (
          <ul className="mb-3.5 flex flex-col overflow-hidden rounded-md border border-card-line">
            {supplementalModels.map((entry) => {
              const source = entry.sources.includes("manual") ? "manual" : "migration-retention";
              return (
                <li
                  key={entry.identity}
                  className="flex flex-wrap items-center gap-2.5 border-t border-line px-3 py-2.5 first:border-t-0"
                >
                  <span className="min-w-0 flex-1 break-all font-mono text-base">{entry.identity}</span>
                  <SourceBadge>{SOURCE_LABEL[source]}</SourceBadge>
                  <Button
                    type="button"
                    variant="outline"
                    color="gray"
                    size={{ initial: "4", sm: "1" }}
                    disabled={busy}
                    onClick={(event) => {
                      deleteFocus.captureTrigger(event);
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
      </CardSection>

      <AlertDialog.Root
        open={deleting !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDeleting(null);
          removeSupplement.reset();
        }}
      >
        <AlertDialog.Content
          maxWidth="520px"
          maxHeight="calc(100dvh - 2rem)"
          size={{ initial: "2", sm: "3" }}
          className="flex min-h-0 flex-col overflow-hidden rounded-2xl shadow-modal sm:rounded-3xl"
          onCloseAutoFocus={deleteFocus.onCloseAutoFocus}
        >
          <AlertDialog.Title size="6" mb="2" className="break-words font-extrabold tracking-[-0.02em]">删除 {deleting?.identity} 的手动来源？</AlertDialog.Title>
          <AlertDialog.Description size="2" color="gray">
            {deleting?.sources.includes("automatic")
              ? "自动发现来源仍会保留，这个模型不会从清单消失。"
              : "这是当前唯一来源；仍被模型组合引用时，服务端会阻止删除并列出位置。"}
          </AlertDialog.Description>
          {removeSupplement.error === null ? null : (
            <div className="mt-4 flex min-h-0 flex-col gap-2 overflow-y-auto">
              <Callout.Root role="alert" color="red" size="1">
                <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                <Callout.Text>{removeSupplement.error.message}</Callout.Text>
              </Callout.Root>
              <ReferenceBlockers references={removeSupplement.error.references} />
            </div>
          )}
          <Flex gap="3" mt="4" justify="end" direction={{ initial: "column-reverse", sm: "row" }} className="shrink-0">
            <AlertDialog.Cancel><Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "2" }}
              disabled={removeSupplement.isPending}
            >
              取消
            </Button></AlertDialog.Cancel>
            <Button
              type="button"
              variant="solid"
              color="red"
              size={{ initial: "4", sm: "2" }}
              disabled={removeSupplement.isPending || deleting === null}
              onClick={() => {
                if (deleting !== null) removeSupplement.mutate(deleting.id);
              }}
            >
              <TrashIcon />{removeSupplement.isPending ? "正在删除…" : "确认删除来源"}
            </Button>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root></> : null}
    </CardShell>
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
        ? "预置目录"
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

const MODEL_ROWS_PAGE_SIZE = 40;

function ModelsTable({
  service,
  models,
  canWriteModels,
}: {
  service: ModelService;
  models: readonly ModelServiceModel[];
  canWriteModels: boolean;
}) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [feedback, setFeedback] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(MODEL_ROWS_PAGE_SIZE);
  const queryClient = useQueryClient();
  const normalizedSearch = search.trim().toLowerCase();
  const filteredModels = useMemo(() => {
    if (normalizedSearch === "") return models;
    const terms = normalizedSearch.split(/\s+/);
    return models.filter((model) => {
      const haystack = [model.discovery.name ?? "", model.identity].join(" ").toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });
  }, [models, normalizedSearch]);
  const visibleModels = filteredModels.slice(0, visibleCount);
  const remainingModels = filteredModels.length - visibleModels.length;

  useEffect(() => {
    setVisibleCount(MODEL_ROWS_PAGE_SIZE);
  }, [models, normalizedSearch]);

  useEffect(() => {
    const availableIds = new Set(models.map((model) => model.identity));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((identity) => availableIds.has(identity)));
      return next.size === current.size ? current : next;
    });
  }, [models]);

  const updateState = useMutation<{ updated: number; enabled: boolean }, ModelServiceMutationError, boolean>({
    mutationFn: async (enabled) => responseJsonWithReferences(
      await api(`/model-services/${encodeURIComponent(service.provider)}/model-states`, {
        method: "PUT",
        body: JSON.stringify({
          models: [...selectedIds].map((identity) => identity.slice(service.provider.length + 1)),
          expectedVersion: service.version,
          enabled,
        }),
      }),
    ),
    onSuccess: (result) => {
      setSelectedIds(new Set());
      setFeedback(`${result.enabled ? "已启用" : "已停用"} ${result.updated} 个模型。`);
      void queryClient.invalidateQueries({ queryKey: ["model-services"] });
    },
  });

  const allFilteredSelected = filteredModels.length > 0 && filteredModels.every((model) => selectedIds.has(model.identity));
  const someFilteredSelected = filteredModels.some((model) => selectedIds.has(model.identity));
  const toggleAllFiltered = (): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) filteredModels.forEach((model) => next.delete(model.identity));
      else filteredModels.forEach((model) => next.add(model.identity));
      return next;
    });
    setFeedback(null);
    updateState.reset();
  };
  const toggleSelected = (identity: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
    setFeedback(null);
    updateState.reset();
  };

  if (models.length === 0) {
    return (
      <CardShell>
        <EmptyState
          title="还没有可用模型"
          titleAs="h3"
          description="模型目录尚未成功发现，也没有手动添加或迁移保留的模型。"
          className="px-4 py-8 sm:px-5"
        />
      </CardShell>
    );
  }
  return (
    <CardShell
      aria-label="模型列表"
      className="overflow-hidden"
      aria-busy={updateState.isPending}
    >
      <CardHeader
        title="模型目录"
        meta={
          <span aria-live="polite">
            {normalizedSearch === "" ? (
              <><span className="font-mono tabular-nums">{models.length}</span> 个模型</>
            ) : (
              <><span className="font-mono tabular-nums">{filteredModels.length}</span> / <span className="font-mono tabular-nums">{models.length}</span> 个模型</>
            )}
          </span>
        }
        action={
          <div className="w-full sm:w-64">
            <Text as="label" htmlFor="model-list-search" className="sr-only">筛选模型</Text>
            <TextField.Root
              id="model-list-search"
              size={{ initial: "3", sm: "2" }}
              className="w-full min-w-0 max-sm:min-h-11"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按名称或 model id 筛选"
            >
              <TextField.Slot side="left">
                <MagnifyingGlassIcon aria-hidden="true" />
              </TextField.Slot>
            </TextField.Root>
          </div>
        }
      />
      {canWriteModels ? (
        <CardSection className="flex flex-wrap items-center gap-2.5 py-2">
          <Text as="label" size="2" className="flex min-h-9 items-center gap-2">
            <Checkbox
              size="2"
              checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
              onCheckedChange={toggleAllFiltered}
              aria-label="全选当前筛选结果"
            />
            <span>全选当前结果</span>
          </Text>
          <span className="text-base text-text-muted" aria-live="polite">
            已选 <span className="font-mono tabular-nums">{selectedIds.size}</span> 个
          </span>
          <div className="ml-auto flex flex-wrap gap-2.5">
            <Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "1" }}
              disabled={selectedIds.size === 0 || updateState.isPending}
              onClick={() => updateState.mutate(true)}
            >
              启用所选
            </Button>
            <Button
              type="button"
              variant="outline"
              color="gray"
              size={{ initial: "4", sm: "1" }}
              disabled={selectedIds.size === 0 || updateState.isPending}
              onClick={() => updateState.mutate(false)}
            >
              停用所选
            </Button>
          </div>
        </CardSection>
      ) : null}
      {feedback === null ? null : (
        <CardSection>
          <Callout.Root role="status" color="green" size="1">
            <Callout.Icon><CheckIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{feedback}</Callout.Text>
          </Callout.Root>
        </CardSection>
      )}
      {updateState.error === null ? null : (
        <CardSection className="flex flex-col gap-2">
          <Callout.Root role="alert" color="red" size="1">
            <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
            <Callout.Text>{updateState.error.message}</Callout.Text>
          </Callout.Root>
          {updateState.error.references.length === 0 ? null : <ReferenceBlockers references={updateState.error.references} />}
        </CardSection>
      )}
      {filteredModels.length === 0 ? (
        <EmptyState
          title="没有匹配的模型"
          description="可以换一个名称或 model id。"
          className="border-t border-line px-4 py-8 sm:px-5"
        />
      ) : (
        // 不给模型清单开自己的滚动条:这一页整页跟外壳滚,再套一层内滚就是两条滚动条
        // 并存——外壳滚到底了,清单里还剩一大半没露出来。清单上面就是筛选框,长清单
        // 靠筛,不靠一个 640px 的窗口。
        <div className="flex flex-col">
          {/* 表头只在三列真正并排时出现:窄屏行内是纵向堆叠,一排列名对不上任何一列。 */}
          <div className={cn(
            "sticky top-0 z-10 hidden gap-3 border-t border-line bg-sunken px-5 py-2 text-sm font-bold text-text-muted xl:grid",
            MODEL_ROW_COLUMNS,
          )}>
            <div>模型</div>
            <div>运行规格</div>
            <div>状态</div>
          </div>
          {visibleModels.map((model) => (
            <article
              key={model.identity}
              className={cn(
                "grid gap-3 border-t border-line px-4 py-3 sm:px-5 xl:items-start",
                MODEL_ROW_COLUMNS,
                !model.available && model.unavailableReason !== "model-disabled" && "bg-danger-tint",
                model.unavailableReason === "model-disabled" && "bg-sunken",
              )}
            >
              <div className="flex min-w-0 items-start gap-2">
                {canWriteModels ? (
                  <Text
                    as="label"
                    size="2"
                    className="mt-0.5 inline-flex min-h-8 min-w-8 shrink-0 cursor-pointer items-start justify-center pt-0.5 max-sm:min-h-11 max-sm:min-w-11"
                  >
                    <Checkbox
                      size="2"
                      checked={selectedIds.has(model.identity)}
                      onCheckedChange={() => toggleSelected(model.identity)}
                      aria-label={`选择 ${model.identity}`}
                    />
                  </Text>
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="break-words font-medium">
                    {model.discovery.name ?? "未提供显示名"}
                  </p>
                  <p className="max-w-full overflow-x-auto whitespace-nowrap font-mono text-base text-text-muted">
                    {model.identity}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="sr-only">来源：</span>
                    {model.sources.map((source) => (
                      <SourceBadge key={source}>{SOURCE_LABEL[source]}</SourceBadge>
                    ))}
                  </p>
                </div>
              </div>
              <div className="min-w-0 max-xl:border-t max-xl:border-line max-xl:pt-2">
                <ModelRuntimeFacts model={model} />
                <ModelDiscoveryDifference model={model} />
              </div>
              <div className="min-w-0">
                <ModelAvailability model={model} />
              </div>
            </article>
          ))}
          {remainingModels > 0 ? (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-sunken px-4 py-3 sm:px-5">
              <p className="text-base text-text-muted" aria-live="polite">
                已显示 <span className="font-mono tabular-nums">{visibleModels.length}</span> /{" "}
                <span className="font-mono tabular-nums">{filteredModels.length}</span> 个
              </p>
              <Button
                type="button"
                variant="outline"
                color="gray"
                size={{ initial: "4", sm: "1" }}
                onClick={() => setVisibleCount((current) => current + MODEL_ROWS_PAGE_SIZE)}
              >
                再显示 {Math.min(MODEL_ROWS_PAGE_SIZE, remainingModels)} 个
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </CardShell>
  );
}

function ModelDiscoveryDifference({ model }: { model: ModelServiceModel }) {
  if (!discoveryDiffersFromRuntime(model)) return null;
  return (
    <Collapsible.Root className="group/discovery mt-2 text-base">
      <Collapsible.Trigger asChild>
        <Button type="button" variant="ghost" color="gray" size={{ initial: "3", sm: "1" }}>
          <ChevronDownIcon className="transition-transform group-data-[state=open]/discovery:rotate-180" aria-hidden />
          发现值与运行规格不同
        </Button>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="mt-2 flex flex-col gap-1 border-l border-line pl-3 text-text-muted">
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
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

function ModelRuntimeFacts({ model }: { model: ModelServiceModel }) {
  const sources = [...new Set(Object.values(model.runtime.sources).map(fieldSourceLabel))];
  return (
    <div className="flex flex-col gap-1 text-base">
      <p className="flex flex-wrap gap-x-3 gap-y-0.5">
        <span>输入：{model.runtime.input.join(" / ")}</span>
        <span>推理：{model.runtime.reasoning ? "声明推理" : "不声明推理"}</span>
        <span>上下文：<span className="font-mono tabular-nums">{quantity(model.runtime.contextWindow)}</span></span>
        <span>最大输出：<span className="font-mono tabular-nums">{quantity(model.runtime.maxOutput)}</span></span>
      </p>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5">
        <CostValue cost={model.runtime.cost} />
        <span className="text-text-muted">规格来源：{sources.join(" / ")}</span>
      </p>
    </div>
  );
}

function ModelAvailability({ model }: { model: ModelServiceModel }) {
  if (model.available) return <StatusBadge tone="success">可用</StatusBadge>;
  return model.unavailableReason === "model-disabled" ? (
    <div className="flex flex-col gap-1">
      <StatusBadge tone="neutral" icon={MinusCircledIcon}>已停用</StatusBadge>
      <p className="max-w-64 break-words text-base text-text-muted">不会出现在审查策略的模型选择中</p>
    </div>
  ) : (
    <div className="flex flex-col gap-1">
      <StatusBadge tone="error">不可用</StatusBadge>
      <p className="max-w-64 break-words text-base text-danger">
        {model.unavailableReasonText ?? "模型不可用"}
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
  if (capability.runnable) return null;
  const canAct =
    (capability.nextAction === "configure-credential" && canWriteCredential) ||
    (capability.nextAction === "add-model-source" && canWriteModels) ||
    (capability.nextAction === "enable-model" && canWriteModels) ||
    (capability.nextAction === "recover-service" && canWriteCustom);
  const nextStep =
    capability.nextAction === "configure-credential"
      ? service.credential.state === "unconfigured"
        ? "到维护页配置模型凭据。"
        : "到维护页重新验证或轮换模型凭据。"
      : capability.nextAction === "add-model-source"
        ? "到维护页刷新自动目录，或到模型页手动添加可验证的 model id。"
      : capability.nextAction === "enable-model"
        ? "到模型页启用至少一个模型。"
      : capability.nextAction === "recover-service"
        ? "到维护页用新名称重建，或删除这项服务。"
        : null;
  return (
    <NoticeBar
      tone="danger"
      icon={CrossCircledIcon}
      titleId={`run-capability-${service.provider}`}
      title={service.providerState === "name-conflict" ? "服务已停用" : "服务需要处理"}
    >
      <p>{capability.reasonText ?? "当前没有可运行模型。"}</p>
      {!canAct || nextStep === null ? null : (
        <p className="mt-1 font-medium text-text">下一步：{nextStep}</p>
      )}
    </NoticeBar>
  );
}

function ReferenceOverview({ references }: { references: readonly ModelReference[] | undefined }) {
  if (references === undefined) {
    return (
      <NoticeBar tone="neutral" icon={InfoCircledIcon} title="组合引用按模型读权限隐藏">
        当前会话只能查看静态服务与凭据状态。
      </NoticeBar>
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
    <CardShell aria-labelledby="service-references">
      <CardHeader
        id="service-references"
        title="组合引用"
        // 零引用时不写「0 个模型标识 · 0 个引用位置」:下面那句已经说了没有谁引用它。
        {...(references.length === 0
          ? {}
          : {
              meta: (
                <>
                  <span className="font-mono tabular-nums">{references.length}</span> 个模型标识 ·{" "}
                  <span className="font-mono tabular-nums">{locationCount}</span> 个引用位置
                </>
              ),
            })}
      />
      <CardSection>
        {references.length === 0 ? (
          <EmptyState title="全局模型组合与仓库覆盖都没有引用这家服务" className="py-0" />
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-md border border-card-line">
            {references.map((reference) => (
              <li key={reference.identity} className="border-t border-line px-3 py-2 first:border-t-0">
                <p className="break-all font-mono text-base font-medium">{reference.identity}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-base text-text-muted">
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
        )}
      </CardSection>
    </CardShell>
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
  onConfigureBuiltin,
  onConfigureCustom,
}: {
  service: ModelService;
  tab: ModelServiceTab;
  canReadModels: boolean;
  canWriteModels: boolean;
  canReadCredential: boolean;
  canWriteCredential: boolean;
  canWriteCustom: boolean;
  onConfigureBuiltin: () => void;
  onConfigureCustom: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 max-sm:[&_button]:min-h-11">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="min-w-0 text-3xl font-extrabold tracking-[-0.02em]">{service.name}</h2>
        <p className="text-base text-text-muted">
          <span className="font-mono">{service.provider}</span> · {service.type === "custom" ? "自定义 provider" : "预置 provider"}
        </p>
      </div>

      {/*
        激活指示条:Radix 自己画的是通栏 2px,这里只在 data-active 上改成设计稿的 3px 圆头
        并左右各缩 14px。限定在 data-active 是必须的——不限定的话 Tailwind 会给未激活项也
        生成一个空的 ::before 盒子,把 tab 的高度顶开。
      */}
      <TabNav.Root
        size="2"
        aria-label="模型服务详情"
        className="shadow-[inset_0_-1px_0_0_var(--v8-border-chrome)]"
      >
        {(["overview", "maintenance", "models"] as const).map((candidate) => {
          if (candidate === "models" && !canReadModels && !canWriteModels) return null;
          const label = candidate === "overview" ? "概览" : candidate === "maintenance" ? "维护" : "模型";
          const to = candidate === "overview"
            ? "/credentials/$provider"
            : candidate === "maintenance"
              ? "/credentials/$provider/maintenance"
              : "/credentials/$provider/models";
          const active = tab === candidate;
          return (
            <TabNav.Link key={candidate} asChild active={active}>
              <Link
                to={to}
                params={{ provider: service.provider }}
                activeOptions={{ exact: true }}
                aria-current={active ? "page" : undefined}
                className="min-h-11 data-[active]:before:inset-x-3.5 data-[active]:before:h-[3px] data-[active]:before:rounded-t-[3px] sm:min-h-0"
              >
                {label}
                {candidate === "models" && service.models !== undefined ? (
                  <Badge
                    color={active ? "blue" : "gray"}
                    variant="soft"
                    radius="full"
                    size="1"
                    className="ml-1.5 tabular-nums"
                  >
                    {service.models.length}
                  </Badge>
                ) : null}
              </Link>
            </TabNav.Link>
          );
        })}
      </TabNav.Root>

      {tab === "overview" ? <>
        <RunCapabilityCard
          service={service}
          canWriteModels={canWriteModels}
          canWriteCredential={canWriteCredential}
          canWriteCustom={canWriteCustom}
        />
        {service.directory?.failure === null || service.directory?.failure === undefined ? null : (
          <NoticeBar tone="warning" icon={ExclamationTriangleIcon} title="目录维护提醒">
            {service.directory.failure}
          </NoticeBar>
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
        <CardShell>
          <CardHeader
            title="模型凭据"
            help={<HelpTooltip label="模型凭据说明" content="新凭据完成目录发现和真实推理后，才会替换当前版本。" />}
            action={
              <Button
                id={`configure-builtin-${service.provider}`}
                type="button"
                variant="outline"
                color="gray"
                size={{ initial: "4", sm: "2" }}
                onClick={onConfigureBuiltin}
              >
                {service.credential.state === "unconfigured" ? "配置凭据" : "换凭据"}
              </Button>
            }
          />
        </CardShell>
      ) : null}

      {tab !== "maintenance" || !canWriteCustom || service.type !== "custom" ? null : (
        <CustomServiceControls service={service} onModify={onConfigureCustom} />
      )}

      {tab === "maintenance" && canWriteModels ? (
        <CatalogControls service={service} section="maintenance" />
      ) : null}

      {tab === "maintenance" && !canWriteCredential && !canWriteModels && !canWriteCustom ? (
        <NoticeBar tone="neutral" icon={InfoCircledIcon} title="暂无修改权限">
          当前账号没有修改模型服务的权限。
        </NoticeBar>
      ) : null}

      {tab === "models" && canWriteModels ? (
        <CatalogControls service={service} section="models" />
      ) : null}

      {tab !== "models" ? null : canReadModels && service.models !== undefined ? (
        <ModelsTable service={service} models={service.models} canWriteModels={canWriteModels} />
      ) : (
        <NoticeBar tone="neutral" icon={InfoCircledIcon} title="暂无模型查看权限">
          当前会话可以审计模型凭据，但不能读取地址、接口协议、模型目录与模型清单。
        </NoticeBar>
      )}
    </div>
  );
}

function LoadingLayout({ detail }: { detail: boolean }) {
  return (
    <div
      className={cn("grid min-w-0 gap-4", MASTER_DETAIL_COLUMNS)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">正在加载模型服务</span>
      <CardShell className={cn("gap-3 p-3", detail ? "hidden lg:flex" : "flex")}>
        <Skeleton aria-hidden className="h-10 w-full" />
        <Skeleton aria-hidden className="h-16 w-full" />
        <Skeleton aria-hidden className="h-16 w-full" />
        <Skeleton aria-hidden className="h-16 w-full" />
      </CardShell>
      <div className={cn("min-w-0 flex-col gap-4", detail ? "flex" : "hidden lg:flex")}>
        <Skeleton aria-hidden className="h-12 w-52" />
        <Skeleton aria-hidden className="h-32 w-full" />
        <Skeleton aria-hidden className="h-56 w-full" />
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
  const navigate = useNavigate();
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
    // 整页跟着壳里的 main 一起滚:列表与详情不再各自开滚动区,回到这一页时要恢复的
    // 位置也只剩 panel-main-scroll 一个,`restoreScroll` 的回落分支正是为此留的。
    <PageBody width="wide" className="gap-4 sm:gap-[18px]">
      <PageHeader
        title="模型服务"
        actions={canWriteCredential ? (
          <Button
            id="add-model-service-trigger"
            type="button"
            variant="solid"
            size={{ initial: "4", sm: "2" }}
            onClick={() => void navigate({
              to: "/credentials/add",
              search: modelServiceReturnSearch(provider, tab, "add-service"),
            })}
          >
            添加模型服务
          </Button>
        ) : undefined}
      />
      {!canReadServices ? (
        <CardShell className="max-w-[760px] gap-1.5 px-4 py-4 sm:px-5">
          <h2 className="text-2xl font-bold tracking-[-0.015em]">模型服务信息不可见</h2>
          <p className="text-text-secondary">
            {canWriteCredential
              ? "当前会话可写模型凭据，但不能读取现有服务、目录和凭据审计字段。可从页头添加模型服务继续配置。"
              : "当前会话没有模型或凭据读取权限。页头搜索只显示按权限裁剪后的内置 provider 信息。"}
          </p>
        </CardShell>
      ) : query.isPending ? (
        <LoadingLayout detail={provider !== undefined} />
      ) : query.isError ? (
        <Callout.Root role="alert" color="red" size="2" className="max-w-[760px]">
          <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
          <Callout.Text>
            <strong className="block font-semibold">模型服务加载失败</strong>
            <span className="mt-1 block">{(query.error as Error).message}</span>
          </Callout.Text>
          <Button
            className="w-fit"
            type="button"
            variant="outline"
            color="gray"
            size={{ initial: "4", sm: "2" }}
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "正在重试…" : "重试"}
          </Button>
        </Callout.Root>
      ) : services.length === 0 ? (
        <CardShell className="max-w-[760px] px-4 py-4 sm:px-5">
          <EmptyState
            title="还没有模型服务"
            titleAs="h2"
            className="py-0"
            description={(
              <>
              这里只列已配置或保留异常状态的服务。
              {canWriteCredential ? "从页头的添加模型服务进入统一配置流程。" : "当前权限只能查看可见状态。"}
              </>
            )}
          />
        </CardShell>
      ) : (
        <div className={cn("grid min-w-0 gap-4", MASTER_DETAIL_COLUMNS)}>
          <CardShell
            className={cn("overflow-hidden", provider === undefined ? "flex" : "hidden lg:flex")}
          >
            <CardHeader
              title="已配置服务"
              meta={<><span className="font-mono tabular-nums">{services.length}</span> 项</>}
            />
            {services.map((service) => {
              const isSelected = service.provider === selected?.provider;
              // 名字冲突的服务整行压灰:它在列表里的语义是「停用」,状态点单独变灰压不住
              // 一行黑字的服务名。
              const dimmed = service.providerState === "name-conflict";
              return (
                <MasterListItem
                  key={service.provider}
                  asChild
                  selected={isSelected}
                  className="block border-t border-line px-4 py-3"
                >
                  <Link to="/credentials/$provider" params={{ provider: service.provider }}>
                    <div className="flex min-w-0 items-center justify-between gap-2.5">
                      <div className="flex min-w-0 flex-col">
                        <Tooltip content={service.name}>
                          <span
                            tabIndex={0}
                            className={cn(
                              "min-w-0 truncate rounded-chip outline-none focus-visible:ring-2 focus-visible:ring-[var(--master-list-focus)] focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
                              isSelected ? null : "font-medium",
                              service.name === service.provider && "font-mono",
                              dimmed && "text-text-disabled",
                            )}
                          >
                            {service.name}
                          </span>
                        </Tooltip>
                        <MasterListItemText asChild>
                          <span className={cn("min-w-0 truncate text-sm", dimmed && "text-text-disabled")}>
                            {service.name === service.provider ? null : <>{service.provider} · </>}
                            {service.type === "custom" ? "自定义" : "内置"}
                            {service.models === undefined || service.directory === undefined
                              ? " · 模型数量与发现时间按权限隐藏"
                              : <> · <span className="font-mono tabular-nums">{service.models.length}</span> 个模型</>}
                          </span>
                        </MasterListItemText>
                      </div>
                      <ServiceStatus service={service} />
                    </div>
                  </Link>
                </MasterListItem>
              );
            })}
          </CardShell>
          <div className={cn("min-w-0", provider === undefined ? "hidden lg:block" : "block")}>
            {provider === undefined ? null : (
              <Button variant="ghost" color="gray" size="3" className="mb-3 w-fit lg:hidden" asChild>
                <Link to="/credentials" activeOptions={{ exact: true }}>
                  <ArrowLeftIcon aria-hidden />
                  返回模型服务列表
                </Link>
              </Button>
            )}
            {selected === undefined ? (
              <CardShell className="gap-1.5 px-4 py-4 sm:px-5">
                <h2 className="text-2xl font-bold tracking-[-0.015em]">模型服务不存在</h2>
                <p className="text-text-secondary">该模型服务已删除，或当前账号无权查看。</p>
              </CardShell>
            ) : (
              <ServiceDetail
                service={selected}
                tab={tab}
                canReadModels={canReadModels}
                canWriteModels={canWriteModels}
                canReadCredential={canReadCredential}
                canWriteCredential={canWriteCredential}
                canWriteCustom={canWriteCustom && canReadModels}
                onConfigureBuiltin={() => void navigate({
                  to: "/credentials/add/builtin/$provider/discover",
                  params: { provider: selected.provider },
                  search: modelServiceReturnSearch(selected.provider, tab, "configure-builtin"),
                })}
                onConfigureCustom={() => void navigate({
                  to: "/credentials/add/custom/$provider/discover",
                  params: { provider: selected.provider },
                  search: modelServiceReturnSearch(selected.provider, tab, "configure-custom"),
                })}
              />
            )}
          </div>
        </div>
      )}
    </PageBody>
  );
}
