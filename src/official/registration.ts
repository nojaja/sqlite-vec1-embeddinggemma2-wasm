import { VectorError } from "../errors";
import { embeddingSqlValue } from "./functions";
import { StatementLifecycle } from "../sqlite/statement-lifecycle";
import { officialMetadataRecord, validateOfficialMetadata } from "./metadata";
import { interceptAndTransformSql, type VectorColumnMetadata } from "./vector-metadata";
import type { EmbeddingControl, Sqlite3Static } from "./types";
import type { EmbeddingCall, EmbeddingCacheIdentity, EmbeddingInference } from "../inference/statement-embedding-cache";

/**
 * 処理名: 登録オプション型
 * 処理概要: 埋め込み拡張登録時の同一性、タイムアウト、メタ情報、チェック関数を定義する。
 * 実装理由: 拡張機能の登録オプションを柔軟に指定可能にするため。
 */
export interface RegistrationOptions {
  identity?: EmbeddingCacheIdentity | undefined;
  timeoutMs?: number | undefined;
  information?: Record<string, unknown> | undefined;
  check?: (() => void) | undefined;
}

const DEFAULT_IDENTITY: EmbeddingCacheIdentity = {
  modelId: "embeddinggemma-2",
  revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  fingerprint: "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
  profile: "embeddinggemma-2/q4/768",
  backend: "wasm",
  runtimeGeneration: 0
};

/**
 * 処理名: DB実行状態インターフェース
 * 処理概要: DBごとのタイムアウトおよびキャンセル発生フラグを管理する。
 * 実装理由: 進捗ハンドラとステートメントステップ間でキャンセル状態を伝播させるため。
 */
interface DbExecutionState {
  timedOut: boolean;
  cancelled: boolean;
  userCancelled: boolean;
}

/**
 * 処理名: ユーザーオーソライザー情報
 * 処理概要: ユーザー定義の認可コールバック関数とアプリポインタを保持する。
 * 実装理由: 拡張機能内部の認可チェックとユーザー認可チェックを合成するため。
 */
interface UserAuthorizerEntry {
  cb: (pApp: unknown, action: number, a1: unknown, a2: unknown, dbName: unknown, triggerName: unknown) => number;
  pApp: unknown;
}

/**
 * 処理名: ユーザープログレスハンドラ情報
 * 処理概要: ユーザー定義の進捗コールバックとオペレーション間隔を保持する。
 * 実装理由: 内部タイムアウト監視とユーザー定義進捗処理を両立するため。
 */
interface UserProgressEntry {
  nOp: number;
  cb: (pApp: unknown) => unknown;
  pApp: unknown;
}

/**
 * 処理名: 登録可能データベースインターフェース
 * 処理概要: UDF登録、クエリ実行、単一値選択機能を提供する。
 * 実装理由: 各種DB操作メソッドへのアクセスを型安全に行うため。
 */
interface RegistrableDb {
  createFunction?: (name: string, fn: (ctx: unknown, ...args: unknown[]) => unknown, opts?: Record<string, unknown>) => void;
  selectValue?: (sql: string) => unknown;
  exec?: (query: unknown) => unknown;
}

/**
 * 処理名: ライフサイクルキャンセル検証
 * 処理概要: 実行中ステートメントのタイムアウトまたはキャンセル共有バッファを確認する。
 * 実装理由: 長時間クエリを早期に中断するため。
 * @param lifecycle ステートメントライフサイクルマネージャ。
 * @param state DB実行状態。
 * @returns 中断すべき場合true。
 */
function checkLifecycleCancellation(lifecycle: StatementLifecycle, state: DbExecutionState): boolean {
  if (!lifecycle.hasActiveStep()) return false;
  try {
    const current = lifecycle.current();
    if (performance.now() >= current.deadline) {
      state.timedOut = true;
      return true;
    }
    if (current.cancelled || Atomics.load(new Int32Array(current.cancellationBuffer), 0) !== 0) {
      state.cancelled = true;
      return true;
    }
  } catch {
    state.timedOut = true;
    return true;
  }
  return false;
}

