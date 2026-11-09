# v0.0.1 推論・モデルプロファイル・Worker仕様

## 1. モデルプロファイルと資材配置戦略

本パッケージは、標準サポートされる参照モデル（EmbeddingGemma-2）と、アプリケーション主導で任意の ONNX 埋め込みモデル（ruri-v3, bekko 等）を動的に利用可能なモデルプロファイル機構の双方に対応する。
また、npm パッケージ配布物（tarball）内には大容量のモデル資材（約300MB）を含めない（ゼロバンドル）。資材の配備およびネットワーク利用は以下の2系統を提供する：

1. **参照モデル（EmbeddingGemma-2）**: 組込みの公式初期化（`initialize({ embedding: ... })`）において、`network: "allow"` での安全なストリーム HTTP 取得による永続キャッシュ構築、または `network: "offline"` での完全ローカルキャッシュ運用（外部通信完全遮断）に対応する。事前配置用ツールとして `scripts/download-assets.mjs` も提供される。
2. **動的モデルプロファイル（任意ローカルモデル）**: アプリケーション側がローカルに任意モデルを事前配置し、`registerEmbeddingExtension` 経由で推論を統合する（完全オフライン・ゼロダウンロード動作）。

### 1.1 動的モデルプロファイル (ModelProfileDefinition)

ライブラリ内部にモデルのハードコードを持たず、アプリ側から動的に設定を注入する：
- `name`: モデル識別名（例: `'ruri-v3'`, `'embeddinggemma-2'`, `'bekko-v1'`）
- `path`: アプリ側で事前配置されたローカルモデルディレクトリパス
- `dimension`: 埋め込み次元数（例: 256, 512, 768）。省略時は `config.json` 等から自動検出可能。
- `normalize`: コサイン類似度向けの L2 正規化（既定: `true`）
- `prefix`: クエリ用・文書用のプレフィックス定義（モデル仕様に応じた整形）

### 1.2 参照モデル定義 (EmbeddingGemma-2)

EmbeddingGemma-2 を利用する場合の参照プロファイル：
公開model名は `embeddinggemma-2`、元model IDは `google/embeddinggemma-2`、ONNX repositoryは `onnx-community/embeddinggemma-2-ONNX`、revisionは `daa72c51243991dfcaf9f9137d2c573d8f7790c0`。text/visionのweight-only q4、FP32 activation、768次元、audio無効。FP16/q4f16/q8や別revisionへ差し替えて成功扱いにしない。

製品manifest `manifests/embeddinggemma2-q4.json` はschemaVersion=1、上記modelId/repository/revision、artifactSetHash、fingerprint、license、profile、assetsを持つ。artifactSetHashは `edc288bfd9366727abe6200cf6db45d844aac338c9055f359308334567ba661e`、論理空間fingerprintは `5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7`。これらはモデル集合/保存空間の識別契約であり、SQLiteやORTバイナリ自体の合否digestではない。

profileはaudio=false、dtype=q4、dimension=768、preprocessingVersion=`embeddinggemma2-input-v1`、prefixVersion=`embeddinggemma2-prefix-v1`、normalizationVersion=`l2-f64-le-f32-v1`、inputContractVersion=1。image設定は本書第3節。backendは論理fingerprintを変えない。

### 1.3 必須11資材

pathはmanifest論理path。配置元がflatな場合も論理pathへ対応付ける。assets配列は以下の順で固定し、各行にrole/mime/license=`apache-2.0`を付ける。graph/weightsはoctet-stream、JSONはapplication/json、templateはtext/plain。

| path | bytes | SHA-256 | role |
| --- | --- | --- | --- |
| `onnx/model_q4.onnx` | 490742 | `f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9` | text-graph |
| `onnx/model_q4.onnx_data` | 174028800 | `c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49` | text-weights |
| `onnx/vision_encoder_q4.onnx` | 159400 | `7ea284226d4938f0ad921ab091f1d80a9ca699aa802984ef5cd5eec4f4761d96` | vision-graph |
| `onnx/vision_encoder_q4.onnx_data` | 108957696 | `0a9d6c927334f152a33dd90874f65d6ea5228999abe6a450d3f7813677fa704c` | vision-weights |
| `config.json` | 5031 | `8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d` | model-config |
| `processor_config.json` | 1788 | `168f6a08522f3ce5dea596d94d003af2fd691742d4f41fe1f9d8cce76bfbf69c` | processor |
| `preprocessor_config.json` | 560 | `9344893f8d0573a46ebb2ca54c03f56d044cea194c8dcfb1f4d652240ac21daa` | image-processor |
| `tokenizer.json` | 32170510 | `4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4` | tokenizer |
| `tokenizer_config.json` | 1599 | `17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874` | tokenizer-config |
| `config_sentence_transformers.json` | 1565 | `031e56a498d33c349ab489a21885bcfe25b4fcba841149dc99e1e90d4a7c28f5` | sentence-config |
| `chat_template.jinja` | 1016 | `4b852efc0b9960283e735363331e6f325b33bc74bdbaa076f595bc4e9b94d85e` | template |

