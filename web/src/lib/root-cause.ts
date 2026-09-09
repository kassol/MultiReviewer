/**
 * 同根因组(CONTEXT.md 同根因组,issue #309):阶段 Finding 列表按组折叠的投影。
 *
 * 服务端已经把列表排好序(待处置在前,再按严重度、文件与行号),折叠不该把这个先后打乱:
 * 一组的卡片就落在它排得最靠前的那个成员原来的位置上,其余成员收进这张卡里,未入组的
 * 条目照旧逐条列出。筛选过的列表同样走这里——筛掉一部分成员之后卡里剩几条就列几条。
 */

/** 一条 Finding 上的组引用,字段与 `GET /api/stage-summary` 的 `rootCause` 逐字对应。 */
export type RootCauseRef = {
  id: number;
  reason: string;
  /** 组的成员总数,与筛选无关:卡片上说的是这个组有多少处。 */
  memberCount: number;
  position: number;
};

/** 折叠之后列表里的一项:一张组卡,或一条未入组的 Finding。 */
export type RootCauseRow<T> =
  | { kind: "group"; id: number; reason: string; memberCount: number; members: T[] }
  | { kind: "finding"; finding: T };

export function foldByRootCause<T extends { rootCause: RootCauseRef | null }>(
  findings: readonly T[],
): RootCauseRow<T>[] {
  const rows: RootCauseRow<T>[] = [];
  const cards = new Map<number, Extract<RootCauseRow<T>, { kind: "group" }>>();
  for (const finding of findings) {
    const ref = finding.rootCause;
    if (ref === null) {
      rows.push({ kind: "finding", finding });
      continue;
    }
    const existing = cards.get(ref.id);
    if (existing !== undefined) {
      existing.members.push(finding);
      continue;
    }
    const card = {
      kind: "group" as const,
      id: ref.id,
      reason: ref.reason,
      memberCount: ref.memberCount,
      members: [finding],
    };
    cards.set(ref.id, card);
    rows.push(card);
  }
  return rows;
}

/**
 * 「处置整组」写得动的成员(issue #309):判据与服务端跳过的那一份同口径——组级处置只写
 * 当前未处置、且有行级评论承载的成员(`server.ts` 的 `handleDisposeRootCauseGroup`)。
 * 没有评论 id 的那条在 Forge 上没有可 resolve 的载体,逐条处置同样处置不了它;把它算成
 * 待处置只会让按钮点得动而一条都写不进去。
 */
export function disposableInGroup(finding: {
  disposition: string;
  commentId: string | null;
}): boolean {
  return (
    finding.commentId !== null &&
    (finding.disposition === "unresolved" || finding.disposition === "unknown")
  );
}
