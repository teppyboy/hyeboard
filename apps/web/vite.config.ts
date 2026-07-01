import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";
import path from "node:path";
import { defineConfig } from "vite";

const gitCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: path.resolve(__dirname, "../..") }).toString().trim();
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
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
