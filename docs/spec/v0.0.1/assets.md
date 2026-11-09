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
| 上流修正パッチ資材 (`patches/`) | Transformers.js 4.3.1 および SQLite 公式資材に対する限定パッチ群（`patches/transformers-portable.patch`、`patches/transformers-directml.patch`、`patches/sqlite-official.patch`）。環境分離・Wasm 安定化・DirectML 認識・バグ回避のために必須。 |
| manifests/embeddinggemma2-q4.json | モデルの 11 資材の完全性（ファイルサイズ、SHA-256、artifactSetHash、fingerprint、license、profile）を定義し、推論初期化時に検証する。`npm run lock:model` または `npm run lock-assets`（`scripts/assets/lock-model.ts` / `lock-assets.ts`）により仕様定義および配置資材から生成・ロックする。 |
| 推論モデル (EmbeddingGemma 2) | HuggingFace の固定リビジョンから 11 資材を取得し、`model/embeddinggemma-2-ONNX/daa72c51243991dfcaf9f9137d2c573d8f7790c0/` へ配置する。 |

---

## 2. 製品およびビルド入力資材

以下の資材を `downloads/` 配下に配置する。

| 保存先 | 入手出元・URL | 用途・補足・完全性要件 |
| --- | --- | --- |
| `downloads/sqlite-official-host/` | Debian 12 (bookworm) official repository | SQLite 再生成コンテナ用 host deb 集合（77 deb、詳細は [linux-toolchain.md](linux-toolchain.md)） |
| `downloads/python-debian/` | Debian 12 (bookworm) official repository | Python 実行環境用 deb 集合（13 deb、詳細は [linux-toolchain.md](linux-toolchain.md)） |
| `downloads/sqlite-src-3540100.zip` | `https://sqlite.org/2026/sqlite-src-3540100.zip` | SQLite 3.54.1 フルソース（Wasm 再生成用）<br>- サイズ: 14,899,528 バイト<br>- SHA-256: `387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b`<br>- 内部に VERSION=3.54.1 および `sqlite-src-3540100/ext/vec1/vec1.c` を同梱 |
| `downloads/vec1.c` | `downloads/sqlite-src-3540100.zip` 内の `sqlite-src-3540100/ext/vec1/vec1.c` より展開・抽出（標準調達手順）<br>（参照元: SQLite 公式 vec1 Fossil リポジトリ `https://sqlite.org/vec1`。※注意: 単体 URL `https://sqlite.org/vec1/raw/vec1.c` は Bot 防御・Browser Verification により HTML が返却されるため、未検証ダウンロードは不可） | vec1 0.8 C ソース（日付: 2026-02-04、Scalar single-threaded 組み込み用）<br>- サイズ: 378,128 バイト<br>- SHA-256: `a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9`<br>- 必須マクロ: `#define VEC1_VERSION "0.8"`<br>- 内容検証: HTML 誤検出防止（`<!DOCTYPE`, `<html` 等を含まない C ソースであること） |
| `downloads/sqlite-official/` | SQLite フルソース + vec1.c より再生成（8 ファイル） | SQLite 3.54.1 + vec1 0.8 組み込み完成ランタイム群：<br>- `sqlite3.wasm`<br>- `sqlite3-node.mjs`<br>- `sqlite3-bundler-friendly.mjs`<br>- `sqlite3.mjs`<br>- `sqlite3-opfs-async-proxy.js`<br>- `sqlite3-worker1.mjs`<br>- `sqlite3-worker1-bundler-friendly.mjs`<br>- `sqlite3-worker1-promiser.mjs` |
| `downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz` | `https://codeload.github.com/sqlite/sqlite-wasm/tar.gz/ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` | 公式 9 デモ検証用・ビルド済みローダー収録リポジトリアーカイブ<br>- サイズ: 1,221,483 バイト<br>- SHA-256: `8a428f3330278c96073c6afda8d8a51921a18a330000f99645c5d7051409a795` |

### 2.1 上流パッチ資材 (`patches/`)

製品ビルドおよび整合性テストにおいて、上流ライブラリの環境互換性・不具合解消・ランタイム分離を決定論的に保証するため、以下の 3 パッチをプロジェクト資材として固定・管理する。パッチの省略、別版への差替え、実行時自動フォールバックによる成功扱いは禁止する。

| パッチファイル | 適用対象ライブラリ | 目的・変更内容 | 完全性検証要件 |
| --- | --- | --- | --- |
| `patches/transformers-portable.patch` | `@huggingface/transformers@4.3.1`<br>(`src/backends/onnx.js`, `src/utils/model-loader.js`) | 1. `env.backends.onnx = ONNX_ENV;` 直接参照代入によるスレッド数 (`numThreads: 1`) 設定の完全反映と動的 `blob:` URL 抑止（Node.js ESM 環境での `ERR_UNSUPPORTED_ESM_URL_SCHEME` 回避）<br>2. セッション作成・推論直列化キューの例外連鎖分離（先行失敗による後続ブロッキング防止）<br>3. `return_path` 最適化の無効化（Uint8Array メモリバッファ供給） | `manifests/runtime-lock.json` にてファイルサイズおよび SHA-256 を固定・照合 |
| `patches/transformers-directml.patch` | `@huggingface/transformers@4.3.1`<br>(`src/backends/onnx.js`) | `Symbol.for('onnxruntime')` 注入時にも DirectML デバイス認識を有効化（`supportedDevices.push('dml', 'cpu'); defaultDevices = ['dml'];`）し、GPU テンソル計算を優先実行。CPU への無言のフォールバックを防止 | `manifests/runtime-lock.json` にてファイルサイズおよび SHA-256 を固定・照合 |
| `patches/sqlite-official.patch` | 公式配布資材<br>(`sqlite3-node.mjs`) | 上流 CAPI 文字列バインドの不具合修正（`Array.isArray(text)` 判定への訂正、`allocCString(text, true)`） | `manifests/runtime-lock.json` にてファイルサイズおよび SHA-256 を固定・照合 |

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

