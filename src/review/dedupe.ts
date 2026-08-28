import type { Category, Finding, Severity } from "./finding.ts";

/**
 * 一条 Finding 的一个归属:某个 Reviewer 对这一处问题的说法(ADR 0015)。
 *
 * 归属保留每个模型自己的严重度、分类与表述:模型对同一个缺陷的表述常常不同,只留一条
 * 会丢掉另一个模型看到的角度。同一个模型在一个合并组里报了两条时只留严重度最高的那条
 * ——归属的单位是模型,不是它按了几次 `report_finding`。
 */
export type FindingAttribution = {
  model: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  impact: string;
  suggestion: string;
};

/**
 * 一组为什么被判成同一处:同一行,或相距几行且相似度多少。
 *
 * 它是 `sameSpot` 那两道判据的原样呈现,不另立口径——面板要解释合并,解释的必须是
 * 真正做出这个决定的那两个数(issue #171 的用户故事 9)。
 */
export type MergeCriterion =
  | { kind: "same_line" }
  | { kind: "distance"; distance: number; similarity: number };

/** 合并组里的一个成员:哪个 Reviewer 在哪一行说了什么。 */
export type MergeMember = {
  /** 报出它的 Reviewer 所绑定的模型标识。 */
  model: string;
  line: number;
  title: string;
};

/**
 * 一次合并的判据与成员(issue #171)。只有真的合并了(成员多于一条)的组才有。
 *
 * 一组可能由多次两两判定串起来,`criterion` 因此取其中最松的那条证据:全部由「同一行」
 * 串起来才记 `same_line`,只要有一次靠行距容差并进来,就记那次里行距最大的一条。读的人
 * 要能看到这组最弱的那道证据,而不是最强的。
 */
export type MergeEvidence = {
  members: MergeMember[];
  criterion: MergeCriterion;
};

/**
 * 同一处问题被多个 Reviewer 各自提出后合并的结果。它是 Finding Identity 在一轮里的
 * 呈现单位:一条 Finding 一条评论,归属记全部报出它的 Reviewer(ADR 0015)。
 */
export type MergedFinding = {
  file: string;
  line: number;
  /** 取各归属里最高的那一档:宁可高估不漏。 */
  severity: Severity;
  /** 取首报那个 Reviewer 的分类:跨模型改口不挪格,与统计里的首轮归属同一取向。 */
  category: Category;
  /** 以下四段取严重度最高的那条归属,作为这一条的代表段。 */
  title: string;
  description: string;
  impact: string;
  suggestion: string;
  /** 每个模型各自的说法,按首报先后。 */
  attributions: FindingAttribution[];
  /**
   * 组内首个自报了命中规则的成员给的那个标识(issue #204)。命中规则说的是「这一处问题
   * 违反了哪条规则」,与谁报出无关,因此不逐模型记,也不参与合并判定。
   */
  ruleId?: number;
  /** 这一组为什么被合并(issue #171)。只有一个成员即没有合并过,这一项缺省。 */
  merge?: MergeEvidence;
};

/**
 * 行号差在此范围内视为指向同一处。模型对同一个缺陷给出的行号常有一两行出入
 * (指到函数签名还是指到出错的那一行)。
 */
const LINE_TOLERANCE = 3;

/**
 * 低于此相似度的两条内容视为两个不同的问题,行距再近也不合并。
 *
 * 取得很低,是因为两类样本的取值互相重叠,这道判据只能压住最极端的那一档:实测同一
 * 缺陷的两种表述高到 0.20(共享 `new Function`),两个不同缺陷高到 0.29(「登录时未校验
 * 密码」与「注册时未校验邮箱格式」共享「时未校验」四字);反过来,同一缺陷的两种纯中文
 * 改写可以一个 token 都不共享而落到 0(「密码用 MD5 存储」与「口令散列算法强度不足」)。
 *
 * 阈值因此压到只在「毫无交集」时才拆。ticket #15 把误合并(两个问题被说成一个)排在漏合并
 * 之上,本该偏向多拆;但这道信号弱到当不了拆分的依据——去拆会先拆散上面那些 token 交集
 * 为 0 的同缺陷表述,拆散造成的重复打扰远多于它拦下的误合并。0.05 是这个弱信号下的最小
 * 伤害,不是说拆错比合错轻。
 *
 * 已知代价两头都有,固定在 `test/similarity.test.ts` 的两条限制里:同缺陷的纯中文同义
 * 改写被拆成两条(漏合并);不同缺陷共享套话时仍被合并(误合并,正是 ticket 最在意的那类)。
 * 前者靠行号相同的硬证据兜住多数(两个模型报同一缺陷时行号常常一致),后者按 ticket
 *「发生率低」接受。要真正分开两类只能换更强的信号(如让模型自报同一缺陷的稳定标识),
 * 不是调这个数。
 */
