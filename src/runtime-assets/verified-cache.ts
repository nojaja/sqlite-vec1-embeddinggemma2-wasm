import { VectorError } from "../errors";
import { MODEL_REPOSITORY, MODEL_REVISION, validateModelAssets, MODEL_ASSET_FILES, type ModelAssetDigest } from "./model-contract";

/**
 * 処理名: SHA-256 16進数計算
 * 処理概要: 依存モジュールなしでバイト列のSHA-256ハッシュを同期計算する。
 * 実装理由: Node/Browser双方でnode:cryptoに依存せず同一ハッシュ検証を行うため。
 * @param bytes - ハッシュ対象バイト配列。
 * @returns 64文字の16進数文字列。
 */
export function computeSha256Hex(bytes: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const len = bytes.length;
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len * 8) >>> 0;
  const rem = (len + 9) % 64;
  const padLen = rem === 0 ? 0 : 64 - rem;
  const totalLen = len + 1 + padLen + 8;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(totalLen - 8, bitLenHi, false);
  view.setUint32(totalLen - 4, bitLenLo, false);

  const W = new Uint32Array(64);
  for (let i = 0; i < totalLen; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((W[t - 15]! >>> 7) | (W[t - 15]! << 25)) ^ ((W[t - 15]! >>> 18) | (W[t - 15]! << 14)) ^ (W[t - 15]! >>> 3);
      const s1 = ((W[t - 2]! >>> 17) | (W[t - 2]! << 15)) ^ ((W[t - 2]! >>> 19) | (W[t - 2]! << 13)) ^ (W[t - 2]! >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + W[t]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(32));
  out.setUint32(0, h0, false);
  out.setUint32(4, h1, false);
  out.setUint32(8, h2, false);
  out.setUint32(12, h3, false);
  out.setUint32(16, h4, false);
  out.setUint32(20, h5, false);
  out.setUint32(24, h6, false);
  out.setUint32(28, h7, false);

  let hex = "";
  const outBytes = new Uint8Array(out.buffer);
  for (let i = 0; i < 32; i++) {
    hex += outBytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * 処理名: 検証済み資材読み出し関数型定義
 * 処理概要: パスを指定して検証済みの資材バイト配列を非同期に読み出す関数シグネチャを定義する。
 * 実装理由: キャッシュストレージからの資材読み出し処理を抽象化するため。
 */
export type VerifiedAssetReader = (path: string) => Promise<Uint8Array | undefined>;

const LOCAL_PREFIX = `/models/${MODEL_REPOSITORY}/`;
const REMOTE_PREFIX = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`;

/**
 * 処理名: Transformers.js用検証済みcache
 * 処理概要: 固定keyだけをmanifest論理pathへ写像し、毎回size/hashを検証して返す。
 * 実装理由: loaderが未検証資材や任意pathを読まないようにするため。
 */
export class VerifiedModelCache {
  private readonly digests: ReadonlyMap<string, ModelAssetDigest>;
  private readonly reader: VerifiedAssetReader;

  /**
   * 処理名: cache生成
   * 処理概要: 完全なdigest集合を検証して保持する。
   * 実装理由: 部分集合のcacheを作らないため。
   * @param assets - 全資材digest。
   * @param reader - bytes読出し関数。
   */
  public constructor(assets: readonly ModelAssetDigest[], reader: VerifiedAssetReader) {
    validateModelAssets(assets);
    this.digests = new Map(assets.map((asset) => [asset.path, { ...asset }]));
    this.reader = reader;
  }

  /**
   * 処理名: key解決
   * 処理概要: 許可keyだけをmanifest pathへ変換する。
   * 実装理由: traversalや別revisionを入口で拒否するため。
   * @param request - URL文字列またはRequest。
   * @returns manifest path。未許可はundefined。
   */
  private resolve(request: string | Request): string | undefined {
    const key = typeof request === "string" ? request : request.url;
    const prefix = key.startsWith(LOCAL_PREFIX) ? LOCAL_PREFIX : key.startsWith(REMOTE_PREFIX) ? REMOTE_PREFIX : undefined;
    if (prefix === undefined) return undefined;
    const path = key.slice(prefix.length);
    return MODEL_ASSET_FILES.some((asset) => asset.path === path) ? path : undefined;
  }

  /**
   * 処理名: 完全性検証
   * 処理概要: bytesのsizeとSHA-256を定義と照合する。
   * 実装理由: 読むたびに完全性を確認するため。
   * @param path - manifest path。
   * @param bytes - 検証対象。
   */
  private verify(path: string, bytes: Uint8Array): void {
    const digest = this.digests.get(path) as ModelAssetDigest;
    if (bytes.byteLength !== digest.bytes || computeSha256Hex(bytes) !== digest.sha256) throw new VectorError("E_ASSET_INTEGRITY");
  }

  /**
   * 処理名: cache照会
   * 処理概要: 検証済みbytesを新しいResponseとして返す。
   * 実装理由: stream再利用を避けcopyを返すため。
   * @param request - 照会key。
   * @returns Response。未許可/欠損はundefined。
   */
  public async match(request: string | Request): Promise<Response | undefined> {
    const path = this.resolve(request);
    if (path === undefined) return undefined;
    const bytes = await this.reader(path);
    if (bytes === undefined) return undefined;
    this.verify(path, bytes);
    const definition = MODEL_ASSET_FILES.find((asset) => asset.path === path);
    return new Response(bytes.slice(), { status: 200, headers: { "Content-Length": String(bytes.byteLength), "Content-Type": definition?.mime ?? "application/octet-stream" } });
  }

  /**
   * 処理名: cache格納検証
   * 処理概要: 同じdigestの内容だけを受理し保存状態は変えない。
   * 実装理由: loaderの書込みでmanifestを迂回させないため。
   * @param request - 格納key。
   * @param response - 格納内容。
   */
  public async put(request: string | Request, response: Response): Promise<void> {
    const path = this.resolve(request);
    if (path === undefined) throw new VectorError("E_ASSET_INTEGRITY");
    this.verify(path, new Uint8Array(await response.arrayBuffer()));
  }
}
