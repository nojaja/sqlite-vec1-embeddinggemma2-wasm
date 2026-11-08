# v0.0.3 受入条件

## 1. 受入方針と検証順序

本プロジェクトの品質保証は、**「既存のテストコードを変更することなく、すべてのテストが green になること」** を厳格な受入基準とする。

検証は以下の順序で進行する：
1. **固定資材の配置点検**: `npm run test:assets` により、全 11 モデル資材および公式成果物の存在と完全性を確認する。
2. **製品ビルド**: `npm run build` により、推論バンドル・公式 SQLite 資材・製品エントリポイント・型定義が欠落なく生成されることを確認する。
3. **単体テストスイート**: `npm test` により、35 ファイル・201 テストすべてが PASS することを確認する。
4. **統合テスト・機能ゲート**:
   - `npm run test:sqlite`: 公式 UDF、未準備短絡、`_svw_meta` 非作成要件、vec1 テーブル動作
   - `npm run test:storage`: `node-file` VFS CRUD、排他ロック、クラッシュ復旧、メタデータ保護
   - `npm run test:search`: 実モデル検索、キャッシュ増分整合性 (`actualInference`)
   - `npm run test:embedding-cache`: ステートメントキャッシュ分離、100行評価と実推論回数検証
   - `npm run test:sql-bridge`: `sqlite3_progress_handler` によるタイムアウト (`E_TIMEOUT`)・キャンセル (`E_CANCELLED`)
   - `npm run test:inference:browser`: MS Edge 上での Wasm 実推論 (クエリ/画像)
   - `npm run test:inference:node:directml`: 100回連続クエリ、117,362 DMLノード実行、Wasm 完全パリティ
5. **E2E 実推論テスト**: `npm run test:e2e` により、実推論（Wasm CPU、DirectML GPU、Edge WebGPU）の 3 スイートすべてが合格することを確認する。
6. **アーキテクチャ依存関係監査**: `npm run depcruise` により、モジュール間の境界違反が 0 件であることを確認する。

テストの入力、期待値、異常系、期限と品質閾値を安易に変更して通過させてはならない。

---

## 2. 同梱試験の範囲

unit は 33 ファイル、E2E は 3 ファイル、統合テストを含め `test/` 配下に配置されている。
- 列挙: `npm test -- --listTests`
- 単体テスト実行: `npm test`
- 単体カバレッジ: `npm run test:ci`
- E2E テスト実行: `npm run test:e2e`

---

## 3. 全unit suite対応表

以下のファイルは `test/unit/` 相対。すべて入力・期待値・異常系/境界を維持して合格させる。

