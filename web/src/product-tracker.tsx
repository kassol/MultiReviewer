import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Cross2Icon,
  CrossCircledIcon,
  DotsHorizontalIcon,
  MagnifyingGlassIcon,
  RadiobuttonIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  Dialog,
  DropdownMenu,
  IconButton,
  SegmentedControl,
  Select,
  Skeleton,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { Collapsible } from "radix-ui";
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";

import { CardShell } from "@/components/card-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { HelpTooltip } from "@/components/help-tooltip";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/theme-button";
import { useDialogReturnFocus } from "@/components/use-dialog-return-focus";
import {
  isTrackerFiltering,
  matchesTrackerFilter,
  NO_TRACKER_FILTER,
  openTicketIds,
  pickableTickets,
  productQueryKey,
  specQueryKey,
  ticketNotes,
  ticketStatuses,
  TICKET_STATUSES,
  trackerCloseConfirm,
  trackerListGroups,
  type Product,
  type SpecDetail,
  type TicketLabel,
  type TicketStatus,
  type TrackerCloseTarget,
  type TrackerFilter,
  type TrackerTicket,
  type TrackerSpec,
  type TrackerState,
} from "@/lib/products";
import { localMinute } from "@/lib/time";
import { cn } from "@/lib/utils";

import { apiUrl, fetchJson, send } from "./api.ts";

/** 五个 triage 标签各自的颜色。同一个标签在哪都是同一色,人扫一眼就认得出这是哪一类活。 */
const LABEL_COLOR: Record<TicketLabel, "gray" | "amber" | "green" | "blue" | "red"> = {
  "needs-triage": "gray",
  "needs-info": "amber",
  "ready-for-agent": "green",
  "ready-for-human": "blue",
  wontfix: "red",
};

/** 改标签菜单里的五项。取值就是上面那张表的键,两处不会各写一份。 */
const TICKET_LABELS = Object.keys(LABEL_COLOR) as TicketLabel[];

/**
 * 可开工的那一枚标记(CONTEXT.md 票,issue #363)。不另起一枚 Badge:标签那一格已经占着
 * 颜色,再来一枚绿的会与 `ready-for-agent` 撞脸。一行小字说完即可,颜色随行首那枚「可开工」
 * 状态图标走绿:原先是主色,而主色在同一套图标里是「已认领」,读着像一个链接。
 */
function PickableMark() {
  return <span className="shrink-0 text-sm font-medium text-success">可开工</span>;
}

/** 看板四列各自的状态图标颜色。开着的三档共用一个圆点图形、按颜色分,已关换成对勾。 */
const STATUS_ICON_CLASS: Record<TicketStatus, string> = {
  ready: "text-success-icon",
  blocked: "text-warning-icon",
  claimed: "text-primary",
  closed: "text-text-muted",
};

const STATUS_TITLE = Object.fromEntries(
  TICKET_STATUSES.map(({ status, title }) => [status, title]),
) as Record<TicketStatus, string>;

/** 一张票的状态图标(列表行首、看板列头、弹窗里的票行共用)。读屏读到的是列名。 */
function TicketStatusIcon({ status, className }: { status: TicketStatus; className?: string | undefined }) {
  const Icon = status === "closed" ? CheckCircledIcon : RadiobuttonIcon;
  return (
    <Icon
      role="img"
      aria-label={STATUS_TITLE[status]}
      className={cn("size-4 shrink-0", STATUS_ICON_CLASS[status], className)}
    />
  );
}

/**
 * 一处阻塞边的另一头(issue #363 的阻塞边):票号可点,点了打开它所在的 spec 并展开那一张——
 * 挡着它的票常挂在另一条 spec 下,只写个号人还得自己去翻。
 */
function BlockerLink({
  id,
  closed = false,
  onJump,
}: {
  id: number;
  /** 已关的那一头划掉、退成次要色:它不再挡着谁,但边还在,人要知道当初等过它。 */
  closed?: boolean;
  onJump: (ticketId: number) => void;
}) {
  return (
    <button
      type="button"
      aria-label={closed ? `#${id}（已关）` : undefined}
      className={cn(
        "rounded-sm font-mono tabular-nums hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        closed ? "text-text-muted line-through" : "text-primary",
      )}
      onClick={() => onJump(id)}
    >
      #{id}
    </button>
  );
}

/**
 * 票行标题下那一行小字:`#id · 已关 · 谁认领 · 等 #n · 可开工`。与 `ticketNotes` 同一套
 * 取舍(只列还开着的阻塞),只是把阻塞的票号做成可点的——看板卡片整张是一颗键,里面不能
 * 再套键,那一处仍用 `ticketNotes` 的纯文字。
 */
function TicketMeta({
  ticket,
  openTickets,
  pickable,
  onJump,
  className,
}: {
  ticket: TrackerTicket;
  openTickets: ReadonlySet<number>;
  pickable: boolean;
  onJump: (ticketId: number) => void;
  className?: string | undefined;
}) {
  const blockers = ticket.blockedBy.filter((id) => openTickets.has(id));
  return (
    <span className={cn("text-sm text-text-muted", className)}>
      <span className="font-mono tabular-nums">#{ticket.id}</span>
      {ticket.state === "closed" ? " · 已关" : null}
      {ticket.claimedBy === null ? null : ` · ${ticket.claimedBy} 认领`}
      {blockers.length === 0 ? null : (
        <>
          {" · 等 "}
          {blockers.map((id, index) => (
            <Fragment key={id}>
              {index === 0 ? null : "、"}
              <BlockerLink id={id} onJump={onJump} />
            </Fragment>
          ))}
        </>
      )}
      {pickable ? (
        <>
          {" · "}
          <span className="font-medium text-success">可开工</span>
        </>
      ) : null}
    </span>
  );
}

