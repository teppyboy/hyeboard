import { stdin, stderr, stdout } from "node:process";
import { createAdminPasswordHash } from "../src/admin-auth";

async function readMasked(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Interactive TTY required; use --stdin for automation.");
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
          if (character === "\r" || character === "\n") { cleanup(); stderr.write("\n"); resolve(value); return; }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (character >= " ") value += character;
        }
      };
      const cleanup = () => stdin.off("data", onData);
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function readStdinPasswords(): Promise<[string, string]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  return [lines[0] ?? "", lines[1] ?? ""];
}

let password = "";
let confirmation = "";
try {
  if (process.argv.slice(2).some((argument) => argument !== "--stdin")) throw new Error("Usage: hash-admin-password.ts [--stdin]");
  [password, confirmation] = process.argv.includes("--stdin")
    ? await readStdinPasswords()
    : [await readMasked("Password: "), await readMasked("Confirm password: ")];
  if (!password) throw new Error("Password must not be empty.");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  stdout.write(`${await createAdminPasswordHash(password)}\n`);
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : "Password hashing failed."}\n`);
  process.exitCode = 1;
} finally {
  password = "";
  confirmation = "";
}
