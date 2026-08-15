import { useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

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
    <main style={{ maxWidth: "20rem", margin: "20vh auto", fontFamily: "system-ui" }}>
      <h1>MultiReviewer</h1>
      <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem" }}>
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="admin token"
          autoFocus
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={busy || token === ""}>
          登录
        </button>
      </form>
      {error === null ? null : <p role="alert">{error}</p>}
    </main>
  );
}
