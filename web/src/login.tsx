import { useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { api } from "./api.ts";

/** 登录一屏:只有一个 token 输入框。错误原样展示服务端的说法(token 不对 / 锁定中)。 */
export function LoginPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api("/session", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      if (response.status === 204) {
        await router.navigate({ to: "/repos" });
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? `登录失败(${response.status})`);
    } catch {
      setError("请求没发出去:后端可达吗?dev 下确认双进程都在跑。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-[21rem] max-w-full flex-col gap-3">
        <div className="flex items-center gap-2">
          <Mark className="size-5 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">MultiReviewer</h1>
        </div>
        <Card className="gap-3 px-4">
          <form onSubmit={submit} className="flex flex-col gap-2">
            {/* 有可见标签,不靠 placeholder 当标签:placeholder 一输入就消失。 */}
            <Label htmlFor="admin-token">admin token</Label>
            <Input
              id="admin-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="current-password"
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "login-error"}
              autoFocus
            />
            <Button type="submit" className="mt-1 w-full" disabled={busy || token === ""}>
              {busy ? "登录中…" : "登录"}
            </Button>
          </form>
          {error === null ? null : (
            <p id="login-error" role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </Card>
      </div>
    </main>
  );
}
