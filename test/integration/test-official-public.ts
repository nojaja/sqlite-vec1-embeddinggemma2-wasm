import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { startLocalModelServer } from "./local-model-server";
import type { ProductInitOptions, ProductSqlite3 } from "../../src/official/types";

/**
 * 処理名: 公式公開Node入口検証
 * 処理概要: 候補bundleのdefault initializerをmainと実Workerで実行する。
 * 実装理由: private helperへの環境仮指定を公開API受入へ読み替えないため。
 * @returns 検証完了。
 */
async function testOfficialPublicEntry(): Promise<void> {
  const entry = resolve("dist/node/index.js");
  const initialize = (require(entry) as { default: (options?: ProductInitOptions) => Promise<ProductSqlite3> }).default;
  await assert.rejects(initialize({ embedding: { model: { network: "offline" } } }), /E_ENVIRONMENT/u);
  const sqlite3 = await initialize();
  const database = new sqlite3.oo1.DB(":memory:");
  assert.equal(database.selectValue("SELECT sqlite_version()"), "3.54.1");
  database.close(); await sqlite3.embedding.close();
  const server = await startLocalModelServer();
  const backend = process.argv[2] ?? "wasm";
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const initialize=require(workerData.entry).default;
      const sqlite3=await initialize({embedding:{backend:workerData.backend,model:{network:'allow',baseUrl:workerData.baseUrl},cacheDirectory:workerData.cache}});
      const database=new sqlite3.oo1.DB(':memory:');
      try{
        const bytes=database.selectValue('SELECT length(embedding_query(?))',['apple fruit']);
        const info=JSON.parse(database.selectValue('SELECT gemma_model_info()'));
        if(bytes!==3072||info.ready!==true||info.backend!==workerData.backend)throw Error('PUBLIC_QUERY_FAILED');
        if(info.modelId!=='google/embeddinggemma-2'||info.dtype!=='q4'||info.dimension!==768)throw Error('PUBLIC_INFO_FAILED');
      }finally{database.close();}
      await sqlite3.embedding.close();parentPort.postMessage({status:'passed'});
    })().catch(()=>parentPort.postMessage({status:'failed'}));
  `, { eval: true, execArgv: [], workerData: { entry, backend, baseUrl: server.baseUrl, cache: resolve(".build/official-model-cache") } });
  try {
    const result = await new Promise<{ status: string }>((complete, reject) => {
      const timer = setTimeout(() => reject(new Error("OFFICIAL_PUBLIC_WORKER_TIMEOUT")), 600000);
      worker.once("message", (message: { status: string }) => { clearTimeout(timer); complete(message); });
      worker.once("error", () => { clearTimeout(timer); reject(new Error("OFFICIAL_PUBLIC_WORKER_FAILED")); });
    });
    assert.equal(result.status, "passed");
  } finally { await worker.terminate(); await server.close(); }
  console.log(JSON.stringify({ stage: "official-public-node", status: "passed", backend }));
}

testOfficialPublicEntry().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });