# v0.0.1 資材 URL 一覧

## 1. 保存先

外部から調達するアーカイブ、ライブラリ成果物を `downloads/` へ、推論用モデルを `model/` へ保存する。以下のパスはプロジェクトルート基準とする。通常 npm パッケージは `package.json` に固定したバージョンを `npm install` で取得する。

### 必要入力の範囲

本プロジェクトでは、公式ビルド済み成果物（公式 SQLite 3.54.1 + vec1 組み込み Wasm/loader、および公式 ONNX Runtime / Transformers.js）を採用する。決定論的な完成資材を直接消費して製品ビルドおよび推論ランタイムの構築を行う。

| 種類 | 準備方法・完了条件 |
| --- | --- |
| 公式 SQLite 完成モジュール | `downloads/sqlite-official/` 配下に SQLite 3.54.1 と vec1 0.7 を組み込んだ公式 Wasm および loader 群（`sqlite3-node.mjs`, `sqlite3.wasm`, `sqlite3-bundler-friendly.mjs` 等）を配置する。 |
| 配布・互換検証用 archive | 公式 npm 配布物（`sqlite-wasm-3.54.1-build1.tgz`）および公式 demo リポジトリアーカイブ（`sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz`）を取得し、型の整合および互換性を検証する。 |
| manifests/embeddinggemma2-q4.json | モデルの 11 資材の完全性（ファイルサイズおよび SHA-256）を定義し、推論初期化時に検証する。 |
| 推論モデル (EmbeddingGemma 2) | HuggingFace の固定リビジョンから 11 資材を取得し、`model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/` へ配置する。 |

---

## 2. 製品およびビルド入力資材

以下の資材を `downloads/` 配下に配置する。

| 保存先 | 入手URL | 用途 |
| --- | --- | --- |
| `downloads/sqlite-official/sqlite3.wasm` | 公式配布物より配置 | SQLite 3.54.1 + vec1 0.7 組み込み WebAssembly バイナリ |
| `downloads/sqlite-official/sqlite3-node.mjs` | 公式配布物より配置 | Node.js 向け公式ローダー |
| `downloads/sqlite-official/sqlite3-bundler-friendly.mjs` | 公式配布物より配置 | バンドラーフレンドリーブラウザローダー |
| `downloads/sqlite-official/sqlite3-worker1-promiser.mjs` | 公式配布物より配置 | 公式 Worker1 Promiser API ローダー |
| `downloads/sqlite-official/sqlite3-opfs-async-proxy.js` | 公式配布物より配置 | OPFS 非同期プロキシスクリプト |
| `downloads/sqlite-wasm-3.54.1-build1.tgz` | `https://registry.npmjs.org/@sqlite.org/sqlite-wasm/-/sqlite-wasm-3.54.1-build1.tgz` | 公開型定義および互換性照合用 |
| `downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz` | `https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` | 公式 9 デモ検証用リポジトリアーカイブ |

---

## 3. 推論モデル資材 (EmbeddingGemma 2)

各ファイルを `model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/` へ保存する。
固定リポジトリ `onnx-community/embeddinggemma-2-ONNX` の固定リビジョン `daa72c51243991dfcaf9f9137d2c573d8f7790c0` から取得する。

| 保存名 | 入手URL (ベースURLからの相対) |
| --- | --- |
| `model_q4.onnx` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/onnx/model_q4.onnx` |
| `model_q4.onnx_data` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/onnx/model_q4.onnx_data` |
| `vision_encoder_q4.onnx` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/onnx/vision_encoder_q4.onnx` |
| `vision_encoder_q4.onnx_data` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/onnx/vision_encoder_q4.onnx_data` |
| `config.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/config.json` |
| `processor_config.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/processor_config.json` |
| `preprocessor_config.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/preprocessor_config.json` |
| `tokenizer.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/tokenizer.json` |
| `tokenizer_config.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/tokenizer_config.json` |
| `config_sentence_transformers.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/config_sentence_transformers.json` |
| `special_tokens_map.json` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/special_tokens_map.json` |

---

## 4. 資材の整合性検証

プロジェクトに必要な資材の存在確認は `npm run test:assets`（`test/integration/test-assets.ts`）により機械的に検証する。
全 11 モデル資材の正確な SHA-256 ダイジェストおよびファイルサイズが `manifests/embeddinggemma2-q4.json` と一致することを確認し、欠落や破損がある場合は推論初期化を中止する。
