/**
 * 范围审查的发起(issue #155)。
 *
 * 打在面板 API 的真实 HTTP 缝上:内存 Forge 记下建了哪两条分支、开了哪个容器 PR,
 * git fixture 提供真实的祖先关系,脚本 Reviewer 让第一轮真的跑完并发出行级评论。
 * 断言只看外部可观察的行为:HTTP 响应、Forge 收到什么调用、库里落了什么行。
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { Forge, RepoRef } from "../src/forge/forge.ts";
import { hashPassword } from "../src/panel/password.ts";
import { openStore } from "../src/review/store.ts";
import {
  GITEA_REPO,
  HARNESS_PR,
  HARNESS_PR_TITLE,
  PANEL_ADMIN_USERNAME,
  startReadyPanelHarness,
  type PanelHarness,
} from "./support/panel-harness.ts";
import { confirmEmptyRuleSet } from "./support/git-fixture.ts";
import { scriptedReviewer } from "./support/memory-forge.ts";

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

const PASSWORD = "range-review-test-password";
const HASH = await hashPassword(PASSWORD);

type RangeReview = {
  id: number;
  owner: string;
  repo: string;
  title: string | null;
  baseSha: string;
  comparisonSha: string;
  state: string;
  containerPullNumber: number | null;
  baseBranch: string;
  headBranch: string;
  createdBy: string;
  createdAt: string;
  completedBy: string | null;
  completedAt: string | null;
  lastForgeFailure: string | null;
  /** 选定比较项时用的分支或 Tag(issue #234);不给时是 null。 */
  comparisonSource: { kind: "branch" | "tag"; name: string } | null;
};

/** 每个用例都要一个已注册的仓库,发起才有对象。 */
async function registeredHarness(
  options: Parameters<typeof startReadyPanelHarness>[1] = {},
): Promise<PanelHarness> {
  const harness = await startReadyPanelHarness(cleanups, options);
  assert.equal(
    (await harness.api("POST", "/repos", { owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }))
      .status,
    201,
  );
  // 门禁分代(issue #206):这几条用例要的是审查行为,仓库放到「知识集已确认」那一侧。
  confirmEmptyRuleSet(harness.db.path, GITEA_REPO.id);
  // 注册后工作副本在后台备(issue #184)。等它跑完再开测:范围审查读的是这份已经在的
  // 副本,而这一步自己也要读一次仓库,混进来会让「读了几次仓库」数不清。
  await harness.worktreesPreparedAtLeast(1);
  return harness;
}

/** 报一条 Finding 的 Reviewer:容器 PR 上要真的出现行级评论。 */
const reportingReviewers: NonNullable<
  Parameters<typeof startReadyPanelHarness>[1]
>["buildReviewers"] = (plans) =>
  plans.map((plan) =>
    scriptedReviewer(plan.spec.model, [
      {
        file: "src/answer.ts",
        line: 1,
        severity: "P1",
        category: "bug",
        description: "这里会越界",
      },
    ]),
  );

test("发起范围审查:建两条分支与容器 PR,第一轮 Review Run 归属它并发出行级评论", async () => {
  const h = await registeredHarness({ buildReviewers: reportingReviewers });

  const response = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(response.status, 202);
  const { rangeReview } = (await response.json()) as { rangeReview: RangeReview };
  assert.equal(rangeReview.state, "in-progress");
  assert.equal(rangeReview.title, "范围审查标题");
  assert.equal(rangeReview.baseSha, h.repo.baseSha);
  assert.equal(rangeReview.comparisonSha, h.repo.headSha);
  assert.equal(rangeReview.createdBy, PANEL_ADMIN_USERNAME);
  assert.equal(rangeReview.baseBranch, `multireviewer/${rangeReview.id}-base`);
  assert.equal(rangeReview.headBranch, `multireviewer/${rangeReview.id}-head`);
  assert.equal(rangeReview.containerPullNumber, h.memory.createdPullRequests[0]!.number);

  // 两条分支分别指向阶段基准与比较项。
  assert.deepEqual(h.memory.createdBranches, [
    { branch: rangeReview.baseBranch, fromSha: h.repo.baseSha },
    { branch: rangeReview.headBranch, fromSha: h.repo.headSha },
  ]);
  const container = h.memory.createdPullRequests[0]!;
  assert.equal(container.head, rangeReview.headBranch);
  assert.equal(container.base, rangeReview.baseBranch);
  assert.equal(
    container.title,
    `[MultiReviewer] 范围审查 ${h.repo.baseSha.slice(0, 7)}..${h.repo.headSha.slice(0, 7)}`,
  );
  // 正文里的面板地址指这个阶段的详情页:范围审查没有自己的页面(issue #180)。
  assert.match(container.body, new RegExp(`/stages/range:${rangeReview.id}`));

  await h.settledAtLeast(1);
  assert.equal(h.settled[0]!.error, undefined);
  // 容器 PR 上有行级评论。
  assert.equal(h.memory.createdReviews.length, 1);
  assert.equal(h.memory.createdReviews[0]!.comments.length, 1);
  assert.equal(h.memory.createdReviews[0]!.comments[0]!.path, "src/answer.ts");

  const store = openStore(h.db.path);
  const runs = store.listRuns({ limit: 30 });
  store.close();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.rangeReviewId, rangeReview.id);
  assert.equal(runs[0]!.pullNumber, container.number);
});

