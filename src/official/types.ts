import type { EmbeddingOptions, EnvironmentInfo } from "./options";
import type { ModelIdentity } from "./metadata";

/**
 * 処理名: SQLite 値型定義
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * 処理名: バインド仕様型定義
 */
export type BindingSpec = SqlValue | SqlValue[] | Record<string, SqlValue>;

/**
 * 処理名: プリペアドステートメントインターフェース
 */
export interface PreparedStatement {
  bind(val: BindingSpec): this;
  step(): boolean;
  stepReset(): this;
  get(output?: unknown[] | Record<string, unknown>): unknown;
  getFloat(index: number): number;
  getInt(index: number): number;
  getString(index: number): string;
  getBlob(index: number): Uint8Array;
  finalize(): void;
  reset(): this;
  columnCount: number;
  parameterCount: number;
}

/**
 * 処理名: データベース接続インターフェース
 */
export interface Database {
  exec(sql: string | { sql: string; bind?: BindingSpec }): this;
  selectValue(sql: string, bind?: BindingSpec): unknown;
  selectArray(sql: string, bind?: BindingSpec): unknown[];
  selectObject(sql: string, bind?: BindingSpec): Record<string, unknown> | undefined;
  prepare(sql: string): PreparedStatement;
  close(): void;
  isOpen(): boolean;
  filename?: string;
  readonly pointer?: number;
}

/**
 * 処理名: CAPI インターフェース
 */
export interface CAPI {
  sqlite3_open_v2(filename: string, ppDb: number, flags: number, vfsName: string | number): number;
  sqlite3_close_v2(pDb: number): number;
  sqlite3_prepare_v2(pDb: number, zSql: string, nByte: number, ppStmt: number, pzTail: number): number;
  sqlite3_step(pStmt: number): number;
  sqlite3_finalize(pStmt: number): number;
  sqlite3_reset(pStmt: number): number;
  sqlite3_bind_text(pStmt: number, index: number, val: string, nByte: number, xDel: number): number;
  sqlite3_bind_blob(pStmt: number, index: number, val: Uint8Array, nByte: number, xDel: number): number;
  sqlite3_column_text(pStmt: number, col: number): string;
  sqlite3_column_blob(pStmt: number, col: number): Uint8Array;
  sqlite3_create_function_v2(
    pDb: number,
    zFunctionName: string,
    nArg: number,
    eTextRep: number,
    pApp: number,
    xFunc: number,
    xStep: number,
    xFinal: number,
    xDestroy: number
  ): number;
  sqlite3_set_authorizer(pDb: number, xAuth: unknown, pUserData: unknown): number;
  sqlite3_trace_v2(pDb: number, uMask: number, xTrace: unknown, pCtx: unknown): number;
  sqlite3_auto_extension(xEntryPoint: unknown): number;
  [key: string]: unknown;
}

/**
 * 処理名: SQLite3 静的インターフェース
 */
export interface Sqlite3Static {
  capi: CAPI;
  wasm: {
    alloc(bytes: number): number;
    dealloc(ptr: number): void;
    peekPtr(ptr: number): number;
    sizeofIR(type: string): number;
    [key: string]: unknown;
  };
  oo1: {
    DB: {
      new (filename?: string | { filename: string; flags?: string }, flags?: string): Database;
    };
  };
  installOpfsSAHPoolVfs?: (options?: unknown) => Promise<{ pauseVfs(): void; removeVfs(): void }>;
  OpfsSAHPoolDb?: new (filename: string) => Database;
  [key: string]: unknown;
}

/**
 * 処理名: 埋め込み制御インターフェース
 */
export interface EmbeddingControl {
  close(): Promise<void>;
}

/**
 * 処理名: 製品拡張付き SQLite3 インターフェース
 */
export interface ProductSqlite3 extends Sqlite3Static {
  embedding: EmbeddingControl;
}

/**
 * 処理名: 製品初期化オプション
 */
export interface ProductInitOptions {
  print?: (...args: unknown[]) => void;
  printErr?: (...args: unknown[]) => void;
  embedding?: EmbeddingOptions;
  wasmBinary?: Uint8Array;
  locateFile?: (file: string) => string;
  [key: string]: unknown;
}

/**
 * 処理名: 公式ファクトリ関数型
 */
export type OfficialFactory = (options?: ProductInitOptions) => Promise<Sqlite3Static>;

/**
 * 処理名: 公式推論セッション型
 */
export interface OfficialInferenceSession {
  infer: (req: { operation: "query" | "document" | "image"; body?: string; title?: string; bytes?: Uint8Array; mime?: string; model?: string }) => Promise<Uint8Array | null> | Uint8Array | null;
  close: () => Promise<void>;
  identity: ModelIdentity;
  information: Record<string, unknown>;
}

/**
 * 処理名: 公式 worker1 promiser 関数型
 */
export type sqlite3Worker1Promiser = (options?: unknown) => (...args: unknown[]) => Promise<unknown>;
