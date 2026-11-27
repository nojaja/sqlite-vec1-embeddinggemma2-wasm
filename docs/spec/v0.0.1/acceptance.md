# v0.0.1 受入条件

## 1. 受入方針と検証順序

本プロジェクトの品質保証は、**「既存のテストコードを変更することなく、すべてのテストが green になること」** を厳格な受入基準とする。

検証は以下の順序で進行する：
1. **固定資材の配置点検と完全性ロック**: `node scripts/download-assets.mjs`（`manifests/embeddinggemma2-q4.json` 不在時は内部で `scripts/assets/lock-model.ts` を自動実行）および `npm run lock-assets` により、全 11 モデル資材、正準マニフェスト（`manifests/embeddinggemma2-q4.json`）、公式 SQLite/vec1 ビルド入力資材、および Debian bookworm ツールチェーン `.deb` パッケージ群（77 + 13 個）の存在と完全性を確認・ロックする。
2. **製品ビルド**: `npm run build` により、推論バンドル・公式 SQLite 資材（`dist/sqlite3-opfs-async-proxy.js` および `dist/workers/sqlite3-opfs-async-proxy.js` の双方を含む）・製品エントリポイント・型定義が欠落なく生成されることを確認する。
3. **実資材統合試験ゲート (G05)**: 製品モジュール（`src/runtime-assets/model-contract`、`src/sqlite/node-model-cache`）連携のもと `npm run test:assets` を実行し、実モデルのオンライン取得、オフラインキャッシュ、破損拒否・修復、並行取得排他が PASS することを確認する。
4. **単体テストスイート**: `npm test` により、36 ファイル・208 テストすべてが PASS することを確認する。
5. **統合テスト・機能ゲート**:
   - `npm run test:sqlite`: 公式 UDF（`DISTANCE`, `gemma_model_info`）、推論無効時の `embedding` / `embedding_query` UDF 未登録（`no such function`）および `gemma_model_info()` の `{"ready":false}` 返却、`_svw_meta` 非作成要件、vec1 テーブル動作（`vec1_info()` が `"version 0.8 (Scalar, single-threaded)"` を返すこと）
   - `npm run test:storage`: `node-file` VFS CRUD、排他ロック、クラッシュ復旧、メタデータ保護
   - `npm run test:search`: 実モデル検索、キャッシュ増分整合性 (`actualInference`)
   - `npm run test:embedding-cache`: ステートメントキャッシュ分離、100行評価と実推論回数検証
   - `npm run test:sql-bridge`: `sqlite3_progress_handler` によるタイムアウト (`E_TIMEOUT`)・キャンセル (`E_CANCELLED`)
   - `npm run test:inference:browser`: MS Edge 上での Wasm 実推論 (クエリ/画像)
   - `npm run test:inference:node:directml`: 100回連続クエリ、117,362 DMLノード実行、Wasm 完全パリティ
6. **E2E 実推論テスト**: `npm run test:e2e` により、実推論（Wasm CPU、DirectML GPU、Edge WebGPU、仕様契約クエリ）の 4 スイートすべてが合格することを確認する。
7. **アーキテクチャ依存関係監査**: `npm run depcruise` により、モジュール間の境界違反が 0 件であることを確認する。

テストの入力、期待値、異常系、期限と品質閾値を安易に変更して通過させてはならない。

---

## 2. 同梱試験の範囲

unit は 36 ファイル、E2E は 4 ファイル、統合テストを含め `test/` 配下に配置されている。
- 列挙: `npm test -- --listTests`
- 単体テスト実行: `npm test`
- 単体カバレッジ: `npm run test:ci`
- E2E テスト実行: `npm run test:e2e`

---

## 3. 全unit suite対応表

以下のファイルは `test/unit/` 相対。すべて入力・期待値・異常系/境界を維持して合格させる。

