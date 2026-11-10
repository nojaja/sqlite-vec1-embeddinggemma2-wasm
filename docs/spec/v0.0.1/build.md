# v0.0.1 ビルド仕様

## 1. ビルド概要

本プロジェクトのビルドは、以下の 2 段階で構成される（ビルド前に `node scripts/download-assets.mjs` および `npm run lock-assets` により入力資材および `manifests/embeddinggemma2-q4.json` が完全に検証・固定されていること）：
1. **上流資材再生成**: SQLite 3.54.1 フルソース（`sqlite-src-3540100.zip`）および `vec1.c`（version 0.8）を入力とし、Emscripten SDK（`emscripten/emsdk:6.0.8`）環境を用いて C 言語レベルで静的組み込み（static auto-extension）した公式互換 Wasm モジュール群（8 ファイル）を生成する。
2. **製品パッケージビルド**: 生成された SQLite 資材、ONNX Runtime、および Transformers.js を入力とし、TypeScript/esbuild を用いて高信頼な Node.js / ブラウザ向け配布パッケージを決定論的に生成する。

---

## 2. SQLite 再生成仕様 (`docker/sqlite-runtime-build`)

公式配布のデモアーカイブ単体の Wasm には vec1 拡張が含まれていないため、隔離 Linux x64 コンテナ環境において以下の手順で SQLite 3.54.1 + vec1 0.8 組み込み Wasm を生成する。ビルドコンテナおよびホスト deb 依存関係の詳細要件は [linux-toolchain.md](linux-toolchain.md) を参照すること。
ホスト環境からは `npm run build:sqlite`（`node scripts/build/sqlite-runtime.ts`）を実行することで、`docker/sqlite-runtime-build` 環境でのコンテナビルド・抽出・完了検証が一貫して自動実行される。

### 2.0 再生成環境資材 (`docker/sqlite-runtime-build`)
- `docker/sqlite-runtime-build/Dockerfile`: `emscripten/emsdk:6.0.8` をベースとするビルドコンテナイメージ
- `docker/sqlite-runtime-build/build-sqlite.sh`: ホストツール展開、ソースパッチ適用、configure / make、成果物抽出・検証を実行するビルドスクリプト
- `docker/sqlite-runtime-build/sqlite3_wasm_extra_init.c`: vec1 拡張および C 言語版 `DISTANCE` 関数を全 DB 接続へ自動登録する Wasm 初期化フック
- `docker/sqlite-runtime-build/verify-sqlite.mjs`: 生成資材の `vec1_info()`、`DISTANCE`、768 次元 CRUD、`quick_check` を検証する完了検査スクリプト

### 2.1 入力資材と環境
- **ビルドコンテナ環境**: `emscripten/emsdk:6.0.8`（Linux x64、詳細は [linux-toolchain.md](linux-toolchain.md)）
- **SQLite フルソース**: `downloads/sqlite-src-3540100.zip`（VERSION=3.54.1、configure、ext/wasm/GNUmakefile を含む。サイズ: 14,899,528 バイト、SHA-256: `387e7f6cad4797b17848c07d453dc6606917bb356a6cfe5a3abafd38c240c71b`）
- **vec1 C ソース**: `downloads/vec1.c`（`sqlite-src-3540100.zip` の `sqlite-src-3540100/ext/vec1/vec1.c` から展開・抽出、または公式 vec1 0.8 C ソース。version 0.8 Scalar single-threaded。サイズ: 378,128 バイト、SHA-256: `a38c62274093bec34631831371ad433703d6dde7fa9ecd6088da4ed33d4a61f9`、`#define VEC1_VERSION "0.8"`。単体 URL 取得時の Browser Verification による HTML 誤取得・誤配置を防止する完全性検証必須）