/**
 * 処理名: ユーザー進捗ハンドラ実行確認
 * 処理概要: ユーザー定義の進捗コールバックを実行し中断指示を検出する。
 * 実装理由: ユーザーからの明示的なクエリ中断要求を反映するため。
 * @param user ユーザー進捗設定エントリ。
 * @param state DB実行状態。
 * @returns ユーザーが中断を指示した場合true。
 */
function checkUserProgress(user: UserProgressEntry, state: DbExecutionState): boolean {
  try {
    const res = user.cb(user.pApp);
    if (res !== 0 && res !== undefined && res !== null && res !== false) {
      state.userCancelled = true;
      return true;
    }
  } catch {
    state.userCancelled = true;
    return true;
  }
  return false;
}

/**
 * 処理名: コサイン距離計算
 * 処理概要: 2つのFloat32ベクトルBLOB間のコサイン距離 (1 - cos) を計算する。
 * 実装理由: SQL UDF DISTANCE(v1, v2) を高速かつ厳密に計算するため。
 * @param left 第1ベクトルBLOB。
 * @param right 第2ベクトルBLOB。
 * @returns コサイン距離（0.0〜2.0）。
 */
function computeCosineDistance(left: Uint8Array, right: Uint8Array): number {
  if (left.byteLength !== right.byteLength || left.byteLength % 4 !== 0 || left.byteLength === 0) {
    throw new VectorError("E_INPUT");
  }
  const dim = left.byteLength / 4;
  const v1 = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const v2 = new DataView(right.buffer, right.byteOffset, right.byteLength);
  let dot = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < dim; i++) {
    const f1 = Number(v1.getFloat32(i * 4, true));
    const f2 = Number(v2.getFloat32(i * 4, true));
    if (!Number.isFinite(f1) || !Number.isFinite(f2)) {
      throw new VectorError("E_INPUT");
    }
    dot += f1 * f2;
    s1 += f1 * f1;
    s2 += f2 * f2;
  }
  const n1 = Math.sqrt(s1);
  const n2 = Math.sqrt(s2);
  if (!Number.isFinite(n1) || !Number.isFinite(n2) || n1 <= 0 || n2 <= 0) {
    throw new VectorError("E_INPUT");
  }
  const cos = dot / (n1 * n2);
  return Math.max(0, Math.min(2, 1 - cos));
}

/**
 * 処理名: 埋め込みUDF関数群登録
 * 処理概要: embedding, embedding_query, gemma_embed_query/doc/image をDBに登録する。
 * 実装理由: SQL文から直接呼び出せる埋め込み計算UDFを提供するため。
 * @param db データベースインスタンス。
 * @param getInfer 推論関数リゾルバ。
 * @param onCall 呼び出しカウンタインクリメント関数。
 */
