import { VectorError } from "../errors";
import { assertInferenceReady } from "../bridge/inference-health";
import {
  StatementEmbeddingCache,
  EmbeddingCacheIdentity,
  CacheCounters
} from "../inference/statement-embedding-cache";

/**
 * 処理名: ステートメント実行コンテキスト型
 * 処理概要: 単一ステートメント実行の世代、期限、キャンセルSAB、キャッシュを保持する。
 * 実装理由: SQLITE_ROW間のキャッシュ保持およびステートメント境界の完全分離を保証するため。
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
 * 処理名: StatementLifecycle クラス
 * 処理概要: ステートメントの step 開始 (enter)、結果終了 (leave)、リセット、破棄ライフサイクルを管理する。
 * 実装理由: 同期 SQLite ステートメント実行中のLRUキャッシュ寿命、期限、キャンセルを正確に追跡するため。
 */
export class StatementLifecycle {
  private readonly identity: EmbeddingCacheIdentity;
  private readonly timeoutMs: number;
  private readonly clock: () => number;
  private readonly health?: SharedArrayBuffer;

  private activeExecution: StatementExecution | null = null;
  private readonly stmtMap = new Map<number, StatementExecution>();
  private readonly dbMap = new Map<number, Set<number>>();
  private generationSeq = 0;

  private accumulatedHit = 0;
  private accumulatedMiss = 0;
  private accumulatedEviction = 0;
  private accumulatedActualInference = 0;

  /**
   * 処理名: StatementLifecycle コンストラクタ
   * 処理概要: キャッシュアイデンティティ、タイムアウト時間、クロック関数、ヘルスバッファを初期化する。
   * 実装理由: ステートメント実行ごとの期限計算およびヘルス監視を設定するため。
   * @param identity - モデル・ランタイムアイデンティティ。
   * @param timeoutMs - ステートメント実行タイムアウト (ミリ秒)。
   * @param clock - 単調時刻クロック関数 (既定: performance.now)。
   * @param health - 推論セッションヘルス共有バッファ (任意)。
   */
  constructor(
    identity: EmbeddingCacheIdentity,
    timeoutMs: number,
    clock: () => number = () => performance.now(),
    health?: SharedArrayBuffer
  ) {
    this.identity = identity;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.health = health;
  }

  /**
   * 処理名: アクティブステップ存在確認
   * 処理概要: 現在 step 実行中のステートメントコンテキストが存在するか判定する。
   * 実装理由: 再入防止および実行状態確認のため。
   * @returns アクティブステップ実行中なら true。
   */
  public hasActiveStep(): boolean {
    return this.activeExecution !== null;
  }

  /**
   * 処理名: ステップ開始 (enter)
   * 処理概要: ステートメント実行を開始し、ROW継続時は既存キャッシュ、新規時は新世代コンテキストを割り当てる。
   * 実装理由: ステートメント間・接続間のキャッシュ混同を排除し、期限切れを検査するため。
   * @param database - データベースポインタ。
   * @param statement - ステートメントポインタ。
   * @returns 有効な StatementExecution。
   */
  public enter(database: number, statement: number): StatementExecution {
    if (this.activeExecution !== null && this.activeExecution.statement !== statement) {
      throw new VectorError("E_PROTOCOL");
    }

    const existing = this.stmtMap.get(statement);
    if (existing) {
      if (this.health) {
        assertInferenceReady(this.health);
      }
      if (existing.cancelled) {
        throw new VectorError("E_CANCELLED");
      }
      if (this.clock() >= existing.deadline) {
        this.reset(statement);
        throw new VectorError("E_TIMEOUT");
      }
      this.activeExecution = existing;
      return existing;
    }

    // 新規実行世代の開始
    this.generationSeq++;
    const generation = this.generationSeq;
    const now = this.clock();
    const deadline = now + this.timeoutMs;
    if (now >= deadline) {
      throw new VectorError("E_TIMEOUT");
    }
    if (this.health) {
      assertInferenceReady(this.health);
    }

    const cancellationBuffer = new SharedArrayBuffer(4);

    const checkCallback = () => {
      if (this.health) {
        assertInferenceReady(this.health);
      }
      const currentExec = this.stmtMap.get(statement);
      if (currentExec?.cancelled) {
        throw new VectorError("E_CANCELLED");
      }
      if (this.clock() >= deadline) {
        throw new VectorError("E_TIMEOUT");
      }
    };

    const cache = new StatementEmbeddingCache(this.identity, 33554432, checkCallback);
    const execution: StatementExecution = {
      database,
      statement,
      generation,
      deadline,
      cancelled: false,
      cancellationBuffer,
      cache
    };

    this.stmtMap.set(statement, execution);
    let stmts = this.dbMap.get(database);
    if (!stmts) {
      stmts = new Set<number>();
      this.dbMap.set(database, stmts);
    }
    stmts.add(statement);

    this.activeExecution = execution;
    return execution;
  }

