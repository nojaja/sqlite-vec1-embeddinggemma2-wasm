import { VectorError } from "../errors";
import type { EmbeddingCall } from "../official/functions";

/**
 * 処理名: 埋め込みキャッシュアイデンティティ型
 * 処理概要: モデル識別子、リビジョン、指紋、プロファイル、バックエンド、ランタイム世代を保持する。
 * 実装理由: ステートメントキャッシュの独立性およびモデル整合性を厳格に保証するため。
 */
export interface EmbeddingCacheIdentity {
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  backend: string;
  runtimeGeneration: number;
}

/**
 * 処理名: 統計カウンタ構造体
 * 処理概要: キャッシュヒット、ミス、追い出し、実推論回数、エントリ数、使用バイト数を保持する。
 * 実装理由: キャッシュ効率および実行状況を診断・検証するため。
 */
export interface CacheCounters {
  hit: number;
  miss: number;
  eviction: number;
  actualInference: number;
  entries: number;
  bytes: number;
}

interface CacheEntry {
  key: string;
  operation: "query" | "document" | "image";
  imageBytes?: Uint8Array;
  blob: Uint8Array;
  size: number;
}

/**
 * 処理名: 埋め込みベクトルの妥当性検証
 * 処理概要: 3072 バイト長、全要素の有限性、非ゼロノルムを検証する。
 * 実装理由: 不正・破損した推論出力をキャッシュまたは SQLite へ渡さないため。
 * @param value - 検証対象のバイナリ。
 */
export function validateEmbeddingBlob(value: unknown): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== 3072) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let sumSquares = 0;
  for (let i = 0; i < 768; i++) {
    const floatVal = view.getFloat32(i * 4, true);
    if (!Number.isFinite(floatVal)) {
      throw new VectorError("E_EMBEDDING_VALUE");
    }
    sumSquares += floatVal * floatVal;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm < 1e-12) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
}

/**
 * 処理名: StatementEmbeddingCache クラス
 * 処理概要: ステートメント実行内で最大10件・32MiBのLRU埋め込みキャッシュを管理する。
 * 実装理由: 同一クエリ実行中における重複推論を排除しつつステートメント境界の分離を保つため。
 */
export class StatementEmbeddingCache {
  private readonly identityStr: string;
  private readonly capacity: number;
  private readonly check: () => void;
  private entriesList: CacheEntry[] = [];
  private currentBytes = 0;
  private isDisposed = false;

  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private actualInferenceCount = 0;

