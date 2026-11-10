# v0.0.1 内部インターフェース

## 1. 適用範囲

各moduleのexport、型、入出力と副作用を以下に定義する。テストが直接importするinterfaceを保持し、外部I/OはJest mockで差し替え可能にする。説明中のBytesはUint8Array、MaybeBytesはUint8Arrayまたはnull、Digestはpath/bytes/sha256、Countersはhit/miss/eviction/actualInference/entries/bytesの略記である。

## 2. 入力・推論

| module path | exportと署名 | 期待する動作 |
| --- | --- | --- |
| `src/errors.ts` | `VectorError extends Error`、constructor(code:ErrorCode) | name=VectorError、message=code、readonly code |
| `src/inference/profile.ts` | `EMBEDDING_DIMENSION=768`, `EMBEDDING_BYTES=3072` | 定数を共用 |
| 同上 | `assertTokenLimit(count:number):void` | safe integer>=0でなければE_PROTOCOL、>2048ならE_TOKEN_LIMIT |
| 同上 | `embeddingToBlob(values:ArrayLike<number>,shape:readonly number[]):Bytes` | 正確なshape/finite/norm、Float64正規化、LE copy |
| 同上 | `formatTextInput(operation,body,title,specialTokens):string|null` | query/document prefix、NULL、型/UTF8/NUL/special-token境界 |
| `src/inference/image.ts` | `validateImageInput(input:unknown,mime:unknown):ImageHeader` | width/height/type、復号前の資源制限 |
| 同上 | `RawImage` constructor(data,width,height,channels)、size getter、rgb():RawImage、static read(input):Promise<RawImage>、resize(width,height,options?):Promise<RawImage> | 独立画素所有、同寸法は同instance、gray/alpha/Blob境界 |
| 同上 | `decodeRawImage(bytes,mime):Promise<RawImage>`、`load_image` | Wasm decode後RGB、load_imageはRawImage.read alias |
| `src/inference/image-codecs.ts` | `ImageCodecBytes={jpeg,png,resize}`、`initializeImageCodecs(assets):Promise<void>`、`decodeImageBytes(bytes,type):Promise<ImageData>`、`resizeRgba(image,width,height):Promise<ImageData>` | 同じWasm codec設定、未知I/Oを発生させない |
| `src/inference/engine.ts` | `InferenceEngine(runtime)`、attach(processor,model):void、embed(request):Promise<MaybeBytes>、close():Promise<void> | 一度attach、全tensor解放、未知例外redaction、NULL短絡 |
| `src/inference/initialize.ts` | `initializeInferenceEngine(runtime,options):Promise<InferenceEngine>`、`warmupImageBytes():Bytes` | codec/config/processor/model/warm-up順、失敗cleanup |
| `src/inference/browser-initialize.ts` | `prepareBrowserInference(options):Promise<PreparedBrowserInference>`、`configureBrowserGpu(runtime,backend,gpu?):Promise<void>` | 永続cacheを先に準備、同origin codec、variant別URL、明示GPU取得 |

engine requestはquery/documentなら `{operation,body:unknown,title?:unknown}`、imageなら `{operation:"image",bytes:unknown,mime:unknown}`。RuntimeInputsは任意tensor項目と `input_ids:{data:ArrayLike<number|bigint>,dims:readonly number[]}`。processorはasync callable(text:string|null,image:unknown)とtokenizer.all_special_tokens、modelはasync callable(inputs)とasync disposeを持つ。出力はRecord<string,unknown>。

PortableRuntimeはenv.backends.onnx.wasmが任意のRecord、AutoConfig/AutoProcessor/AutoModelのfrom_pretrained、initializeImageCodecs、decodeRawImageを持つ。runtimeをglobal singletonへ漏らさず、Jest mockを渡せるconstructor境界とする。Node.js 環境下での Wasm 実行時は `env.backends.onnx.wasm.numThreads = 1` を明示設定し、動的 `blob:` URL のインポート（Node ESM ローダーの `ERR_UNSUPPORTED_ESM_URL_SCHEME` 例外）を完全に回避する。