model validatorは上記pathの完全な集合を要求し、欠落、重複、余分、非正の非整数byte数、小文字64桁hex以外のSHAを `E_ASSET_INTEGRITY` とする。定義のsource fieldはgraph/dataだけbasename、残りはpathと同じ。

license evidenceはid=`apache-2.0`、metadataPath=`README.md`、metadataBytes=28720、metadataSha256=`4fe21bf1b86938ac62c7cd2d1511822e4ea6e8654e015e00b06a72676b5420e6`、textPath=`LICENSE`、textBytes=11357、textSha256=`c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`。固定revisionのmodel cardとAPI metadataのlicense一致を承認し、LICENSEが配信元に存在しない場合は承認済みApache-2.0標準本文を対応付ける。404を空fileや別licenseで代用しない。

## 2. 共通推論初期化

Transformers.js 4.3.1のAutoConfig/AutoProcessor/AutoModelを使う。private runtimeへ検証済みcacheを設定し、`useCustomCache=true`、`useBrowserCache=false`、`useFSCache=false`、`useFS=false`、`allowLocalModels=true`、`allowRemoteModels=false`、`localModelPath="/models/"`、`useWasmCache=false`。env.fetchはcache外通信を必ず `E_ASSET_INTEGRITY` で拒否する。local_files_only=trueと固定revisionを全loaderへ渡す。

初期化順はbackend設定、codec、config、audio_config=null、processor、q4 text/vision model、engine attach、query warm-up、image warm-up。vision_configは保持する。feature-extraction pipelineで不要encoderを読む方式にしない。warm-up query本文は `warm up`。共通imageは次の1px PNGで、Node/browserで同じbytesを使う。

```text
iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==
```

WasmはORT Web `1.31.0-dev.20260914-8d85527a0`、numThreads=1、proxy=false、package内wasmPathsを明示する。session optionはenableMemPattern=false。browser Wasm/Node WasmはJSEP、browser WebGPUはJSPIとWebGPU用bundle初期化を使う。JS/loader/Wasmを同じ版で組にする。WebGPUはrequestAdapter()で取得したadapterをORT env.backends.onnx.webgpu.adapterへ設定し、取得不能を環境エラーにする。

Node.js 環境における Wasm 実行では、マルチスレッド（`numThreads > 1`）時に ONNX Runtime 内部で WebAssembly Worker 起動用の動的 `blob:` URL (`URL.createObjectURL`) を生成して `import(blobUrl)` を試みる挙動を完全に回避しなければならない。Node.js のデフォルト ESM ローダーは `blob:` スキームをサポートしておらず、`ERR_UNSUPPORTED_ESM_URL_SCHEME` 例外が発生するためである。このため、Node.js 実行環境ではスレッド数を厳格に `numThreads = 1`（単一スレッド）に強制し、動的 `blob:` URL の生成および動的インポートを完全に抑止する。上流 Transformers.js の内部バックエンド参照（`ONNX_ENV`）への浅いコピーに起因するスレッド設定の不達を防ぐため、`patches/transformers-portable.patch` により `env.backends.onnx = ONNX_ENV` の直接参照結合を保証し、外部から設定された `numThreads = 1` がランタイム内部へ確実に伝播する設計とする。

textはprocessor(formattedText,null)、imageはprocessor(null,decodedImage)。最終input_ids.data.lengthを検証してからmodelを呼ぶ。sentence_embeddingのみを出力BLOBへ変換する。成功・失敗とも入力/出力のdispose可能objectをidentityのSetで重複排除して一度ずつdisposeする。

engine.attachは一度だけ。closedまたは二重attach、未attachのembedは `E_ENVIRONMENT`。closeはmodelを一度disposeし、processor/model参照を外し、再closeは成功する。既知VectorErrorは保持し、未知例外は本文を捨て `E_INFERENCE`。別bundle由来画像例外はcodeが `E_IMAGE_FORMAT` または `E_IMAGE_LIMIT` のときだけ自moduleのVectorErrorへ変換する。任意codeの偽装は受理しない。

### 2.1 Portable互換処理

