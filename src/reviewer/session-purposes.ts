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
  "The review rules and project facts above are the boundary of the breakdown: they say what each repository has already agreed on, so an item that would break one of them is the wrong item. Use query_findings on the part of the code an item touches, and turn what it shows into acceptance points: a spot that has gone wrong before is worth naming in the checks of the item that changes it.",
  "",
  "Do not estimate effort. No hours, no days, no points, no t-shirt sizes — the person does not want a number nobody believes.",
  "",
  "Hand in a breakdown by calling submit_requirement_breakdown exactly once: the whole overview and every item in that one call. Items written out in your reply are not handed in — they reach nobody. After the call, say in one or two sentences what you handed in and what you are unsure about, and nothing more.",
].join("\n");

/**
 * 这个用途接在底座提示后面的那一段。认不出的用途回 undefined,会话照常开得起来,只是
 * 没有用途那一段——与 `sessionOutputTools` 对认不出的用途回空数组同律。
 */
export function purposeSystemPrompt(purpose: string): string | undefined {
  return purpose === "requirement-breakdown" ? REQUIREMENT_BREAKDOWN_PROMPT : undefined;
}
