import type {
  Category,
  Finding,
  HistoryFinding,
  ReviewerEvent,
  ReviewerUsage,
  Severity,
} from "./finding.ts";

/**
 * 一条 Finding 的一个归属:某个 Reviewer 对这一处问题的说法(ADR 0015)。
 *
 * 归属保留每个模型自己的严重度、分类与表述:模型对同一个缺陷的表述常常不同,只留一条
 * 会丢掉另一个模型看到的角度。同一个模型在一个合并组里的多条全部保留(2026-08-31,
 * 修订 ADR 0015):合并管的是评论挂在哪,不该顺手把模型明确报出的内容吞掉;只有标题
 * 与描述逐字相同的重复报才折叠成一条,留严重度高的。
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
 * 一组为什么被判成同一处:合并 agent 的一句理由,或算法档的同一行 / 行距加相似度。
 *
 * 算法两档是 `sameSpot` 那两道判据的原样呈现,不另立口径——面板要解释合并,解释的
 * 必须是真正做出这个决定的那两个数(issue #171 的用户故事 9)。`agent` 档同律:那一句
 * 理由就是做出这个决定的东西本身(issue #228)。
 */
export type MergeCriterion =
  | { kind: "same_line" }
  | { kind: "distance"; distance: number; similarity: number }
  | { kind: "agent"; reason: string };

/**
 * 一次跨轮次收口(折叠或延续)凭的是什么(issue #240)。轨迹上与 `MergeCriterion` 占
 * 同一格 `criteria`,里面同样是做出这个决定的东西本身,不是一句转述。
 *
 * 判据另立一个联合而不是复用 `MergeCriterion`:同一轮内的「同一行」与「行距加相似度」
 * 在跨轮次上不成立(旧位置的代码可能已经改写,行号证明不了什么),跨轮次这三档在同一轮
 * 内也不成立。共用一个联合会让两边各自多出一半永远取不到的取值。
 */
export type CarryCriterion =
  /** 旧指纹按 ±3 行滑动在本轮 head 上仍算得出(`priorMatch`),只用于折叠。 */
  | { kind: "fingerprint" }
  /** 复核判仍在,本轮新报的一条内容对得上(`sameContent`),只用于延续。 */
  | { kind: "content" }
  /** 复核结论自带新位置,本轮据它合成一条(issue #170),只用于延续。 */
  | { kind: "verdict" }
  /** 合并 agent 把本轮这条与那条历史分进了同一组,带它给的那句理由原文。 */
  | { kind: "agent"; reason: string };

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
  /**
   * 合并 agent 判定与这一组讲的是同一回事的那条历史 Finding(issue #240):它的落库 id,
   * 加 agent 给的那句理由原文。一组命中多条历史时取 id 最小的那条,其余历史不动。
   *
   * 折叠还是延续由编排层按「旧指纹在本轮 head 上算不算得出」定,这里只记「命中了谁」
   * ——位置语义不交给模型,与三条硬性质同律。
   */
  history?: { id: number; reason: string };
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
function sameSpot(a: Finding, b: Finding): AlgorithmCriterion | undefined {
  const distance = Math.abs(a.line - b.line);
  if (distance > LINE_TOLERANCE) return undefined;
  if (distance === 0) return { kind: "same_line" };
  // 距离档只对跨模型开放。跨模型去重的前提是两个模型无法协调,同处近说法即同一条;
  // 同一个模型自己分开按了两次 report_finding,分开本身就是「这是两个问题」的最强
  // 信号,相似度这道弱信号不该盖过它——PR #21 实测它把一条独立的 P1 吞进了隔壁的
  // P0 组,评论里连痕迹都不剩。
  if (a.model === b.model) return undefined;
  const similarity = contentSimilarity(comparable(a), comparable(b));
  if (similarity < SIMILARITY_THRESHOLD) return undefined;
  return { kind: "distance", distance, similarity };
}

/** 算法档的两道判据。`agent` 档由合并 agent 给,不经这几个函数。 */
type AlgorithmCriterion = Exclude<MergeCriterion, { kind: "agent" }>;

/** 一条 Finding 并进某个组时,组里与它最贴近的那条证据。并不进去即 undefined。 */
function joinCriterion(group: readonly Finding[], finding: Finding): AlgorithmCriterion | undefined {
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
function groupCriterion(joins: readonly AlgorithmCriterion[]): AlgorithmCriterion {
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
 * 同一个模型自己报的两条只在行号完全相同时合并;距离档不对同模型开放,见 `sameSpot`。
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
    const groups: { members: Finding[]; joins: AlgorithmCriterion[] }[] = [];

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
          groupCriterion(group.joins),
        ),
      );
    }
  }

  return merged;
}

