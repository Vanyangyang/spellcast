import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(cmd, args) {
  return spawn(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

async function up(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch {
    return false;
  }
}

if (!existsSync(join(root, "node_modules"))) {
  const install = run(npmCmd(), ["install"]);
  const code = await new Promise((resolve) => install.on("exit", resolve));
  if (code !== 0) process.exit(code ?? 1);
}

let api = null;
if (!(await up("http://127.0.0.1:47194/api/health"))) {
  api = run("cargo", ["run", "-p", "orbit-server"]);
  for (let i = 0; i < 80; i++) {
    if (await up("http://127.0.0.1:47194/api/health")) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log("");
console.log("  头脑风暴板  →  http://127.0.0.1:47193  （浏览器预览，不会往系统桌面抛泡）");
console.log("  桌面抛出     →  npm run desktop        （打开 Spellcast 窗口，一颗泡一扇透明小窗）");
console.log("");

const stop = () => {
  if (api && !api.killed) api.kill();
};
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
process.on("SIGTERM", stop);

if (await up("http://127.0.0.1:47193/")) {
  console.log("板已经在跑，不用再开。");
  if (api) {
    await new Promise((resolve) => api.on("exit", resolve));
  }
} else {
  const vite = run(npmCmd(), ["run", "dev"]);
  const code = await new Promise((resolve) => vite.on("exit", resolve));
  stop();
  process.exit(code ?? 0);
}
