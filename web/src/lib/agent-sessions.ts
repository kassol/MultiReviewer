/**
 * Agent 会话的取值、文案与查询键(CONTEXT.md Agent 会话 / 会话用途)。产品页左栏、会话页与
 * 顶栏面包屑读的是同一份:文案摊在三处会让同一个会话在三个地方叫三个名字。
 */

/** 会话用途(CONTEXT.md 会话用途)。与服务端同一份取值。 */
export const AGENT_SESSION_PURPOSES = [
  "requirement-breakdown",
  "open-conversation",
  "product-survey",
] as const;

export type AgentSessionPurpose = (typeof AGENT_SESSION_PURPOSES)[number];

export const PURPOSE_LABEL: Record<AgentSessionPurpose, string> = {
  "requirement-breakdown": "需求拆分",
  "open-conversation": "开放对话",
  "product-survey": "产品梳理",
};

/**
 * 一个会话按仓库开在哪个 commit 上(issue #351)。`branch` 是那个 commit 来自哪条分支或哪个 Tag——
 * 没有显式选择即这个仓库生效的默认分支(CONTEXT.md 默认分支);`kind` 说是哪一种(issue #355)。
 */
export type AgentSessionBaseline = {
  owner: string;
  repo: string;
  sha: string;
  branch: string;
  kind: "branch" | "tag";
};

export type AgentSession = {
  id: number;
  productId: number;
  createdBy: string;
  purpose: AgentSessionPurpose;
  /** 「在跑」是进程内的事实,服务端每次读会话时按会话运行时覆盖这一格(issue #333)。 */
  status: "idle" | "running";
  createdAt: string;
  /** 第一条人说的话,截到 80 字;还没人说过话即 null(产品梳理恒为 null)。列表与左栏用它当会话名。 */
  title: string | null;
  /**
   * 产品梳理谈完的时刻(CONTEXT.md 产品梳理,issue #365)。别的用途恒为 null;会话头部据它
   * 显示「已谈完」,而这一场照旧读得到、创建者照旧续得了。
   */
  completedAt: string | null;
  /** 最近一条记录的时刻;没有记录时等于 createdAt。 */
  lastActiveAt: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
  };
  /** 这个会话每个仓库开在哪个 commit(issue #351)。这一票之前建的会话是空的。 */
  baselines: AgentSessionBaseline[];
};

/**
 * 服务端派生会话标题时的截断上限(`src/review/store.ts` 的 `agentSessionTitle`),与那一侧
 * 同一个数。它截得不带省略号,面板因此要自己补。
 */
const TITLE_LIMIT = 80;

/**
 * 面板上显示的会话名:标题截到上限时补一个省略号,没有标题的会话退回用途名。左栏「我的
 * 会话」、会话页头部与顶栏面包屑都走它——三处各写一份的话,同一个会话会在三个地方断在
 * 不同的地方。
 *
 * 正好写满 80 字的第一条消息也会带上省略号:截没截断在这一侧分不出来,而漏掉省略号让人
 * 以为这就是全文。
 */
export function sessionTitle(title: string | null, fallback: string): string {
  if (title === null) return fallback;
  return title.length >= TITLE_LIMIT ? `${title}…` : title;
}

/** 一个产品下「我的会话」那一份读缓存的键。产品页左栏与会话页读的是同一个。 */
export function sessionsQueryKey(productId: number): readonly unknown[] {
  return ["products", productId, "sessions"];
}

/** 一个会话那一份读缓存的键。会话页与顶栏面包屑读的是同一个。 */
export function agentSessionQueryKey(sessionId: number): readonly unknown[] {
  return ["agent-sessions", sessionId];
}
