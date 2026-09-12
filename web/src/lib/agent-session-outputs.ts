/**
 * 会话产出的形状与「复制为 Markdown」的拼接(issue #337)。
 *
 * 拼接在前端完成、不走服务端(spec #330):这段文本只有人按下那个按钮的时候要,后端没有
 * 第二个读者。格式是 spec #330 定的那一份,顺序与右栏的卡片一致——人核对的是同一份东西。
 */

/** 一条拆分条目(CONTEXT.md 拆分条目)。服务端归一化过,这里只读不补。 */
export type BreakdownItem = {
  title: string;
  description: string;
  /** 所属仓库,`<owner>/<repo>`。 */
  repo: string;
  /** 落点:仓库相对的目录或文件。 */
  locations: string[];
  /** 依赖条目,按条目在本版里的序号(从 1 起)。 */
  dependsOn: number[];
  acceptance: string[];
};

/** 一份需求拆分(CONTEXT.md 需求拆分)。 */
export type RequirementBreakdown = {
  summary: string;
  assumptions: string[];
  openQuestions: string[];
  items: BreakdownItem[];
};

/** 一版会话产出(CONTEXT.md 会话产出)。`payload` 的形状由产出类型决定。 */
export type AgentSessionOutput = {
  kind: "requirement-breakdown";
  version: number;
  payload: RequirementBreakdown;
  toolCallId: string;
  createdAt: string;
};

/** 一次定稿或换版(CONTEXT.md 定稿)。首次定稿的 `fromVersion` 为空。 */
export type AgentSessionOutputFinalization = {
  kind: string;
  seq: number;
  fromVersion: number | null;
  toVersion: number;
  finalizedBy: string;
  finalizedAt: string;
};

/** 当前定稿的那一次。没有定稿过即 undefined——它就是换版记录的最后一条。 */
export function currentFinalization(
  finalizations: readonly AgentSessionOutputFinalization[],
): AgentSessionOutputFinalization | undefined {
  return finalizations.at(-1);
}

/** 空列表写「无」,否则逐项一个无序列表项。段落照留:少一段人会以为漏了。 */
function bullets(values: readonly string[], indent = ""): string[] {
  if (values.length === 0) return [`${indent}无`];
  return values.map((value) => `${indent}- ${value}`);
}

/** 空即「无」,否则逐项用顿号之外的半角逗号隔开(spec #330 的格式)。 */
function inline(values: readonly (string | number)[]): string {
  return values.length === 0 ? "无" : values.join(", ");
}

/**
 * 一版需求拆分的 Markdown(spec #330 的固定格式)。标题行的「定稿」只在这一版是定稿版时
 * 出现;假设与未决问题为空时段落照留、写「无」;依赖条目与落点为空同样写「无」。
 */
export function requirementBreakdownMarkdown(options: {
  version: number;
  finalized: boolean;
  breakdown: RequirementBreakdown;
}): string {
  const { version, finalized, breakdown } = options;
  const lines = [
    `# 需求拆分 v${version}${finalized ? " · 定稿" : ""}`,
    "",
    "## 需求概要",
    breakdown.summary,
    "",
    "## 假设",
    ...bullets(breakdown.assumptions),
    "",
    "## 未决问题",
    ...bullets(breakdown.openQuestions),
    "",
    "## 拆分条目",
  ];
  for (const [index, item] of breakdown.items.entries()) {
    lines.push(
      "",
      `### ${index + 1}. ${item.title}`,
      `- 所属仓库:${item.repo}`,
      `- 描述:${item.description}`,
      `- 落点:${inline(item.locations)}`,
      `- 依赖条目:${inline(item.dependsOn)}`,
      "- 验收要点:",
      ...bullets(item.acceptance, "  "),
    );
  }
  return lines.join("\n");
}