test("标题必填:不给与只给空白都被拒,一条分支都不建", async () => {
  const h = await registeredHarness();
  const range = {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  };

  assert.equal((await h.api("POST", "/range-reviews", range)).status, 400);
  // 空白不算标题:一个只有空格的名字在列表里与没有名字看起来一样。
  assert.equal(
    (await h.api("POST", "/range-reviews", { ...range, title: "   " })).status,
    400,
  );

  assert.deepEqual(h.memory.createdBranches, []);
  assert.deepEqual(h.memory.createdPullRequests, []);
  const store = openStore(h.db.path);
  assert.deepEqual(store.listRangeReviews({}), []);
  store.close();
});

test("base 预填:取同仓库最近一个审查完成的范围审查的最终比较项,没有则为空", async () => {
  const h = await registeredHarness();
  const prefill = async (): Promise<string | null> => {
    const response = await h.api(
      "GET",
      `/range-reviews/prefill?owner=${HARNESS_PR.owner}&repo=${HARNESS_PR.repo}`,
    );
    assert.equal(response.status, 200);
    return ((await response.json()) as { base: string | null }).base;
  };

  // 一个都没完成时不预填。
  assert.equal(await prefill(), null);

  const created = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(created.status, 202);
  const { rangeReview } = (await created.json()) as { rangeReview: RangeReview };
  await h.settledAtLeast(1);

  // 进行中的那个不算:预填要的是「上一段审到哪里」。
  assert.equal(await prefill(), null);

  const next = h.repo.pushToHead({ "src/answer.ts": "export const answer = 3;\n" });
  assert.equal(
    (await h.api("POST", `/range-reviews/${rangeReview.id}/advance`, { comparison: next }))
      .status,
    202,
  );
  await h.settledAtLeast(2);
  assert.equal((await h.api("POST", `/range-reviews/${rangeReview.id}/complete`)).status, 200);

  // 预填的是最终比较项,不是发起时那个。
  assert.equal(await prefill(), next);
});

test("比较项不是 base 的后代:拒绝,一条分支都不建", async () => {
  const h = await registeredHarness();

  const response = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.headSha,
    comparison: h.repo.baseSha,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(h.memory.createdBranches, []);
  assert.deepEqual(h.memory.createdPullRequests, []);

  const store = openStore(h.db.path);
  assert.deepEqual(store.listRangeReviews({}), []);
  store.close();
});

test("同一 base 已有进行中的:先提醒,带确认标志重发即成功,两条记录并存", async () => {
  const h = await registeredHarness();
  const request = (confirm?: true): Promise<Response> =>
    h.api("POST", "/range-reviews", {
      title: "范围审查标题",
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      base: h.repo.baseSha,
      comparison: h.repo.headSha,
      ...(confirm === undefined ? {} : { confirm }),
    });

  assert.equal((await request()).status, 202);
  await h.settledAtLeast(1);

  const reminded = await request();
  assert.equal(reminded.status, 409);
  const body = (await reminded.json()) as { needsConfirmation?: boolean; existing?: RangeReview[] };
  assert.equal(body.needsConfirmation, true);
  assert.equal(body.existing?.length, 1);

  assert.equal((await request(true)).status, 202);
  await h.settledAtLeast(2);

  const list = (await (await h.api("GET", "/stages?source=range-review")).json()) as {
    stages: { stageId: string }[];
  };
  assert.equal(list.stages.length, 2);
  const bases: string[] = [];
  for (const stage of list.stages) {
    const detail = (await (
      await h.api("GET", `/stages/${encodeURIComponent(stage.stageId)}`)
    ).json()) as { rangeReview: RangeReview };
    bases.push(detail.rangeReview.baseSha);
  }
  assert.deepEqual(bases, [h.repo.baseSha, h.repo.baseSha]);
});

