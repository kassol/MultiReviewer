/**
 * 本机的假模型服务:一个只听 `127.0.0.1` 的 HTTP 服务,按脚本逐次回 openai-completions
 * 协议的 SSE 响应。
 *
 * 与 `stub-fetch.ts` 不是一回事:那份打的是本进程的 `globalThis.fetch`,而 Reviewer 跑在
 * fork 出去的子进程里,取证子会话又是 pi-subagents 在那个子进程内另建的会话(issue #262)
 * ——两边都要打到同一个模型地址,只有真起一个端口才够得着。用它跑的是真实 SDK 链路
 * (`createPiReviewer → worker → pi-subagents → read → transcript → ReviewerOutcome`),
 * 全程不碰收费模型。
 *
 * 脚本按请求到达顺序消费:取证一律前台跑,父会话等子会话回来才发下一次请求,顺序
 * 因此是确定的。一次取证被停下之后两边各自发请求,顺序就由机器负载决定,那种用例给
 * `match` 按「谁在问」认领(issue #397)。每次请求解析出的形状记进 `requests`,测试据它
 * 断言「文件内容确实回到了模型请求里」这类事。脚本用完还有请求进来即回 500——那说明链路
 * 多发了一次调用,让它当场失败比静默回一份空响应好。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { testCleanups } from "./git-fixture.ts";

/** 一次响应声明的用量。缓存两项不给即 0。 */
export type StubUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** 脚本里的一次响应:说一句话,或调一个 / 一批工具(可以同时说一句)。 */
export type StubTurn = {
  text?: string;
  toolCall?: { name: string; args: unknown };
  /**
   * 一条助手消息里的一批工具调用(issue #334):Pi 把整批跑完才到下一个回合边界,插话因此
   * 要靠它才验得到「不打断正在跑的工具批次」。与 `toolCall` 同时给时两者都发出去。
   */
  toolCalls?: readonly { name: string; args: unknown }[];
  usage: StubUsage;
  /**
   * 收到请求后先等这么久再回(issue #262):用来让一次取证撞上它自己的超时。请求到达
   * 那一刻就记进 `requests`,与回不回、回得多晚无关。
   */
  delayMs?: number;
  /**
   * 等测试兑现它再回:回应何时放行由测试侧决定,不靠 `delayMs` 跑赢机器负载。与 `delayMs`
   * 同给时先等它、再计延迟。
   */
  release?: Promise<unknown>;
  /**
   * 不回正文,回这个 HTTP 状态与一段 JSON 错误(issue #262),错误文案取 `text`:扮演一次
   * 服务端失败。状态与文案决定 Pi 会不会重试——408/409/429/5xx 走 SDK 的重试,文案里带
   * `insufficient_quota` 之类的额度字样则两层都不重试。
   */
  status?: number;
  /**
   * 只回给匹配的请求(issue #397)。脚本默认按到达顺序消费,而父会话与子会话各自发请求的
   * 用例里谁先到取决于机器负载——取证超时那一条就是父会话的收尾与被停下的子会话抢同一条
   * 脚本。给了它就按「谁在问」认领(工具面分得出父子),到达顺序不再进判据。
   */
  match?: (request: StubRequest) => boolean;
};

/** 一次请求里测试关心的几样:带了哪些工具、消息序列长什么样。 */
export type StubRequest = {
  model: string;
  tools: string[];
  messages: {
    role: string;
    content: string;
    toolCallId?: string;
    /**
     * 这条消息带的图片(issue #336):openai-completions 协议里一个 `image_url` 块的
     * `data:<mimeType>;base64,<data>`,拆成两格。一张图都没带时这一格缺席。
     */
    images?: { mimeType: string; data: string }[];
  }[];
};

export type ModelStub = {
  baseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
};

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      const text = (part as { text?: unknown } | null)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/** 这条消息里的图片块(issue #336)。data URL 拆成 mimeType 与 base64 两格。 */
function imagesOf(content: unknown): { mimeType: string; data: string }[] {
  if (!Array.isArray(content)) return [];
  const images: { mimeType: string; data: string }[] = [];
  for (const part of content) {
    const url = (part as { image_url?: { url?: unknown } } | null)?.image_url?.url;
    if (typeof url !== "string") continue;
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (match !== null) images.push({ mimeType: match[1]!, data: match[2]! });
  }
  return images;
}