InferenceInitialization共通は `{cache:object,codecs:ImageCodecBytes,warmupImage:Bytes}`。wasm/webgpuはbackend/wasmUrl/factoryUrl必須、directmlはbackendと任意graphOptimizationLevel。browser準備はworkerUrl、modelBaseUrl、backend、network、artifactSetHash、manifestHash、assets、任意fetcher/storage/persistentCache。返値はcache/wasmUrl/factoryUrl/codecs。persistentCache mockはinitialize(online/offline)とread(path)を提供できる。

## 3. Bridgeとcontroller

| module path | exportと署名 | 期待する動作 |
| --- | --- | --- |
| `src/bridge/protocol.ts` | createResponseBuffer():SharedArrayBuffer | 新品8192B、version field=1 |
| 同上 | publishResponse(buffer,payload,errorId=0):boolean | CAS占有・publish、放棄済み/二重応答false |
| 同上 | readResponse(buffer):BridgeResponse | terminal検査後 `{payload:copy,errorId}` |
| 同上 | abandonResponse(buffer):boolean | 放棄成立true、公開済みfalse、未知state拒否 |
| 同上 | waitResponse(buffer,cancel,deadline):BridgeResponse | 通知先行、cancel/deadline、50ms再確認 |
| `src/bridge/inference-health.ts` | validateInferenceHealth(value):SharedArrayBufferまたはundefined | undefined可、他は4-byte SABのみ、異常E_PROTOCOL |
| 同上 | publishInferenceHealth(bufferまたはundefined,state:1/2/3):void | optionalならno-op、atomic store+notify |
| 同上 | assertInferenceReady(buffer):void | 値1以外E_INFERENCE |
| `src/workers/db.ts` | requestEmbedding(port,request,cancellationBuffer,timeoutMs):MaybeBytes | 同期結果、NULL短絡、画像copy、送信失敗E_INFERENCE |
| `src/workers/inference.ts` | handleInferenceRequest(engine,message:unknown,generation:number):Promise<boolean> | 応答publishとfatal bool、stale世代を無視 |
| `src/workers/inference-browser-controller.ts` | BrowserInferenceController(host,createEngine)、receiveControl(message):void、whenIdle():Promise<void> | 初期化/推論/終了の直列chain、ready/failed/closed、port回収 |
| `src/workers/inference-browser.ts` | ブラウザ推論専用 Worker エントリ（`dist/workers/inference-browser.mjs` のバンドル入力） | `globalThis.addEventListener("message", ...)` と `BrowserInferenceController` を接続し、`prepareBrowserInference` + `initializeInferenceEngine`（`@huggingface/transformers` バンドル）で実エンジンを生成 |
| `src/workers/inference-node.ts` | Node 推論専用 Worker エントリ（`dist/workers/inference-node.js` のバンドル入力） | `worker_threads` の `parentPort` で初期化を受け、`prepareNodeModelCache` + `initializeInferenceEngine`（portable Wasm または DirectML バンドル）を起動し `handleInferenceRequest` で同期ブリッジ要求を処理 |

DbEmbeddingRequestはjobId/requestId/generationとquery/documentのbody/title、またはimageのbytes/mime。DB owner 側の `port`（`InferenceRequestPort`）は `postMessage(message:unknown):void` だけを必要とする。timeoutは有限>=0、requestId>=1、generation>=0、非空jobIdでなければE_PROTOCOL。NULL本文短絡はenvelope検証後で、画像はUint8Arrayをcopyする。portへ渡すinputはbodyでなくtextという名前を使用する。

BrowserControllerInitializationはkind=initialize、generation、backend、network、modelBaseUrl、manifest={modelId,repository,revision,artifactSetHash,fingerprint,assets}、inferencePort、任意healthBuffer。hostはpostMessageとclose。createEngineはwarm-up済みengineをasync返却する。generationやmodel manifestをfactoryより先に検証する。`BrowserInferenceController` の初期化前検証では、`manifest` の `modelId` / `repository` / `revision`、64桁小文字hexの `artifactSetHash` / `fingerprint`、および `Array.isArray(manifest.assets)` を確認し、`manifest.assets.length > 0` のときは `validateModelAssets(manifest.assets)` を実行する（`manifest.assets.length === 0` の単体テスト fixture は controller 単体境界では許容し、実 `createEngine` 内の `prepareBrowserInference` / `PersistentModelCache` で必須11資材を検証する）。また、Worker 側の `inferencePort`（`BrowserInferencePort`）は要求受信（`onmessage`）・開始（`start()`）・終了（`close()`）のみを担い応答は `responseBuffer`（SAB）に書き込むため、初期化検証では `start` および `close` が関数であることのみを確認し、`postMessage` を要求しない。

