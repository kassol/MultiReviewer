/**
 * Agent 会话的图片附件(spec #329,issue #336)。
 *
 * 缝与别的面板用例相同:真 HTTP、临时库、图片文件落临时库所在的那个目录(部署里的 data
 * 目录)。压的是票的验收:上传落点与库里只有引用、超限图片被缩到阈值内、第 5 张被拒、
 * 目录能力不含 image 时回绝而换了模型就恢复、删会话连文件一起删。
 *
 * 图片进模型请求那一条在 `agent-session-subprocess.test.ts`:那里有真子进程与假模型服务。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { openStore } from "../src/review/store.ts";
import {
  deflateImageBlocks,
  inflateImageRefs,
  MISSING_IMAGE_TEXT,
  type AgentSessionImageRef,
} from "../src/reviewer/session-images.ts";
import {
  HARNESS_SPEC,
  scopedUser,
  seedAvailableModelService,
  seedRepo,
  startPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { pngBytes, pngSize } from "./support/png.ts";
import { putGlobalSettings } from "./support/store-seed.ts";

const PASSWORD = "agent-session-image-password";
const AT = "2026-09-12T00:00:00.000Z";
const PURPOSE = "requirement-breakdown";
const REPO_ID = 4242;

/** 一家看得了图的模型服务。目录里的输入能力就是判据(issue #336)。 */
const VISION = { provider: "vision", model: "sees-images" };

function as(
  h: PanelHarness,
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${h.serverUrl}/api${path}`, {
    method,
    headers: {
      cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function upload(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  bytes: Buffer,
  contentType = "image/png",
): Promise<Response> {
  return fetch(`${h.serverUrl}/api/agent-sessions/${sessionId}/images`, {
    method: "POST",
    headers: { cookie, "content-type": contentType },
    body: bytes,
  });
}

type UploadedImage = { imageId: string; mimeType: string; width: number; height: number };

async function uploaded(
  h: PanelHarness,
  cookie: string,
  sessionId: number,
  bytes: Buffer,
): Promise<UploadedImage> {
  const response = await upload(h, cookie, sessionId, bytes);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { image: UploadedImage }).image;
}

/**
 * 起一套图片收得下的 harness:仓库进注册表、产品挂上它、创建者有 `agent:chat`,模型服务的
 * 目录声明看得了图。`imageInput` 为假那一档的用例自己传 `input: ["text"]`。
 */
async function startImageHarness(
  input: readonly ("text" | "image")[] = ["text", "image"],
): Promise<{ h: PanelHarness; cookie: string; productId: number; sessionId: number }> {
  const h = await startPanelHarness();
  seedModelService(h, HARNESS_SPEC.provider, HARNESS_SPEC.model, input);
  seedRepo(h, REPO_ID, "acme", "widgets");
  const created = await h.api("POST", "/products", { name: "报销系统" });
  assert.equal(created.status, 201);
  const { product } = (await created.json()) as { product: { id: number } };
  assert.equal((await h.api("PUT", `/products/${product.id}/repos/${REPO_ID}`)).status, 204);
  const cookie = await scopedUser(h, "member", PASSWORD, AT, [REPO_ID], ["agent:chat"]);
  const sessionId = await createSession(h, cookie, product.id);
  return { h, cookie, productId: product.id, sessionId };
}

/** 播一家模型服务,目录里的输入能力由用例给定。 */
function seedModelService(
  h: PanelHarness,
  provider: string,
  model: string,
  input: readonly ("text" | "image")[],
): void {
  seedAvailableModelService(h, provider, [model], { input: [...input] });
}

async function createSession(
  h: PanelHarness,
  cookie: string,
  productId: number,
): Promise<number> {
  const response = await as(h, cookie, "POST", `/products/${productId}/sessions`, {
    purpose: PURPOSE,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { session: { id: number } }).session.id;
}

/** 读会话时跟着回的那一格:当前辅助模型看不看得了图。 */
async function imageInput(h: PanelHarness, cookie: string, sessionId: number): Promise<boolean> {
  const response = await as(h, cookie, "GET", `/agent-sessions/${sessionId}`);
  assert.equal(response.status, 200);
  return ((await response.json()) as { imageInput: boolean }).imageInput;
}

/** 这个会话的图片目录。落点就是库文件所在目录下的 `agent-sessions/<会话 id>`。 */
function imageDir(h: PanelHarness, sessionId: number): string {
  return join(dirname(h.db.path), "agent-sessions", String(sessionId));
}

test("传一张图:文件落 data 目录,库里只有路径与 mimeType,取图走同一道门", async () => {
  const { h, cookie, sessionId } = await startImageHarness();
  const image = await uploaded(h, cookie, sessionId, pngBytes(40, 30));
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual({ width: image.width, height: image.height }, { width: 40, height: 30 });

  // 落点:库文件所在目录下,按会话分目录,文件名是图片 id 加扩展名。
  const path = join(imageDir(h, sessionId), `${image.imageId}.png`);
  assert.ok(existsSync(path), `图片没落在 ${path}`);
  assert.deepEqual(pngSize(readFileSync(path)), { width: 40, height: 30 });

  // 库里只有路径与 mimeType:base64 一个字节都不进库。
  const store = openStore(h.db.path);
  try {
    const row = store.getAgentSessionImage(sessionId, image.imageId);
    assert.deepEqual(
      { path: row?.path, mimeType: row?.mimeType },
      { path, mimeType: "image/png" },
    );
  } finally {
    store.close();
  }

  // 取图:创建者拿得到字节,content type 是库里那一份。
  const fetched = await as(h, cookie, "GET", `/agent-sessions/${sessionId}/images/${image.imageId}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), readFileSync(path));

  // 认不出的图片 id 与会话不存在同形的一句。
  const missing = await as(
    h,
    cookie,
    "GET",
    `/agent-sessions/${sessionId}/images/00000000-0000-4000-8000-000000000000`,
  );
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "没有这张图片" });
});

