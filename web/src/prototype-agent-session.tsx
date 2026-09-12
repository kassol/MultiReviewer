// 原型:三种会话页布局,?variant= 切换,/prototype/agent-session 路由,回答 issue #324。一次性代码,不进 main。
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  Cross2Icon,
  ExclamationTriangleIcon,
  ImageIcon,
  MagnifyingGlassIcon,
  PaperPlaneIcon,
  PlusIcon,
  ReaderIcon,
  StopIcon,
  TrashIcon,
} from "@radix-ui/react-icons";
import {
  Badge,
  Callout,
  DropdownMenu,
  IconButton,
  SegmentedControl,
  Select,
  Separator,
  Switch,
  Table,
  Text,
  TextArea,
  Tooltip,
} from "@radix-ui/themes";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { MasterListItem, MasterListItemText } from "@/components/master-list-item";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/theme-button";

/* ──────────────────────────── 假数据 ──────────────────────────── */

const ME = "张旭";

const PRODUCT = {
  name: "报销系统",
  repos: ["expense/frontend", "expense/backend", "expense/mobile"],
} as const;

const OTHER_PRODUCTS = ["考勤系统", "合同中心"] as const;

type SessionBrief = { id: number; title: string; at: string; running: boolean };

const SESSIONS: readonly SessionBrief[] = [
  { id: 1, title: "差旅报销单支持多币种", at: "今天 10:24", running: true },
  { id: 2, title: "审批流加代理人", at: "9 月 9 日", running: false },
];

type QueueMode = "followUp" | "steer";
type Queued = { id: number; mode: QueueMode; text: string };

type Msg = {
  id: number;
  kind: "user" | "assistant" | "system";
  at: string;
  text: string;
  streaming?: boolean;
  tool?: { name: string; target: string; running: boolean };
  artifactVersion?: number;
};

const EARLIER_MESSAGES: readonly Msg[] = [
  { id: 9, kind: "user", at: "9 月 11 日 17:40", text: "先别拆,帮我看看现在报销单的币种字段是怎么存的。" },
  { id: 10, kind: "assistant", at: "9 月 11 日 17:41", text: "只有一个 amount 字段,单位写死人民币;三个仓库都没有币种概念。" },
];

const BASE_MESSAGES: readonly Msg[] = [
  { id: 11, kind: "user", at: "10:02", text: "需求:差旅报销单要支持多币种。员工按原币录入,财务按月结汇率折算成人民币报账。" },
  { id: 12, kind: "assistant", at: "10:02", text: "先确认三点:1) 月结汇率从哪来,人工维护还是外部取?2) 已提交未审批的单子跟不跟新汇率?3) 移动端这期要不要一起改?" },
  { id: 13, kind: "user", at: "10:05", text: "1) 财务每月手填一张表。2) 不跟,锁定提交那一刻的汇率。3) 移动端这期只读展示。" },
  { id: 14, kind: "assistant", at: "10:05", text: "够了,我读一遍三个仓库的落点再拆。" },
  { id: 15, kind: "assistant", at: "10:06", text: "", tool: { name: "grep", target: "currency 在 expense/backend", running: false } },
  { id: 16, kind: "assistant", at: "10:08", text: "第一版需求拆分已交:三条拆分条目,后端两条、前端一条。", artifactVersion: 1 },
  { id: 17, kind: "user", at: "10:18", text: "第二版把移动端也拆出来,另外把汇率表的来源写进验收要点。" },
  { id: 18, kind: "assistant", at: "10:18", text: "好,我再看一眼 backend 的汇率表和 mobile 的报销单详情页。" },
  { id: 19, kind: "assistant", at: "10:19", text: "", tool: { name: "grep", target: "exchange_rate 在 expense/backend、expense/mobile", running: false } },
  { id: 20, kind: "assistant", at: "10:22", text: "第二版需求拆分已交:五条拆分条目,补了汇率表维护页与移动端只读展示。", artifactVersion: 2 },
  { id: 21, kind: "system", at: "10:23", text: "辅助模型已切换为 anthropic:claude-opus-5(high),子进程已重建。这条系统消息不进模型上下文。" },
  { id: 22, kind: "assistant", at: "10:24", text: "正在按已定稿的 v1 复核依赖条目,前端那条要等后端的汇率字段先落地", streaming: true },
  { id: 23, kind: "assistant", at: "10:24", text: "", tool: { name: "grep", target: "submitted_rate 在 expense/frontend", running: true } },
];

