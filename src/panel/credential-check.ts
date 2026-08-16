/**
 * 模型凭据的厂商验证(ADR 0008)。保存前真发一次最小请求:key 打错要在粘贴的那一刻
 * 显形,不能等下一个 PR 进来才暴露。
 *
 * 请求一律选各家最便宜的只读端点,不产生推理费用。这里只认得下面四家,而模型目录列出
 * Pi 全部 39 家:认不出的那些照样能保存,只是跳过厂商验证并在库里标成未验证。拒收会让
 * 其余 35 家的模型选得出、凭据配不上,那才是把人堵死。
 */

/** 一家厂商的验证请求。`auth` 拼出该家认的认证头。 */
type ProviderCheck = {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
};

/**
 * 认得的 provider 及其验证端点。provider 标识与 Pi 的一致(模型组合里写的就是它)。
 *
 * - anthropic:`GET /v1/models` 认 `x-api-key`,并要求 `anthropic-version`。
 * - openai / deepseek:OpenAI 兼容的 `GET /models`,认 Bearer。
 * - openrouter:`GET /api/v1/key` 回这把 key 自己的额度信息,是它最小的认证端点
 *   (`/api/v1/models` 匿名可读,验不了凭据)。
 */
const CHECKS: Record<string, ProviderCheck> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  deepseek: {
    url: "https://api.deepseek.com/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/key",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  },
};

/** 认得的 provider 列表,提示里要把它们列出来。 */
export const CHECKED_PROVIDERS = Object.keys(CHECKS);

/** `verified` 为假即「这一家没有验证端点,key 对不对现在不知道」。 */
export type CredentialCheck = { ok: true; verified: boolean } | { ok: false; reason: string };

/**
 * 发一次最小请求验证凭据。2xx 即通过;401 / 403 是「这把 key 不被接受」,其余状态与
 * 网络错误各自照实回报——保存失败的原因要让人看得懂下一步做什么。
 *
 * 认不出的 provider 直接放行并标未验证:一个请求都不发,保存照做。
 */
export async function checkCredential(
  provider: string,
  apiKey: string,
): Promise<CredentialCheck> {
  const check = CHECKS[provider];
  if (check === undefined) return { ok: true, verified: false };

  let response: Response;
  try {
    response = await fetch(check.url, { method: "GET", headers: check.headers(apiKey) });
  } catch (error) {
    return {
      ok: false,
      reason: `连不上 ${provider}:${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.ok) return { ok: true, verified: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: `${provider} 不接受这把 key(HTTP ${response.status})` };
  }
  return { ok: false, reason: `${provider} 验证请求回了 HTTP ${response.status}` };
}
