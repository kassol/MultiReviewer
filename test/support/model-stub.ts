/**
 * 本机的假模型服务:一个只听 `127.0.0.1` 的 HTTP 服务,按脚本逐次回 openai-completions
 * 协议的 SSE 响应。
 *
 * 与 `stub-fetch.ts` 不是一回事:那份打的是本进程的 `globalThis.fetch`,而 Reviewer 跑在
 * fork 出去的子进程里,取证子代理又在 pi-subagents 派出的第三个进程里——三个进程都要
 * 打到同一个模型地址,只有真起一个端口才够得着。用它跑的是真实 SDK 链路
 * (`createPiReviewer → worker → pi-subagents → read → transcript → ReviewerOutcome`),
 * 全程不碰收费模型。
 *
 * 脚本按请求到达顺序消费:取证一律前台跑,父会话等子会话回来才发下一次请求,顺序
 * 因此是确定的。每次请求解析出的形状记进 `requests`,测试据它断言「文件内容确实回到了
 * 模型请求里」这类事。脚本用完还有请求进来即回 500——那说明链路多发了一次调用,让它
 * 当场失败比静默回一份空响应好。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** 一次响应声明的用量。缓存两项不给即 0。 */
export type StubUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** 脚本里的一次响应:说一句话,或调一个工具(可以同时说一句)。 */
export type StubTurn = {
  text?: string;
  toolCall?: { name: string; args: unknown };
  usage: StubUsage;
};

/** 一次请求里测试关心的几样:带了哪些工具、消息序列长什么样。 */
export type StubRequest = {
  model: string;
  tools: string[];
  messages: { role: string; content: string; toolCallId?: string }[];
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
      return {
        role: String(m.role ?? ""),
        content: flattenContent(m.content),
        ...(typeof m.tool_call_id === "string" ? { toolCallId: m.tool_call_id } : {}),
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
  if (turn.toolCall !== undefined) {
    parts.push(
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-stub-${serial}`,
                  type: "function",
                  function: {
                    name: turn.toolCall.name,
                    arguments: JSON.stringify(turn.toolCall.args),
                  },
                },
              ],
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
        { index: 0, delta: {}, finish_reason: turn.toolCall === undefined ? "stop" : "tool_calls" },
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
  let next = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const parsed = parseRequest(body);
      requests.push(parsed);
      const turn = turns[next];
      next += 1;
      if (turn === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `脚本只有 ${turns.length} 次响应,这是第 ${next} 次请求` } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(sseBody(turn, next, parsed.model));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
