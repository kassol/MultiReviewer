/**
 * 产品 tracker 的读写与渲染(CONTEXT.md 产品 tracker、spec、票,ADR 0035,issue #361)。
 *
 * 会话的 tracker 工具全部落在这一个入口上(`runTrackerRequest`):库在主进程,而「这张票
 * 在不在同一个产品」只有查过 spec 才说得出来,判定因此不留在子进程那一侧——子进程只把
 * 参数交上来,打回的理由与落库都在这里。打回走**正常返回**一句英文理由,与产出工具同一
 * 口径:模型看见理由就改得动。
 *
 * 导出的 Markdown 是给人读的一份文档(US 27),因此措辞用中文,票按依赖顺序排:一份拿到
 * 手上就能从第一张往下做的清单。
 */
import { isThenable } from "../async.ts";
import {
  PRODUCT_TICKET_LABELS,
  type AsyncStore,
  type ProductSpecRecord,
  type ProductTicketLabel,
  type ProductTicketRecord,
  type ProductTrackerState,
  type Store,
} from "../review/store.ts";
import type { TrackerRequest, TrackerTarget } from "../reviewer/session-protocol.ts";

/** 票正文与 spec 正文的上限。一份 spec 是几屏 Markdown,一张票短得多,两边同一个宽松的数。 */
export const TRACKER_BODY_MAX = 60_000;

/** 标题上限。一行放得下即可。 */
export const TRACKER_TITLE_MAX = 200;

/** 认领人那一格写给模型看的样子。 */
function claim(ticket: ProductTicketRecord): string {
  return ticket.claimedBy === null ? "unclaimed" : `claimed by ${ticket.claimedBy}`;
}

/** 阻塞它的那几张票,给模型看的一句。没有即空串。 */
function blockedSuffix(ticket: ProductTicketRecord): string {
  return ticket.blockedBy.length === 0
    ? ""
    : `, blocked by ${ticket.blockedBy.map((id) => `ticket ${id}`).join(" and ")}`;
}

/** 列表里的一张票。 */
function ticketLine(ticket: ProductTicketRecord): string {
  return `  - ticket ${ticket.id} (${ticket.state}, ${ticket.label}, ${claim(ticket)}${blockedSuffix(ticket)}) ${ticket.title}`;
}

/** 列表里的一条 spec 连同挂在它下面的票。 */
function specBlock(spec: ProductSpecRecord, tickets: readonly ProductTicketRecord[]): string[] {
  const own = tickets.filter((ticket) => ticket.specId === spec.id);
  return [
    `- spec ${spec.id} (${spec.state}) ${spec.title}`,
    ...(own.length === 0 ? ["  (no tickets yet)"] : own.map(ticketLine)),
  ];
}

/**
 * 票按依赖顺序排(US 27):阻塞它的票排在它前面。
 *
 * 只看这一份里的边——挡着它的票可能属于同一产品的另一条 spec,那一张不在这份文档里,
 * 排序因此不等它。有环时把剩下的按票号补在末尾:一份导出不该因为一个环就排不出来。
 */
export function trackerTicketOrder(
  tickets: readonly ProductTicketRecord[],
): ProductTicketRecord[] {
  const inside = new Set(tickets.map((ticket) => ticket.id));
  const waiting = new Map(
    tickets.map((ticket) => [
      ticket.id,
      new Set(ticket.blockedBy.filter((id) => inside.has(id))),
    ]),
  );
  const ordered: ProductTicketRecord[] = [];
  const left = [...tickets];
  while (left.length > 0) {
    const next = left.findIndex((ticket) => waiting.get(ticket.id)!.size === 0);
    // 一张都不自由即剩下的全在环里:按票号补完,顺序仍是确定的。
    if (next === -1) {
      ordered.push(...left.sort((a, b) => a.id - b.id));
      break;
    }
    const [taken] = left.splice(next, 1);
    ordered.push(taken!);
    for (const set of waiting.values()) set.delete(taken!.id);
  }
  return ordered;
}

