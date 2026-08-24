import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/theme-button";
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
      setError("两次输入的密码不一致，请重新输入。");
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
          setError(body?.error ?? `注册失败（${registered.status}）`);
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
      setError(body?.error ?? `登录失败（${response.status}）`);
    } catch {
      setError("暂时无法连接服务，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-chrome px-4 py-8">
      <div className="flex w-[23rem] max-w-full flex-col gap-4">
        <div className="flex items-center gap-2.5 px-1">
          <Mark className="size-6 text-primary" />
          <h1 className="text-xl font-semibold tracking-tight">MultiReviewer</h1>
        </div>
        <Card className="gap-5 px-5 py-6">
          {bootstrapMode ? (
            <div className="border-b border-border pb-4">
              <h2 className="text-base font-semibold">注册首个系统管理员</h2>
              <p className="mt-1 text-muted-foreground">注册完成后，后续注册入口将关闭。</p>
            </div>
          ) : null}
          <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
            {bootstrapMode ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bootstrap">一次性启动口令</Label>
                <Input id="bootstrap" type="password" value={bootstrap} onChange={(event) => setBootstrap(event.target.value)} />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="username">用户名</Label>
              <Input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">密码</Label>
              <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={bootstrapMode ? "new-password" : "current-password"} />
            </div>
            {bootstrapMode ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="confirm">确认密码</Label>
                <Input id="confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="new-password" />
              </div>
            ) : null}
            {error === null ? null : <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">{error}</p>}
            <Button type="submit" variant="solid" highContrast size={{ initial: "4", sm: "2" }} className="w-full" disabled={busy || username === "" || password === ""}>
              {busy ? "处理中…" : bootstrapMode ? "注册并登录" : "登录"}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
