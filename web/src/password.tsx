import { useRouter } from "@tanstack/react-router";
import { Text, TextField } from "@radix-ui/themes";
import { useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/theme-button";
import { Card } from "@radix-ui/themes";

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
      setError("两次输入的密码不一致，请重新输入。");
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
        <Card size="2" className="flex flex-col gap-5">
          <div className="border-b border-border pb-4">
            <h2 className="text-base font-semibold">修改密码</h2>
            <p className="mt-1 break-words text-muted-foreground">
              {session.mustChangePassword
                ? "密码已由系统管理员重置。请设置新的密码后继续使用面板。"
                : "保存后，其他设备上的会话会失效；当前会话继续使用。"}
            </p>
          </div>
          <form onSubmit={submit} className="flex flex-col gap-4" aria-busy={busy}>
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="new-password" size="2" weight="medium">新密码</Text>
              <TextField.Root id="new-password" type="password" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoComplete="new-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="confirm-password" size="2" weight="medium">确认密码</Text>
              <TextField.Root id="confirm-password" type="password" size={{ initial: "3", sm: "2" }} className="min-w-0 w-full max-sm:min-h-11" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} />
            </div>
            {error === null ? null : <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">{error}</p>}
            <Button type="submit" variant="solid" highContrast size={{ initial: "4", sm: "2" }} className="w-full" disabled={busy || password === "" || confirm === ""}>{busy ? "保存中…" : "保存新密码"}</Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