Transformers.js (`@huggingface/transformers`) を private staging へ配置し、Node portable経路からonnxruntime-nodeとsharp importを除去する。Node環境自体を偽装せず、device許可とruntime選択だけをwasmへ限定する。session作成/run queueは直列化し、rejectionが次の正常要求へ連鎖しないようにする。`patches/transformers-portable.patch` により、Node.js 環境での動的 `blob:` URL のインポート失敗を防ぐ `numThreads = 1` 参照反映と、直列化プロミスチェーンでの例外連鎖防止、`return_path` 最適化の無効化（Uint8Array メモリバッファ供給）を確実に適用する。

core graphをUint8Array、externalDataを `{path,data}` bytesで供給する。native向けreturn_path最適化をportable経路で無効にする。external data名はgraphの相対名であり、cache絶対pathではない。RawImageを第3節のportable adapterへ置換し、sessionの上流error loggingからtensor/入力を除く。browser bundleへNode builtin/native依存を到達させない。

## 3. 画像前処理

入力はUint8Array、MIMEは厳密にimage/jpegまたはimage/png。20*1024*1024 bytes以下、各辺1..16384の整数、幅*高さ<=16000000。signature確認後にimage-size 2.0.4のbuffer APIで形式/寸法を取得する。型不正はE_INPUT、容量/寸法はE_IMAGE_LIMIT、形式・MIME不一致・破損はE_IMAGE_FORMAT。

PNGは8-byte signature、各chunkの長さ/境界、終端IEND長0とfile末尾一致を検証する。acTLがあればAPNGとして拒否する。JPEGはFF D8 FFで識別。URL、path、SVG、data URLを画像として取得しない。

jSquash JPEG 1.6.0はpreserveOrientation=true、PNG 3.1.1は8-bit RGBA。復号後も寸法/channel/buffer長を検証する。RawImage constructorはchannels=1..4、data長=width*height*channelsを要求し、独立Uint8ClampedArrayを所有する。

rgb()は同instanceを返し、1/2channelならgrayをRGBへ展開、4channelならalphaを捨てる。白背景合成やICC色管理はしない。sRGBとして扱う。readは既存RawImageをそのまま返し、JPEG/PNG Blobだけを追加受理する。その他の入力はE_INPUT。

resizeは同寸法なら同instanceを返す。その他はrgb()後にalpha=255のRGBAを作り、jSquash resize 2.1.1でmethod=catrom、fitMethod=stretch、premultiply=false、linearRGB=falseを指定し、新しいRGB画像を返す。上流resample optionでこの設定を変えない。Nodeには厳密4*width*heightのImageData互換だけを用意し、Canvasを模擬しない。

固定Gemma processorのpatch_size=16、pooling_kernel_size=3、max_soft_tokens=280、rescale_factor=1/255、do_normalize=falseを保持する。最大2520 patches、patch dimension=768、position padding=-1。target寸法・patchify・projection・poolingは上流処理へ委ね、独自実装しない。複数画像やtext+image合成入力は公開しない。

## 4. DirectML

### 4.1 事前検証とnative inventory

Windows x64 Node24で明示directmlのときだけ、`onnxruntime-node@1.31.1` を使う。owner側ではbindingをrequireせず、package metadataと次のnative root直下全fileを計測する。version、不足、重複、余分なentry、directory、byte数/hash不一致はE_ASSET_INTEGRITY。未導入/非対応platform/load不能/DML非bundledはE_ENVIRONMENT。model取得前に拒否する。

rootは `bin/napi-v6/win32/x64/`。

| file | bytes | SHA-256 |
| --- | --- | --- |
| `DirectML.dll` | 18527544 | `d16be72fa002dd610cca93e376f0ef44865dfce43de4b7bf9738af22534f7a9d` |
| `dxcompiler.dll` | 17986400 | `430eed027979399769a325b60319aca4e4afa4daebe475d3c763dcf2a0190a72` |
| `onnxruntime.dll` | 31736672 | `beb6e1edba0e74c132453fe4df113da2ea2b99ef8ea7dfc25696a872efd11c45` |
| `onnxruntime_binding.node` | 358200 | `8d9f996ff7dcc60c4899aa87aa7abe07d806f9c314882f44a001d0fd8a23d16f` |

推論Workerで再検証してrequireし、listSupportedBackendsにname=dmlかつbundled=trueがあることを確認する。private DirectML bundleだけがnative依存をexternalとして参照する。portable Nodeとbrowserは参照しない。製品tarballへnative fileを複製しない。

### 4.2 sessionとgraph

