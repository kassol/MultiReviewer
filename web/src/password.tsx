import { useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { api, errorText } from "./api.ts";
import { clearPanelSession, loadPanelSession, type PanelSession } from "./session.ts";

export function PasswordPage({ session, next }: { session: PanelSession; next: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (password !== confirm) {
      setError("两次密码不一样");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await api("/session/password", {
        method: "PUT",
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setError(await errorText(response));
        return;
      }
      clearPanelSession();
      await loadPanelSession();
      await router.navigate({ to: next });
    } catch {
      setError("请求没发出去，请稍后重试。");
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
          <div>
            <h2 className="text-base font-semibold">先改密码</h2>
            <p className="text-muted-foreground">管理员重置了 {session.username} 的密码。设一枚只有你知道的新密码，才能继续使用面板。</p>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-2">
            <Label htmlFor="new-password">新密码</Label>
            <Input id="new-password" type="password" autoComplete="new-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
            <Label htmlFor="confirm-password">确认密码</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            <Button type="submit" className="mt-1 w-full" disabled={busy || password === "" || confirm === ""}>{busy ? "保存中…" : "保存新密码"}</Button>
          </form>
          {error === null ? null : <p role="alert" className="text-destructive">{error}</p>}
        </Card>
      </div>
    </main>
  );
}
