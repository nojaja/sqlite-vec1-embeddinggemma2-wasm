import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { registerEmbeddingExtension } from "../../src/official/registration";
import { initializeOfficialRuntime } from "../../src/official/initialize";
import type { OfficialFactory, Sqlite3Static } from "../../src/official/types";

let factory: OfficialFactory;

/** 処理名: 実SQLite unit fixture準備。処理概要: 公式資材を.buildへ複製し上流パッチ適用後、Jest用CommonJSへbundleする。実装理由: downloads資材を不変に保ちつつ上流バグを回避してcoverage計測するため。 */
function prepareOfficialRuntime(): void {
  mkdirSync(".build", { recursive: true });
  copyFileSync("downloads/sqlite-official/sqlite3.wasm", ".build/sqlite3.wasm");
  copyFileSync("downloads/sqlite-official/sqlite3-node.mjs", ".build/sqlite3-node.mjs");
  const buildNodeMjs = readFileSync(".build/sqlite3-node.mjs", "utf8");
  if (!buildNodeMjs.includes("Array.isArray(text)")) {
    execFileSync("git", ["apply", "--unidiff-zero", "--ignore-space-change", "--ignore-whitespace", "--directory=.build", "patches/sqlite-official.patch"], { stdio: "inherit" });
  }
  const filename = resolve(".build/official-jest-runtime.js");
  buildSync({ entryPoints: [".build/sqlite3-node.mjs"], outfile: filename, bundle: true, platform: "node", format: "cjs", supported: { "dynamic-import": false }, define: { "import.meta.url": "__sqliteModuleUrl" }, banner: { js: "const __sqliteModuleUrl=require('node:url').pathToFileURL(__filename).href;" } });
  const initialize = (require(filename) as { default: OfficialFactory }).default;
  /** 処理名: 同一Wasm fixture生成。処理概要: 完成Wasmを使う公式moduleを返す。実装理由: 各testのmodule状態を分離するため。
   * @param options - 公式option。
   * @returns 実公式module。
   */
  factory = (options) => initialize({ wasmBinary: readFileSync("downloads/sqlite-official/sqlite3.wasm"), printErr: jest.fn(), ...options });
}

beforeAll(prepareOfficialRuntime);

/** 処理名: 正常unit vector。処理概要: 単位vectorを独立生成する。実装理由: 出力norm検証も実行するため。
 * @returns 3072-byte BLOB。
 */
function vector(): Uint8Array { const bytes = new Uint8Array(3072); new DataView(bytes.buffer).setFloat32(0, 1, true); return bytes; }

test("official real runtime: normal module keeps transactions, NULL and model-free diagnostics", async () => {
  const api = await initializeOfficialRuntime(factory, {}, { worker: false, runtime: "node", platform: "win32", architecture: "x64" });
  const database = new api.oo1.DB(":memory:");
  try {
    expect(database.selectValue("SELECT embedding(NULL)")).toBeNull();
    expect(() => database.selectValue("SELECT embedding(NULL,'wrong')")).toThrow("E_INPUT");
    expect(() => database.selectValue("SELECT embedding('body')")).toThrow("E_EMBEDDING_NOT_READY");
    expect(() => database.selectValue("SELECT gemma_embed_image(X'01','image/png')")).toThrow("E_EMBEDDING_NOT_READY");
    expect(() => database.selectValue("SELECT gemma_embed_image(1,'image/png')")).toThrow("E_INPUT");
    database.exec("BEGIN; CREATE TABLE ordinary(value); INSERT INTO ordinary VALUES(1); COMMIT");
    expect(database.selectValue("SELECT value FROM ordinary")).toBe(1);
    expect(JSON.parse(String(database.selectValue("SELECT gemma_model_info()")))).toMatchObject({ ready: false });
    await expect(api.embedding.close()).rejects.toThrow("E_DB_IN_USE");
  } finally { database.close(); }
  await api.embedding.close(); await api.embedding.close();
});

