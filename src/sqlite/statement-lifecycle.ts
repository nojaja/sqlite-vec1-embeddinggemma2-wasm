import { VectorError } from "../errors";
import {
  StatementEmbeddingCache,
  type EmbeddingCacheIdentity,
  type StatementCacheCounters
} from "../inference/statement-embedding-cache";

/** 単一Statementの実行コンテキスト。 */
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

  public hasActiveStep(): boolean {
    return this.activeStepStatement !== null;
  }

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

  public reset(statement: number): void {
    this.disposeExecution(statement);
  }

  public close(database: number): void {
    for (const [stmt, exec] of Array.from(this.statementMap.entries())) {
      if (exec.database === database) {
        this.disposeExecution(stmt);
      }
    }
  }

  public cancel(database?: number): void {
    for (const exec of this.statementMap.values()) {
      if (database === undefined || exec.database === database) {
        exec.cancelled = true;
        Atomics.store(new Int32Array(exec.cancellationBuffer), 0, 1);
        exec.cache.dispose();
      }
    }
  }

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
