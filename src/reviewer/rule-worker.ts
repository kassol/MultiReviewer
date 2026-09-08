/**
 * 规则 agent 子进程的入口(issue #205)。
 *
 * 与 Reviewer 子进程同构:一个进程只有它自己那一家厂商的凭据(见 `env.ts`),工具集只
 * 读不写,产出经一个自定义工具逐条回传主进程。区别只在任务本身——这里读的是基点 commit
 * 上的仓库全貌,产出的是规范性陈述,不是 Finding。
 */
import {
  createAgentSession,
  defineTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { KnowledgeEntry, PendingProposal } from "../review/finding.ts";
import { MODEL_API_KEY_ENV, redactModelCredential } from "./env.ts";
import { AGENT_STATEMENT_LIMIT, readProposalType } from "./rule-agent.ts";
import type {
  ConsolidationProposal,
  DispositionFeedback,
  RuleWorkerMessage,
  RuleWorkerRequest,
} from "./rule-agent.ts";
import { reviewerEventStream } from "./trace-events.ts";
import {
  READ_ONLY_TOOLS,
  numberedReadTool,
  oneLine,
  prepareAgentRuntime,
  sessionFailure,
  sessionThinkingLevel,
  streamHeartbeat,
} from "./worker-tools.ts";

const PROPOSE_RULE_TOOL = "propose_rule";
const MERGE_PROPOSALS_TOOL = "merge_proposals";
const RETARGET_PROPOSAL_TOOL = "retarget_proposal";

/**
 * 陈述形状(CONTEXT.md 陈述形状,spec #286)。三条链路共用这一段,定义只此一处——三份
 * 系统提示各抄一份,改一次上限就会剩下两份说旧数。四条约束里只有长度由服务端拦
 * (`AGENT_STATEMENT_LIMIT`),另外三条靠这一段说清:正向、不带证据、不带结论句都判不出
 * 程序化判据,写死判据只会误伤正常的陈述。
 */
const STATEMENT_SHAPE = `**Shape of a statement.** Every statement you write is one sentence of Chinese, at most ${AGENT_STATEMENT_LIMIT} characters. State the invariant that holds, positively — what this repository requires or what is the case, not what a reader should not conclude. Leave out line numbers, call site inventories and file listings: they stop being true as soon as the code moves, and the whole entry goes with them. Leave out verdicts on one finding, such as "因此不作为缺陷". The grounds — the code you read, the reasoning that got you there — belong in the reason field, which is kept beside the statement and shown to the person who rules on it. A statement over ${AGENT_STATEMENT_LIMIT} characters is dropped by the server, so say the one thing and stop.`;

const SYSTEM_PROMPT = `You are deriving the knowledge a code reviewer needs about one repository. Explore it with your read tools, then report that knowledge as entries of two kinds.

A **rule** is a normative statement — what the code ought to do. "Handlers must validate request bodies at the boundary" is a rule. Violating a rule is a finding, so a rule has to be something a reviewer would genuinely flag.

A **fact** is a checkable statement about how this repository, its architecture or its environment actually is. "A global interceptor covers every route under /api" is a fact. A fact is never a finding: it is what the reviewer uses to stop guessing, so that it does not report code that the architecture already covers. Report a fact when a reviewer who had not read that part of the codebase would otherwise assume something false.

Give every entry the kind it really is. Do not dress a fact up as an obligation to get it in, and do not report a rule that only restates what the code happens to do today. Leave out file inventories and dependency lists: those go stale without ever changing a review.

Report each entry by calling the propose_rule tool exactly once per entry. Do not describe entries in prose — an entry that is not reported through the tool does not exist.

Order the entries by importance, most important first. Importance means how much a reviewer's judgement improves by having it. Report as many as this repository genuinely warrants and no more: every entry is confirmed by hand, so one that is obvious, that a linter or the type checker already enforces, or that no reviewer would act on costs the reader time and earns nothing.

${STATEMENT_SHAPE}

Write the statement field in Chinese. The reviewers of this repository read Chinese. Keep identifiers, file paths and code fragments in their original form — do not translate them.

Narrate in Chinese too: everything you say between tool calls goes into a trace read by this repository's maintainers, so write those sentences in Chinese — one short line on what you are about to look at and what you are trying to establish, before each group of tool calls.

The read tool prefixes every line with its line number, like \`12: code\`. The prefix is not part of the file content.`;

/**
 * 知识整理的系统提示(CONTEXT.md 知识整理,issue #284、#285)。整理的对象是文本,不是
 * 代码:它手里没有读工具,只有对队列的两个直改动作与一个提案工具。明写「什么都不改是
 * 预期结果」——agent 手里有工具时倾向于用它,而一份没有重复的队列本来就不需要动。
 *
 * 三个动作分两类,提示因此要说清界线:队列直改立刻生效(它改的是还没人裁决的东西),
 * 对现集的变更只能排队等人裁决——知识集仍然只由裁决改动。
 *
 * 对现集那一档明写三条判据(issue #291):不合形状的条目提修改、同一不变量的几条提合并、
 * 写成事实的评审范围排除提单目标合并改型为规则。只给「重复与矛盾」这一句时 agent 挑不出
 * 存量里那 47 条把一条 Finding 的论证写成事实的条目——它们彼此不重复,也不互相矛盾。
 */
const CONSOLIDATION_SYSTEM_PROMPT = `You are tidying the revision proposal queue of one repository's review knowledge.

You get two lists: the knowledge entries currently in force, and the proposals waiting for a human to accept or reject. You change the queue directly, and you propose changes to the knowledge itself. You have three actions.

**Merge** proposals that say the same thing. Two proposals raised from two different disposition notes often carry one idea. Call merge_proposals once per group, with every proposal id in that group and one statement that says what the whole group says — the reviewer reads that one sentence instead of two. Merge only real duplicates: proposals that would have the same effect on the knowledge set. Proposals of different change kinds, or aimed at different entries, are not duplicates. That statement replaces the one in the queue, so it keeps the shape below like every other statement you write.

**Retarget** a proposal that adds something the knowledge set already has. Call retarget_proposal with that proposal's id and the id of the entry it duplicates: it becomes a change to that entry, so the reviewer sees the difference against what is in force and rejects it when there is none. Retarget only proposals whose change kind is add.

**Propose** a change to the entries in force. The knowledge set itself accumulates duplicates, contradictions and entries written in the wrong shape, and you are the one reading all of it at once. Call propose_rule with the ids in rule_ids. Always give rule_ids: you are not exploring the code, so you have no grounds for an entry the list does not already carry. Give a reason on every proposal — the human reading the queue sees it and decides. Three things in that list are worth a proposal:

- **An entry that does not keep the shape below.** It runs past ${AGENT_STATEMENT_LIMIT} characters; or it carries line numbers, a call site inventory or a file listing; or it ends on a verdict about one finding, such as "因此不作为缺陷"; or it is the argument for rejecting one finding written down as if the argument were the knowledge. Pass its id with the same kind and one statement saying the invariant that argument rests on, and put the evidence you took out of the statement into the reason — it is a change, and a change never turns a fact into a rule.
- **Several entries carrying one invariant.** The same underlying rule or fact wrapped in case after case reads as many entries and holds as one. Pass every one of their ids in rule_ids with one statement that covers them all — a merge.
- **A limit on reviewing written as a fact.** "X 目录下不按 Y 标准审", "这类问题不作为评审发现": a statement of what the reviewer should leave alone is a rule about reviewing this repository, not a statement of how the repository is. Pass that one entry's id in rule_ids with type rule — one target of the other kind is a merge that changes the kind, so one decision does the whole thing. Write the new statement as an imperative addressed to the review, such as "评审 \`x/**\` 时只报功能正确性问题".

An entry that contradicts another and cannot stand goes with retire=true and that one id.

Do all of this in one pass: the duplicates in the queue and the rewriting of the entries in force are one task, not two rounds.

Those three differ in what they touch. Merging and retargeting change the queue, which nobody has ruled on yet, so they take effect at once. A proposal changes the knowledge set, so it joins the queue and waits for a person: accepting and rejecting stays with people, and you never judge the proposals already in the queue.

Leave alone every proposal that is not a duplicate, and every entry that still holds as it stands. Changing nothing is an expected outcome for a queue and a knowledge set that have no duplicates in them.

${STATEMENT_SHAPE}

Write statements in Chinese, and narrate in Chinese: everything you say between tool calls goes into a trace read by this repository's maintainers. Say one short line on what you found before each action.`;

const ruleSchema = Type.Object({
  type: Type.String({
    description:
      "One of exactly: rule, fact. rule is a normative statement — what the code ought to do; violating it is a finding. fact is a checkable statement about how this repository actually is; it is grounds for judgement and never a finding by itself.",
  }),
  statement: Type.String({
    description:
      `One sentence in Chinese of at most ${AGENT_STATEMENT_LIMIT} characters — a longer one is dropped by the server. For a rule: what code in this repository must or must not do. For a fact: what is actually the case in this repository, phrased so a reader can check it against the code. State the invariant positively; leave out line numbers and call site inventories, which go stale with the code; leave out verdicts on one finding, such as "因此不作为缺陷"; put the evidence in the reason field, not here.`,
  }),
  scope: Type.Optional(
    Type.String({
      description:
        "A glob limiting the paths this rule applies to, such as `src/api/**`. Leave it out when the rule applies to the whole repository.",
    }),
  ),
  rule_ids: Type.Optional(
    Type.Array(Type.Number(), {
      description:
        "The ids of the agreed entries this change targets, taken from the list of agreed knowledge. Pass one id to reword or retire that entry; pass that one id together with the other kind in `type` to change its kind — the statement you give here replaces it. Pass two or more ids to merge those entries into the single statement you give here. Leave it out when you propose an entry that is not in that list.",
    }),
  ),
  retire: Type.Optional(
    Type.Boolean({
      description:
        "Set to true together with exactly one id in rule_ids to retire that agreed entry instead of restating it. Restate the entry you want retired in the statement field. Use it for a rule the code no longer justifies, and for a fact the code has outgrown.",
    }),
  ),
  proposal_id: Type.Optional(
    Type.Number({
      description:
        "The id of the proposal already waiting for a decision that says the same thing as this note, taken from the list of proposals awaiting a decision. Pass it together with one statement that covers what that proposal and this note both say: your statement replaces the one on that proposal, and the proposal keeps its own change kind and targets. Leave it out when no waiting proposal says the same thing.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description:
        "One sentence in Chinese saying why you propose this change, with the code evidence for it. It is kept on the proposal as its evidence and is shown to the human who rules on it.",
    }),
  ),
});

const mergeSchema = Type.Object({
  proposal_ids: Type.Array(Type.Number(), {
    description:
      "The ids of the pending proposals that say the same thing, at least two of them. The one with the smallest id is kept; the others are removed and their provenance is folded into the kept one.",
  }),
  statement: Type.String({
    description:
      "One sentence in Chinese saying what the whole group says. It replaces the statement of the kept proposal.",
  }),
});

const retargetSchema = Type.Object({
  proposal_id: Type.Number({
    description: "The id of a pending proposal whose change kind is add.",
  }),
  rule_id: Type.Number({
    description:
      "The id of the agreed entry that proposal duplicates, taken from the list of agreed knowledge. The proposal becomes a change to that entry.",
  }),
});

function send(message: RuleWorkerMessage): void {
  process.send?.(message);
}

/**
 * 现有知识集。首次探索时是空的,这一段因此不渲染;非空即这一次提的是对照它的变更
 * (issue #207),条目带上标识与它是哪一型(issue #222),agent 据此指出改哪一条、
 * 废止哪一条——分不清哪条是规则、哪条是事实,就分不清「改一条标准」与「废止一条过期
 * 事实」。
 */
function existingSection(entries: readonly KnowledgeEntry[]): string {
  return [
    "",
    "This repository already agreed on the following knowledge, each entry with its id and its kind:",
    "",
    ...entries.map((entry) => knowledgeBullet(entry)),
    "",
    "Report changes against that list, not the list itself. Do not restate an entry that still holds as it stands — an entry you do not report stays in force. For each change, call propose_rule once:",
    "- to reword or narrow an agreed entry, pass its id in rule_ids and the full new statement;",
    "- to retire an agreed entry the code no longer justifies or has outgrown, pass its id in rule_ids, retire=true and restate that entry;",
    "- to merge agreed entries that say the same thing, pass all of their ids in rule_ids and one statement that covers what they all say. Merge only entries a reader would take for one another; entries that differ in what they require stay separate.",
    "- to add a standard or a fact the list does not cover, leave rule_ids out.",
  ].join("\n");
}

/**
 * 现有知识集里的一条给 agent 看的样子:标识、两型之一、作用范围与那一句陈述。与 Reviewer
 * 那侧的 `ruleBullet` 分开:那边按型分两段渲染、事实不给标识,这边是一份要被指名修改的
 * 清单,两型必须在同一份里各自认得出来。
 */
function knowledgeBullet(entry: KnowledgeEntry, mark = ""): string {
  const scope = entry.scope === "" ? "whole repository" : entry.scope;
  return `- [${entry.id}] (${entry.type}) (${scope}) ${mark}${oneLine(entry.statement)}`;
}

/**
 * 待裁决队列(issue #283)。队列为空时这一段不渲染;非空即这一次要先看它——同一件事已经
 * 有人提过一条,再排一条只会让人裁两次。并入必须给合成后的新陈述:它覆盖队列里那一条的
 * 陈述,而队列里留下的要是「这两次备注合起来说的那一句」,不是其中一次的原话。
 */
function pendingSection(proposals: readonly PendingProposal[]): string {
  return [
    "",
    "This repository already has the following proposals waiting for a human decision, each with its id:",
    "",
    ...proposals.map(pendingBullet),
    "",
    "Read that queue before you report anything. When this note says the same thing as one of those proposals, merge into it instead of queuing a second one: pass its id in proposal_id together with one statement that covers what that proposal and this note both say. Merge only a proposal a reader would take for the same matter as this note; a proposal that asks for something else stays as it is. When no waiting proposal says the same thing, leave proposal_id out and report the change as usual.",
  ].join("\n");
}

/**
 * 待裁决队列里的一条给 agent 看的样子:标识、变更类型、它指向的现有条目与那一句陈述。
 * 「废止条目 7」与「新增一条」说的不是同一件事,变更类型与目标因此都要给出来。
 */
function pendingBullet(proposal: PendingProposal): string {
  const targets =
    proposal.targetRuleIds.length === 0 ? "" : ` of ${proposal.targetRuleIds.join(", ")}`;
  return `- [${proposal.id}] (${proposal.change}${targets}) ${oneLine(proposal.statement)}`;
}

function rulePrompt(request: Pick<RuleWorkerRequest, "baselineSha" | "existingKnowledge">): string {
  const existing =
    request.existingKnowledge.length === 0 ? "" : `${existingSection(request.existingKnowledge)}\n`;
  // 基点只有探索与反哺两条链路给得出来(整理那一档没有代码可看,也不会走到这里)。
  const at = request.baselineSha === undefined ? "" : ` at commit ${request.baselineSha}`;
  return `Derive the review knowledge of the repository as it stands${at}.
${existing}
Start from the repository's own documentation and configuration, then read the code that matters most: the entry points, the modules everything else depends on, and the places where mistakes would be expensive.

Two things come out of that reading. The conventions the existing code already keeps to become rules, stated as obligations. The load-bearing arrangements a reviewer cannot see from a diff — what a shared layer already guarantees, what the deployment or the data actually look like — become facts.

Report each entry through ${PROPOSE_RULE_TOOL}. When you have reported everything worth confirming, stop.`;
}

/**
 * 处置反哺的提示(issue #208)。同一个 agent、同一套产出协议,输入换成一条处置备注与
 * 它处置掉的那条 Finding:要的是「这条意见该不该成为长期标准」,不是重新推导整套规则。
 *
 * 明写「报不出变更是预期结果」:一条只了结眼前那一条 Finding 的备注不构成规则,而 agent
 * 手里有个报告工具时倾向于用它。粒度门槛把这一句说到底(spec #286):只免得掉同一处代码
 * 复报的备注连提都不用提——同一处未改动代码再报会折叠到已处置的那条历史 Finding,那样
 * 一条条目免不掉任何东西,只是让人多裁决一次。
 */
export function feedbackPrompt(
  request: Pick<RuleWorkerRequest, "existingKnowledge" | "pendingProposals"> & {
    feedback: DispositionFeedback;
  },
): string {
  const { note, finding } = request.feedback;
  const existing =
    request.existingKnowledge.length === 0
      ? ""
      : `${existingSection(request.existingKnowledge)}\n`;
  const pending =
    request.pendingProposals === undefined || request.pendingProposals.length === 0
      ? ""
      : `${pendingSection(request.pendingProposals)}\n`;
  return `A reviewer of this repository just disposed of one finding and left a note explaining the decision. Judge what that note says about the standards this repository should be reviewed by.

Finding: ${finding.title ?? finding.description}
Location: ${finding.file}:${finding.line}
Description: ${finding.description}
Disposition note: ${note}
${existing}${pending}
Distil the note by what it says, not by how it is phrased. A note that says this repository should or should not do something is a **rule**. A note that explains why the finding was wrong by pointing at how this repository already is — a shared layer that already covers it, a constraint of the deployment, a property of the data — is a **fact**: report it as one, so the next review has that ground instead of guessing again. A note whose whole content is that some class of problem is not worth reporting in some part of this repository is a **rule** as well, one addressed to the review instead of to the code: write its statement as an imperative to the review, such as "评审 \`x/**\` 时只报功能正确性问题", and put the paths it governs in the scope field. Do not write that one as a statement of how this repository is, and do not tack a verdict such as "因此不上报" onto the end of a fact.

Report only what the note itself justifies. A note that settles this one finding and nothing more justifies no change at all — reporting nothing is an expected outcome. Read the code around the finding when you need it to tell a one-off from a standing rule, or to check a fact before stating it; the evidence you read goes in the reason field, not in the statement.

A note whose only effect is to keep this one place in the code from being reported again buys nothing, and is not worth an entry. The same finding on the same unchanged code folds into the one already disposed of, so it never reaches a person again on its own. Report a change only when what the note says holds beyond this one place — in other files, in other methods, or wherever this repository does the same thing.

Report each change through ${PROPOSE_RULE_TOOL}. When you have nothing more to report, stop.`;
}

/**
 * 一句陈述的长度给整理 agent 看的样子(issue #292)。陈述形状那四条里只有长度判得出程序,
 * 标出来整理才知道该先动哪几条——AI-API 首轮整理的现集 75 条里 72 条超限,它只碰了 20 条
 * 就宣布完成。计数与服务端那道闸(`usableRuleItems`)同一口径,免得标着合规却被丢掉。
 */
function lengthMark(statement: string): string {
  const length = statement.trim().length;
  const over = length > AGENT_STATEMENT_LIMIT ? ", over limit" : "";
  return `(${length} characters${over})`;
}

/** 待裁决队列里的一条给整理 agent 看的样子:标识、变更类型、目标、作用范围、字数与陈述,加它的出处。 */
function proposalBullet(proposal: ConsolidationProposal): string {
  const scope = proposal.scope === "" ? "whole repository" : proposal.scope;
  const target =
    proposal.targetRuleIds.length === 0 ? "" : ` (targets entries ${proposal.targetRuleIds.join(", ")})`;
  const sources = proposal.sources
    .map((source) => (source.note === null ? source.origin : `${source.origin}: ${oneLine(source.note)}`))
    .join(" | ");
  return [
    `- [${proposal.id}] (${proposal.change}) (${proposal.type})${target} (${scope}) ${lengthMark(proposal.statement)} ${oneLine(proposal.statement)}`,
    `  provenance: ${sources === "" ? "none recorded" : sources}`,
  ].join("\n");
}

/**
 * 知识整理的提示(issue #284、#285)。现集那一段与探索、反哺共用 `existingSection` 的
 * 清单形状会带上「一个都认不出即新增」那一句,而整理提不出新增(它不读代码);这里
 * 因此自己渲染现集,既是「改写为修改型时指向哪一条」的目标清单,也是提案的目标清单。
 */
export function consolidationPrompt(
  proposals: readonly ConsolidationProposal[],
  entries: readonly KnowledgeEntry[],
): string {
  const agreed =
    entries.length === 0
      ? "This repository has no knowledge entries in force yet, so nothing can be retargeted and nothing can be proposed against."
      : [
          "The knowledge entries in force, each with its id, kind, scope, statement length and statement:",
          "",
          ...entries.map((entry) => knowledgeBullet(entry, `${lengthMark(entry.statement)} `)),
        ].join("\n");
  const over = entries.filter((entry) => entry.statement.trim().length > AGENT_STATEMENT_LIMIT).length;
  const mustHandle =
    over === 0
      ? ""
      : `\n${over} of those entries are marked over limit, and a statement that long is the shape problem you can see without reading any code. Every entry marked over limit must appear in at least one proposal — shortened to the invariant it rests on, merged with the entries carrying that same invariant, or changed in kind. When one of them genuinely needs no change, name it in your narration and say why.\n`;
  // 队列那一半只标不改:整理没有改写单条提案陈述的动作。这句与现集那段同律,队列里没有
  // 超限的那一条时不出现——标记词只在真有标记时出现。
  const queueOver = proposals.some((proposal) => proposal.statement.trim().length > AGENT_STATEMENT_LIMIT)
    ? "\nA proposal marked over limit is shortened by the person who rules on it: you have no action that rewrites the statement of one proposal, so leave those statements as they stand.\n"
    : "";
  return `Tidy the revision proposal queue of this repository.

${agreed}
${mustHandle}
The proposals waiting for adjudication, each with its id, change kind, entry kind, target entry, scope, statement length, statement and provenance:

${proposals.map(proposalBullet).join("\n")}
${queueOver}
Report every duplicate proposal through ${MERGE_PROPOSALS_TOOL} and ${RETARGET_PROPOSAL_TOOL}. Report every change the entries in force need through ${PROPOSE_RULE_TOOL}, always with rule_ids and a reason. When you have nothing more to report, stop.`;
}

/** 这一次任务的提示。三条链路各一份,由输入里带的那一半认出来。 */
function promptFor(request: RuleWorkerRequest): string {
  if (request.consolidation !== undefined) {
    return consolidationPrompt(request.consolidation.proposals, request.existingKnowledge);
  }
  if (request.feedback !== undefined) {
    return feedbackPrompt({
      existingKnowledge: request.existingKnowledge,
      ...(request.pendingProposals === undefined
        ? {}
        : { pendingProposals: request.pendingProposals }),
      feedback: request.feedback,
    });
  }
  return rulePrompt(request);
}

async function run(request: RuleWorkerRequest): Promise<void> {
  const proposeRule = defineTool({
    name: PROPOSE_RULE_TOOL,
    label: "Propose Rule",
    description: "Report one review rule this repository should be judged by.",
    parameters: ruleSchema,
    execute: async (_id, params) => {
      const raw = params as {
        type: string;
        statement: string;
        scope?: string;
        rule_ids?: number[];
        retire?: boolean;
        proposal_id?: number;
        reason?: string;
      };
      send({
        kind: "rule",
        item: {
          // 两型是封闭枚举,宽松字符串加归一化是与 report_finding 同一条口径(ADR 0004);
          // 认不得的取值怎么收见 `readProposalType`。
          type: readProposalType(raw.type, raw.rule_ids, request.existingKnowledge),
          scope: raw.scope ?? "",
          statement: raw.statement,
          ...(raw.rule_ids === undefined ? {} : { targetRuleIds: raw.rule_ids }),
          ...(raw.retire === true ? { retire: true } : {}),
          ...(raw.proposal_id === undefined ? {} : { proposalId: raw.proposal_id }),
          ...(raw.reason === undefined ? {} : { reason: raw.reason }),
        },
      });
      return { content: [{ type: "text", text: "recorded" }], details: {} };
    },
  });

  const mergeProposals = defineTool({
    name: MERGE_PROPOSALS_TOOL,
    label: "Merge Proposals",
    description: "Fold several pending proposals that say the same thing into one.",
    parameters: mergeSchema,
    execute: async (_id, params) => {
      const raw = params as { proposal_ids: number[]; statement: string };
      const ids = raw.proposal_ids ?? [];
      send({
        kind: "action",
        // 保留哪一行不由 agent 定:落地一律留 id 最小的那一条,协议上的 keepId 因此
        // 就是这一组里最小的那个,其余是被并的。
        action: {
          kind: "merge",
          keepId: Math.min(...ids),
          mergedIds: ids,
          statement: raw.statement,
        },
      });
      return { content: [{ type: "text", text: "merged" }], details: {} };
    },
  });

  const retargetProposal = defineTool({
    name: RETARGET_PROPOSAL_TOOL,
    label: "Retarget Proposal",
    description: "Turn a proposal that adds an entry the knowledge set already has into a change to that entry.",
    parameters: retargetSchema,
    execute: async (_id, params) => {
      const raw = params as { proposal_id: number; rule_id: number };
      send({
        kind: "action",
        action: { kind: "retarget", proposalId: raw.proposal_id, targetRuleId: raw.rule_id },
      });
      return { content: [{ type: "text", text: "retargeted" }], details: {} };
    },
  });

  // 知识整理不读代码(issue #284):它手里只有对队列的两个动作与提案那一个(issue
  // #285),没有读工具,系统提示也换成整理那一份。
  const consolidating = request.consolidation !== undefined;
  const prepared = await prepareAgentRuntime({
    agentDirPrefix: "multireviewer-rule-agent-",
    worktreePath: request.worktreePath,
    runtimeModel: request.runtimeModel,
    systemPrompt: consolidating ? CONSOLIDATION_SYSTEM_PROMPT : SYSTEM_PROMPT,
  });
  if ("failure" in prepared) {
    send({ kind: "done", failure: prepared.failure });
    return;
  }
  const { agentDir, apiKey, model, modelRuntime, settingsManager, resourceLoader } = prepared;

  const { session } = await createAgentSession({
    cwd: request.worktreePath,
    agentDir,
    model,
    thinkingLevel: sessionThinkingLevel(request.runtimeModel.reasoning, request.thinkingLevel),
    modelRuntime,
    tools: consolidating
      ? [MERGE_PROPOSALS_TOOL, RETARGET_PROPOSAL_TOOL, PROPOSE_RULE_TOOL]
      : [...READ_ONLY_TOOLS, PROPOSE_RULE_TOOL],
    customTools: consolidating
      ? [mergeProposals, retargetProposal, proposeRule]
      : [proposeRule, numberedReadTool(request.worktreePath)],
    resourceLoader,
    sessionManager: SessionManager.inMemory(request.worktreePath),
    settingsManager,
  });

  // 知识轨迹只订阅并转发,不做判断(ADR 0017、issue #214):转换与 Reviewer 那侧共用
  // 同一个,凭据在转换那一步就抹掉。
  const forwardEvent = reviewerEventStream(apiKey, (event) => send({ kind: "event", event }));
  // 长思考档位下,几分钟内可能一条完整消息、一次工具调用都没有,静默闸会把它当卡死;
  // 流式 delta 因此另发一路节流过的心跳(`streamHeartbeat`)。
  const heartbeat = streamHeartbeat(send);
  session.subscribe((event) => {
    forwardEvent(event);
    heartbeat(event);
  });

  let thrown: string | undefined;
  try {
    await session.prompt(promptFor(request));
  } catch (error) {
    thrown = String(error instanceof Error ? error.message : error);
  }

  // `session.prompt()` 在模型调用失败时也正常返回,失败只在这两处可见。
  const failure = sessionFailure(session, thrown, apiKey);

  session.dispose();
  send({ kind: "done", ...(failure === undefined ? {} : { failure }) });
  // 显式退出:`dispose()` 之后 Pi 仍可能留着未关闭的 handle,IPC 通道也让事件循环存活。
  process.exit(0);
}

process.on("message", (request: RuleWorkerRequest) => {
  run(request).catch((error: unknown) => {
    send({
      kind: "done",
      failure: redactModelCredential(
        String(error instanceof Error ? error.message : error),
        process.env[MODEL_API_KEY_ENV],
      ),
    });
  });
});
