import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "extensions", "spellcast");

function tryCli(bin) {
  const result = spawnSync(bin, ["--install-extension", ext], {
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

if (tryCli("cursor") || tryCli("code")) {
  console.log("已安装 Spellcast 侧栏。先 npm run desktop，再从侧栏打开 Spellcast。");
  process.exit(0);
}

const home = process.env.USERPROFILE || process.env.HOME || "";
const dest = join(home, ".cursor", "extensions", "spellcast-board");
mkdirSync(dirname(dest), { recursive: true });
if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
cpSync(ext, dest, { recursive: true });
console.log(`已拷到 ${dest}。重载窗口后，先 npm run desktop，再从侧栏打开 Spellcast。`);