const BASE_QUEUE: readonly Queued[] = [
  { id: 101, mode: "followUp", text: "再补一条:财务导出 Excel 要加原币与折算后两列。" },
  { id: 102, mode: "steer", text: "先别管移动端,优先把后端汇率表的落点定下来。" },
];

type BreakdownItem = {
  title: string;
  desc: string;
  repo: string;
  spot: string;
  deps: string;
  accept: string;
};

type Breakdown = {
  version: number;
  at: string;
  toolCall: string;
  summary: { brief: string; assumptions: readonly string[]; open: readonly string[] };
  items: readonly BreakdownItem[];
};

const ITEM_RATE_TABLE: BreakdownItem = {
  title: "月结汇率表与维护接口",
  desc: "新增月结汇率表,按「年月 + 币种」唯一,财务手工维护;提供读写接口。",
  repo: "expense/backend",
  spot: "src/finance/exchange-rate/",
  deps: "无",
  accept: "同一年月同一币种只存一条;改历史月份不影响已提交单据。",
};

const ITEM_CLAIM_CURRENCY: BreakdownItem = {
  title: "报销单按原币录入",
  desc: "报销单明细加币种与原币金额,提交时锁定当月汇率写入折算金额。",
  repo: "expense/backend",
  spot: "src/expense/claim/submit.ts",
  deps: "月结汇率表与维护接口",
  accept: "提交后改汇率表,单据折算金额不变;缺当月汇率时提交被拒并提示。",
};

const ITEM_WEB_FORM: BreakdownItem = {
  title: "填单页币种选择与双金额显示",
  desc: "填单页加币种下拉,列表与详情同时显示原币与折算后金额。",
  repo: "expense/frontend",
  spot: "src/pages/claim/ClaimForm.tsx",
  deps: "报销单按原币录入",
  accept: "切币种后折算金额即时刷新;历史单据仍按锁定汇率展示。",
};

const ITEM_RATE_ADMIN: BreakdownItem = {
  title: "汇率表维护页",
  desc: "财务角色按月录入、修改本月汇率,改动留痕。",
  repo: "expense/frontend",
  spot: "src/pages/finance/ExchangeRate.tsx",
  deps: "月结汇率表与维护接口",
  accept: "非财务角色看不到入口;保存后列表即时反映新值。",
};

const ITEM_MOBILE_READ: BreakdownItem = {
  title: "移动端报销单只读双金额",
  desc: "详情页展示原币与折算后金额,本期不支持移动端填单。",
  repo: "expense/mobile",
  spot: "lib/pages/claim_detail.dart",
  deps: "填单页币种选择与双金额显示",
  accept: "老接口返回无币种字段时回落显示人民币,不崩。",
};

const BREAKDOWNS: readonly Breakdown[] = [
  {
    version: 1,
    at: "2026-09-12 10:08",
    toolCall: "submit_requirement_breakdown · call_8f21",
    summary: {
      brief: "报销单支持多币种:员工按原币录入,提交时锁定当月汇率,财务按折算后金额报账。",
      assumptions: ["月结汇率由财务手工维护,不接外部汇率源", "单据提交后汇率锁定,不随汇率表变动"],
      open: ["历史单据要不要补币种字段", "移动端这期做到什么程度"],
    },
    items: [ITEM_RATE_TABLE, ITEM_CLAIM_CURRENCY, ITEM_WEB_FORM],
  },
  {
    version: 2,
    at: "2026-09-12 10:22",
    toolCall: "submit_requirement_breakdown · call_a3c7",
    summary: {
      brief: "在 v1 基础上补齐汇率表维护页与移动端只读展示,三个仓库各有落点。",
      assumptions: ["月结汇率由财务手工维护,不接外部汇率源", "移动端本期只读,不支持原币填单"],
      open: ["导出 Excel 的列顺序待财务确认"],
    },
    items: [ITEM_RATE_TABLE, ITEM_CLAIM_CURRENCY, ITEM_WEB_FORM, ITEM_RATE_ADMIN, ITEM_MOBILE_READ],
  },
];

function breakdownOf(version: number): Breakdown {
  return BREAKDOWNS.find((item) => item.version === version) ?? BREAKDOWNS[0]!;
}

function titleOf(sessionId: number): string {
  return SESSIONS.find((item) => item.id === sessionId)?.title ?? "";
}

/* ──────────────────────────── 本地状态 ──────────────────────────── */

type Finalized = { version: number; who: string; when: string };

function stamp(): string {
  return new Date().toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-");
}