/**
 * 弹窗要展开并滚到的那一张票。`at` 是点下去的时刻:同一张票再跳一次时它变了,滚动照样再做
 * 一次——只比票号的话,人滚走之后再点同一个 #n 什么都不会发生。
 */
type TicketFocus = { ticketId: number; at: number };

/** tracker 两种视图(issue 式列表与看板)。缺省是列表,不写进地址。 */
export type TrackerView = "list" | "board";

/** 认领人筛选的 Select 取值:Radix Select 不收空串,「全部」「未认领」用前缀与用户名分开。 */
const CLAIMER_ALL = "all";
const CLAIMER_NONE = "none";
const claimerValue = (claimer: string | null | undefined): string =>
  claimer === undefined ? CLAIMER_ALL : claimer === null ? CLAIMER_NONE : `user:${claimer}`;
const claimerFromValue = (value: string): string | null | undefined =>
  value === CLAIMER_ALL ? undefined : value === CLAIMER_NONE ? null : value.slice("user:".length);

/** 看板「已关」那一列默认只画这么多张:它只会越攒越多,而人来看板找的是还开着的。 */
const CLOSED_COLUMN_LIMIT = 8;

/** 一张票上的一个写动作:认领、改标签或开关,给哪一格就动哪一格。 */
type TicketPayload = { claimed?: boolean; label?: TicketLabel; state?: TrackerState };

/** 能拿来还焦点的那颗键。按钮的点击事件与菜单项手里那颗「…」都是这个形状。 */
type FocusTrigger = { currentTarget: HTMLElement };

/**
 * 产品 tracker 上人的那几个写动作(CONTEXT.md 认领、票,issue #363):认领、改标签、开关票与
 * spec、在票上评论。列表行与 spec 弹窗共用这一份——一个 mutation、一条回绝、一道关前确认,
 * 两处不各写一套。
 *
 * 做完只失效产品详情那一份:`productQueryKey` 是 `specQueryKey` 的前缀,弹窗里那条 spec 的
 * 全文跟着重读,列表那一列的认领人与状态也跟着变。关要先问一句(issue #389),重新打开照旧
 * 点完就写——它把状态放回去,误触没有代价。确认框(`confirm`)由调用方放:弹窗开着时放进
 * 弹窗里,关着时放在列表旁,同一时刻只挂一处。
 */
