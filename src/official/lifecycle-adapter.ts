import { VectorError } from "../errors";
import type { Sqlite3Static, Database } from "./types";
import { StatementLifecycle } from "../sqlite/statement-lifecycle";

/**
 * 処理名: 公式ライフサイクルアダプタークラス
 * 処理概要: 開かれたデータベース接続の追跡、ステートメント実行の監視、CAPI (step, reset, finalize, authorizer, progress_handler, trace_v2) の安全なフックと復元を行う。
 * 実装理由: 推論セッション終了時に DB が使用中である場合は安全に拒否し、リソースリークや再入不正を防ぐため。
 */
export class OfficialLifecycleAdapter {
  private readonly sqlite3: Sqlite3Static;
  private readonly openDatabases = new Set<Database>();
  private readonly lifecycle: StatementLifecycle;
  private readonly onCloseCallbacks: Array<(db: Database) => void> = [];

  // 元の CAPI 関数の退避
  private readonly origStep: any;
  private readonly origReset: any;
  private readonly origFinalize: any;
  private readonly origSetAuthorizer: any;
  private readonly origProgressHandler: any;
  private readonly origTraceV2: any;

  // ユーザー定義の authorizer および progress handler マップ (db ハンドル別)
  private readonly userAuthorizers = new Map<number, { fn: Function; arg: any }>();
  private readonly userProgressHandlers = new Map<number, { nOps: number; fn: Function; arg: any }>();
  private readonly lastInterruptReason = new Map<number, unknown>();

  private disposed = false;

  /**
   * 処理名: OfficialLifecycleAdapter コンストラクタ
   * 処理概要: SQLite 静的オブジェクトとライフサイクル管理を受け取り、CAPI をフックする。
   * 実装理由: ステートメント境界と権限保護を CAPI レベルで透過的に管理するため。
   * @param sqlite3 - 公式 SQLite3 静的インターフェース。
   * @param lifecycle - ステートメントライフサイクルマネージャー。
   * @param onClose - DB クローズ時コールバック。
   */
  constructor(
    sqlite3: Sqlite3Static,
    lifecycle?: StatementLifecycle,
    onClose?: (db: Database) => void
  ) {
    this.sqlite3 = sqlite3;
    this.lifecycle = lifecycle ?? ({} as StatementLifecycle);
    if (onClose) {
      this.onCloseCallbacks.push(onClose);
    }

    const capi = sqlite3.capi as any;

    this.origStep = capi.sqlite3_step;
    this.origReset = capi.sqlite3_reset;
    this.origFinalize = capi.sqlite3_finalize;
    this.origSetAuthorizer = capi.sqlite3_set_authorizer;
    this.origProgressHandler = capi.sqlite3_progress_handler;
    this.origTraceV2 = capi.sqlite3_trace_v2;

    this.installCapiHooks();
  }

  /**
   * 処理名: CAPI フックのインストール
   * 処理概要: step, reset, finalize, authorizer, progress_handler, trace_v2 をインターセプトする。
   * 実装理由: ステートメントキャッシュ境界の維持と _svw_ メタデータ保護、および引数互換性を保証するため。
   */
  private installCapiHooks(): void {
    const capi = this.sqlite3.capi as any;
    const adapter = this;

    // sqlite3_step
    capi.sqlite3_step = function (pStmt: number) {
      const pDb = capi.sqlite3_db_handle(pStmt);
      const dbPtr = typeof pDb === "number" ? pDb : (pDb?.pointer ?? pDb);
      adapter.lastInterruptReason.delete(dbPtr);

      if (typeof adapter.lifecycle.enter === "function") {
        adapter.lifecycle.enter(pDb, pStmt);
      }
      try {
        const res = adapter.origStep.call(capi, pStmt);
        if (typeof adapter.lifecycle.leave === "function") {
          adapter.lifecycle.leave(pStmt, res);
        }
        if (res === 9 /* SQLITE_INTERRUPT */ || res === capi.SQLITE_INTERRUPT) {
          const reason = adapter.lastInterruptReason.get(dbPtr);
          if (reason) {
            adapter.lastInterruptReason.delete(dbPtr);
            if (typeof adapter.lifecycle.reset === "function") {
              adapter.lifecycle.reset(pStmt);
            }
            throw reason;
          }
        }
        return res;
      } catch (err) {
        if (typeof adapter.lifecycle.reset === "function") {
          adapter.lifecycle.reset(pStmt);
        }
        throw err;
      }
    };

    // sqlite3_reset
    capi.sqlite3_reset = function (pStmt: number) {
      if (typeof adapter.lifecycle.reset === "function") {
        adapter.lifecycle.reset(pStmt);
      }
      return adapter.origReset.call(capi, pStmt);
    };

    // sqlite3_finalize
    capi.sqlite3_finalize = function (pStmt: number) {
      if (typeof adapter.lifecycle.reset === "function") {
        adapter.lifecycle.reset(pStmt);
      }
      return adapter.origFinalize.call(capi, pStmt);
    };

    // sqlite3_set_authorizer
    capi.sqlite3_set_authorizer = function (pDb: any, xAuth: any, pUserData: any) {
      const dbPtr = typeof pDb === "number" ? pDb : (pDb?.pointer ?? pDb);
      if (xAuth) {
        adapter.userAuthorizers.set(dbPtr, { fn: xAuth, arg: pUserData });
      } else {
        adapter.userAuthorizers.delete(dbPtr);
      }
      return adapter.applyAuthorizer(pDb);
    };

    // sqlite3_progress_handler
    capi.sqlite3_progress_handler = function (pDb: any, nOps: number, xHandler: any, pUserData: any) {
      const dbPtr = typeof pDb === "number" ? pDb : (pDb?.pointer ?? pDb);
      if (xHandler && nOps > 0) {
        adapter.userProgressHandlers.set(dbPtr, { nOps, fn: xHandler, arg: pUserData });
      } else {
        adapter.userProgressHandlers.delete(dbPtr);
      }
      return adapter.applyProgressHandler(pDb);
    };

    // sqlite3_trace_v2 (第4引数省略時互換および DB オブジェクト展開)
    if (typeof this.origTraceV2 === "function") {
      capi.sqlite3_trace_v2 = function (pDb: any, uMask: number, xCallback: any, pCtx: any = 0) {
        const dbPtr = typeof pDb === "number" ? pDb : (pDb?.pointer ?? pDb);
        return adapter.origTraceV2.call(capi, dbPtr, uMask, xCallback, pCtx ?? 0);
      };
    }
  }