test("超过 2000px 的图按 Pi 的缩放默认缩到阈值内再落盘", async () => {
  const { h, cookie, sessionId } = await startImageHarness();
  const image = await uploaded(h, cookie, sessionId, pngBytes(2400, 1200));
  // 长边缩到 2000,比例不变。
  assert.deepEqual({ width: image.width, height: image.height }, { width: 2000, height: 1000 });
  const path = join(imageDir(h, sessionId), `${image.imageId}.${image.mimeType === "image/png" ? "png" : "jpg"}`);
  assert.deepEqual(pngSize(readFileSync(path)), { width: 2000, height: 1000 });
});

test("一条消息最多带四张图:第 5 张被拒,认不出的图片 id 也被拒", async () => {
  const { h, cookie, sessionId } = await startImageHarness();
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    ids.push((await uploaded(h, cookie, sessionId, pngBytes(8, 8))).imageId);
  }

  const tooMany = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
    clientMessageId: "c1",
    text: "看这五张原型图",
    images: ids,
  });
  assert.equal(tooMany.status, 400);
  assert.deepEqual(await tooMany.json(), {
    error: "images 是这个会话上传过的图片 id,最多 4 张",
  });

  // 不是这个会话上传过的 id 同样被拒:带了图却没带上比默默少一张更该当场说。
  const unknown = await as(h, cookie, "POST", `/agent-sessions/${sessionId}/messages`, {
    clientMessageId: "c2",
    text: "看这张图",
    images: ["00000000-0000-4000-8000-000000000000"],
  });
  assert.equal(unknown.status, 400);
});

test("目录能力不含 image 时上传被拒、读会话回 imageInput=false,换成支持图片的模型后恢复", async () => {
  const { h, cookie, sessionId } = await startImageHarness(["text"]);

  const refused = await upload(h, cookie, sessionId, pngBytes(8, 8));
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), {
    error: "当前辅助模型不支持图片,换一个支持图片的辅助模型",
  });
  assert.equal(await imageInput(h, cookie, sessionId), false);

  // 审查策略里把辅助模型换成看得了图的那一处(ADR 0029),下一次读会话就跟上。
  seedAvailableModelService(h, VISION.provider, [VISION.model], { input: ["text", "image"] });
  const store = openStore(h.db.path);
  try {
    assert.equal(
      putGlobalSettings(store, { auxiliaryModelJson: JSON.stringify(VISION) }),
      true,
    );
  } finally {
    store.close();
  }
  assert.equal(await imageInput(h, cookie, sessionId), true);
  assert.equal((await upload(h, cookie, sessionId, pngBytes(8, 8))).status, 201);
});