### 2.2 ソース構成およびフック
- `ext/wasm/vec1.c` としてソースを配置し、マクロ `#define VEC1_VERSION "0.8"`, `#define VEC1_STATIC 1`, `#define VEC1_THREADS 0` を設定（`scripts/download-assets.mjs` の入力検証および統合テスト `test/integration/test-official-sqlite.ts` が要求する実行時 `SELECT vec1_info()` の返却値 `"version 0.8 (Scalar, single-threaded)"` と一致させる）。
- 単一スレッドビルド（`#define VEC1_THREADS 0`）時、上流 `vec1.c` の `vec1KMeansInitOne` 関数内で `#if VEC1_THREADS` ガード外から `pQueue->nWorker` を参照して発生するコンパイルエラー（`no member named 'nWorker' in 'struct Vec1TaskQueue'`）を解消するため、作業コピー `ext/wasm/vec1.c` の `vec1KMeansInitOne` 内における `pQueue->nWorker` 参照を単一スレッド定数 `1` に置換する。
- `ext/wasm/sqlite3_wasm_extra_init.c` を作成し、`sqlite3_auto_extension((void(*)(void))sqlite3_extension_init)` により公式 vec1 の初期化関数を全 DB 接続へ自動登録。

### 2.3 C レベル限定互換変更
1. **vec1 savepoint 再入保護**: `vec1Savepoint`、`vec1Release`、`vec1RollbackTo` の対象関数スコープ内に限定して、`Vec1Writer *pWriter = pTab->pWriter` を退避し、NULL なら `SQLITE_OK`、`pTab->pWriter = 0` を `vec1WriterFinish(pWriter, ...)` より先に行う（`vec1Update` 等の他関数内の `vec1WriterFinish` 呼び出しを誤置換しないこと）。
2. **C 言語版 DISTANCE 関数**: 2つの同一バイト長（`dim * 4` バイト。256, 512, 768 次元など各モデルの次元数に対応）の有限 Float32 BLOB を受け取り、倍精度 L2 ノルム正規化を行った上で `vec1CosDist` へ委譲するスカラー関数 `DISTANCE(left, right)` を静的登録（いずれかが NULL の場合は NULL、不適合時は `E_INPUT`）。
3. **JS capi sqlite3_bind_text**: Array 判定・連結の誤変数 `pMem` を `text` へ訂正し、文字列 allocation は `allocCString(text, true)` でポインタと長さを取得。
4. **oo1 built-in trace / step 警告（公式上流実装の維持）**:
   - `oo1` の built-in trace（`__dbTraceToConsole`：Flags `"ct"` 時の `console.log("SQL TRACE #"+(++this.counter), 'via sqlite3@'+c+'['+capi.sqlite3_db_filename(c,null)+']', wasm.cstrToJs(x));`）および `Stmt.step()` 失敗時警告（`sqlite3.config.warn("sqlite3_step() rc=", rc, capi.sqlite3_js_rc_str(rc), "SQL =", capi.sqlite3_sql(this.pointer));`）は、上流 `@sqlite.org/sqlite-wasm`（`ext/wasm/api/sqlite3-api-oo1.c-pp.js`）の公式実装をそのまま維持する。
   - 旧仕様の `SQLITE_TRACE_EVENT` / `SQLITE_STEP_FAILED` への独自置換は行わない（`test/unit/official-runtime.test.ts` が `flags: "ct"` 時の `console.log` に実行 SQL が出力されること、および `step()` 失敗時に `console.warn` が呼び出されることを検証するため。既存の `downloads/sqlite-official/*.mjs` に旧置換が含まれている場合は上流公式実装へ復元する）。