/**
 * 合并 agent 提出的一组(issue #228):成员编号是它收到的那份 Finding 列表的下标,
 * 理由是这一组为什么是同一个问题的一句话。
 */
export type MergeGroupProposal = {
  members: readonly number[];
  /**
   * 这一组里的历史成员,值是历史 Finding 的落库 id(issue #240)。历史用自己的 id 作
   * 标识,与本轮 Finding 的下标分在两格里:混在一格里,`3` 到底指第 3 条本轮 Finding
   * 还是 id 为 3 的历史就说不清了。没有历史成员时缺省。
   */
  history?: readonly number[];
  reason: string;
};

/**
 * 合并 agent 的注入边界(issue #228,ADR 0022)。与 `Reviewer`、`RuleAgent` 同构:编排层
 * 只认这一个函数类型,真实实现是 Pi 子进程(`reviewer/merge-agent.ts`),测试注入脚本化
 * 实现。模型与凭据在建它的时候就固定了,不随任务给。
 */
export type MergeAgent = (request: MergeAgentRequest) => Promise<MergeAgentResult>;

/** 交给合并 agent 的一次任务。 */
export type MergeAgentRequest = {
  /**
   * 本轮全部成功 Reviewer 的 Finding,按 Reviewer 的配置顺序拼好。下标即成员编号,
   * 分组方案与验收都按它对齐。
   */
  findings: readonly Finding[];
  /**
   * 本审查阶段的历史 Finding,只取所在文件在本轮有 Finding 报出的那些(issue #240)。
   * 未处置与已处置都给,来源与注入 Reviewer 的那一份相同(`store.stageHistory`),
   * 不带操作人。跨轮次的重报要能被判成同一回事,agent 就得看得见历史。
   */
  history?: readonly HistoryFinding[];
  /** 本轮的一次性工作副本。agent 需要翻代码时读的就是它。 */
  worktreePath: string;
  /** 过程事件的回调。逐条给,调用方落成审查轨迹。 */
  onEvent?: (event: ReviewerEvent) => void;
};

/** 一次合并的产出。`failure` 有值即这一次没跑成,调用方回退到算法合并。 */
export type MergeAgentResult = {
  groups: MergeGroupProposal[];
  failure?: string;
  /** 这次会话的 token 用量。会话没建起来时取不到。 */
  usage?: ReviewerUsage;
};

/** 分组方案的验收结果:过了给合并结果,没过给一句拒绝理由,调用方据此回退并记轨迹。 */
export type MergeProposalOutcome =
  | { merged: MergedFinding[] }
  | { rejected: string };

/**
 * 按合并 agent 的分组方案合并(issue #228)。语义判断是它的,三条硬性质是代码的:
 *
 * 1. 每条输入 Finding 恰好落在一组里(不丢不重);
 * 2. 一组的成员同属一个文件;
 * 3. 一组里每个成员与组内至少一个其他成员行距不超过 `LINE_TOLERANCE`。
 *
 * 三条是「同一处」的位置语义,合并改的只是「这两条讲的是不是同一回事」那一半,位置
 * 这一半不交出去。任一条不成立即整份方案作废,调用方退回 `dedupeFindings`——半份采纳
 * 会让检出率悄悄少一块,而检出率是代码要守住的那个量。
 *
 * 带上同文件历史之后验收分两档(issue #240):不含历史成员的组照上面三条验;含历史成员
 * 的组只验第一、二条,行距那一条免验——代码改写之后同一个问题会漂到离旧位置很远的地方,
 * 拿行距去挡等于把本票要接住的那一类全挡掉。历史成员的旧行号一并不参与行距计算。
 * 历史那一侧另有两条:编号必须是这次给出的历史里的一条,且不得出现在两组里。历史可以
 * 不出现在任何一组里——它只是候选,不是必须被认领的输入。
 *
 * 行号、严重度、分类、归属折叠与代表段的派生规则全部沿用算法档那一套(`mergeGroup`),
 * 呈现语义因此与升级前逐字一致。
 */