### 4.1 ビルド入力資材（downloads/）の検証

`scripts/download-assets.mjs` により、ビルド入力資材の存在・サイズ・SHA-256・内容妥当性を機械的に検証する。

1. **`downloads/sqlite-src-3540100.zip`**:
   - バイトサイズ: 14,899,528 バイト、SHA-256: `387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b`
2. **`downloads/vec1.c`**:
   - SQLite 公式 Fossil URL (`https://sqlite.org/vec1/raw/vec1.c`) への単体アクセスは、Bot 検証機構（Browser Verification）等により HTML が返却される場合がある。スクリプトによる取得時はレスポンスの Content-Type および先頭バイト（`<!DOCTYPE`, `<html`）を検査し、HTML 誤取得を防止する。
   - `sqlite-src-3540100.zip` に同梱されている `sqlite-src-3540100/ext/vec1/vec1.c` から展開・抽出することを標準手順とし、以下の完全性を検証する：
     - バイトサイズ: 378,128 バイト
     - SHA-256: `a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9`
     - 必須マクロ: `#define VEC1_VERSION "0.8"` が含まれていること
3. **`downloads/sqlite-wasm-ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a.tar.gz`**:
   - バイトサイズ: 1,221,483 バイト、SHA-256: `8a428f3330278c96073c6afda8d8a51921a18a330000f99645c5d7051409a795`

### 4.2 推論モデル資材の完全性検証と資材ゲート

1. **マニフェストによる静的完全性検証**:
   - `scripts/assets/lock-model.ts`（`npm run lock:model`）および `scripts/assets/lock-assets.ts`（`npm run lock-assets`）により、固定リビジョン `daa72c51243991dfcaf9f9137d2c573d8f7790c0` に対応する正準マニフェスト `manifests/embeddinggemma2-q4.json` を生成・ロックする。
   - `scripts/download-assets.mjs` は、同マニフェストの定義に従って全 11 モデル資材のファイル存在、ファイルサイズ、SHA-256 を機械的に照合し、不整合時は再取得・異常停止を行う。
   - 公式 Hugging Face API とのメタデータ照合のみでは製品資材ゲートの成功とはみなさず、製品内マニフェスト `manifests/embeddinggemma2-q4.json` との決定論的照合を完了条件とする。

2. **実資材統合試験ゲート (G05 実資材ゲート)**:
   - `npm run test:assets`（`test/integration/test-assets.ts`）は、製品コード（`src/runtime-assets/model-contract.ts`、`src/sqlite/node-model-cache.ts`）整備後に実行される G05 受入ゲートである。
   - 単にマニフェストファイルが存在するだけでなく、実ローカルモデルサーバー（`test/integration/local-model-server.ts`）を起動し、実バイトによるオンラインキャッシュ取得、オフライン整合性検証、破損資材の検知・拒否・修復、並行取得排他、非対象ファイル保護を検証する。全 11 モデル資材の正確な SHA-256 ダイジェストおよびファイルサイズが一致しない場合、推論初期化を中止する。

### 4.3 上流パッチ資材の完全性検証とビルド契約

1. **パッチ完全性ロック契約**:
   - 推論ビルド (`scripts/build/inference.ts`) および製品パッケージビルド (`scripts/build/package.ts`) は、実行時に `patches/` ディレクトリ配下の各パッチファイルの存在、ファイルサイズ、SHA-256 ダイジェストを機械的に照合する。
   - 正準ランタイムロックファイル `manifests/runtime-lock.json`（および `dist/runtime-lock.json`）の `patches` フィールドに、全 3 パッチのハッシュ値を確定・記録する。
   - パッチの欠落、内容改変、未適用、別版への差し替え、実行時自動フォールバックによる推論の代行は `E_ASSET_INTEGRITY` またはビルド中断とし、成功扱いにしない。
2. **パッチ適用検証**:
   - `scripts/build/inference.ts` は、`git apply --unidiff-zero --ignore-space-change --ignore-whitespace` コマンドを用いてステージング領域へ決定論的にパッチを適用する。
   - パッチ適用後の作業ツリーよりエクスポートコードをバンドルし、生成されるバンドル成果物（Node Wasm CJS、ブラウザ Wasm/WebGPU ESM、DirectML CJS）が所定の境界条件を満たすことを単体テストおよび実推論テスト（Wasm パリティ、DirectML 実行プロバイダー確認等）により検証する。
