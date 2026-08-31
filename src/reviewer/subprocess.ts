/**
 * Reviewer 与规则 agent 共用的子进程生命周期(issue #209)。
 *
 * 两条链路 fork 出去的都是同一种东西:一个只带自家厂商凭据的一次性 worker,经 IPC
 * 逐条回传产出,末尾一条收尾消息。进程怎么起、怎么等、怎么判成败在这里只有一份;
 * 消息里的产出怎么收由调用方在 `onMessage` 里自己做。
 */
import { fork, type ChildProcess, type Serializable } from "node:child_process";

import { MODEL_API_KEY_ENV, reviewerEnv } from "./env.ts";

/**
 * 一个卡住的子进程不是失败,是永远不返回。没有这道闸,整次 Review Run 会被它拖住不
 * 结束,工作树也随之永不释放。
 *
 * 闸计的是**连续静默**,不是总时长(2026-09-01 取代总时长上限):健康的会话 IPC 常鸣
 * ——旁白、工具调用隔几秒就一条,真正的卡死表现为彻底沉默。按总时长计两头都错:大
 * Review Range 认真跑几十分钟会被误杀,二十秒的合并 agent 卡死却要陪满整个上限。
 * 每收到一条消息就重置计时,跑多久都行,哑火五分钟即判死。
 */
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

/** 回报结果之后留给子进程收尾的时间。超过就当它退不掉,强杀并按已收到的结果结束。 */
const EXIT_GRACE_MS = 5000;

/** 子进程这一次的成败。`exitCode` 只在非零退出时有值。 */
export type ChildOutcome = { failure?: string; exitCode?: number };

/** 两条链路的收尾消息共用这一个形状:`runWorkerChild` 只认这两个字段。 */
type ChildMessage = { kind: string; failure?: string };

export type ChildRun<M extends ChildMessage> = {
  workerPath: string;
  /**
   * 子进程的 cwd 也落在工作副本里。只设 Pi 的 cwd 不够:模型会拼出相对于编排进程
   * 目录的路径,报出来的 file 因此指不到仓库里的文件。
   */
  worktreePath: string;
  /** 该链路绑定厂商的模型凭据。子进程的环境里只会有这一份。 */
  apiKey: string;
  /** 超时文案里的主语,例如 `Reviewer`。 */
  timeoutSubject: string;
  /** 起来之后投递给子进程的任务。凭据不进 IPC 消息。 */
  payload: Serializable;
  /** 子进程回传的每一条消息,收尾那条也在内。 */
  onMessage: (message: M) => void;
  /** 静默上限的测试注入口。生产不传,取默认的五分钟。 */
  inactivityTimeoutMs?: number;
};

/**
 * fork 一个 worker,收满它的消息并判定这一次的成败。`workerPath` 是参数而非常量,
 * 使失败路径(未回报即退出、被信号终止)能用受控的 worker 脚本驱动测试。
 */
export function runWorkerChild<M extends ChildMessage>(run: ChildRun<M>): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let done: M | undefined;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    let child: ChildProcess;
    try {
      child = fork(run.workerPath, {
        cwd: run.worktreePath,
        env: reviewerEnv(process.env, { [MODEL_API_KEY_ENV]: run.apiKey }),
        // 不继承父进程的 execArgv。worker 是普通脚本,继承会把父进程的运行模式带过来
        // ——在 `node --test` 下跑时,worker 会被当成测试文件启动并挂住不退出。
        execArgv: [],
        // 子进程的 stdout/stderr 归入服务日志,不参与协议。
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch (error) {
      // 工作副本目录不存在时 fork 同步抛。这是一次调用的失败,
      // 不该把整次 Review Run 一起掀掉。
      resolve({
        failure: `子进程无法启动: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    const finish = (failure: string | undefined, exitCode?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      child.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      resolve({
        ...(failure === undefined ? {} : { failure }),
        // 退出码只在失败时有意义,进轨迹的失败事件带上它(issue #171)。
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    };

    const silence = run.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
    const silenceFailure = `${run.timeoutSubject} 卡死:连续 ${silence / 60_000} 分钟没有任何回传`;
    let timer = setTimeout(() => finish(silenceFailure), silence);

    child.on("message", (message: M) => {
      run.onMessage(message);
      // 每一条消息都是活着的证据,静默计时从头再来。
      clearTimeout(timer);
      if (message.kind !== "done") {
        timer = setTimeout(() => finish(silenceFailure), silence);
        return;
      }
      done = message;
      // 结果已经拿到,不该再为一个赖着不退出的子进程等下去。
      graceTimer = setTimeout(() => finish(message.failure), EXIT_GRACE_MS);
    });

    child.on("error", (error) => finish(`子进程无法启动: ${error.message}`));

    child.on("exit", (code, signal) => {
      // 退出码优先于会话状态:子进程异常终止时 `done` 根本没发出来,会话内的失败信号
      // 都读不到,退出码是唯一的信号。
      if (done === undefined) {
        finish(
          signal === null
            ? `子进程未回报结果即退出,退出码 ${code}`
            : `子进程被信号 ${signal} 终止`,
          code ?? undefined,
        );
        return;
      }
      if (code !== 0) {
        finish(done.failure ?? `子进程退出码 ${code}`, code ?? undefined);
        return;
      }
      finish(done.failure);
    });

    // 必须带 callback:子进程起不来时(例如工作副本目录不存在)投递会失败,
    // 没有 callback 时 Node 把 EPIPE 异步抛出去,try/catch 拦不住,
    // 一个 Reviewer 的失败会掀掉整次 Review Run。
    child.send(run.payload, (error) => {
      if (error !== null) finish(`无法向子进程投递任务: ${error.message}`);
    });
  });
}
