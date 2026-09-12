/** 产品页共用的纯投影(issue #331)。 */

export type ProductRepoRef = { repoId: number };

/**
 * 还没归入任何产品的仓库。归属弹窗的候选就是它:一个仓库至多属一个产品,已经归过的
 * 仓库再选一次只会换回服务端的 409。入参的仓库列表已经按仓库分配收窄过(ADR 0018),
 * 这里不再判可见性;看不到的产品里的仓库因此仍可能被选中,那一档由服务端回 409。
 */
export function unassignedRepos<T extends ProductRepoRef>(
  repos: readonly T[],
  products: readonly { repos: readonly ProductRepoRef[] }[],
): T[] {
  const taken = new Set(
    products.flatMap((product) => product.repos.map((repo) => repo.repoId)),
  );
  return repos.filter((repo) => !taken.has(repo.repoId));
}
