/**
 * 服务(生产)或 Vite 插件(dev)注入的全局变量,前端读取前缀的唯一代码路径。
 * 不设 `import.meta.env` 回落:分叉点只留「谁注入」一个,「本地好好的、进镜像白屏」
 * 这类分叉不该存在。
 */
export type Injected = {
  /** 面板前缀,不含斜杠。Router basepath 与 API 基址都从它来。 */
  prefix: string;
};

declare global {
  interface Window {
    __MULTIREVIEWER__?: Injected;
  }
}

let cached: Injected | undefined;

export function injected(): Injected {
  if (cached !== undefined) return cached;
  const value = window.__MULTIREVIEWER__;
  if (value === undefined || typeof value.prefix !== "string" || value.prefix === "") {
    // 注入缺失当场报错,页面上写明原因,不静默白屏。
    document.body.textContent =
      "前缀注入缺失:生产由服务在返回 index.html 时注入;dev 要在仓库根 .env 设置 " +
      "MULTIREVIEWER_PANEL_PREFIX 后重启 Vite。";
    throw new Error("window.__MULTIREVIEWER__ 注入缺失");
  }
  cached = value;
  return value;
}