export function mergeByProposal(
  findings: readonly Finding[],
  groups: readonly MergeGroupProposal[],
  history: readonly HistoryFinding[] = [],
): MergeProposalOutcome {
  const historyById = new Map(history.map((entry) => [entry.id, entry]));
  const claimed = new Set<number>();
  const claimedHistory = new Set<number>();
  for (const group of groups) {
    // 空组不是合法方案:它分不到任何条目,后面取代表时还会当场崩——验收的职责正是
    // 把一切不成立的方案挡成回退,而不是让它变成异常。只有历史成员的组同样不成立:
    // 一组的产出是本轮的一条 Finding,没有本轮成员就没有东西可产出。
    if (group.members.length === 0) return { rejected: "方案里有一组没有任何成员" };
    for (const member of group.members) {
      if (!Number.isInteger(member) || member < 0 || member >= findings.length) {
        return { rejected: `分组里的编号 ${member} 不是 0 到 ${findings.length - 1} 之间的条目` };
      }
      if (claimed.has(member)) return { rejected: `第 ${member} 条被分进了两组` };
      claimed.add(member);
    }
    for (const id of group.history ?? []) {
      if (!historyById.has(id)) return { rejected: `分组里的历史条目 ${id} 不在这次给出的历史里` };
      if (claimedHistory.has(id)) return { rejected: `历史条目 ${id} 被分进了两组` };
      claimedHistory.add(id);
    }
  }
  if (claimed.size !== findings.length) {
    return { rejected: `${findings.length - claimed.size} 条 Finding 没有被分进任何一组` };
  }

  const merged: MergedFinding[] = [];
  for (const group of groups) {
    // 成员编号即首报先后:输入按 Reviewer 的配置顺序拼(`run.ts`),下标就是报出的次序。
    const members = [...group.members].sort((a, b) => a - b).map((index) => findings[index]!);
    // 一组含多条历史时取 id 最小的那条作数:先来的那条拿走这次交接,与延续那边
    //「一条新 Finding 至多承接一条旧 Identity、id 小的先拿」同一条口径。
    const hits = [...(group.history ?? [])].sort((a, b) => a - b).map((id) => historyById.get(id)!);
    const file = members[0]!.file;
    const files = new Set([...members, ...hits].map((entry) => entry.file));
    if (files.size > 1) {
      return { rejected: `一组里混了不同文件:${[...files].join("、")}` };
    }
    if (
      hits.length === 0 &&
      members.length > 1 &&
      members.some((member) =>
        members.every(
          (other) => other === member || Math.abs(other.line - member.line) > LINE_TOLERANCE,
        ),
      )
    ) {
      return {
        rejected: `${file} 的一组里有成员与组内任何其他成员都相距超过 ${LINE_TOLERANCE} 行`,
      };
    }
    merged.push(
      mergeGroup(
        file,
        members,
        { kind: "agent", reason: group.reason },
        hits[0] === undefined ? undefined : { id: hits[0].id, reason: group.reason },
      ),
    );
  }

  // 与算法档同序:文件按首次出现的先后,组内按代表行号升序。呈现次序不因换了分组方式而变。
  const fileOrder = new Map<string, number>();
  for (const finding of findings) {
    if (!fileOrder.has(finding.file)) fileOrder.set(finding.file, fileOrder.size);
  }
  merged.sort(
    (a, b) => fileOrder.get(a.file)! - fileOrder.get(b.file)! || a.line - b.line,
  );
  return { merged };
}

/** 按首报先后排好的一组 Finding 合成一条。 */
function mergeGroup(
  file: string,
  group: readonly Finding[],
  criterion: MergeCriterion,
  history?: { id: number; reason: string },
): MergedFinding {
  const leading = [...group].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  )[0]!;

  // 按首报先后。同一个模型的多条只在标题与描述逐字相同(真正的重复报)时折叠成一条、
  // 留严重度高的;其余全部保留——分组的拓扑(链式并入、小 hunk 把不同问题汇流到同一
  // 行)不该决定模型报出的内容还在不在,PR #21 实测被折叠吞掉的 P1/P2 在评论上零痕迹。
  // 不用 sameContent 当重复判据:0.05 的弱阈值把「除零防护」与「类型校验」都判成同一
  // 回事,拿它折叠等于把吞条换个地方再吞一遍;检出优先,近似重复宁可多一段。
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
    const dup = attributions.findIndex(
      (a) =>
        a.model === said.model &&
        a.title === said.title &&
        a.description === said.description,
    );
    if (dup === -1) attributions.push(said);
    else if (SEVERITY_RANK[said.severity] > SEVERITY_RANK[attributions[dup]!.severity]) {
      attributions[dup] = said;
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
    ...(history === undefined ? {} : { history }),
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
            criterion,
          },
        }),
  };
}
