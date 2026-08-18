/**
 * 模型目录:`GET <前缀>/api/catalog` 那一份查询、目录里的几个类型、模型标识的写法,以及单价
 * 留空那一档的说法。凭据页的 provider 下拉与两栏面板(`components/model-composer.tsx`)共用
 * 这一份——各拉一份查询会让「已配凭据」在两处不同步,各写一句措辞会让两边漂开。
 *
 * 这个文件原来叫 `components/model-picker.tsx`:那个 Popover 形态的模型多选器随仓库覆盖换用
 * 两栏面板(issue #91)一起删掉了,两处编辑模型组合的界面从此是同一个组件。剩下的这些既不
 * 是组件也不带 JSX,因此落在 `src/` 里、与 `api.ts` 同级。
 */
import { useQuery } from "@tanstack/react-query";

import { fetchJson } from "./api.ts";

/** 单价,原样透出 Pi 的 `ModelCost`:每百万 token 的美元数。 */
export type CatalogCost = { input: number; output: number };

export type CatalogModel = {
  id: string;
  name: string;
  contextWindow: number;
  cost: CatalogCost;
  /**
   * 真即这个模型的单价在库里是留空的,它的 Review Run 费用会记成零。判据在服务端(库里
   * 那一行的两个单价字段都是 null),前端不拿 `cost` 自己推——单价真是 0 的模型有一百多个。
   */
  costUnset: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  configured: boolean;
  /** 保存凭据时这家会不会真发一次验证请求。服务端给,前端不自己列名单。 */
  verifiable: boolean;
  /** 真即这一家是操作员自己加进来的自定义 provider,不是 Pi 内置的那些家。 */
  custom: boolean;
  /**
   * 真即这个名字上有一条自定义 provider 登记,而 Pi 的内置目录里也有同名的一家(登记当时
   * 不撞,Pi 升级之后才撞,issue #94)。这一档服务端把登记的那一家整个停用了,所以这条
   * 记录的 `name` 与 `models` 都是内置那一家的,`custom` 仍为真——库里那条登记还在,删得掉。
   * 面板的判据因此是 `custom && conflict`。
   */
  conflict: boolean;
  models: CatalogModel[];
};

/** 目录与凭据状态一次拿齐。凭据页与两栏面板共用这一份查询。 */
export function useModelCatalog() {
  return useQuery({
    queryKey: ["catalog"],
    queryFn: () => fetchJson<{ providers: CatalogProvider[] }>("/catalog"),
  });
}

/** 模型标识:`provider:model`,与后端 `modelIdentity` 同一形状。 */
export function modelIdentity(spec: { provider: string; model: string }): string {
  return `${spec.provider}:${spec.model}`;
}

/** 标识拆回 ReviewerSpec。provider 由所选模型直接推出,不做两级选择器。 */
export function parseModelIdentity(identity: string): { provider: string; model: string } {
  const at = identity.indexOf(":");
  return { provider: identity.slice(0, at), model: identity.slice(at + 1) };
}

/**
 * 单价留空那一档的说法(issue #89)。成本取的就是这张单价表,留空走的是 Pi 的默认值 0,
 * 于是这个模型的花费在评审记录里永远是 0——不说的话「没记账」会被读成「很便宜」。
 * 模型行与已选列表几处共用同一句,免得各写各的然后漂开。
 */
export const COST_ZERO_NOTE = "单价没填,费用记成零";
