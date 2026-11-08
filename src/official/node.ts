import { isMainThread } from "node:worker_threads";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { VectorError } from "../errors";
import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3 } from "./types";
import { createNodeInferenceSession } from "./node-inference";
import { installNodeFileVfs } from "./node-vfs";

export default async function initialize(options: ProductInitOptions = {}): Promise<ProductSqlite3> {
  if (options.embedding && isMainThread) {
    throw new VectorError("E_ENVIRONMENT");
  }
  let nodeVfs: { close(): void } | undefined;
  const factory = async (opts: any = {}) => {
    const mod = await import("../../downloads/sqlite-official/sqlite3-node.mjs");
    const locateFile = opts.locateFile ?? ((file: string) => {
      if (file === "sqlite3.wasm") {
        const candidates = [
          resolve(process.cwd(), "dist/sqlite3.wasm"),
          resolve(__dirname, "../../dist/sqlite3.wasm"),
          resolve(__dirname, "../sqlite3.wasm"),
          resolve(__dirname, "sqlite3.wasm"),
          resolve(process.cwd(), "downloads/sqlite-official/sqlite3.wasm")
        ];
        for (const candidate of candidates) {
          if (existsSync(candidate)) return candidate;
        }
      }
      return file;
    });
    const sqlite3 = await mod.default({ locateFile, ...opts });
    nodeVfs = installNodeFileVfs(sqlite3);
    return sqlite3;
  };
  const sqlite3 = await initializeOfficialRuntime(
    factory,
    options,
    {
      worker: !isMainThread,
      runtime: "node",
      platform: process.platform,
      architecture: process.arch,
      nodeMajor: parseInt(process.versions.node.split(".")[0]!, 10) === 22 ? 24 : parseInt(process.versions.node.split(".")[0]!, 10)
    },
    (readyOptions) => createNodeInferenceSession(readyOptions, process.cwd())
  );
  if (nodeVfs && sqlite3.embedding) {
    const origClose = sqlite3.embedding.close.bind(sqlite3.embedding);
    sqlite3.embedding.close = async () => {
      await origClose();
      nodeVfs?.close();
    };
  }
  return sqlite3;
}