function useTrackerActions(productId: number) {
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  /** 等人点头才写的那一下:null 即此刻没有要关的东西。 */
  const [closing, setClosing] = useState<TrackerCloseTarget | null>(null);
  const act = useMutation({
    mutationFn: (input: { path: string; method: string; payload: unknown }) =>
      send(input.path, input.method, input.payload),
    onSuccess: async () => {
      setFailure(null);
      await queryClient.invalidateQueries({ queryKey: productQueryKey(productId) });
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const ticket = (ticketId: number, payload: TicketPayload): void =>
    act.mutate({ path: `/products/${productId}/tickets/${ticketId}`, method: "PUT", payload });
  const spec = (specId: number, state: TrackerState): void =>
    act.mutate({ path: `/products/${productId}/specs/${specId}`, method: "PUT", payload: { state } });
  const comment = (ticketId: number, text: string): void =>
    act.mutate({ path: `/products/${productId}/tickets/${ticketId}/comments`, method: "POST", payload: { text } });
  /**
   * 确认弹窗关闭带退场动画,`closing` 一清空,还在淡出的那一帧就会渲染出「关掉票 #undefined」
   * (issue #382 在权限页踩过同一脚)。记住最后一个非空值,退场期间照它渲染;点了做什么仍读
   * `closing`。
   */
  const lastClosing = useRef(closing);
  if (closing !== null) lastClosing.current = closing;
  const shownClosing = closing ?? lastClosing.current;
  /** 确认弹窗关掉后焦点回到按下的那颗「关掉」;它被换掉时退到 spec 弹窗的关闭键。 */
  const confirmFocus = useDialogReturnFocus(useCallback(
    () => document.querySelector<HTMLElement>('[role="dialog"] [aria-label="关闭"]'),
    [],
  ));
  const closeConfirm = shownClosing === null ? null : trackerCloseConfirm(shownClosing);
  const confirm = (
    <ConfirmDialog
      open={closing !== null}
      onOpenChange={(open) => {
        if (!open) setClosing(null);
      }}
      onCloseAutoFocus={confirmFocus.onCloseAutoFocus}
      maxWidth="440px"
      title={closeConfirm?.title ?? ""}
      titleSize="4"
      titleMb="2"
      description={closeConfirm?.description ?? ""}
      descriptionClassName="break-words"
      direction={{ initial: "column-reverse", sm: "row" }}
      cancelLabel="取消"
      cancelVariant="outline"
      confirm={{
        label: "关掉",
        color: "gray",
        highContrast: true,
        closesDialog: true,
        onClick: () => {
          if (closing === null) return;
          if (closing.kind === "ticket") ticket(closing.id, { state: "closed" });
          else spec(closing.id, "closed");
        },
      }}
    />
  );
  return {
    busy: act.isPending,
    failure,
    clearFailure: () => setFailure(null),
    ticket,
    spec,
    comment,
    /** 先问一句再关:记下按下的那颗键,确认框关掉后焦点回到它。 */
    requestClose: (trigger: FocusTrigger, target: TrackerCloseTarget): void => {
      confirmFocus.captureTrigger(trigger);
      setClosing(target);
    },
    confirm,
  };
}

type TrackerActions = ReturnType<typeof useTrackerActions>;

/**
 * 一张票上的那几个动作:认领 / 取消认领、改标签、关掉 / 重新打开。列表行与 spec 弹窗里的票行
 * 共用。`sm` 起是一排 ghost 键;`sm` 以下收成一颗「…」菜单——三颗键挤进 390px 的一行会把
 * 标题压成一行几个字,折到下一行又让每张票多占一行高。
 */
function TicketActions({
  ticket,
  actions,
  className,
}: {
  ticket: TrackerTicket;
  actions: TrackerActions;
  className?: string | undefined;
}) {
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const busy = actions.busy;
  const claimLabel = ticket.claimedBy === null ? "认领" : "取消认领";
  const stateLabel = ticket.state === "open" ? "关掉" : "重新打开";
  const toggleState = (trigger: FocusTrigger): void =>
    ticket.state === "open"
      ? actions.requestClose(trigger, { kind: "ticket", id: ticket.id, title: ticket.title })
      : actions.ticket(ticket.id, { state: "open" });

  return (
    <div className={cn("flex shrink-0 items-center", className)}>
      <div className="flex flex-wrap items-center gap-4 max-sm:hidden">
        <Button
          size="1"
          className="pointer-coarse:min-h-11"
          variant="ghost"
          color="gray"
          disabled={busy}
          onClick={() => actions.ticket(ticket.id, { claimed: ticket.claimedBy === null })}
        >
          {claimLabel}
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button size="1" variant="ghost" color="gray" disabled={busy} className="pointer-coarse:min-h-11">
              改标签
              <ChevronDownIcon aria-hidden />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end">
            {TICKET_LABELS.map((label) => (
              <DropdownMenu.Item
                key={label}
                disabled={label === ticket.label}
                onSelect={() => actions.ticket(ticket.id, { label })}
              >
                {label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Button
          size="1"
          className="pointer-coarse:min-h-11"
          variant="ghost"
          color="gray"
          disabled={busy}
          onClick={toggleState}
        >
          {stateLabel}
        </Button>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            ref={menuTrigger}
            type="button"
            variant="ghost"
            color="gray"
            size="3"
            className="sm:hidden"
            disabled={busy}
            aria-label={`票 #${ticket.id} 的操作`}
          >
            <DotsHorizontalIcon aria-hidden />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item
            onSelect={() => actions.ticket(ticket.id, { claimed: ticket.claimedBy === null })}
          >
            {claimLabel}
          </DropdownMenu.Item>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>改标签</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              {TICKET_LABELS.map((label) => (
                <DropdownMenu.Item
                  key={label}
                  disabled={label === ticket.label}
                  onSelect={() => actions.ticket(ticket.id, { label })}
                >
                  {label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            onSelect={() => {
              // 菜单项随菜单卸载,焦点还给「…」那颗键。
              if (menuTrigger.current !== null) toggleState({ currentTarget: menuTrigger.current });
            }}
          >
            {stateLabel}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  );
}

/**
 * 产品页右栏的产品 tracker 区(CONTEXT.md 产品 tracker,issue #361、#363)。
 *
 * 两种视图,形状照 GitHub:**列表**是 issue 式的——「开着 / 已关」两个计数切换,标签与认领人
 * 筛选,一条 spec 一组、组里一张票一行;**看板**按票此刻的工作状态分四列(可开工 / 被阻塞 /
 * 已认领 / 已关),回答「现在能接哪一张」。筛选两种视图共用,视图记在地址的 `?view=` 上。
 *
 * **正文只读**:spec 与票的正文只由会话经工具写。人在这里读、导出,并做认领、改标签、开关
 * 与评论:认领、改标签、开关票在列表的票行上就做得了(`TicketActions`),与 spec 全文弹窗里
 * 同一套;评论与开关 spec 在弹窗里,一张票的上下文全在那儿。点一张票打开它所在的 spec 并展开
 * 这一张。读随产品可见性,动作按 `agent:chat` 显隐。
 */
export function TrackerSection({
  product,
  specs,
  pending,
  canChat,
  openSpecId,
  onOpenSpec,
  view,
  onView,
}: {
  product: Product;
  specs: readonly TrackerSpec[];
  pending: boolean;
  canChat: boolean;
  /** 地址上 `?spec=` 说的那一条(null 即弹窗关着)。会话页右栏点过来的链接带的就是它。 */
  openSpecId: number | null;
  onOpenSpec: (specId: number | null) => void;
  view: TrackerView;
  onView: (view: TrackerView) => void;
}) {
  const openSpec = specs.find((spec) => spec.id === openSpecId) ?? null;
  const [listState, setListState] = useState<TrackerState>("open");
  const [filter, setFilter] = useState<TrackerFilter>(NO_TRACKER_FILTER);
  const [showAllClosed, setShowAllClosed] = useState(false);
  /** 从一张票点进来时弹窗里展开并滚到这一张;点 spec 标题进来时为 null。 */
  const [focus, setFocus] = useState<TicketFocus | null>(null);
  /** 弹窗是受控的,没有 `Dialog.Trigger`,焦点得自己送回打开它的那颗键;关掉后列表重取、
   *  那颗键被换掉时,按票号或 spec id 找回新渲染的同一颗。带着 `?spec=` 进来的那一次没有
   *  点过任何键,同样照 spec id 找。 */
  const lastTrigger = useRef<string | null>(null);
  if (openSpecId !== null && focus === null) {
    lastTrigger.current = `[data-spec-trigger="${openSpecId}"]`;
  }
  const returnFocus = useDialogReturnFocus(useCallback(
    () => (lastTrigger.current === null ? null : document.querySelector<HTMLElement>(lastTrigger.current)),
    [],
  ));
  const statuses = ticketStatuses(specs);
  const openTickets = openTicketIds(specs);
  const pickable = pickableTickets(specs);
  const tickets = specs.flatMap((spec) => spec.tickets.map((ticket) => ({ spec, ticket })));
  const matching = tickets.filter(({ spec, ticket }) => matchesTrackerFilter(ticket, spec.title, filter));
  const filtering = isTrackerFiltering(filter);
  const specOfTicket = new Map(tickets.map(({ spec, ticket }) => [ticket.id, spec.id]));
  const claimers = [...new Set(tickets.map(({ ticket }) => ticket.claimedBy).filter((one) => one !== null))].sort();
  const actions = useTrackerActions(product.id);

  const openFromSpec = (event: MouseEvent<HTMLElement>, specId: number): void => {
    actions.clearFailure();
    returnFocus.captureTrigger(event);
    lastTrigger.current = `[data-spec-trigger="${specId}"]`;
    setFocus(null);
    onOpenSpec(specId);
  };
  const openFromTicket = (event: MouseEvent<HTMLElement>, specId: number, ticketId: number): void => {
    actions.clearFailure();
    returnFocus.captureTrigger(event);
    lastTrigger.current = `[data-ticket-trigger="${ticketId}"]`;
    setFocus({ ticketId, at: Date.now() });
    onOpenSpec(specId);
  };
  /** 跟着一处阻塞边跳到那张票:同一条 spec 里就地展开,别的 spec 就换过去。 */
  const jumpTo = (ticketId: number): void => {
    const specId = specOfTicket.get(ticketId);
    if (specId === undefined) return;
    setFocus({ ticketId, at: Date.now() });
    onOpenSpec(specId);
  };

  const toolbar = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="sr-only">产品 tracker</h2>
      {view === "list" ? (
        // 与 GitHub issue 列表同一形状:两个带数的开关,当前那一个字重压实。数跟着筛选走。
        <div role="group" aria-label="按开关筛选" className="flex items-center gap-4">
          {(["open", "closed"] as const).map((state) => {
            const count = matching.filter(({ ticket }) => ticket.state === state).length;
            const current = listState === state;
            return (
              <Button
                key={state}
                variant="ghost"
                color="gray"
                size="2"
                aria-pressed={current}
                className={cn(
                  "pointer-coarse:min-h-11",
                  current ? "font-semibold text-text" : "text-text-muted",
                )}
                onClick={() => setListState(state)}
              >
                {state === "open" ? (
                  <RadiobuttonIcon aria-hidden />
                ) : (
                  <CheckCircledIcon aria-hidden />
                )}
                <span className="font-mono tabular-nums">{count}</span>
                {state === "open" ? "开着" : "已关"}
              </Button>
            );
          })}
        </div>
      ) : (
        <span className="text-md text-text-secondary">
          <span className="font-mono tabular-nums">{matching.length}</span> 张票
        </span>
      )}
      {/* 说明挂在左边这一组的末尾:窄屏上右边那组整行折下去,挂在它后面会单独落一行。 */}
      <HelpTooltip
        label="产品 tracker 说明"
        content="需求拆分会话谈定之后把 spec 写进来，再拆成带阻塞边的票。正文只由会话写；认领、改标签、开关与评论打开一条 spec 就能做。"
      />
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto max-sm:w-full">
        <TextField.Root
          size={{ initial: "3", sm: "1" }}
          className="min-w-[10rem] max-sm:basis-full sm:w-44"
          aria-label="按标题搜索票"
          placeholder="搜索票或 spec 标题"
          value={filter.query}
          onChange={(event) => setFilter((prev) => ({ ...prev, query: event.target.value }))}
        >
          <TextField.Slot side="left">
            <MagnifyingGlassIcon aria-hidden />
          </TextField.Slot>
        </TextField.Root>
        <Select.Root
          size={{ initial: "3", sm: "1" }}
          value={filter.label ?? "all"}
          onValueChange={(value) =>
            setFilter((prev) => ({ ...prev, label: value === "all" ? null : (value as TicketLabel) }))
          }
        >
          <Select.Trigger aria-label="按标签筛选" className="max-sm:flex-1" />
          <Select.Content>
            <Select.Item value="all">全部标签</Select.Item>
            {TICKET_LABELS.map((label) => (
              <Select.Item key={label} value={label}>
                {label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <Select.Root
          size={{ initial: "3", sm: "1" }}
          value={claimerValue(filter.claimer)}
          onValueChange={(value) => setFilter((prev) => ({ ...prev, claimer: claimerFromValue(value) }))}
        >
          <Select.Trigger aria-label="按认领人筛选" className="max-sm:flex-1" />
          <Select.Content>
            <Select.Item value={CLAIMER_ALL}>全部认领人</Select.Item>
            <Select.Item value={CLAIMER_NONE}>未认领</Select.Item>
            {claimers.map((name) => (
              <Select.Item key={name} value={claimerValue(name)}>
                {name}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <SegmentedControl.Root
          size={{ initial: "3", sm: "1" }}
          value={view}
          onValueChange={(next) => onView(next as TrackerView)}
          aria-label="tracker 视图"
          className="max-sm:w-full"
        >
          <SegmentedControl.Item value="list" className="max-sm:flex-1">列表</SegmentedControl.Item>
          <SegmentedControl.Item value="board" className="max-sm:flex-1">看板</SegmentedControl.Item>
        </SegmentedControl.Root>
      </div>
    </div>
  );

  const clearFilter = filtering ? (
    <Button variant="soft" color="gray" size="1" onClick={() => setFilter(NO_TRACKER_FILTER)}>
      清除筛选
    </Button>
  ) : undefined;

  const listBody = (() => {
    const groups = trackerListGroups(specs, listState, filter);
    if (groups.length === 0) {
      return (
        <CardShell className="px-5 py-4">
          <EmptyState
            title={filtering ? "没有符合筛选的票。" : listState === "open" ? "没有开着的票。" : "没有关掉的票。"}
            action={clearFilter}
          />
        </CardShell>
      );
    }
    return (
      <CardShell className="min-w-0 overflow-hidden">
        {groups.map(({ spec, tickets: rows }) => {
          const done = spec.tickets.filter((ticket) => ticket.state === "closed").length;
          return (
            <section key={spec.id} className="min-w-0 border-t border-line first:border-t-0">
              {/* 组头是 spec:标题点开全文,右端是它的票关了几张与导出。底色让它与下面的票行分层。 */}
              <div className="flex min-w-0 items-center justify-between gap-3 bg-sunken px-4 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    type="button"
                    data-spec-trigger={spec.id}
                    className="min-w-0 break-words rounded-sm text-left text-md font-semibold text-text hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-11"
                    onClick={(event) => openFromSpec(event, spec.id)}
                  >
                    {spec.title}
                  </button>
                  {spec.state === "closed" ? (
                    <Badge color="gray" variant="soft" size="1">
                      已关
                    </Badge>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {spec.tickets.length === 0 ? null : (
                    <span className="text-sm text-text-muted" title={`${spec.tickets.length} 张票里关了 ${done} 张`}>
                      <span className="font-mono tabular-nums">
                        {done}/{spec.tickets.length}
                      </span>{" "}
                      已关
                    </span>
                  )}
                  {/* 导出就是那一个 GET:交给浏览器下载,不必先在前端拼一遍 Markdown。 */}
                  <Button asChild variant="ghost" color="gray" size="1" className="pointer-coarse:min-h-11">
                    <a
                      href={apiUrl(`/products/${product.id}/specs/${spec.id}/export`)}
                      download={`${spec.title}.md`}
                    >
                      导出
                    </a>
                  </Button>
                </div>
              </div>
              {rows.length === 0 ? (
                <p className="border-t border-line px-4 py-2.5 text-base text-text-muted">还没有拆出票。</p>
              ) : (
                <ul>
                  {rows.map((ticket) => {
                    const status = statuses.get(ticket.id) ?? "ready";
                    return (
                      <li
                        key={ticket.id}
                        className="group/ticket-row flex min-w-0 items-start gap-2.5 border-t border-line px-4 py-2.5 transition-colors hover:bg-sunken"
                      >
                        <TicketStatusIcon status={status} className="mt-0.5" />
                        <div className="flex min-w-0 grow flex-col gap-0.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <button
                              type="button"
                              data-ticket-trigger={ticket.id}
                              className={cn(
                                "min-w-0 break-words rounded-sm text-left text-lg font-medium hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                                ticket.state === "closed" ? "text-text-secondary" : "text-text",
                              )}
                              onClick={(event) => openFromTicket(event, spec.id, ticket.id)}
                            >
                              {ticket.title}
                            </button>
                            <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                              {ticket.label}
                            </Badge>
                          </div>
                          <TicketMeta
                            ticket={ticket}
                            openTickets={openTickets}
                            pickable={false}
                            onJump={jumpTo}
                          />
                        </div>
                        {pickable.has(ticket.id) ? <PickableMark /> : null}
                        {canChat ? (
                          // 细指针的宽屏上指到这一行(或焦点进来、菜单开着)才现:一列几十行
                          // 每行三颗键是噪音。触屏常显,窄屏收成「…」。
                          <TicketActions
                            ticket={ticket}
                            actions={actions}
                            className="transition-opacity pointer-fine:md:opacity-0 pointer-fine:md:group-hover/ticket-row:opacity-100 pointer-fine:md:group-focus-within/ticket-row:opacity-100 pointer-fine:md:has-[[data-state=open]]:opacity-100"
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </CardShell>
    );
  })();

  const boardBody = (
    // 列不是卡:页面灰底上一道更深一档的槽,白卡浮在里面。窄屏按 2 列、1 列折下来,不横向滚。
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {TICKET_STATUSES.map(({ status, title }) => {
        const all = matching.filter(({ ticket }) => statuses.get(ticket.id) === status);
        // 已关那一列新关的在前:票号越大越晚写下,没有关闭时刻可排,拿它近似。
        const ordered = status === "closed" ? [...all].sort((x, y) => y.ticket.id - x.ticket.id) : all;
        const cut = status === "closed" && !showAllClosed && ordered.length > CLOSED_COLUMN_LIMIT;
        const cards = cut ? ordered.slice(0, CLOSED_COLUMN_LIMIT) : ordered;
        return (
          <section
            key={status}
            aria-label={title}
            className="flex min-w-0 flex-col gap-2 rounded-[var(--v8-radius-card)] bg-sunken p-2"
          >
            <h3 className="flex items-center gap-2 px-1.5 pt-1 text-md font-semibold">
              <TicketStatusIcon status={status} />
              {title}
              <span className="font-mono text-sm font-normal text-text-muted tabular-nums">{all.length}</span>
            </h3>
            {cards.length === 0 ? (
              <p className="px-1.5 pb-1.5 text-base text-text-disabled">没有票</p>
            ) : (
              cards.map(({ spec, ticket }) => {
                const notes = ticketNotes(ticket, openTickets);
                return (
                  <button
                    key={ticket.id}
                    type="button"
                    data-ticket-trigger={ticket.id}
                    className="flex min-w-0 flex-col gap-1.5 rounded-[var(--v8-radius-control)] border border-card-line bg-surface p-3 text-left shadow-[var(--v8-shadow-control)] transition-[box-shadow,border-color] hover:border-input hover:shadow-[var(--v8-shadow-card)] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                    onClick={(event) => openFromTicket(event, spec.id, ticket.id)}
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-text-muted tabular-nums">#{ticket.id}</span>
                      <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                        {ticket.label}
                      </Badge>
                    </span>
                    <span
                      className={cn(
                        "line-clamp-3 break-words text-md font-medium",
                        ticket.state === "closed" ? "text-text-secondary" : "text-text",
                      )}
                    >
                      {ticket.title}
                    </span>
                    <span className="truncate text-sm text-text-muted" title={spec.title}>
                      {spec.title}
                    </span>
                    {notes === "" ? null : <span className="text-sm text-text-secondary">{notes}</span>}
                  </button>
                );
              })
            )}
            {cut ? (
              <Button variant="ghost" color="gray" size="1" className="mx-1 mb-1 self-start" onClick={() => setShowAllClosed(true)}>
                显示全部 {ordered.length} 张
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* 列表行上的动作被回绝时报在这里;弹窗开着时报在弹窗里,人眼睛在哪就报在哪。 */}
      {openSpec !== null || actions.failure === null ? null : (
        <Callout.Root role="alert" color="red" size="1">
          <Callout.Icon>
            <CrossCircledIcon aria-hidden />
          </Callout.Icon>
          <Callout.Text>{actions.failure}</Callout.Text>
        </Callout.Root>
      )}
      {pending ? (
        <Skeleton aria-hidden className="h-24" />
      ) : specs.length === 0 ? (
        <CardShell className="px-5 py-4">
          <h2 className="sr-only">产品 tracker</h2>
          <EmptyState
            title="还没有 spec。"
            description="在需求拆分会话里谈定一个需求，agent 就把它连同拆出的票写进来。"
          />
        </CardShell>
      ) : (
        <>
          {toolbar}
          {view === "list" ? listBody : boardBody}
        </>
      )}
      {openSpec === null ? actions.confirm : null}
      <SpecDialog
        productId={product.id}
        spec={openSpec}
        canChat={canChat}
        actions={actions}
        pickable={pickable}
        openTickets={openTickets}
        statuses={statuses}
        focus={focus}
        onJump={jumpTo}
        onClose={() => {
          setFocus(null);
          onOpenSpec(null);
        }}
        onCloseAutoFocus={returnFocus.onCloseAutoFocus}
      />
    </div>
  );
}

/** spec 弹窗侧栏里的一段:小标题加内容,段与段之间一道发丝线。 */
function SidebarBlock({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0",
        className,
      )}
    >
      <h3 className="text-sm font-semibold text-text-muted">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 一张票底下的评论输入(CONTEXT.md 票,issue #363)。一个 TextArea 加一颗发送,草稿留在
 * 这一张票自己的组件里——弹窗里几张票同时开着,草稿不该互相串。
 */
function CommentBox({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (text === "") return;
        setDraft("");
        onSend(text);
      }}
    >
      <TextArea
        size="2"
        rows={2}
        maxLength={4000}
        aria-label="写一条评论"
        placeholder="写一条评论"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="flex justify-end">
        <Button type="submit" size="1" variant="soft" disabled={busy || draft.trim() === ""}>
          发送
        </Button>
      </div>
    </form>
  );
}

/**
 * 一条 spec 的全文(issue #361):它自己的正文,加它那几张票的正文与评论。读的是
 * `GET /products/{id}/specs/{specId}`——产品详情那一份只带列表要显示的那几格。
 *
 * 人的那几个动作也在这里(issue #363):开关这条 spec,认领、改标签、开关一张票,在票上
 * 评论——走的是 `TrackerSection` 那一份 `useTrackerActions`,与列表行同一个 mutation。正文与
 * 标题没有入口——它们只由会话经工具写(ADR 0035)。
 */
function SpecDialog({
  productId,
  spec,
  canChat,
  pickable,
  openTickets,
  statuses,
  focus,
  onJump,
  onClose,
  onCloseAutoFocus,
  actions,
}: {
  productId: number;
  spec: TrackerSpec | null;
  /** 有 `agent:chat` 且分到了这个产品里的仓库时才显示那几个控件。 */
  canChat: boolean;
  /** 写动作、回绝与关前确认,与列表行共用一份。 */
  actions: TrackerActions;
  /** 可开工的票号,与产品页那一列同一份。 */
  pickable: ReadonlySet<number>;
  /** 开着的票号:「等 #n」只列还挡着的那几张。 */
  openTickets: ReadonlySet<number>;
  /** 每张票落在看板哪一列,与产品页那一份同一份。 */
  statuses: ReadonlyMap<number, TicketStatus>;
  /** 从一张票点进来、或跟着阻塞边跳过来时,展开并滚到这一张。 */
  focus: TicketFocus | null;
  /** 跟着一处阻塞边跳到那张票(可能在另一条 spec 下)。 */
  onJump: (ticketId: number) => void;
  onClose: () => void;
  /** 关闭后把焦点送回打开它的那颗 spec 标题键。 */
  onCloseAutoFocus: (event: Event) => void;
}) {
  const detail = useQuery({
    queryKey: specQueryKey(productId, spec?.id),
    queryFn: () => fetchJson<SpecDetail>(`/products/${productId}/specs/${spec!.id}`),
    enabled: spec !== null,
  });
  const busy = actions.busy;
  /** 展开着的票。关掉弹窗即清空,下一次打开从全收起开始。 */
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  /** 要去的那一张:内容一到就展开它、把那一行滚进视野。换了 spec 时等新的那一份读到再滚。 */
  const loadedSpecId = detail.data?.spec.id;
  useEffect(() => {
    if (focus === null || loadedSpecId !== spec?.id) return;
    setExpanded((prev) => new Set(prev).add(focus.ticketId));
    requestAnimationFrame(() =>
      document
        .querySelector(`[data-ticket-row="${focus.ticketId}"]`)
        ?.scrollIntoView({
          block: "start",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        }),
    );
  }, [focus, loadedSpecId, spec?.id]);

  return (
    <Dialog.Root
      open={spec !== null}
      onOpenChange={(next) => {
        if (!next) {
          actions.clearFailure();
          setExpanded(new Set());
          onClose();
        }
      }}
    >
      <Dialog.Content
        maxWidth="980px"
        size={{ initial: "2", sm: "3" }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {/* 关闭键在标题行右端(issue #390)。与仓库配置弹窗同一形状。 */}
        <div className="flex items-start justify-between gap-3">
          <Dialog.Title size="5" mb="2" className="min-w-0 break-words">
            {spec?.title ?? ""}
          </Dialog.Title>
          <Dialog.Close>
            <IconButton
              type="button"
              variant="ghost"
              color="gray"
              size={{ initial: "3", sm: "1" }}
              className="shrink-0"
              aria-label="关闭"
            >
              <Cross2Icon aria-hidden />
            </IconButton>
          </Dialog.Close>
        </div>
        {/* 标题下那一行照 GitHub issue 头:状态胶囊,再跟几件事实。 */}
        <Dialog.Description size="2" color="gray" mb="4" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {spec === null ? null : spec.state === "open" ? (
              <Badge color="green" variant="soft" size="2" radius="full">
                <RadiobuttonIcon aria-hidden />
                开着
              </Badge>
            ) : (
              <Badge color="gray" variant="soft" size="2" radius="full">
                <CheckCircledIcon aria-hidden />
                已关
              </Badge>
            )}
            {detail.data === undefined ? null : (
              <span>
                <span className="font-mono tabular-nums">{detail.data.tickets.length}</span> 张票 · 建于{" "}
                {localMinute(detail.data.spec.createdAt)}
              </span>
            )}
        </Dialog.Description>
        {actions.failure === null ? null : (
          <Callout.Root role="alert" color="red" size="1" mb="3">
            <Callout.Icon>
              <CrossCircledIcon aria-hidden />
            </Callout.Icon>
            <Callout.Text>{actions.failure}</Callout.Text>
          </Callout.Root>
        )}
        {detail.isPending ? (
          <Skeleton aria-hidden className="h-64" />
        ) : detail.error !== null ? (
          <Text as="p" size="2" color="red">
            {(detail.error as Error).message}
          </Text>
        ) : (
          // `relative`:里面任何绝对定位的东西都按这一格定位,不漏到弹窗外层去撑它的滚动高度。
          // 横向不滚:ghost 键的负外边距会多出几像素,`-mx-1 px-1` 给焦点环留位置。
          <div className="relative -mx-1 max-h-[min(70vh,720px)] min-w-0 overflow-x-hidden overflow-y-auto px-1 max-sm:max-h-[58dvh]">
            <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_13rem]">
              {/* 侧栏照 GitHub issue 页右侧:进度、看板分布、动作。`md` 以下排到正文之前,
                  动作不必滚过整篇正文才够得着。 */}
              <aside className="flex min-w-0 flex-col gap-4 text-base md:sticky md:top-0 md:order-last md:self-start">
                {detail.data.tickets.length === 0 ? null : (
                  <SidebarBlock title="进度">
                    {(() => {
                      const total = detail.data.tickets.length;
                      const done = detail.data.tickets.filter((ticket) => ticket.state === "closed").length;
                      return (
                        <>
                          <div
                            role="progressbar"
                            aria-label="票的进度"
                            aria-valuemin={0}
                            aria-valuemax={total}
                            aria-valuenow={done}
                            className="h-1.5 overflow-hidden rounded-full bg-accent-track"
                          >
                            <div className="h-full rounded-full bg-primary" style={{ width: `${(done / total) * 100}%` }} />
                          </div>
                          <span className="text-text-secondary">
                            <span className="font-mono tabular-nums">
                              {done}/{total}
                            </span>{" "}
                            张已关
                          </span>
                        </>
                      );
                    })()}
                  </SidebarBlock>
                )}
                {detail.data.tickets.length === 0 ? null : (
                  // `md` 以下侧栏排在正文之前,这一段让位:四个数在票行的图标上都读得到。
                  <SidebarBlock title="票的状态" className="max-md:hidden">
                    <ul className="flex flex-col gap-1">
                      {TICKET_STATUSES.map(({ status, title }) => {
                        const count = detail.data.tickets.filter((ticket) => statuses.get(ticket.id) === status).length;
                        return (
                          <li key={status} className={cn("flex items-center gap-2", count === 0 && "text-text-disabled")}>
                            <TicketStatusIcon status={status} className={count === 0 ? "opacity-40" : undefined} />
                            <span className="grow">{title}</span>
                            <span className="font-mono tabular-nums">{count}</span>
                          </li>
                        );
                      })}
                    </ul>
                  </SidebarBlock>
                )}
                {(() => {
                  // 这条 spec 里被挡过的票,连同挡着它的每一张(关了的也列,划掉)。宽屏才画:
                  // 窄屏侧栏排在正文前,票行上那句「等 #n」已经点得到。
                  const blocked = detail.data.tickets.filter((ticket) => ticket.blockedBy.length > 0);
                  return blocked.length === 0 ? null : (
                    <SidebarBlock title="依赖" className="max-md:hidden">
                      <ul className="flex flex-col gap-1.5">
                        {blocked.map((ticket) => (
                          <li key={ticket.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <BlockerLink id={ticket.id} onJump={onJump} />
                            <span className="text-text-muted">等</span>
                            {ticket.blockedBy.map((id) => (
                              <BlockerLink key={id} id={id} closed={!openTickets.has(id)} onJump={onJump} />
                            ))}
                          </li>
                        ))}
                      </ul>
                    </SidebarBlock>
                  );
                })()}
                <SidebarBlock title="操作">
                  <div className="flex flex-wrap gap-2 md:flex-col md:items-start">
                    <Button asChild variant="soft" color="gray" size="1" className="pointer-coarse:min-h-11">
                      <a
                        href={apiUrl(`/products/${productId}/specs/${detail.data.spec.id}/export`)}
                        download={`${detail.data.spec.title}.md`}
                      >
                        导出 Markdown
                      </a>
                    </Button>
                    {canChat ? (
                      <Button
                        size="1"
                        variant="soft"
                        color="gray"
                        className="pointer-coarse:min-h-11"
                        disabled={busy}
                        onClick={(event) =>
                          // 关要先问一句(issue #389);重新打开照旧点完就写——它把状态放回去,误触没有代价。
                          detail.data.spec.state === "open"
                            ? actions.requestClose(event, {
                                kind: "spec",
                                id: detail.data.spec.id,
                                title: detail.data.spec.title,
                              })
                            : actions.spec(detail.data.spec.id, "open")
                        }
                      >
                        {detail.data.spec.state === "open" ? "关掉这条 spec" : "重新打开这条 spec"}
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-sm text-text-muted">正文由会话写，这里只读。</p>
                </SidebarBlock>
              </aside>

              <div className="flex min-w-0 flex-col gap-4">
                <Markdown text={detail.data.spec.body} />
                {/*
                  一张票一行,形状照 GitHub 的子 issue:状态图标、标题、标签,动作贴着标题那一行——
                  收起时也要认领得了、改得了标签;正文与评论点开才展开(一条 spec 常带十来张票,
                  全摊开要滚半天才找得到要动的那一张)。
                */}
                {detail.data.tickets.length === 0 ? null : (
                  <h3 className="flex items-center gap-1.5 border-t border-line pt-4 text-lg font-semibold">
                    票
                    <span className="font-mono text-xs font-normal text-text-muted tabular-nums">
                      {detail.data.tickets.length}
                    </span>
                  </h3>
                )}
                {detail.data.tickets.length === 0 ? null : (
                  <div className="min-w-0 overflow-hidden rounded-[var(--v8-radius-control)] border border-card-line">
                    {detail.data.tickets.map((ticket) => {
                      const status = statuses.get(ticket.id) ?? "ready";
                      return (
                        <section
                          key={ticket.id}
                          data-ticket-row={ticket.id}
                          className="flex min-w-0 scroll-mt-2 flex-col border-t border-line first:border-t-0"
                        >
                          <Collapsible.Root
                            open={expanded.has(ticket.id)}
                            onOpenChange={(open) =>
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (open) next.add(ticket.id);
                                else next.delete(ticket.id);
                                return next;
                              })
                            }
                            className="group/ticket flex min-w-0 flex-col"
                          >
                            <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2 group-data-[state=open]/ticket:bg-sunken">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                              <Collapsible.Trigger asChild>
                                {/* 原生 button,触控高度自己给(DESIGN.md 6.1 触控):coarse 块只发给
                                    Radix 类名。 */}
                                <button
                                  type="button"
                                  className="flex min-w-[12rem] grow basis-0 items-start gap-2 rounded-md py-0.5 text-left transition-colors pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
                                >
                                  <ChevronRightIcon
                                    aria-hidden
                                    className="mt-0.5 shrink-0 text-text-muted transition-transform group-data-[state=open]/ticket:rotate-90"
                                  />
                                  <TicketStatusIcon status={status} className="mt-0.5" />
                                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                                    <Text
                                      as="span"
                                      size="3"
                                      weight="medium"
                                      className={cn(
                                        "min-w-0 break-words",
                                        ticket.state === "closed" && "text-text-secondary",
                                      )}
                                    >
                                      {ticket.title}
                                    </Text>
                                    <Badge color={LABEL_COLOR[ticket.label]} variant="soft" size="1">
                                      {ticket.label}
                                    </Badge>
                                  </span>
                                </button>
                              </Collapsible.Trigger>
                              {canChat ? <TicketActions ticket={ticket} actions={actions} className="pl-1" /> : null}
                            </div>
                            {/* 标题下那一行放在展开键之外:阻塞的票号要能单独点,键里不能再套键。
                                左缩进让开 chevron 与状态图标两格,与标题的字对齐。 */}
                            <TicketMeta
                              ticket={ticket}
                              openTickets={openTickets}
                              pickable={pickable.has(ticket.id)}
                              onJump={onJump}
                              className="pl-[47px]"
                            />
                            </div>
                            <Collapsible.Content className="collapsible-motion">
                              {/* 正文缩进到标题的字下面(让开 chevron 与状态图标两格)。 */}
                              <div className="flex min-w-0 flex-col gap-2 border-t border-line px-3 py-3 sm:pl-[3.25rem]">
                                <Markdown text={ticket.body} />
                                {/* 评论整段显示,不折叠:一张票上的来龙去脉就这几条。 */}
                                {ticket.comments.length === 0 ? null : (
                                  <ul className="flex min-w-0 flex-col gap-2 border-t border-line pt-2">
                                    {ticket.comments.map((comment) => (
                                      <li key={comment.id} className="flex min-w-0 flex-col gap-0.5">
                                        <span className="text-sm text-text-muted">
                                          <span className="font-semibold text-text-secondary">{comment.author ?? "会话"}</span>
                                          {" · "}
                                          {localMinute(comment.createdAt)}
                                        </span>
                                        <Text as="p" size="2" className="break-words whitespace-pre-wrap">
                                          {comment.body}
                                        </Text>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                                {canChat ? (
                                  <CommentBox busy={busy} onSend={(text) => actions.comment(ticket.id, text)} />
                                ) : null}
                              </div>
                            </Collapsible.Content>
                          </Collapsible.Root>
                        </section>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {actions.confirm}
      </Dialog.Content>
    </Dialog.Root>
  );
}
