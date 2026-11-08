const toolBuild = require("esbuild") as typeof import("esbuild");
const toolFiles = require("node:fs") as typeof import("node:fs");
const toolPath = require("node:path") as typeof import("node:path");
const toolProcess = require("node:child_process") as typeof import("node:child_process");

/**
 * 処理名: 試験CLI起動
 * 処理概要: 指定したintegration試験を一時bundleしてNodeで実行する。
 * 実装理由: CommonJSからTypeScriptの試験を同じ条件で起動するため。
 */
function runIntegrationTool(): void {
  process.chdir(toolPath.resolve(__dirname, ".."));
  const name = process.argv[2];
  if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("INVALID_TEST_NAME");
  const probeNames: Record<string, string> = {
    "probe-node-directml": "probe-directml",
    "probe-inference-backend": "probe-backend",
    "probe-inference-model-loader": "probe-model-loader",
    "probe-inference-image-codecs": "probe-image-codecs",
    "probe-inference-browser": "probe-browser",
    "probe-inference-model": "probe-inference",
    "probe-inference-worker": "probe-worker"
  };
  const probe = probeNames[name];
  const entry = probe === undefined
    ? toolPath.resolve("test/integration", `${name}.ts`)
    : toolPath.resolve("test/integration/probes", `${probe}.ts`);
  if (!toolFiles.existsSync(entry)) throw new Error("TEST_ENTRY_MISSING");
  const output = toolPath.resolve(".build/scripts", `${name}.js`);
  toolBuild.buildSync({ absWorkingDir: process.cwd(), entryPoints: [entry], outfile: output, bundle: true, packages: "external", platform: "node", format: "cjs", target: "node24" });
  const child = toolProcess.spawnSync(process.execPath, [output, ...process.argv.slice(3)], { stdio: "inherit", timeout: 1800000 });
  process.exitCode = child.status ?? 124;
}

runIntegrationTool();