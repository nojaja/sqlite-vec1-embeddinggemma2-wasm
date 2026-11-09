# v0.0.1 製品・公開API・SQL仕様

## 1. 製品境界

製品名は `@nojaja/sqlite-vec1-embeddinggemma2-wasm`、package versionは `0.0.1`。公式 `@sqlite.org/sqlite-wasm@3.54.1-build1` に対する完全なドロップイン互換（drop-in replacement）として提供され、利用者が `package.json` の依存先を本パッケージに変更するだけで、SQLite 3.54.1、公式vec1 0.7、EmbeddingGemma 2のq4 text/visionを一つのnpm形式tarballから利用できる。SQLite/vec1は同じWasm instance、SQL接続、transactionで動作する。モデル推論を別DBで事前計算して転記する方式を主実装にしない。

手書き製品・tooling・sampleはTypeScript、設定は `.js`、rootはCommonJS。browserは生成ESM、Nodeは生成CommonJSとESM wrapperを使用する。公式CAPI/VFS hook、限定上流patch、第三者資材、生成物は言語例外。独自SQL parser、tokenizer、距離・推論engineを新設しない。通常のbuild・test・sampleは任意の実験projectを取り外しても動作する。

明示backend選択と失敗時の拒否を基本とし、自動fallback、SQL自動再試行、旧版DB/cacheの自動変換を行わない。通常SQLのtrust boundaryは公式SQLite APIと同じく利用側が所有する。通常接続を任意SQL向けsandboxとは扱わない。

## 2. 公開入口と型

公式 `@sqlite.org/sqlite-wasm` と同一のエクスポート構造を提供し、各種 bundler（Vite, Webpack, Parcel, Rsbuild）や Node.js ESM/CJS 環境において追加設定なしで解決可能とする。

| package path | types | 実行入口 / 条件 |
| --- | --- | --- |
| `.` | `dist/index.d.ts` (ESM: `dist/index.d.mts`) | `node`: `dist/node/index.js` (CJS) / `dist/node/index.mjs` (ESM)<br>`import`: `dist/index.mjs`<br>`browser`: `dist/browser/index.mjs`<br>`main`: `dist/index.bundle.js` |
| `./browser` | `dist/index-browser.d.ts` | `dist/browser/index.mjs` |
| `./node` | `dist/index.d.ts` | import/requireを上と同じく分離 |
| `./sqlite3.wasm` | なし | `dist/sqlite3.wasm` |
| `./package.json` | なし | `./package.json` |

公開設定として `"private": false` および `"publishConfig": { "access": "public" }` を定義する。同梱ファイル (`files`) は `dist`, `manifests`, `README.md`, `LICENSE` 等の実在資材に限定し、欠損パスを含めない。

条件exportのtypesを先頭にする。root `main` は `./dist/index.bundle.js`、`types` は `./dist/index.d.ts`、Node engineは `>=24 <25`。CommonJS利用時のinitializerは `require(packageName).default`。Node ESM wrapperはCommonJSのdefaultを明示再exportし、CommonJS namespaceをinitializerとして返さない。

browserには `sqlite3Worker1Promiser` named exportもある。標準Worker1は同じ製品initializerを使い、通常SQLとvec1を提供する。利用者の独自DB owner Workerによるembedding初期化とは別の経路である。

公式API・型の互換対象は `@sqlite.org/sqlite-wasm@3.54.1-build1`。供給資材内の公式 `index.d.mts` をそのまま型の基礎とし、宣言tokenを変更せず説明コメントを補足できる。公式の `Sqlite3Static`、`Database`、`PreparedStatement`、`CAPI`、`WASM_API`、`SqlValue`、`Sqlite3Result`、`ExecOptions`を再exportする。その他の公式export型も保持する。Worker1型と `OpfsDb = OpfsDatabase` の型aliasを公開する。

製品固有型は次のとおり。以下は実装コードではなく署名契約である。

```typescript
type Backend = "wasm" | "webgpu" | "directml";
interface EmbeddingOptions {
  backend?: Backend;
  model: { network: "allow" | "offline"; baseUrl?: string };
  cacheDirectory?: string;
  initTimeoutMs?: number;
  sqlTimeoutMs?: number;
}
type ProductInitOptions = Record<string, unknown> & {
  embedding?: EmbeddingOptions;
};
interface EmbeddingControl { close(): Promise<void> }
type ProductSqlite3 = Sqlite3Static & { embedding: EmbeddingControl };
declare function sqlite3InitModule(
  options?: ProductInitOptions
): Promise<ProductSqlite3>;
```

## 3. 初期化

### 3.1 通常SQL

