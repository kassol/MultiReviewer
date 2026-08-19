// PROTOTYPE — three variants of the model services page, switchable via `?variant=` on `/credentials`.
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleX,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Server,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type CatalogState = "ready" | "stale" | "failed";
type ModelSource = "automatic" | "manual" | "both";
type PrototypeVariant = "A" | "B" | "C";

type Model = {
  id: string;
  source: ModelSource;
  context: string;
  price: string;
};

type ModelService = {
  id: string;
  name: string;
  custom: boolean;
  conflict: boolean;
  credential: "verified" | "missing";
  catalog: CatalogState;
  lastSuccess: string;
  error?: string;
  models: Model[];
};

const INITIAL_SERVICES: ModelService[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    custom: false,
    conflict: false,
    credential: "verified",
    catalog: "ready",
    lastSuccess: "今天 11:12",
    models: [
      { id: "anthropic/claude-sonnet-4.5", source: "automatic", context: "200K", price: "$3 / $15" },
      { id: "openai/gpt-5.2", source: "automatic", context: "400K", price: "$1.75 / $14" },
      { id: "z-ai/glm-5.2", source: "both", context: "未提供", price: "费用未记账" },
    ],
  },
  {
    id: "internal-gateway",
    name: "公司模型网关",
    custom: true,
    conflict: false,
    credential: "verified",
    catalog: "stale",
    lastSuccess: "今天 09:42",
    error: "刷新超时；继续使用最近成功目录",
    models: [
      { id: "code-review-large", source: "automatic", context: "128K", price: "费用未记账" },
      { id: "security-review-v2", source: "manual", context: "未提供", price: "费用未记账" },
    ],
  },
  {
    id: "openai",
    name: "旧 OpenAI 网关",
    custom: true,
    conflict: true,
    credential: "verified",
    catalog: "ready",
    lastSuccess: "昨天 18:06",
    error: "与 Pi 内置 provider 同名，已由系统停用",
    models: [{ id: "gpt-5.1-internal", source: "manual", context: "未提供", price: "费用未记账" }],
  },
];

const SOURCE_LABEL: Record<ModelSource, string> = {
  automatic: "自动发现",
  manual: "模型补录",
  both: "自动发现 + 模型补录",
};

function serviceTone(service: ModelService) {
  if (service.conflict) return { label: "已停用", className: "bg-destructive/10 text-destructive", icon: CircleX };
  if (service.catalog === "stale") return { label: "刷新失败", className: "bg-warning/10 text-warning", icon: AlertTriangle };
  if (service.credential === "missing" || service.catalog === "failed") {
    return { label: "需要配置", className: "bg-destructive/10 text-destructive", icon: CircleX };
  }
  return { label: "正常", className: "bg-success/10 text-success", icon: Check };
}

function StatusBadge({ service }: { service: ModelService }) {
  const tone = serviceTone(service);
  const Icon = tone.icon;
  return (
    <Badge variant="secondary" className={cn("border-0", tone.className)}>
      <Icon data-icon="inline-start" />
      {tone.label}
    </Badge>
  );
}

function StateRows({ service }: { service: ModelService }) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-3">
      <div className="bg-background p-3">
        <dt className="text-xs font-medium text-muted-foreground">PROVIDER</dt>
        <dd className={cn("mt-1 font-medium", service.conflict && "text-destructive")}>
          {service.conflict ? "名字冲突，已停用" : "正常"}
        </dd>
      </div>
      <div className="bg-background p-3">
        <dt className="text-xs font-medium text-muted-foreground">模型凭据</dt>
        <dd className="mt-1 font-medium">{service.credential === "verified" ? "已验证" : "未配置"}</dd>
        {service.credential === "verified" ? <p className="mt-0.5 text-xs text-muted-foreground">今天 10:58 验证</p> : null}
      </div>
      <div className="bg-background p-3">
        <dt className="text-xs font-medium text-muted-foreground">模型目录</dt>
        <dd className={cn("mt-1 font-medium", service.catalog !== "ready" && "text-warning")}>
          {service.catalog === "ready" ? "可用" : service.catalog === "stale" ? "可用，刷新失败" : "发现失败"}
        </dd>
        <p className="mt-0.5 text-xs text-muted-foreground">最近成功 {service.lastSuccess}</p>
      </div>
    </dl>
  );
}

