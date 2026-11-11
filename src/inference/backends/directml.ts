import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { VectorError } from "../../errors";

/**
 * 処理名: DirectML ネイティブ資材ダイジェスト型
 * 処理概要: パス、バイトサイズ、SHA-256 ハッシュを保持する。
 */
export interface DirectMlNativeAsset {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * 処理名: 固定 DirectML ネイティブインベントリ一覧
 * 処理概要: onnxruntime-node@1.31.1 の Windows x64 向け 4 つのネイティブバイナリの正準ダイジェストを定義する。
 * 実装理由: 未検証ネイティブコードのロードや改ざんバイナリの実行を排除するため。
 */
export const DIRECTML_NATIVE_INVENTORY: readonly DirectMlNativeAsset[] = [
  {
    path: "bin/napi-v6/win32/x64/DirectML.dll",
    bytes: 18527544,
    sha256: "d16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d"
  },
  {
    path: "bin/napi-v6/win32/x64/dxcompiler.dll",
    bytes: 17986400,
    sha256: "430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72"
  },
  {
    path: "bin/napi-v6/win32/x64/onnxruntime.dll",
    bytes: 31736672,
    sha256: "beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45"
  },
  {
    path: "bin/napi-v6/win32/x64/onnxruntime_binding.node",
    bytes: 358200,
    sha256: "8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f"
  }
];

/**
 * 処理名: DirectML インベントリ完全性検証
 * 処理概要: バージョンが 1.31.1 であり、資材一覧が固定 4 資材と完全一致（過不足なし・サイズ/ハッシュ一致）することを検証する。
 * 実装理由: 承認されたバイナリ以外による DirectML 実行を防止するため。
 * @param version - onnxruntime-node バージョン。
 * @param actual - 実測資材ダイジェスト一覧。
 */
export function validateDirectMlInventory(
  version: string,
  actual: readonly DirectMlNativeAsset[]
): void {
  if (version !== "1.31.1") {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (!Array.isArray(actual) || actual.length !== DIRECTML_NATIVE_INVENTORY.length) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const expectedMap = new Map<string, DirectMlNativeAsset>();
  for (const item of DIRECTML_NATIVE_INVENTORY) {
    expectedMap.set(item.path, item);
  }

  for (const asset of actual) {
    const expected = expectedMap.get(asset.path);
    if (!expected) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    if (asset.bytes !== expected.bytes) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    if (asset.sha256.toLowerCase() !== expected.sha256.toLowerCase()) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
  }
}

/**
 * 処理名: DirectML インストール状態検証
 * 処理概要: Windows x64 環境および node_modules/onnxruntime-node の配置資材完全性を検証する。
 * 実装理由: 推論ワーカー起動前に DirectML 実行可能であることを確定させるため。
 * @returns 検証済みバージョン文字列。
 */
export async function verifyDirectMlInstallation(): Promise<string> {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new VectorError("E_ENVIRONMENT");
  }

  let pkgDir: string;
  try {
    const resolved = require.resolve("onnxruntime-node/package.json");
    pkgDir = path.dirname(resolved);
  } catch {
    throw new VectorError("E_ENVIRONMENT");
  }

  const pkgJson = JSON.parse(await fs.promises.readFile(path.join(pkgDir, "package.json"), "utf8"));
  const version = pkgJson.version;

  const actualList: DirectMlNativeAsset[] = [];
  for (const item of DIRECTML_NATIVE_INVENTORY) {
    const fullPath = path.join(pkgDir, item.path);
    if (!fs.existsSync(fullPath)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const stat = await fs.promises.stat(fullPath);
    const content = await fs.promises.readFile(fullPath);
    const sha = crypto.createHash("sha256").update(content).digest("hex");
    actualList.push({ path: item.path, bytes: stat.size, sha256: sha });
  }

  validateDirectMlInventory(version, actualList);
  return version;
}

/**
 * 処理名: DirectML ランタイムロード
 * 処理概要: onnxruntime-node バインディングをロードし、DML プロバイダーが bundled されているか確認して返す。
 * 実装理由: DirectML デバイスが使用可能であることをランタイムから証明するため。
 * @returns onnxruntime-node エクスポートオブジェクト。
 */
export async function loadDirectMlRuntime(): Promise<unknown> {
  await verifyDirectMlInstallation();
  try {
    const ort = require("onnxruntime-node");
    const backends = ort.listSupportedBackends ? ort.listSupportedBackends() : [];
    const dml = backends.find((b: { name: string; bundled: boolean }) => b.name === "dml" && b.bundled);
    if (!dml) {
      throw new VectorError("E_ENVIRONMENT");
    }
    return ort;
  } catch (err: unknown) {
    if (err instanceof VectorError) throw err;
    throw new VectorError("E_ENVIRONMENT");
  }
}