`embedding`省略時は公式loaderへ残りのoptionsをそのまま渡す。公式callback、module configuration、Wasm location指定を維持する。main threadでも通常SQL、oo1、capi、vec1、DISTANCEを使える。モデル取得、codec初期化、推論Worker、metadataを作らない。SQL関数名の登録は行うため、NULL短絡と未準備診断は利用できる。

### 3.2 パス解決契約（外部プロジェクト配置対応）

本パッケージが npm 経由で他プロジェクトの `node_modules/@nojaja/sqlite-vec1-embeddinggemma2-wasm` にインストールされた場合でも安全に稼働するため、パッケージ内アセット（`manifests/embeddinggemma2-q4.json`、`dist/workers/inference-node.js`、`dist/sqlite3.wasm` 等）の解決は呼び出し元の `process.cwd()` ではなく、本パッケージ自身の配置ディレクトリ（`__dirname` または `import.meta.url`）を基準に解決する。

### 3.3 推論有効化およびスレッド制約の緩和

検証順序は、embedding省略の短絡、option/model object、Node対応matrix、backend、network、base URL、期限。
メインスレッド制約の緩和契約：利用者の利便性のため、メインスレッド（Node.js main thread、ブラウザ window / main thread）での初期化時であっても `E_ENVIRONMENT` で即時拒否せず、バックグラウンド Worker を介して推論を実行可能なアーキテクチャとする。

| 推論を行う環境 | wasm | webgpu | directml |
| --- | --- | --- | --- |
| Windows x64 Node.js 24 (main / worker_threads) | 既定 | 環境エラー | 明示指定のみ |
| Linux x64 Node.js 24 (main / worker_threads) | 既定 | 環境エラー | 環境エラー |
| 対応Edge (Window / dedicated Worker) | 既定 | 明示指定のみ | 環境エラー |

Nodeの他OS・architecture・major版は `E_ENVIRONMENT`。未知backend、`auto`、`gpu`、`dml`は `E_INPUT`。browserのWebGPU対応は実adapter/device取得を必要とし、`navigator.gpu`の存在だけで合格にしない。Chrome、macOS、ARM、NPU、CUDA、複数GPUは保証対象ではない。

`network`は厳密にallow/offline。baseUrlはHTTPSまたはlocalhost・127.0.0.1・[::1]のHTTP、末尾 `/` 必須、userinfo/query/fragment禁止。browserのモデルbaseはpackage entryと同一originに限定する。Nodeの既定取得元は固定ONNX repository/revisionのresolve directory。環境変数でモデルIDやrevisionを差し替えない。

初期化期限は600000ms、SQL期限は120000msが既定。いずれも有限数かつ閉区間 `[1,1800000]`。現行validatorは整数に限定しない。nullish値は既定に展開する。範囲外、NaN、Infinityは `E_INPUT`。

公式loader初期化後に推論sessionを準備する。モデル・codecとquery/image warm-upが成功するまでinitializerをresolveしない。ブラウザ環境においてはダミースタブではなく本物の推論エンジン／ワーカー（`InferenceBrowserController`）と正式接続し、実推論パイプラインを確立する。推論有効moduleは専用推論Worker/sessionを一組所有し、同moduleの接続で使う。異なるmodule・Workerへ共有しない。同時推論は1。モデル共有poolは提供しない。

### 3.4 接続と終了

vec1 は C の static auto-extension（`sqlite3_wasm_extra_init.c` による `sqlite3_auto_extension(sqlite3_extension_init)` 登録）として SQLite Wasm バイナリ内部に組み込まれ、全接続へネイティブに自動登録される。embedding 系は公式 CAPI/oo1 拡張で全接続へ登録する。oo1 constructor および CAPI step/reset/finalize を包括して直接 CAPI 呼出しを取りこぼさない。callback と function pointer は module 寿命まで保持する。

通常 `db.close()` は同期。全接続をcloseしてから `await sqlite3.embedding.close()` を呼ぶ。生存接続があれば `E_DB_IN_USE` で拒否し、callbackやsessionを先に破棄しない。成功したmodule closeは再呼出し可能。内部登録解除、元capi復元、session/model/port/Worker終了を行う。取得したSAH poolにはDB/session終了後 `pauseVfs()` を呼び、保存データを消さない。Nodeは最後に所有VFSを解除する。

## 4. SQL関数と型メタデータ連携 (方式A)

### 4.1 SQL関数一覧（特定モデル依存関数の全廃）

特定モデルに特化した関数（`gemma_embed_*` 群）は完全に廃止・削除され、モデル非依存の汎用関数のみを提供する。

| 関数 | 登録arity | 用途 |
| --- | :--- | :--- |
| `embedding(text[, model])` | 1、2 | 文書（document）向け埋め込みベクトルの生成 |
| `embedding_query(text[, model])` | 1、2 | 検索クエリ（query）向け埋め込みベクトルの生成 |
| `DISTANCE(left, right)` | 2 | 2つの Float32 ベクトル間のコサイン距離 (0〜2) |

