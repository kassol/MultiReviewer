/**
 * 会话用途自己那一段系统提示(issue #338)。
 *
 * 底座那一份说的是「会话是什么、工作区长什么样、工具面到哪里为止」(`session-worker.ts`
 * 的 `sessionSystemPrompt`);这里一处按用途分发,接在它后面。新用途接入时在这里多一档,
 * 底座那一份一格不动。
 *
 * 段落用英文写,与现有 prompt 同一风格;要求产出用中文,与产出工具字段 description 里
 * 那几句「written in Chinese」同一口径。
 */
import { PRODUCT_TICKET_LABELS } from "../review/store.ts";
import {
  QUERY_KNOWLEDGE_TOOL,
  WITHDRAW_KNOWLEDGE_TOOL,
  WRITE_KNOWLEDGE_TOOL,
} from "./session-knowledge-tool.ts";
import { SUBMIT_PRODUCT_SURVEY_TOOL } from "./session-output-tools.ts";
import type { SessionProductKnowledge } from "./session-protocol.ts";
import { ASK_QUESTION_ROUND_TOOL } from "./session-question-tool.ts";
import { sessionSkillNames } from "./session-skills.ts";
import { TRACKER_TOOLS } from "./session-tracker-tools.ts";

/**
 * 需求拆分用途的那一段(spec #330 的「系统 prompt 要点」)。
 *
 * 最后那一条与 Reviewer 的「不经工具报出的问题不存在」同一口径:正文里散列的条目不算产出,
 * 它既不落产出表也不进右栏,人拿不走。
 */
const REQUIREMENT_BREAKDOWN_PROMPT = [
  "## This session: breaking a requirement down",
  "",
  "A person brings you a requirement and you break it into items a team can build. Write everything you hand in, and everything you say in this conversation, in Chinese.",
  "",
  "The requirement arrives over several turns: take what is in front of you as part of it, not all of it. When something you need is missing or can be read two ways, ask before you break it down — one round of questions beats a breakdown built on a guess. When the person says 直接拆, or otherwise tells you to break it down as it stands, stop asking and hand in a breakdown with what you have; write what you had to assume into the assumptions, and what is still undecided into the open questions.",
  "",
  "One item is one change inside a single repository that can go out as its own pull request. A feature that spans repositories is therefore several items, one per repository, tied together by dependsOn: the item that has to land first comes first, and the ones waiting on it name its position. Never write an item that changes two repositories.",
  "",
  "Every location of an item is a directory or a file you have seen yourself with read, grep, find or ls. Read the repositories before you break anything down: a location you did not read is a guess, and a guess here sends somebody to a path that does not exist. When you cannot find where a change lands, say so in the open questions instead of writing a plausible path.",
  "",
  "What query_knowledge returns is the boundary of the breakdown: the review rules and project facts say what each repository has already agreed on, and the product knowledge says how the repositories fit together, so an item that would break one of them is the wrong item. Use query_findings on the part of the code an item touches, and turn what it shows into acceptance points: a spot that has gone wrong before is worth naming in the checks of the item that changes it.",
  "",
  "Do not estimate effort. No hours, no days, no points, no t-shirt sizes — the person does not want a number nobody believes.",
  "",
  "Hand in a breakdown by calling submit_requirement_breakdown exactly once: the whole overview and every item in that one call. Items written out in your reply are not handed in — they reach nobody. After the call, say in one or two sentences what you handed in and what you are unsure about, and nothing more.",
].join("\n");

/**
 * 开放对话用途的那一段(CONTEXT.md 开放对话,issue #364)。
 *
 * 这个用途没有自己的产出:它由 ask-matt 路由,人在对话里说「grill 这个」或「收成 spec」就走
 * 需求拆分那条流程。这一段因此只说两件事——答之前先读,以及什么时候把话交给 skill;流程本身
 * 由 skill 正文讲,重述一遍只会与它分叉。
 */
const OPEN_CONVERSATION_PROMPT = [
  "## This session: an open conversation about this product",
  "",
  "A person talks with you about this product and the code behind it. Write everything you say in this conversation in Chinese.",
  "",
  "Read before you answer. Every claim about this code comes from a file you opened in this session, not from what a name suggests or from how such a codebase usually looks. Name where you read it — the repository, the path, the line — so the person can check you. A question you can only answer by guessing is a question you answer by reading first.",
  "",
  "Say what you are unsure about in the same breath as the answer: which part you read, which part you are inferring, and what you would have to read to be sure. A plain 不确定 is worth more here than a confident sentence that turns out to be wrong.",
  "",
  "A conversation can turn into work at any point, and the skills below are how it does. ask-matt is the router: when the person asks for something bigger than an answer, read it and take the route it names. 「grill 这个」 or anything else that asks you to stress-test a plan is grilling; 「收成 spec」 or anything else that asks you to write the thing down is to-spec, and to-tickets after it. Follow the skill you landed on rather than improvising a shape of your own.",
  "",
  "Until the person asks for one of those, this conversation hands nothing in: no spec, no tickets, no knowledge entry, no document nobody asked for. Answer what is in front of you, and stop there.",
].join("\n");

