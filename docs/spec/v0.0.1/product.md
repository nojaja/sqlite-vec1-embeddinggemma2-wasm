# v0.0.1 製品・公開API・SQL仕様

## 1. 製品境界

製品名は `sqlite-vec1-embeddinggemma2-wasm`、package versionは `0.0.1`。SQLite 3.54.1、公式vec1 0.7、EmbeddingGemma 2のq4 text/visionを一つのnpm形式tarballから利用する。SQLite/vec1は同じWasm instance、SQL接続、transactionで動作する。モデル推論を別DBで事前計算して転記する方式を主実装にしない。

手書き製品・tooling・sampleはTypeScript、設定は `.js`、rootはCommonJS。browserは生成ESM、Nodeは生成CommonJSとESM wrapperを使用する。公式CAPI/VFS hook、限定上流patch、第三者資材、生成物は言語例外。独自SQL parser、tokenizer、距離・推論engineを新設しない。通常のbuild・test・sampleは任意の実験projectを取り外しても動作する。

明示backend選択と失敗時の拒否を基本とし、自動fallback、SQL自動再試行、旧版DB/cacheの自動変換を行わない。通常SQLのtrust boundaryは公式SQLite APIと同じく利用側が所有する。通常接続を任意SQL向けsandboxとは扱わない。

## 2. 公開入口と型

| package path | types | 実行入口 |
| --- | --- | --- |
| `.` | `dist/index.d.ts` | browser条件は `dist/browser/index.mjs`。nodeのimportは `dist/node/index.mjs`、require/defaultは `dist/node/index.js` |
| `./browser` | `dist/index-browser.d.ts` | `dist/browser/index.mjs` |
| `./node` | `dist/index.d.ts` | import/requireを上と同じく分離 |
| `./sqlite3.wasm` | なし | `dist/sqlite3.wasm` |
| `./package.json` | なし | package metadata |

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

### 3.2 推論有効化

検証順序は、embedding省略の短絡、Worker環境、option/model object、Node対応matrix、backend、network、base URL、期限。main threadでembeddingを指定した場合はoption内容より先に `E_ENVIRONMENT`。通常SQLのみの省略時に推論向けOS制限を適用しない。

| 推論を行う環境 | wasm | webgpu | directml |
| --- | --- | --- | --- |
| Windows x64 Node.js 24 worker_threads | 既定 | 環境エラー | 明示指定のみ |
| Linux x64 Node.js 24 worker_threads | 既定 | 環境エラー | 環境エラー |
| 対応Edge dedicated Worker | 既定 | 明示指定のみ | 環境エラー |

Nodeの他OS・architecture・major版は `E_ENVIRONMENT`。未知backend、`auto`、`gpu`、`dml`は `E_INPUT`。browserのWebGPU対応は実adapter/device取得を必要とし、`navigator.gpu`の存在だけで合格にしない。Chrome、macOS、ARM、NPU、CUDA、複数GPUは保証対象ではない。

`network`は厳密にallow/offline。baseUrlはHTTPSまたはlocalhost・127.0.0.1・[::1]のHTTP、末尾 `/` 必須、userinfo/query/fragment禁止。browserのモデルbaseはpackage entryと同一originに限定する。Nodeの既定取得元は固定ONNX repository/revisionのresolve directory。環境変数でモデルIDやrevisionを差し替えない。

初期化期限は600000ms、SQL期限は120000msが既定。いずれも有限数かつ閉区間 `[1,1800000]`。現行validatorは整数に限定しない。nullish値は既定に展開する。範囲外、NaN、Infinityは `E_INPUT`。

公式loader初期化後に推論sessionを準備する。モデル・codecとquery/image warm-upが成功するまでinitializerをresolveしない。推論有効moduleは専用推論Worker/sessionを一組所有し、同moduleの接続で使う。異なるmodule・Workerへ共有しない。同時推論は1。モデル共有poolは提供しない。

### 3.3 接続と終了

vec1は公式SQLite Wasm組み込みの仮想テーブル拡張、embedding系は公式CAPI/oo1拡張で全接続へ登録する。oo1 constructorおよびCAPI step/reset/finalizeを包括して直接CAPI呼出しを取りこぼさない。callbackとfunction pointerはmodule寿命まで保持する。

通常 `db.close()` は同期。全接続をcloseしてから `await sqlite3.embedding.close()` を呼ぶ。生存接続があれば `E_DB_IN_USE` で拒否し、callbackやsessionを先に破棄しない。成功したmodule closeは再呼出し可能。内部登録解除、元capi復元、session/model/port/Worker終了を行う。取得したSAH poolにはDB/session終了後 `pauseVfs()` を呼び、保存データを消さない。Nodeは最後に所有VFSを解除する。

## 4. SQL関数

### 4.1 署名

| 関数 | 登録arity | 用途 |
| --- | --- | --- |
| `embedding(text[,model])` | 1、2 | document |
| `embedding_query(text[,model])` | 1、2 | query |
| `gemma_embed_query(text[,title])` | 1、2 | query。第2引数はprefixへ使用しない |
| `gemma_embed_document(text[,title])` | 1、2 | title付きdocument |
| `gemma_embed_image(bytes,mime)` | 2 | JPEG/PNG画像 |
| `gemma_model_info()` | 0 | 安全な診断JSON TEXT |
| `DISTANCE(left,right)` | 2 | vec1由来のcosine distance |

