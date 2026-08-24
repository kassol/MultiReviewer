import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { HelpTooltip } from "@/components/help-tooltip";
import { Button } from "@/components/theme-button";
import { Card } from "@radix-ui/themes";

import { fetchJson } from "./api.ts";
import { hasPermission, type PanelSession } from "./session.ts";

export const SETUP_STATUS_QUERY_KEY = ["setup-status"] as const;

export type SetupStatus = {
  hasRunnableModelService: boolean;
  reviewConfigurationReady: boolean;
  hasRepository: boolean;
  instanceEnabled: boolean;
};

export function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchJson<SetupStatus>("/setup-status"),
  });
}

export function SetupChecklist({ session }: { session: PanelSession }) {
  const status = useSetupStatus();
  if (status.isError) {
    return (
      <Card size="2" className="flex flex-col mx-4 mt-4 gap-2 sm:mx-5" aria-label="首次配置状态读取失败">
        <h2 className="font-semibold">首次配置暂时不可用</h2>
        <p role="alert" className="text-sm text-destructive">{status.error.message}</p>
        <Button
          className="w-fit"
          type="button"
          variant="outline"
          color="gray"
          size={{ initial: "4", sm: "1" }}
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
        >
          {status.isFetching ? "正在重试…" : "重试"}
        </Button>
      </Card>
    );
  }
  if (status.data === undefined) {
    return (
      <Card size="2" className="flex flex-col mx-4 mt-4 gap-2 sm:mx-5" aria-label="正在读取首次配置状态">
        <h2 className="font-semibold">正在读取首次配置…</h2>
      </Card>
    );
  }
  if (status.data.instanceEnabled) return null;

  const current = !status.data.hasRunnableModelService
    ? "service"
    : !status.data.reviewConfigurationReady
      ? "strategy"
      : "repository";
  const steps = [
    {
      id: "service",
      label: "配置并验证模型服务",
      done: status.data.hasRunnableModelService,
      to: "/credentials" as const,
      allowed: hasPermission(session, "credential:write"),
    },
    {
      id: "strategy",
      label: "保存审查策略",
      done: status.data.reviewConfigurationReady,
      to: "/settings" as const,
      allowed: hasPermission(session, "model:write"),
    },
    {
      id: "repository",
      label: "注册首个仓库",
      done: status.data.hasRepository,
      to: "/repos" as const,
      allowed: hasPermission(session, "repo:write"),
    },
  ];

  return (
    <Card size="2" className="flex flex-col mx-4 mt-4 gap-2 sm:mx-5" aria-label="首次配置检查单">
      <div>
        <div className="flex items-center gap-1.5">
          <h2 className="font-semibold">完成首次配置</h2>
          <HelpTooltip
            label="首次配置说明"
            content="完成模型服务、审查策略和首个仓库配置后，系统开始处理已注册仓库的审查请求。"
          />
        </div>
      </div>
      <ol className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {steps.map((step, index) => (
          <li key={step.id} className={step.done ? "text-success" : current === step.id ? "font-medium" : "text-muted-foreground"}>
            {current === step.id && step.allowed ? (
              <Link className="underline underline-offset-4" to={step.to}>{index + 1}. {step.label}</Link>
            ) : (
              <span>{step.done ? `已完成：${step.label}` : `${index + 1}. ${step.label}`}</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