## 4. Statementと公式adapter

```typescript
interface EmbeddingCacheIdentity {
  modelId: string; revision: string; fingerprint: string;
  profile: string; backend: string; runtimeGeneration: number;
}
type EmbeddingCall =
  | { operation: "query" | "document"; body: unknown; title: unknown }
  | { operation: "image"; bytes: Uint8Array; mime: string };
type EmbeddingExecutionBudget = {
  deadline: number; cancellationBuffer: SharedArrayBuffer;
};
type EmbeddingInference = (
  request: EmbeddingCall, budget?: EmbeddingExecutionBudget
) => Uint8Array | null;
```

| module path | export/メソッド | 動作 |
| --- | --- | --- |
| `src/inference/statement-embedding-cache.ts` | validateEmbeddingBlob(value):void | 正確3072B、finite、norm許容 |
| 同上 | StatementEmbeddingCache(identity,capacity=33554432,check=空関数) | capacityはsafe integer1..33554432、それ以外E_INPUT |
| 同上 | resolve(request,infer):MaybeBytes、dispose():void、statistics():Counters | hit/miss/eviction/copyと終了済み拒否 |
| `src/sqlite/statement-lifecycle.ts` | StatementLifecycle(identity,timeoutMs,clock=performance.now,health?) | module世代、単調期限、health callback |
| 同上 | enter(database:number,statement:number):StatementExecution | active step中の再入E_PROTOCOL、新規generationまたはROW継続 |
| 同上 | leave(statement,result):void | result100だけcache保持、異statementのPROFILEでrunningを消さない |
| 同上 | current():StatementExecution、hasActiveStep():boolean | currentはhealth/cancel/deadline/identityを検証 |
| 同上 | reset(statement)、close(database)、cancel(database?)、statistics() | 各対象だけ破棄/取消、終了counter累積 |
| `src/official/functions.ts` | embeddingSqlValue(name,args:readonly unknown[],infer?):MaybeBytes | generic model先行検証、用途・NULL・準備状態 |
| `src/official/options.ts` | validateEmbeddingOptions(options,environment):ReadyEmbeddingOptionsまたはundefined | 製品仕様の検証順と既定値 |
| `src/official/initialize.ts` | initializeOfficialRuntime(factory,options={},environment,prepare?):Promise<ProductSqlite3> | embeddingだけ分離して公式option転送、session/拡張終了、pool非破壊解放 |
| `src/official/registration.ts` | registerEmbeddingExtension(sqlite3,infer?,options?):EmbeddingControl | all-open auto-extension、trace/protection、functionCallsとcache、動的モデルプロファイル登録 |
| `src/official/vector-metadata.ts` | parseVectorTypeDeclaration(typeDecl:string):VectorTypeMeta\|null、extractVectorColumnsFromTableInfo(tableName,rows):Map<string,VectorColumnSchema>、resolveModelFromAuthorizer(context):string、calculateCosineDistance(left,right):number\|null、evaluateReferenceModelNetworkPolicy(options):NetworkPolicyResult | `VECTOR(dim[, 'model'])` 型宣言解析、`PRAGMA table_info` からの列メタデータ抽出、Authorizer 通知（`INSERT=18`、`UPDATE=23` および単体テスト互換 `UPDATE=9` かつ `arg1 && arg2` 非空、`FUNCTION=31`）からの優先順位別モデル解決、コサイン距離計算、参照モデル通信方針判定 |
| `src/official/lifecycle-adapter.ts` | OfficialLifecycleAdapter(sqlite3,lifecycle?,onClose?)、observe(db)、assertClosed()、dispose() | 元capi保持、callback合成、close追跡、元binding復元 |
| `src/official/metadata.ts` | officialMetadataRecord(identity)、validateOfficialMetadata(actual,identity)、initializeOfficialMetadata(sqlite3,db,identity) | 保存仕様の7項目（`productVersion: "0.0.3"` 固定）、DDL、空DB判定 |
| 同上 | OfficialMetadataProtection(sqlite3)、observe(db)、close(db)、dispose() | 内部保護と利用者authorizer合成 |
| `src/official/node-files.ts` | canonicalNodeSqlitePath(filename):string、NodeSqliteFiles | canonical path、同期I/O、fd/temp/lockの単一所有 |
| `src/official/node-file-ownership.ts` | NodeFileOwnership(filename)、release():void | kernel IPC排他、同process Worker死亡から復旧 |
| `src/official/node-vfs.ts` | installNodeFileVfs(sqlite3):{close():void} | 非既定node-file VFS、公式struct helper |
| `src/official/node-inference.ts` | createNodeInferenceSession(options,packageRoot):Promise<OfficialInferenceSession> | native事前検証、package相対Worker/manifest、READY後同期bridge |
| `src/official/browser-inference.ts` | resolveOfficialBrowserAssets(entryUrl,modelBase?):{worker,manifest,modelBase} | entry基準URL、同origin、userinfo/query/fragment拒否 |
| 同上 | createBrowserInferenceSession(options,entryUrl):Promise<OfficialInferenceSession> | 同originmanifest、専用Worker/port、health |