function clock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function usePrototypeSession() {
  const [sessionId, setSessionId] = useState(1);
  const [messages, setMessages] = useState<readonly Msg[]>(BASE_MESSAGES);
  const [queue, setQueue] = useState<readonly Queued[]>(BASE_QUEUE);
  const [running, setRunning] = useState(true);
  const [earlierLoaded, setEarlierLoaded] = useState(false);
  const [truncatedCount, setTruncatedCount] = useState(7);
  const [version, setVersion] = useState(2);
  const [finalized, setFinalized] = useState<Finalized | null>({ version: 1, who: ME, when: "2026-09-12 10:24" });
  const [records, setRecords] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState(0);
  const [mode, setMode] = useState<QueueMode>("followUp");
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  // 两个原型开关,切换条在底部那根切换栏上:权限格 repo:write、辅助模型收不收图。
  const [canWrite, setCanWrite] = useState(true);
  const [modelSupportsImages, setModelSupportsImages] = useState(true);

  const nextId = useRef(1000);
  const takeId = () => ++nextId.current;

  return {
    sessionId,
    selectSession: (value: number) => {
      setSessionId(value);
      setRunning(value === 1);
    },
    messages,
    queue,
    running,
    earlierLoaded,
    truncatedCount,
    version,
    setVersion,
    finalized,
    records,
    error,
    images,
    mode,
    setMode,
    draft,
    setDraft,
    copied,
    canWrite,
    setCanWrite,
    modelSupportsImages,
    setModelSupportsImages,
    dismissError: () => setError(null),
    /** 名额全满那条 409 的桩:这条路上的错误长什么样。 */
    simulate409: () => setError("名额已满,稍后再发"),
    send: () => {
      const text = draft.trim();
      if (text === "") return;
      setDraft("");
      setImages(0);
      setError(null);
      if (running) {
        setQueue((prev) => [...prev, { id: takeId(), mode, text }]);
        return;
      }
      setMessages((prev) => [...prev, { id: takeId(), kind: "user", at: clock(), text }]);
      setRunning(true);
    },
    stop: () => {
      setRunning(false);
      setMessages((prev) => [
        ...prev
          .filter((item) => item.tool?.running !== true)
          .map((item) => (item.streaming === true ? { ...item, streaming: false } : item)),
        {
          id: takeId(),
          kind: "system",
          at: clock(),
          text: `${ME} 点了停止:已中止当前这一步,${queue.length} 条排队消息保留,下次开跑时投递。`,
        },
      ]);
    },
    clearQueue: () => setQueue([]),
    loadEarlier: () => {
      setEarlierLoaded(true);
      setMessages((prev) => [...EARLIER_MESSAGES, ...prev]);
      setTruncatedCount(5);
    },
    addImage: () => setImages((prev) => Math.min(4, prev + 1)),
    finalize: (value: number) => {
      const previous = finalized;
      setFinalized({ version: value, who: ME, when: stamp() });
      if (previous !== null && previous.version !== value) {
        setRecords((prev) => [...prev, `换版记录:定稿从 v${previous.version} 换成 v${value} · ${ME} · ${stamp()}`]);
      }
    },
    copyMarkdown: () => {
      void navigator.clipboard.writeText(toMarkdown(breakdownOf(version)));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    },
  };
}

type Session = ReturnType<typeof usePrototypeSession>;

function toMarkdown(breakdown: Breakdown): string {
  const lines = [
    `# 需求拆分 v${breakdown.version}`,
    "",
    "## 总述",
    `需求概要:${breakdown.summary.brief}`,
    "",
    "假设:",
    ...breakdown.summary.assumptions.map((item) => `- ${item}`),
    "",
    "未决问题:",
    ...breakdown.summary.open.map((item) => `- ${item}`),
    "",
    "## 拆分条目",
  ];
  for (const item of breakdown.items) {
    lines.push(
      "",
      `### ${item.title}`,
      `- 描述:${item.desc}`,
      `- 所属仓库:${item.repo}`,
      `- 落点:${item.spot}`,
      `- 依赖条目:${item.deps}`,
      `- 验收要点:${item.accept}`,
    );
  }
  return lines.join("\n");
}

/* ──────────────────────────── 共用块 ──────────────────────────── */

function TruncationBanner({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Callout.Root color="amber" size="1">
      <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
      <Callout.Text>记录链不完整,前 {count} 条不在上下文。续谈照常,agent 看不到那几条。</Callout.Text>
    </Callout.Root>
  );
}