5. **OPFS void 参照**: 上流の未使用 local/catch/flags/lock を void 参照で安全に処理。
6. **STRICT テーブルにおける VECTOR 型ネイティブ受容とパーサー文法拡張**:
   - **Lemon パーサー文法規則拡張 (`src/parse.y`)**: 上流 SQLite Lemon パーサーは型宣言の引数として数値（`signed`）しか受理しないため、第2引数にモデル名文字列や識別子を含む宣言（例: `VECTOR(768, 'embeddinggemma-2')`）が文法エラーとなる。なお、上流 `src/parse.y` では `%token_class ids ID|STRING.` として `ids` が識別子と文字列リテラルの双方を包含しているため、`STRING` 個別規則と `ids` 規則を同時に追加すると Lemon ジェネレータで reduce/reduce 競合（`1 parsing conflicts`）が発生する。これを回避するため、`src/parse.y` の `typetoken` 規則には `typetoken(A) ::= typename(A) LP signed COMMA ids RP(Y). { A.z = A.z; A.n = (int)(&Y.z[Y.n] - A.z); }` の 1 規則を追加し、競合 0 件で文字列リテラル・識別子の双方を受理する `parse.c` / `parse.h` を生成する。
   - **カラム型登録とアフィニティ解決 (`src/build.c` / `sqlite3.c`)**: `sqlite3AddColumn` および `sqlite3AffinityType` において、型名先頭が `VECTOR`（case-insensitive）の列を `SQLITE_AFF_BLOB` アフィニティとして解決し、完全な型宣言文字列（例: `VECTOR(768, 'embeddinggemma-2')`）を `zType` に保持（`COLFLAG_HASTYPE` および `COLTYPE_CUSTOM` を維持し `PRAGMA table_info` が `"BLOB"` へ上書きされるのを防ぐ）。
   - **STRICT 列型検証の受容と BLOB 型制約 (`src/build.c` / `src/vdbe.c` / `sqlite3.c`)**: `sqlite3EndTable` の `TF_Strict` 検証において、型名先頭が `VECTOR`（case-insensitive）である列を未知の型エラーとせず受容。実行時は `src/vdbe.c` の `OP_TypeCheck` において `eType == COLTYPE_CUSTOM && pCol->affinity == SQLITE_AFF_BLOB` の列に `COLTYPE_BLOB` と同等の型検査を適用し、BLOB（および NULL）以外のデータ型（INTEGER, REAL, TEXT）の代入を拒否する。
   - これにより、TypeScript 側の DDL 前処理・文字列置換を完全に排除し、低レベル CAPI を含む全実行経路で `VECTOR` 型 DDL のネイティブ受理、`PRAGMA table_info` / `sqlite_schema` での完全宣言文字列保持、および再オープン後の永続性を保証する。

### 2.4 ビルドコマンドと生成成果物
- `./configure --disable-readline --disable-tcl`
- `make sqlite3.c` 実行前に、`src/parse.y` への Lemon 文法規則追加、`src/build.c` および `src/vdbe.c` へのパッチを適用し、Lemon による再生成を経て `make sqlite3.c` により amalgamation を生成
- 生成された `sqlite3.c` における STRICT VECTOR 型パッチおよびアフィニティ解決の整合性を検証・補正
- `cd ext/wasm && make -j2 npm bin.wasm-opt=`（Emscripten 最適化を維持しつつ追加 wasm-opt を無効化）
- 生成された `npm-bundle.zip` より以下の 8 ファイルを `downloads/sqlite-official/` へ配置（ホスト側の既存ファイルが読み取り専用属性 `0444` 等を持つ場合でも `EACCES` とならないよう、コピー前に書き込み権限付与 `chmod u+w` または既存ファイル削除を行う）：
  - `sqlite3.wasm` (SQLite 3.54.1 + vec1 0.8 組み込み)
  - `sqlite3-node.mjs`
  - `sqlite3-bundler-friendly.mjs`
  - `sqlite3.mjs`
  - `sqlite3-opfs-async-proxy.js`
  - `sqlite3-worker1.mjs`
  - `sqlite3-worker1-bundler-friendly.mjs`
  - `sqlite3-worker1-promiser.mjs`
- **完了検証**: 同梱 Node.js（`verify-sqlite.mjs`）により `vec1_info()` が `"version 0.8 (Scalar, single-threaded)"` を返し、`DISTANCE`、`VECTOR(768, 'embeddinggemma-2') STRICT` DDL の CAPI 直接実行、STRICT BLOB 型制約（TEXT 等の代入拒否）、`PRAGMA table_info` 型文字列保持、再オープン後スキーマ復元、768 次元 flat/CRUD、`quick_check` が PASS することを確認して完了とする。

---

## 3. 製品パッケージビルド工程

製品ビルドは `npm run build`（`node scripts/build/package.ts`）により、以下の 5 段階で自動実行される。

