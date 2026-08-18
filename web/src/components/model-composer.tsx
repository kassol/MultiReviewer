/**
 * 模型组合的两栏面板(issue #90)。模型进组合的三条入口收在同一屏上:左栏是厂商列(内置
 * 与自定义 provider 排在同一列、同一种渲染,列底部「+ 加一家 provider」),右栏是选中那家
 * 的模型列(顶上一个只筛这一家的搜索框,列底部固定一行手填 model id),已选的模型单独一
 * 张卡放在两栏之上。
 *
 * 形态取自原型变体 C(issue #83)。它把「填进哪一家」这个问题设计掉了:手填框长在已选中
 * 那家的下面,provider 不是一个要填对的字段,而是当前所处的位置——所以手填框旁边不要再
 * 摆一个 provider 下拉,那会把这一分还回去。明确接受的代价是跨厂商搜索没了(右栏的搜索
 * 框只筛当前这一家):模型组合是低频设置,三条入口的边界清楚才是每次都要用的。
 *
 * 接口只有「当前模型组合 + 变更回调」。写模型行、加一家 provider 是组件自己的事(它们改
 * 的是模型目录,不是这个组合);模型组合本身怎么存归调用页——全局设置存 `PUT /settings`,
 * 仓库覆盖存 `PUT /repos/<id>/reviewers` 且有「跟随全局」那一档(issue #91,两处共用这一份
 * 实现,没有第二份)。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import { api, errorText, fetchJson } from "../api.ts";
import {
  COST_ZERO_NOTE,
  modelIdentity,
  parseModelIdentity,
  useModelCatalog,
  type CatalogProvider,
} from "../model-catalog.ts";

/** 一条手填的模型行(issue #87)。面板只用得上它的标识,单价与上下文窗口这里改不了。 */
type ModelRow = {
  provider: string;
  model: string;
  createdAt: string;
};

/** 一家自定义 provider(issue #88)。key 不在这里:它只写不回显,状态看凭据页。 */
type CustomProvider = {
  name: string;
  baseUrl: string;
  api: string;
  createdAt: string;
};

/**
 * 接口协议的取值。服务端是权威的那一份(`CUSTOM_PROVIDER_APIS`),填别的值会被拒收并
 * 附上取值集;这里只是让人不用去查那两个字符串怎么拼。
 */
const CUSTOM_PROVIDER_APIS: { value: string; hint: string }[] = [
  { value: "openai-completions", hint: "走 /chat/completions" },
  { value: "openai-responses", hint: "走 /responses" },
];

/**
 * 右栏一次最多渲染这么多行:openrouter 一家就有五百多个模型,全渲染会让每次输入都卡住。
 * 这个数沿用换掉的那个 Popover 选择器全部加起来的上限(它按搜索词裁剪到 120 行),右栏
 * 一次只渲染一家,所以 120 全给这一家。
 */
const MODELS_SHOWN = 120;

type Feedback = { text: string; isError: boolean } | null;

export type ModelComposerProps = {
  /** 当前模型组合,受控。元素是模型标识 `provider:model`。 */
  value: string[];
  onChange: (next: string[]) => void;
};

