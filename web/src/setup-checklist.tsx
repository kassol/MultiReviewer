import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Card } from "@/components/ui/card";

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
  if (status.data === undefined || status.data.instanceEnabled) return null;

  const current = !status.data.hasRunnableModelService
    ? "service"
    : !status.data.reviewConfigurationReady
      ? "strategy"
      : "repository";
  const steps = [
    {
      id: "service",
      label: "配置可运行模型服务",
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
    <Card className="mx-4 mt-4 gap-2 px-4 py-3 sm:mx-5" aria-label="首次配置检查单">
      <div>
        <h2 className="font-semibold">完成首次配置</h2>
        <p className="text-xs text-muted-foreground">按顺序完成三步后，实例开始接收已注册仓库的审查。</p>
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