function registerUdfFunctions(
  db: RegistrableDb,
  getInfer: () => EmbeddingInference | undefined,
  onCall: () => void
): void {
  /**
   * 処理名: 単一UDF登録ヘルパー
   * 処理概要: 指定名・引数個数でUDF関数をDBインスタンスに登録する。
   * 実装理由: UDF登録の定型処理を共通化するため。
   * @param name 関数名。
   * @param arity 引数の個数。
   * @param fn 実行関数。
   */
  function create(name: string, arity: number, fn: (...args: unknown[]) => unknown): void {
    if (typeof db.createFunction === "function") {
      db.createFunction(name, (_pCtx: unknown, ...args: unknown[]) => fn(...args), { arity, directOnly: true });
    }
  }

  create("embedding", 1, (text: unknown) => {
    onCall();
    return embeddingSqlValue("embedding", [text], getInfer());
  });
  create("embedding", 2, (text: unknown, model: unknown) => {
    onCall();
    return embeddingSqlValue("embedding", [text, model], getInfer());
  });
  create("embedding_query", 1, (text: unknown) => {
    onCall();
    return embeddingSqlValue("embedding_query", [text], getInfer());
  });
  create("embedding_query", 2, (text: unknown, model: unknown) => {
    onCall();
    return embeddingSqlValue("embedding_query", [text, model], getInfer());
  });
  create("gemma_embed_query", 1, (text: unknown) => {
    onCall();
    return embeddingSqlValue("gemma_embed_query", [text], getInfer());
  });
  create("gemma_embed_query", 2, (text: unknown, title: unknown) => {
    onCall();
    return embeddingSqlValue("gemma_embed_query", [text, title], getInfer());
  });
  create("gemma_embed_document", 1, (text: unknown) => {
    onCall();
    return embeddingSqlValue("gemma_embed_document", [text], getInfer());
  });
  create("gemma_embed_document", 2, (text: unknown, title: unknown) => {
    onCall();
    return embeddingSqlValue("gemma_embed_document", [text, title], getInfer());
  });
  create("gemma_embed_image", 2, (bytes: unknown, mime: unknown) => {
    onCall();
    return embeddingSqlValue("gemma_embed_image", [bytes, mime], getInfer());
  });
}

/**
 * 処理名: モデル情報関数登録
 * 処理概要: gemma_model_info UDFをデータベースインスタンスに登録する。
 * 実装理由: モデル名、キャッシュ統計、推論状態のJSON取得を可能にするため。
 * @param db データベースインスタンス。
 * @param lifecycle ステートメントライフサイクル。
 * @param identity キャッシュ識別情報。
 * @param infer 推論関数。
 * @param getFunctionCalls 呼出し回数取得関数。
 * @param extraInfo 追加メタデータ。
 */
function registerModelInfoFunction(
  db: RegistrableDb,
  lifecycle: StatementLifecycle,
  identity: EmbeddingCacheIdentity,
  infer: EmbeddingInference | undefined,
  getFunctionCalls: () => number,
  extraInfo?: Record<string, unknown>
): void {
  if (typeof db.createFunction !== "function") return;
  db.createFunction("gemma_model_info", () => {
    const stats = lifecycle.statistics();
    const ready = !!infer;
    const cacheObj = {
      hit: stats.hit,
      miss: stats.miss,
      eviction: stats.eviction,
      actualInference: stats.actualInference,
      entries: stats.entries,
      bytes: stats.bytes
    };
    const baseInfo: Record<string, unknown> = {
      ready,
      model: "embeddinggemma-2",
      functionCalls: getFunctionCalls(),
      cache: cacheObj,
      ...cacheObj
    };
    if (ready) {
      baseInfo.modelId = "google/embeddinggemma-2";
      baseInfo.revision = identity.revision;
      baseInfo.fingerprint = identity.fingerprint;
      baseInfo.dtype = "q4";
      baseInfo.dimension = 768;
      baseInfo.backend = identity.backend;
      baseInfo.profile = identity.profile;
      if (extraInfo) {
        Object.assign(baseInfo, extraInfo);
      }
    }
    return JSON.stringify(baseInfo);
  }, { arity: 0, directOnly: true });
}

/**
 * 処理名: DBメタデータ初期化および検証
 * 処理概要: _svw_meta テーブルを作成・照合してモデルバインドの一貫性を検証する。
 * 実装理由: 異なるモデルで作成されたDBへの誤接続を防止するため。
 * @param db データベースインスタンス。
 * @param identity キャッシュ識別情報。
 * @param infer 推論関数。
 */
