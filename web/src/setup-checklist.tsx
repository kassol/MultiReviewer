import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Card, Skeleton } from "@radix-ui/themes";

import { HelpTooltip } from "@/components/help-tooltip";
import { Button } from "@/components/theme-button";

import { fetchJson } from "./api.ts";
import { hasPermission, type PanelSession } from "./session.ts";

export const SETUP_STATUS_QUERY_KEY = ["setup-status"] as const;

export type SetupStatus = {
  hasRunnableModelService: boolean;
  reviewConfigurationReady: boolean;
  hasRepository: boolean;
  instanceEnabled: boolean;
};

/**
 * 首次配置状态。同一页面里有三处读它——顶栏导航的告警点、这张检查单、以及注册仓库那颗
 * 按钮,三处共用这一个查询键。
 *
 * 保鲜时间让同一页面只请求一次(issue #439):壳先挂载、发出请求,页面代码是懒加载的,
 * 它那一批 chunk 到齐之后检查单才挂载,那时上一份已经落地而默认保鲜时间是 0,新观察者
 * 于是立刻重发一次(实测间隔约 0.4 秒)。**检查单仍然及时**:任何一次成功的写请求都让
 * 这个键失效(`main.tsx` 的 `MutationCache`),失效不看保鲜时间,照样立刻重取——配模型
 * 服务与存审查策略走 `useMutation`;注册仓库是普通的异步提交,它在成功之后自己点名失效
 * 这个键(`repo-actions.tsx`)。
 */
export function useSetupStatus() {
  return useQuery({
    queryKey: SETUP_STATUS_QUERY_KEY,
    queryFn: () => fetchJson<SetupStatus>("/setup-status"),
    staleTime: 30_000,
  });
}

/**
 * 检查条与业务页正文共用同一条内容轨:左右内边距跟 `PageBody` 对齐。它比
 * 正文宽出一截的话,页面顶上就多了一道对不齐的边,而这块本来就是正文的一部分。
 */
function ChecklistShell({ children }: { children: ReactNode }) {
  return <div className="w-full px-[18px] pt-6 sm:px-7">{children}</div>;
}

export function SetupChecklist({ session }: { session: PanelSession }) {
  const status = useSetupStatus();
  if (status.isError) {
    return (
      <ChecklistShell>
      <Callout.Root role="alert" color="red" size="2" aria-label="首次配置状态读取失败">
        <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
        <Callout.Text>
          <strong className="font-semibold">首次配置暂时不可用</strong>
          <span className="mt-1 block">{status.error.message}</span>
        </Callout.Text>
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
      </Callout.Root>
      </ChecklistShell>
    );
  }
  if (status.data === undefined) {
    return (
      <ChecklistShell>
        <Card
          size="2"
          className="flex flex-col gap-2"
          role="status"
          aria-label="正在读取首次配置状态"
          aria-busy="true"
        >
          <Skeleton aria-hidden className="h-5 w-40" />
          <Skeleton aria-hidden className="h-10 w-full" />
        </Card>
      </ChecklistShell>
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
      // 注册入口在首页左栏顶部(issue #195),仓库页已经没了。
      to: "/" as const,
      allowed: hasPermission(session, "repo:write"),
    },
  ];

  return (
    <ChecklistShell>
    <Card size="2" className="flex flex-col gap-2" aria-label="首次配置检查单">
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
          <li key={step.id} className={step.done ? "text-success" : current === step.id ? "font-medium" : "text-text-muted"}>
            {current === step.id && step.allowed ? (
              <Link className="underline underline-offset-4" to={step.to}>{index + 1}. {step.label}</Link>
            ) : (
              <span>{step.done ? `已完成：${step.label}` : `${index + 1}. ${step.label}`}</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
    </ChecklistShell>
  );
}
