# v0.0.1 ビルド仕様

## 1. ビルド概要

本プロジェクトのビルドは、公式ビルド済み完成資材（SQLite 3.54.1 + vec1 0.7 組み込み Wasm/ローダー、および ONNX Runtime）を入力とし、TypeScript/esbuild を用いて高信頼な Node.js / ブラウザ向け配布パッケージを決定論的に生成する。

検証済みの完成バイナリおよび JavaScript/TypeScript コードのバンドル・型定義生成に特化することで、クロスプラットフォーム（Windows / Linux / ブラウザ）で高速かつ安定したビルドを実現する。

---

## 2. ビルド工程

ビルドは `npm run build`（`node scripts/build/package.ts`）により、以下の 5 段階で自動実行される。

```
[1/5] 推論ビルド (scripts/build/inference.ts)
  ├─ ORT Wasm ランタイムの dist/ort への配置
  ├─ 画像コーデック Wasm の dist/image への配置
  └─ Transformers.js パッチ適用およびバンドル (Node / Browser / DirectML)
[2/5] 公式 SQLite 資材の dist/ へのコピー
  ├─ sqlite3.wasm (SQLite 3.54.1 + vec1 0.7)
  └─ 公式ローダー群 (sqlite3-node.mjs, sqlite3-bundler-friendly.mjs 等)
[3/5] 製品エントリポイントおよびサンプルのバンドル (esbuild)
  ├─ dist/node/index.{js,mjs} (Node エントリ)
  ├─ dist/browser/index.mjs (ブラウザエントリ)
  ├─ dist/workers/inference-node.js (Node 同期ブリッジ Worker)
  └─ dist/workers/inference-browser.mjs (ブラウザ推論 Worker)
[4/5] TypeScript 型定義ファイルの生成 (tsc --emitDeclarationOnly)
  └─ dist/index.d.ts, dist/index-browser.d.ts
[5/5] ランタイムロック・ビルドレポートの生成
  └─ dist/runtime-lock.json
```

---

## 3. 推論ビルド仕様 (`scripts/build/inference.ts`)

推論ビルドは、推論 Worker が利用するバイナリおよびライブラリを `dist/` 配下に構成する。

### 3.1 ORT ランタイムおよび画像コーデック Wasm の配置
- `node_modules/onnxruntime-web/dist/` より、以下のファイルを `dist/ort/` へ配置する：
  - `ort-wasm-simd-threaded.jsep.mjs`
  - `ort-wasm-simd-threaded.jsep.wasm`
  - `ort-wasm-simd-threaded.jspi.mjs`
  - `ort-wasm-simd-threaded.jspi.wasm`
- `@jsquash` より以下の画像コーデック Wasm を `dist/image/` へ配置する：
  - `jpeg.wasm` (`@jsquash/jpeg`)
  - `png.wasm` (`@jsquash/png`)
  - `resize.wasm` (`@jsquash/resize`)

### 3.2 Transformers.js のパッチ適用とバンドル
`node_modules/@huggingface/transformers` を作業領域にコピーし、以下のパッチを適用してバンドルを生成する：

1. **Portable パッチ (`patches/transformers-portable.patch`)**:
   - Node.js 環境での Wasm 実行時、スレッド数設定がデフォルトのままだと `onnxruntime-web` が動的 blob URL (`blob:...`) によるワーカーインポートを試みて Node.js の ESM ローダーで例外となる問題を防止。
   - `env.backends.onnx = ONNX_ENV;` により直接参照を保持し、外部からの `numThreads: 1` 注入を内部へ確実に反映させる。
   - 直列化プロミスチェーンにおける例外連鎖を防止（前の推論失敗が後続推論をブロックしないよう分離）。
2. **DirectML パッチ (`patches/transformers-directml.patch`)**:
   - `Symbol.for('onnxruntime')` 注入時にも `supportedDevices.push('dml', 'cpu'); defaultDevices = ['dml'];` を設定し、DirectML デバイス認識を有効化。

