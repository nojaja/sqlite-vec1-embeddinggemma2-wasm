import { VectorError } from "../errors";
import {
  StatementEmbeddingCache,
  type EmbeddingCacheIdentity,
  type StatementCacheCounters
} from "../inference/statement-embedding-cache";

/**
 * 処理名: ステートメント実行コンテキストインターフェース
 * 処理概要: 単一prepared statementの実行状態、世代、タイムアウト期限、キャッシュを保持する。
 * 実装理由: 文単位の推論キャッシュとキャンセル制御を管理するため。
 */
export interface StatementExecution {
  database: number;
  statement: number;
  generation: number;
  deadline: number;
  cancelled: boolean;
  cancellationBuffer: SharedArrayBuffer;
  cache: StatementEmbeddingCache;
}

/**
 * 処理名: StatementLifecycle
 * 処理概要: prepared statementの実行ライフサイクル（ROW継続、DONE/resetでの世代交代、タイムアウト・キャンセル管理）を統括する。
 * 実装理由: 複数文・複数DBのキャッシュ漏れを防ぎ、期限超過やキャンセルを確実に同期検出するため。
 */
export class StatementLifecycle {
  private readonly identity: EmbeddingCacheIdentity;
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private readonly health?: (() => void) | undefined;

  private currentExecution: StatementExecution | null = null;
  private activeStepStatement: number | null = null;
  private statementMap = new Map<number, StatementExecution>();
  private globalGeneration = 0;

  // 累積カウンター
  private accHit = 0;
  private accMiss = 0;
  private accEviction = 0;
  private accActualInference = 0;

  /**
   * 処理名: ライフサイクルマネージャー生成
   * 処理概要: モデル識別子、タイムアウト、クロック、健全性確認関数を保持して初期化する。
   * 実装理由: ステートメント実行管理の共通コンテキストを保持するため。
   * @param identity - モデルキャッシュ識別情報。
   * @param timeoutMs - タイムアウトミリ秒。
   * @param clock - 現在時刻取得関数。
   * @param health - 健全性確認コールバック。
   */
  public constructor(
    identity: EmbeddingCacheIdentity,
    timeoutMs: number,
    clock: () => number = () => performance.now(),
    health?: () => void
  ) {
    this.identity = identity;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.health = health;
  }

  /**
   * 処理名: ステートメント実行開始
   * 処理概要: ステートメントのステップ実行開始を記録し、実行コンテキストを返却する。
   * 実装理由: 実行コンテキストの世代管理とタイムアウトチェックを行うため。
   * @param database - データベースハンドルポインタ。
   * @param statement - ステートメントハンドルポインタ。
   * @returns ステートメント実行コンテキスト。
   */
  public enter(database: number, statement: number): StatementExecution {
    if (this.activeStepStatement !== null && this.activeStepStatement !== statement) {
      throw new VectorError("E_PROTOCOL");
    }

    const existing = this.statementMap.get(statement);
    if (existing) {
      if (this.clock() >= existing.deadline) {
        this.reset(statement);
        throw new VectorError("E_TIMEOUT");
      }
      this.activeStepStatement = statement;
      this.currentExecution = existing;
      return existing;
    }

    const deadline = this.clock() + this.timeoutMs;
    if (this.clock() >= deadline) {
      throw new VectorError("E_TIMEOUT");
    }

    this.globalGeneration++;
    const cancellationBuffer = new SharedArrayBuffer(4);
    const execution: StatementExecution = {
      database,
      statement,
      generation: this.globalGeneration,
      deadline,
      cancelled: false,
      cancellationBuffer,
      cache: null as unknown as StatementEmbeddingCache
    };

    /**
     * 処理名: 実行状態健全性チェック
     * 処理概要: キャンセルフラグ、タイムアウト期限、ステートメント生存を確認する。
     * 実装理由: キャッシュ参照時に実行中断を即座に検出するため。
     */
    const check = (): void => {
      if (this.health) {
        this.health();
      }
      if (execution.cancelled || Atomics.load(new Int32Array(execution.cancellationBuffer), 0) !== 0) {
        throw new VectorError("E_CANCELLED");
      }
      if (this.clock() >= execution.deadline) {
        throw new VectorError("E_TIMEOUT");
      }
      if (!this.statementMap.has(statement) || this.statementMap.get(statement) !== execution) {
        throw new VectorError("E_PROTOCOL");
      }
    };

    execution.cache = new StatementEmbeddingCache(
      { ...this.identity, runtimeGeneration: execution.generation },
      32 * 1024 * 1024,
      check
    );

    this.statementMap.set(statement, execution);
    this.activeStepStatement = statement;
    this.currentExecution = execution;
    return execution;
  }