StatementExecutionはdatabase/statement/generation/deadline/cancelled/cancellationBuffer/cache。check順序はhealth、cancelled、clock>=deadline、所有map identity。cancelはflag=1とcache.dispose、対象contextは次step等で破棄する。deadline超過後にenterを試みたらresetして例外を返す。

InitializationEnvironmentはworker:boolean、runtime=node/browser、platform、architecture、任意nodeMajor。内部検証でnodeMajor省略は24として扱う。ReadyEmbeddingOptionsはbackend/initTimeoutMs/sqlTimeoutMsが必須化されたoptions。

OfficialFactoryは `(options?:Record<string,unknown>)=>Promise<Sqlite3Static>`。OfficialInferenceFactoryはReadyEmbeddingOptionsからsessionを返す。sessionはinfer/identity/information/任意assertReady/async close。registration optionsはidentity/timeoutMs/information/任意check。pool mockはinstallOpfsSAHPoolVfsが返すpauseVfsを観測可能にする。

NodeSqliteFilesメソッドはopen(identifier,filenameまたはnull,{create,readonly,main,removeOnClose})、read(identifier,output,offset):number、write(identifier,input,offset):void、sync、truncate(identifier,size)、size(identifier):number、accessible(filename,writable):boolean、delete(filename,synchronize)、close(identifier)、dispose()。readはゼロ埋めした実byte数、未登録identifierはE_STORAGE。ファイルをcloseした後は再open可能で、重複ownerはE_DATABASE_LOCKED。

`src/official/node.ts`とbrowser.tsのdefaultを環境別entryから再exportする。browser.tsはsqlite3Worker1Promiserもexport。types.tsは公式型と製品追加型をexportする。generated-modules.d.tsは完成loaderのmodule宣言を提供し、worker1.tsはdefault initializer完了後initWorker1APIを呼ぶ。

## 5. Cache/storageの署名

| module path | export/メソッド |
| --- | --- |
| `src/runtime-assets/model-contract.ts` | MODEL_ID、MODEL_REPOSITORY、MODEL_REVISION、MODEL_ASSET_FILES、ModelAssetDigest、validateModelAssets(assets):void |
| `src/runtime-assets/verified-cache.ts` | VerifiedModelCache(assets,reader)、match(request:string/Request):Promise<Response/undefined>、put(request,response):Promise<void> |
| `src/runtime-assets/persistent-model-cache.ts` | ModelCacheMode=online/cold/offline、PersistentModelCache(options)、initialize(mode)、recover()、read(path) |
| `src/runtime-assets/node-persistent-cache-storage.ts` | NodePersistentCacheStorage.create(directory,options?)、createNodePersistentCacheStorage(directory,options?) |
| `src/runtime-assets/browser-opfs-cache-storage.ts` | BrowserOpfsPersistentCacheStorage(root,locks,options?)、createBrowserOpfsPersistentCacheStorage(options?) |
| `src/runtime-assets/browser-model.ts` | isSecureBrowserUrl(URL):boolean、createBrowserModelReader(assets,baseUrl,expectedOrigin,fetcher?):async reader |
| `src/sqlite/node-model-cache.ts` | DEFAULT_NODE_MODEL_BASE_URL、createNodeModelFetcher(baseUrl,fetcher?)、prepareNodeModelCache(options,fetcher?):Promise<VerifiedModelCache> |

