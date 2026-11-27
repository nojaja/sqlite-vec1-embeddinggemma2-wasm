import initialize from "../official/browser";
import type { Database, EmbeddingOptions, ProductSqlite3 } from "../official/types";

/**
 * 処理名: DB Worker 初期化メッセージ型
 * 処理概要: メインスレッドから DB Owner Worker へ送られる初期化ペイロード。
 * 実装理由: Dedicated Worker 内で推論オプション付き初期化を行うため。
 */
interface DbWorkerInitMessage {
  kind: "initialize";
  embedding?: EmbeddingOptions;
}

/**
 * 処理名: DB Worker RPC メッセージ型
 * 処理概要: メインスレッドから DB Owner Worker へ送られる RPC 要求ペイロード。
 * 実装理由: open / exec / close / shutdown 等の非同期操作を識別・応答するため。
 */
interface DbWorkerRpcMessage {
  type: string;
  messageId?: string;
  args?: Record<string, unknown>;
}

const openDatabases = new Map<string, Database>();
let sqlite3Instance: ProductSqlite3 | null = null;
let dbIdCounter = 1;

/**
 * 処理名: エラーメッセージ抽出
 * 処理概要: 未知の例外オブジェクトから安全なエラーメッセージ文字列を抽出する。
 * 実装理由: RPC エラー応答としてメインスレッドへ原因を伝達するため。
 * @param err - 捕捉した例外。
 * @returns エラーメッセージ文字列。
 */
function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 処理名: 対象データベース解決
 * 処理概要: 指定された dbId または既定の先頭データベースインスタンスを取得する。
 * 実装理由: dbId を省略した公式 Worker1 互換呼び出しにも対応するため。
 * @param dbId - 対象 DB 識別子。
 * @returns 解決された Database インスタンス。
 */
function resolveDatabase(dbId: unknown): Database {
  if (typeof dbId === "string" && openDatabases.has(dbId)) {
    return openDatabases.get(dbId)!;
  }
  const first = openDatabases.values().next().value;
  if (!first) {
    throw new Error("E_DATABASE_NOT_OPEN");
  }
  return first;
}

/**
 * 処理名: データベースオープン処理
 * 処理概要: 指定されたファイル名および VFS（opfs-sahpool 等）で SQLite DB を開く。
 * 実装理由: Dedicated Worker 内で同期 UDF が利用可能な DB 接続を確立するため。
 * @param args - open RPC 引数。
 * @returns 割り当てられた dbId を含む結果オブジェクト。
 */
async function handleOpen(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!sqlite3Instance) {
    throw new Error("E_EMBEDDING_NOT_READY");
  }
  const filename = typeof args.filename === "string" ? args.filename : ":memory:";
  const vfs = typeof args.vfs === "string" ? args.vfs : undefined;
  let db: Database;

  if (vfs === "opfs-sahpool" && typeof sqlite3Instance.installOpfsSAHPoolVfs === "function") {
    const pool = await sqlite3Instance.installOpfsSAHPoolVfs({
      clearOnInit: false,
      preserveOnInitFailure: true
    });
    const PoolDb = (pool as { OpfsSAHPoolDb?: new (name: string) => Database }).OpfsSAHPoolDb;
    db = PoolDb ? new PoolDb(filename) : new sqlite3Instance.oo1.DB({ filename, vfs });
  } else {
    db = vfs ? new sqlite3Instance.oo1.DB({ filename, vfs }) : new sqlite3Instance.oo1.DB(filename);
  }

  const dbId = `db-${dbIdCounter++}`;
  openDatabases.set(dbId, db);
  return { dbId, filename };
}

/**
 * 処理名: SQL 実行処理
 * 処理概要: 指定された SQLite DB 上で SQL を実行し、結果行とカラム名を返却する。
 * 実装理由: embedding() / embedding_query() UDF を Worker 内で同期実行するため。
 * @param args - exec RPC 引数。
 * @returns 実行結果オブジェクト。
 */
function handleExec(args: Record<string, unknown>): Record<string, unknown> {
  const db = resolveDatabase(args.dbId);
  const sql = typeof args.sql === "string" ? args.sql : "";
  const resultRows = Array.isArray(args.resultRows) ? (args.resultRows as unknown[]) : [];
  const execOpts: Record<string, unknown> = {
    sql,
    rowMode: typeof args.rowMode === "string" ? args.rowMode : "array",
    resultRows
  };
  if (args.bind !== undefined) {
    execOpts.bind = args.bind;
  }
  if (Array.isArray(args.columnNames)) {
    execOpts.columnNames = args.columnNames;
  }
  db.exec(execOpts as Parameters<Database["exec"]>[0]);
  return {
    resultRows,
    columnNames: Array.isArray(args.columnNames) ? args.columnNames : undefined
  };
}