function ModelTable({ service, onAdd }: { service: ModelService; onAdd: (model: string) => void }) {
  const [modelId, setModelId] = useState("");
  return (
    <section className="overflow-hidden rounded-md border">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted px-3 py-2">
        <div>
          <h3 className="text-base font-semibold">模型</h3>
          <p className="text-xs text-muted-foreground">{service.models.length} 个模型进入可用清单</p>
        </div>
        <form
          className="ml-auto flex min-w-0 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (modelId.trim() === "") return;
            onAdd(modelId.trim());
            setModelId("");
          }}
        >
          <Label className="sr-only" htmlFor={`model-${service.id}`}>补录 model id</Label>
          <Input
            id={`model-${service.id}`}
            className="h-7 w-52 bg-background"
            placeholder="补录 model id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            disabled={service.conflict}
          />
          <Button size="sm" variant="outline" disabled={service.conflict || modelId.trim() === ""}>
            <Plus />补录
          </Button>
        </form>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-background text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 font-medium">模型标识</th><th className="px-3 py-2 font-medium">来源</th><th className="px-3 py-2 font-medium">上下文</th><th className="px-3 py-2 font-medium">输入 / 输出单价</th></tr>
          </thead>
          <tbody className="divide-y">
            {service.models.map((model) => (
              <tr key={model.id}>
                <td className="px-3 py-2"><span className="font-mono text-xs">{service.id}:{model.id}</span></td>
                <td className="px-3 py-2"><Badge variant="outline">{SOURCE_LABEL[model.source]}</Badge></td>
                <td className={cn("px-3 py-2", model.context === "未提供" && "text-warning")}>{model.context}</td>
                <td className={cn("px-3 py-2", model.price === "费用未记账" && "text-warning")}>{model.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServiceActions({
  service,
  onRefresh,
  onVerify,
}: {
  service: ModelService;
  onRefresh: () => void;
  onVerify: () => void;
}) {
  const [key, setKey] = useState("");
  return (
    <div className="grid gap-3 rounded-md border bg-muted p-3 lg:grid-cols-[1fr_auto]">
      <div className="grid gap-1.5">
        <Label htmlFor={`key-${service.id}`}>{service.credential === "verified" ? "更新模型凭据" : "配置模型凭据"}</Label>
        <div className="flex gap-2">
          <Input id={`key-${service.id}`} type="password" placeholder="只写不回显" value={key} onChange={(event) => setKey(event.target.value)} />
          <Button disabled={key === "" || service.conflict} onClick={() => { onVerify(); setKey(""); }}>
            <KeyRound />验证并保存
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">最小推理验证；失败不会替换现有有效凭据。</p>
      </div>
      <div className="flex items-end">
        <Button variant="outline" disabled={service.conflict} onClick={onRefresh}>
          <RefreshCw />刷新模型目录
        </Button>
      </div>
    </div>
  );
}

function ServiceDetail({
  service,
  onRefresh,
  onVerify,
  onAddModel,
}: {
  service: ModelService;
  onRefresh: () => void;
  onVerify: () => void;
  onAddModel: (model: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-lg font-semibold">{service.name}</h2><StatusBadge service={service} /></div>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{service.id}{service.custom ? " · 自定义 provider" : " · Pi 内置 provider"}</p>
        </div>
        {service.custom ? <Button className="ml-auto" size="sm" variant="destructive">删除模型服务</Button> : null}
      </div>
      {service.error === undefined ? null : (
        <div className={cn("rounded-md border px-3 py-2", service.conflict ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning/10 text-warning")}>
          <p className="font-medium">{service.error}</p>
          <p className="mt-0.5 text-xs">{service.conflict ? "改名重建或删除这项模型服务。" : "最近成功目录仍在使用，可重新刷新。"}</p>
        </div>
      )}
      <StateRows service={service} />
      <ServiceActions service={service} onRefresh={onRefresh} onVerify={onVerify} />
      <ModelTable service={service} onAdd={onAddModel} />
    </div>
  );
}

function VariantA(props: VariantProps) {
  return (
    <div className="grid max-w-[1180px] gap-4 p-5 pb-20 lg:grid-cols-[300px_minmax(0,1fr)]">
      <Card className="self-start gap-0 overflow-hidden p-0">
        <div className="border-b bg-muted px-3 py-2">
          <div className="flex items-center gap-2"><Search className="size-4 text-muted-foreground" /><span className="font-medium">模型服务检查表</span></div>
          <p className="mt-0.5 text-xs text-muted-foreground">先处理异常，再进入单项配置</p>
        </div>
        <div className="divide-y">
          {props.services.map((service) => (
            <button key={service.id} type="button" className={cn("w-full px-3 py-3 text-left hover:bg-muted", props.selected.id === service.id && "bg-muted")} onClick={() => props.onSelect(service.id)}>
              <div className="flex items-center gap-2"><span className="font-medium">{service.name}</span><StatusBadge service={service} /></div>
              <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>{service.models.length} 个模型</span><span>{service.lastSuccess}</span></div>
            </button>
          ))}
        </div>
      </Card>
      <Card className="p-4"><ServiceDetail service={props.selected} onRefresh={props.onRefresh} onVerify={props.onVerify} onAddModel={props.onAddModel} /></Card>
    </div>
  );
}

function VariantB(props: VariantProps) {
  const attention = props.services.filter((service) => serviceTone(service).label !== "正常");
  return (
    <div className="max-w-[1120px] space-y-5 p-5 pb-20">
      <section>
        <div className="mb-2 flex items-baseline justify-between"><h2 className="text-base font-semibold">需要处理</h2><span className="text-xs text-muted-foreground">{attention.length} 项</span></div>
        <div className="grid gap-3 md:grid-cols-2">
          {attention.map((service) => (
            <button key={service.id} type="button" className="rounded-md border border-warning/30 bg-warning/10 p-3 text-left hover:bg-warning/15" onClick={() => props.onSelect(service.id)}>
              <div className="flex items-center justify-between"><span className="font-medium">{service.name}</span><StatusBadge service={service} /></div>
              <p className="mt-2 text-sm">{service.error}</p>
              <p className="mt-1 text-xs text-muted-foreground">打开并处理 →</p>
            </button>
          ))}
        </div>
      </section>
      <section className="overflow-hidden rounded-md border">
        <div className="flex items-center border-b bg-muted px-3 py-2"><h2 className="text-base font-semibold">全部模型服务</h2><span className="ml-auto text-xs text-muted-foreground">仅显示已配置与异常项</span></div>
        <div className="divide-y">
          {props.services.map((service) => (
            <div key={service.id}>
              <button type="button" className={cn("grid w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted sm:grid-cols-[1fr_110px_120px_120px]", props.selected.id === service.id && "bg-muted shadow-[inset_3px_0_0_var(--foreground)]")} onClick={() => props.onSelect(service.id)}>
                <span><strong className="font-medium">{service.name}</strong><span className="ml-2 font-mono text-xs text-muted-foreground">{service.id}</span></span>
                <StatusBadge service={service} />
                <span className="text-xs text-muted-foreground">{service.models.length} 个模型</span>
                <span className="text-xs text-muted-foreground">{service.lastSuccess}</span>
              </button>
              {props.selected.id === service.id ? <div className="border-t bg-background p-4"><ServiceDetail service={service} onRefresh={props.onRefresh} onVerify={props.onVerify} onAddModel={props.onAddModel} /></div> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function VariantC(props: VariantProps) {
  return (
    <div className="max-w-[1120px] p-5 pb-20">
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted p-2">
        <span className="px-2 text-xs font-medium text-muted-foreground">正在处理</span>
        <select className="h-8 min-w-56 rounded-md border bg-background px-2 text-sm" value={props.selected.id} onChange={(event) => props.onSelect(event.target.value)}>
          {props.services.map((service) => <option key={service.id} value={service.id}>{service.name} · {serviceTone(service).label}</option>)}
        </select>
        <div className="ml-auto flex gap-1 text-xs">
          <span className="rounded-sm bg-background px-2 py-1">1 检查状态</span><span className="rounded-sm bg-background px-2 py-1">2 验证凭据</span><span className="rounded-sm bg-background px-2 py-1">3 管理模型</span>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
        <Card className="p-4"><ServiceDetail service={props.selected} onRefresh={props.onRefresh} onVerify={props.onVerify} onAddModel={props.onAddModel} /></Card>
        <aside className="space-y-3">
          <Card className="p-3">
            <h2 className="text-base font-semibold">健康队列</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">按需要处理的顺序排列</p>
            <div className="mt-3 space-y-1">
              {props.services.map((service) => (
                <button key={service.id} type="button" className={cn("flex w-full items-center justify-between rounded-md px-2 py-2 text-left hover:bg-muted", service.id === props.selected.id && "bg-muted")} onClick={() => props.onSelect(service.id)}>
                  <span className="truncate">{service.name}</span><StatusBadge service={service} />
                </button>
              ))}
            </div>
          </Card>
          <Card className="p-3">
            <h2 className="text-base font-semibold">添加服务</h2>
            <p className="mt-1 text-xs text-muted-foreground">搜索未配置的 Pi 内置 provider，或添加自定义端点。</p>
            <Button className="mt-3 w-full" variant="outline"><Plus />添加模型服务</Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}

type VariantProps = {
  services: ModelService[];
  selected: ModelService;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  onVerify: () => void;
  onAddModel: (model: string) => void;
};

const VARIANTS: { key: PrototypeVariant; name: string }[] = [
  { key: "A", name: "主从检查表" },
  { key: "B", name: "异常优先清单" },
  { key: "C", name: "单项工作台" },
];

function currentVariant(): PrototypeVariant {
  const value = new URLSearchParams(window.location.search).get("variant");
  return value === "B" || value === "C" ? value : "A";
}

function PrototypeSwitcher({ variant, onChange }: { variant: PrototypeVariant; onChange: (variant: PrototypeVariant) => void }) {
  const index = VARIANTS.findIndex((item) => item.key === variant);
  const move = (step: number) => onChange(VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length]!.key);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!import.meta.env.DEV) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-2 py-1.5 text-primary-foreground shadow-lg">
      <Button aria-label="上一种原型" size="icon-sm" variant="ghost" className="text-primary-foreground hover:bg-white/15 hover:text-primary-foreground" onClick={() => move(-1)}><ArrowLeft /></Button>
      <span className="min-w-40 text-center text-xs font-medium">{variant} — {VARIANTS[index]!.name}</span>
      <Button aria-label="下一种原型" size="icon-sm" variant="ghost" className="text-primary-foreground hover:bg-white/15 hover:text-primary-foreground" onClick={() => move(1)}><ArrowRight /></Button>
    </div>
  );
}

export function CredentialsPage() {
  const [services, setServices] = useState(INITIAL_SERVICES);
  const [selectedId, setSelectedId] = useState(INITIAL_SERVICES[1]!.id);
  const [variant, setVariant] = useState<PrototypeVariant>(currentVariant);
  const [notice, setNotice] = useState("这是不连接真实 API 的交互原型；所有操作只改变当前页面内存。 ");

  const selected = useMemo(() => services.find((service) => service.id === selectedId) ?? services[0]!, [selectedId, services]);
  const updateSelected = (change: (service: ModelService) => ModelService) => setServices((current) => current.map((service) => service.id === selected.id ? change(service) : service));
  const changeVariant = (next: PrototypeVariant) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
    setVariant(next);
  };
  const props: VariantProps = {
    services,
    selected,
    onSelect: setSelectedId,
    onRefresh: () => {
      updateSelected((service) => {
        if (service.conflict) return { ...service, catalog: "ready", lastSuccess: "刚刚" };
        const { error: _error, ...rest } = service;
        return { ...rest, catalog: "ready", lastSuccess: "刚刚" };
      });
      setNotice(`${selected.name} 的模型目录已刷新；原型把它切到最近成功状态。`);
    },
    onVerify: () => {
      updateSelected((service) => ({ ...service, credential: "verified" }));
      setNotice(`${selected.name} 已通过最小推理验证；失败时旧凭据会继续生效。`);
    },
    onAddModel: (model) => {
      updateSelected((service) => service.models.some((item) => item.id === model) ? service : { ...service, models: [...service.models, { id: model, source: "manual", context: "未提供", price: "费用未记账" }] });
      setNotice(`已补录 ${selected.id}:${model}；模型信息保持未知。`);
    },
  };

  return (
    <>
      <PageHeader
        title="模型服务"
        description="配置 provider 与模型凭据，检查模型目录，并处理影响模型组合的异常。"
        actions={<><Button variant="outline"><Search />配置内置 provider</Button><Button><Plus />添加自定义 provider</Button></>}
      />
      <div className="border-b bg-muted px-5 py-2 text-xs text-muted-foreground" role="status">{notice}</div>
      {variant === "A" ? <VariantA {...props} /> : variant === "B" ? <VariantB {...props} /> : <VariantC {...props} />}
      <PrototypeSwitcher variant={variant} onChange={changeVariant} />
    </>
  );
}