  /**
   * 処理名: StatementEmbeddingCache コンストラクタ
   * 処理概要: アイデンティティと容量、ヘルス/デッドライン検査コールバックを初期化する。
   * 実装理由: ステートメント実行単位で独立したキャッシュインスタンスを構築するため。
   * @param identity - モデル・ランタイムアイデンティティ。
   * @param capacity - 最大バイト容量 (1..33554432)。
   * @param check - ヘルスおよび期限検査コールバック。
   */
  constructor(
    identity: EmbeddingCacheIdentity,
    capacity = 33554432,
    check: () => void = () => {}
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 33554432) {
      throw new VectorError("E_INPUT");
    }
    this.identityStr = JSON.stringify([
      identity.modelId,
      identity.revision,
      identity.fingerprint,
      identity.profile,
      identity.backend,
      identity.runtimeGeneration
    ]);
    this.capacity = capacity;
    this.check = check;
  }

  /**
   * 処理名: 画像バイト配列完全一致比較
   * 処理概要: 2つの Uint8Array の長さと全バイトを比較する。
   * 実装理由: 画像ハッシュ衝突のリスクを排除し全バイトで同一性を保証するため。
   * @param a - 比較対象 A。
   * @param b - 比較対象 B。
   * @returns 完全一致時 true。
   */
  private compareBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) {
      return false;
    }
    for (let i = 0; i < a.byteLength; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * 処理名: キャッシュ解決
   * 処理概要: キャッシュを探索し、ヒット時は複製を返し、ミス時は推論を実行してLRUキャッシュへ追加する。
   * 実装理由: 同一ステートメント内の重複推論を抑制し、安全にキャッシュを更新するため。
   * @param request - 埋め込み呼び出し要求。
   * @param infer - 推論実行コールバック。
   * @returns 3072 バイトの独立した Float32 ベクトル BLOB、または NULL。
   */
  public resolve(
    request: EmbeddingCall,
    infer: (req: EmbeddingCall) => Uint8Array | null
  ): Uint8Array | null {
    if (this.isDisposed) {
      throw new VectorError("E_PROTOCOL");
    }
    this.check();

    let key: string;
    let entrySize: number;
    let reqImageCopy: Uint8Array | undefined;

    const getStrBytes = (s: string) =>
      typeof Buffer !== "undefined"
        ? Buffer.byteLength(s, "utf8")
        : new TextEncoder().encode(s).length;

    if (request.operation === "image") {
      key = JSON.stringify([this.identityStr, "image", request.mime, request.bytes.length]);
      entrySize = getStrBytes(key) + 3072 + request.bytes.length;
      reqImageCopy = new Uint8Array(request.bytes);
    } else {
      const normalizedTitle = request.title ?? "";
      key = JSON.stringify([this.identityStr, request.operation, request.body, normalizedTitle]);
      entrySize = getStrBytes(key) + 3072;
    }

    // ヒット探索
    const hitIdx = this.entriesList.findIndex((e) => {
      if (e.key !== key) return false;
      if (request.operation === "image") {
        return e.imageBytes && this.compareBytes(e.imageBytes, request.bytes);
      }
      return true;
    });

    if (hitIdx !== -1) {
      this.check();
      const [hitEntry] = this.entriesList.splice(hitIdx, 1);
      this.entriesList.push(hitEntry!);
      this.hitCount++;
      return new Uint8Array(hitEntry!.blob);
    }

    // ミス時推論実行
    this.missCount++;
    this.actualInferenceCount++;
    const result = infer(request);
    if (result === null) {
      return null;
    }
    validateEmbeddingBlob(result);

    // 単一エントリが許容容量を超える場合はキャッシュせず返却
    if (entrySize > this.capacity) {
      return new Uint8Array(result);
    }

    // LRU 追い出し
    while (
      this.entriesList.length >= 10 ||
      (this.currentBytes + entrySize > this.capacity && this.entriesList.length > 0)
    ) {
      const evicted = this.entriesList.shift()!;
      this.currentBytes -= evicted.size;
      this.evictionCount++;
    }

    const blobCopy = new Uint8Array(result);
    this.entriesList.push({
      key,
      operation: request.operation,
      imageBytes: reqImageCopy,
      blob: blobCopy,
      size: entrySize
    });
    this.currentBytes += entrySize;

    return new Uint8Array(result);
  }

  /**
   * 処理名: キャッシュ破棄
   * 処理概要: 全エントリと内部バッファ参照を解放し、再利用を不可にする。
   * 実装理由: ステートメント終了時のメモリ解放および再利用拒否プロトコルを遵守するため。
   */
  public dispose(): void {
    this.isDisposed = true;
    this.entriesList = [];
    this.currentBytes = 0;
  }

  /**
   * 処理名: 統計カウンタ取得
   * 処理概要: ヒット、ミス、追い出し、実推論、エントリ数、保持バイト数を返す。
   * 実装理由: キャッシュ動作の検証および gemma_model_info 診断のため。
   * @returns 統計カウンタ情報。
   */
  public statistics(): CacheCounters {
    return {
      hit: this.hitCount,
      miss: this.missCount,
      eviction: this.evictionCount,
      actualInference: this.actualInferenceCount,
      entries: this.entriesList.length,
      bytes: this.currentBytes
    };
  }
}
