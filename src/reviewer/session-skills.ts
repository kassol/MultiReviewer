/**
 * 会话 skill(CONTEXT.md 会话 skill,issue #364)。
 *
 * 作者的工程 skill 随镜像 vendor 在 `vendor/skills/`,开会话时按用途拷进这次会话的临时
 * agentDir 的 `skills/`——Pi 把 agentDir 下的 `skills/` 当全局 skill 目录扫(它的
 * `docs/skills.md`),名字与描述因此自动进系统提示的 `<available_skills>`,正文由模型用
 * `read` 按需取。铺装时机与会话子代理同一处(`prepareAgentRuntime` 的 `installKit`)。
 *
 * 拷贝时改一处、也只改这一处:frontmatter 里的 `disable-model-invocation`。那一格在 Claude
 * Code 是「只让人用斜杠命令调」,在 Pi 是**整条从系统提示里摘掉**(`formatSkillsForPrompt`
 * 按它过滤),而会话里没有人替 agent 打斜杠命令——留着它,ask-matt、to-spec、to-tickets
 * 三个 skill 模型一个都看不见。`vendor/` 下那几份仍是作者的原样副本,升级 skill 就是重拷
 * 一遍,这一道改写留在代码里。
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 每个用途铺哪几个 skill(spec #357)。需要写文件、跑 git 或 shell 的那些一个都不铺——
 * 会话的工具面里没有它们要的工具,铺进来只会让模型照着一条走不通的路走。
 */
const SKILLS_BY_PURPOSE: Readonly<Record<string, readonly string[]>> = {
  "product-survey": ["grilling", "domain-modeling"],
  "requirement-breakdown": ["grilling", "domain-modeling", "to-spec", "to-tickets"],
  "open-conversation": ["ask-matt", "grilling", "domain-modeling", "to-spec", "to-tickets"],
};

/** 这个用途铺哪几个 skill。认不出的用途一个都不铺,会话照常开得起来。 */
export function sessionSkillNames(purpose: string): readonly string[] {
  return SKILLS_BY_PURPOSE[purpose] ?? [];
}

/** vendor 进镜像的 skill 目录。源码与它在镜像里是 `/app/src` 与 `/app/vendor`,同一层。 */
export function vendoredSkillsPath(): string {
  return fileURLToPath(new URL("../../vendor/skills", import.meta.url));
}

/** 这次会话的 skill 铺在 agentDir 的哪里。读工具要放行的那一段路径也是它。 */
export function sessionSkillsDir(agentDir: string): string {
  return join(agentDir, "skills");
}

/** frontmatter 里那一行摘掉。只认行首,正文里提到这个词的句子不动。 */
function stripDisableModelInvocation(skill: string): string {
  return skill.replace(/^disable-model-invocation:.*\r?\n/m, "");
}

/**
 * 把这个用途的 skill 拷进这次会话的 agentDir,返回铺了哪几个。
 *
 * 目录整个拷(`SKILL.md` 与它引用的格式文件都要在,skill 正文里是相对路径),拷完把
 * `SKILL.md` 里那一行摘掉。
 */
export function installSessionSkills(agentDir: string, purpose: string): readonly string[] {
  const names = sessionSkillNames(purpose);
  // 目录一律建出来,哪怕一个 skill 都不铺:资源加载器拿到的是一条固定路径,不存在时它会
  // 记一条「Skill path does not exist」的诊断,而「这个用途没有 skill」不是配置错误。
  const skillsDir = sessionSkillsDir(agentDir);
  mkdirSync(skillsDir, { recursive: true });
  for (const name of names) {
    const target = join(skillsDir, name);
    cpSync(join(vendoredSkillsPath(), name), target, { recursive: true });
    const file = join(target, "SKILL.md");
    writeFileSync(file, stripDisableModelInvocation(readFileSync(file, "utf8")));
  }
  return names;
}