/**
 * 処理名: データベースクローズ処理
 * 処理概要: 指定された dbId の SQLite DB 接続を閉じる。
 * 実装理由: 接続リソースを明示的に解放するため。
 * @param args - close RPC 引数。
 * @returns クローズ結果オブジェクト。
 */
function handleClose(args: Record<string, unknown>): Record<string, unknown> {
  const targetId =
    typeof args.dbId === "string" ? args.dbId : openDatabases.keys().next().value;
  if (typeof targetId === "string") {
    const db = openDatabases.get(targetId);
    if (db) {
      db.close();
      openDatabases.delete(targetId);
    }
  }
  return { ok: true };
}

/**
 * 処理名: 推論状態取得処理
 * 処理概要: gemma_model_info() 相当の現在の推論・キャッシュ状態 JSON を取得する。
 * 実装理由: メインスレッドから推論エンジンの準備状態を診断可能にするため。
 * @param args - embedding-info RPC 引数。
 * @returns 状態オブジェクト。
 */
function handleEmbeddingInfo(args: Record<string, unknown>): Record<string, unknown> {
  if (!sqlite3Instance) {
    return { ready: false };
  }
  if (openDatabases.size > 0) {
    const db = resolveDatabase(args.dbId);
    const raw = db.selectValue("SELECT gemma_model_info()");
    if (typeof raw === "string") {
      return JSON.parse(raw) as Record<string, unknown>;
    }
  }
  return { ready: true };
}

/**
 * 処理名: Worker シャットダウン処理
 * 処理概要: 開いている全 DB 接続を閉じ、推論セッションを安全に終了する。
 * 実装理由: E_DB_IN_USE を防ぎつつ推論 Worker および SAH Pool をクリーンアップするため。
 * @returns 終了結果オブジェクト。
 */
async function handleShutdown(): Promise<Record<string, unknown>> {
  for (const [id, db] of openDatabases.entries()) {
    try {
      db.close();
    } finally {
      openDatabases.delete(id);
    }
  }
  if (sqlite3Instance) {
    await sqlite3Instance.embedding.close();
    sqlite3Instance = null;
  }
  return { ok: true };
}

/**
 * 処理名: RPC ディスパッチ処理
 * 処理概要: 受信した RPC 種別に応じて対応する DB 操作を実行する。
 * 実装理由: メインスレッドからの非同期メッセージ要求を統一的に処理するため。
 * @param msg - RPC メッセージ。
 * @returns 応答結果オブジェクト。
 */
async function dispatchRpc(msg: DbWorkerRpcMessage): Promise<Record<string, unknown>> {
  const args = msg.args ?? {};
  switch (msg.type) {
    case "open":
      return handleOpen(args);
    case "exec":
      return handleExec(args);
    case "close":
      return handleClose(args);
    case "embedding-info":
      return handleEmbeddingInfo(args);
    case "shutdown":
      return handleShutdown();
    default:
      throw new Error(`Unsupported RPC type: ${msg.type}`);
  }
}

/**
 * 処理名: Worker メッセージハンドラ
 * 処理概要: 初期化メッセージおよび RPC メッセージを受信し、結果をメインスレッドへ返信する。
 * 実装理由: Dedicated Worker としてメインスレッドとの非同期通信ループを維持するため。
 * @param event - MessageEvent。
 */
async function onWorkerMessage(event: MessageEvent<unknown>): Promise<void> {
  const data = event.data as Partial<DbWorkerInitMessage & DbWorkerRpcMessage> | undefined;
  if (!data) {
    return;
  }

  if (data.kind === "initialize") {
    try {
      sqlite3Instance = await initialize({ embedding: data.embedding });
      globalThis.postMessage({ kind: "ready" });
    } catch (err: unknown) {
      globalThis.postMessage({ kind: "failed", error: toErrorMessage(err) });
    }
    return;
  }

  if (typeof data.type === "string") {
    try {
      const result = await dispatchRpc(data as DbWorkerRpcMessage);
      globalThis.postMessage({
        type: data.type,
        messageId: data.messageId,
        result
      });
    } catch (err: unknown) {
      globalThis.postMessage({
        type: data.type,
        messageId: data.messageId,
        error: toErrorMessage(err)
      });
    }
  }
}

globalThis.addEventListener("message", (event) => {
  void onWorkerMessage(event);
});