test("建容器 PR 失败:记下失败原因,已建的两条分支被清理", async () => {
  const h = await registeredHarness({
    wrapForge: (forge: Forge) => ({
      ...forge,
      createPullRequest: async () => {
        throw new Error("branch protection 拦住了");
      },
    }),
  });

  const response = await h.api("POST", "/range-reviews", {
    title: "范围审查标题",
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  });
  assert.equal(response.status, 502);
  const { rangeReviewId } = (await response.json()) as { rangeReviewId: number };

  const store = openStore(h.db.path);
  const record = store.getRangeReview(rangeReviewId)!;
  store.close();
  assert.equal(record.state, "failed");
  assert.equal(record.containerPullNumber, null);
  assert.match(record.lastForgeFailure!, /branch protection/);

  // 半建的分支不留在仓库里。
  assert.deepEqual(h.memory.deletedBranches, [record.baseBranch, record.headBranch]);
});

test("阶段详情返回 base、当前比较项与本范围审查的轮次", async () => {
  const h = await registeredHarness();
  const created = (await (
    await h.api("POST", "/range-reviews", {
      title: "范围审查标题",
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      base: h.repo.baseSha,
      comparison: h.repo.headSha,
    })
  ).json()) as { rangeReview: RangeReview };
  await h.settledAtLeast(1);

  const detail = await h.api("GET", `/stages/range:${created.rangeReview.id}`);
  assert.equal(detail.status, 200);
  const body = (await detail.json()) as {
    stage: { rangeReviewId: number | null };
    rangeReview: RangeReview;
    groups: { sha: string; runs: { runId: number; headSha: string }[] }[];
  };
  assert.equal(body.stage.rangeReviewId, created.rangeReview.id);
  assert.equal(body.rangeReview.baseSha, h.repo.baseSha);
  assert.equal(body.rangeReview.comparisonSha, h.repo.headSha);
  assert.equal(body.groups.length, 1);
  assert.equal(body.groups[0]!.sha, h.repo.headSha);
  assert.equal(body.groups[0]!.runs.length, 1);
  assert.equal(body.groups[0]!.runs[0]!.headSha, h.repo.headSha);

  assert.equal((await h.api("GET", "/stages/range:9999")).status, 404);
});

test("删掉的两个只读接口与未知端点同一档 404", async () => {
  const h = await startReadyPanelHarness(cleanups);

  for (const path of ["/range-reviews", "/range-reviews/1"]) {
    const response = await h.api("GET", path);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: "没有这个端点" });
  }
});

test("时间流区分 PR 触发与范围审查", async () => {
  const h = await registeredHarness();
  assert.equal(
    (
      await h.api("POST", "/rerun", {
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        pullNumber: HARNESS_PR.number,
      })
    ).status,
    202,
  );
  await h.settledAtLeast(1);
  assert.equal(
    (
      await h.api("POST", "/range-reviews", {
        title: "范围审查标题",
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        base: h.repo.baseSha,
        comparison: h.repo.headSha,
      })
    ).status,
    202,
  );
  await h.settledAtLeast(2);

  const body = (await (await h.api("GET", "/runs")).json()) as {
    runs: { pullNumber: number; rangeReviewId: number | null; title: string | null }[];
  };
  assert.equal(body.runs.length, 2);
  // 倒序:范围审查那一轮在前,PR 重跑那一轮的归属为空。
  assert.notEqual(body.runs[0]!.rangeReviewId, null);
  assert.equal(body.runs[1]!.rangeReviewId, null);
  assert.equal(body.runs[1]!.pullNumber, HARNESS_PR.number);
  // 标题同样分得开:重跑记下被审 pull request 的标题,范围审查那一轮不记——
  // 它的容器 PR 标题是本工具自己拼的,阶段的名字来自范围审查自身。
  assert.equal(body.runs[0]!.title, null);
  assert.equal(body.runs[1]!.title, HARNESS_PR_TITLE);
});

