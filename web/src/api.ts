/**
 * 面板 API 的唯一入口。API 挂在 `/api` 下,cookie 同源自动携带;带 body 的请求
 * 默认按 JSON 发。
 */
/**
 * 面板 API 的绝对路径。`EventSource` 只收一个 URL,进不了 `api()` 的封装,由这里给出
 * 同一份基址。
 */
export function apiUrl(path: string): string {
  return `/api${path}`;
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
}

/** 失败响应的展示文案:优先取服务端的 error 字段，并保留可供查日志的 request id。 */
export async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    requestId?: string;
  } | null;
  const message = body?.error ?? `请求失败(${response.status})`;
  return body?.requestId === undefined ? message : `${message}（request id：${body.requestId}）`;
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await api(path);
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()) as T;
}

/**
 * 带 body 的请求(POST/PUT/DELETE)最常见的形状:发出去、失败就报错、有响应体就当 JSON
 * 解析。204 或空响应体两处都当作没有返回值——不去猜服务端这次到底给不给得出一份 JSON。
 * 需要在 `!response.ok` 之前先读一次响应体分支(比如 409 冲突)的调用点不适用这个封装。
 */
export async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await api(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