```
[1/5] 推論ビルド (scripts/build/inference.ts)
  ├─ ORT Wasm ランタイムの dist/ort への配置
  ├─ 画像コーデック Wasm の dist/image への配置
  └─ Transformers.js パッチ適用およびバンドル (Node / Browser / DirectML)
[2/5] 公式 SQLite 資材の dist/ へのコピー
  ├─ sqlite3.wasm (SQLite 3.54.1 + vec1 0.8)
  └─ 公式ローダー群 (sqlite3-node.mjs, sqlite3-bundler-friendly.mjs 等)
[3/5] 製品エントリポイントおよびサンプルのバンドル (esbuild)
  ├─ dist/node/index.{js,mjs} (Node エントリ)
  ├─ dist/index-browser.mjs (ブラウザエントリ)
  ├─ dist/workers/inference-node.js (Node 同期ブリッジ Worker)
  └─ dist/workers/inference-browser.mjs (ブラウザ推論 Worker)
[4/5] TypeScript 型定義ファイルの生成 (tsc --emitDeclarationOnly)
  └─ dist/index.d.ts, dist/index-browser.d.ts
[5/5] ランタイムロック・ビルドレポートの生成
  └─ dist/runtime-lock.json
```

---

## 4. 推論ビルド仕様 (`scripts/build/inference.ts`)

推論ビルドは、推論 Worker が利用するバイナリおよびライブラリを `dist/` 配下に構成する。

### 4.1 ORT ランタイムおよび画像コーデック Wasm の配置
- `node_modules/onnxruntime-web/dist/` より、以下のファイルを `dist/ort/` へ配置する：
  - `ort-wasm-simd-threaded.jsep.mjs`
  - `ort-wasm-simd-threaded.jsep.wasm`
  - `ort-wasm-simd-threaded.jspi.mjs`
  - `ort-wasm-simd-threaded.jspi.wasm`
- `@jsquash` より以下の画像コーデック Wasm を `dist/image/` へ配置する：
  - `jpeg.wasm` (`@jsquash/jpeg`)
  - `png.wasm` (`@jsquash/png`)
  - `resize.wasm` (`@jsquash/resize`)

### 4.2 Transformers.js および SQLite 公式資材のパッチ仕様 (`patches/`)
`node_modules/@huggingface/transformers`（固定バージョン 4.3.1）をステージング作業領域（`.build/staging/transformers-portable` および `.build/staging/transformers-directml`）にコピーし、`git apply --unidiff-zero --ignore-space-change --ignore-whitespace` コマンドにより以下のパッチを適用して各推論バンドルを生成する。すべてのパッチファイル（`patches/*.patch`）は **UTF-8（BOM なし）・LF 改行・ファイル末尾 LF 必須** とする。パッチファイルが存在しない場合や適用に失敗した場合は即座にビルドを中止する。パッチの省略、別版への差し替え、実行時自動フォールバックによる成功扱いは禁止する。

1. **Portable パッチ (`patches/transformers-portable.patch`)**:
   - **適用対象**: `@huggingface/transformers@4.3.1` の `src/backends/onnx.js`, `src/utils/model-loader.js`, `src/models/session.js`
   - **Node.js ESM 動的 URL 回避 & スレッド数設定の完全反映 (`src/backends/onnx.js`)**:
     - Node portable 経路から `onnxruntime-node` を除去し、Symbol 注入または Web/Node Wasm 環境とも `supportedDevices = ['wasm']; defaultDevices = ['wasm'];` に統一する。
     - 上流コードの `env.backends.onnx = { ...ONNX_ENV, setLogLevel };` によるオブジェクト浅い複製を排除し、`ONNX_ENV.setLogLevel = setLogLevel; env.backends.onnx = ONNX_ENV;` により直接参照結合を行う。これにより、Node.js 実行環境で外部から注入される `env.backends.onnx.wasm.numThreads = 1` が ONNX Runtime Web 内部へ確実に伝播し、マルチスレッド時に発生する動的 `blob:` URL (`URL.createObjectURL`) によるワーカーインポート（Node ESM ローダーの `ERR_UNSUPPORTED_ESM_URL_SCHEME` 例外）を完全に抑止する。
   - **例外連鎖の分離（プロミスチェーンの独立性保護） (`src/backends/onnx.js`)**:
     - セッション作成キュー (`webInitChain`) および推論実行キュー (`webInferenceChain`) において、`apis.IS_WEB_ENV` 限定条件を外して Node portable 経路でも直列化を有効化し、かつ先行タスクの拒否（rejection）が後続タスクへ連鎖しないよう `const run = webInitChain.then(create, create); webInitChain = run.then(() => undefined, () => undefined); return run;` および `const run = webInferenceChain.then(execute, execute); webInferenceChain = run.then(() => undefined, () => undefined); return run;` へ書き換える。
   - **メモリバッファ供給の維持（`return_path` 最適化の無効化） (`src/utils/model-loader.js`)**:
     - `const return_path = apis.IS_NODE_ENV;` を `const return_path = false;` に変更し、常に入力モデル資材を Uint8Array メモリバッファおよび externalData（`{path, data}`）として供給する。
   - **セッション実行エラー時の入力テンソル出力抑止 (`src/models/session.js`)**:
     - `console.error(\`An error occurred during model execution: "${e}".\`); console.error('Inputs given to model:', reduced);` の 2 行を削除し、例外発生時に入力データ・テンソル内容が標準エラーへ漏洩しないようにする。

