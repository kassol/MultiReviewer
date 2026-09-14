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

/** 一个产品下「我的会话」那一份读缓存的键。产品页左栏与会话页读的是同一个。 */
export function sessionsQueryKey(productId: number): readonly unknown[] {
  return ["products", productId, "sessions"];
}

/** 一个会话那一份读缓存的键。会话页与顶栏面包屑读的是同一个。 */
export function agentSessionQueryKey(sessionId: number): readonly unknown[] {
  return ["agent-sessions", sessionId];
}