function parseRequest(body: Record<string, unknown>): StubRequest {
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  return {
    model: String(body["model"] ?? ""),
    tools: tools.map((tool: unknown) =>
      String((tool as { function?: { name?: unknown } } | null)?.function?.name ?? ""),
    ),
    messages: messages.map((message: unknown) => {
      const m = message as { role?: unknown; content?: unknown; tool_call_id?: unknown };
      const images = imagesOf(m.content);
      return {
        role: String(m.role ?? ""),
        content: flattenContent(m.content),
        ...(typeof m.tool_call_id === "string" ? { toolCallId: m.tool_call_id } : {}),
        ...(images.length === 0 ? {} : { images }),
      };
    }),
  };
}

/** 一次响应的 SSE 正文。用量放在最后那个没有 choices 的块里,与 OpenAI 的流式约定一致。 */
function sseBody(turn: StubTurn, serial: number, model: string): string {
  const id = `chatcmpl-stub-${serial}`;
  const chunk = (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, ...payload })}\n\n`;
  const parts: string[] = [];
  if (turn.text !== undefined) {
    parts.push(
      chunk({
        choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }],
      }),
    );
  }
  const calls = [...(turn.toolCall === undefined ? [] : [turn.toolCall]), ...(turn.toolCalls ?? [])];
  if (calls.length > 0) {
    parts.push(
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: calls.map((call, index) => ({
                index,
                id: `call-stub-${serial}-${index}`,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
            finish_reason: null,
          },
        ],
      }),
    );
  }
  parts.push(
    chunk({
      choices: [
        { index: 0, delta: {}, finish_reason: calls.length === 0 ? "stop" : "tool_calls" },
      ],
    }),
  );
  const cacheRead = turn.usage.cacheRead ?? 0;
  const cacheWrite = turn.usage.cacheWrite ?? 0;
  parts.push(
    chunk({
      choices: [],
      usage: {
        // pi-ai 把 prompt_tokens 减去两项缓存后当作 input,这里因此把缓存加回去。
        prompt_tokens: turn.usage.input + cacheRead + cacheWrite,
        completion_tokens: turn.usage.output,
        total_tokens: turn.usage.input + cacheRead + cacheWrite + turn.usage.output,
        prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
      },
    }),
  );
  parts.push("data: [DONE]\n\n");
  return parts.join("");
}

/** 起一个假模型服务,脚本按到达顺序消费。返回的 `baseUrl` 直接当运行模型的 `baseUrl` 用。 */
export async function startModelStub(turns: readonly StubTurn[]): Promise<ModelStub> {
  const requests: StubRequest[] = [];
  /** 已经认领掉的那几条。带 `match` 的用例里认领顺序与到达顺序不一定相同。 */
  const taken = turns.map(() => false);
  let next = 0;
  /**
   * 还没到点的延迟响应(issue #335)。`close()` 要把它们清掉:一个挂着的 `setTimeout` 会让
   * 测试进程在用例跑完之后继续活到它到点,验「名额满」那种用例挂的正是几十秒的延迟。
   */
  const delayed = new Set<NodeJS.Timeout>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const parsed = parseRequest(body);
      requests.push(parsed);
      next += 1;
      // 没给 `match` 的一条谁都认:脚本因此默认还是按到达顺序消费。
      const index = turns.findIndex(
        (candidate, position) => !taken[position] && (candidate.match?.(parsed) ?? true),
      );
      const turn = index === -1 ? undefined : turns[index];
      if (index !== -1) taken[index] = true;
      if (turn === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `脚本只有 ${turns.length} 次响应,这是第 ${next} 次请求` } }));
        return;
      }
      const respond = (): void => {
        if (turn.status !== undefined) {
          res.writeHead(turn.status, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: turn.text ?? `脚本让第 ${next} 次请求回 ${turn.status}` },
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sseBody(turn, next, parsed.model));
      };
      const afterDelay = (): void => {
        if (turn.delayMs === undefined) {
          respond();
          return;
        }
        const timer = setTimeout(() => {
          delayed.delete(timer);
          respond();
        }, turn.delayMs);
        delayed.add(timer);
      };
      if (turn.release === undefined) afterDelay();
      else void turn.release.then(afterDelay);
    });
  });
  // 空闲的 keep-alive 连接不由服务端关(issue #397,同 `fake-gitea.ts`):服务端 5 秒、客户端
  // 4 秒,负载下客户端晚一秒就会在一条已关的连接上发请求并拿回 ECONNRESET,而那一次失败在
  // Pi 那边会变成一次重试,把脚本多吃一条。
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= new Promise<void>((resolve, reject) => {
      for (const timer of delayed) clearTimeout(timer);
      delayed.clear();
      server.closeAllConnections();
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }));
  // 起来即进文件级收尾队列:用例在拿到 `close` 之前就抛了(harness 建到一半断言失败),
  // 监听着的服务会让测试进程跑完所有用例也退不出去。`close` 因此幂等,用例自己关过也不碍事。
  testCleanups().push(close);
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close };
}