### 4.2 方式A: `VECTOR(dim, 'model')` 型定義と自動モデル判断

#### 4.2.1 DDL 構文とスキーマ解析
SQLite の動的型付けアフィニティおよび DDL 透過インターセプトを活かし、テーブル定義時にベクトル型およびメタデータを定義する：
```sql
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(768 , 'embeddinggemma-2')
) STRICT;
```
- ライブラリは `CREATE TABLE` 実行時または接続初期化時に DDL をインターセプト・解析し、テーブル名・カラム名・次元数・モデル名のマッピング辞書を構築・保持する。内部的には SQLite のネイティブストレージ層（`STRICT` 指定テーブルを含む）へ透過的に適合させる。

#### 4.2.2 `[model]` パラメータの自動解決優先順位
SQL 文中で `embedding(text)` や `embedding_query(text)` の第2引数 `[model]` が省略された場合、以下の優先順位で自動解決される：

1. **明示指定**: `embedding(text, 'model_name')` が渡されている場合は最優先で使用。
2. **カラムコンテキスト（INSERT / UPDATE）**: 実行中の SQL 文を解析し、代入先カラムが `VECTOR(dim, 'model')` として定義されていればそのモデル名を自動採用。
3. **DB 内の一意モデル**: データベース内に定義されている `VECTOR` 型のモデルが 1 種類のみの場合、すべての省略呼び出しでそのモデルを自動採用。
4. **デフォルトモデル設定**: アプリ初期化時に指定された `defaultModel` を採用。
5. いずれにも該当しない場合は `E_MODEL_UNBOUND` エラーを送出。

### 4.3 距離関数 `DISTANCE(left, right)`

どちらかが NULL なら NULL。その他は両方 BLOB、同一バイト長（`dim * 4` バイト）、有限 Float32 配列を要求し、不適合は `E_INPUT`。
コサイン距離計算式: `1 - dot(left, right) / (norm(left) * norm(right))`。同一 0、直交 1、逆向き 2 を返す。入力ベクトルの次元数は 512, 768, 256 など登録モデルの次元数に柔軟に対応する。

### 4.4 動的モデルプロファイルと外部資材（ゼロダウンロード）

- **事前定義不要**: ライブラリ内部に特定モデルをハードコードせず、アプリ側が利用時に任意の ONNX モデル（ruri-v3, bekko, Gemma 等）のパスと設定を動的登録可能。
- **自動ダウンロードの完全排除**: ライブラリ自身による外部ネットワーク通信（Hugging Face 等からの自動フェッチ）は一切行わず、アプリ側で事前に配置されたローカルファイル資材のみを読み込む。
- **遅延初期化**: `embedding` 関数が実際に SQL で評価されるまで推論 Worker / ONNX Runtime の起動を行わず、通常 SQL や vec1 仮想テーブルはゼロオーバーヘッドで即座に動作する。

## 5. 実行内LRU

所有単位はmodule・connection・Stmt・execution generation。同じprepared statementの最初のstepで空cacheを作り、SQLITE_ROW(100)の間だけ維持する。DONE、step error、reset、finalize、DB closeで破棄する。reset/rebind/暗黙再実行ではgenerationを増やす。複数文exec、transaction、同じSQL文字列をcache共有単位にしない。

keyのidentityは `[modelId,revision,fingerprint,profile,backend,runtimeGeneration]` のJSON tuple。textはidentity文字列、operation、未加工body、`title ?? ""`をJSON tupleにする。imageはidentity、operation、MIME、byte長をtupleにし、さらに画像全bytesを比較する。hashだけの一致、区切り連結を使わない。generic文書とtitle未指定gemma文書は同じkey、query/documentは別key。queryの第2引数もkeyには残る。

最大10件かつ32MiB。sizeはUTF-8 key長+3072+元画像byte長。hit時は最新へ移す。新規成功値が収まるまで最古から追い出す。1 entryが上限を超えたら正常な結果をcopy返却するがcacheしない。失敗・NULL・不正BLOBは保存しない。hitでもhealth、cancel、deadline、generationを先に検査する。保存値・画像key・返却値はすべてcopyし、外部mutationでcacheが変わらないようにする。

終了後は内容とbuffer参照を解放しcounterだけを累積する。GCの物理即時消去は保証しない。保持中の entries/bytes は終了時0。破棄済みcacheの再利用は `E_PROTOCOL`。追い出されなければ100行の同一query ORDER BYの実推論は1回。UDF評価回数や走査行数を1回にする保証ではない。0行での不要な推論を強制しない。