PersistentModelCacheOptionsはassets/artifactSetHash/manifestHash/storageと任意fetcher/chunkSize。ArtifactWriterはasync write(chunk)、close、abort。PersistentCacheStorageはasync exists(path):boolean、read(path):Bytes/undefined、digest(path):{bytes,sha256}/undefined、createWriter(path)、commit(source,target)、removeTree(prefix)、runExclusive<T>(key,async action):Promise<T>。Node/browser storageともこの署名を実装する。

Node storage optionはmaxWriteBytes/lockRetryMs/lockTimeoutMs、browser optionはmaxWriteBytes。全て指定時は正のsafe integer。OPFS mockはdirectory.getDirectoryHandle/getFileHandle/removeEntry、file.getFile/createWritable、OpfsFileSnapshotのsize/arrayBuffer/stream、writable.write/close/abort、locks.request(name,action)を提供できる。

NodeModelCacheOptionsはcacheDirectory/network/baseUrl/assets/artifactSetHash/manifestHash。allowはonline、offlineはoffline初期化。browser fetch署名は(input:string,init:RequestInit)=>Promise<Response>。Node/browserのURL・copy・完全性・stage/ready動作は推論仕様第5節と一致させる。

### 5.1 Mock境界のexport型名

既存テストのtype importも同名で解決可能にする。以下の宣言と、本文の同名実体の契約を合わせる。ReferenceGenerationInputManifestの全fieldは第7.1節のmanifest形式で定義する。

```typescript
export interface BrowserPersistentModelCache {
  initialize(mode: "online" | "offline"): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
}
export interface BrowserLockManager {
  request<Result>(name: string, action: () => Promise<Result>): Promise<Result>;
}
export interface OpfsFileSnapshot {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
}
export interface OpfsWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface OpfsFileHandle {
  getFile(): Promise<OpfsFileSnapshot>;
  createWritable(): Promise<OpfsWritable>;
}
export interface OpfsDirectoryHandle {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}
export interface BrowserControllerHost {
  postMessage(message: unknown): void;
  close(): void;
}
export interface BrowserInferencePort {
  onmessage: ((event: { readonly data?: unknown }) => void) | null;
  start(): void;
  close(): void;
}
export interface InferenceRequestPort { postMessage(message: unknown): void }
export type RuntimeProcessor = (
  (text: string | null, image: unknown) => Promise<RuntimeInputs>
) & { tokenizer: { all_special_tokens: readonly string[] } };
export type RuntimeModel = (
  (inputs: RuntimeInputs) => Promise<Record<string, unknown>>
) & { dispose(): Promise<void> };
```

## 6. DirectMLと品質

| module path | exportと動作 |
| --- | --- |
| `src/inference/backends/directml.ts` | DirectMlNativeAsset=Digest、validateDirectMlInventory(version,actual):void、verifyDirectMlInstallation():Promise<string>、loadDirectMlRuntime():Promise<DirectMlOrtRuntime> |
| `src/inference/backends/directml-vision-graph.ts` | patchDirectMlVisionGraph(source):{bytes,changed,sha256}、DirectMlModelCache(source)、async match、async put():never、patchInfo():{changed,bytes:number,sha256}/undefined |
| `src/inference/embedding-quality.ts` | evaluateEmbeddingQuality(pairs,thresholds):EmbeddingQualityReport |

