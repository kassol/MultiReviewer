import { useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <main className="mx-auto mt-[22vh] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-3.5">
      <h1 className="text-[19px] font-semibold tracking-tight">MultiReviewer</h1>
      <form onSubmit={submit} className="flex gap-2">
        <Input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="admin token"
          autoFocus
        />
        <Button type="submit" disabled={busy || token === ""}>
          登录
        </Button>
      </form>
      {error === null ? null : (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </main>
  );
}
