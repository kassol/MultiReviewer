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
