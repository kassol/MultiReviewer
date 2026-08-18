/**
 * 三条入口原型的入口 —— 原型分支专用,不进主干(issue #83)。
 *
 * 三个变体挂在真实的 `/settings` 路由上,`?variant=A|B|C` 切换,底部有切换条。
 * 目录是真的(`GET <前缀>/api/catalog`),已选模型只在内存里,不发写请求。
 */
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { PrototypeSwitcher, type VariantEntry } from "@/components/prototype-switcher";
import type { CatalogProvider } from "@/components/model-picker";

import { VariantA } from "./variant-a.tsx";
import { VariantB } from "./variant-b.tsx";
import { VariantC } from "./variant-c.tsx";
import type { Picked } from "./shared.tsx";

export const VARIANTS: VariantEntry[] = [
  { key: "A", name: "一个选择器吃下三条" },
  { key: "B", name: "三张并列的卡片" },
  { key: "C", name: "先选厂商再选模型" },
];

/** URL 里的 `?variant=`。不带即走真页面。 */
export function usePrototypeVariant(): string | null {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value !== null && VARIANTS.some((entry) => entry.key === value) ? value : null;
}

/**
 * 本机没配凭据时目录里一家 `configured` 都没有,「手填」与「置灰」两档都看不出效果。
 * 原型因此把前四家当作已配 —— 只影响原型分支的观感,不碰真实的凭据状态。
 */
function withFakeCredentials(providers: CatalogProvider[]): CatalogProvider[] {
  if (providers.some((provider) => provider.configured)) return providers;
  return providers.map((provider, index) =>
    index < 4 ? { ...provider, configured: true } : provider,
  );
}

export function PrototypeSettings({
  variant,
  providers: raw,
}: {
  variant: string;
  providers: CatalogProvider[];
}) {
  const [value, setValue] = useState<Picked[]>([]);
  const providers = withFakeCredentials(raw);

  return (
    <>
      <PageHeader
        title="全局设置"
        description="原型:三条入口怎么同时出现。已选的东西只在内存里,不会保存。"
      />
      <div className="flex max-w-[1060px] flex-col gap-4 p-5 pb-24">
        {variant === "A" ? (
          <VariantA providers={providers} value={value} onChange={setValue} />
        ) : null}
        {variant === "B" ? (
          <VariantB providers={providers} value={value} onChange={setValue} />
        ) : null}
        {variant === "C" ? (
          <VariantC providers={providers} value={value} onChange={setValue} />
        ) : null}

        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>
      <PrototypeSwitcher variants={VARIANTS} current={variant} />
    </>
  );
}
