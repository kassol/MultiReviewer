/**
 * Agent 会话的图片附件(spec #329,issue #336)。
 *
 * 三件事在这一份里:**落盘**(按 Pi 的缩放默认缩到阈值内,写进 data 目录)、**记录里的
 * 文件引用**(落库前把 Pi 条目里的 base64 图片块换成引用,喂回 Pi 时读文件填回 base64)、
 * **删除**(会话没了连目录一起删)。
 *
 * 缩放直接用 Pi 导出的 `resizeImage`:它的默认就是 4.5MB / 2000px 那一套(Anthropic 的 5MB
 * 内联上限之下留余量),自己再写一份只会与模型侧的真实上限错开。它在 worker 线程里跑 Photon,
 * 跑完就 terminate。
 *
 * 放在 `reviewer/` 下的理由与别的 Pi 用法相同:Pi 的 import 只在这个目录里(`src/AGENTS.md`)。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { resizeImage } from "@earendil-works/pi-coding-agent";

/** 一条消息最多带几张图(spec #329)。超过这个数的那一条当场回绝,不截断。 */
export const MAX_AGENT_SESSION_IMAGES = 4;

/**
 * 收得下的图片类型与它们的扩展名。只放四种模型侧普遍认的格式:能解码不等于模型看得懂,
 * 而存进来的东西迟早要原样喂给模型。
 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * 这个 content type 是不是收得下的图片。带 `; charset=` 之类参数的也认——浏览器上传时
 * 带不带参数由它自己决定。认不出回 undefined。
 *
 * 白名单用 `Object.hasOwn` 查,与 `isInDiff` 同口径:`in` 连原型上的键一起认,
 * `content-type: constructor` 那一条因此会被当成合法图片类型。
 */
export function agentSessionImageMimeType(contentType: string | undefined): string | undefined {
  const mimeType = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  return Object.hasOwn(IMAGE_EXTENSIONS, mimeType) ? mimeType : undefined;
}

/**
 * 这个会话的图片目录:`<data 目录>/agent-sessions/<会话 id>`。data 目录就是库文件所在的
 * 目录(容器里是 `/data`),备份范围因此不变——库与图片在同一个目录下(spec #329 的部署约定)。
 */
export function agentSessionImageDir(dbPath: string, sessionId: number): string {
  return join(dirname(resolve(dbPath)), "agent-sessions", String(sessionId));
}

/** 落好盘的一张图。`path` 与 `mimeType` 进库,宽高只回给上传方看一眼缩成了多少。 */
export type StoredAgentSessionImage = {
  imageId: string;
  path: string;
  mimeType: string;
  width: number;
  height: number;
};

/**
 * 缩到阈值内再落盘。缩不动(Photon 不在,或怎么缩都超过阈值)回 undefined,由调用方回绝
 * 这一次上传——存一张模型收不下的图,只会在人发消息时才失败。
 *
 * 缩放可能换格式(PNG 与 JPEG 各试一遍取小的那个),因此扩展名与入库的 mimeType 都取结果
 * 那一份,不取上传时声明的。
 */