export function ModelComposer({ value, onChange }: ModelComposerProps) {
  const catalog = useModelCatalog();
  const rows = useQuery({
    queryKey: ["model-rows"],
    queryFn: () => fetchJson<{ rows: ModelRow[] }>("/model-rows"),
  });
  const customProviders = useQuery({
    queryKey: ["custom-providers"],
    queryFn: () => fetchJson<{ providers: CustomProvider[] }>("/custom-providers"),
  });

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const providers = catalog.data?.providers ?? [];
  // 目录是异步来的,首帧一家都没有,所以选中项不能只在初值里定一次;删掉当前这一家之后它
  // 也要退回去有东西可选的状态。
  const selected = providers.find((entry) => entry.id === pickedId) ?? providers[0];

  // 手填进来的那些行。chips 与模型列表都要认出它们(前者标来源,后者给删除入口),因此按
  // 标识摊平成一张集合,随查询记忆化。
  const freehand = useMemo(() => {
    return new Set((rows.data?.rows ?? []).map(modelIdentity));
  }, [rows.data]);

  // 自定义 provider 的判据在目录端点给的 `custom` 位上,不在这张列表上:一家的模型全都是
  // 模型行,只看模型行会把它们一律标成「手填」。
  const customNames = useMemo(() => {
    const result = new Set<string>();
    for (const provider of providers) {
      if (provider.custom) result.add(provider.id);
    }
    return result;
  }, [providers]);

  // 已选的 chips 手上只有模型标识,单价留空那一位得回目录里查。整份目录扫一遍,只在目录
  // 变了的时候重扫。
  const costZero = useMemo(() => {
    const result = new Set<string>();
    for (const provider of providers) {
      for (const model of provider.models) {
        if (model.costUnset) result.add(`${provider.id}:${model.id}`);
      }
    }
    return result;
  }, [providers]);

  const toggle = (identity: string): void => {
    onChange(
      value.includes(identity)
        ? value.filter((item) => item !== identity)
        : [...value, identity],
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-2.5 px-4">
        <h2 className="text-base font-semibold">模型组合</h2>
        <p className="text-muted-foreground">
          一次审查按这几个模型各跑一遍。下面那两栏只管往里加,加进来的模型出现在这里。
        </p>
        {value.length === 0 ? (
          <p className="text-muted-foreground">还没选模型。</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {value.map((identity) => {
              const provider = parseModelIdentity(identity).provider;
              const origin = customNames.has(provider)
                ? "自定义"
                : freehand.has(identity)
                  ? "手填"
                  : null;
              return (
                <Badge key={identity} variant="outline" className="gap-1.5 font-mono">
                  {identity}
                  {origin === null ? null : (
                    <span className="rounded-sm bg-muted px-1 font-sans text-xs text-muted-foreground">
                      {origin}
                    </span>
                  )}
                  {costZero.has(identity) ? (
                    <span className="font-sans text-warning">{COST_ZERO_NOTE}</span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`移除 ${identity}`}
                    className="-mr-0.5 text-muted-foreground transition-colors hover:text-destructive"
                    onClick={() => toggle(identity)}
                  >
                    {/* 画出来的图标,不用 `×` 这个字符:字符的粗细与基线跟不上旁边的文字。 */}
                    <X className="size-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="grid h-[460px] grid-cols-[220px_1fr]">
          <div className="flex min-h-0 flex-col border-r border-border bg-chrome">
            <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
              厂商 <span className="font-mono tabular-nums">{providers.length}</span> 家
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {catalog.isPending ? (
                <div className="p-3">
                  <Skeleton className="h-56" />
                </div>
              ) : (
                providers.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={entry.id === selected?.id}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 border-b border-border px-3 py-2 text-left",
                      entry.id === selected?.id ? "bg-background" : "hover:bg-background/60",
                    )}
                    onClick={() => {
                      setPickedId(entry.id);
                      setFeedback(null);
                    }}
                  >
                    <span className="w-full truncate font-mono">{entry.id}</span>
                    <span className="text-xs text-muted-foreground">
                      <span className="font-mono tabular-nums">{entry.models.length}</span> 个模型
                      {entry.configured ? null : (
                        <span className="text-warning"> · 未配凭据</span>
                      )}
                      {/* 登记的那一家被停用了,目录里这一条其实是 Pi 内置的同名 provider。 */}
                      {entry.custom && entry.conflict ? (
                        <span className="text-destructive"> · 名字冲突,已停用</span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              className="border-t border-border px-3 py-2.5 text-left hover:bg-background/60"
              onClick={() => {
                setFeedback(null);
                setAddOpen(true);
              }}
            >
              + 加一家 provider
            </button>
          </div>

          {selected === undefined ? (
            <div className="p-3">
              {catalog.isPending ? (
                <Skeleton className="h-56" />
              ) : (
                <p className="text-muted-foreground">模型目录里一家 provider 都没有。</p>
              )}
            </div>
          ) : (
            // 换一家即整块重挂:搜索词与手填框跟着回到空,不会把上一家的输入带过来。
            <ProviderPane
              key={selected.id}
              provider={selected}
              custom={(customProviders.data?.providers ?? []).find(
                (entry) => entry.name === selected.id,
              )}
              value={value}
              freehand={freehand}
              onToggle={toggle}
              onFeedback={setFeedback}
              onProviderRemoved={() =>
                onChange(
                  value.filter(
                    (identity) => parseModelIdentity(identity).provider !== selected.id,
                  ),
                )
              }
            />
          )}
        </div>
      </Card>

      {catalog.isError ? (
        <p className="text-destructive">模型目录读不到:{(catalog.error as Error).message}</p>
      ) : null}
      {feedback === null ? null : (
        <p className={feedback.isError ? "text-destructive" : "text-muted-foreground"}>
          {feedback.text}
        </p>
      )}

      <AddProviderDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={(name) => {
          setAddOpen(false);
          setPickedId(name);
          setFeedback({
            text: `已加进模型目录,${name} 就在左边那一列里,它的模型选进组合就能跑。`,
            isError: false,
          });
        }}
      />
    </div>
  );
}

/**
 * 右栏:选中那一家的全部内容。搜索、模型列表、手填框三段固定在同一列里,人不需要知道
 * provider 该填在哪——它就是当前所处的位置。
 *
 * 自定义 provider 的端点与删除入口也在这里:一家的所有事都在同一屏上,才不用回到某张卡片
 * 上去找。
 */
function ProviderPane({
  provider,
  custom,
  value,
  freehand,
  onToggle,
  onFeedback,
  onProviderRemoved,
}: {
  provider: CatalogProvider;
  custom: CustomProvider | undefined;
  value: string[];
  freehand: Set<string>;
  onToggle: (identity: string) => void;
  onFeedback: (feedback: Feedback) => void;
  onProviderRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");

  const matched = useMemo(() => {
    const needles = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (needles.length === 0) return provider.models;
    return provider.models.filter((model) => {
      const haystack = `${model.id} ${model.name}`.toLowerCase();
      return needles.every((needle) => haystack.includes(needle));
    });
  }, [provider.models, query]);
  const models = matched.slice(0, MODELS_SHOWN);
  const hidden = matched.length - models.length;

  // 模型能不能选:凭据是原本那道门禁,撞名停用那一档(issue #94)也一并关掉。判据是目录在这
  // 一档给的是 Pi 内置同名那一家的模型,而登记的那一家自带凭据、`configured` 为真,只看它这
  // 些模型就选得进组合;服务端组装 Reviewer 时只按 provider 名判撞名,选进去的一律当失败处
  // 理。两者共用同一个模型标识,保存层分不出人要的是哪一个,所以门禁只能立在这里。手填框的
  // 判据不跟着改、仍只看 `configured`:撞名那一档由服务端拒收(沿用 issue #88 那条约定)。
  const selectable = provider.configured && !(provider.custom && provider.conflict);

  // 写模型行会同时动到目录:不失效 `catalog` 的话,刚填的那一行在这张列表里看不见。
  const refreshRows = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["model-rows"] });
    void queryClient.invalidateQueries({ queryKey: ["catalog"] });
  };

  const add = useMutation({
    mutationFn: async (model: string) => {
      const response = await api("/model-rows", {
        method: "POST",
        body: JSON.stringify({ provider: provider.id, model }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: (_result, model) => {
      onFeedback({
        text: `已加进 ${provider.id} 的模型列表,上面已按它过滤,点一下就选进组合。`,
        isError: false,
      });
      setDraft("");
      // 这一家有几百个模型时新加的行会落在渲染上限之外,搜出来才看得见。
      setQuery(model);
      refreshRows();
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  const removeRow = useMutation({
    mutationFn: async (model: string) => {
      const response = await api("/model-rows", {
        method: "DELETE",
        body: JSON.stringify({ provider: provider.id, model }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      onFeedback({
        text: "已从模型目录里删掉。已经把它选进模型组合的话记得一起改掉,否则下一次审查它会报「模型不存在」。",
        isError: false,
      });
      refreshRows();
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  const removeProvider = useMutation({
    mutationFn: async () => {
      const response = await api(`/custom-providers/${provider.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      // 本地组合里这家的标识跟着摘掉:服务端的引用检查只看已落库的组合,所以「先把这家的模
      // 型加进本地组合、保存之前把这家删掉」这条路删得成;而模型组合端点不校验目录成员,保
      // 存也会被接受,悬空的标识要到下一次 Review Run 才报缺凭据或模型不存在。就地摘掉,不
      // 留给人自己记着——反过来「本地还引用着就不许删」与服务端那道引用检查措辞重叠,还更磨人。
      onProviderRemoved();
      onFeedback({
        text: "已删除,它的模型行与那把 key 一起摘掉了。它的模型也从上面的模型组合里移掉了,记得按保存。",
        isError: false,
      });
      // 摘掉一家会同时动到目录、模型行与凭据三处:那把 key 走的是模型凭据表。
      void queryClient.invalidateQueries({ queryKey: ["custom-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
      refreshRows();
    },
    onError: (error: Error) => onFeedback({ text: error.message, isError: true }),
  });

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <span className="font-mono">{provider.id}</span>
        <span className="text-xs text-muted-foreground">{provider.name}</span>
        {provider.configured ? null : (
          <>
            <span className="text-xs text-warning">未配凭据,这家的模型选不了</span>
            <Link to="/credentials" className="text-xs text-primary underline underline-offset-4">
              去配凭据
            </Link>
          </>
        )}
        {custom === undefined ? null : (
          <>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {custom.baseUrl}
            </span>
            <span className="font-mono text-xs text-muted-foreground">{custom.api}</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="ml-auto"
              disabled={removeProvider.isPending}
              onClick={() => {
                onFeedback(null);
                removeProvider.mutate();
              }}
            >
              删掉这一家
            </Button>
          </>
        )}
      </div>

      {/*
       * 名字冲突这一档两条出路都要写出来(issue #94),而左栏只有 220px 宽塞不下:那边只
       * 标一句「名字冲突,已停用」,全文在这里。删除入口就在上面那一行,改名重建等于删掉
       * 再加一次,两条出路因此都在同一屏上够得着。
       */}
      {provider.custom && provider.conflict ? (
        <p className="border-b border-border px-3 py-2 text-destructive">
          <span className="font-mono">{provider.id}</span> 撞上 Pi
          内置的同名 provider「{provider.name}」,你加的这一家已停用,下面列的是内置那一家的
          模型,而且现在一个都选不了:它们与你这一家共用同一个模型标识,选进组合之后服务端只按
          provider 名判撞名,一律当失败处理。先改个名字重建,或者把它删掉,这一家的模型才选得
          了。已经在模型组合里的那些留着不动,下一次审查会为它们各留一条写明名字冲突的失败记
          录,同一轮里其余模型照常跑完。
        </p>
      ) : null}

      <div className="border-b border-border px-3 py-2">
        <Input
          aria-label={`在 ${provider.id} 里搜模型`}
          placeholder={`在 ${provider.id} 里搜模型,搜不到别家的`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {models.length === 0 ? (
          <p className="px-3 py-6 text-center text-muted-foreground">
            {provider.models.length === 0
              ? "这家在模型目录里一个模型都没有,手填的行继承不到接口协议与 base URL,这一家现在用不了。"
              : "这家没有匹配的模型。"}
          </p>
        ) : null}
        {models.map((model) => {
          const identity = `${provider.id}:${model.id}`;
          const picked = value.includes(identity);
          return (
            <div
              key={identity}
              className={cn(
                "flex items-center gap-2 border-b border-border px-3 py-2",
                selectable ? "hover:bg-muted" : null,
              )}
            >
              <button
                type="button"
                aria-pressed={picked}
                disabled={!selectable}
                className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-45"
                onClick={() => onToggle(identity)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">
                    {model.name}
                    {picked ? <span className="ml-2 text-primary">已选</span> : null}
                  </span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {Math.round(model.contextWindow / 1000)}K 上下文 ·{" "}
                  {model.costUnset ? (
                    <span className="text-warning">{COST_ZERO_NOTE}</span>
                  ) : (
                    `$${model.cost.input}/M 入 · $${model.cost.output}/M 出`
                  )}
                </span>
              </button>
              {freehand.has(identity) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={removeRow.isPending}
                  onClick={() => {
                    onFeedback(null);
                    removeRow.mutate(model.id);
                  }}
                >
                  删除
                </Button>
              ) : null}
            </div>
          );
        })}
        {hidden > 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            这家还有 {hidden} 个没列出,在上面的搜索框里缩小范围。
          </p>
        ) : null}
      </div>

      <form
        className="flex flex-col gap-1.5 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          onFeedback(null);
          add.mutate(draft.trim());
        }}
      >
        <Label htmlFor="freehand-model">在 {provider.id} 下手填一个 model id</Label>
        <div className="flex gap-2">
          <Input
            id="freehand-model"
            className="font-mono"
            placeholder="厂商文档里那个 id,例如 z-ai/glm-5.2"
            disabled={!provider.configured}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={add.isPending || !provider.configured || draft.trim() === ""}
          >
            {add.isPending ? "保存中…" : "加进目录"}
          </Button>
        </div>
        {provider.configured ? (
          <p className="text-xs text-warning">
            目录里还没有的模型填这里,接口协议与 base URL 从这家已有的模型继承。这里填的行不带
            单价,它的费用会记成零。
          </p>
        ) : (
          <p className="text-xs text-warning">
            这家还没配模型凭据,填了也跑不起来,所以这个框是禁用的。先去凭据页粘一把 key。
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * 「+ 加一家 provider」(issue #88)。公司内网网关、本机部署这类 OpenAI 兼容端点在这里加
 * 一家,加完它就排进左边那一列,和内置那些家并列。
 *
 * 五项一次收齐:全新的一家没有可继承的来源,缺 base URL 或接口协议时 Pi 会把这一家整个从
 * 目录里丢掉——不是报错,是消失;第一个 model id 一起填,新加的一家要立刻有东西可选;key
 * 走模型凭据表,不填的话这家的模型点得动却跑不起来。
 *
 * 校验一律不在前端复制一份:名字的字符集与撞名都由服务端回话,这里只把五个框都填了当作
 * 可提交。
 */
function AddProviderDialog({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiProtocol, setApiProtocol] = useState(CUSTOM_PROVIDER_APIS[0]!.value);
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      const response = await api("/custom-providers", {
        method: "POST",
        body: JSON.stringify({ name, baseUrl, api: apiProtocol, model, apiKey }),
      });
      if (!response.ok) throw new Error(await errorText(response));
    },
    onSuccess: () => {
      // 加一家会同时动到目录、模型行与凭据三处:那把 key 走的是模型凭据表,凭据页那一行
      // 也得跟着出现。
      void queryClient.invalidateQueries({ queryKey: ["custom-providers"] });
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      void queryClient.invalidateQueries({ queryKey: ["model-rows"] });
      void queryClient.invalidateQueries({ queryKey: ["credentials"] });
      const added = name;
      setName("");
      setBaseUrl("");
      setModel("");
      setApiKey("");
      onAdded(added);
    },
    onError: (failure: Error) => setError(failure.message),
  });

  const incomplete =
    name.trim() === "" || baseUrl.trim() === "" || model.trim() === "" || apiKey === "";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            add.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>加一家 provider</DialogTitle>
            <DialogDescription>
              加完它排进左边那一列,和内置那些家并列。名字由你起,只能用小写字母、数字与连
              字符、最长 64 个字符,与内置那些家共用同一命名空间——撞上已有的名字会被拒收。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-provider-name">名字</Label>
            {/* 上限 64 与服务端拉齐(`/^[a-z0-9-]{1,64}$/`,POST 校验与 DELETE 路由同一个数)。 */}
            <Input
              id="custom-provider-name"
              className="font-mono"
              placeholder="corp-gateway"
              maxLength={64}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-provider-base-url">base URL</Label>
            <Input
              id="custom-provider-base-url"
              className="font-mono"
              placeholder="https://ai.corp.example/v1"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>接口协议</Label>
            {/* 两个取值,做成两态开关:选项只有这么多,下拉多一次点击换不来任何信息。 */}
            <div className="flex gap-1">
              {CUSTOM_PROVIDER_APIS.map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={apiProtocol === option.value ? "default" : "outline"}
                  className="font-mono"
                  title={option.hint}
                  onClick={() => setApiProtocol(option.value)}
                >
                  {option.value}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-provider-model">第一个 model id</Label>
            <Input
              id="custom-provider-model"
              className="font-mono"
              placeholder="这个端点上那个模型标识"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-provider-key">key</Label>
            <Input
              id="custom-provider-key"
              type="password"
              autoComplete="off"
              placeholder="这个端点认的那把 key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              只写不回显。自定义端点没有能验证的只读接口,这把 key 对不对要等下一次审查才
              知道,凭据页上那一行因此写着「未验证」。
            </p>
          </div>
          {error === null ? null : <p className="text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={add.isPending || incomplete}>
              {add.isPending ? "保存中…" : "加一家"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
