/**
 * 全局设置页(issue #68)。全局模型组合与批次上限在这里改,存 `PUT <前缀>/api/settings`。
 *
 * 模型组合的编辑是两栏面板(issue #90,`components/model-composer.tsx`):模型进组合的三条
 * 入口——从目录里选、给已配凭据的 provider 手填一个标识、加一家自定义 provider——收在同
 * 一屏上。此前挂在这一页底下的「手填模型标识」与「自定义 provider」两张卡片因此从页上消
 * 失:它们各自搬进了面板里那条入口该在的位置(手填在选中那家的模型列下面,加一家在厂商
 * 列的底部),不是另写一份。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ModelComposer } from "@/components/model-composer";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import { api, errorText, fetchJson } from "./api.ts";
import { modelIdentity, parseModelIdentity } from "./model-catalog.ts";

type Settings = {
  reviewers: { provider: string; model: string }[];
  maxChangedLinesPerBatch: number;
};

export function SettingsPage() {
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => fetchJson<Settings>("/settings"),
  });

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

        {settings.data === undefined ? (
          <>
            <Skeleton className="h-[136px]" />
            <Skeleton className="h-[460px]" />
            <Skeleton className="h-[142px]" />
          </>
        ) : (
          // 表单以读回来的设置为初值,所以等数据到了再挂载。
          <SettingsForm key={JSON.stringify(settings.data)} settings={settings.data} />
        )}
      </div>
    </>
  );
}

function SettingsForm({ settings }: { settings: Settings }) {
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
      setFeedback({ text: "已保存,下一次投递按新组合跑。", isError: false });
      void queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  return (
    // 面板不在这张 `<form>` 里:它自己带着手填模型行那张表单,套进同一个 `<form>` 既是
    // 非法嵌套,也会让填一个 model id 顺手把模型组合与批次上限一起保存了。
    <div className="flex flex-col gap-4">
      <ModelComposer value={models} onChange={setModels} />
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
    </div>
  );
}
