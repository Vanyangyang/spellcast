#!/usr/bin/env node
/** Build an ordinary Web work and keep the original sources and dependency licenses. */
import { build } from "esbuild";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [directory, destination] = process.argv.slice(2);
if (!directory || !destination) throw new Error("Usage: node scripts/build-artifact.mjs SOURCE_DIRECTORY NEW_OUTPUT_DIRECTORY");
const source = await fs.realpath(path.resolve(directory));
const output = path.resolve(destination);
function archiveName(absolute) {
  const relative = path.relative(workspace, absolute);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep)
    ? relative : path.join("external", absolute.replace(/^([a-z]):/i, "$1").replace(/^[/\\]+/, ""));
}
if (output === source || output.startsWith(source + path.sep)) throw new Error("Use an output directory outside the source tree.");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output); // Existing outputs are preserved; build the next revision into a fresh directory.

async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) throw new Error("Artifact sources must not contain symbolic links: " + entry.name);
    const original = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(original, target);
    else if (entry.isFile()) await fs.copyFile(original, target);
  }
}
await copyTree(source, output);
const candidates = ["main.ts", "main.js"];
let entry;
for (const name of candidates) if (await fs.stat(path.join(source, name)).then(s => s.isFile()).catch(() => false)) { entry = path.join(source, name); break; }
const used = new Map();
if (entry) {
  const result = await build({ absWorkingDir: workspace, entryPoints: [entry], outdir: output,
    bundle: true, splitting: true, format: "esm", platform: "browser", target: "es2022", minify: true,
    entryNames: "app", chunkNames: "chunks/[name]-[hash]", assetNames: "assets/[name]-[hash]", sourcemap: "external", metafile: true,
    nodePaths: [path.join(workspace, "node_modules")],
    loader: { ...Object.fromEntries([".woff", ".woff2", ".ttf", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".glb", ".mp3", ".wav", ".mp4", ".webm"].map(ext => [ext, "file"])), ".md": "text" } });
  for (const input of Object.keys(result.metafile.inputs)) {
    const absolute = path.resolve(workspace, input), parts = absolute.split(path.sep);
    const nodeModules = parts.lastIndexOf("node_modules");
    if (nodeModules >= 0) {
      const count = parts[nodeModules + 1].startsWith("@") ? 3 : 2;
      const packageRoot = parts.slice(0, nodeModules + count).join(path.sep);
      if (!used.has(packageRoot)) {
        const pkg = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
        used.set(packageRoot, { name: pkg.name, version: pkg.version, license: pkg.license ?? "SEE LICENSE" });
      }
    } else {
      const target = path.join(output, "source", archiveName(absolute));
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(absolute, target);
    }
  }
  await fs.writeFile(path.join(output, "build-meta.json"), JSON.stringify({ entry: path.relative(workspace, entry), outputs: Object.keys(result.metafile.outputs) }, null, 2));
}
const sourceArchive = path.join(output, "source", archiveName(source));
await copyTree(source, sourceArchive);
await fs.mkdir(path.join(output, "source/scripts"), { recursive: true });
await fs.copyFile(fileURLToPath(import.meta.url), path.join(output, "source/scripts/build-artifact.mjs"));
await fs.copyFile(path.join(workspace, "package.json"), path.join(output, "source/package.json"));
await fs.copyFile(path.join(workspace, "package-lock.json"), path.join(output, "source/package-lock.json"));
await fs.copyFile(path.join(workspace, "LICENSE"), path.join(output, "source/LICENSE"));
const licenseDir = path.join(output, "licenses"); await fs.mkdir(licenseDir);
for (const [root, info] of used) {
  for (const name of ["LICENSE", "LICENSE.txt", "LICENSE.md", "license", "license.md", "COPYING"]) {
    const from = path.join(root, name);
    if (await fs.stat(from).then(s => s.isFile()).catch(() => false)) {
      await fs.copyFile(from, path.join(licenseDir, info.name.replaceAll("/", "__") + "@" + info.version + "-" + name)); break;
    }
  }
}
await fs.writeFile(path.join(output, "dependencies.json"), JSON.stringify([...used.values()], null, 2));
console.log(JSON.stringify({ directory: output, entry: "index.html", dependencies: [...used.values()].map(p => `${p.name}@${p.version}`) }));
