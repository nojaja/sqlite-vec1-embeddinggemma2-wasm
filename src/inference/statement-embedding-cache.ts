import { VectorError } from "../errors";

/**
 * 処理名: 埋め込みキャッシュ識別情報
 * 処理概要: モデル・リビジョン・フィンガープリント等のキャッシュキー識別情報を定義する。
 * 実装理由: 異なるモデルや実行環境間でキャッシュが混ざることを防ぐため。
 */
export interface EmbeddingCacheIdentity {
  // モデルID
  modelId: string;
  // リビジョン
  revision: string;
  // フィンガープリント
  fingerprint: string;
  // プロファイル名
  profile: string;
  // バックエンド名
  backend: string;
  // 実行時生成番号
  runtimeGeneration: number;
}

/**
 * 処理名: テキスト埋め込み呼出し引数
 * 処理概要: テキストクエリまたはドキュメントの入力情報。
 * 実装理由: テキスト推論入力を型定義するため。
 */
export interface TextEmbeddingCall {
  // 操作種別 ("query" または "document")
  operation: "query" | "document";
  // 本文テキスト
  body: unknown;
  // タイトル (任意)
  title?: unknown;
}

/**
 * 処理名: 画像埋め込み呼出し引数
 * 処理概要: 画像バイト配列とMIMEタイプの入力情報。
 * 実装理由: マルチモーダル画像推論入力を型定義するため。
 */
export interface ImageEmbeddingCall {
  // 操作種別 ("image")
  operation: "image";
  // 画像バイト配列
  bytes: Uint8Array;
  // MIMEタイプ
  mime: string;
}

/**
 * 処理名: 埋め込み呼び出し入力引数型
 * 処理概要: テキストクエリ、ドキュメント、または画像バイト配列の入力形式を定義する。
 * 実装理由: 多様な入力形式を統一的に受け付けるため。
 */
export type EmbeddingCall = TextEmbeddingCall | ImageEmbeddingCall;

/**
 * 処理名: 推論実行時予算インターフェース
 * 処理概要: 実行デッドラインとキャンセル共有バッファを管理する。
 * 実装理由: 長時間実行やタイムアウト時に推論を安全に中断するため。
 */
export interface EmbeddingExecutionBudget {
  // デッドライン時刻
  deadline: number;
  // キャンセル同期用共有バッファ
  cancellationBuffer: SharedArrayBuffer;
}

/**
 * 処理名: 埋め込み推論関数型
 * 処理概要: テキストまたは画像入力を受け取りベクトルBLOBを同期計算する関数。
 * 実装理由: 推論エンジンとの統一インターフェースを定義するため。
 * @param request 埋め込み要求オブジェクト。
 * @param budget 実行予算（タイムアウト・キャンセル情報）。
 * @returns 計算されたベクトルBLOB、または失敗時null。
 */
export type EmbeddingInference = (
  request: EmbeddingCall,
  budget?: EmbeddingExecutionBudget
) => Uint8Array | null;

/**
 * 処理名: ステートメントキャッシュ統計情報
 * 処理概要: ヒット数・ミス数・退避数・推論回数・エントリ数・バイト数を保持する。
 * 実装理由: キャッシュの効果測定とモニタリングのため。
 */
export interface StatementCacheCounters {
  hit: number;
  miss: number;
  eviction: number;
  actualInference: number;
  entries: number;
  bytes: number;
}

const DEFAULT_CAPACITY = 32 * 1024 * 1024; // 32MiB
const MAX_ENTRIES = 10;
const EMBEDDING_BYTES = 3072;

/**
 * 処理名: 埋め込みBLOB検証
 * 処理概要: 正確に3072Bで、768個のFloat32がすべて有限で、L2ノルムが正規化されていることを検証する。
 * 実装理由: 不正な埋め込みベクトルがキャッシュやDBに保存されるのを防ぐため。
 * @param value 検証対象の値。
 */
export function validateEmbeddingBlob(value: unknown): void {
  if (!(value instanceof Uint8Array) || value.byteLength % 4 !== 0 || value.byteLength === 0) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
  const dim = value.byteLength / 4;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  let squared = 0;
  for (let i = 0; i < dim; i++) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) {
      throw new VectorError("E_EMBEDDING_VALUE");
    }
    squared += v * v;
  }
  const norm = Math.sqrt(squared);
  if (!Number.isFinite(norm) || norm <= 1e-12 || Math.abs(norm - 1) > 1e-4) {
    throw new VectorError("E_EMBEDDING_VALUE");
  }
}

/**
 * 処理名: キャッシュノードインターフェース
 * 処理概要: 双方向連結リストのノードとしてキャッシュエントリを保持する。
 * 実装理由: LRUアルゴリズムによる高速な昇格・退避を実現するため。
 */
interface CacheNode {
  keyStr: string;
  imageBytes?: Uint8Array | undefined;
  value: Uint8Array;
  size: number;
  prev: CacheNode | null;
  next: CacheNode | null;
}

/**
 * 処理名: 画像バイト列一致検証
 * 処理概要: 2つのバイト配列の長さと内容が完全に一致するか検証する。
 * 実装理由: 画像埋め込みキャッシュキーの完全一致を判定するため。
 * @param a キャッシュ内画像バイト配列。
 * @param b 要求画像バイト配列。
 * @returns 完全一致する場合true。
 */
function isImageBytesMatch(a: Uint8Array | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < b.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 処理名: ステートメント埋め込みキャッシュ
 * 処理概要: SQL statement実行内でのLRU埋め込みキャッシュ。
 * 実装理由: 同一クエリでのORDER BYや複数回評価時の再推論を抑止するため。
 */
export class StatementEmbeddingCache {
  private readonly identityStr: string;
  private readonly capacity: number;
  private readonly check: () => void;
  private head: CacheNode | null = null;
  private tail: CacheNode | null = null;
  private nodeMap = new Map<string, CacheNode[]>();
  private disposed = false;

  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;
  private actualInferenceCount = 0;
  private currentBytes = 0;
  private currentEntries = 0;

  /**
   * 処理名: キャッシュ生成
   * 処理概要: キャッシュ同一性文字列と容量上限を設定してインスタンスを初期化する。
   * 実装理由: 同一セッション・設定に応じたキャッシュ境界を確立するため。
   * @param identity キャッシュ識別情報。
   * @param capacity キャッシュ容量バイト上限。
   * @param check ヒット時の追加バリデーションコールバック。
   */
  public constructor(
    identity: EmbeddingCacheIdentity,
    capacity = DEFAULT_CAPACITY,
    check: () => void = () => {}
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > DEFAULT_CAPACITY) {
      throw new VectorError("E_INPUT");
    }
    this.capacity = capacity;
    this.check = check;
    this.identityStr = JSON.stringify([
      identity.modelId,
      identity.revision,
      identity.fingerprint,
      identity.profile,
      identity.backend,
      identity.runtimeGeneration
    ]);
  }

  /**
   * 処理名: キャッシュキー計算
   * 処理概要: 埋め込み要求からJSONキー文字列およびバイトサイズを算出する。
   * 実装理由: テキスト・画像要求ごとの一意な検索キーを構築するため。
   * @param request 埋め込み要求。
   * @returns キー文字列、画像バイト列、キー長。
   */
  private computeKey(request: EmbeddingCall): { keyStr: string; imageBytes?: Uint8Array; keyByteLen: number } {
    if (request.operation === "image") {
      const tuple = [this.identityStr, request.operation, request.mime, request.bytes.byteLength];
      const keyStr = JSON.stringify(tuple);
      const keyByteLen = Buffer.byteLength(keyStr, "utf8");
      return { keyStr, imageBytes: request.bytes.slice(), keyByteLen };
    } else {
      const title = request.title === undefined || request.title === null ? "" : request.title;
      const tuple = [this.identityStr, request.operation, request.body, title];
      const keyStr = JSON.stringify(tuple);
      const keyByteLen = Buffer.byteLength(keyStr, "utf8");
      return { keyStr, keyByteLen };
    }
  }

  /**
   * 処理名: キャッシュノード探索
   * 処理概要: キー文字列および画像バイト列に合致する既存ノードを検索する。
   * 実装理由: LRUキャッシュから合致するエントリを特定するため。
   * @param keyStr 検索キー文字列。
   * @param imageBytes 検索対象画像バイト配列。
   * @returns 合致したキャッシュノード、または未検出時null。
   */
  private findNode(keyStr: string, imageBytes?: Uint8Array): CacheNode | null {
    const list = this.nodeMap.get(keyStr);
    if (!list) return null;
    if (!imageBytes) {
      return list[0] ?? null;
    }
    for (const node of list) {
      if (isImageBytesMatch(node.imageBytes, imageBytes)) {
        return node;
      }
    }
    return null;
  }

  /**
   * 処理名: ノード切り離し
   * 処理概要: 指定ノードを双方向連結リストから切り離す。
   * 実装理由: LRUリストにおける順序更新や削除を行うため。
   * @param node 切り離し対象ノード。
   */
  private detachNode(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  /**
   * 処理名: ノード先頭挿入
   * 処理概要: 指定ノードを双方向連結リストの先頭（最新）に配置する。
   * 実装理由: LRUアクセス順を更新するため。
   * @param node 先頭に配置するノード。
   */
  private attachHead(node: CacheNode): void {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  /**
   * 処理名: 末尾ノード退避
   * 処理概要: 最も古く使われた末尾ノードをキャッシュから退避・削除する。
   * 実装理由: 容量超過または最大エントリ数超過時に空き領域を確保するため。
   */
  private evictTail(): void {
    if (!this.tail) return;
    const old = this.tail;
    this.detachNode(old);
    const list = this.nodeMap.get(old.keyStr);
    if (list) {
      const idx = list.indexOf(old);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.nodeMap.delete(old.keyStr);
    }
    this.currentBytes -= old.size;
    this.currentEntries--;
    this.evictionCount++;
  }

  /**
   * 処理名: 埋め込み解決
   * 処理概要: キャッシュヒット時はキャッシュ値を返し、ミス時は推論を実行してキャッシュに保存する。
   * 実装理由: SQL文実行中の重複推論を防止しレスポンスを向上させるため。
   * @param request 埋め込み要求。
   * @param infer 推論実行関数。
   * @returns 埋め込みベクトルBLOB、または推論失敗時null。
   */
  public resolve(request: EmbeddingCall, infer: EmbeddingInference): Uint8Array | null {
    if (this.disposed) {
      throw new VectorError("E_PROTOCOL");
    }

    const { keyStr, imageBytes, keyByteLen } = this.computeKey(request);
    const existing = this.findNode(keyStr, imageBytes);
    if (existing) {
      this.check();
      this.hitCount++;
      this.detachNode(existing);
      this.attachHead(existing);
      return existing.value.slice();
    }

    this.missCount++;
    this.actualInferenceCount++;
    const res = infer(request);
    if (res === null) {
      return null;
    }

    validateEmbeddingBlob(res);

    const entrySize = keyByteLen + EMBEDDING_BYTES + (imageBytes ? imageBytes.byteLength : 0);
    if (entrySize <= this.capacity) {
      while ((this.currentEntries >= MAX_ENTRIES || this.currentBytes + entrySize > this.capacity) && this.tail) {
        this.evictTail();
      }

      const node: CacheNode = {
        keyStr,
        imageBytes,
        value: res.slice(),
        size: entrySize,
        prev: null,
        next: null
      };
      this.attachHead(node);
      let list = this.nodeMap.get(keyStr);
      if (!list) {
        list = [];
        this.nodeMap.set(keyStr, list);
      }
      list.push(node);
      this.currentBytes += entrySize;
      this.currentEntries++;
    }

    return res.slice();
  }

  /**
   * 処理名: キャッシュ破棄
   * 処理概要: キャッシュノードおよびマップをクリアし破棄状態にする。
   * 実装理由: ステートメント終了時にリソースを解放するため。
   */
  public dispose(): void {
    this.disposed = true;
    this.head = null;
    this.tail = null;
    this.nodeMap.clear();
    this.currentBytes = 0;
    this.currentEntries = 0;
  }

  /**
   * 処理名: キャッシュ統計取得
   * 処理概要: キャッシュのヒット・ミス・退避等の統計カウンタを取得する。
   * 実装理由: キャッシュ動作のプロファイリングのため。
   * @returns キャッシュ統計カウンタ。
   */
  public statistics(): StatementCacheCounters {
    return {
      hit: this.hitCount,
      miss: this.missCount,
      eviction: this.evictionCount,
      actualInference: this.actualInferenceCount,
      entries: this.currentEntries,
      bytes: this.currentBytes
    };
  }
}
