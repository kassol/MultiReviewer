/**
 * 编排进程持有 forge 凭据与全部厂商的模型凭据,而 Reviewer 读取的 PR diff 属于
 * 半可信输入。子进程的环境因此重建而非继承:先剥掉父进程里一切像凭据的变量,
 * 再只放回该 Reviewer 绑定厂商的那一份(ADR 0004)。
 */

/** 变量名命中其一即视为凭据,不传给子进程。 */
const CREDENTIAL_PATTERN = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH)(?:_|$)/i;

/**
 * 模型凭据经这一个固定变量进入子进程,再由 worker 注入 Pi 的运行时。
 * 走环境变量而非 IPC 消息:消息可能被日志或崩溃转储带出去。
 */
export const MODEL_API_KEY_ENV = "MULTIREVIEWER_MODEL_API_KEY";

/**
 * Pi 默认从 `~/.pi/agent` 读 `auth.json`,那里有宿主机上配置过的每一家厂商的凭据。
 * 剥掉环境变量挡不住它,必须把 Pi 的 agent 目录也指到子进程私有的临时目录。
 */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** 子进程失败文本会经 IPC 回主进程；若下游异常回显请求凭据，先在边界处抹掉。 */
export function redactModelCredential(text: string, credential: string | undefined): string {
  return credential === undefined || credential === "" ? text : text.replaceAll(credential, "[REDACTED]");
}

export function reviewerEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
  vendorEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (CREDENTIAL_PATTERN.test(name)) continue;
    env[name] = value;
  }

  // 显式给定的厂商凭据最后写入,父进程里的同名陈旧值不得覆盖它。
  for (const [name, value] of Object.entries(vendorEnv)) {
    env[name] = value;
  }

  return env;
}
