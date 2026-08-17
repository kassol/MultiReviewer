/**
 * 凭据页(issue #64,ADR 0008)。每个 provider 一把 key,粘进来就完成配置。
 *
 * 只写不回显:列表给 provider、是否已配、更新时间、尾 4 位,明文从不回到前端。主密钥
 * 没设时整页只显示「差什么」——那一档服务照常起,但这一页什么都做不了。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useModelCatalog, type CatalogProvider } from "@/components/model-picker";

import { api, errorText } from "./api.ts";

/** 列表里的一家厂商。`configured` 为假即密文解不开,按未配置对待。 */
type Credential = {
  provider: string;
  configured: boolean;
  /** 保存时有没有真发过厂商验证请求。假即这家没有验证端点,key 对不对现在不知道。 */
  verified: boolean;
  updatedAt: string;
  last4: string | null;
};

/** 主密钥缺失时服务端回 503,这一页据此整体切到「差什么」的状态。 */
const MASTER_KEY_MISSING_STATUS = 503;

type ListState =
  | { kind: "ok"; credentials: Credential[] }
  | { kind: "unavailable"; reason: string };

/**
 * 表单底下那句针对所选 provider 的说明:覆盖还是新增、保存时验不验证。没选时说清这个
 * 下拉是什么,选了就只讲这一家会发生什么。
 */
function providerHint(picked: CatalogProvider | undefined): { text: string; isWarning: boolean } {
  if (picked === undefined) {
    return {
      text: "先挑一家 provider,列表是模型目录里的全部厂商,已配过 key 的那几家标了出来。",
      isWarning: false,
    };
  }
  const overwrite = picked.configured
    ? `${picked.id} 已经配过 key,保存是覆盖那一把,不是新增。`
    : `${picked.id} 还没配过 key。`;
  return picked.verifiable
    ? { text: `${overwrite}保存时真发一次最小请求验证,不通过就不保存。`, isWarning: false }
    : {
        text:
          `${overwrite}这家没有验证端点,保存时不发验证请求:` +
          "key 写错要等下一次 Review Run 失败才知道。",
        isWarning: true,
      };
}

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
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

  // provider 从模型目录里选,不手输:面板是唯一配置面,手写的标识配不上任何模型。
  const catalog = useModelCatalog();
  const providers = catalog.data?.providers ?? [];
  const picked = providers.find((candidate) => candidate.id === provider);
  const matched = useMemo((): CatalogProvider[] => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return providers;
    return providers.filter((candidate) =>
      `${candidate.id} ${candidate.name}`.toLowerCase().includes(needle),
    );
  }, [providers, query]);

  const pickedHint = providerHint(picked);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["credentials"] });
    // 目录里的 configured 与凭据列表同源,存完删完都要跟着变,否则下拉里还写着旧状态。
    void queryClient.invalidateQueries({ queryKey: ["catalog"] });
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
      // 认不出的厂商跳过了验证,这一点要当场说清:key 打错了要等下一次 Review Run 失败
      // 才会显形,而那时人早已离开这一页。
      const text = saved.verified
        ? `${saved.provider} 已保存,尾 4 位 ${saved.last4}。`
        : `${saved.provider} 已保存(尾 4 位 ${saved.last4}),但没有验证:` +
          "MultiReviewer 认不出这家厂商,key 写错了要等下一次 Review Run 失败才知道。";
      setFeedback({ text, isError: false });
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
          每个 provider 一把 key,同一家下的多个模型共用。有验证端点的那几家保存时真发一次
          最小请求验证,不通过就不保存;其余厂商照样能保存,只是标成「未验证」——是哪一种
          在 provider 下拉里逐家标出。key 加密进库,任何界面都不回显明文。
        </p>
      </div>

      {list.isError ? (
        <p className="text-destructive">{(list.error as Error).message}</p>
      ) : null}
      {catalog.isError ? (
        <p className="text-destructive">
          模型目录读不到,provider 选不了:{(catalog.error as Error).message}
        </p>
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
                <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      id="credential-provider"
                      type="button"
                      variant="outline"
                      className="w-56 justify-start font-mono"
                      disabled={catalog.isPending || catalog.isError}
                    >
                      {catalog.isPending
                        ? "读取模型目录…"
                        : catalog.isError
                          ? "目录读不到"
                          : picked === undefined
                            ? "挑一家 provider"
                            : picked.id}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[min(420px,calc(100vw-2rem))] gap-0 p-0"
                  >
                    {/* cmdk 自带的过滤只看选项值,而这里要按标识与显示名两样都能搜。 */}
                    <Command shouldFilter={false}>
                      <CommandInput
                        placeholder="搜 provider:标识或厂商名"
                        value={query}
                        onValueChange={setQuery}
                      />
                      <CommandList className="max-h-[300px]">
                        {matched.length === 0 ? (
                          <p className="py-6 text-center text-muted-foreground">
                            没有匹配的 provider。
                          </p>
                        ) : (
                          <CommandGroup>
                            {matched.map((candidate) => (
                              <CommandItem
                                key={candidate.id}
                                value={candidate.id}
                                onSelect={() => {
                                  setProvider(candidate.id);
                                  setPickerOpen(false);
                                }}
                              >
                                <span className="flex min-w-0 flex-1 flex-col">
                                  <span className="truncate font-mono">
                                    {candidate.id}
                                    {candidate.id === provider ? (
                                      <span className="ml-2 font-sans text-primary">已选</span>
                                    ) : null}
                                  </span>
                                  <span className="truncate text-[11px] text-muted-foreground">
                                    {candidate.name}
                                  </span>
                                </span>
                                <span className="shrink-0 text-[11px]">
                                  {candidate.configured ? (
                                    <span className="text-muted-foreground">已配,选它是覆盖</span>
                                  ) : candidate.verifiable ? (
                                    <span className="text-muted-foreground">保存时验证</span>
                                  ) : (
                                    <span className="text-warning">保存但不验证</span>
                                  )}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
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
            <p
              className={
                pickedHint.isWarning ? "text-xs text-warning" : "text-xs text-muted-foreground"
              }
            >
              {pickedHint.text}
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
                    <>
                      <span className="font-mono text-muted-foreground">
                        尾 4 位 {credential.last4}
                      </span>
                      {credential.verified ? null : (
                        <span className="text-warning">未验证</span>
                      )}
                    </>
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
