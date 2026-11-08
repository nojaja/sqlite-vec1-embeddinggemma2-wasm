import { buildSync } from "esbuild";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

mkdirSync(".build/samples", { recursive: true });
const entry = resolve("samples/ruri-demo.ts");
const output = resolve(".build/samples/ruri-demo.js");

console.log("Ruri-v3 検証スクリプトをバンドルしています...");
buildSync({
  absWorkingDir: process.cwd(),
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "cjs",
  target: "node24"
});

console.log("Ruri-v3 CLI 検証を実行します...\n");
const child = spawnSync(process.execPath, [output], {
  stdio: "inherit",
  timeout: 300000
});

process.exit(child.status ?? 0);
