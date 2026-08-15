/**
 * Gitea 专属的仓库 hook 管理:列 / 建 / 删 hook 与 bot 权限查询。
 *
 * 不进 `Forge` 接口——ADR 0002 的能力交集不含 hook 管理,且管理面板只服务 Gitea。
 * 端点与字段名的依据取自 go-gitea/gitea `release/v1.26`,逐处标注在下方;幂等、404
 * 语义、secret 不可改这些契约细节见 `docs/research/gitea-webhook-api.md`。
 */
import type { RepoRef } from "./forge.ts";
import { request, requestJson, type GiteaForgeOptions } from "./gitea.ts";

const PAGE_SIZE = 100;

/**
 * 建 hook 的订阅集,窄订阅:`pull_request_only` 是「只订裸 `pull_request`、不展开
 * 事件族」的哨兵(`routers/api/v1/utils/hook.go:188`——直接写 `pull_request` 会展开成
 * 8 个 PR 事件,PR 下每条评论、每次打标签都投一次);`pull_request_sync` 单列,Gitea
 * 把「同步」拆成独立事件,漏了它 PR 新增 commit 一条投递都不发。PR closed 走裸
 * `pull_request` 事件本身,处置率回填(ADR 0006)靠它。
 */
export const SUBSCRIBED_EVENTS = ["pull_request_only", "pull_request_sync"] as const;

/**
 * 窄订阅在 Gitea 侧的回显:哨兵落回裸 `pull_request` 加 `pull_request_sync`
 * (`docs/research/gitea-webhook-api.md` 第 3 节,含实例实测)。核对订阅比这个集合,
 * 且只能按集合比——回显顺序来自 Go map 迭代,无序。
 */
const READBACK_EVENTS: ReadonlySet<string> = new Set(["pull_request", "pull_request_sync"]);

export type GiteaHook = {
  id: number;
  /** 投递目标,即 `config.url`,含 `?k=` 代次(ADR 0007)。 */
  url: string;
  /** `config.content_type`。被人改成 `form` 时投递不再是 JSON,验签端解析不了。 */
  contentType: string;
  events: string[];
  active: boolean;
};

export type HookSpec = {
  /** 投递目标地址,含 `?k=` 代次。 */
  url: string;
  /** 该仓库的 Key,写进 hook 的 `config.secret` 参与 HMAC 验签。Gitea 从不回显它。 */
  key: string;
};

export type AdminCheck = { admin: true } | { admin: false; reason: string };

export type GiteaHookManager = {
  listHooks(ref: RepoRef): Promise<GiteaHook[]>;
  /**
   * 幂等地把 hook 收敛到目标状态。同 URL 的 hook 已存在时 Gitea 的 POST 不报错、
   * 会堆出第二条(`CreateWebhook` 是无条件 insert,URL 无唯一索引),幂等只能自己做:
   * 先列后建,按 `config.url` 匹配;订阅或激活不对时 PATCH 收敛,不建第二条。
   */
  ensureHook(ref: RepoRef, spec: HookSpec): Promise<void>;
  /** 删 hook。404 视为成功——删除不幂等,重复删回 404,而它的语义就是目标已达成。 */
  deleteHook(ref: RepoRef, hookId: number): Promise<void>;
  /** bot 对仓库的权限是否 admin。hook 端点全挂在 `reqAdmin()` 后面,write 不够。 */
  checkAdmin(ref: RepoRef): Promise<AdminCheck>;
};

/**
 * 读回的 hook。`modules/structs/hook.go:19-44`:`ID int64 json:"id"`、
 * `Config map[string]string json:"config"`、`Events []string json:"events"`、
 * `Active bool json:"active"`;顶层 `URL` 的 json 标签是 `"-"`,投递地址只在
 * `config.url` 里,secret 从不回显(`services/webhook/general.go:394-425` 的 `ToHook`)。
 */
type RawHook = {
  id: number;
  config?: { url?: string; content_type?: string };
  events?: string[];
  active: boolean;
};

function eventsMatch(events: readonly string[]): boolean {
  const actual = new Set(events);
  if (actual.size !== READBACK_EVENTS.size) return false;
  for (const event of READBACK_EVENTS) {
    if (!actual.has(event)) return false;
  }
  return true;
}