test("上传只收图片类型,且只有创建者传得了自己的会话", async () => {
  const { h, cookie, sessionId } = await startImageHarness();

  const wrongType = await upload(h, cookie, sessionId, Buffer.from("不是图"), "text/plain");
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await wrongType.json(), {
    error: "图片只收 image/png、image/jpeg、image/webp 与 image/gif",
  });

  // 系统管理员读得到这个会话,传不了图。
  const admin = await upload(h, h.cookie, sessionId, pngBytes(8, 8));
  assert.equal(admin.status, 403);
  assert.deepEqual(await admin.json(), { error: "只有会话的创建者能做" });

  // 同事连这一条在不在都问不到,取图也一样。
  const other = await scopedUser(h, "other", PASSWORD, AT, [REPO_ID], ["agent:chat"]);
  const stranger = await upload(h, other, sessionId, pngBytes(8, 8));
  assert.equal(stranger.status, 404);
  const image = await uploaded(h, cookie, sessionId, pngBytes(8, 8));
  const peek = await as(
    h,
    other,
    "GET",
    `/agent-sessions/${sessionId}/images/${image.imageId}`,
  );
  assert.equal(peek.status, 404);
  assert.deepEqual(await peek.json(), { error: "没有这个 Agent 会话" });
});

test("删会话与删产品都连图片文件一起删", async () => {
  const { h, cookie, productId, sessionId } = await startImageHarness();
  const second = await createSession(h, cookie, productId);
  await uploaded(h, cookie, sessionId, pngBytes(8, 8));
  await uploaded(h, cookie, second, pngBytes(8, 8));
  assert.ok(existsSync(imageDir(h, sessionId)));
  assert.ok(existsSync(imageDir(h, second)));

  assert.equal((await as(h, cookie, "DELETE", `/agent-sessions/${sessionId}`)).status, 204);
  assert.equal(existsSync(imageDir(h, sessionId)), false);
  // 库里的行跟着会话走。
  const store = openStore(h.db.path);
  try {
    assert.equal(store.getAgentSessionImage(sessionId, "any"), undefined);
  } finally {
    store.close();
  }

  // 删产品级联:它下面剩下的那个会话的图也没了。
  const removed = await h.api("DELETE", `/products/${productId}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { cascade: { sessions: 1 } });
  assert.equal(existsSync(imageDir(h, second)), false);
});

test("落库把图片块换成文件引用,重建读回 base64,文件丢了换占位文本", () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-session-image-"));
  try {
    const path = join(dir, "one.png");
    const bytes = pngBytes(8, 8);
    writeFileSync(path, bytes);
    const ref: AgentSessionImageRef = {
      type: "image-ref",
      imageId: "one",
      path,
      mimeType: "image/png",
    };
    const entry = {
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这张图" },
          { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
        ],
      },
    };

    // 落库那一步:base64 换成文件引用,别的块原样。
    const stored = deflateImageBlocks(entry, [{ ...ref }]) as typeof entry;
    assert.deepEqual(stored.message.content, [{ type: "text", text: "看这张图" }, ref]);

    // 重建那一步:引用读回 base64,与原来那一块逐字相同。
    assert.deepEqual(inflateImageRefs([stored]), [entry]);

    // 文件被手动删掉:那一块换成占位文本,整段历史照样重建得起来。
    rmSync(path);
    const inflated = inflateImageRefs([stored])[0] as typeof entry;
    assert.deepEqual(inflated.message.content, [
      { type: "text", text: "看这张图" },
      { type: "text", text: MISSING_IMAGE_TEXT },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