function initDbMetadata(
  db: RegistrableDb,
  identity: EmbeddingCacheIdentity,
  infer: EmbeddingInference | undefined
): void {
  if (!infer || typeof db.selectValue !== "function" || typeof db.exec !== "function") return;
  try {
    const hasMeta = db.selectValue("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_svw_meta'");
    if (!hasMeta) {
      const userTableCount = db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'");
      if (Number(userTableCount) > 0) {
        throw new VectorError("E_MODEL_UNBOUND");
      }
      db.exec("CREATE TABLE _svw_meta(id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL) STRICT");
      const record = officialMetadataRecord(identity);
      db.exec({
        sql: "INSERT INTO _svw_meta(id, metadata) VALUES(1, ?)",
        bind: [JSON.stringify(record)]
      });
    } else {
      const raw = db.selectValue("SELECT metadata FROM _svw_meta WHERE id=1");
      if (!raw) throw new VectorError("E_MODEL_MISMATCH");
      const parsed = JSON.parse(String(raw));
      validateOfficialMetadata(parsed, identity);
    }
  } catch (e: unknown) {
    if (e instanceof VectorError) throw e;
  }
}

/**
 * 処理名: 埋め込み拡張登録
 * 処理概要: SQLite Wasmランタイムにベクトル埋め込みUDF、ライフサイクル管理、および透過DDL変換を登録する。
 * 実装理由: 公式SQLite Wasm上で透過的なベクトル推論・検索機能を提供するため。
 * @param sqlite3 SQLite3静的ランタイムオブジェクト。
 * @param infer 埋め込み推論関数。
 * @param options 登録オプション。
 * @returns 埋め込み制御オブジェクト。
 */
