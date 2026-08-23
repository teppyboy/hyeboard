import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vite";

const gitRoot = import.meta.dirname;
const gitCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: path.resolve(gitRoot, "../..") }).toString().trim();
  } catch {
    return "dev";
  }
})();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __HYEB_GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.VITE_PROXY_TARGET?.trim() || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
