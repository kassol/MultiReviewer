/**
 * 全局设置页(issue #68)。全局模型组合与批次上限在这里改,存 `PUT <前缀>/api/settings`。
 * 模型组合走多选器,不再手写标识;provider 由所选模型直接推出。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ModelPicker,
  modelIdentity,
  parseModelIdentity,
  useModelCatalog,
  type CatalogProvider,
} from "@/components/model-picker";

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

  return (
    <div className="flex max-w-[1060px] flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-[19px] font-semibold tracking-tight">全局设置</h1>
        <p className="text-muted-foreground">
          这里的模型组合是所有仓库的默认值,没设覆盖的仓库跟的就是它。批次上限决定一次
          审查最多送多少改动行。
        </p>
      </div>

      {settings.isError ? (
        <p className="text-destructive">{(settings.error as Error).message}</p>
      ) : null}
      {catalog.isError ? (
        <p className="text-destructive">模型目录读不到:{(catalog.error as Error).message}</p>
      ) : null}

      {settings.data === undefined ? (
        <p className="text-muted-foreground">读取中…</p>
      ) : (
        // 表单以读回来的设置为初值,所以等数据到了再挂载。
        <SettingsForm
          key={JSON.stringify(settings.data)}
          settings={settings.data}
          providers={catalog.data?.providers ?? []}
        />
      )}
    </div>
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
    mutationFn: async (): Promise<Settings> => {
      const response = await api("/settings", {
        method: "PUT",
        body: JSON.stringify({
          reviewers: models.map(parseModelIdentity),
          maxChangedLinesPerBatch: Number(limit),
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
        save.mutate();
      }}
    >
      <Card className="gap-2.5 px-4">
        <h2 className="font-semibold">模型组合</h2>
        <p className="text-muted-foreground">
          一次审查按这几个模型各跑一遍。没配凭据的厂商在列表里看得见但选不了。
        </p>
        <ModelPicker providers={providers} value={models} onChange={setModels} />
      </Card>

      <Card className="gap-2.5 px-4">
        <h2 className="font-semibold">批次上限</h2>
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
