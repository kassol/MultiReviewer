/**
 * 凭据页(issue #64,ADR 0008)。每个 provider 一把 key,粘进来就完成配置。
 *
 * 只写不回显:列表给 provider、是否已配、更新时间、尾 4 位,明文从不回到前端。主密钥
 * 没设时整页只显示「差什么」——那一档服务照常起,但这一页什么都做不了。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, errorText } from "./api.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 列表里的一家厂商。`configured` 为假即密文解不开,按未配置对待。 */
type Credential = {
  provider: string;
  configured: boolean;
  updatedAt: string;
  last4: string | null;
};

/** 主密钥缺失时服务端回 503,这一页据此整体切到「差什么」的状态。 */
const MASTER_KEY_MISSING_STATUS = 503;

type ListState =
  | { kind: "ok"; credentials: Credential[] }
  | { kind: "unavailable"; reason: string };

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; isError: boolean } | null>(null);

  const list = useQuery({
    queryKey: ["credentials"],
    queryFn: async (): Promise<ListState> => {
      const response = await api("/credentials");
      if (response.status === MASTER_KEY_MISSING_STATUS) {
        return { kind: "unavailable", reason: await errorText(response) };
      }
      if (!response.ok) throw new Error(await errorText(response));
      const body = (await response.json()) as { credentials: Credential[] };
      return { kind: "ok", credentials: body.credentials };
    },
  });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["credentials"] });
  };

  const save = useMutation({
    mutationFn: async (input: { provider: string; apiKey: string }) => {
      const response = await api(`/credentials/${encodeURIComponent(input.provider)}`, {
        method: "PUT",
        body: JSON.stringify({ apiKey: input.apiKey }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      return (await response.json()) as Credential;
    },
    onSuccess: (saved) => {
      setFeedback({ text: `${saved.provider} 已保存,尾 4 位 ${saved.last4}。`, isError: false });
      setApiKey("");
      refresh();
    },
    // 验证失败是本页最重要的一类失败:key 打错就该在这里显形,不能混进普通提示。
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  const remove = useMutation({
    mutationFn: async (target: string) => {
      const response = await api(`/credentials/${encodeURIComponent(target)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      setFeedback({ text: "已删除。", isError: false });
      refresh();
    },
    onError: (error: Error) => setFeedback({ text: error.message, isError: true }),
  });

  const state = list.data;
  const credentials = state?.kind === "ok" ? state.credentials : [];

  return (
    <div className="flex max-w-[1060px] flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-[19px] font-semibold tracking-tight">模型凭据</h1>
        <p className="text-muted-foreground">
          每个 provider 一把 key,同一家下的多个模型共用。保存时服务真发一次最小请求验证,
          不通过就不保存。key 加密进库,任何界面都不回显明文。
        </p>
      </div>

      {list.isError ? (
        <p className="text-destructive">{(list.error as Error).message}</p>
      ) : null}
      {feedback === null ? null : (
        <p className={feedback.isError ? "text-destructive" : "text-muted-foreground"}>
          {feedback.text}
        </p>
      )}

      {state?.kind === "unavailable" ? (
        <Card className="gap-2.5 border-l-[3px] border-l-warning px-4">
          <h2 className="font-semibold">这一页现在用不了</h2>
          <p className="text-muted-foreground">{state.reason}</p>
        </Card>
      ) : (
        <>
          <Card className="gap-2.5 px-4">
            <h2 className="font-semibold">粘一把 key</h2>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setFeedback(null);
                save.mutate({ provider, apiKey });
              }}
            >
              <div className="flex flex-col gap-1">
                <Label htmlFor="credential-provider">provider</Label>
                <Input
                  id="credential-provider"
                  className="w-56 font-mono"
                  placeholder="anthropic"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
              </div>
              <div className="flex min-w-56 flex-1 flex-col gap-1">
                <Label htmlFor="credential-key">key</Label>
                <Input
                  id="credential-key"
                  type="password"
                  className="font-mono"
                  placeholder="粘贴厂商 key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </div>
              <Button type="submit" disabled={save.isPending || provider === "" || apiKey === ""}>
                {save.isPending ? "验证中…" : "验证并保存"}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground">
              同一个 provider 保存第二次是覆盖,不是新增。
            </p>
          </Card>

          <Card className="gap-2.5 px-4">
            <h2 className="font-semibold">已配的厂商</h2>
            {list.isPending ? (
              <p className="text-muted-foreground">读取中…</p>
            ) : credentials.length === 0 ? (
              <p className="text-muted-foreground">还没有配任何厂商凭据。</p>
            ) : (
              credentials.map((credential) => (
                <div
                  key={credential.provider}
                  className="flex flex-wrap items-center gap-3 border-t border-border pt-2.5 first:border-t-0 first:pt-0"
                >
                  <span className="font-mono font-medium">{credential.provider}</span>
                  {credential.configured ? (
                    <span className="font-mono text-muted-foreground">
                      尾 4 位 {credential.last4}
                    </span>
                  ) : (
                    // 主密钥换过之后的形态:密文还在,这把主密钥解不开,重新粘一次即可。
                    <span className="text-warning">未配置(密文解不开,重新粘一次 key)</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    更新于 {new Date(credential.updatedAt).toLocaleString()}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    disabled={remove.isPending}
                    onClick={() => {
                      setFeedback(null);
                      remove.mutate(credential.provider);
                    }}
                  >
                    删除
                  </Button>
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </div>
  );
}
