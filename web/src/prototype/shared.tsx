/**
 * 三条入口原型的共用件 —— 原型分支专用,不进主干。
 *
 * 三个变体共用的只有:已选模型的 chips、来源标记、以及「加一家自定义 provider」和
 * 「手填一个标识」两个表单的字段集合。布局一律各写各的,不共用 Layout。
 */
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CatalogProvider } from "@/components/model-picker";

/** 一条已选模型的来源。目录里选的、手填的、自定义 provider 带来的。 */
export type Origin = "catalog" | "freehand" | "custom";

export type Picked = { identity: string; origin: Origin };

const ORIGIN_LABEL: Record<Origin, string> = {
  catalog: "目录",
  freehand: "手填",
  custom: "自定义",
};

/** 已选列表。手填与自定义的行标出来源,并在缺单价时挂一句成本记零的提示。 */
export function PickedList({
  value,
  onRemove,
}: {
  value: Picked[];
  onRemove: (identity: string) => void;
}) {
  if (value.length === 0) return <p className="text-muted-foreground">还没选模型。</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {value.map(({ identity, origin }) => (
        <Badge key={identity} variant="outline" className="gap-1.5 font-mono">
          {identity}
          {origin === "catalog" ? null : (
            <span
              className="rounded-sm bg-muted px-1 font-sans text-xs text-muted-foreground"
              title={origin === "freehand" ? "手填的标识,单价留空则成本记零" : "自定义 provider"}
            >
              {ORIGIN_LABEL[origin]}
            </span>
          )}
          <button
            type="button"
            aria-label={`移除 ${identity}`}
            className="-mr-0.5 text-muted-foreground transition-colors hover:text-destructive"
            onClick={() => onRemove(identity)}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

export function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  mono,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className={mono === true ? "font-mono" : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** 只有已配凭据的 provider 能手填(见 issue #80)。三个变体各自据此裁列表。 */
export function configuredProviders(providers: CatalogProvider[]): CatalogProvider[] {
  return providers.filter((provider) => provider.configured);
}

/** 撞上目录里已有的名字即拒收(见 issue #81)。 */
export function nameError(name: string, providers: CatalogProvider[]): string | null {
  if (name === "") return null;
  if (!/^[a-z0-9-]+$/u.test(name)) return "只能用小写字母、数字与连字符。";
  if (providers.some((provider) => provider.id === name)) return `${name} 已经被占用了,换一个。`;
  return null;
}