EmbeddingQualityPairはid/modality=textまたはimage/candidate:Float32Array/reference:Float32Array。閾値はtext/imageごとの `{mean:number,each:number}`。返値はpassedとtext/imageそれぞれ `{count,mean,minimum,passed}`。両modalityが必要、空/重複idはE_INPUT、768以外/非finite/ゼロvectorはE_EMBEDDING_VALUE。独立cosine集計をし、平均だけで各件の劣化を隠さない。

## 7. Tooling/CLIのテスト互換

| path | exportと受入 |
| --- | --- |
| `tooling/assets/model-lock.ts` | ModelLicenseEvidence、validateModelLicenseEvidence(evidence):void。idは小文字SPDX相当、README.md/LICENSE path固定、正size、小文字64桁hash |
| `tooling/assets/runtime-lock.ts` | RuntimeAssetLock、RuntimePatchLock、RuntimeLock、REQUIRED_RUNTIME_ASSETS、REQUIRED_RUNTIME_PATCHES（`patches/transformers-portable.patch`, `patches/transformers-directml.patch`, `patches/sqlite-official.patch`）、validateRuntimeLock(lock):void |
| `tooling/release/release-audit.ts` | ReleaseAuditSummary={info,low,moderate,high,critical,total}、validateReleaseAudit(summary):void。全値safe integer>=0、合計整合、全0以外拒否 |
| `tooling/quality/sqlite-wasm-compat.ts` | sqliteWasmDemoCases、verifyDemoRows(actual,expected):void。長さ/順序/値の完全一致。不一致SQLITE_WASM_DEMO_RESULT_MISMATCH |
| `tooling/quality/sqlite-demo-bundlers.ts` | buildWebpackDemo(root,loader)、buildParcelDemo(root,loader)、buildRsbuildDemo(root,loader):Promise<string>、serveSqliteDemo(root):Promise<{server,origin}> |
| `tooling/build/docker-build-validation.ts` | ortArtifactNames、DockerOrtBuildReport、validateDockerOrtArtifacts(report,files,demoFiles):void |
| `scripts/release/package-contract.ts` | requiredPackageFiles、auditPackageFiles(root):Promise<PackageAuditReport>、createCycloneDxSbom(version,inputs)、isFile(filename):Promise<boolean> |
| `test/integration/search-gate-helpers.ts` | decodeFloat32LittleEndian(bytes)、cosineDistance(left,right)、rankFlat(candidates,query,k) |

runtime asset revisionは数字、v任意の数値版、version-X、40桁commit等のimmutable形式。mutableなbranch/latestを拒否する。name/licenseは英数先頭の安全識別子。HTTPS以外のsourceは許可downloads/docker module pathだけ。完成buildにbytes/hashが存在しても拒否する。他資材はbytes/hash必須。optional integrityはsha512-base64。必須24asset/3patch欠落、duplicate name/path、patch traversal、toolchain不正はE_ASSET_INTEGRITY。

DockerOrtBuildReportはstage/status/runToken/fullLto/files/demo。stage=ort-web-wasm-build2、status=passed、UUID v1..5、標準buildはfullLto=false、demo=demo/index.html、filesは4file名stringまたは{name}の配列。fullLtoはCMake cacheだけで決めず、同runの生成Ninjaと実compile/link flagsで判定する。明示ONの検証buildだけtrueを許可し、full `-flto` のcompile/link適用と `-flto=thin` 不使用を要求する。output/demo mapsも各4件で同じrunのcopy一致、Wasm validate、loader非空を要求する。過去のdigest一致を条件にしない。

PackageAuditReportはrequiredFiles、files:{path,bytes}[]、forbiddenFiles、repositoryImports、sensitiveLogging。ファイル名順、同一入力で同じreport。欠落/禁止要素があれば例外で停止する。SBOM入力はname/version/任意hash。

### 7.1 G03参照生成

`scripts/quality/g03-fixtures.ts` は `generateG03FixtureSet(root):Promise<G03FixtureSourceManifest>` をexport。2directoryへ生成して同じmanifest/file bytesになる。120 textはmultilingual/code/searchの3分類、32 imageは32x32 PNG、source=self-generated:g03-fixture-generator-v1、license=CC0-1.0、各画像SHAを持つ。合成するのは入力だけで参照vectorを偽造しない。