const SIMILARITY_THRESHOLD = 0.05;

/**
 * 分词:ASCII 连续段整段成词,CJK 逐字成词,标点与空白不进集合。
 *
 * 中英混排上不能逐字符切:`new Function` 与 `summary count` 在字符粒度上共享
 * n/u/c/t/o/m 一大把字母,PR #3 那对本该拆开的标题因此算出 0.22 的相似度。
 */
const TOKEN = /[a-z0-9]+|[\p{L}\p{N}]/gu;

/**
 * 两段文本的相似度,取 token 集合的 Jaccard 系数,值域 [0, 1]。
 *
 * 中文短标题上不用字符 bigram:同一缺陷的两种中文说法常常一个二字片段都不共享
 * (实测「sub 多减了 1」与「减法结果偏移」的 bigram Jaccard 是 0),拿它当判据会把
 * 大量该合并的拆开。
 */
export function contentSimilarity(a: string, b: string): number {
  const left = new Set(a.toLowerCase().match(TOKEN));
  const right = new Set(b.toLowerCase().match(TOKEN));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * 拿去比相似度的那段文本:标题优先,标题为空时退回描述。
 *
 * `title` 允许为空(模型没给标题时归一化补空串),而空串与任何文本的相似度都是 0,
 * 直接拿它比会让不给标题的模型一条都合并不进来。描述必定非空——归一化的硬校验,
 * 见 `reviewer/normalize.ts`——退回它即可,空标题不需要另设一档。
 */
function comparable(finding: { title: string; description: string }): string {
  return finding.title === "" ? finding.description : finding.title;
}

/**
 * 两条内容讲的是不是同一回事。判据与阈值都取跨模型去重的第二道判据,不另立一套:
 * 「什么算同一个问题」在一处定,改动时两边一起变。
 *
 * 延续用它挡住「同文件里随便一条新 Finding 都能被承接」(issue #167):那一档没有行号
 * 可依——旧位置的代码已经被改写,行号跨轮之间不再是硬证据,内容是仅剩的判据。
 */
export function sameContent(
  a: { title: string; description: string },
  b: { title: string; description: string },
): boolean {
  return contentSimilarity(comparable(a), comparable(b)) >= SIMILARITY_THRESHOLD;
}

/**
 * 两条 Finding 是否指向同一处。行距是必要条件,内容是行距容差内的第二道判据。
 *
 * 行号完全相同时不看内容:Finding 的行号是模型从 read 输出抄下来、再经 snippet 锚定
 * 核对过的(见 `reviewer/anchor.ts`),同一行是「同一处」的硬证据,拿标题措辞去推翻
 * 它是用弱信号盖强信号。要防的是相邻而非同一行的那种误合并。
 */
function sameSpot(a: Finding, b: Finding): MergeCriterion | undefined {
  const distance = Math.abs(a.line - b.line);
  if (distance > LINE_TOLERANCE) return undefined;
  if (distance === 0) return { kind: "same_line" };
  const similarity = contentSimilarity(comparable(a), comparable(b));
  if (similarity < SIMILARITY_THRESHOLD) return undefined;
  return { kind: "distance", distance, similarity };
}

/** 一条 Finding 并进某个组时,组里与它最贴近的那条证据。并不进去即 undefined。 */
function joinCriterion(group: readonly Finding[], finding: Finding): MergeCriterion | undefined {
  let best: Extract<MergeCriterion, { kind: "distance" }> | undefined;
  for (const member of group) {
    const criterion = sameSpot(member, finding);
    if (criterion === undefined) continue;
    // 同一行是硬证据,遇到即定;其余取行距最近的那条。
    if (criterion.kind === "same_line") return criterion;
    if (best === undefined || criterion.distance < best.distance) best = criterion;
  }
  return best;
}

/** 一组的合并判据:全部由「同一行」串起来才是 same_line,否则取行距最大的那条。 */
function groupCriterion(joins: readonly MergeCriterion[]): MergeCriterion {
  let widest: Extract<MergeCriterion, { kind: "distance" }> | undefined;
  for (const join of joins) {
    if (join.kind !== "distance") continue;
    if (widest === undefined || join.distance > widest.distance) widest = join;
  }
  return widest ?? { kind: "same_line" };
}

/** 数字大的先行。合并后的那条取组内最高优先级。 */
const SEVERITY_RANK: Record<Severity, number> = { P0: 3, P1: 2, P2: 1 };

/**
 * 跨模型去重:同一文件里指向同一处的 Finding 合并为一条。
 *
 * 同一个模型自己报的两条也会被合并——它们同样指向同一处。
 */
export function dedupeFindings(findings: readonly Finding[]): MergedFinding[] {
  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.file);
    if (list === undefined) byFile.set(finding.file, [finding]);
    else list.push(finding);
  }

  // 报出的先后:入参按 Reviewer 的配置顺序排(`run.ts` 按 `deps.reviewers` 拼,谁先跑完
  // 都不影响),分组时要按行号排,首报因此要先记下来——归属的次序与合并后的分类都取它
  // (ADR 0015)。按配置顺序而非完成顺序,同一份输入才永远给同一个答案。
  const reportOrder = new Map<Finding, number>(findings.map((f, index) => [f, index]));

  const merged: MergedFinding[] = [];
  for (const [file, fileFindings] of byFile) {
    const sorted = [...fileFindings].sort((a, b) => a.line - b.line);
    // `joins` 与 `members` 里第二条起的成员一一对应:每条并进来时凭的是哪道判据。
    const groups: { members: Finding[]; joins: MergeCriterion[] }[] = [];

    for (const finding of sorted) {
      // 与组内任一条同处即并入,不只比组内最后一条。加了内容判据之后分组不再是行号
      // 区间:一条 Finding 可能与组里靠前的那条讲的是一回事,却与最后一条无关,只比
      // 最后一条会把它单独拆出去,同一个缺陷因此发两条评论。行距那一半仍是链式的
      // ——一串两两相近的 Finding 应当聚成一组。
      let joined = false;
      for (const group of groups) {
        const criterion = joinCriterion(group.members, finding);
        if (criterion === undefined) continue;
        group.members.push(finding);
        group.joins.push(criterion);
        joined = true;
        break;
      }
      if (!joined) groups.push({ members: [finding], joins: [] });
    }

    for (const group of groups) {
      merged.push(
        mergeGroup(
          file,
          [...group.members].sort((a, b) => reportOrder.get(a)! - reportOrder.get(b)!),
          group.joins,
        ),
      );
    }
  }

  return merged;
}

