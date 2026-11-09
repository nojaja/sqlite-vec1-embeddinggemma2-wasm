import { VectorError } from "../../errors";

/**
 * 処理名: DirectMLネイティブ資材メタデータ
 * 処理概要: DirectMLバイナリのパス、バイトサイズ、SHA-256ハッシュを定義する。
 * 実装理由: ネイティブアセットの完全性検証を行うため。
 */
export interface DirectMlNativeAsset {
  path: string;
  bytes: number;
  sha256: string;
}

const REQUIRED_ASSETS: readonly DirectMlNativeAsset[] = Object.freeze([
  { path: "bin/napi-v6/win32/x64/DirectML.dll", bytes: 18527544, sha256: "d16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d" },
  { path: "bin/napi-v6/win32/x64/dxcompiler.dll", bytes: 17986400, sha256: "430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72" },
  { path: "bin/napi-v6/win32/x64/onnxruntime.dll", bytes: 31736672, sha256: "beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45" },
  { path: "bin/napi-v6/win32/x64/onnxruntime_binding.node", bytes: 358200, sha256: "8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f" }
]);

/**
 * 処理名: DirectML資材インベントリ検証
 * 処理概要: パッケージ内のDirectMLネイティブライブラリのバージョンとハッシュを照合する。
 * 実装理由: 破損や改ざんのないDirectMLバイナリのみを実行可能にするため。
 * @param version - ONNX Runtimeのバージョン文字列。
 * @param actual - 検出された資材メタデータの配列。
 */
export function validateDirectMlInventory(version: string, actual: readonly DirectMlNativeAsset[]): void {
  if (version !== "1.31.1" || actual.length !== REQUIRED_ASSETS.length) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  for (let i = 0; i < REQUIRED_ASSETS.length; i++) {
    const exp = REQUIRED_ASSETS[i]!;
    const act = actual[i]!;
    if (exp.path !== act.path || exp.bytes !== act.bytes || exp.sha256 !== act.sha256) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }
}