device=dml、executionMode=sequential、enableMemPattern=false、freeDimensionOverrides={s11:1,s35:2520}、graphOptimizationLevelは既定all、logSeverityLevel=4。内部初期化APIはdisabled/basic/extended/allを指定可能。CPUをfallback候補へ足さない。shape/control nodeのORT内部CPU配置と製品fallbackは区別する。

vision graphは元manifest完全性検証後、構造化ONNX protobuf decode/encodeを使いReshapeのallowzero=1だけを0へ変更する。128箇所、出力159391 bytes、SHA=`e6115d00cb043a16d22376e513898471a911cd97d42832871f92599fd4279fe4`をすべて要求する。他operator/attributeは変えない。永続cache、元graph、fingerprintは書換えない。Wasm/WebGPUに適用しない。

DirectMlModelCache.matchは元VerifiedModelCacheを先に読み、vision graphだけメモリ内patchしResponseを返す。patchInfoはchanged/bytes/sha256だけ。putは常にE_ASSET_INTEGRITY。native graphもbytes+externalDataで供給する。pathへの退避や任意DLL探索をしない。

## 5. 検証済みモデルcache

### 5.1 論理layoutと状態

```text
<storage-root>/
  sets/<artifactSetHash>/
    files/<manifest-relative-path>
    ready.json
    stage/state.json
    stage/files/<manifest-relative-path>
    stage/ready.json
```

model storageはDB領域から分離する。Node既定rootはLOCALAPPDATA、次にXDG_CACHE_HOME、なければhomedir/.cacheを選び、その下の `sqlite-vec1-embeddinggemma2-wasm/model`。cacheDirectoryで上書きできる。browserはOPFS root直下 `.svw-models`。

PersistentModelCache constructorで全11資材、小文字64桁のartifactSetHash/manifestHash、正のsafe integer chunkSizeを検証し、manifest entryをcopy/freezeする。chunkSize既定1MiB。markerは最大64KiB、UTF-8 strict JSON、schemaVersion=1、artifactSetHash、manifestHash、順序込みassetsのpath/bytes/sha256を照合する。

initializeはartifact set排他内で実行する。

| 保存状態 | online | cold | offline |
| --- | --- | --- | --- |
| markerと全file digestが正常 | 再利用 | 再利用 | 再利用・通信0 |
| marker破損または公開file破損 | 明示online初期化で再取得可能 | E_ASSET_INTEGRITY | E_ASSET_INTEGRITY |
| markerなし | fetcherがあれば取得 | fetcherがあれば取得 | E_MODEL_CACHE_MISS |
| 取得が必要だがfetcherなし | E_MODEL_CACHE_MISS | E_MODEL_CACHE_MISS | E_MODEL_CACHE_MISS |
| 取得が必要でstage/state.json残存 | E_ASSET_INTEGRITY | E_ASSET_INTEGRITY | 前記offline判定 |

recover()だけが現在setのstageを排他的に削除し、ready=falseへ戻す。他set/DBを消さない。再起動時に未完stageを黙って消さない。

stage/state.jsonを先に書き、11資材を順次stream取得する。各writeはchunkSize以下、宣言byte超過を途中で止め、EOF後の実byte数/hashを検証してwriterをflush/closeする。readerは成功失敗ともcancel/release。全fileが正常になった後にmarkerを書き、各fileをfilesへcommit、markerを最後にcommitし、stageを除去する。途中失敗はwriter.abort、固定E_ASSET_INTEGRITY。部分集合をREADYにしない。

read(unknownPath)はundefined。既知pathでも未READYならE_MODEL_CACHE_MISS。READY後も排他内でdigestを再確認し、読んだbyte長を検証してcopy返却する。markerの存在だけを信頼しない。自動LRU削除、Range resume、HTTP retry/backoffは現行cacheにはない。応答失敗は上記固定errorで止め、設計上の将来retryを実装済み契約にしない。

### 5.2 storage adapter

Nodeはcanonical rootを保持し、各操作でroot差替えとpath境界を確認する。logical pathはslash区切りの `[A-Za-z0-9._-]+` segmentsで、空・dot/dotdot・backslash・absoluteを拒否。親/最終symlink、非directory parent、非通常fileを拒否。stage writerは排他的作成、partial write loop、fsync/close、abortで所有fileのみ削除。close後write/二重closeは完全性エラー。maxWriteBytes既定1MiB。

Node cache lockはDB所有lockとは別で `.locks/<hash>.lock` directory。既定25ms retry、30000ms deadline。EEXISTだけretryし、期限/別I/O errorはE_ASSET_INTEGRITY。action終了のfinallyで自分のlockを除去する。commitは同一rootのrename。

