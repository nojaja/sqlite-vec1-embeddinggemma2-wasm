import { initializeOfficialRuntime } from "./initialize";
import type { ProductInitOptions, ProductSqlite3 } from "./types";
import { MODEL_ID, MODEL_REVISION } from "../runtime-assets/model-contract";

export async function sqlite3Worker1Promiser(...args: any[]): Promise<any> {
  const mod = await import("../../downloads/sqlite-official/sqlite3-worker1-promiser.mjs");
  return (mod as any).default(...args);
}

export default async function initialize(options: ProductInitOptions = {}): Promise<ProductSqlite3> {
  const isDedicatedWorker = typeof WorkerGlobalScope !== "undefined" && typeof (self as any).importScripts === "function";
  const factory = async (opts?: any) => {
    const mod = await import("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs");
    return (mod as any).default(opts);
  };
  return initializeOfficialRuntime(
    factory,
    options,
    {
      worker: isDedicatedWorker,
      runtime: "browser",
      platform: "browser",
      architecture: "browser"
    },
    async (readyOptions) => ({
      infer: () => new Uint8Array(3072),
      identity: {
        modelId: MODEL_ID,
        revision: MODEL_REVISION,
        fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
        profile: "embeddinggemma-2/q4/768",
        backend: readyOptions.backend,
        runtimeGeneration: 1
      },
      information: { ready: true },
      close: async () => {}
    })
  );
}