2. **DirectML パッチ (`patches/transformers-directml.patch`)**:
   - **適用対象**: `@huggingface/transformers@4.3.1` の `src/backends/onnx.js`, `src/models/session.js`
   - **Symbol 注入時の DirectML デバイス認識有効化と優先実行 (`src/backends/onnx.js`)**:
     - グローバルシンボル `Symbol.for('onnxruntime')` 注入時および Node 環境下のデバイス判定ロジックにおいて、`supportedDevices = ['dml']; defaultDevices = ['dml'];`（または `supportedDevices.push('dml', 'cpu'); defaultDevices = ['dml'];`）を設定し、Windows x64 環境下で DirectML (`dml`) を優先デバイスとして選択させる。CPU への無言のフォールバックを禁止し、DirectML が利用できない環境では環境エラー（`E_ENVIRONMENT`）として厳格に分離する。
     - `ONNX_ENV.setLogLevel = setLogLevel; env.backends.onnx = ONNX_ENV;` による直接参照結合、および `webInitChain` / `webInferenceChain` の例外連鎖分離（`run.then(() => undefined, () => undefined)`）も同様に適用する。
   - **セッション実行エラー時の入力テンソル出力抑止 (`src/models/session.js`)**:
     - Portable パッチと同様に `src/models/session.js` の `console.error` 2 行を削除する。

3. **SQLite 公式ローダーパッチ (`patches/sqlite-official.patch`)**:
   - **適用対象**: `downloads/sqlite-official/sqlite3-node.mjs`（および同等の公式ローダー JS）
   - **CAPI `sqlite3_bind_text` の配列判定と UTF-8 文字列長算出の修正**:
     - `else if(Array.isArray(pMem)) text = text.join("");` の誤変数 `pMem` を `else if(Array.isArray(text)) text = text.join("");` に修正し、`const [pStr, n] = allocCString(text, true);` で確保したバイト長 `n` を `sqlite3_bind_text(pStmt, ndx, pStr, n, ...)` へ渡す変更を記録する。

### 4.3 生成される推論バンドル
- `dist/vendor/transformers-portable-node.js`: Node.js Wasm 向け CJS バンドル（`node:url` pathToFileURL banner 注入、画像 codec は自前 `src/inference/image.ts` へ解決）
- `dist/vendor/transformers-portable.mjs`: ブラウザ Wasm/WebGPU 向け ESM バンドル（Node builtin モジュールを空スタブ解決、画像 codec は自前 `src/inference/image.ts` へ解決）
- `dist/vendor/transformers-directml-node.js`: Node.js DirectML 向け CJS バンドル（`onnxruntime-node` は external 解決、画像 codec は自前 `src/inference/image.ts` へ解決）

---

## 5. 製品パッケージバンドル仕様 (`scripts/build/package.ts`)

### 5.1 エントリポイント構成