| suite | 主な受入 assertion |
| :--- | :--- |
| `browser-worker-controller.test.ts` | READY 前 warm-up、要求直列化、世代不一致、未知 control、manifest ヘッダ検証（非空 assets 時の `validateModelAssets` と unit fixture 空配列許容）、`inferencePort` の `start`/`close` 検証（`postMessage` 非必須）、失敗/close 後の資源回収、health |
| `browser-worker-build.test.ts` | browser Worker/entry の Node/native 非到達、DirectML Worker の external native |
| `browser-opfs-cache-storage.test.ts` | bounded write、atomic copy commit、path 拒否、Web Lock、abort/close |
| `browser-model.test.ts` | HTTPS/loopback・クロスオリジンCDN許可・危険URL拒否、未知 path miss、HTTP非OK・size/hash検証、CORS/credentials |
| `browser-initialize.test.ts` | 永続 cache 先行、offline fetch 0、codec 上限、WebGPU adapter 取得/失敗 |
| `db-worker.test.ts` | 同期動的次元 (`dim * 4` バイト、例: 512D=2048B / 768D=3072B) copy、`model` 伝播、NULL 送信なし、画像 copy、ID 1..10、cancel/timeout/遅延 |
| `distribution-contract.test.ts` | npm 配布設定、他 dir パス解決、メインスレッド制約緩和、ブラウザ正式推論接続、TypeScript 型互換契約 |
| `directml-vision-graph.test.ts` | 固定元 graph、128 変更、出力 size/hash、元 cache 不変、put 拒否 |
| `directml-runtime.test.ts` | version、4 native 完全 inventory、欠落/余剰/hash/size 不一致拒否 |
| `embedding-quality.test.ts` | text/image 平均と各件、欠落 modality/重複 ID/異次元/NaN/zero 拒否（任意同一次元対応） |
| `image.test.ts` | signature/MIME、容量/寸法/APNG/chunk 終端、gray/alpha/RGB、resize、URL/path 拒否 |
| `inference-engine.test.ts` | query/document/image、token 境界、Float32 shape、tensor dispose、既知画像 error |
| `inference-initialize.test.ts` | env/cache、audio 無効 vision 保持、2 warm-up、失敗 dispose、Wasm/DML session options |
| `inference-worker.test.ts` | envelope/generation/image 変換、SAB publish、固定 numeric error |
| `model-manifest.test.ts` | 汎用マニフェストスキーマ検証（`schemaVersion`, `modelId`, `repository`, `revision`, `profile.dimension`, `assets`）、参照11資材および `ruri-v3` 等任意資材集合、重複/欠落/digest 拒否、license evidence |
| `node-model-cache-flow.test.ts` | persistent 初期化後だけ VerifiedModelCache 消費、再起動 offline |
| `node-model-cache-url.test.ts` | 危険 URL 拒否、loopback integration 許可 |
| `node-persistent-cache-storage.test.ts` | bounded lifecycle、containment/symlink、set 排他 |
| `official-browser-assets.test.ts` | document URL 非依存、package 相対・明示 `workerUrl`/`manifestUrl`/`modelBaseUrl`/`dbWorkerUrl` 解決、外部CDN許可と危険 URL 拒否、`prepareInference` 接続 |
| `official-functions.test.ts` | 動的登録モデル検証（未知モデル名のみ `E_INPUT`、登録済みモデルは許容・伝播）が NULL/READY より先、型/空白/NUL、query/document/title 写像 |
| `official-initialize.test.ts` | 公式 option 転送、embedding 省略 prepare 0、READY 待機、DB close 前拒否、pool pause だけ |
| `official-metadata.test.ts` | 7 key 版/空間（`productVersion: "0.0.3"` 固定、`"0.0.2"` 等の拒否、動的 `dimension`/`dtype` 一致）、backend 非保存、未知 schema/混在拒否 |
| `official-node-entry.test.ts` | main thread 推論初期化許可（E_ENVIRONMENT 拒否の撤廃）、環境情報引継ぎ |
| `official-node-files.test.ts` | ownership 競合、short read ゼロ埋め、fsync/write/reopen、symlink 拒否、temporary 回収 |
| `official-options.test.ts` | 省略、Node main 許可、browser Dedicated Worker 許可、browser main thread 推論指定時の `E_ENVIRONMENT` 早期拒否、matrix、1/1800000 境界、0/NaN/Infinity/unknown 拒否 |
| `official-public-exports.test.ts` | default initializer、browser named `sqlite3Worker1Promiser` および `sqlite3EmbeddingWorkerPromiser`、廃止 API を公開しない |
| `official-runtime.test.ts` | 実 SQLite transactions/NULL、`infer` 未指定時の `embedding`/`embedding_query` UDF 未登録（`no such function`）、公式上流準拠の SQL trace 出力（`flags: "ct"` 時の実行 SQL 出力）および `step()` 失敗時 `console.warn`、2 Stmt authorizer、DIRECTONLY、metadata、DISTANCE |
| `persistent-model-cache.test.ts` | cold stage/ready（初回 `ready.json` 不在時は事前削除なし、既存 `ready.json` 存在時のみ先に削除）、offline 通信 0、corrupt online 修復、明示 recover、別 set/DB 保護 |
| `profile.test.ts` | 768D/512D 等の動的次元 LE 独立 BLOB、shape/NaN/zero 拒否、exact/動的 prefix/NULL、2048 token、本文/title bytes |
| `protocol.test.ts` | 通知先行/待機中 publish、動的次元 (`dim * 4 === payloadLen`、例: 512D=2048B / 768D=3072B) 検証、state 放棄、公開済保護、cancel/期限、不正 header/size |
| `release-audit.test.ts` | 全 severity 0 のみ受理、件数不正/不整合/脆弱性を拒否 |
| `statement-embedding-cache.test.ts` | copy、用途/title/key、10/11 LRU、画像全 bytes、実 32MiB、超過 bypass、NULL/error 非保存 |
| `statement-lifecycle.test.ts` | ROW 保持/DONE/reset 世代、交互接続/Stmt、close/finalize/error、pause 期限/cancel |
| `vector-type-and-model-resolution-spec.test.ts` | VECTOR 型 DDL（Lemonパーサー文法拡張・STRICT BLOB型制約・完全宣言保持）解析、[model] 自動解決（Authorizer `INSERT=18`、`UPDATE=23` および unit fixture 互換 `UPDATE=9` かつ `arg1 && arg2` 非空）、動的プロファイル、ゼロダウンロード、推論事前準備・warm-up保証（省略時ゼロオーバーヘッド） |
| `vector-type-grammar-and-strict.test.ts` | Lemon パーサー文法規則拡張（`ids` トークンクラスによる競合0の文字列/識別子引数受理）、STRICT テーブルでの BLOB 型制約（`OP_TypeCheck` による BLOB 以外拒否）、完全宣言文字列保持・再オープン復元、CAPI 透過投入 |
| `verified-cache.test.ts` | 2 prefix だけ、未知 key、毎 read size/hash、put は同内容だけ |

