/**
 * SSE 响应的逐帧读取。审查轨迹流(issue #171)与 Agent 会话的记录流(issue #333)共用这
 * 一份:两条流是同一套管道,帧形状逐字相同。
 */
import assert from "node:assert/strict";

/** 一条 SSE 帧,按空行切开之后的三行。 */
export type Frame = { id?: string; event: string; data: string };

export function parseFrame(chunk: string): Frame {
  const frame: { id?: string; event: string; data: string } = { event: "message", data: "" };
  for (const line of chunk.split("\n")) {
    if (line.startsWith("id: ")) frame.id = line.slice(4);
    else if (line.startsWith("event: ")) frame.event = line.slice(7);
    else if (line.startsWith("data: ")) frame.data = line.slice(6);
  }
  return frame;
}

/**
 * 从 SSE 响应体里逐帧读。测试要能在流还开着的时候就看到已经到达的帧,不能等整个
 * 响应结束——「实时推送」这件事只有增量读得出来。
 */
export function frameReader(response: Response): {
  next(): Promise<Frame>;
  cancel(): Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: Frame[] = [];
  return {
    async next(): Promise<Frame> {
      for (;;) {
        const index = buffer.indexOf("\n\n");
        if (index !== -1) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          // 以冒号开头的是心跳注释帧,浏览器不当事件,这里也跳过。
          if (chunk.startsWith(":")) continue;
          return parseFrame(chunk);
        }
        if (pending.length > 0) return pending.shift()!;
        const { value, done } = await reader.read();
        assert.equal(done, false, "流已经关了,还差一帧没读到");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}
