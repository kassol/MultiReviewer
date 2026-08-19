import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * 前缀来源与后端是同一份环境文件(仓库根的 `.env`):后端运行时读,这里配置阶段读。
 * base 保持 Vite 默认的绝对 `/`:静态资源不进前缀,构建产物与前缀无关。
 */
export default defineConfig(({ mode }) => {
  // loadEnv 会把 .env 里全部 MULTIREVIEWER_* 读进来(含模型凭据主密钥等机密)。它们只
  // 停留在配置作用域;绝不要把 envPrefix 设成 "MULTIREVIEWER_"——那会把机密打进客户端包。
  const env = loadEnv(mode, "..", "MULTIREVIEWER_");
  const prefix = env["MULTIREVIEWER_PANEL_PREFIX"] ?? "";
  const backendPort = env["MULTIREVIEWER_PORT"] ?? "3000";

  // dev 与生产的分叉压缩到「谁注入前缀全局变量」一个点:生产是服务返回 index.html
  // 时注入,dev 是这个内联插件注入同名变量。不设 dev 假前缀:没配就不注入,前端
  // 入口当场报错,与生产缺注入的表现一致。
  const injectPrefix: Plugin = {
    name: "multireviewer-inject-prefix",
    // 只在 dev 生效:build 时也注入会把前缀烤进产物,而构建产物必须与前缀无关——
    // 生产的注入由服务在返回 index.html 时做。
    apply: "serve",
    transformIndexHtml(html) {
      if (prefix === "") return html;
      return html.replace(
        "</head>",
        `<script>window.__MULTIREVIEWER__ = ${JSON.stringify({ prefix })};</script></head>`,
      );
    },
  };

  return {
    plugins: [react(), tailwindcss(), injectPrefix],
    // shadcn 组件用 `@/` 互相引用,与 tsconfig 的 paths 同一套。
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      // dev 走 proxy 把 `<前缀>/api` 转到本机后端:浏览器视角同源同路径,cookie
      // 正常携带、无 CORS。webhook 不进 proxy。后端没起时 502 即为答案,不做兜底。
      proxy:
        prefix === ""
          ? {}
          : { [`/${prefix}/api`]: { target: `http://localhost:${backendPort}` } },
    },
  };
});