function TokenLine() {
  return (
    <Text size="1" color="gray">
      会话 token 用量:输入 1,284,300 · 输出 96,240 · 缓存命中 742,100(与 Review Run 的用量分开计)
    </Text>
  );
}

function ToolRow({ tool }: { tool: NonNullable<Msg["tool"]> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-sunken px-3 py-2">
      <MagnifyingGlassIcon aria-hidden className="size-3.5 text-text-muted" />
      <Text size="1" color="gray">
        {tool.running ? "在跑工具 " : "已跑工具 "}
        <span className="font-mono">{tool.name}</span> {tool.target}
      </Text>
      {tool.running ? <StatusBadge tone="running">在跑</StatusBadge> : null}
    </div>
  );
}

function ArtifactCard({ version, onOpen }: { version: number; onOpen: (version: number) => void }) {
  const breakdown = breakdownOf(version);
  return (
    <button
      type="button"
      onClick={() => onOpen(version)}
      className="w-full rounded-2xl border border-card-line bg-surface px-3.5 py-3 text-left transition-colors hover:bg-sunken"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ReaderIcon aria-hidden className="size-4 text-text-muted" />
        <Text size="2" weight="bold">会话产出 · 需求拆分 v{breakdown.version}</Text>
        <Badge color="gray" variant="soft">{breakdown.items.length} 条拆分条目</Badge>
      </div>
      <Text as="p" size="1" color="gray" className="mt-1">{breakdown.summary.brief}</Text>
      <Text as="p" size="1" color="blue" className="mt-1">点开看总述与全部条目</Text>
    </button>
  );
}

function MessageRow({ msg, onOpenArtifact }: { msg: Msg; onOpenArtifact: ((version: number) => void) | null }) {
  if (msg.tool !== undefined) return <ToolRow tool={msg.tool} />;
  if (msg.kind === "system") {
    return (
      <div className="rounded-xl bg-sunken px-3 py-2">
        <Text size="1" color="gray">系统 · {msg.at} · {msg.text}</Text>
      </div>
    );
  }
  const mine = msg.kind === "user";
  return (
    <div className={mine ? "flex justify-end" : "flex justify-start"}>
      <div className="flex min-w-0 max-w-[46rem] flex-col gap-1.5">
        <Text size="1" color="gray" className={mine ? "self-end" : ""}>{mine ? ME : "agent"} · {msg.at}</Text>
        <div
          className={
            mine
              ? "rounded-2xl bg-accent-tint px-3.5 py-2.5 text-base"
              : "rounded-2xl border border-card-line bg-surface px-3.5 py-2.5 text-base"
          }
        >
          {msg.text}
          {msg.streaming === true ? <span className="ml-0.5 inline-block animate-pulse font-bold">▍</span> : null}
        </div>
        {msg.artifactVersion !== undefined && onOpenArtifact !== null ? (
          <ArtifactCard version={msg.artifactVersion} onOpen={onOpenArtifact} />
        ) : null}
      </div>
    </div>
  );
}

function QueuePanel({ session }: { session: Session }) {
  if (session.queue.length === 0) {
    return <Text size="1" color="gray">排队消息:无</Text>;
  }
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-line bg-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text size="1" weight="bold">排队消息 {session.queue.length} 条</Text>
        {/* Pi 只给整队清空,单条撤回不支持(issue #320),所以这里只有这一个动作。 */}
        <Button size="1" variant="soft" color="gray" onClick={session.clearQueue}>
          <TrashIcon /> 清空队列
        </Button>
      </div>
      {session.queue.map((item) => (
        <div key={item.id} className="flex min-w-0 items-start gap-2">
          <Badge color={item.mode === "steer" ? "orange" : "gray"} variant="soft">
            {item.mode === "steer" ? "插话" : "排队"}
          </Badge>
          <Text size="1" className="min-w-0 flex-1">{item.text}</Text>
        </div>
      ))}
      <Text size="1" color="gray">单条撤回不支持,只能整队清空。</Text>
    </div>
  );
}

