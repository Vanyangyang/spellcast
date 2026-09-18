#!/usr/bin/env node
/**
 * Record docs/hero/index.html into docs/media/spellcast-hero-story.gif.
 * Uses system Chrome + ffmpeg. No extra npm deps.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = path.join(root, "docs/hero/index.html");
const outGif = path.join(root, "docs/media/spellcast-hero-story.gif");
const framesDir = path.join(root, "docs/hero/.frames");

const WIDTH = 1000;
const HEIGHT = 436;
const FPS = 20;
const DURATION_MS = 4200;
const FRAME_COUNT = Math.round((DURATION_MS / 1000) * FPS);

const chrome =
  process.env.CHROME ||
  ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome"].find((bin) =>
    existsSync(bin),
  );

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

async function shot(t, dest) {
  const url = `${pathToFileURL(html).href}?t=${t}`;
  await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    `--window-size=${WIDTH},${HEIGHT}`,
    "--default-background-color=07080c",
    `--screenshot=${dest}`,
    url,
  ]);
}

await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

for (let i = 0; i < FRAME_COUNT; i++) {
  const t = Math.round((i / FPS) * 1000);
  const dest = path.join(framesDir, `f${String(i).padStart(4, "0")}.png`);
  process.stdout.write(`frame ${i + 1}/${FRAME_COUNT} t=${t}\n`);
  await shot(t, dest);
}

const palette = path.join(framesDir, "palette.png");
await run("ffmpeg", [
  "-y",
  "-framerate",
  String(FPS),
  "-i",
  path.join(framesDir, "f%04d.png"),
  "-vf",
  "scale=1000:436:flags=neighbor,palettegen=max_colors=160:stats_mode=full",
  palette,
]);
await run("ffmpeg", [
  "-y",
  "-framerate",
  String(FPS),
  "-i",
  path.join(framesDir, "f%04d.png"),
  "-i",
  palette,
  "-lavfi",
  "scale=1000:436:flags=neighbor[x];[x][1:v]paletteuse=dither=floyd_steinberg",
  "-loop",
  "0",
  outGif,
]);

await rm(framesDir, { recursive: true, force: true });
process.stdout.write(`wrote ${outGif}\n`);