/** 导出的 Markdown 里这几格的中文名。两个取值都在,读回来不必再兜底。 */
const STATE_TEXT: Record<ProductTrackerState, string> = { open: "开", closed: "关" };

/**
 * 一条 spec 连同它的票渲染成一份 Markdown(US 27)。票按依赖顺序,每张票先列标签、状态、
 * 认领人与阻塞它的票,再是正文。评论不进这一份:导出要给的是要做的事。
 */
export function specMarkdown(
  spec: ProductSpecRecord,
  tickets: readonly ProductTicketRecord[],
): string {
  const lines = [`# ${spec.title}`, "", `状态:${STATE_TEXT[spec.state]}`, ""];
  if (spec.body !== "") lines.push(spec.body, "");
  lines.push("## 票", "");
  if (tickets.length === 0) {
    lines.push("这条 spec 还没有拆出票。", "");
  }
  for (const ticket of trackerTicketOrder(tickets)) {
    lines.push(
      `### #${ticket.id} ${ticket.title}`,
      "",
      `- 标签:${ticket.label}`,
      `- 状态:${STATE_TEXT[ticket.state]}`,
      `- 认领人:${ticket.claimedBy ?? "无人认领"}`,
      `- 阻塞它的票:${ticket.blockedBy.length === 0 ? "无" : ticket.blockedBy.map((id) => `#${id}`).join("、")}`,
      "",
    );
    if (ticket.body !== "") lines.push(ticket.body, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** 认不出的 spec 与别的产品的 spec 说同一句话:看不到的产品里有什么,不该从这里问出来。 */
function noSpec(specId: number): string {
  return `there is no spec ${specId} in this product's tracker; call tracker_list to see what is there`;
}

function noTicket(ticketId: number): string {
  return `there is no ticket ${ticketId} in this product's tracker; call tracker_list to see what is there`;
}

/** 这个目标说成一句话:`spec 3` / `ticket 7`。 */
function targetText(target: TrackerTarget): string {
  return `${target.kind} ${target.id}`;
}

/**
 * 一次 tracker 读写走完的那几步:`yield` 出去的是一次 Store 调用,收回来的是它的结果
 * (`wait`),最后 `return` 的是交给模型的那一段文字。
 */
type TrackerSteps = Generator<unknown, string, unknown>;

/**
 * 等一次 Store 调用的结果。同步那一路拿到的就是值本身(issue #447)。
 *
 * 判定、落库与措辞只有 `trackerSteps` 那一份,而调用方一侧还持着同步的 `Store`
 * (`webhook/agent-session.ts`),迁过来的那一侧给的是异步门面。把库调用写成
 * `yield* wait(...)`,由 `runTrackerRequest` 按它是不是 Promise 决定等不等,两路因此
 * 共用同一段判定;同步那一路当场跑完,返回值仍是一句话。收缩那一票(#449)之后同步
 * 那一路没有了,这两处连同 `yield*` 一起换回 `await`。
 */
function* wait<T>(value: T): Generator<unknown, Awaited<T>, unknown> {
  return (yield value) as Awaited<T>;
}

/**
 * agent 对这个产品的 tracker 做的一次读写(issue #361)。回的是工具原样交给模型的那一段
 * 文字:做成了就一句确认,做不成就一句理由。
 *
 * `sessionId` 是发起它的那个会话:写下的 spec、票与评论都记在它名下(正文只由会话写)。
 */
export function runTrackerRequest(
  store: Store,
  productId: number,
  sessionId: number,
  request: TrackerRequest,
  at: string,
): string;
/** 库是异步门面的那一路(issue #447):这一句话等库回完才有。 */
export function runTrackerRequest(
  store: AsyncStore,
  productId: number,
  sessionId: number,
  request: TrackerRequest,
  at: string,
): Promise<string>;
export function runTrackerRequest(
  store: Store | AsyncStore,
  productId: number,
  sessionId: number,
  request: TrackerRequest,
  at: string,
): string | Promise<string> {
  const steps = trackerSteps(store, productId, sessionId, request, at);
  const step = (result: unknown): string | Promise<string> => {
    const next = steps.next(result);
    if (next.done === true) return next.value;
    return isThenable(next.value)
      ? Promise.resolve(next.value).then(step)
      : step(next.value);
  };
  return step(undefined);
}

function* trackerSteps(
  store: Store | AsyncStore,
  productId: number,
  sessionId: number,
  request: TrackerRequest,
  at: string,
): TrackerSteps {
  /** 这个产品下的一条 spec。别的产品的与不存在的都读作没有。 */
  function* specOf(specId: number): Generator<unknown, ProductSpecRecord | undefined, unknown> {
    const spec = yield* wait(store.getProductSpec(specId));
    return spec?.productId === productId ? spec : undefined;
  }
  /** 这个产品下的一张票。跨产品的边正是由这一判打回的。 */
  function* ticketOf(
    ticketId: number,
  ): Generator<unknown, ProductTicketRecord | undefined, unknown> {
    const ticket = yield* wait(store.getProductTicket(ticketId));
    return ticket?.productId === productId ? ticket : undefined;
  }

  switch (request.kind) {
    case "create-spec": {
      const title = request.title.trim();
      const body = request.body.trim();
      if (title === "") return "the spec has no title; name what it is about, in one line";
      if (title.length > TRACKER_TITLE_MAX) {
        return `the title is ${title.length} characters; keep it under ${TRACKER_TITLE_MAX}`;
      }
      if (body === "") return "the spec has no body; write the spec itself";
      if (body.length > TRACKER_BODY_MAX) {
        return `the body is ${body.length} characters; a spec is at most ${TRACKER_BODY_MAX}`;
      }
      const spec = yield* wait(store.createProductSpec({ productId, title, body, sessionId, at }));
      return `recorded as spec ${spec.id}; split it into tickets with tracker_create_ticket`;
    }
    case "create-ticket": {
      const title = request.title.trim();
      const body = request.body.trim();
      const label = request.label.trim() as ProductTicketLabel;
      if ((yield* specOf(request.specId)) === undefined) return noSpec(request.specId);
      if (!PRODUCT_TICKET_LABELS.includes(label)) {
        return `${request.label} is not one of this tracker's labels; use one of exactly: ${PRODUCT_TICKET_LABELS.join(", ")}`;
      }
      if (title === "") return "the ticket has no title; name the piece of work, in one line";
      if (title.length > TRACKER_TITLE_MAX) {
        return `the title is ${title.length} characters; keep it under ${TRACKER_TITLE_MAX}`;
      }
      if (body === "") return "the ticket has no body; say what has to be built and how it is checked";
      if (body.length > TRACKER_BODY_MAX) {
        return `the body is ${body.length} characters; a ticket is at most ${TRACKER_BODY_MAX}`;
      }
      const ticket = yield* wait(
        store.createProductTicket({
          specId: request.specId,
          title,
          body,
          label,
          sessionId,
          at,
        }),
      );
      return `recorded as ticket ${ticket.id} under spec ${request.specId}`;
    }
    case "list": {
      const specs = yield* wait(store.listProductSpecs(productId));
      const tickets = yield* wait(store.listProductTickets(productId));
      if (specs.length === 0) {
        return "this product's tracker is empty: no spec has been written yet. Write one with tracker_create_spec once the person and you agree on what is to be built.";
      }
      return [
        `this product's tracker has ${specs.length} spec(s) and ${tickets.length} ticket(s).`,
        "",
        ...specs.flatMap((spec) => specBlock(spec, tickets)),
      ].join("\n");
    }
    case "read": {
      const { target } = request;
      if (target.kind === "spec") {
        const spec = yield* specOf(target.id);
        if (spec === undefined) return noSpec(target.id);
        const own = (yield* wait(store.listProductTickets(productId))).filter(
          (ticket) => ticket.specId === spec.id,
        );
        return [
          `spec ${spec.id} (${spec.state}): ${spec.title}`,
          "",
          spec.body,
          "",
          ...(own.length === 0 ? ["It has no tickets yet."] : ["Its tickets:", ...own.map(ticketLine)]),
        ].join("\n");
      }
      const ticket = yield* ticketOf(target.id);
      if (ticket === undefined) return noTicket(target.id);
      const comments = yield* wait(store.listProductTicketComments(ticket.id));
      return [
        `ticket ${ticket.id} (${ticket.state}, ${ticket.label}, ${claim(ticket)}${blockedSuffix(ticket)}) of spec ${ticket.specId}: ${ticket.title}`,
        "",
        ticket.body,
        ...(comments.length === 0
          ? []
          : [
              "",
              "Comments:",
              ...comments.map(
                (comment) =>
                  `- ${comment.author ?? `session ${comment.sessionId ?? "?"}`}: ${comment.body}`,
              ),
            ]),
      ].join("\n");
    }
    case "update-body": {
      const { target } = request;
      const body = request.body.trim();
      if (body === "") return `the new body is empty; ${targetText(target)} keeps the body it has`;
      if (body.length > TRACKER_BODY_MAX) {
        return `the body is ${body.length} characters; the limit is ${TRACKER_BODY_MAX}`;
      }
      if (target.kind === "spec") {
        if ((yield* specOf(target.id)) === undefined) return noSpec(target.id);
        yield* wait(store.setProductSpecBody(target.id, body));
      } else {
        if ((yield* ticketOf(target.id)) === undefined) return noTicket(target.id);
        yield* wait(store.setProductTicketBody(target.id, body));
      }
      return `the body of ${targetText(target)} is rewritten`;
    }
    case "close": {
      const { target } = request;
      if (target.kind === "spec") {
        if ((yield* specOf(target.id)) === undefined) return noSpec(target.id);
        return (yield* wait(store.setProductSpecState(target.id, "closed", at)))
          ? `spec ${target.id} is closed`
          : `spec ${target.id} was already closed`;
      }
      if ((yield* ticketOf(target.id)) === undefined) return noTicket(target.id);
      return (yield* wait(store.setProductTicketState(target.id, "closed", at)))
        ? `ticket ${target.id} is closed`
        : `ticket ${target.id} was already closed`;
    }
    case "comment": {
      const body = request.body.trim();
      if ((yield* ticketOf(request.ticketId)) === undefined) return noTicket(request.ticketId);
      if (body === "") return "the comment is empty; say what you have to say";
      yield* wait(
        store.addProductTicketComment({
          ticketId: request.ticketId,
          author: null,
          sessionId,
          body,
          at,
        }),
      );
      return `comment recorded on ticket ${request.ticketId}`;
    }
    case "block":
    case "unblock": {
      const { ticketId, blockedById } = request;
      if ((yield* ticketOf(ticketId)) === undefined) return noTicket(ticketId);
      if (ticketId === blockedById) {
        return `ticket ${ticketId} cannot block itself; a blocking edge goes between two different tickets`;
      }
      // 别的产品的票在这一判上与不存在的同形:边只在同一个产品的票之间(CONTEXT.md 票)。
      if ((yield* ticketOf(blockedById)) === undefined) return noTicket(blockedById);
      if (request.kind === "block") {
        yield* wait(store.addProductTicketBlock(ticketId, blockedById));
        return `ticket ${ticketId} is now blocked by ticket ${blockedById}`;
      }
      return (yield* wait(store.removeProductTicketBlock(ticketId, blockedById)))
        ? `ticket ${ticketId} is no longer blocked by ticket ${blockedById}`
        : `ticket ${ticketId} was not blocked by ticket ${blockedById}`;
    }
  }
}