  /**
   * 処理名: ステートメント実行終了
   * 処理概要: ステップ実行の完了を記録し、DONEやエラー時にコンテキストを解放する。
   * 実装理由: ROW以外のステータス時にキャッシュ世代を終了するため。
   * @param statement - ステートメントハンドルポインタ。
   * @param result - SQLiteステップ実行結果コード。
   */
  public leave(statement: number, result: number): void {
    if (this.activeStepStatement !== statement) {
      // 異なるstatementのPROFILEなどでrunningを消さない
      return;
    }

    this.activeStepStatement = null;
    this.currentExecution = null;

    if (result !== 100) {
      // SQLITE_ROW(100) 以外（DONE=101, ERROR等）はcacheを破棄して世代終了
      this.disposeExecution(statement);
    }
  }

  /**
   * 処理名: 現在実行コンテキスト取得
   * 処理概要: 現在ステップ実行中のステートメントコンテキストを取得して健全性を検証する。
   * 実装理由: UDF評価コンテキストから実行中ステートメント情報を取得するため。
   * @returns 現在のステートメント実行コンテキスト。
   */
  public current(): StatementExecution {
    if (!this.currentExecution || this.activeStepStatement === null) {
      throw new VectorError("E_PROTOCOL");
    }
    if (this.health) {
      this.health();
    }
    if (this.currentExecution.cancelled || Atomics.load(new Int32Array(this.currentExecution.cancellationBuffer), 0) !== 0) {
      throw new VectorError("E_CANCELLED");
    }
    if (this.clock() >= this.currentExecution.deadline) {
      throw new VectorError("E_TIMEOUT");
    }
    return this.currentExecution;
  }

  /**
   * 処理名: アクティブステップ実行判定
   * 処理概要: 現在ステップ実行中のステートメントが存在するかを判定する。
   * 実装理由: 排他制御状態を確認するため。
   * @returns アクティブなステップが存在する場合はtrue。
   */
  public hasActiveStep(): boolean {
    return this.activeStepStatement !== null;
  }

  /**
   * 処理名: 実行コンテキスト破棄
   * 処理概要: ステートメントのキャッシュを破棄し統計カウンターを累積する。
   * 実装理由: メモリリークを防ぎ統計を正しく集計するため。
   * @param statement - ステートメントハンドルポインタ。
   */
  private disposeExecution(statement: number): void {
    const exec = this.statementMap.get(statement);
    if (exec) {
      this.statementMap.delete(statement);
      const stats = exec.cache.statistics();
      this.accHit += stats.hit;
      this.accMiss += stats.miss;
      this.accEviction += stats.eviction;
      this.accActualInference += stats.actualInference;
      exec.cache.dispose();
      if (this.currentExecution === exec) {
        this.currentExecution = null;
        this.activeStepStatement = null;
      }
    }
  }

  /**
   * 処理名: ステートメントリセット
   * 処理概要: ステートメントのリセットを検知して実行コンテキストを破棄する。
   * 実装理由: リセット時にキャッシュを確実に破棄するため。
   * @param statement - ステートメントハンドルポインタ。
   */
  public reset(statement: number): void {
    this.disposeExecution(statement);
  }

  /**
   * 処理名: データベースクローズ通知
   * 処理概要: 対象データベースに属する全ステートメントの実行コンテキストを破棄する。
   * 実装理由: DB切断時のリソースを完全に解放するため。
   * @param database - データベースハンドルポインタ。
   */
  public close(database: number): void {
    for (const [stmt, exec] of Array.from(this.statementMap.entries())) {
      if (exec.database === database) {
        this.disposeExecution(stmt);
      }
    }
  }

  /**
   * 処理名: 実行中断キャンセル
   * 処理概要: 指定DBまたは全ステートメントのキャンセルフラグを立てキャッシュを破棄する。
   * 実装理由: ユーザーからのキャンセル要求を同期的に反映するため。
   * @param database - データベースハンドルポインタ（任意）。
   */
  public cancel(database?: number): void {
    for (const exec of this.statementMap.values()) {
      if (database === undefined || exec.database === database) {
        exec.cancelled = true;
        Atomics.store(new Int32Array(exec.cancellationBuffer), 0, 1);
        exec.cache.dispose();
      }
    }
  }

  /**
   * 処理名: キャッシュ統計情報集計
   * 処理概要: 累積統計と現在アクティブなコンテキストの統計を合算して返す。
   * 実装理由: キャッシュヒット率やメモリ使用量の計測情報を取得するため。
   * @returns 集計されたキャッシュ統計カウンタ。
   */
  public statistics(): StatementCacheCounters {
    let currentHit = this.accHit;
    let currentMiss = this.accMiss;
    let currentEviction = this.accEviction;
    let currentActual = this.accActualInference;
    let currentEntries = 0;
    let currentBytes = 0;

    for (const exec of this.statementMap.values()) {
      const stats = exec.cache.statistics();
      currentHit += stats.hit;
      currentMiss += stats.miss;
      currentEviction += stats.eviction;
      currentActual += stats.actualInference;
      currentEntries += stats.entries;
      currentBytes += stats.bytes;
    }

    return {
      hit: currentHit,
      miss: currentMiss,
      eviction: currentEviction,
      actualInference: currentActual,
      entries: currentEntries,
      bytes: currentBytes
    };
  }
}