| 出力ファイル | フォーマット | ターゲット環境 | 備考 |
| :--- | :---: | :---: | :--- |
| `dist/index.bundle.js` | CJS | 汎用メイン | `import.meta.url` ポリフィル注入 |
| `dist/node/index.js` | CJS | Node.js (require) | `node-file` VFS 初期化、Worker 接続 |
| `dist/node/index.mjs` | ESM | Node.js (import) | CJS エントリのラッパー |
| `dist/index-browser.mjs` | ESM | ブラウザ | 専用 Worker / OPFS SAH Pool 連携 |
| `dist/workers/inference-node.js` | CJS | Node Worker | Atomics 同期ブリッジおよび推論実行 |
| `dist/workers/inference-browser.mjs`| ESM | ブラウザ Worker | WebGPU adapter 注入および推論実行 |

### 5.2 CJS 出力における `import.meta.url` の解決
公式 `sqlite3-node.mjs` は内部で `createRequire(import.meta.url)` を使用して Wasm バイナリ等を解決する。
esbuild で CJS 形式でバンドルする際、以下の設定を施す：
- `define: { "import.meta.url": "__svw_import_meta_url" }`
- `banner: { js: "const __svw_import_meta_url = require('url').pathToFileURL(__filename).href;" }`
これにより、CJS 環境下でも `import.meta.url` が常に有効な `file:///` URL として動作する。

### 5.3 Wasm ファイル配置と自動検出 (`locateFile`)
`dist/sqlite3.wasm` はパッケージルートおよび各エントリポイントから参照される。
`src/official/node.ts` の `locateFile` オプションにより、カレントディレクトリ、`dist/`、またはモジュール相対パスから実在する絶対パスを自動検出して SQLite ランタイムへ渡す。

### 5.4 ランタイムロックとパッチ完全性記録 (`manifests/runtime-lock.json`)
ビルド工程の最終段階（`[5/5]`）において、`scripts/build/package.ts` は使用した全資材およびパッチファイルの完全性を固定するロックファイル `manifests/runtime-lock.json`（および `dist/runtime-lock.json`）を生成する。
- 必須記録パッチ（`patches`）:
  - `patches/transformers-portable.patch`: バイト数および SHA-256
  - `patches/transformers-directml.patch`: バイト数および SHA-256
  - `patches/sqlite-official.patch`: バイト数および SHA-256
- パッチファイルが存在しない、あるいは SHA-256 が一致しない場合はビルドを即座にエラー停止（exit code 1）とする。各環境での決定論的再現性を保証し、未検証パッチやパッチ欠落のまま配布物が生成されることを防ぐ。

---

## 6. 型定義ファイルの生成

公式 `@sqlite.org/sqlite-wasm@3.54.1-build1` の型定義（`index.d.mts`）を基盤とし、TypeScript コンパイラおよび型合成スクリプトを用いて型宣言ファイルを生成する。
- 必須型エクスポート: 公式の `Sqlite3Static`, `Database`, `PreparedStatement`, `CAPI`, `SqlValue`, `BindingSpec`, `sqlite3Worker1Promiser` および製品固有の `ProductSqlite3`, `ProductInitOptions`, `EmbeddingOptions`, `EmbeddingControl`
- 生成成果物:
  - `dist/index.d.ts` (Node / メイン公開型定義)
  - `dist/index.d.mts` (ESM 向け型定義)
  - `dist/index-browser.d.ts` (ブラウザ公開型定義)

---

## 7. 配布成果物構成および npm 設定

最終配布パッケージ（npm tarball）に含まれるファイル構成および npm 設定：
- パッケージ名: `@nojaja/sqlite-vec1-embeddinggemma2-wasm`
- 公開設定: `"private": false`、`"publishConfig": { "access": "public" }`
- 同梱ファイル (`files`):
  - `dist/`: バンドル済み JavaScript、Wasm バイナリ、型定義 (`index.d.ts`, `index.d.mts` 等)
- `manifests/`: `embeddinggemma2-q4.json`
- `README.md`: 利用ドキュメント
  - `LICENSE`: ライセンス表示
  - `package.json`: 公式互換エクスポート定義およびメタデータ
