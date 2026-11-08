import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerEmbeddingExtension } from "../../src/official/registration";
import type { OfficialFactory } from "../../src/official/types";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";

/** 処理名: Worker分離cache検証。処理概要: 二つの実Workerで同じ100行SQLを独立実行する。実装理由: process共有cacheで成功を装わないため。
 * @returns 検証完了。
 */
async function verifyCacheWorkers(): Promise<void> {
  const adapter = resolve(".build/official-cache-worker-adapter.js");
  await build({ entryPoints: ["src/official/registration.ts"], bundle: true, platform: "node", format: "cjs", outfile: adapter });
  const source = `
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {default:initialize}=await import(workerData.loader);const sqlite3=await initialize();let actual=0;
      const control=require(workerData.adapter).registerEmbeddingExtension(sqlite3,()=>{actual++;const value=new Uint8Array(3072);new DataView(value.buffer).setFloat32(0,1,true);return value;});
      const database=new sqlite3.oo1.DB(':memory:');
      try{const size=database.selectValue("WITH RECURSIVE numbers(value) AS(VALUES(1) UNION ALL SELECT value+1 FROM numbers WHERE value<100) SELECT sum(length(embedding_query('same'))) FROM numbers");if(size!==307200||actual!==1)throw Error('CACHE_WORKER_RESULT');}
      finally{database.close();await control.close();}
      parentPort.postMessage({status:'passed',actual});parentPort.close();
    })().catch(()=>{parentPort.postMessage({status:'failed'});parentPort.close();});
  `;
  const workers = Array.from({ length: 2 }, () => new Worker(source, { eval: true, execArgv: [], workerData: { adapter, loader: pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href } }));
  try {
    const results = await Promise.all(workers.map((worker) => new Promise<{ status: string; actual: number }>((complete, reject) => {
      const timer = setTimeout(() => reject(new Error("CACHE_WORKER_TIMEOUT")), 30000);
      worker.once("message", (message: { status: string; actual: number }) => { clearTimeout(timer); complete(message); });
      worker.once("error", () => { clearTimeout(timer); reject(new Error("CACHE_WORKER_FAILED")); });
    })));
    assert.deepEqual(results, [{ status: "passed", actual: 1 }, { status: "passed", actual: 1 }]);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
}

/**
 * 処理名: 実SQLite実行cache検証
 * 処理概要: 公式oo1のstep/resetとSQL全行評価で推論counterを測る。
 * 実装理由: mockの境界管理だけで実SQLiteの評価回数を代替しないため。
 * @returns 検証完了。
 */
async function testOfficialCache(): Promise<void> {
  const module = await import(pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href) as { default: OfficialFactory };
  const sqlite3 = await module.default();
  let calls = 0;
  const control = registerEmbeddingExtension(sqlite3, () => {
    calls++;
    const value = new Uint8Array(3072);
    new DataView(value.buffer).setFloat32(0, 1, true);
    return value;
  });
  const database = new sqlite3.oo1.DB(":memory:");
  try {
    database.exec("CREATE TABLE documents(id INTEGER); WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value+1 FROM numbers WHERE value<100) INSERT INTO documents SELECT value FROM numbers");
    assert.equal(database.selectValue("SELECT sum(length(embedding_query('same'))) FROM documents"), 307200);
    assert.equal(calls, 1);
    database.selectValue("SELECT sum(length(embedding_query('same'))) FROM documents");
    assert.equal(calls, 2);
    const statement = database.prepare("SELECT embedding_query(?)");
    try {
      statement.bind(["same"]);
      assert.equal(statement.step(), true);
      assert.equal(calls, 3);
      statement.reset();
      statement.bind(["same"]);
      assert.equal(statement.step(), true);
      assert.equal(calls, 4);
    } finally { statement.finalize(); }
    await assert.rejects(control.close(), /E_DB_IN_USE/u);
  } finally { database.close(); }
  await control.close();
  await verifyCacheWorkers();
  console.log(JSON.stringify({ stage: "official-statement-cache", status: "passed", rowCount: 100, firstExecutionInferences: 1, totalInferences: calls, isolatedWorkers: 2 }));
}

testOfficialCache().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });