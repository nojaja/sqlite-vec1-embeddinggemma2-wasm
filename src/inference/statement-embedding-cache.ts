import { VectorError } from "../errors";

/** cache識別用identity。 */
export interface EmbeddingCacheIdentity {
  modelId: string;
  revision: string;
  fingerprint: string;
  profile: string;
  backend: string;
  runtimeGeneration: number;
}

/** 埋め込み呼出し引数。 */
export type EmbeddingCall =
  | { operation: "query" | "document"; body: unknown; title?: unknown }
  | { operation: "image"; bytes: Uint8Array; mime: string };

/** 実行時予算。 */
export interface EmbeddingExecutionBudget {
  deadline: number;
  cancellationBuffer: SharedArrayBuffer;
}

/** 推論呼出し関数。 */
export type EmbeddingInference = (
  request: EmbeddingCall,
  budget?: EmbeddingExecutionBudget
) => Uint8Array | null;

/** 統計情報。 */
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
 * @param value - 検証対象のUint8Array
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

interface CacheNode {
  keyStr: string;
  imageBytes?: Uint8Array;
  value: Uint8Array;
  size: number;
  prev: CacheNode | null;
  next: CacheNode | null;
}

/**
 * 処理名: StatementEmbeddingCache
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

  private findNode(keyStr: string, imageBytes?: Uint8Array): CacheNode | null {
    const list = this.nodeMap.get(keyStr);
    if (!list) return null;
    if (!imageBytes) {
      return list[0] ?? null;
    }
    for (const node of list) {
      if (node.imageBytes && node.imageBytes.byteLength === imageBytes.byteLength) {
        let match = true;
        for (let i = 0; i < imageBytes.byteLength; i++) {
          if (node.imageBytes[i] !== imageBytes[i]) {
            match = false;
            break;
          }
        }
        if (match) return node;
      }
    }
    return null;
  }

  private detachNode(node: CacheNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private attachHead(node: CacheNode): void {
    node.next = this.head;
    node.prev = null;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

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

  public dispose(): void {
    this.disposed = true;
    this.head = null;
    this.tail = null;
    this.nodeMap.clear();
    this.currentBytes = 0;
    this.currentEntries = 0;
  }

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
