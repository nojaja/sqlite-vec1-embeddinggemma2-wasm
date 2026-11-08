import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { mkdirSync } from "node:fs";
import { E2eTimingRecorder } from "./e2e-timing";

describe("G05 E2E: Specification Contract Query Execution", () => {
  test(
    "executes VECTOR(768 , 'embeddinggemma-2') STRICT DDL, INSERT and DISTANCE query successfully",
    async () => {
      const timing = new E2eTimingRecorder("vector-contract-query-wasm");
      mkdirSync(".build/samples", { recursive: true });

      const entry = resolve("samples/cli-demo.ts");
      const output = resolve(".build/samples/cli-demo.js");

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

      await timing.measure("contract-query-execution", async () => {
        const result = spawnSync(process.execPath, [output], {
          stdio: "pipe",
          encoding: "utf8",
          timeout: 300000
        });

        if (result.status !== 0) {
          console.error("CLI stdout:\n", result.stdout);
          console.error("CLI stderr:\n", result.stderr);
        }

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("CREATE TABLE documents");
        expect(result.stdout).toContain("VECTOR(768 , 'embeddinggemma-2')");
        expect(result.stdout).toContain("契約クエリの完全一致実行に成功しました！");
      });

      await timing.write("passed", {
        backend: "wasm",
        model: "embeddinggemma-2",
        measuredAt: new Date().toISOString()
      });
    },
    360000
  );
});