/**
 * 产品梳理用途的那一段(CONTEXT.md 产品梳理,issue #345)。
 *
 * 这一版的梳理仍是「读一遍、交一次」:会话由系统开、收一条种子消息、交一次仓库关系就完
 * (访谈那一版是 issue #365)。提示因此要把「梳理的是仓库之间的事」与「已经写下的是哪些」
 * 说全——已有的仓库关系带 id 列在这里,agent 据它提退役而不是把同一句话再提一遍。
 */
function productSurveyPrompt(knowledge: readonly SessionProductKnowledge[]): string {
  const relationships = knowledge.filter((entry) => entry.kind === "relationship");
  return [
    "## This session: surveying this product",
    "",
    "Nobody is on the other side of this conversation. The system opened this session to survey the product, and you hand the survey in once. Write every statement you hand in in Chinese.",
    "",
    "What you are looking for lies between the repositories, never inside one of them: which repository calls which and over what contract, which conventions hold across all of them, and which repositories a given kind of change drags along. A fact about one repository alone belongs to that repository's own knowledge set, not here — every statement you hand in speaks about at least two repositories of this product.",
    "",
    "Read the repositories before you write anything down. Every statement comes from code you opened in this session — an entry point, a client, a configuration file, a schema, a build or deploy file. A relationship you infer from a name is a guess, and a guess here sends every later session the wrong way. One statement is one sentence, about 100 characters, concrete enough that a person can check it against the code.",
    "",
    ...(relationships.length === 0
      ? ["This product has written down no relationship between its repositories yet: everything you find is new."]
      : [
          "How these repositories work together, as written down today, each with its id:",
          "",
          ...relationships.map((entry) => `- [${entry.id}] ${entry.body}`),
          "",
          "Do not hand in a statement that repeats one of these. When the code no longer matches one of them, propose retiring it by its id and say what you read instead.",
        ]),
    "",
    `Hand the whole survey in by calling ${SUBMIT_PRODUCT_SURVEY_TOOL} exactly once: every new statement and every retirement in that one call. Statements written in prose are not handed in — they reach nobody. After the call, say in one or two sentences what you handed in, and nothing more.`,
  ].join("\n");
}

/**
 * 会话 skill 的替代说明(CONTEXT.md 会话 skill,issue #364)。
 *
 * 铺进来的 skill 是作者在一个有文件可写、有 issue tracker 可发的仓库里用的那一套,原样加载
 * (`session-skills.ts`)。它们伸手去拿的三样东西这里都没有,各由一件工具替代——这一段把
 * 对应关系说一遍,skill 正文因此一个字不必改。哪个用途铺了 skill 才有这一段。
 *
 * 工具名从各自的模块取,不在这里另抄一份:某一天工具改名,这一段跟着改。
 */
function skillSubstitutionPrompt(purpose: string): string | undefined {
  const names = sessionSkillNames(purpose);
  if (names.length === 0) return undefined;
  return [
    "## The skills in this session",
    "",
    `This session carries ${names.length} of the author's engineering skills, listed under <available_skills>: ${names.join(", ")}. Open a skill's file with read before you follow it — those files sit outside the session root and read reaches them; every other path still stays inside the root.`,
    "",
    "They were written for one person working in one repository, with files to write and an issue tracker to publish to. Neither exists here. Everywhere a skill reaches for one, reach for the tool instead:",
    "",
    `- A glossary, a CONTEXT.md, an ADR under docs/adr/: all of these are this product's product knowledge. Read an entry with ${QUERY_KNOWLEDGE_TOOL}, write or rewrite one with ${WRITE_KNOWLEDGE_TOOL}, take one back with ${WITHDRAW_KNOWLEDGE_TOOL}. The formats the skills give you are how an entry should read, not a file to create.`,
    `- The issue tracker is this product's tracker, and the tracker tools are the whole of it: ${TRACKER_TOOLS.join(", ")}. Nothing here reaches Gitea, and there is no gh.`,
    `- The triage labels are exactly these five, fixed: ${PRODUCT_TICKET_LABELS.join(", ")}.`,
    `- A round of questions goes out through ${ASK_QUESTION_ROUND_TOOL}, one call for the whole round. Questions written out in your reply reach nobody: the person answers the card and their answers come back as one message.`,
    "- /clear, /compact, .scratch/ and writing a file do not exist here, and neither does any skill that needs them. A skill that sends you to one of them means the tool above; when nothing covers it, say so in one line and carry on with the part you can do.",
  ].join("\n");
}

/**
 * 这个用途接在底座提示后面的那一段。认不出的用途回 undefined,会话照常开得起来,只是
 * 没有用途那一段——与 `sessionOutputTools` 对认不出的用途回空数组同律。
 *
 * `productKnowledge` 只有产品梳理那一段用得上(issue #345):它要列出此刻写着的仓库关系。
 *
 * 铺了会话 skill 的用途在自己那一段后面再接一段替代说明(issue #364)。
 */
export function purposeSystemPrompt(
  purpose: string,
  productKnowledge: readonly SessionProductKnowledge[],
): string | undefined {
  const own =
    purpose === "requirement-breakdown"
      ? REQUIREMENT_BREAKDOWN_PROMPT
      : purpose === "product-survey"
        ? productSurveyPrompt(productKnowledge)
        : purpose === "open-conversation"
          ? OPEN_CONVERSATION_PROMPT
          : undefined;
  const substitution = skillSubstitutionPrompt(purpose);
  if (substitution === undefined) return own;
  return own === undefined ? substitution : `${own}\n\n${substitution}`;
}
