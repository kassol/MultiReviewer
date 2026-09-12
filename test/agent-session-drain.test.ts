/**
 * 排空与重启后的惰性重建(issue #335),走真进程:`spawnMain` 起一个 `main.ts`,让一个 Agent
 * 会话真的跑起来(真子进程 + 本机假模型服务 + 假 Gitea),再给它 SIGTERM。
 *
 * 只有真进程测得出这一档:在跑的会话被中止、中止记进会话记录、排队的消息落库、进程按时退出
 * 以 0 收场,然后**同一个库上再起一个进程**,人下次发消息时从记录重建并把中止前排着的那条一并
 * 投递。harness 那套在进程内起服务,测不到信号与退出;先例是 `drain.test` / `main-boot.test`。
 *
 * 库按 schema 直接播种(用户、角色、注册表、产品、会话、模型服务):要的是一个「已经在用」的
 * 实例,而不是把面板的建表流程再走一遍。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { CREDENTIAL_MASTER_KEY_ENV } from "../src/panel/credential-crypto.ts";
import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import { makeRepo, testCleanups } from "./support/git-fixture.ts";
import { startFakeGitea } from "./support/fake-gitea.ts";
import { LISTENING, spawnMain } from "./support/main-process.ts";
import { startModelStub, type StubTurn } from "./support/model-stub.ts";
import {
  GITEA_REPO,
  HARNESS_SPEC,
  PANEL_CREDENTIAL_MASTER_KEY,
  seedAvailableModelService,
} from "./support/panel-harness.ts";

const AT = "2026-09-12T00:00:00.000Z";
const USERNAME = "member";
const PASSWORD = "agent-session-drain-password";

/** 人发的那三句话,各自独一无二,好在模型请求里认出来。 */
const FIRST = "把「报销单可以撤回」拆成可实现的条目";
const QUEUED = "排空之前排着的那一句";
const AFTER_RESTART = "重启之后再说一句";

const cleanups = testCleanups();

/** 内核挑一个空闲端口再还回去:真进程要一个定死的端口,面板请求才打得进去。 */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** 等一个条件成真,或等到上限就失败。等的都是库里的行与假服务那一侧的事实。 */
async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`等了 30 秒,${what}`);
}