### 3.3 生成される推論バンドル
- `dist/vendor/transformers-portable-node.js`: Node.js Wasm 向け CJS バンドル
- `dist/vendor/transformers-portable.mjs`: ブラウザ Wasm/WebGPU 向け ESM バンドル (Node builtin モジュールを空スタブ解決)
- `dist/vendor/transformers-directml-node.js`: Node.js DirectML 向け CJS バンドル (`onnxruntime-node` は external 解決)

---

## 4. 製品パッケージバンドル仕様 (`scripts/build/package.ts`)

### 4.1 エントリポイント構成

| 出力ファイル | フォーマット | ターゲット環境 | 備考 |
| :--- | :---: | :---: | :--- |
| `dist/index.bundle.js` | CJS | 汎用メイン | `import.meta.url` ポリフィル注入 |
| `dist/node/index.js` | CJS | Node.js (require) | `node-file` VFS 初期化、Worker 接続 |
| `dist/node/index.mjs` | ESM | Node.js (import) | CJS エントリのラッパー |
| `dist/browser/index.mjs` | ESM | ブラウザ | 専用 Worker / OPFS SAH Pool 連携 |
| `dist/workers/inference-node.js` | CJS | Node Worker | Atomics 同期ブリッジおよび推論実行 |
| `dist/workers/inference-browser.mjs`| ESM | ブラウザ Worker | WebGPU adapter 注入および推論実行 |

### 4.2 CJS 出力における `import.meta.url` の解決
公式 `sqlite3-node.mjs` は内部で `createRequire(import.meta.url)` を使用して Wasm バイナリ等を解決する。
esbuild で CJS 形式でバンドルする際、以下の設定を施す：
- `define: { "import.meta.url": "__svw_import_meta_url" }`
- `banner: { js: "const __svw_import_meta_url = require('url').pathToFileURL(__filename).href;" }`
これにより、CJS 環境下でも `import.meta.url` が常に有効な `file:///` URL として動作する。

### 4.3 Wasm ファイル配置と自動検出 (`locateFile`)
`dist/sqlite3.wasm` はパッケージルートおよび各エントリポイントから参照される。
`src/official/node.ts` の `locateFile` オプションにより、カレントディレクトリ、`dist/`、またはモジュール相対パスから実在する絶対パスを自動検出して SQLite ランタイムへ渡す。

---

## 5. 型定義ファイルの生成

公式 `@sqlite.org/sqlite-wasm@3.54.1-build1` の型定義（`index.d.mts`）を基盤とし、TypeScript コンパイラおよび型合成スクリプトを用いて型宣言ファイルを生成する。
- 必須型エクスポート: 公式の `Sqlite3Static`, `Database`, `PreparedStatement`, `CAPI`, `SqlValue`, `BindingSpec`, `sqlite3Worker1Promiser` および製品固有の `ProductSqlite3`, `ProductInitOptions`, `EmbeddingOptions`, `EmbeddingControl`
- 生成成果物:
  - `dist/index.d.ts` (Node / メイン公開型定義)
  - `dist/index.d.mts` (ESM 向け型定義)
  - `dist/index-browser.d.ts` (ブラウザ公開型定義)

---

## 6. 配布成果物構成および npm 設定

最終配布パッケージ（npm tarball）に含まれるファイル構成および npm 設定：
- パッケージ名: `@nojaja/sqlite-vec1-embeddinggemma2-wasm`
- 公開設定: `"private": false`、`"publishConfig": { "access": "public" }`
- 同梱ファイル (`files`):
  - `dist/`: バンドル済み JavaScript、Wasm バイナリ、型定義 (`index.d.ts`, `index.d.mts` 等)
- `manifests/`: `embeddinggemma2-q4.json`
- `README.md`: 利用ドキュメント
  - `LICENSE`: ライセンス表示
  - `package.json`: 公式互換エクスポート定義およびメタデータ
