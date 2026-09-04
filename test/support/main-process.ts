/**
 * 进程入口 `main.ts` 的 spawn 骨架(issue #249)。
 *
 * 启动那一档的用例(`main-boot` 与 `drain`)都要做同三件事:起一个真进程、把 stdout 与
 * stderr 并成一条文本、等它打出监听行。三件事只有一份,各用例只写自己那部分收尾。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
/** 服务起好之后打的那一行。用例据它判「起来了」。 */
export const LISTENING = "MultiReviewer webhook 监听";

export type MainProcess = {
  child: ReturnType<typeof spawn>;
  /** 到此刻为止的 stdout 加 stderr。 */
  output: () => string;
  /** 监听行首次出现时 resolve。进程没起来就一直不 resolve,也不 reject。 */
  listening: Promise<void>;
};

export function spawnMain(cwd: string, env: NodeJS.ProcessEnv): MainProcess {
  const child = spawn(process.execPath, [MAIN], { cwd, env });
  let output = "";
  let announce = (): void => {};
  const listening = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.includes(LISTENING)) announce();
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, output: () => output, listening };
}