公式capi.sqlite3_step/reset/finalizeを直接観測・インターセプトする。利用者のprogress設定（sqlite3_progress_handler）を内部タイムアウト・キャンセル監視と合成して多重化し、利用者が解除しても内部観測を失わない。2Stmt/2接続の交互step、pointer再利用も独立して管理する。

## 6. SQL利用例

以下は同じ初期化済みDB owner Worker内で実行するSQLである。通常の公式bind APIへ値を渡す。

```sql
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  text_data TEXT NOT NULL,
  embedding VECTOR(768 , 'embeddinggemma-2')
) STRICT;
INSERT INTO documents(id,text_data,embedding)
VALUES(1,:text,embedding(:text));
SELECT id,text_data FROM documents
ORDER BY DISTANCE(embedding,embedding_query(:query)),id LIMIT 3;
```

`embedding(:query)`も有効だが文書用prefixとなり、検索用と同じvector/順位を保証しない。次の形式はquery評価を明示的に分離する。

```sql
WITH q(vector) AS MATERIALIZED(SELECT embedding_query(:query))
SELECT d.id,d.text_data FROM documents AS d CROSS JOIN q
ORDER BY DISTANCE(d.embedding,q.vector),d.id LIMIT 3;
CREATE VIRTUAL TABLE document_vectors USING vec1(vector);
INSERT INTO document_vectors(cmd,arg)
VALUES('rebuild','{"index":"flat","distance":"cos"}');
INSERT INTO document_vectors(rowid,vector)
SELECT id,embedding FROM documents;
WITH q(vector) AS MATERIALIZED(SELECT embedding_query(:query))
SELECT d.id,c.distance FROM q
CROSS JOIN document_vectors(q.vector,'{"k":3}') AS c
JOIN documents AS d ON d.id=c.rowid ORDER BY c.distance,d.id;
```

flat/cosは全件厳密比較。tieは同値として評価し、業務表/vector表の更新削除は公式transactionでatomicに行う。標準SQL parser、optimizer、transaction、SAVEPOINT、bind、結果型を保つ。旧ラッパー固有のSQL文数・queue・行数・export容量制限を通常公式APIへ付加しない。

## 7. 停止とエラー

SQL期限は最初のstepからの単調時計で、ROW読み出し休止時間も含む。各step/cache操作/同期waitと、通常1000 VM命令ごとのprogressで確認する。利用者progress callbackの非0は接続のcancel flagへ反映し `E_CANCELLED`。内部期限を利用者のprogress解除で消さない。

同期API自体は外側の強制停止supervisorを提供しない。停止困難なC/ORT処理に備え、利用アプリの別threadがDB ownerを監視する。sampleは初期化/SQL段階の600000ms+1000msで停止し `E_OUTCOME_UNKNOWN` を報告する。commitと応答の境界不明は成功/rollbackを推測しない。再open後に業務IDとquick_checkを確認する。timer throttling下での厳密実時間保証はない。

製品内部 `VectorError` は `Error` subclass、name=`VectorError`、messageとreadonly codeが固定code文字列だけ。外部例外本文をコピーしない。UDF境界は固定codeをSQLite errorへ返し、通常SQLite例外の形式まで独自のjob/outcome objectへ変更しない。

| code | 条件 |
| --- | --- |
| `E_INPUT` | 型、model、本文/画像入力契約、option不正 |
| `E_TOKEN_LIMIT` | 最終token上限超過 |
| `E_IMAGE_FORMAT`, `E_IMAGE_LIMIT` | 形式不正、画像資源上限 |
| `E_EMBEDDING_NOT_READY` | 未準備の非NULL推論 |
| `E_EMBEDDING_VALUE` | shape/finite/norm不正。致命的session障害 |
| `E_INFERENCE`, `E_MEMORY`, `E_PROTOCOL` | runtime/Worker、memory、bridge/context故障。自動再実行なし |
| `E_TIMEOUT`, `E_CANCELLED` | deadline、共有flagまたはprogress停止 |
| `E_ASSET_INTEGRITY`, `E_MODEL_CACHE_MISS` | 完全性違反、offline不足 |
| `E_MODEL_MISMATCH`, `E_MODEL_UNBOUND` | 保存空間不一致、非空DB未bind |
| `E_ENVIRONMENT` | 非対応実行環境/EP/機能 |
| `E_DB_IN_USE` | 生存接続中のmodule close |
| `E_DATABASE_LOCKED`, `E_STORAGE` | Node保存所有競合、I/O故障 |
| `E_OUTCOME_UNKNOWN` | 外側supervisorが未応答ownerを停止 |

公式loaderの警告は `SQLITE_STEP_FAILED` とSQLite code/nameだけ、組込みtraceは `SQLITE_TRACE_EVENT` とcounterだけを出す。SQL全文・DB filename・bind値を上流のconsoleへ漏らさない。
