import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

/** base 保持 Vite 默认的绝对 `/`:面板与静态资源都挂在根路径下。 */
export default defineConfig(({ mode }) => {
  // loadEnv 会把 .env 里全部 MULTIREVIEWER_* 读进来(含模型凭据主密钥等机密)。它们只
  // 停留在配置作用域;绝不要把 envPrefix 设成 "MULTIREVIEWER_"——那会把机密打进客户端包。
  const env = loadEnv(mode, "..", "MULTIREVIEWER_");
  const backendPort = env["MULTIREVIEWER_PORT"] ?? "3000";

  return {
    plugins: [react(), tailwindcss()],
    // 项目源码用 `@/` 指向 src，与 tsconfig 的 paths 同一套。
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    server: {
      // dev 走 proxy 把 `/api` 转到本机后端:浏览器视角同源同路径,cookie 正常携带、
      // 无 CORS。webhook 不进 proxy。后端没起时 502 即为答案,不做兜底。
      proxy: { "/api": { target: `http://localhost:${backendPort}` } },
    },
  };
});
