import type { Category, Finding, Severity } from "./finding.ts";

/**
 * 同一处问题被多个模型各自提出后合并的结果。
 *
 * 合并保留每一条来源 Finding:模型对同一个缺陷的表述常常不同,只留一条会丢掉
 * 另一个模型看到的角度。
 */
export type MergedFinding = {
  file: string;
  line: number;
  severity: Severity;
  category: Category;
  /** 以下四段取严重度最高的那条来源。 */
  title: string;
  description: string;
  impact: string;
  suggestion: string;
  /** 提出它的全部模型,按首次出现顺序。 */
  models: string[];
  sources: Finding[];
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
function comparable(finding: Finding): string {
  return finding.title === "" ? finding.description : finding.title;
}

/**
 * 两条 Finding 是否指向同一处。行距是必要条件,内容是行距容差内的第二道判据。
 *
 * 行号完全相同时不看内容:Finding 的行号是模型从 read 输出抄下来、再经 snippet 锚定
 * 核对过的(见 `reviewer/anchor.ts`),同一行是「同一处」的硬证据,拿标题措辞去推翻
 * 它是用弱信号盖强信号。要防的是相邻而非同一行的那种误合并。
 */
function isSameSpot(a: Finding, b: Finding): boolean {
  const distance = Math.abs(a.line - b.line);
  if (distance > LINE_TOLERANCE) return false;
  if (distance === 0) return true;
  return contentSimilarity(comparable(a), comparable(b)) >= SIMILARITY_THRESHOLD;
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

  const merged: MergedFinding[] = [];
  for (const [file, fileFindings] of byFile) {
    const sorted = [...fileFindings].sort((a, b) => a.line - b.line);
    const groups: Finding[][] = [];

    for (const finding of sorted) {
      // 与组内任一条同处即并入,不只比组内最后一条。加了内容判据之后分组不再是行号
      // 区间:一条 Finding 可能与组里靠前的那条讲的是一回事,却与最后一条无关,只比
      // 最后一条会把它单独拆出去,同一个缺陷因此发两条评论。行距那一半仍是链式的
      // ——一串两两相近的 Finding 应当聚成一组。
      const group = groups.find((g) => g.some((member) => isSameSpot(member, finding)));
      if (group === undefined) groups.push([finding]);
      else group.push(finding);
    }

    for (const group of groups) merged.push(mergeGroup(file, group));
  }

  return merged;
}

function mergeGroup(file: string, group: readonly Finding[]): MergedFinding {
  const leading = [...group].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0]!;

  const models: string[] = [];
  for (const finding of group) {
    if (!models.includes(finding.model)) models.push(finding.model);
  }

  return {
    file,
    // 取组内最小行号:偏保守,评论落在问题起始处而非中段。
    line: Math.min(...group.map((f) => f.line)),
    severity: leading.severity,
    category: leading.category,
    title: leading.title,
    description: leading.description,
    impact: leading.impact,
    suggestion: leading.suggestion,
    models,
    sources: [...group],
  };
}