test("SIGTERM:在跑的会话被中止并记明原因,进程按时退出;重启后发消息时重建并投递中止前的队列", async () => {
  const dir = mkdtempSync(join(tmpdir(), "multireviewer-session-drain-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "multireviewer.db");
  const repo = makeRepo({
    base: { "src/answer.ts": "export const answer = 1;\n" },
    head: { "src/answer.ts": "export const answer = 2;\n" },
  });
  cleanups.push(repo.cleanup);
  const gitea = await startFakeGitea({ ...GITEA_REPO, cloneUrl: repo.dir });
  cleanups.push(gitea.close);
  const turns: StubTurn[] = [
    // 这一次挂着不回:SIGTERM 落在它还在跑的时候。
    { text: "还在读代码", usage: { input: 10, output: 2 }, delayMs: 60_000 },
    { text: "中止前排着的那条的回答", usage: { input: 11, output: 2 } },
    { text: "重启之后那条的回答", usage: { input: 12, output: 2 } },
  ];
  const stub = await startModelStub(turns);
  cleanups.push(() => void stub.close());

  // 一个「已经在用」的实例:有这个人、有注册的仓库与它的分配、有产品与会话、有可用的模型服务。
  const store = openStore(dbPath);
  const role = store.createPanelRole({
    name: "拆需求的人",
    permissions: ["agent:chat"],
    createdAt: AT,
  });
  store.createPanelUser({
    username: USERNAME,
    displayName: null,
    passwordHash: await hashPassword(PASSWORD),
    mustChangePassword: false,
    createdAt: AT,
    isSystemAdmin: false,
    roleId: role.id,
  });
  assert.equal(
    store.registerRepo({
      repoId: GITEA_REPO.id,
      owner: GITEA_REPO.owner,
      repo: GITEA_REPO.repo,
      generation: 1,
      key: "drain-test-key",
    }),
    true,
  );
  // 分配要在注册之后:外键指着注册表那一行。
  store.setPanelUserAssignment(USERNAME, [GITEA_REPO.id]);
  const product = store.createProduct({ name: "报销系统", createdAt: AT });
  store.attachProductRepo(product.id, GITEA_REPO.id, AT);
  const session = store.createAgentSession({
    productId: product.id,
    createdBy: USERNAME,
    purpose: "requirement-breakdown",
    createdAt: AT,
  });
  store.close();
  seedAvailableModelService(
    { db: { path: dbPath } },
    HARNESS_SPEC.provider,
    [HARNESS_SPEC.model],
    {},
    stub.baseUrl,
  );
  // 全局模型组合代表升级前已存在的状态,与 harness 同一做法:运行期写要走设置页的门禁。
  const seed = new DatabaseSync(dbPath);
  seed
    .prepare("INSERT INTO global_setting (key, value) VALUES (?, ?)")
    .run("reviewers", JSON.stringify([HARNESS_SPEC]));
  seed.close();

  const port = await freePort();
  const env = {
    ...process.env,
    MULTIREVIEWER_DB: dbPath,
    MULTIREVIEWER_CACHE_DIR: join(dir, "worktrees"),
    MULTIREVIEWER_BASE_URL: `http://localhost:${port}`,
    MULTIREVIEWER_PORT: String(port),
    MULTIREVIEWER_GITEA_URL: gitea.url,
    MULTIREVIEWER_GITEA_TOKEN: "bot-pat",
    [CREDENTIAL_MASTER_KEY_ENV]: PANEL_CREDENTIAL_MASTER_KEY,
    GITHUB_TOKEN: "",
  };
  const serverUrl = `http://127.0.0.1:${port}`;

  /** 登录一次,拿这个人的会话 cookie。进程换了一个之后照样要重新拿一次。 */
  const login = async (): Promise<string> => {
    const response = await fetch(`${serverUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    assert.equal(response.status, 204, await response.text());
    return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
  };
  const send = async (cookie: string, clientMessageId: string, text: string): Promise<void> => {
    const response = await fetch(`${serverUrl}/api/agent-sessions/${session.id}/messages`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ clientMessageId, text }),
    });
    assert.equal(response.status, 202, await response.text());
  };
  /** 这个会话此刻落库的记录。进程在不在都读得到:SQLite 是唯一真相(ADR 0031)。 */
  const records = (): { type: string; entry: unknown }[] => {
    const read = openStore(dbPath);
    try {
      return read.listAgentSessionEntries(session.id).map((record) => ({
        type: record.type,
        entry: record.entry,
      }));
    } finally {
      read.close();
    }
  };

  // ── 第一个进程:一条消息跑起来,另一条排着,然后 SIGTERM ──
  const first = spawnMain(dir, env);
  cleanups.push(() => {
    first.child.kill("SIGKILL");
  });
  await first.listening;
  const cookie = await login();
  await send(cookie, "c1", FIRST);
  await send(cookie, "c2", QUEUED);
  // 模型请求已经发出去:当前这一步确实在跑。
  await until("假模型服务还没收到第一次请求", () => stub.requests.length >= 1);

  first.child.kill("SIGTERM");
  const code = await new Promise<number | null>((resolve) => {
    first.child.on("exit", resolve);
    // 排空卡住时不该让整个测试文件挂在这里等。
    setTimeout(() => first.child.kill("SIGKILL"), 30_000).unref();
  });
  assert.equal(code, 0, first.output());
  assert.match(first.output(), /排空结束/);

  // 中止记进了会话记录:人第二天回来看得见这一轮为什么断了。
  const system = records().filter(
    (record) => record.type === "custom" && JSON.stringify(record.entry).includes("排空"),
  );
  assert.equal(system.length, 1, JSON.stringify(records()));
  // 排着的那一条落了库:它还没投出去,重建时才投。
  const pending = openStore(dbPath);
  assert.deepEqual(pending.takeAgentSessionPendingMessages(session.id), [
    { mode: "followUp", text: QUEUED },
  ]);
  // 读完就删,再放回去:下面那个进程要的正是它。
  pending.putAgentSessionPendingMessages(session.id, [{ mode: "followUp", text: QUEUED }]);
  pending.close();

  // ── 第二个进程:同一个库。人下次发消息才重建,中止前排着的那条一并投递 ──
  const second = spawnMain(dir, env);
  cleanups.push(() => {
    second.child.kill("SIGKILL");
  });
  await second.listening;
  assert.ok(second.output().includes(LISTENING), second.output());
  const again = await login();
  await send(again, "c3", AFTER_RESTART);

  await until("假模型服务还没收到重建之后的两次请求", () => stub.requests.length >= 3);
  const rebuilt = stub.requests[1]!.messages.map((message) => message.content).join("\n");
  // 重建把整段记录喂回去了:SIGTERM 之前人说的那句还在上下文里。
  assert.match(rebuilt, new RegExp(FIRST));
  // 中止前排着的那一条先投,新的这一条排在它后面(与停止那一档同一个顺序)。
  assert.match(rebuilt, new RegExp(QUEUED));
  assert.ok(!rebuilt.includes(AFTER_RESTART), "重启之后那条抢在排着的前面投出去了");
  const last = stub.requests[2]!.messages.map((message) => message.content).join("\n");
  assert.match(last, new RegExp(AFTER_RESTART));
  // 排队消息投出去就不留:重建那一刻取出即删。
  const drained = openStore(dbPath);
  assert.deepEqual(drained.takeAgentSessionPendingMessages(session.id), []);
  drained.close();

  second.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    second.child.on("exit", () => resolve());
    setTimeout(() => {
      second.child.kill("SIGKILL");
      resolve();
    }, 30_000).unref();
  });
});