export function createGiteaHookManager(options: GiteaForgeOptions): GiteaHookManager {
  const hooksPath = (ref: RepoRef): string => `/repos/${ref.owner}/${ref.repo}/hooks`;

  async function listHooks(ref: RepoRef): Promise<GiteaHook[]> {
    const hooks: GiteaHook[] = [];
    // `GET /repos/{owner}/{repo}/hooks`,分页参数 `page` / `limit`
    // (`routers/api/v1/repo/hook.go:43-50`)。终止条件是「读到空页」而不是「不满一页」:
    // 实例的 `API.MAX_RESPONSE_ITEMS`(默认 50)会把 limit 钳下去,「不满 limit」不代表
    // 到底了——在这里漏读意味着 ensureHook 匹配不到既有 hook,POST 出重复的一条。
    for (let page = 1; ; page += 1) {
      const batch = await requestJson<RawHook[]>(
        options,
        "GET",
        `${hooksPath(ref)}?page=${page}&limit=${PAGE_SIZE}`,
      );
      if (batch.length === 0) break;
      for (const hook of batch) {
        hooks.push({
          id: hook.id,
          url: hook.config?.url ?? "",
          contentType: hook.config?.content_type ?? "",
          events: hook.events ?? [],
          active: hook.active,
        });
      }
    }
    return hooks;
  }

  return {
    listHooks,

    async ensureHook(ref, spec) {
      // 先列后建仍有并发窗口:两次同时 ensure 会各自 POST。单管理员面板不为它加锁。
      const existing = (await listHooks(ref)).find((hook) => hook.url === spec.url);

      if (existing === undefined) {
        // `CreateHookOption`(`modules/structs/hook.go:54-73`):`type` 与 `config`
        // 必填,config 的值全是字符串;`content_type` 只收 "json" / "form";`active`
        // 默认 false,必须显式置真,否则建出来的 hook 一条投递都不发。成功回 201。
        await request(options, "POST", hooksPath(ref), {
          type: "gitea",
          config: { url: spec.url, content_type: "json", secret: spec.key },
          events: [...SUBSCRIBED_EVENTS],
          active: true,
        });
        return;
      }

      if (existing.active && existing.contentType === "json" && eventsMatch(existing.events)) {
        return;
      }

      // 订阅、激活或 content_type 被人改过:PATCH 收敛。`events` 是全量覆盖——省略即被
      // 重置为 `["push"]`(`routers/api/v1/utils/hook.go:164-166, 375`);`active` 是指针
      // 字段,要显式带上;`config` 按 key 部分更新,只回 `content_type`,`url` 保留。
      // secret 在这里改不了(PATCH 静默忽略它,ADR 0007),换 Key 走删旧建新的轮转,
      // 不在本模块。
      await request(options, "PATCH", `${hooksPath(ref)}/${existing.id}`, {
        config: { content_type: "json" },
        events: [...SUBSCRIBED_EVENTS],
        active: true,
      });
    },

    async deleteHook(ref, hookId) {
      // `DELETE .../hooks/{id}` 成功回 204;重复删回 404(`models/webhook/webhook.go:336-341`),
      // 当成功收下。
      await request(options, "DELETE", `${hooksPath(ref)}/${hookId}`, undefined, [404]);
    },

    async checkAdmin(ref) {
      // `GET /repos/{owner}/{repo}` 返回当前认证用户在该仓库上的权限:
      // `modules/structs/repo.go:88` `Permissions *Permission json:"permissions,omitempty"`,
      // `:12-13` `Admin bool json:"admin"`,取值是 `AccessMode >= AccessModeAdmin`
      // (`services/convert/repository.go:41-42`)。hook 路由挂在 `reqAdmin()` 后
      // (`routers/api/v1/api.go:1257`),write 权限不够。
      const response = await request(
        options,
        "GET",
        `/repos/${ref.owner}/${ref.repo}`,
        undefined,
        [404],
      );
      if (response.status === 404) {
        return {
          admin: false,
          reason:
            `bot 看不到 ${ref.owner}/${ref.repo}:仓库不存在,或 bot 还不是它的协作者。` +
            "先把 bot 以管理员权限加入这个仓库。",
        };
      }
      const repo = (await response.json()) as { permissions?: { admin?: boolean } };
      if (repo.permissions?.admin === true) return { admin: true };
      return {
        admin: false,
        reason:
          `bot 对 ${ref.owner}/${ref.repo} 没有 admin 权限——hook 管理的端点要求仓库 admin,` +
          "write 不够。把 bot 的协作者权限升到管理员。",
      };
    },
  };
}