function Composer({ session }: { session: Session }) {
  return (
    <div className="flex flex-col gap-2.5 border-t border-line bg-surface px-3 py-3 sm:px-4">
      {session.error === null ? null : (
        <Callout.Root color="red" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text className="flex-1">{session.error}</Callout.Text>
          <Button size="1" variant="ghost" color="gray" onClick={session.dismissError}>知道了</Button>
        </Callout.Root>
      )}
      <QueuePanel session={session} />
      <TextArea
        size="2"
        rows={3}
        placeholder="给 agent 说需求,或补充一轮。"
        value={session.draft}
        onChange={(event) => session.setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl.Root
          size="1"
          value={session.mode}
          onValueChange={(value) => session.setMode(value as QueueMode)}
        >
          <SegmentedControl.Item value="followUp">排队(followUp)</SegmentedControl.Item>
          <SegmentedControl.Item value="steer">插话(steer)</SegmentedControl.Item>
        </SegmentedControl.Root>
        <Tooltip
          content={
            session.modelSupportsImages
              ? "一条消息最多 4 张图片"
              : "当前辅助模型不支持图片,换一个支持图片的辅助模型"
          }
        >
          <span className="inline-flex">
            <Button
              size="1"
              variant="soft"
              color="gray"
              disabled={!session.modelSupportsImages || session.images >= 4}
              onClick={session.addImage}
            >
              <ImageIcon /> 图片 {session.images}/4
            </Button>
          </span>
        </Tooltip>
        <div className="flex-1" />
        <Button size="1" variant="ghost" color="gray" onClick={session.simulate409}>模拟 409</Button>
        <Button size="1" variant="soft" color="red" disabled={!session.running} onClick={session.stop}>
          <StopIcon /> 停止
        </Button>
        <Button size="1" onClick={session.send}>
          <PaperPlaneIcon /> {session.running ? (session.mode === "steer" ? "插话" : "排队") : "发送"}
        </Button>
      </div>
      <Text size="1" color="gray">
        {session.mode === "steer"
          ? "插话在下一个回合边界才生效,不打断当前工具批次。"
          : "排队消息等当前这一轮跑完按顺序投递。"}
        {" 停止只中止当前这一步,排队消息保留。"}
      </Text>
      <TokenLine />
    </div>
  );
}

/** 消息流。`onOpenArtifact` 为 null 时不在流里挂产出卡片(三栏档与表格档各有自己的产出区)。 */
function Conversation({
  session,
  onOpenArtifact,
}: {
  session: Session;
  onOpenArtifact: ((version: number) => void) | null;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  // 打开一个旧会话就停在最新一条:更早的历史在上面,要看自己点。
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [session.sessionId]);
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
      <div className="mx-auto flex w-full max-w-[62rem] flex-col gap-3">
        <div className="flex justify-center">
          {session.earlierLoaded ? (
            <Text size="1" color="gray">已到最早一条</Text>
          ) : (
            <Button size="1" variant="soft" color="gray" onClick={session.loadEarlier}>
              <ChevronUpIcon /> 加载更早的消息
            </Button>
          )}
        </div>
        <TruncationBanner count={session.truncatedCount} />
        {session.messages.map((msg) => (
          <MessageRow key={msg.id} msg={msg} onOpenArtifact={onOpenArtifact} />
        ))}
        {session.running ? (
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="running">在跑</StatusBadge>
            <Text size="1" color="gray">流式 delta 不落库,断线不回放;重连只补落库的条目。</Text>
          </div>
        ) : (
          <Text size="1" color="gray">空闲。满 10 分钟没动静子进程被回收,下次发消息重建。</Text>
        )}
      </div>
    </div>
  );
}

