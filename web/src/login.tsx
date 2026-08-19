import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { api } from "./api.ts";
import { clearPanelSession, loadPanelSession, panelNeedsBootstrap } from "./session.ts";

/** 同一条 /login:探测响应决定是账号登录还是零用户注册。 */
export function LoginPage() {
  const router = useRouter();
  const [bootstrapMode, setBootstrapMode] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [bootstrap, setBootstrap] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadPanelSession().then((session) => {
      if (session !== null) return router.navigate({ to: "/" });
      setBootstrapMode(panelNeedsBootstrap());
    });
  }, [router]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (bootstrapMode && password !== confirm) {
      setError("两次密码不一样");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (bootstrapMode) {
        const registered = await api("/users/bootstrap", {
          method: "POST",
          body: JSON.stringify({ bootstrap, username, password }),
        });
        if (registered.status !== 201) {
          const body = (await registered.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `注册失败(${registered.status})`);
          return;
        }
      }
      const response = await api("/session", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      if (response.status === 204) {
        clearPanelSession();
        await router.navigate({ to: "/" });
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
      <div className="flex w-[22rem] max-w-full flex-col gap-3">
        <div className="flex items-center gap-2">
          <Mark className="size-5 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">MultiReviewer</h1>
        </div>
        <Card className="gap-3 px-4">
          {bootstrapMode ? (
            <div>
              <h2 className="text-base font-semibold">建第一个管理员</h2>
              <p className="text-muted-foreground">第一个注册的人就是系统管理员,注册入口随后关闭。</p>
            </div>
          ) : null}
          <form onSubmit={submit} className="flex flex-col gap-2">
            {bootstrapMode ? (
              <>
                <Label htmlFor="bootstrap">bootstrap 口令</Label>
                <Input id="bootstrap" type="password" value={bootstrap} onChange={(event) => setBootstrap(event.target.value)} />
              </>
            ) : null}
            <Label htmlFor="username">用户名</Label>
            <Input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
            <Label htmlFor="password">密码</Label>
            <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrapMode ? "new-password" : "current-password"} />
            {bootstrapMode ? (
              <>
                <Label htmlFor="confirm">确认密码</Label>
                <Input id="confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
              </>
            ) : null}
            <Button type="submit" className="mt-1 w-full" disabled={busy || username === "" || password === ""}>
              {busy ? "处理中…" : bootstrapMode ? "注册并登录" : "登录"}
            </Button>
          </form>
          {error === null ? null : <p role="alert" className="text-destructive">{error}</p>}
        </Card>
      </div>
    </main>
  );
}