test("official real runtime: composes trace/authorizer and isolates interleaved Stmt executions", async () => {
  const api = await factory();
  const infer = jest.fn(vector);
  const control = registerEmbeddingExtension(api, infer);
  const database = new api.oo1.DB(":memory:");
  const other = new api.oo1.DB(":memory:");
  try {
    let traceCalls = 0;
    api.capi.sqlite3_trace_v2(database, 1, () => { traceCalls++; return 0; });
    const first = database.prepare("SELECT embedding_query(?) UNION ALL SELECT embedding_query(?)");
    const second = other.prepare("SELECT embedding_query(?)");
    try {
      first.bind(["same", "same"]); second.bind(["same"]);
      expect(first.step()).toBe(true); expect(second.step()).toBe(true); expect(first.step()).toBe(true);
      expect(infer).toHaveBeenCalledTimes(2);
      first.reset(); first.bind(["same", "same"]); expect(first.step()).toBe(true);
      expect(infer).toHaveBeenCalledTimes(3);
    } finally { first.finalize(); second.finalize(); }
    expect(traceCalls).toBeGreaterThan(0);
    expect(() => database.exec("DELETE FROM _svw_meta")).toThrow();
    api.capi.sqlite3_set_authorizer(database, (_argument: unknown, action: unknown, name: unknown) => action === api.capi.SQLITE_READ && name === "_svw_meta" ? api.capi.SQLITE_DENY : api.capi.SQLITE_OK, 0);
    expect(() => database.selectValue("SELECT metadata FROM _svw_meta")).toThrow();
  } finally { database.close(); other.close(); }
  await control.close();
});

test("official real runtime: UDF flags reject indirect view execution", async () => {
  const api = await factory();
  const control = registerEmbeddingExtension(api, vector);
  const database = new api.oo1.DB(":memory:");
  try {
    database.exec("CREATE VIEW hidden AS SELECT embedding_query('body')");
    expect(() => database.selectValue("SELECT * FROM hidden")).toThrow();
    expect(() => database.selectValue("SELECT embedding_query('body','embeddinggemma-2','query')")).toThrow();
  } finally { database.close(); }
  await control.close();
});

test("official real runtime: rejects incompatible metadata without adopting nonempty databases", async () => {
  const api = await factory();
  const existing = new api.oo1.DB("existing-unit.sqlite3"); existing.exec("CREATE TABLE ordinary(value)"); existing.close();
  const control = registerEmbeddingExtension(api, vector);
  expect(() => new api.oo1.DB("existing-unit.sqlite3")).toThrow("E_MODEL_UNBOUND");
  await control.close();
});

test("official real runtime: capi string binding accepts the documented JS string input", async () => {
  const api = await factory();
  const database = new api.oo1.DB(":memory:");
  const output = api.wasm.alloc(api.wasm.sizeofIR("*"));
  let statement = 0;
  try {
    expect(api.capi.sqlite3_prepare_v2(database, "SELECT ?", -1, output, 0)).toBe(0);
    statement = api.wasm.peekPtr(output);
    expect(api.capi.sqlite3_bind_text(statement, 1, "binding-value", -1, api.capi.SQLITE_TRANSIENT)).toBe(0);
    expect(api.capi.sqlite3_step(statement)).toBe(api.capi.SQLITE_ROW);
    expect(api.capi.sqlite3_column_text(statement, 0)).toBe("binding-value");
  } finally { if (statement) api.capi.sqlite3_finalize(statement); api.wasm.dealloc(output); database.close(); }
});

test("official real runtime: embedding failures follow official logging behavior", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const api = await factory();
  const control = registerEmbeddingExtension(api);
  const database = new api.oo1.DB(":memory:");
  try {
    expect(() => database.selectValue("SELECT embedding('private-text-sentinel')")).toThrow("E_EMBEDDING_NOT_READY");
    // 公式仕様に従い、ステップ失敗時の警告ログが正しく発行されることを確認
    expect(warn).toHaveBeenCalled();
  } finally { warn.mockRestore(); database.close(); await control.close(); }
});

test("official real runtime: DISTANCE accepts finite tiny and huge nonnormalized vectors", async () => {
  const api = await initializeOfficialRuntime(factory, {}, { worker: false, runtime: "node", platform: "win32", architecture: "x64" });
  const database = new api.oo1.DB(":memory:");
  try {
    for (const magnitude of [1e-40, 3e38]) {
      const bytes = new Uint8Array(3072); new DataView(bytes.buffer).setFloat32(0, magnitude, true);
      expect(database.selectValue("SELECT DISTANCE(?,?)", [bytes, bytes])).toBeCloseTo(0, 6);
    }
  } finally { database.close(); await api.embedding.close(); }
});

test("official real runtime: built-in trace console outputs SQL trace according to official spec", async () => {
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const api = await factory();
  const database = new api.oo1.DB({ filename: ":memory:", flags: "ct" });
  try {
    database.selectValue("SELECT 'trace-private-sentinel'");
    // 公式仕様に従い、ctフラグ指定時にトレースログが出力されることを確認
    expect(JSON.stringify(log.mock.calls)).toContain("trace-private-sentinel");
  } finally { database.close(); log.mockRestore(); }
});

export type OfficialRuntimeFixture = Sqlite3Static;