function VersionPicker({ session }: { session: Session }) {
  return (
    <Select.Root size="1" value={String(session.version)} onValueChange={(value) => session.setVersion(Number(value))}>
      <Select.Trigger />
      <Select.Content>
        {BREAKDOWNS.map((breakdown) => (
          <Select.Item key={breakdown.version} value={String(breakdown.version)}>
            v{breakdown.version} · {breakdown.items.length} 条 · {breakdown.at.slice(11)}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function FinalizeRow({ session }: { session: Session }) {
  const current = session.version;
  const finalized = session.finalized;
  const isFinalized = finalized !== null && finalized.version === current;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {isFinalized ? (
          <StatusBadge tone="success">v{current} 已定稿</StatusBadge>
        ) : (
          <Button size="1" onClick={() => session.finalize(current)}>
            {finalized === null ? `定稿 v${current}` : `换版到 v${current}`}
          </Button>
        )}
        <Button size="1" variant="soft" color="gray" onClick={session.copyMarkdown}>
          {session.copied ? <CheckCircledIcon /> : <CopyIcon />} {session.copied ? "已复制" : "复制为 Markdown"}
        </Button>
      </div>
      {finalized === null ? (
        <Text size="1" color="gray">还没有定稿版。</Text>
      ) : (
        <Text size="1" color="gray">
          定稿 v{finalized.version} · {finalized.who} · {finalized.when} · 定稿版不可改,进模型上下文
        </Text>
      )}
      {session.records.map((record) => (
        <Text key={record} size="1" color="gray">{record}</Text>
      ))}
    </div>
  );
}

function Summary({ breakdown }: { breakdown: Breakdown }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-card-line bg-surface p-3.5">
      <Text size="2" weight="bold">总述</Text>
      <Text size="2">需求概要:{breakdown.summary.brief}</Text>
      <div>
        <Text size="1" weight="bold" color="gray">假设</Text>
        <ul className="ml-4 list-disc">
          {breakdown.summary.assumptions.map((item) => (
            <li key={item}><Text size="1" color="gray">{item}</Text></li>
          ))}
        </ul>
      </div>
      <div>
        <Text size="1" weight="bold" color="gray">未决问题</Text>
        <ul className="ml-4 list-disc">
          {breakdown.summary.open.map((item) => (
            <li key={item}><Text size="1" color="gray">{item}</Text></li>
          ))}
        </ul>
      </div>
      <Text size="1" color="gray">来自工具调用 {breakdown.toolCall}</Text>
    </div>
  );
}

function ItemList({ breakdown }: { breakdown: Breakdown }) {
  return (
    <div className="flex flex-col gap-2">
      <Text size="2" weight="bold">拆分条目 {breakdown.items.length} 条</Text>
      {breakdown.items.map((item) => (
        <div key={item.title} className="flex flex-col gap-1 rounded-2xl border border-card-line bg-surface p-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Text size="2" weight="bold">{item.title}</Text>
            <Badge color="gray" variant="soft">{item.repo}</Badge>
          </div>
          <Text size="1" color="gray">{item.desc}</Text>
          <Text size="1" color="gray">落点:<span className="font-mono">{item.spot}</span></Text>
          <Text size="1" color="gray">依赖条目:{item.deps}</Text>
          <Text size="1" color="gray">验收要点:{item.accept}</Text>
        </div>
      ))}
    </div>
  );
}

function ItemTable({ breakdown }: { breakdown: Breakdown }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-card-line bg-surface">
      <Table.Root size="1">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>标题</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>所属仓库</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>落点</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>依赖条目</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>验收要点</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {breakdown.items.map((item) => (
            <Table.Row key={item.title}>
              <Table.Cell>
                <Text size="2" weight="bold">{item.title}</Text>
                <Text as="p" size="1" color="gray">{item.desc}</Text>
              </Table.Cell>
              <Table.Cell><Badge color="gray" variant="soft">{item.repo}</Badge></Table.Cell>
              <Table.Cell><span className="font-mono text-sm">{item.spot}</span></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{item.deps}</Text></Table.Cell>
              <Table.Cell><Text size="1" color="gray">{item.accept}</Text></Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </div>
  );
}

function ArtifactPanel({ session }: { session: Session }) {
  const breakdown = breakdownOf(session.version);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Text size="2" weight="bold">会话产出 · 需求拆分</Text>
        <VersionPicker session={session} />
      </div>
      <FinalizeRow session={session} />
      <Separator size="4" />
      <Summary breakdown={breakdown} />
      <ItemList breakdown={breakdown} />
    </div>
  );
}

/** 抄阶段页那一档侧滑的形状:桌面从右侧滑入,窄视口从底部升起。 */
function PrototypeDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById("panel-portal")), []);
  if (host === null) return null;
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal container={host}>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          style={{ backdropFilter: "var(--v8-drawer-blur)" }}
          className="fixed inset-x-0 bottom-0 z-50 flex h-[86dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-[color:var(--v8-drawer-bg)] shadow-overlay outline-none md:inset-y-3.5 md:right-3.5 md:left-auto md:h-auto md:w-[min(720px,calc(100vw-28px))] md:rounded-3xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-overlay-line px-4 py-3">
            <Dialog.Title className="text-3xl font-semibold">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton variant="ghost" color="gray" size="2" aria-label={`关闭${title}`}><Cross2Icon /></IconButton>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ──────────────────────────── A 三栏工作台 ──────────────────────────── */

function VariantA({ session }: { session: Session }) {
  const [product, setProduct] = useState<string>(PRODUCT.name);
  return (
    <div className="flex h-dvh min-h-0">
      <aside className="flex w-[17rem] shrink-0 flex-col overflow-y-auto border-r border-line bg-surface max-lg:hidden">
        <div className="flex flex-col gap-1 px-3 py-3">
          <Text size="1" weight="bold" color="gray">产品</Text>
          {[PRODUCT.name, ...OTHER_PRODUCTS].map((name) => (
            <MasterListItem
              key={name}
              selected={name === product}
              onClick={() => setProduct(name)}
              className="rounded-lg px-3 py-2"
            >
              <Text size="2">{name}</Text>
            </MasterListItem>
          ))}
          {session.canWrite ? (
            <div className="mt-1 flex flex-col gap-1">
              <Button size="1" variant="soft" color="gray"><PlusIcon /> 建产品</Button>
              <Button size="1" variant="soft" color="gray">归属仓库</Button>
            </div>
          ) : (
            <Text size="1" color="gray" className="mt-1">建产品与归属仓库要 repo:write。</Text>
          )}
        </div>
        <Separator size="4" />
        <div className="flex flex-col gap-1 px-3 py-3">
          <Text size="1" weight="bold" color="gray">{product} 的仓库</Text>
          {PRODUCT.repos.map((repo) => (
            <Text key={repo} size="1" color="gray" className="font-mono">{repo}</Text>
          ))}
        </div>
        <Separator size="4" />
        <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <Text size="1" weight="bold" color="gray">我的会话</Text>
            <Button size="1"><PlusIcon /> 建会话</Button>
          </div>
          {SESSIONS.map((item) => (
            <MasterListItem
              key={item.id}
              selected={item.id === session.sessionId}
              onClick={() => session.selectSession(item.id)}
              className="rounded-lg px-3 py-2"
            >
              <Text size="2" className="block truncate">{item.title}</Text>
              <MasterListItemText>{item.at}{item.running ? " · 在跑" : ""}</MasterListItemText>
            </MasterListItem>
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
          <Text size="3" weight="bold">{titleOf(session.sessionId)}</Text>
          <Badge color="gray" variant="soft">{product}</Badge>
          {session.running ? <StatusBadge tone="running">在跑</StatusBadge> : <StatusBadge tone="neutral">空闲</StatusBadge>}
        </header>
        <Conversation session={session} onOpenArtifact={null} />
        <Composer session={session} />
      </main>
      <aside className="w-[24rem] shrink-0 overflow-y-auto border-l border-line bg-sunken px-3.5 py-3.5 max-xl:hidden">
        <ArtifactPanel session={session} />
      </aside>
    </div>
  );
}

/* ──────────────────────────── B 对话为主 ──────────────────────────── */

function VariantB({ session }: { session: Session }) {
  const [drawerVersion, setDrawerVersion] = useState<number | null>(null);
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <Text size="1" color="gray">产品</Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button size="1" variant="soft" color="gray">{PRODUCT.name} <ChevronDownIcon /></Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {[PRODUCT.name, ...OTHER_PRODUCTS].map((name) => (
              <DropdownMenu.Item key={name}>{name}</DropdownMenu.Item>
            ))}
            {session.canWrite ? (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item>建产品</DropdownMenu.Item>
                <DropdownMenu.Item>归属仓库</DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Text size="1" color="gray">/</Text>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button size="1" variant="soft" color="gray">{titleOf(session.sessionId)} <ChevronDownIcon /></Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {SESSIONS.map((item) => (
              <DropdownMenu.Item key={item.id} onSelect={() => session.selectSession(item.id)}>
                {item.title} · {item.at}
              </DropdownMenu.Item>
            ))}
            <DropdownMenu.Separator />
            <DropdownMenu.Item>建会话</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        {session.running ? <StatusBadge tone="running">在跑</StatusBadge> : <StatusBadge tone="neutral">空闲</StatusBadge>}
        <div className="flex-1" />
        {session.finalized === null ? null : (
          <Text size="1" color="gray">定稿 v{session.finalized.version} · {session.finalized.who} · {session.finalized.when}</Text>
        )}
      </header>
      <Conversation session={session} onOpenArtifact={(version) => { session.setVersion(version); setDrawerVersion(version); }} />
      <Composer session={session} />
      {drawerVersion === null ? null : (
        <PrototypeDrawer title="会话产出 · 需求拆分" onClose={() => setDrawerVersion(null)}>
          <ArtifactPanel session={session} />
        </PrototypeDrawer>
      )}
    </div>
  );
}

/* ──────────────────────────── C 产出为主 ──────────────────────────── */

function VariantC({ session }: { session: Session }) {
  const [open, setOpen] = useState(true);
  const breakdown = breakdownOf(session.version);
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <Text size="3" weight="bold">{PRODUCT.name}</Text>
        <Text size="1" color="gray">/</Text>
        <Select.Root
          size="1"
          value={String(session.sessionId)}
          onValueChange={(value) => session.selectSession(Number(value))}
        >
          <Select.Trigger />
          <Select.Content>
            {SESSIONS.map((item) => (
              <Select.Item key={item.id} value={String(item.id)}>{item.title}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        <VersionPicker session={session} />
        {session.running ? <StatusBadge tone="running">在跑</StatusBadge> : <StatusBadge tone="neutral">空闲</StatusBadge>}
        <div className="flex-1" />
        {session.canWrite ? (
          <>
            <Button size="1" variant="soft" color="gray"><PlusIcon /> 建产品</Button>
            <Button size="1" variant="soft" color="gray">归属仓库</Button>
          </>
        ) : null}
        <Button size="1"><PlusIcon /> 建会话</Button>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        <TruncationBanner count={session.truncatedCount} />
        <FinalizeRow session={session} />
        <Summary breakdown={breakdown} />
        <Text size="2" weight="bold">拆分条目 {breakdown.items.length} 条</Text>
        <ItemTable breakdown={breakdown} />
        <TokenLine />
      </main>
      <section className="flex max-h-[62dvh] min-h-0 flex-col border-t border-line bg-surface">
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-left hover:bg-sunken"
        >
          {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          <Text size="2" weight="bold">对话</Text>
          <Text size="1" color="gray">
            {session.running ? "在跑 · 正在流式输出" : "空闲"} · 排队 {session.queue.length} 条
          </Text>
        </button>
        {open ? (
          <>
            <Conversation session={session} onOpenArtifact={null} />
            <Composer session={session} />
          </>
        ) : null}
      </section>
    </div>
  );
}

/* ──────────────────────────── 切换栏与页面 ──────────────────────────── */

type VariantId = "A" | "B" | "C";

const VARIANTS: readonly { id: VariantId; name: string; render: (session: Session) => ReactElement }[] = [
  { id: "A", name: "三栏工作台", render: (session) => <VariantA session={session} /> },
  { id: "B", name: "对话为主", render: (session) => <VariantB session={session} /> },
  { id: "C", name: "产出为主", render: (session) => <VariantC session={session} /> },
];

function variantIndex(value: unknown): number {
  const found = VARIANTS.findIndex((item) => item.id === value);
  return found === -1 ? 0 : found;
}

/** 输入框里按方向键是移光标,不是切档。 */
function typing(): boolean {
  const active = document.activeElement;
  if (active === null) return false;
  const tag = active.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (active as HTMLElement).isContentEditable === true;
}

function SwitcherBar({
  index,
  onStep,
  session,
}: {
  index: number;
  onStep: (delta: number) => void;
  session: Session;
}) {
  if (import.meta.env.PROD) return null;
  const current = VARIANTS[index]!;
  return (
    <div className="fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-full border border-overlay-line bg-[color:var(--v8-drawer-bg)] px-3 py-1.5 shadow-overlay">
      <IconButton size="1" variant="ghost" color="gray" aria-label="上一档" onClick={() => onStep(-1)}>
        <ArrowLeftIcon />
      </IconButton>
      <Text size="1" weight="bold">{current.id} {current.name}</Text>
      <IconButton size="1" variant="ghost" color="gray" aria-label="下一档" onClick={() => onStep(1)}>
        <ArrowRightIcon />
      </IconButton>
      <Separator orientation="vertical" size="1" />
      <Text as="label" size="1" color="gray" className="flex items-center gap-1">
        <Switch size="1" checked={session.canWrite} onCheckedChange={session.setCanWrite} /> repo:write
      </Text>
      <Text as="label" size="1" color="gray" className="flex items-center gap-1">
        <Switch size="1" checked={session.modelSupportsImages} onCheckedChange={session.setModelSupportsImages} /> 模型收图
      </Text>
    </div>
  );
}

export function PrototypeAgentSessionPage() {
  const session = usePrototypeSession();
  const navigate = useNavigate();
  const index = useRouterState({
    select: (state) => variantIndex((state.location.search as Record<string, unknown>).variant),
  });
  const step = (delta: number): void => {
    const next = VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]!;
    void navigate({ to: "/prototype/agent-session", search: { variant: next.id }, replace: true });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typing()) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="bg-background text-text">
      {VARIANTS[index]!.render(session)}
      <SwitcherBar index={index} onStep={step} session={session} />
    </div>
  );
}