export function registerEmbeddingExtension(
  sqlite3: Sqlite3Static,
  infer?: EmbeddingInference,
  options: RegistrationOptions = {}
): EmbeddingControl {
  const openDatabases = new Set<unknown>();
  let functionCalls = 0;
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const lifecycle = new StatementLifecycle(
    identity,
    options.timeoutMs ?? 120000,
    () => performance.now(),
    options.check
  );

  const capi = sqlite3.capi as Record<string, (...args: unknown[]) => unknown> & Record<string, number>;

  if (capi && typeof capi.sqlite3_trace_v2 === "function") {
    const origTrace = capi.sqlite3_trace_v2.bind(capi);

    /**
     * 処理名: ラップされたsqlite3_trace_v2
     * 処理概要: トレースコールバックを元のAPIに渡す。
     * 実装理由: トレース関数のシグネチャ互換性を維持するため。
     * @param pDb DBポインタ。
     * @param mask トレースマスク。
     * @param cb トレースコールバック。
     * @param pApp アプリポインタ。
     * @returns 実行結果。
     */
    function wrappedTraceV2(pDb: unknown, mask: unknown, cb: unknown, pApp?: unknown): unknown {
      return origTrace(pDb, mask, cb, pApp ?? 0);
    }
    capi.sqlite3_trace_v2 = wrappedTraceV2;
  }

  const userAuthorizers = new Map<unknown, UserAuthorizerEntry>();
  let origSetAuthorizer: ((...args: unknown[]) => unknown) | null = null;

  /**
   * 処理名: 複合認可ハンドラインストール
   * 処理概要: 内部メタデータテーブルへのアクセス禁止とユーザー定義認可を合成した認可ハンドラを設定する。
   * 実装理由: 内部管理テーブルの不正改ざんを防ぎつつユーザーのセキュリティポリシーを遵守するため。
   * @param dbTarget DBインスタンスまたはポインタ。
   */
  function installCompositeAuthorizer(dbTarget: unknown): void {
    if (!origSetAuthorizer) return;
    const targetObj = dbTarget as { pointer?: number } | null;
    const pDb = typeof targetObj?.pointer === "number" ? targetObj.pointer : dbTarget;

    /**
     * 処理名: 認可ハンドラコールバック
     * 処理概要: 内部テーブル保護およびユーザー認可ロジックを実行する。
     * 実装理由: 悪意あるクエリから保護しつつユーザー権限を適用するため。
     * @param _pApp アプリデータポインタ。
     * @param action SQLiteアクションコード。
     * @param a1 アクション引数1。
     * @param a2 アクション引数2。
     * @param dbName データベース名。
     * @param triggerName トリガー名。
     * @returns 認可結果コード。
     */
    function authorizerCallback(
      _pApp: unknown,
      action: number,
      a1: unknown,
      a2: unknown,
      dbName: unknown,
      triggerName: unknown
    ): number {
      const s1 = typeof a1 === "string" ? a1.toLowerCase() : "";
      const s2 = typeof a2 === "string" ? a2.toLowerCase() : "";
      if ((s1.includes("_svw_") || s2.includes("_svw_")) && action !== capi.SQLITE_READ) {
        return capi.SQLITE_DENY;
      }
      if (action === capi.SQLITE_PRAGMA && s1 === "writable_schema") {
        return capi.SQLITE_DENY;
      }
      const user = userAuthorizers.get(pDb) ?? userAuthorizers.get(dbTarget);
      if (user && typeof user.cb === "function") {
        return user.cb(user.pApp, action, a1, a2, dbName, triggerName);
      }
      return capi.SQLITE_OK;
    }

    origSetAuthorizer(pDb, authorizerCallback, 0);
  }

  if (capi && typeof capi.sqlite3_set_authorizer === "function") {
    origSetAuthorizer = capi.sqlite3_set_authorizer.bind(capi);

    /**
     * 処理名: ラップされたsqlite3_set_authorizer
     * 処理概要: ユーザー認可ハンドラを登録し複合認可ハンドラを有効化する。
     * 実装理由: ユーザーポリシーと内部セキュリティ制御を統合するため。
     * @param dbTarget DBインスタンスまたはポインタ。
     * @param userCb ユーザー認可コールバック。
     * @param pApp アプリポインタ。
     * @returns 成功コード。
     */
    function wrappedSetAuthorizer(dbTarget: unknown, userCb: unknown, pApp?: unknown): unknown {
      const targetObj = dbTarget as { pointer?: number } | null;
      const pDb = typeof targetObj?.pointer === "number" ? targetObj.pointer : dbTarget;
      if (typeof userCb === "function") {
        userAuthorizers.set(pDb, { cb: userCb as UserAuthorizerEntry["cb"], pApp });
      } else {
        userAuthorizers.delete(pDb);
      }
      installCompositeAuthorizer(dbTarget);
      return capi.SQLITE_OK;
    }
    capi.sqlite3_set_authorizer = wrappedSetAuthorizer;
  }

  const userProgressHandlers = new Map<number, UserProgressEntry>();
  let origProgressHandler: ((...args: unknown[]) => unknown) | null = null;
  const dbStates = new Map<number, DbExecutionState>();

  /**
   * 処理名: DB実行状態取得
   * 処理概要: DBポインタに対応する実行状態オブジェクトを取得または新規作成する。
   * 実装理由: 各DBのタイムアウト・キャンセル状態を追跡するため。
   * @param pDb DBポインタ。
   * @returns 実行状態オブジェクト。
   */
  function getDbState(pDb: number): DbExecutionState {
    let state = dbStates.get(pDb);
    if (!state) {
      state = { timedOut: false, cancelled: false, userCancelled: false };
      dbStates.set(pDb, state);
    }
    return state;
  }

  /**
   * 処理名: 複合進捗ハンドラインストール
   * 処理概要: タイムアウト監視とユーザー定義進捗ハンドラを統合したコールバックを登録する。
   * 実装理由: 推論実行中のタイムアウト・キャンセルを確実に行うため。
   * @param pDb DBポインタ。
   */
  function installCompositeProgressHandler(pDb: number): void {
    if (!origProgressHandler) return;
    const user = userProgressHandlers.get(pDb);
    const internalN = 50;
    const effectiveN = (user && user.nOp > 0) ? Math.min(user.nOp, internalN) : internalN;

    let opCounter = 0;

    /**
     * 処理名: 進捗ハンドラコールバック
     * 処理概要: 定期的なオプコード実行時にタイムアウトとユーザー進捗を検査する。
     * 実装理由: 長時間実行クエリの中断および進捗通知を実現するため。
     * @returns 中断時1、継続時0。
     */
    function progressCallback(): number {
      const state = getDbState(pDb);
      opCounter += effectiveN;

      if (checkLifecycleCancellation(lifecycle, state)) {
        return 1;
      }

      if (user && user.nOp > 0 && typeof user.cb === "function") {
        if (opCounter >= user.nOp) {
          opCounter = 0;
          if (checkUserProgress(user, state)) {
            return 1;
          }
        }
      }

      return 0;
    }

    origProgressHandler(pDb, effectiveN, progressCallback, 0);
  }

  if (capi && typeof capi.sqlite3_progress_handler === "function") {
    origProgressHandler = capi.sqlite3_progress_handler.bind(capi);

    /**
     * 処理名: ラップされたsqlite3_progress_handler
     * 処理概要: ユーザー進捗ハンドラを登録し複合進捗ハンドラを有効化する。
     * 実装理由: ユーザー進捗監視と内部タイムアウト監視を統合するため。
     * @param dbTarget DBインスタンスまたはポインタ。
     * @param nOp オペレーション間隔。
     * @param cb ユーザー進捗コールバック。
     * @param pApp アプリポインタ。
     */
    function wrappedProgressHandler(dbTarget: unknown, nOp: number, cb: unknown, pApp?: unknown): void {
      const targetObj = dbTarget as { pointer?: number } | null;
      const pDb = typeof targetObj?.pointer === "number" ? targetObj.pointer : Number(dbTarget);
      if (nOp > 0 && typeof cb === "function") {
        userProgressHandlers.set(pDb, { nOp, cb: cb as UserProgressEntry["cb"], pApp: pApp ?? 0 });
      } else {
        userProgressHandlers.delete(pDb);
      }
      installCompositeProgressHandler(pDb);
    }
    capi.sqlite3_progress_handler = wrappedProgressHandler;
  }

  let origStep: ((pStmt: number) => number) | null = null;
  let origReset: ((pStmt: number) => number) | null = null;
  let origFinalize: ((pStmt: number) => number) | null = null;

  if (capi && typeof capi.sqlite3_step === "function") {
    origStep = capi.sqlite3_step.bind(capi) as (pStmt: number) => number;
    origReset = capi.sqlite3_reset.bind(capi) as (pStmt: number) => number;
    origFinalize = capi.sqlite3_finalize.bind(capi) as (pStmt: number) => number;

    /**
     * 処理名: ラップされたsqlite3_step
     * 処理概要: ステートメント実行時にライフサイクル進入・退出およびタイムアウト検査を行う。
     * 実装理由: 実行時タイムアウトおよびキャッシュ境界を管理するため。
     * @param pStmt ステートメントポインタ。
     * @returns 実行結果コード。
     */
    function wrappedStep(pStmt: number): number {
      const pDb = Number(capi.sqlite3_db_handle(pStmt));
      lifecycle.enter(pDb, pStmt);
      let rc = 1;
      let stepErr: unknown = null;
      try {
        rc = origStep!(pStmt);
      } catch (err: unknown) {
        stepErr = err;
      }
      const state = dbStates.get(pDb);
      if (state?.timedOut) {
        state.timedOut = false;
        lifecycle.leave(pStmt, 1);
        throw new VectorError("E_TIMEOUT");
      }
      if (state?.cancelled || state?.userCancelled) {
        state.cancelled = false;
        state.userCancelled = false;
        lifecycle.leave(pStmt, 1);
        throw new VectorError("E_CANCELLED");
      }
      if (stepErr) {
        lifecycle.leave(pStmt, 1);
        throw stepErr;
      }
      lifecycle.leave(pStmt, rc);
      return rc;
    }
    capi.sqlite3_step = wrappedStep;

    /**
     * 処理名: ラップされたsqlite3_reset
     * 処理概要: ステートメントリセット時にライフサイクルをリセットする。
     * 実装理由: ステートメント再利用時の状態整合性を保つため。
     * @param pStmt ステートメントポインタ。
     * @returns 実行結果コード。
     */
    function wrappedReset(pStmt: number): number {
      lifecycle.reset(pStmt);
      return origReset!(pStmt);
    }
    capi.sqlite3_reset = wrappedReset;

    /**
     * 処理名: ラップされたsqlite3_finalize
     * 処理概要: ステートメント終了時にライフサイクルをクリーンアップする。
     * 実装理由: ステートメント破棄時のリソース解放を行うため。
     * @param pStmt ステートメントポインタ。
     * @returns 実行結果コード。
     */
    function wrappedFinalize(pStmt: number): number {
      lifecycle.reset(pStmt);
      return origFinalize!(pStmt);
    }
    capi.sqlite3_finalize = wrappedFinalize;
  }

  const origDB = sqlite3.oo1.DB;
  let dbCounter = 1;

  /**
   * 処理名: DB個別関数およびメタデータ登録
   * 処理概要: 開かれたDBインスタンスに対してUDFおよびメタデータを登録する。
   * 実装理由: 各DBインスタンスでベクトル関数を利用可能にするため。
   * @param db DBインスタンス。
   */
  function registerFunctionsOnDb(db: RegistrableDb): void {
    /**
     * 処理名: 推論関数取得
     * 処理概要: 現在のステートメントキャッシュに紐づく推論関数、または基本推論関数を返す。
     * 実装理由: ステートメントスコープでのキャッシュ利用を実現するため。
     * @returns 推論関数、または未準備時undefined。
     */
    function getInfer(): EmbeddingInference | undefined {
      if (!infer) return undefined;
      const current = lifecycle.hasActiveStep() ? lifecycle.current() : null;
      return current ? (req: EmbeddingCall) => current.cache.resolve(req, infer) : infer;
    }

    /**
     * 処理名: 呼出しカウンタインクリメント
     * 処理概要: 関数呼び出し累計カウンタを1加算する。
     * 実装理由: 統計情報の精度を保つため。
     */
    function onCall(): void {
      functionCalls++;
    }

    /**
     * 処理名: 呼出し累計取得
     * 処理概要: 関数呼出し回数を取得する。
     * 実装理由: モデル情報JSONへ埋め込むため。
     * @returns 累計呼出し回数。
     */
    function getCalls(): number {
      return functionCalls;
    }

    registerUdfFunctions(db, getInfer, onCall);

    registerModelInfoFunction(
      db,
      lifecycle,
      identity,
      infer,
      getCalls,
      options.information
    );

    if (typeof db.createFunction === "function") {
      db.createFunction("DISTANCE", (_ctx: unknown, left: unknown, right: unknown) => {
        if (left === null || right === null) return null;
        if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
          throw new VectorError("E_INPUT");
        }
        return computeCosineDistance(left, right);
      }, { arity: 2, directOnly: true });
    }

    initDbMetadata(db, identity, infer);
    installCompositeAuthorizer(db);
  }

  /**
   * 処理名: ラップされたDBコンストラクタ
   * 処理概要: DB生成時にライフサイクル追跡、関数登録、DDL変換インターセプトを組み込む。
   * 実装理由: ユーザーが生成した全DBインスタンスを透過的に拡張するため。
   * @param args コンストラクタ引数。
   * @returns 拡張されたDBインスタンス。
   */
  function WrappedDB(this: unknown, ...args: unknown[]): unknown {
    const db = new (origDB as unknown as new (...a: unknown[]) => Record<string, unknown>)(...args);
    const dbId = typeof db.pointer === "number" ? db.pointer : dbCounter++;
    openDatabases.add(db);

    const tableMetadata: Record<string, Record<string, VectorColumnMetadata>> = {};

    const origExec = (db.exec as (...a: unknown[]) => unknown).bind(db);

    /**
     * 処理名: ラップされたexecメソッド
     * 処理概要: DDL内のVECTOR型定義を透過変換して元のexecを実行する。
     * 実装理由: SQLiteネイティブ互換なテーブル作成を支援するため。
     * @param optOrSql SQL文字列または実行オプション。
     * @param rest 追加引数。
     * @returns 実行結果。
     */
    function wrappedExec(optOrSql: unknown, ...rest: unknown[]): unknown {
      let target = optOrSql;
      if (typeof target === "string") {
        target = interceptAndTransformSql(target, tableMetadata);
      } else if (target && typeof (target as { sql?: unknown }).sql === "string") {
        target = { ...(target as Record<string, unknown>), sql: interceptAndTransformSql((target as { sql: string }).sql, tableMetadata) };
      }
      return origExec(target, ...rest);
    }
    db.exec = wrappedExec;

    const origPrepare = (db.prepare as (...a: unknown[]) => unknown).bind(db);

    /**
     * 処理名: ラップされたprepareメソッド
     * 処理概要: SQL文字列内のVECTOR型エイリアスを透過解決して元のprepareを実行する。
     * 実装理由: カラム名エイリアス互換性を維持するため。
     * @param sql SQL文字列。
     * @param rest 追加引数。
     * @returns ステートメントオブジェクト。
     */
    function wrappedPrepare(sql: unknown, ...rest: unknown[]): unknown {
      let target = sql;
      if (typeof target === "string") {
        target = interceptAndTransformSql(target, tableMetadata);
      }
      return origPrepare(target, ...rest);
    }
    db.prepare = wrappedPrepare;

    const origClose = (db.close as () => unknown).bind(db);

    /**
     * 処理名: ラップされたcloseメソッド
     * 処理概要: DBクローズ時にライフサイクル登録を解除する。
     * 実装理由: メモリリークを防止するため。
     * @returns 実行結果。
     */
    function wrappedClose(): unknown {
      openDatabases.delete(db);
      lifecycle.close(typeof db.pointer === "number" ? db.pointer : dbId);
      return origClose();
    }
    db.close = wrappedClose;

    try {
      registerFunctionsOnDb(db);
      if (typeof db.pointer === "number") {
        installCompositeProgressHandler(db.pointer);
      }
    } catch (err: unknown) {
      openDatabases.delete(db);
      try { origClose(); } catch {}
      throw err;
    }
    return db;
  }
  Object.setPrototypeOf(WrappedDB, origDB);
  (WrappedDB as unknown as { prototype: unknown }).prototype = (origDB as unknown as { prototype: unknown }).prototype;

  sqlite3.oo1.DB = WrappedDB as unknown as typeof sqlite3.oo1.DB;

  let closed = false;
  return {
    /**
     * 処理名: 拡張機能クローズ
     * 処理概要: パッチしたSQLite APIおよびコンストラクタを元に戻す。
     * 実装理由: 拡張機能を安全にアンインストールするため。
     * @returns 完了プロミス。
     */
    close: async (): Promise<void> => {
      if (closed) return;
      if (openDatabases.size > 0) {
        throw new VectorError("E_DB_IN_USE");
      }
      sqlite3.oo1.DB = origDB;
      if (origSetAuthorizer) capi.sqlite3_set_authorizer = origSetAuthorizer;
      if (origProgressHandler) capi.sqlite3_progress_handler = origProgressHandler;
      if (origStep) capi.sqlite3_step = origStep;
      if (origReset) capi.sqlite3_reset = origReset;
      if (origFinalize) capi.sqlite3_finalize = origFinalize;
      closed = true;
    }
  };
}