generic関数のmodel省略は厳密に `embeddinggemma-2`。model指定時は同じ文字列だけを受理する。NULL、数値、空文字、大小文字違い、別名は `E_INPUT`。model検証を本文NULLより先に行う。登録されていないarityはSQLite標準のarity error。

text系はmodel検証後、本文NULLなら推論なし・cache登録なしでNULL。非NULL本文の型・byte長・空白・NULを検証してから準備状態を確認する。未準備なら `E_EMBEDDING_NOT_READY`。SQL画像関数は `Uint8Array` とstring MIMEを先に要求し、NULL画像/MIMEも `E_INPUT`。内部engineの画像NULL短絡をSQL登録関数の仕様と混同しない。

text/image/model-infoの登録flagsは `SQLITE_UTF8 | SQLITE_DIRECTONLY`。DETERMINISTIC、INNOCUOUSを設定しない。view、trigger、generated column、expression index等からの間接推論を認めず、明示SQLとtransactionを使う。cache最適化のためにflagsを偽装しない。

### 4.2 入出力

query prefixは `task: search result | query: {body}`、document prefixは `title: {title-or-none} | text: {body}`。親SQLやDISTANCEの有無から用途を推測しない。文書titleのundefined/NULL/空文字だけをnoneへ展開し、空白titleを勝手にtrimしない。

本文は未加工Unicode文字列のUTF-8で1MiB以下、空・空白のみ・NULは禁止。titleは1024 bytes以下。数値/BLOBの暗黙変換、Unicode正規化、小文字化、chunk化、切詰めを行わない。固定tokenizerのall_special_tokensを入力に含めない。prefix・画像soft token込みの最終input_idsが2048を超えたら `E_TOKEN_LIMIT`。2048は受理する。

出力は独立所有のUint8Array。headerなし、768個のLE IEEE754 Float32、3072 bytes。モデルのFloat32 `sentence_embedding` とshape `[1,768]`を要求し、last_hidden_state等で代用しない。Float64累積normが有限かつ `>1e-12` であることを確認し、各値をnormで除してLE Float32へ格納する。保存norm誤差は `abs(norm-1)<=1e-5`。非finite・shape違い・ゼロは `E_EMBEDDING_VALUE`。query/document/imageは同じ論理embedding空間を使う。

### 4.3 距離

どちらかがNULLならNULL。その他は両方BLOB、各3072 bytes、768 finite Float32、正のnormを要求し、不適合は `E_INPUT`。非正規化入力も許可する。各normをdouble精度で求め、正規化したFloat32一時配列を公式 `vec1CosDist` へ渡す。極小約 `1e-40`・極大約 `3e38` をFloat32の積のoverflow/underflowで拒否しない。

意味は `1-dot(left,right)/(norm(left)*norm(right))`。同一0、直交1、逆向き2を許容誤差内で返す。小さい順が近傍。入力BLOBのモデル由来は距離関数では分からず、保存metadataと利用者の入力管理で空間混在を防ぐ。NULLのsort順はSQLite標準のまま。

### 4.4 診断

model-infoはJSON TEXTで、`ready`、`model:"embeddinggemma-2"`、累積 `functionCalls`、cacheの `hit,miss,eviction,actualInference,entries,bytes` を含む。有効sessionでは元modelId、revision、fingerprint、q4、dimension、backend、runtime/version、executionProvider等のREADY情報も含む。未準備ではready=false、全cache counter=0で、診断のためにモデルを取得しない。

functionCallsはtext/imageのUDF評価回数でNULLや入力エラーも計数し、model-info自身は計数しない。actualInferenceはstatement cacheのmissからinferを呼んだ回数で、成功結果だけの数ではない。warm-upをSQL counterへ混ぜない。本文、画像、SQL、BLOB値、token ID、絶対pathを診断へ出さない。

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
  vector_data BLOB NOT NULL CHECK(length(vector_data)=3072)
) STRICT;
INSERT INTO documents(id,text_data,vector_data)
VALUES(1,:text,embedding(:text));
SELECT id,text_data FROM documents
ORDER BY DISTANCE(vector_data,embedding_query(:query)),id LIMIT 3;
```

`embedding(:query)`も有効だが文書用prefixとなり、検索用と同じvector/順位を保証しない。次の形式はquery評価を明示的に分離する。

```sql
WITH q(vector) AS MATERIALIZED(SELECT embedding_query(:query))
SELECT d.id,d.text_data FROM documents AS d CROSS JOIN q
ORDER BY DISTANCE(d.vector_data,q.vector),d.id LIMIT 3;
CREATE VIRTUAL TABLE document_vectors USING vec1(vector);
INSERT INTO document_vectors(cmd,arg)
VALUES('rebuild','{"index":"flat","distance":"cos"}');
INSERT INTO document_vectors(rowid,vector)
SELECT id,vector_data FROM documents;
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