| suite | 主な受入 assertion |
| :--- | :--- |
| `browser-worker-controller.test.ts` | READY 前 warm-up、要求直列化、世代不一致、未知 control、失敗/close 後の資源回収、health |
| `browser-worker-build.test.ts` | browser Worker/entry の Node/native 非到達、DirectML Worker の external native |
| `browser-opfs-cache-storage.test.ts` | bounded write、atomic copy commit、path 拒否、Web Lock、abort/close |
| `browser-model.test.ts` | HTTPS/loopback・同 origin、未知 path miss、size/hash、credentials/redirect |
| `browser-initialize.test.ts` | 永続 cache 先行、offline fetch 0、codec 上限、WebGPU adapter 取得/失敗 |
| `db-worker.test.ts` | 同期 3072B copy、NULL 送信なし、画像 copy、ID 1..10、cancel/timeout/遅延 |
| `distribution-contract.test.ts` | npm 配布設定、他 dir パス解決、メインスレッド制約緩和、ブラウザ正式推論接続、TypeScript 型互換契約 |
| `directml-vision-graph.test.ts` | 固定元 graph、128 変更、出力 size/hash、元 cache 不変、put 拒否 |
| `directml-runtime.test.ts` | version、4 native 完全 inventory、欠落/余剰/hash/size 不一致拒否 |
| `embedding-quality.test.ts` | text/image 平均と各件、欠落 modality/重複 ID/異次元/NaN/zero 拒否 |
| `image.test.ts` | signature/MIME、容量/寸法/APNG/chunk 終端、gray/alpha/RGB、resize、URL/path 拒否 |
| `inference-engine.test.ts` | query/document/image、token 境界、Float32 shape、tensor dispose、既知画像 error |
| `inference-initialize.test.ts` | env/cache、audio 無効 vision 保持、2 warm-up、失敗 dispose、Wasm/DML session options |
| `inference-worker.test.ts` | envelope/generation/image 変換、SAB publish、固定 numeric error |
| `model-manifest.test.ts` | 正確な 11 資材、重複/欠落/digest 拒否、license evidence |
| `node-model-cache-flow.test.ts` | persistent 初期化後だけ VerifiedModelCache 消費、再起動 offline |
| `node-model-cache-url.test.ts` | 危険 URL 拒否、loopback integration 許可 |
| `node-persistent-cache-storage.test.ts` | bounded lifecycle、containment/symlink、set 排他 |
| `official-browser-assets.test.ts` | document URL 非依存、package 相対 Worker/manifest/model、同 origin と危険 URL 拒否 |
| `official-functions.test.ts` | model 検証が NULL/READY より先、型/空白/NUL、query/document/title 写像 |
| `official-initialize.test.ts` | 公式 option 転送、embedding 省略 prepare 0、READY 待機、DB close 前拒否、pool pause だけ |
| `official-metadata.test.ts` | 7 key 版/空間、一致、backend 非保存、未知 schema/混在拒否 |
| `official-node-entry.test.ts` | main thread で model アクセス前に環境拒否 (`E_ENVIRONMENT`) |
| `official-node-files.test.ts` | ownership 競合、short read ゼロ埋め、fsync/write/reopen、symlink 拒否、temporary 回収 |
| `official-options.test.ts` | 省略、main 拒否、matrix、1/1800000 境界、0/NaN/Infinity/unknown 拒否 |
| `official-public-exports.test.ts` | default initializer、browser named promiser、廃止 API を公開しない |
| `official-runtime.test.ts` | 実 SQLite transactions/NULL、2 Stmt trace/authorizer、DIRECTONLY、metadata、DISTANCE |
| `persistent-model-cache.test.ts` | cold stage/ready、offline 通信 0、corrupt online 修復、明示 recover、別 set/DB 保護 |
| `profile.test.ts` | 768D LE 独立 BLOB、shape/NaN/zero 拒否、exact prefix/NULL、2048 token、本文/title bytes |
| `protocol.test.ts` | 通知先行/待機中 publish、state 放棄、公開済保護、cancel/期限、不正 header/size |
| `release-audit.test.ts` | 全 severity 0 のみ受理、件数不正/不整合/脆弱性を拒否 |
| `statement-embedding-cache.test.ts` | copy、用途/title/key、10/11 LRU、画像全 bytes、実 32MiB、超過 bypass、NULL/error 非保存 |
| `statement-lifecycle.test.ts` | ROW 保持/DONE/reset 世代、交互接続/Stmt、close/finalize/error、pause 期限/cancel |
| `vector-type-and-model-resolution-spec.test.ts` | gemma_embed_* 廃止、VECTOR 型 DDL 解析、[model] 自動解決、動的プロファイル、ゼロダウンロード、遅延初期化 |
| `verified-cache.test.ts` | 2 prefix だけ、未知 key、毎 read size/hash、put は同内容だけ |

---

## 4. 公式 API 互換 (9 デモ)

固定公式リポジトリ commit `ccbb81134a3b5a824f8a3cc3c5d8edd6e799ab5a` の全 9 デモを実行し、表示行が一致することを確認する。

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
3. **ブラウザ WebGPU 実推論 (`test/e2e/browser-inference.test.ts`)**:
   - MS Edge ブラウザ環境で WebGPU アダプター/デバイスが正常に取得され、テキストクエリおよび画像埋め込みの実推論が完了すること。