browserはOPFS handleをsegmentで辿り、Web Lock `svw-model-cache:<hash>` で排他する。createWritableのatomic closeを使い、commitはsourceのファイルスナップショットをbounded copyしtarget close後にsourceを削除。非標準moveに依存しない。NotFoundErrorだけを不存在として扱う。digestは同時に巨大fileを複数materializeせず、1ファイルスナップショットずつWeb Cryptoで計算する。

### 5.3 loader cacheと通信

VerifiedModelCacheは次のkeyだけをmanifest論理pathへ完全一致で写像する。

```text
/models/onnx-community/embeddinggemma-2-ONNX/<path>
https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/<path>
```

未知keyはmiss。matchのたびにcopyとsize/hash照合を行い、Content-Lengthと定義MIMEの新しいResponseを返す。putはbounded readで同じdigestを確認するだけで、永続storeやready状態を変えない。

Node fetcherはHTTPS/loopback directoryだけ、userinfo/query/fragmentを拒否する。各assetのencoded pathをroot配下へ解決し、redirect=error、credentials=omit、cache=no-store。browserはさらに同一originを要求する。codec package取得は非空かつ32MiB以下を要求し、model用hash契約と区別する。offlineはmodel download 0だが、HTML/JS/Wasm/manifest/codecのローカル配信まで不要になる意味ではない。サイト全体のservice workerは利用者責務。

## 6. 同期bridge

DB ownerは同期UDF、推論Workerは非同期modelを所有する。MessageChannelで入力を送り、DB ownerだけがAtomics.waitする。browser main threadでwaitしない。SQL UDFから同接続へ再入SQLを呼ばず、推論WorkerからDBへの同期要求も行わない。

request envelopeは `{protocolVersion:1,jobId,requestId,generation,operation,input,responseBuffer}`。jobIdは非空string、requestIdはsafe integer>=1、generationはsafe integer>=0。text inputは `{text,title}`、imageは `{bytes,mime}`。元画像はcopyしcallerのbufferをdetachしない。ArrayBuffer画像はhandlerでUint8Arrayへ変換する。SABをtransfer listに入れない。

responseはrequestごとに新品8192-byte SAB、先頭32 bytesをInt32Array(8)、残りをpayloadとする。

| header index | 契約 |
| --- | --- |
| 0 | state: PENDING=0、WRITING=1、OK=2、ERROR=3、ABANDONED=4 |
| 1 | OKは3072、ERRORは0..4096のpayload長 |
| 2 | 成功0、error ID 1..10 |
| 3 | 成功dimension=768、失敗0 |
| 4 | protocolVersion=1 |
| 5..7 | 常に0 |

error IDは1 E_INPUT、2 E_TOKEN_LIMIT、3 E_IMAGE_FORMAT、4 E_IMAGE_LIMIT、5 E_EMBEDDING_VALUE、6 E_INFERENCE、7 E_TIMEOUT、8 E_CANCELLED、9 E_MEMORY、10 E_PROTOCOL。unknown/破損headerはE_PROTOCOL。応答error payloadは通常空で、例外本文を送らない。

writerはCAS PENDING->WRITING成功時だけpayloadとheaderを書き、最後にWRITING->OK/ERRORのCASで公開しnotifyする。readerはterminal stateをatomicに観測した後だけheader検証とpayload copyを行う。wait前の通知を取りこぼさず、最大50msごとに再読取する。

cancel flagは別4-byte SAB。cancel/deadline到達ではPENDINGまたはWRITINGをCASでABANDONEDにする。既にOK/ERRORなら上書きせず結果を読む。既存ABANDONEDのwaitはE_CANCELLED。timeoutによる自分の放棄はE_TIMEOUT。無期限deadline、通常ArrayBuffer、異容量はE_PROTOCOL。使い捨てSABなので遅延writeが次要求へ混入しない。

handlerは異generationのsafe integer要求を応答せず無視し、非致命falseを返す。正常結果NULLはprotocol違反。fatal IDは5/6/9/10で、WorkerをFAILEDへ進めengineを解放する。他の入力errorは同sessionの次要求を許す。session healthは4-byte SAB、READY=1、FAILED=2、CLOSED=3。cache hit前にもREADYを確認し、メッセージloopが停止中でも故障を検出する。

browser controllerはinitialize/inference/closeをPromise chainに直列化し、失敗後のqueueもcatchで処理する。二重initialize、未知control、不正manifestは拒否。READYはwarm-up後だけ。close/failureでengineとportを閉じる。session closeの応答待ちは30000ms、そのfinallyでport/Workerを必ず終了する。
