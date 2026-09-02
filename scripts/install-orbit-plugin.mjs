import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extensions", "orbit");

function tryCli(bin) {
  const result = spawnSync(bin, ["--install-extension", ext], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

if (tryCli("cursor") || tryCli("code")) {
  console.log("已安装 Spellcast 专注板。命令面板执行：Spellcast: 展开专注板");
  process.exit(0);
}

const home = process.env.USERPROFILE || process.env.HOME || "";
// Extension files only. Never write ~/.codex/** or Cursor mcp.json.
const dest = join(home, ".cursor", "extensions", "orbit-board");
mkdirSync(dirname(dest), { recursive: true });
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(ext, dest, { recursive: true });
console.log(`已拷到 ${dest}。先在仓库根目录 npm start，重载窗口后执行：Spellcast: 展开专注板`);