export async function storeAgentSessionImage(
  dbPath: string,
  sessionId: number,
  bytes: Uint8Array,
  mimeType: string,
): Promise<StoredAgentSessionImage | undefined> {
  const resized = await resizeImage(bytes, mimeType);
  if (resized === null) return undefined;
  const extension = IMAGE_EXTENSIONS[resized.mimeType] ?? IMAGE_EXTENSIONS[mimeType]!;
  const imageId = randomUUID();
  const dir = agentSessionImageDir(dbPath, sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${imageId}.${extension}`);
  writeFileSync(path, Buffer.from(resized.data, "base64"));
  return {
    imageId,
    path,
    mimeType: resized.mimeType,
    width: resized.width,
    height: resized.height,
  };
}

/** 这个会话的图片目录连里面的文件一起删。目录不存在不是错误。 */
export function removeAgentSessionImages(dbPath: string, sessionId: number): void {
  rmSync(agentSessionImageDir(dbPath, sessionId), { recursive: true, force: true });
}

/**
 * 会话记录里的一张图(ADR 0031 的图片例外):只存文件引用,不存 base64——一张图的 base64
 * 有几 MB,落进记录表就等于每次读记录都把它搬一遍。
 */
export type AgentSessionImageRef = {
  type: "image-ref";
  imageId: string;
  /** 文件的绝对路径。重建时按它读回 base64。 */
  path: string;
  mimeType: string;
};

/** 一条消息带的那几张图的引用。IPC 与排队镜像里都是这一份。 */
export function agentSessionImageRef(image: {
  imageId: string;
  path: string;
  mimeType: string;
}): AgentSessionImageRef {
  return {
    type: "image-ref",
    imageId: image.imageId,
    path: image.path,
    mimeType: image.mimeType,
  };
}

/** 文件被手动删掉之后那一块在上下文里的样子。人看得见 agent 为什么没看到图。 */
export const MISSING_IMAGE_TEXT = "[图片已丢失]";

/** 一个内容块是不是 base64 图片块(Pi 的 `ImageContent`)。 */
function isImageBlock(part: unknown): boolean {
  return (part as { type?: unknown } | null)?.type === "image";
}

/** 一个内容块是不是落库过的图片引用。 */
function isImageRef(part: unknown): part is AgentSessionImageRef {
  const ref = part as { type?: unknown; path?: unknown; mimeType?: unknown } | null;
  return (
    ref?.type === "image-ref" && typeof ref.path === "string" && typeof ref.mimeType === "string"
  );
}

/** 这条 Pi 条目的消息内容,是分块数组时才给得出。 */
function contentBlocks(entry: unknown): unknown[] | undefined {
  const content = (entry as { message?: { content?: unknown } } | null)?.message?.content;
  return Array.isArray(content) ? content : undefined;
}

/** 把条目换一份新的消息内容,其余字段原样。 */
function withContent(entry: unknown, content: unknown[]): unknown {
  const row = entry as { message?: Record<string, unknown> };
  return { ...(entry as object), message: { ...row.message, content } };
}

/**
 * 落库前把这条 Pi 条目里的 base64 图片块换成文件引用(issue #336)。
 *
 * 图片是这一侧刚刚随 prompt 发出去的那几张,`refs` 是它们的引用、顺序即投递顺序:第 k 个
 * 图片块配第 k 个引用,取走即从队列里摘掉。条目里没有图片块时原样返回。
 */
export function deflateImageBlocks(entry: unknown, refs: AgentSessionImageRef[]): unknown {
  const content = contentBlocks(entry);
  if (content === undefined || !content.some(isImageBlock)) return entry;
  const replaced = content.map((part) => {
    if (!isImageBlock(part)) return part;
    const ref = refs.shift();
    return ref ?? { type: "text", text: MISSING_IMAGE_TEXT };
  });
  return withContent(entry, replaced);
}

/**
 * 重建子进程时把文件引用读回 base64(issue #336)。文件被手动删掉的那一块换成占位文本:
 * 丢一块图不该让整段历史重建不起来,而 agent 要知道这里本来有张图。
 *
 * 纯函数:进去一段条目、出来一段条目,只读文件不写库。重建那一侧(issue #335)直接喂它的
 * 返回值给 Pi 的内存会话管理器。
 */
export function inflateImageRefs(entries: readonly unknown[]): unknown[] {
  return entries.map((entry) => {
    const content = contentBlocks(entry);
    if (content === undefined || !content.some(isImageRef)) return entry;
    return withContent(
      entry,
      content.map((part) => (isImageRef(part) ? imageBlock(part) : part)),
    );
  });
}

/** 一张图喂给 Pi 的形状(`ImageContent`)。文件读不到即占位文本块。 */
function imageBlock(ref: AgentSessionImageRef): unknown {
  try {
    return { type: "image", data: readFileSync(ref.path).toString("base64"), mimeType: ref.mimeType };
  } catch {
    return { type: "text", text: MISSING_IMAGE_TEXT };
  }
}

/**
 * 子进程发 prompt 时要交给 Pi 的那几张图:读文件填 base64。base64 不过 IPC——一张 4.5MB 的
 * 图经 IPC 传过来要再序列化一遍,而子进程读同一个文件就够了。读不到的那一张直接不带:
 * 这是刚上传完的文件,读不到只可能是部署层面的事故,此刻静静少一张比整条消息发不出去好。
 */
export function readAgentSessionImages(
  refs: readonly AgentSessionImageRef[],
): { type: "image"; data: string; mimeType: string }[] {
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const ref of refs) {
    const block = imageBlock(ref);
    if ((block as { type: string }).type === "image") {
      images.push(block as { type: "image"; data: string; mimeType: string });
    }
  }
  return images;
}
