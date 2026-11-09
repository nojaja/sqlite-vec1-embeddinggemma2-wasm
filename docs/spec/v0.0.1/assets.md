# v0.0.1 資材 URL 一覧

## 1. 保存先と資材構成方針

外部から調達するアーカイブ、ライブラリ成果物を `downloads/` へ、推論用モデルを `model/` へ保存する。以下のパスはプロジェクトルート基準とする。通常 npm パッケージは `package.json` に固定したバージョンを `npm install` で取得する。

本プロジェクトは、公式ビルド済み成果物（公式 SQLite 3.54.1 + vec1 0.8 組み込み Wasm、公式 ONNX Runtime、Transformers.js）を採用しており、利用環境での C++ コンパイラによる再コンパイルは不要である。

### 必要入力の範囲

本プロジェクトでは、SQLite 3.54.1 と vec1 0.8 を C 言語レベルで静的組み込み（static auto-extension）した公式互換 Wasm モジュール、および公式 ONNX Runtime / Transformers.js を採用する。

公式配布の demo アーカイブ（`sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz`）単体の Wasm には vec1 拡張が含まれていないため、`sqlite-src-3540100.zip` および `vec1.c`（version 0.8）から再生成された完成資材 8 ファイルを `downloads/sqlite-official/` 配下に配置して製品ビルドに消費する。

| 種類 | 準備方法・完了条件 |
| --- | --- |
| 公式 SQLite + vec1 完成モジュール | `sqlite-src-3540100.zip` および `vec1.c`（version 0.8 Scalar single-threaded）を Emscripten SDK（`emscripten/emsdk:6.0.8`）環境にてビルドし、生成された 8 ファイル（`sqlite3.wasm`, `sqlite3-node.mjs`, `sqlite3-bundler-friendly.mjs` 等）を `downloads/sqlite-official/` 配下へ配置する（Linux 再生成環境およびホスト依存は [linux-toolchain.md](linux-toolchain.md) 参照）。 |
| 互換検証用 archive | 公式 demo リポジトリアーカイブ（`sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz`）を取得し、公式デモとの互換性を検証する。 |
| manifests/embeddinggemma2-q4.json | モデルの 11 資材の完全性（ファイルサイズおよび SHA-256）を定義し、推論初期化時に検証する。 |
| 推論モデル (EmbeddingGemma 2) | HuggingFace の固定リビジョンから 11 資材を取得し、`model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/` へ配置する。 |

---

## 2. 製品およびビルド入力資材

以下の資材を `downloads/` 配下に配置する。

| 保存先 | 入手出元・URL | 用途・補足 |
| --- | --- | --- |
| `downloads/sqlite-official-host/` | Debian 12 (bookworm) official repository | SQLite 再生成コンテナ用 host deb 集合（77 deb、詳細は [linux-toolchain.md](linux-toolchain.md)） |
| `downloads/sqlite-src-3540100.zip` | `https://sqlite.org/2026/sqlite-src-3540100.zip` | SQLite 3.54.1 フルソース（Wasm 再生成用） |
| `downloads/vec1.c` | SQLite 公式 vec1 Fossil リポジトリ (`https://sqlite.org/vec1`)<br>URL: `https://sqlite.org/vec1/raw/vec1.c`（または trunk ソースツリー `ext/vec1/vec1.c`、`https://sqlite.org/vec1/file/vec1.c`） | vec1 0.8 C ソース（日付: 2026-02-04、`#define VEC1_VERSION "0.8"`、Scalar single-threaded 組み込み用） |
| `downloads/sqlite-official/` | SQLite フルソース + vec1.c より再生成（8 ファイル） | SQLite 3.54.1 + vec1 0.8 組み込み完成ランタイム群：<br>- `sqlite3.wasm`<br>- `sqlite3-node.mjs`<br>- `sqlite3-bundler-friendly.mjs`<br>- `sqlite3.mjs`<br>- `sqlite3-opfs-async-proxy.js`<br>- `sqlite3-worker1.mjs`<br>- `sqlite3-worker1-bundler-friendly.mjs`<br>- `sqlite3-worker1-promiser.mjs` |
| `downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz` | `https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` | 公式 9 デモ検証用・ビルド済みローダー収録リポジトリアーカイブ |

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
| `chat_template.jinja` | `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/chat_template.jinja` |

---

## 4. 資材の整合性検証

プロジェクトに必要な資材の存在確認は `npm run test:assets`（`test/integration/test-assets.ts`）により機械的に検証する。
全 11 モデル資材の正確な SHA-256 ダイジェストおよびファイルサイズが `manifests/embeddinggemma2-q4.json` と一致することを確認し、欠落や破損がある場合は推論初期化を中止する。
