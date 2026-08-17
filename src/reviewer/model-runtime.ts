/**
 * 面板与 Reviewer 子进程共用的模型运行时构件。
 *
 * Pi 把 pi.dev 的目录增量(overlay)落在一个 `models-store.json` 里,而 `ModelRuntime`
 * 默认把它放在 `modelsPath` 旁边——两侧的 `modelsPath` 都在各自每次新建的临时目录里,
 * 于是面板拉回来的 overlay 子进程根本读不到:面板列得出 348 个 openrouter 模型,子进程
 * 只有内置的 276 个,选中那多出来的 72 个之一,Review Run 上报「模型不存在」。
 *
 * 收口的办法是两侧指同一个绝对路径的 store,并且只有面板那侧联网。
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** 缓存根目录下专放 Pi 模型目录 overlay 的子目录。 */
const STORE_DIR = "pi-models";

/**
 * overlay 的落盘位置,绝对路径。
 *
 * 必须是绝对路径:子进程的 `cwd` 是工作副本(`pi-reviewer.ts`),而
 * `MULTIREVIEWER_CACHE_DIR` 的默认值是相对路径 `.cache/worktrees`,交给子进程按自己的
 * `cwd` 解析就会指到工作副本里去,两侧读的又不是同一份。`MULTIREVIEWER_CACHE_DIR` 本身
 * 传得进子进程:`env.ts` 的凭据剥离只认变量名里的 KEY/TOKEN 一类词,不命中它。
 *
 * 目录建不出来就返回 undefined:调用方退回 Pi 的默认位置(临时目录),只是失去共用与
 * 缓存,不影响读目录。
 */
export function modelsStorePath(): string | undefined {
  const dir = resolve(process.env["MULTIREVIEWER_CACHE_DIR"] ?? ".cache/worktrees", STORE_DIR);
  try {
    mkdirSync(dir, { recursive: true });
    return join(dir, "models-store.json");
  } catch {
    return undefined;
  }
}

/**
 * Reviewer 子进程侧的 `ModelRuntime`。
 *
 * `authPath` 与 `modelsPath` 指进子进程私有的空目录:默认值在 `~/.pi/agent` 下,那里的
 * auth.json 存着宿主机上配置过的每一家厂商的凭据,读到就等于凭据分割白做(ADR 0004)。
 * `modelsStorePath` 反过来必须指到共用的那一份,否则拿不到面板那侧落盘的 overlay。
 *
 * 全程不联网:`ModelRuntime.create` 只在显式传 `allowModelNetwork` 时才发请求,这里不传。
 * store 里的 overlay 仍然进得来——`create` 内部那一次 `refresh({allowNetwork: false})` 会先
 * 把 store 里的条目恢复进内存,再判断要不要联网,而恢复不受 4 小时刷新窗限制(过期只决定
 * 是否重新联网)。子进程因此一个对外目录请求都不发,却与面板看到同一份模型表。
 */
export function reviewerModelRuntime(
  agentDir: string,
  storePath: string | undefined,
): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    ...(storePath === undefined ? {} : { modelsStorePath: storePath }),
  });
}

/**
 * 「模型不存在」时补的一句成因指向。store 里没有任何 overlay 时,子进程手上只有 Pi
 * 内置的那一份目录,面板上选得到的远程模型这时一个都取不到——单看模型标识看不出这一层,
 * 运维会去查凭据和拼写。store 正常时返回空串,不给正常路径添噪。
 *
 * store 读不出来(文件不在、内容坏了、权限不够)与「没有 overlay」同一处理:两者对子
 * 进程的后果相同,而 Pi 自己也是这样降级的——它把每家 provider 的读取失败收进
 * `refresh` 的 `errors` 里而不抛,内置目录原样留着,审查照常跑得起来。
 */
export function missingModelHint(storePath: string | undefined): string {
  if (storePath !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Record<
        string,
        { models?: unknown[] } | undefined
      >;
      if (Object.values(parsed).some((entry) => (entry?.models?.length ?? 0) > 0)) return "";
    } catch {
      // 落到下面那句提示。
    }
  }
  const where = storePath === undefined ? "" : ` ${storePath}`;
  return `(远程模型目录缓存${where} 里没有 overlay,子进程手上只有 Pi 内置目录;面板读过一次模型目录之后它才落盘)`;
}