  /**
   * 処理名: 現在実行コンテキスト取得
   * 処理概要: 現在アクティブなステップの StatementExecution を取得し、ヘルス・キャンセル・期限を検査する。
   * 実装理由: UDF 評価時に実行文脈の健全性を保証するため。
   * @returns 現在の StatementExecution。
   */
  public current(): StatementExecution {
    if (!this.activeExecution) {
      throw new VectorError("E_PROTOCOL");
    }
    if (this.health) {
      assertInferenceReady(this.health);
    }
    if (this.activeExecution.cancelled) {
      throw new VectorError("E_CANCELLED");
    }
    if (this.clock() >= this.activeExecution.deadline) {
      throw new VectorError("E_TIMEOUT");
    }
    return this.activeExecution;
  }

  /**
   * 処理名: ステップ終了 (leave)
   * 処理概要: ステップ実行を完了し、SQLITE_ROW(100)以外の場合はキャッシュを破棄して統計を加算する。
   * 実装理由: ROW行間のみキャッシュを維持し、DONEやエラー時に確実にメモリを解放するため。
   * @param statement - ステートメントポインタ。
   * @param result - sqlite3_step の戻り値コード (100=SQLITE_ROW, 101=SQLITE_DONE 等)。
   */
  public leave(statement: number, result: number): void {
    if (this.activeExecution && this.activeExecution.statement === statement) {
      this.activeExecution = null;
    }

    // ネストした異ステートメントの leave (例: native PROFILE) は所有ステップを終了しない
    const execution = this.stmtMap.get(statement);
    if (!execution) {
      return;
    }

    if (result === 100) {
      // SQLITE_ROW: キャッシュは継続
      return;
    }

    // SQLITE_DONE (101) またはエラー: キャッシュを解放してリセット
    this.reset(statement);
  }

  /**
   * 処理名: ステートメントリセット
   * 処理概要: 対象ステートメントのキャッシュを破棄し、統計カウンタを累積してマップから除去する。
   * 実装理由: sqlite3_reset / finalize 時のキャッシュ破棄プロトコルを遵守するため。
   * @param statement - ステートメントポインタ。
   */
  public reset(statement: number): void {
    const execution = this.stmtMap.get(statement);
    if (execution) {
      const stats = execution.cache.statistics();
      this.accumulatedHit += stats.hit;
      this.accumulatedMiss += stats.miss;
      this.accumulatedEviction += stats.eviction;
      this.accumulatedActualInference += stats.actualInference;
      execution.cache.dispose();
      this.stmtMap.delete(statement);

      const stmts = this.dbMap.get(execution.database);
      if (stmts) {
        stmts.delete(statement);
      }
    }
    if (this.activeExecution && this.activeExecution.statement === statement) {
      this.activeExecution = null;
    }
  }

  /**
   * 処理名: データベースクローズ
   * 処理概要: 指定データベースに関連付けられた全ステートメントのコンテキストを破棄する。
   * 実装理由: DB close 時のリソース完全回収のため。
   * @param database - データベースポインタ。
   */
  public close(database: number): void {
    const stmts = this.dbMap.get(database);
    if (stmts) {
      for (const statement of Array.from(stmts)) {
        this.reset(statement);
      }
      this.dbMap.delete(database);
    }
  }

  /**
   * 処理名: 実行キャンセル
   * 処理概要: 指定データベースまたは全ステートメントのキャンセルフラグを立て、キャッシュを破棄する。
   * 実装理由: キャンセルシグナルを同期的かつ即座に反映させるため。
   * @param database - 対象データベースポインタ (省略時は全DB)。
   */
  public cancel(database?: number): void {
    const targets: StatementExecution[] = [];
    if (database !== undefined) {
      const stmts = this.dbMap.get(database);
      if (stmts) {
        for (const s of stmts) {
          const exec = this.stmtMap.get(s);
          if (exec) targets.push(exec);
        }
      }
    } else {
      targets.push(...Array.from(this.stmtMap.values()));
    }

    for (const execution of targets) {
      execution.cancelled = true;
      Atomics.store(new Int32Array(execution.cancellationBuffer, 0, 1), 0, 1);
      execution.cache.dispose();
    }
  }

  /**
   * 処理名: 累積統計取得
   * 処理概要: これまでに実行・終了した全ステートメントのキャッシュ統計を合算して返す。
   * 実装理由: gemma_model_info におけるキャッシュ効率診断のため。
   * @returns 累積 CacheCounters。
   */
  public statistics(): CacheCounters {
    let currentEntries = 0;
    let currentBytes = 0;
    for (const exec of this.stmtMap.values()) {
      const s = exec.cache.statistics();
      currentEntries += s.entries;
      currentBytes += s.bytes;
    }
    return {
      hit: this.accumulatedHit,
      miss: this.accumulatedMiss,
      eviction: this.accumulatedEviction,
      actualInference: this.accumulatedActualInference,
      entries: currentEntries,
      bytes: currentBytes
    };
  }
}
