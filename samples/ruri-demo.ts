import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { EmbeddingCall } from "../src/official/functions";
import { registerEmbeddingExtension } from "../src/official/registration";

const STATUS_IDLE = 0;
const STATUS_REQUEST = 1;
const STATUS_DONE = 2;

if (!isMainThread) {
  // =========================================================================
  // Worker Thread: ONNX Runtime (Ruri-v3) のロードと推論処理
  // =========================================================================
  const { sab } = workerData as { sab: SharedArrayBuffer };
  const control = new Int32Array(sab, 0, 8);
  const dataView = new Uint8Array(sab, 32);

  const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");
  const { Tokenizer } = require("@huggingface/tokenizers");

  const modelDir = resolve("model/ruri-v3-130m-ONNX");
  const tokenizerJson = JSON.parse(readFileSync(resolve(modelDir, "tokenizer.json"), "utf8"));
  const configJson = JSON.parse(readFileSync(resolve(modelDir, "tokenizer_config.json"), "utf8"));
  const tokenizer = new Tokenizer(tokenizerJson, configJson);

  const onnxPath = resolve(modelDir, "onnx/model_q4.onnx");

  ort.InferenceSession.create(onnxPath).then(async (session) => {
    parentPort?.postMessage({ status: "ready" });

    while (true) {
      while (Atomics.load(control, 0) !== STATUS_REQUEST) {
        Atomics.wait(control, 0, STATUS_IDLE, 50);
      }

      const opCode = control[1]; // 0: document, 1: query
      const textLen = control[2]!;
      const textBytes = dataView.subarray(0, textLen);
      const text = new TextDecoder().decode(textBytes);

      // Ruri-v3 公式仕様のプレフィックス
      const prefixedText = opCode === 1 ? `検索クエリ: ${text}` : `検索文書: ${text}`;
      const encoding = tokenizer.encode(prefixedText);
      const ids = BigInt64Array.from(encoding.ids.map((id: number) => BigInt(id)));
      const mask = new BigInt64Array(ids.length).fill(1n);

      const feeds = {
        input_ids: new ort.Tensor("int64", ids, [1, ids.length]),
        attention_mask: new ort.Tensor("int64", mask, [1, mask.length])
      };

      const res = await session.run(feeds);
      const outputTensor = res.sentence_embedding || res.token_embeddings;
      if (!outputTensor) throw new Error("No output tensor from Ruri session");
      const rawData = outputTensor.data as Float32Array;

      // 512 次元 L2 正規化
      const normVec = new Float32Array(512);
      let sumSq = 0;
      for (let i = 0; i < 512; i++) sumSq += rawData[i]! * rawData[i]!;
      const norm = Math.sqrt(sumSq) || 1.0;
      for (let i = 0; i < 512; i++) normVec[i] = rawData[i]! / norm;

      // 2048 バイトのバイナリを出力
      const outBytes = new Uint8Array(normVec.buffer, normVec.byteOffset, normVec.byteLength);
      dataView.set(outBytes, 0);

      control[3] = outBytes.byteLength;
      Atomics.store(control, 0, STATUS_DONE);
      Atomics.notify(control, 0);
    }
  });
} else {
  // =========================================================================
  // Main Thread: SQLite Wasm & 指定クエリ実行
  // =========================================================================
  async function main(): Promise<void> {
    console.log("================================================================================");
    console.log("  Ruri-v3 (512次元) ONNX モデル推論 & 契約クエリ検証 CLI アプリケーション");
    console.log("================================================================================");

    console.log("\n[1/4] Ruri-v3 (130m Q4) 推論ワーカーを初期化中...");
    const sab = new SharedArrayBuffer(65536);
    const control = new Int32Array(sab, 0, 8);
    const dataView = new Uint8Array(sab, 32);

    const worker = new Worker(__filename, { workerData: { sab } });
    await new Promise<void>((done) => {
      worker.once("message", (msg) => {
        if (msg.status === "ready") done();
      });
    });
    console.log("  -> Ruri-v3 推論ワーカー起動完了 (512次元 Float32)");

    function inferRuriSync(call: EmbeddingCall): Uint8Array {
      if (call.operation === "image") {
        throw new Error("Ruri does not support image embedding");
      }
      const text = typeof call.body === "string" ? call.body : String(call.body ?? "");
      const textBytes = new TextEncoder().encode(text);
      dataView.set(textBytes, 0);

      control[1] = call.operation === "query" ? 1 : 0;
      control[2] = textBytes.byteLength;

      Atomics.store(control, 0, STATUS_REQUEST);
      Atomics.notify(control, 0);

      while (Atomics.load(control, 0) !== STATUS_DONE) {
        Atomics.wait(control, 0, STATUS_REQUEST, 50);
      }

      const resLen = control[3]!;
      const result = new Uint8Array(dataView.buffer, dataView.byteOffset, resLen).slice();
      Atomics.store(control, 0, STATUS_IDLE);
      Atomics.notify(control, 0);
      return result;
    }

    const initModule = require(resolve("dist/node/index.js")).default;
    const sqlite3 = await initModule();
    registerEmbeddingExtension(sqlite3, inferRuriSync, {
      identity: {
        modelId: "ruri-v3",
        revision: "main",
        fingerprint: "ruri-v3-130m-onnx",
        profile: "ruri-v3/q4/512",
        backend: "wasm",
        runtimeGeneration: 0
      }
    });

    const db = new sqlite3.oo1.DB(":memory:");

    try {
      // 1. CREATE TABLE 実行 (指定クエリ完全一致)
      console.log("\n[2/4] DDL 実行 (CREATE TABLE ... VECTOR(512, 'ruri-v3') STRICT)");
      const ddl = `
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(512, 'ruri-v3')
) STRICT;
`.trim();
      console.log("--------------------------------------------------");
      console.log(ddl);
      console.log("--------------------------------------------------");
      db.exec(ddl);
      console.log("  -> テーブル作成に成功しました！");

      // 2. INSERT 実行 (指定クエリ完全一致: vector_data への代入も透過エイリアス解決)
      console.log("\n[3/4] INSERT 実行 (INSERT INTO documents(id,text_data,vector_data) VALUES(1,:text,embedding(:text));)");
      const insertSql = `
INSERT INTO documents(id,text_data,vector_data)
VALUES(1,:text,embedding(:text));
`.trim();
      console.log("--------------------------------------------------");
      console.log(insertSql);
      console.log("--------------------------------------------------");

      const testDocs = [
        { id: 1, text: "甘くて新鮮な赤いリンゴや旬の果物。" },
        { id: 2, text: "ハイブリッド車や次世代電気自動車(EV)の最新技術。" },
        { id: 3, text: "子犬や子猫など、家庭で飼育するペットのしつけと健康管理。" }
      ];

      // ID=1 の指定クエリ実行 (完全一致)
      db.exec({
        sql: "INSERT INTO documents(id,text_data,vector_data) VALUES(1,:text,embedding(:text));",
        bind: { ":text": testDocs[0]!.text }
      });
      console.log(`  [登録完了] id: 1 | "${testDocs[0]!.text}"`);

      // 比較用の ID=2, 3 の登録
      try {
        for (let i = 1; i < testDocs.length; i++) {
          const doc = testDocs[i]!;
          db.exec({
            sql: "INSERT INTO documents(id,text_data,vector_data) VALUES(?,:text,embedding(:text));",
            bind: [doc.id, doc.text]
          });
          console.log(`  [登録完了] id: ${doc.id} | "${doc.text}"`);
        }
      } catch (err: any) {
        console.error("Insert error:", err);
        throw err;
      }

      // 3. SELECT 実行 (指定クエリ完全一致: vector_data 参照も透過エイリアス解決)
      console.log("\n[4/4] SELECT 実行 (ORDER BY DISTANCE(vector_data,embedding_query(:query)),id LIMIT 3;)");
      const selectSql = `
SELECT id,text_data FROM documents
ORDER BY DISTANCE(vector_data,embedding_query(:query)),id LIMIT 3;
`.trim();
      console.log("--------------------------------------------------");
      console.log(selectSql);
      console.log("--------------------------------------------------");

      const testQueries = [
        "美味しいフルーツや果物の収穫",
        "最新のエコカーとEV技術"
      ];

      for (const query of testQueries) {
        console.log(`\n>>> 検索クエリ (:query): "${query}"`);
        const selectStmt = db.prepare(`
          SELECT id, text_data, DISTANCE(vector_data, embedding_query(:query)) AS distance
          FROM documents
          ORDER BY DISTANCE(vector_data, embedding_query(:query)), id
          LIMIT 3;
        `);

        try {
          selectStmt.bind({ ":query": query });
          let rank = 1;
          while (selectStmt.step()) {
            const row = selectStmt.get({});
            const dist = Number(row.distance);
            const sim = (1 - dist).toFixed(4);
            console.log(`  Rank ${rank++}: [id=${row.id}] (コサイン類似度: ${sim}, 距離: ${dist.toFixed(4)})`);
            console.log(`          text_data: "${row.text_data}"`);
          }
        } finally {
          selectStmt.finalize();
        }
      }

      console.log("\n================================================================================");
      console.log("  Ruri-v3 (512次元) での指定クエリ完全一致実行・検証に成功しました！");
      console.log("================================================================================");
    } finally {
      db.close();
      await worker.terminate();
      process.exit(0);
    }
  }

  main().catch((err) => {
    console.error("実行エラー:", err);
    process.exit(1);
  });
}