/** 按首报先后排好的一组 Finding 合成一条。 */
function mergeGroup(
  file: string,
  group: readonly Finding[],
  joins: readonly MergeCriterion[],
): MergedFinding {
  const leading = [...group].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0]!;

  // 一个模型一条归属,按首报先后。同一个模型报了两条时留严重度高的那条:归属的单位
  // 是模型,不是它按了几次 report_finding。
  const attributions: FindingAttribution[] = [];
  for (const finding of group) {
    const said: FindingAttribution = {
      model: finding.model,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      description: finding.description,
      impact: finding.impact,
      suggestion: finding.suggestion,
    };
    const index = attributions.findIndex((a) => a.model === said.model);
    if (index === -1) attributions.push(said);
    else if (SEVERITY_RANK[said.severity] > SEVERITY_RANK[attributions[index]!.severity]) {
      attributions[index] = said;
    }
  }

  // 按首报先后取第一个给出命中规则的成员:模型自报是稀疏的,取代表段那条会让一组里
  // 唯一报出规则的那个模型的自报白丢。
  const ruleId = group.find((finding) => finding.ruleId !== undefined)?.ruleId;

  return {
    file,
    // 取组内最小行号:偏保守,评论落在问题起始处而非中段。
    line: Math.min(...group.map((f) => f.line)),
    severity: leading.severity,
    // 分类取首报(ADR 0015)。严重度取最高是为了不漏,分类没有高低之分,只能定一个
    // 稳定的取值口径,取首报与统计里「首轮报出的 category 为准」同一取向。
    category: group[0]!.category,
    title: leading.title,
    description: leading.description,
    impact: leading.impact,
    suggestion: leading.suggestion,
    attributions,
    ...(ruleId === undefined ? {} : { ruleId }),
    // 只有一个成员的组没有合并过,不产生合并事件(issue #171 的用户故事 10)。
    ...(group.length === 1
      ? {}
      : {
          merge: {
            members: group.map((finding) => ({
              model: finding.model,
              line: finding.line,
              title: finding.title,
            })),
            criterion: groupCriterion(joins),
          },
        }),
  };
}