---

## 4. 公式 API 互換 (9 デモ)

固定公式リポジトリ commit `ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` の全 9 デモを実行し、表示行が一致することを確認する。詳細な検証手順および Parcel 等のバンドラー対応の配慮事項は [sqlite-wasm-compat.md](sqlite-wasm-compat.md) を参照すること。

| demo | bundler | 期待される表示行 |
| :--- | :---: | :--- |
| `main-thread-demo` | vite | `1: Alice`、`2: Bob` |
| `in-worker-demo` | vite | `1: InWorker 1`、`2: InWorker 2` |
| `opfs-demo` | vite | `1: OPFS 1`、`2: OPFS 2` |
| `opfs-wl-demo` | vite | `1: OPFS-WL 1`、`2: OPFS-WL 2` |
| `kvvfs-demo` | vite | `1: kvvfs 1`、`2: kvvfs 2` |
| `sahpool-demo` | vite | `1: Alice`、`2: Bob` |
| `sahpool-webpack-demo` | webpack | `1: Alice`、`2: Bob` |
| `sahpool-parcel-demo` | parcel | `1: Alice`、`2: Bob` |
| `sahpool-rsbuild-demo` | rsbuild | `1: Alice`、`2: Bob` |

---

## 5. E2E 実推論および統合シナリオ受入条件

1. **Node.js Wasm 実推論 (`test/e2e/sql-semantic-search.test.ts`)**:
   - 実モデルを用いた文書 INSERT（`embedding`）、クエリ検索（`embedding_query`）、および `DISTANCE` ソート。
   - セマンティック検索により「猫」に関するクエリで猫の文書が 1 位として抽出されること。
   - オンライン初期化後のオフライン再起動でネットワーク要求が 0 であること。
   - トランザクションロールバック時にベクトルデータが正常にロールバックされること。
2. **Node.js DirectML GPU 実推論 (`test/e2e/sql-semantic-search-directml.test.ts`)**:
   - Windows x64 環境で DirectML 実行プロバイダーが選択され、GPU 上でテンソル計算が実行されること。
   - Wasm 推論結果とのコサイン類似度が `0.999999` 以上の一致（Parity）を達成すること。
