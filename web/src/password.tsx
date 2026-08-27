import { useRouter } from "@tanstack/react-router";
import { CrossCircledIcon } from "@radix-ui/react-icons";
import { Callout, Card, Text, TextField } from "@radix-ui/themes";
import { useState, type FormEvent } from "react";

import { Mark } from "@/components/mark";
import { Button } from "@/components/theme-button";

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
    <div className="flex min-h-full items-center justify-center bg-background px-4 py-8">
      <div className="flex w-[360px] max-w-full flex-col items-center gap-[26px]">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[image:var(--v8-mark-gradient)] shadow-mark">
            <Mark framed={false} className="size-7 text-white" />
          </span>
          <h1 className="text-4xl font-extrabold tracking-[-0.02em]">修改密码</h1>
        </div>
        <Card size="2" className="flex w-full flex-col gap-3.5 rounded-2xl border-card-line bg-surface px-7 py-[26px] shadow-card">
          <p className="break-words text-text-muted">
            {session.mustChangePassword
              ? "密码已由系统管理员重置。请设置新的密码后继续使用面板。"
              : "保存后，其他设备上的会话会失效；当前会话继续使用。"}
          </p>
          <form onSubmit={submit} className="flex flex-col gap-3.5" aria-busy={busy}>
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="new-password" size="2" weight="medium">新密码</Text>
              <TextField.Root
                id="new-password"
                type="password"
                size={{ initial: "3", sm: "2" }}
                className="min-w-0 w-full max-sm:min-h-11"
                autoComplete="new-password"
                autoFocus
                value={password}
                aria-invalid={error !== null || undefined}
                aria-describedby={error === null ? undefined : "password-error"}
                onChange={(event) => { setPassword(event.target.value); setError(null); }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Text as="label" htmlFor="confirm-password" size="2" weight="medium">确认密码</Text>
              <TextField.Root
                id="confirm-password"
                type="password"
                size={{ initial: "3", sm: "2" }}
                className="min-w-0 w-full max-sm:min-h-11"
                autoComplete="new-password"
                value={confirm}
                aria-invalid={error !== null || undefined}
                aria-describedby={error === null ? undefined : "password-error"}
                onChange={(event) => { setConfirm(event.target.value); setError(null); }}
              />
            </div>
            {error === null ? null : (
              <Callout.Root id="password-error" role="alert" color="red" size="1">
                <Callout.Icon><CrossCircledIcon aria-hidden /></Callout.Icon>
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Button type="submit" variant="solid" size={{ initial: "4", sm: "2" }} className="w-full" disabled={busy || password === "" || confirm === ""}>{busy ? "保存中…" : "保存新密码"}</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
