import { validateDirectMlInventory, type DirectMlNativeAsset } from "../../src/inference/backends/directml";

const assets: DirectMlNativeAsset[] = [
  { path: "bin/napi-v6/win32/x64/DirectML.dll", bytes: 18527544, sha256: "d16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d" },
  { path: "bin/napi-v6/win32/x64/dxcompiler.dll", bytes: 17986400, sha256: "430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72" },
  { path: "bin/napi-v6/win32/x64/onnxruntime.dll", bytes: 31736672, sha256: "beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45" },
  { path: "bin/napi-v6/win32/x64/onnxruntime_binding.node", bytes: 358200, sha256: "8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f" }
];

/** 処理名: native inventory受理検証。処理概要: 固定版と完全一致allowlistを受理する。実装理由: 正常なinstallをload可能にするため。 */
function verifyAcceptedInventory(): void { expect(() => validateDirectMlInventory("1.31.1", assets)).not.toThrow(); }

/** 処理名: native改ざん拒否検証。処理概要: hash不一致と余分なnative資材を拒否する。実装理由: 未承認native codeをloadしないため。 */
function verifyRejectedInventory(): void {
  expect(() => validateDirectMlInventory("1.31.0", assets)).toThrow("E_ASSET_INTEGRITY");
  expect(() => validateDirectMlInventory("1.31.1", assets.slice(1))).toThrow("E_ASSET_INTEGRITY");
  expect(() => validateDirectMlInventory("1.31.1", [...assets, { path: "bin/napi-v6/win32/x64/extra.dll", bytes: 1, sha256: "0".repeat(64) }])).toThrow("E_ASSET_INTEGRITY");
  expect(() => validateDirectMlInventory("1.31.1", assets.map((asset, index) => index === 0 ? { ...asset, bytes: asset.bytes + 1 } : asset))).toThrow("E_ASSET_INTEGRITY");
}

test("G00-DML: fixed native inventory is accepted", verifyAcceptedInventory);
test("G00-DML: changed or extra native inventory is rejected", verifyRejectedInventory);