  /**
   * 処理名: 合成 authorizer の適用
   * 処理概要: _svw_ メタデータ保護とユーザー定義 authorizer を合成して設定する。
   * 実装理由: 内部メタデータの改変を拒絶しつつユーザー側のセキュリティポリシーを両立するため。
   * @param db - 対象データベース。
   */
  public applyAuthorizer(db: any): number {
    const capi = this.sqlite3.capi as any;
    const dbPtr = typeof db === "number" ? db : (db?.pointer ?? db);
    const userAuth = this.userAuthorizers.get(dbPtr);

    const SQLITE_OK = capi.SQLITE_OK ?? 0;
    const SQLITE_DENY = capi.SQLITE_DENY ?? 1;
    const SQLITE_READ = capi.SQLITE_READ ?? 20;

    const compositeAuth = (arg: any, action: number, p3: any, p4: any, p5: any, p6: any) => {
      const targetName = typeof p3 === "string" ? p3 : (typeof p4 === "string" ? p4 : "");
      const isInternal = targetName.startsWith("_svw_");

      if (isInternal) {
        if (action === SQLITE_READ) {
          if (userAuth) {
            return userAuth.fn(userAuth.arg, action, p3, p4, p5, p6);
          }
          return SQLITE_OK;
        }
        // _svw_ への変更・書き込み・削除は常に拒絶
        return SQLITE_DENY;
      }

      if (userAuth) {
        return userAuth.fn(userAuth.arg, action, p3, p4, p5, p6);
      }
      return SQLITE_OK;
    };

    return this.origSetAuthorizer.call(capi, db, compositeAuth, 0);
  }

  /**
   * 処理名: 合成 progress handler の適用
   * 処理概要: 100 命令周期の内部ライフサイクル期限検査とユーザー進捗ハンドラを合成する。
   * 実装理由: 長時間実行やキャンセルの安全な中断とユーザー通知を両立するため。
   * @param db - 対象データベース。
   */
  public applyProgressHandler(db: any): number {
    const capi = this.sqlite3.capi as any;
    const dbPtr = typeof db === "number" ? db : (db?.pointer ?? db);
    const userHandler = this.userProgressHandlers.get(dbPtr);
    const nOps = userHandler ? Math.min(userHandler.nOps, 100) : 100;

    const compositeProgress = (arg: any) => {
      if (typeof this.lifecycle.current === "function") {
        try {
          this.lifecycle.current();
        } catch (err) {
          this.lastInterruptReason.set(dbPtr, err);
          return 1; // 中断
        }
      }
      if (userHandler) {
        const userRes = userHandler.fn(userHandler.arg);
        if (userRes !== 0) {
          this.lastInterruptReason.set(dbPtr, new VectorError("E_CANCELLED"));
          return 1;
        }
      }
      return 0;
    };

    return this.origProgressHandler.call(capi, db, nOps, compositeProgress, 0);
  }

  /**
   * 処理名: データベース接続監視開始
   * 処理概要: DB インスタンスの close メソッドをフックし、接続のオープン・クローズ状態を追跡する。
   * @param db - 対象データベース接続。
   */
  public observe(db: Database): void {
    if (this.disposed) return;
    this.openDatabases.add(db);

    this.applyAuthorizer(db);
    this.applyProgressHandler(db);

    const originalClose = db.close.bind(db);
    db.close = () => {
      this.openDatabases.delete(db);
      for (const cb of this.onCloseCallbacks) {
        try {
          cb(db);
        } catch {
          // 無視
        }
      }
      return originalClose();
    };
  }

  /**
   * 処理名: クローズ状態アサート
   * 処理概要: まだオープン中のデータベース接続が存在する場合は E_DB_IN_USE エラーを投げる。
   */
  public assertClosed(): void {
    if (this.openDatabases.size > 0) {
      throw new VectorError("E_DB_IN_USE");
    }
  }

  /**
   * 処理名: 追跡中のデータベース数取得
   */
  public get activeCount(): number {
    return this.openDatabases.size;
  }

  /**
   * 処理名: ライフサイクルアダプター破棄
   * 処理概要: フックした CAPI を元通りに復元し、追跡状態をリセットする。
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const capi = this.sqlite3.capi as any;
    capi.sqlite3_step = this.origStep;
    capi.sqlite3_reset = this.origReset;
    capi.sqlite3_finalize = this.origFinalize;
    capi.sqlite3_set_authorizer = this.origSetAuthorizer;
    capi.sqlite3_progress_handler = this.origProgressHandler;
    if (typeof this.origTraceV2 === "function") {
      capi.sqlite3_trace_v2 = this.origTraceV2;
    }

    this.openDatabases.clear();
    this.userAuthorizers.clear();
    this.userProgressHandlers.clear();
  }
}