3. **ブラウザ WebGPU 実推論・メインスレッド Promiser (`test/e2e/browser-inference.test.ts`)**:
   - MS Edge ブラウザ環境で WebGPU アダプター/デバイスが正常に取得され、テキストクエリおよび画像埋め込みの実推論が完了すること。
   - ブラウザメインスレッドから `initialize({ embedding })` を直接呼び出した場合に初期化時点で `E_ENVIRONMENT` が送出されること。
   - ブラウザメインスレッドから `sqlite3EmbeddingWorkerPromiser({ embedding })` を呼び出し、Dedicated Worker 内の `embedding()` / `embedding_query()` / `DISTANCE()` を含む SQL 実行および `shutdown` が正常完了すること。また、`dist/workers/db-browser.mjs` 起動時に `sqlite3-opfs-async-proxy.js` の 404 / MIME type エラーによる OPFS / OPFS-WL VFS 初期化失敗が発生しないこと。
4. **仕様契約クエリ実推論 (`test/e2e/vector-contract-query.test.ts`)**:
   - `VECTOR(768 , 'embeddinggemma-2') STRICT` テーブル定義が Lemon 文法解析および STRICT 列型検証を通過し、TypeScript 側での置換なしにネイティブ・透過的に作成されること。
   - `PRAGMA table_info` および `sqlite_schema` において型宣言文字列 `VECTOR(768 , 'embeddinggemma-2')` が完全保持されること。
   - STRICT テーブルの型制約として、`VECTOR` 列への BLOB 以外の型（TEXT, INTEGER 等）の INSERT が拒否され、Float32 ベクトル BLOB が正常に受容されること。
   - データベース再オープン後もスキーマから完全な型定義が復元され、モデル自動解決が機能すること。
   - 低レベル CAPI（`sqlite3.capi.sqlite3_exec`）から DDL を直接実行しても文法エラーとならず `SQLITE_OK` で受理されること。
   - `INSERT INTO documents(id,text_data,embedding) VALUES(1,:text,embedding(:text));` によるベクトル埋め込みの生成と保存。
   - `SELECT id,text_data FROM documents ORDER BY DISTANCE(embedding,embedding_query(:query)),id LIMIT 3;` によるコサイン距離順セマンティック検索で期待される文書が最上位に抽出されること。
5. **vec1 ネイティブ仮想テーブル動作の厳格検証要件**:
   E2E および統合テストにおいて、TS/JS 側のエミュレーション・擬似実装（SQL 置換や JS UDF 全探索）を排他し、Wasm 内の C 言語ネイティブ vec1 仮想テーブルモジュールが真に動作していることを以下の 4 重検証により判定・受入する：
   - **モジュール登録検証**: `SELECT count(*) FROM pragma_module_list WHERE name = 'vec1'` が `1` であること（C API `sqlite3_create_module` による登録の証明）。
   - **スキーマ保持検証**: `SELECT sql FROM sqlite_schema WHERE name = 'docs_vec'` が `CREATE VIRTUAL TABLE docs_vec USING vec1(...)` を保持していること（通常テーブルへのすり替えがない証明）。
   - **実行計画（プラン）検証**: ベクトル検索クエリ（`CROSS JOIN docs_vec(q.vector, ...)`）に対して `EXPLAIN QUERY PLAN` を実行し、`detail` に `VIRTUAL TABLE INDEX` または `USING vec1` が含まれること（仮想テーブルインデックス走査の証明）。
   - **CAPI 直接実行検証**: TS の SQL 前処理ラッパーを介さず、低レベル CAPI（`sqlite3.capi.sqlite3_exec`）で直接 `CREATE VIRTUAL TABLE ... USING vec1` を実行し、`SQLITE_OK` で完了すること（Wasm バイナリ単体での vec1 静的組み込みの証明）。
6. **複数埋め込みモデル（`ruri-v3` 等）動的利用検証**:
   - `models` オプションまたは外部/ローカルマニフェストにより `ruri-v3`（512次元）等の他モデルが登録可能であること。
   - `CREATE TABLE ETOM (ID INTEGER PRIMARY KEY, NAME TEXT, DESCRIPTION TEXT, EMBEDDING VECTOR (512, 'ruri-v3'));` が受理され、`embedding(DESCRIPTION, 'ruri-v3')` および `embedding_query('顧客サポート', 'ruri-v3')` が 512 次元（2048 バイト）の Float32 BLOB を返却し、`DISTANCE` による近傍検索が完了すること。
   - 登録されていない未知のモデル名が指定された場合に `E_INPUT` が送出されること。
