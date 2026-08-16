import { injected } from "./injected.ts";

/**
 * 面板 API 的唯一入口。基址从注入的前缀来,cookie 同源自动携带;带 body 的请求
 * 默认按 JSON 发。
 */
export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/${injected().prefix}/api${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
}

/** 失败响应的展示文案:优先取服务端的 error 字段。 */
export async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `请求失败(${response.status})`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await api(path);
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as T;
}
