import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installNodeFileVfs } from "../../src/official/node-vfs";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { Worker } from "node:worker_threads";
import type { OfficialFactory } from "../../src/official/types";

/**
 * 処理名: 公式Node VFS受入
 * 処理概要: 同じ公式Wasmでhost fileのCRUDとclose/reopenを実行する。
 * 実装理由: NODEFSやWASI preopenを永続化保証の代用にしないため。
 * @returns 検証完了。
 */
async function testOfficialNodeVfs(): Promise<void> {
  await build({ entryPoints: ["src/official/node-vfs.ts"], bundle: true, platform: "node", format: "cjs", outfile: ".build/official-vfs-crash.js" });
  const module = await import(pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href) as { default: OfficialFactory };
  const sqlite3 = await module.default();
  const vfs = installNodeFileVfs(sqlite3);
  const root = await mkdtemp(join(tmpdir(), "official-node-vfs-"));
  const filename = join(root, "main.sqlite3");
  try {
    const database = new sqlite3.oo1.DB({ filename, vfs: "node-file", flags: "c" });
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE business(id INTEGER PRIMARY KEY,value TEXT); BEGIN; INSERT INTO business VALUES(1,'durable'); COMMIT");
    assert.equal(database.selectValue("PRAGMA quick_check"), "ok");
    assert.throws(() => new sqlite3.oo1.DB({ filename, vfs: "node-file", flags: "c" }), /BUSY|locked/u);
    database.close();
    const reopened = new sqlite3.oo1.DB({ filename, vfs: "node-file", flags: "w" });
    try {
      assert.equal(reopened.selectValue("SELECT value FROM business"), "durable");
      reopened.exec("BEGIN; UPDATE business SET value='changed'; DELETE FROM business; ROLLBACK");
      assert.equal(reopened.selectValue("SELECT value FROM business"), "durable");
      assert.equal(reopened.selectValue("PRAGMA quick_check"), "ok");
    } finally { reopened.close(); }
    const child = spawn(process.execPath, ["--input-type=module", "-"], { stdio: ["pipe", "pipe", "inherit"] });
    const script = `
      import initialize from ${JSON.stringify(pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href)};
      import {createRequire} from 'node:module';
      const require=createRequire(import.meta.url);
      const {installNodeFileVfs}=require(${JSON.stringify(resolve(".build/official-vfs-crash.js"))});
      const sqlite3=await initialize();installNodeFileVfs(sqlite3);
      const database=new sqlite3.oo1.DB({filename:${JSON.stringify(filename)},vfs:'node-file',flags:'w'});
      database.exec("PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=8;PRAGMA cache_spill=ON;BEGIN IMMEDIATE;UPDATE business SET value='uncommitted';WITH RECURSIVE numbers(value) AS(VALUES(2) UNION ALL SELECT value+1 FROM numbers WHERE value<100) INSERT INTO business SELECT value,printf('%10000d',value) FROM numbers");
      process.stdout.write('UNCOMMITTED_READY');setInterval(()=>{},1000);
    `;
    const ready = new Promise<void>((complete, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error("VFS_CRASH_CHILD_TIMEOUT")); }, 30000);
      child.stdout.on("data", (bytes: Buffer) => { if (bytes.toString("utf8").includes("UNCOMMITTED_READY")) { clearTimeout(timer); complete(); } });
      child.once("error", reject);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("VFS_CRASH_CHILD_EARLY_EXIT")); });
    });
    child.stdin.end(script);
    try { await ready; assert.ok((await stat(filename + "-journal")).size > 512); child.kill("SIGKILL"); await new Promise<void>((complete) => child.once("exit", () => complete())); }
    finally { if (child.exitCode === null) child.kill(); }
    const recovered = new sqlite3.oo1.DB({ filename, vfs: "node-file", flags: "w" });
    try { assert.equal(recovered.selectValue("SELECT value FROM business"), "durable"); assert.equal(recovered.selectValue("SELECT count(*) FROM business"), 1); assert.equal(recovered.selectValue("PRAGMA quick_check"), "ok"); }
    finally { recovered.close(); }
    const owner = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {default:initialize}=await import(workerData.loader);
        require(workerData.adapter).installNodeFileVfs(await initialize());
        const sqlite3=await initialize();require(workerData.adapter).installNodeFileVfs(sqlite3);
        const database=new sqlite3.oo1.DB({filename:workerData.filename,vfs:'node-file',flags:'w'});
        database.exec("BEGIN IMMEDIATE;UPDATE business SET value='worker-uncommitted'");
        parentPort.postMessage('READY');setInterval(()=>{},1000);
      })().catch(()=>parentPort.postMessage('FAILED'));
    `, { eval: true, execArgv: [], workerData: { loader: pathToFileURL(resolve("downloads/sqlite-official/sqlite3-node.mjs")).href, adapter: resolve(".build/official-vfs-crash.js"), filename } });
    try {
      const message = await new Promise<unknown>((complete, reject) => { owner.once("message", complete); owner.once("error", reject); });
      assert.equal(message, "READY");
    } finally { await owner.terminate(); }
    const workerRecovered = new sqlite3.oo1.DB({ filename, vfs: "node-file", flags: "w" });
    try { assert.equal(workerRecovered.selectValue("SELECT value FROM business"), "durable"); assert.equal(workerRecovered.selectValue("PRAGMA quick_check"), "ok"); }
    finally { workerRecovered.close(); }
  } finally { vfs.close(); await rm(root, { recursive: true, force: true }); }
  console.log(JSON.stringify({ stage: "official-node-vfs", status: "passed", journal: "DELETE", sync: "FULL" }));
}

testOfficialNodeVfs().catch((failure: unknown) => { console.error(failure); process.exitCode = 1; });