`scripts/quality/g03-reference-generation.ts` はFIXED_ORIGINAL_REVISION、FIXED_ONNX_REVISION、validateReferenceGenerationInputs(root,manifest):Promise<{textFixtures,imageFixtures,wheelFiles}>をexport。manifestはschemaVersion1、contractId=embeddinggemma2-g03-reference-v1、originalModel/onnxFp32/q4各{revision,root,files:Digest[]}、wheelhouse={root,requirements:Digest,files}、fixtures={root,manifest:Digest}、python={root,executable:Digest,files}、driver:Digest、toolVersions={python,torch,transformers,sentenceTransformers,onnxRuntime,driver}。

全rootは入力directory内の相対path、全fileは完全inventory・digest検証。元モデル必須6file、FP32/q4各graph/data4file、wheelはbinaryのみ。余剰/欠落はREFERENCE_INPUT_INVENTORY_INVALID、hash違いはREFERENCE_INPUT_HASH_MISMATCH、revision違いはREFERENCE_REVISION_MISMATCH、directory不在はREFERENCE_LOCAL_DIRECTORY_UNAVAILABLE、traversal/symlinkはREFERENCE_PATH_INVALID、空実行file/weightはREFERENCE_INPUT_DIGEST_INVALID。Python inventoryの空stdlib fileだけは許可する。読み中のsize/mtime変化はREFERENCE_INPUT_CHANGED。

`scripts/quality/g03-prepare.ts` はbuildPythonLock(pipReport):string、prepareRuntime(target,source):Promise<void>。pip install reportのnameをlowercaseしunderscoreをhyphenへ、exact versionとwheel SHAで `name==version --hash=sha256:<hash>\n`。重複、sdist、不正metadataはREFERENCE_RESOLUTION_INVALID。runtime copyはhost Scripts/site-packagesを除外しLib/venv内launcherを保持する。固定requirements.lockとdriverを配備し、既存出力は上書きせずERR_FS_CP_EEXIST。

参照実生成はPython3.13.9/Torch2.9.0/Torchvision0.24.0/Transformers5.22.1/SentenceTransformers6.2.0/ORT1.23.2を別venvへoffline導入する。driverはmodel-reference/conversion-reference/q4の各系列、fixture/model roots/outputを引数に受け、IDごとに3072B LE Float32を新規出力。模擬driverはunitの境界試験だけで、実精度合格の代用不可。

## 8. Sample/benchmark

`samples/official-scenario.ts` はpopulateOfficialSample(database,stage)、searchOfficialSample(database,query)、mutateOfficialSample(database)をexport。登録は猫/車/犬の3日本語文書と共通1px PNG、id1..4、vec1 flat/cos。検索返値はrowid:string/distance:number。更新はid2の本文/vector、削除はid3の業務/vectorを同transactionで行う。

Node sampleは同じfileのmain supervisorとowner Workerを分離。browserはindex.ts supervisor、owner.ts DB、server.ts静的配信。browserには `__SVW_WALKTHROUGH_ONLINE__` と `__SVW_WALKTHROUGH_OFFLINE__` hookがあり、offlineは `runOwnedBrowser("offline")` でfresh ownerを起動する。601000ms監視、未応答E_OUTCOME_UNKNOWN。SAHはclearOnInit:false/preserveOnInitFailure:true、synchronous=FULL、finallyでembedding.close。

sample reportは4登録、3072B、2 query、先頭id1、finite distance昇順、rollbackVerified=true、更新削除後3行、削除id3不在、quick_check=ok、modelRequestsOnline=11/offline=0を検査可能にする。本文・画像・vector・秘密値はreportしない。`scripts/walkthrough.ts` はEdge channel=msedge、Node/browser reportを保存し、使用tarballをmetadata name/versionで一意選択する。

benchmarkはcold init/warm-up、SQL cache cold/hit、100行distance走査を分け、query/document/image各30回以上のp50/p95を計測する。process RSSとowner heapを区別し、GPU memoryが取得不能ならnull。高速化率/SLAを捏造しない。