test("没有 review:create 的用户发起被拒,新权限格不落到已有角色", async () => {
  const h = await registeredHarness();
  const store = openStore(h.db.path);
  // 升级前就存在的角色:它拿到的是当时的全部评审权限,不含新增的 review:create。
  const legacy = store.createPanelRole({
    name: "老的评审角色",
    permissions: ["review:rerun"],
    createdAt: "2026-08-20T00:00:00.000Z",
  });
  store.createPanelUser({
    username: "range-reader",
    displayName: null,
    passwordHash: HASH,
    mustChangePassword: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    isSystemAdmin: false,
    roleId: legacy.id,
  });
  store.close();

  const login = await fetch(`${h.serverUrl}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "range-reader", password: PASSWORD }),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.getSetCookie()[0]!.split(";", 1)[0]!;

  const session = (await (
    await fetch(`${h.serverUrl}/api/session`, { headers: { cookie } })
  ).json()) as { permissions: string[] };
  assert.deepEqual(session.permissions, ["review:rerun"]);

  const denied = await fetch(`${h.serverUrl}/api/range-reviews`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      owner: HARNESS_PR.owner,
      repo: HARNESS_PR.repo,
      base: h.repo.baseSha,
      comparison: h.repo.headSha,
    }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(h.memory.createdBranches, []);

  // 只读那一格仍然读得到评审记录。
  assert.equal(
    (await fetch(`${h.serverUrl}/api/stages`, { headers: { cookie } })).status,
    200,
  );
});

test("未注册仓库、非 sha 的入参都在碰 Forge 之前被拒", async () => {
  const h = await registeredHarness();

  assert.equal(
    (
      await h.api("POST", "/range-reviews", {
        title: "范围审查标题",
        owner: "ghost",
        repo: "gone",
        base: h.repo.baseSha,
        comparison: h.repo.headSha,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await h.api("POST", "/range-reviews", {
        title: "范围审查标题",
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        base: "main",
        comparison: h.repo.headSha,
      })
    ).status,
    400,
  );
  assert.deepEqual(h.memory.createdBranches, []);
});

test("范围审查只认得到自己仓库的 clone 地址,不依赖任何既有 pull request", async () => {
  const seen: RepoRef[] = [];
  const h = await registeredHarness({
    wrapForge: (forge: Forge) => ({
      ...forge,
      getRepository: async (ref: RepoRef) => {
        seen.push(ref);
        return forge.getRepository(ref);
      },
    }),
  });
  // 注册后备工作副本也读一次仓库(issue #184),那一次已经跑完;从这里开始数发起自己的。
  seen.length = 0;

  assert.equal(
    (
      await h.api("POST", "/range-reviews", {
        title: "范围审查标题",
        owner: HARNESS_PR.owner,
        repo: HARNESS_PR.repo,
        base: h.repo.baseSha,
        comparison: h.repo.headSha,
      })
    ).status,
    202,
  );
  assert.deepEqual(seen, [{ owner: HARNESS_PR.owner, repo: HARNESS_PR.repo }]);
});

test("发起带来源:落库并回给面板,不带时是 null(issue #234)", async () => {
  const h = await registeredHarness();
  const range = {
    owner: HARNESS_PR.owner,
    repo: HARNESS_PR.repo,
    base: h.repo.baseSha,
    comparison: h.repo.headSha,
  };

  const withSource = await h.api("POST", "/range-reviews", {
    ...range,
    title: "带来源的范围审查",
    comparisonSource: { kind: "tag", name: "v1.0.0" },
  });
  assert.equal(withSource.status, 202);
  const sourced = ((await withSource.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.deepEqual(sourced.comparisonSource, { kind: "tag", name: "v1.0.0" });

  // 同一个 base 上再发起要二次确认,来源不给时这一格是 null。
  const withoutSource = await h.api("POST", "/range-reviews", {
    ...range,
    title: "不带来源的范围审查",
    confirm: true,
  });
  assert.equal(withoutSource.status, 202);
  const plain = ((await withoutSource.json()) as { rangeReview: RangeReview }).rangeReview;
  assert.equal(plain.comparisonSource, null);

  const store = openStore(h.db.path);
  assert.deepEqual(store.getRangeReview(sourced.id)!.comparisonSource, {
    kind: "tag",
    name: "v1.0.0",
  });
  assert.equal(store.getRangeReview(plain.id)!.comparisonSource, null);
  store.close();
});
