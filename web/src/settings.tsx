/**
 * 全局设置页(issue #68)。全局模型组合与批次上限在这里改,存 `PUT <前缀>/api/settings`。
 * 模型组合走多选器,不再手写标识;provider 由所选模型直接推出。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ModelPicker,
  modelIdentity,
  parseModelIdentity,
  useModelCatalog,
  type CatalogProvider,
} from "@/components/model-picker";
import { PrototypeSettings, usePrototypeVariant } from "./prototype/index.tsx";

import { api, errorText, fetchJson } from "./api.ts";

type Settings = {
  reviewers: { provider: string; model: string }[];
  maxChangedLinesPerBatch: number;
};

export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<Settings>("/settings"),
  });
  const catalog = useModelCatalog();

  // 原型分支:三条入口的变体挂在同一条路由上,`?variant=` 切换。主干不要这一段。
  const variant = usePrototypeVariant();
  if (variant !== null) {
    return (
      <PrototypeSettings variant={variant} providers={catalog.data?.providers ?? []} />
    );
  }

  return (
    <>
      <PageHeader
        title="全局设置"
        description="这里的模型组合是所有仓库的默认值,没设覆盖的仓库跟的就是它。批次上限决定一次审查最多送多少改动行。"
      />
      <div className="flex max-w-[1060px] flex-col gap-4 p-5">
        {settings.isError ? (
          <p className="text-destructive">{(settings.error as Error).message}</p>
        ) : null}
        {catalog.isError ? (
          <p className="text-destructive">模型目录读不到:{(catalog.error as Error).message}</p>
        ) : null}

        {settings.data === undefined ? (
          <>
            <Skeleton className="h-[136px]" />
            <Skeleton className="h-[142px]" />
          </>
        ) : (
          // 表单以读回来的设置为初值,所以等数据到了再挂载。
          <SettingsForm
            key={JSON.stringify(settings.data)}
            settings={settings.data}
            providers={catalog.data?.providers ?? []}
          />
        )}
      </div>
    </>
  );
}

function SettingsForm({
  settings,
  providers,
}: {
  settings: Settings;
  providers: CatalogProvider[];
}) {
  const queryClient = useQueryClient();
  const [models, setModels] = useState(() => settings.reviewers.map(modelIdentity));
  const [limit, setLimit] = useState(String(settings.maxChangedLinesPerBatch));
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  const save = useMutation({
    mutationFn: async (maxChangedLinesPerBatch: number): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          reviewers: models.map(parseModelIdentity),
          maxChangedLinesPerBatch,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Settings;
    },
    onSuccess: () => {
      setFeedback({ text: "已保存。", isError: false });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        setFeedback(null);
        // 字段是自由文本,`Number("abc")` 是 NaN,JSON 里它序列化成 null,而 null 在
        // 服务端的语义是「清除这一项」:不拦的话人看到「已保存」,配置却被悄悄删了。
        const parsed = Number(limit.trim());
        if (limit.trim() === "" || !Number.isInteger(parsed) || parsed <= 0) {
          setFeedback({ text: "批次上限要填正整数,这次没保存。", isError: true });
          return;
        }
        save.mutate(parsed);
      }}
    >
      <Card className="gap-2.5 px-4">
        <h2 className="text-base font-semibold">模型组合</h2>
        <p className="text-muted-foreground">
          一次审查按这几个模型各跑一遍。没配凭据的厂商在列表里看得见但选不了。
        </p>
        <ModelPicker providers={providers} value={models} onChange={setModels} />
      </Card>

      <Card className="gap-2.5 px-4">
        <h2 className="text-base font-semibold">批次上限</h2>
        <div className="flex flex-col gap-1">
          <Label htmlFor="max-changed-lines">一批最多改动行数</Label>
          <Input
            id="max-changed-lines"
            className="w-40 font-mono"
            inputMode="numeric"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          超过这个行数的改动会拆成多批送审。留空不行,要正整数。
        </p>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存"}
        </Button>
        {feedback === null ? null : (
          <span className={feedback.isError ? "text-destructive" : "text-muted-foreground"}>
            {feedback.text}
          </span>
        )}
      </div>
    </form>
  );
}
