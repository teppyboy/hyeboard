import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const workerRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(workerRoot, "../..");
const bundlePath = join(workerRoot, "dist/index.js");
const tempRoot = join(workerRoot, ".package-check");
const execFileAsync = promisify(execFile);

async function linkDependency(root, name, source) {
  const target = join(root, "node_modules", ...name.split("/"));
  await mkdir(resolve(target, ".."), { recursive: true });
  await symlink(source, target, "junction");
}

async function verifyStartup(ocrEnabled) {
  const root = await mkdtemp(join(tempRoot, ocrEnabled ? "ocr-on-" : "ocr-off-"));
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    await cp(bundlePath, join(root, "dist/index.js"));
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
    await linkDependency(root, "@elysiajs/node", join(workerRoot, "node_modules/@elysiajs/node"));
    if (ocrEnabled) {
      const tesseractPath = join(workspaceRoot, "packages/university-adapters/node_modules/tesseract.js");
      if (!existsSync(tesseractPath)) throw new Error("tesseract.js is not installed for the OCR-enabled package check");
      await linkDependency(root, "tesseract.js", tesseractPath);
      await execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        "const module = await import('tesseract.js'); if (typeof module.createWorker !== 'function') throw new Error('missing createWorker export')",
      ], { cwd: root });
    }

    await new Promise((resolveStartup, rejectStartup) => {
      let output = "";
      let settled = false;
      let startupSeen = false;
      const child = spawn(process.execPath, ["dist/index.js"], {
        cwd: root,
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          HYEB_CAPTCHA_OCR: ocrEnabled ? "true" : "false",
          HYEB_SESSION_SECRET: "package-check-secret-package-check-secret",
          NODE_ENV: "production",
          PORT: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => finish(new Error(`startup timed out: ${output}`)), 10_000);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectStartup(error);
        else resolveStartup();
      };
      const inspect = (chunk) => {
        output += chunk.toString();
        if (!startupSeen && output.includes("Hyeboard (Node) listening")) {
          startupSeen = true;
          child.kill("SIGTERM");
        }
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", finish);
      child.once("exit", (code) => {
        if (!settled) finish(startupSeen ? undefined : new Error(`startup exited with code ${code}: ${output}`));
      });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await mkdir(tempRoot, { recursive: true });
try {
  const bundle = await readFile(bundlePath, "utf8");
  if (bundle.includes("@hyeboard/university-adapters/src/uet/captcha-ocr")) {
    throw new Error("Node bundle retains unresolved captcha-ocr workspace import");
  }
  if (!bundle.includes('await import("tesseract.js")')) throw new Error("Node bundle lost dynamic bare tesseract.js import");
  if (!bundle.includes("function solveCaptchaImage(") || !bundle.includes(".solveCaptchaImage);")) {
    throw new Error("Node bundle lost local OCR solver implementation or registration");
  }
  await verifyStartup(false);
  await verifyStartup(true);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
