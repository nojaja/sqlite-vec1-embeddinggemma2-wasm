# 開発ガイド

## 1. 開発対象

このprojectでは、[製品仕様](spec/v0.0.3/product.md)と[配布仕様](spec/v0.0.3/build.md)に適合するSQLite/vec1/EmbeddingGemma 2のnpm moduleを作成する。公開API、配布内容、SQL・推論・保存・公式互換・sampleの実動作を受入条件に従って検証する。

外部資材は[READMEの取得URL](../README.md#資材-url-一覧)と[資材一覧](spec/v0.0.3/assets.md)に従ってdownloadsとmodelへ配置する。npm依存の導入はREADMEの `npm install` から開始し、設計・テスト・設定に沿って製品、build処理、sampleを実装する。上流への限定変更はbuild仕様の変更範囲と合格条件に従う。

本書は実施手順であり、製品契約の正本は[設計書一覧](spec/v0.0.3/README.md)である。契約間に矛盾があれば前提と影響を確認し、暗黙のfallbackで回避しない。

## 2. 最小の実施順序

最小とは不要な環境再構築や失敗後の全工程やり直しを避ける順序であり、固定資材や受入gateの削減ではない。初回の各工程はこのproject内で実装する。まだないscriptを既存であるかのように実行しない。

| 順序 | 実施内容 | 次へ進む条件 |
| --- | --- | --- |
| 1 | READMEのURLからdownloads/modelへ資材を取得し、npm installで依存を導入してlockを生成・審査。assetsとLinux toolchainの必要file一覧を作る | npm依存と29 archive、用途別77/13/4deb、mirrorの不足が区別されている。model/G03資材は別工程として管理 |
| 2 | 指定emsdk 6.0.8の専用Linux x64 workspaceを準備。run UUIDを作り必要資材を搬入 | 全必要fileの転送一致とarchive検査。|
| 3 | run専用toolchainへ展開し固定toolとPython moduleを実起動 | [Linux準備条件](spec/v0.0.3/linux-toolchain.md)を満たす。基盤glibcを置換しない |
| 4 | SQLite/ORTのfolder-local builderと検査を実装。未変更上流を新規source rootへ展開し限定patchを適用 | SQLite source構成、build仕様の全限定変更（Abseil属性27件・補助2定義を含む）、再適用不変・対象外不変、header probeと両variantの[依存target・代表object一括点検](spec/v0.0.3/build.md#長時間build前の一括点検)が合格 |
| 5 | SQLite8file、ORTのJSEP/JSPI4fileを生成し同じrunで検査 | SQLite loader・SQL/vec1/DISTANCE、両ORTのReLU、run別完了状態・flagsが合格 |
| 6 | 検証済み出力を転送検査後に製品downloadsへ配置。通常SQL入口と公式互換を実装 | モデルなしの公式API・型・9demo・上流smokeが合格。通常SQLを推論環境制限で拒否しない |
| 7 | 固定q4、manifest/license、codec/cache、Worker推論、同期SQL bridge、metadata/VFS/LRUを実装 | unitから実SQLite・実モデル・保存・offlineへ進み、Node/Edgeと明示backendの条件を満たす |
| 8 | E2E、sample、配布と監査を実装し最終tarballを検証 | [受入条件](spec/v0.0.3/acceptance.md)の全gate、3空consumer、Node/Edge sample、全severity0。G03参照生成も別途完了 |

SQLiteとORTは別の生成runとして管理してよい。「同じrunの一式」はSQLiteの8file内、ORTの4file内それぞれに適用し、異なるvariantや古いloader/Wasmを混ぜない。製品buildは完成入力だけを読み、builderのsource/patch/reportを読み込まない。検査済み資材を保持し、失敗した工程とその依存後段だけを再実行する。sourceやpatchを変えた場合は新規run/treeで生成し直す。

各工程で関連テストを実行し、失敗原因を修正して同じテストを繰り返す。入力・期待値・異常系・期限・品質閾値を維持し、unit、integration、E2Eまで確認する。期限は[上流smokeの実行設定](spec/v0.0.3/acceptance.md#41-上流smokeの実行設定)に限りNode側60000msを使用し、browser側の既定5000msと他の製品試験は変更しない。

## 3. 失敗時の戻り先

以下の警告に関する行は[ORT再生成の警告方針](spec/v0.0.3/build.md#ort再生成の警告方針)と合わせて使う。「warning抑制・降格を成功にしない」は許可外の追加・範囲拡大を指す。固定上流の設定とbuilder8flagは由来・target・variantを検査し、許可済みflagだけを理由に停止しない。

| 症状 | 判定と次の作業 | 成功とは扱わないもの |
| --- | --- | --- |
| remoteに後続directoryがない、gzip/tarがEOF | 展開前に全件照合。不一致fileだけ有限再送。大容量は4MiB分割・part検査・連結・全体検査後rename | file存在・非空 |
| 一致したarchiveが展開不能 | 原本も末尾まで検査して取得失敗と転送失敗を分離。正常原本を保持し原因を記録 | 別版への差替え・HTML保存 |
| Node/CMake/Pythonのlibrary不足 | 専用overlayと指定deb内の限定4 library、stdlib、PATHを確認 | 基盤libc上書き、OS一括APT導入 |
| Abseil件数が26になる | 行継続処理漏れを確認。raw_hash_map=8、合計27を全sourceで検査 | 件数検査の緩和、warning抑制 |
| 27件適用後も公開headerが失敗 | 元sourceとの限定差分、macro行継続保持、同じSDK/flagsを確認 | headerを除外したprobe |
| protobuf単体は成功しonnx_protoが失敗 | 固定utf8_range includeが公開header利用側へ1件伝播するか実compileで確認 | header存在、protoc版表示 |
| configure後の警告policy gateが停止 | [許可方針](spec/v0.0.3/build.md#ort再生成の警告方針)の設定元・target・PUBLIC伝播と実効commandを照合。threads用flag、protobuf限定-w、utilのcomment flag、JSPI依存とbuilder8flagを区別し、atomicな全診断JSONを確認 | 全Wno一律拒否、出現flagの自動許可、全体への-w、裸の-Wno-error、report未保存 |
| function_utils.ccのGetVersionForDomainがunused-templateで失敗 | [限定属性変更](spec/v0.0.3/build.md#ort本体の未使用template)の初回1/0・適用済み0/1、署名/本体保持を確認。両variantの実compileから再検証 | 関数削除、他templateへの一括注釈、warning抑制 |
| sparse_utils.ccがEigenのunused-templateで失敗 | [Eigen限定変更](spec/v0.0.3/build.md#eigenの未使用template)の6header・12定義、前方宣言との区別、名前直後のコメント、初回12/0・適用済み0/12を確認。両variantの実compile/linkから再検証 | 部分適用、対象外注釈、system include化、warning抑制 |
| tensorprotoutils.ccのcurrent_pathがnodiscardで失敗 | [戻り値の限定変更](spec/v0.0.3/build.md#current_pathの戻り値)の1呼出しだけへのvoid cast、error_code分岐・後続path検証の保持を確認。Eigen等の変更も維持し両variantの実compile/linkから再検証 | 呼出し削除、path検証省略、warning抑制 |
| activations.ccがParallelizeSingleSpanのunused-templateで失敗 | [定義1件の限定変更](spec/v0.0.3/build.md#parallelizesinglespanの未使用template)のnamespace・定義/呼出しの区別、初回1/0・適用済み0/1、本体不変を確認。両variantのconsumer実compile/linkから再検証 | 関数削除、並列処理変更、対象外注釈、warning抑制 |
| cast_map.cc/category_mapper.ccがwrite_scoresのunused-templateで失敗 | [2overloadの限定変更](spec/v0.0.3/build.md#write_scoresの未使用template)のtemplate parameter・全引数・定義/呼出しの区別、全体2/0から0/2、一括適用と本体不変を確認。両variantの両consumer実compile/linkから再検証 | 片方だけの適用、名前だけの一括置換、長さ検証削除、warning抑制 |
| qlinear_where.ccの4templateがunused-templateで失敗 | [4定義の限定変更](spec/v0.0.3/build.md#qlinear_whereの未使用template)の匿名namespace・戻り値・引数とscalar側の区別、全体4/0から0/4、一括適用と本体不変を確認。両variantの実compile/linkから再検証 | scalar側への注釈、部分適用、broadcast処理変更、warning抑制 |
| allocator_adapters.cc/compile_api.ccがSessionOptionsAppendEPのunused-templateで失敗 | [公開headerの限定変更](spec/v0.0.3/build.md#sessionoptionsappendepの未使用template)のOrt::detail内匿名namespace、1定義と2呼出しの区別、配列・各長さ・ThrowOnErrorの保持を確認。両variantの両consumer実compileから再検証 | 公開型変更、linkage変更、既存呼出し削除、warning降格 |
| AbseilのFastUnref/PutLeadingWhitespaceがunused-templateで失敗 | [補助template限定変更](spec/v0.0.3/build.md#abseil補助templateの未使用診断)の2定義とsigned側の区別、初回2/0・適用済み0/2、参照count・出力処理保持を確認 | 関数削除、signed側への注釈、warning降格 |
| raw_logging.ccで旧Emscripten macroの診断が出る | config.hの版合成macro展開を確認し、旧token8出現の限定変更を点検。raw_logging.cc自身の旧tokenは0件として実compileで確認 | 診断行をsource tokenと誤認、架空の置換件数追加 |
| configure/probeは成功し本体buildが未完 | 同じUUIDの実process・run別exitを確認。接続切断だけで新規buildを重複起動しない | 接続終了0、古いreport |
| 生成完了だがReLU/SQLが失敗 | 同一runのloader/WasmとABI、runtime optionを確認し生成工程へ戻る | syntax/validateだけの成功 |
| 実model/GPU/G03資材がない | 不足と未確認gateを記録。独立した実行可能工程は進めてもreleaseは停止 | mock、既存vector、別backendによる代用 |
| 上流Wasm hash URL試験が5000msでtimeout | [smoke runner仕様](spec/v0.0.3/build.md#上流sqlite-smoke-runner)のNode project60000ms、browser既定維持、子Vite専用aliasと導入済み固定Viteの解決を確認。起動/build時間とassertionを切り分ける | 9/10成功、試験本文変更、別bundler、事前buildした固定結果 |
| 9demo成功後のsmokeや後処理が失敗 | 全体子process上限180000msと各試験期限を区別し、今回のJSON・非0状態と所有子孫終了を確認。Vitest/browser/server終了後に一時treeを削除 | 古いreport、単一demoの成功、終了前のtree削除 |

転送の期限・再送・分割復旧は[build仕様](spec/v0.0.3/build.md#搬入完了の判定と有限再送)、Abseilの初回/適用済み件数・保護範囲は[ORT再生成契約](spec/v0.0.3/build.md#5-ort再生成)を正本とする。

## 4. 設計判断を固定する境界

| 境界 | 維持する決定 | 正本 |
| --- | --- | --- |
| 生成と製品build | 各builderは自身のpackage内で準備・生成・検査を完結させる。共通資材はこのprojectのdownloads、環境定義はdockerfileを使い、製品buildは検証済みの完成入力だけを読む | [build](spec/v0.0.3/build.md) |
| 環境と資材 | emsdk image指定は固定Node/CMake等の版確認や指定deb集合を免除しない。image内tool流用による別手順化は別提案 | [Linux toolchain](spec/v0.0.3/linux-toolchain.md) |
| ABIと公開面 | 公式SQLite default initializer・型・Worker1を維持。独自DBラッパーAPIへ置換しない | [product](spec/v0.0.3/product.md) |
| 推論所有者 | DB owner Workerと推論Workerを区別。moduleごとにsession一組、推論直列。通常SQLはmodelなし | [inference](spec/v0.0.3/inference.md) |
| backend | wasm既定、WebGPU/DirectML明示。自動fallback・別モデル・別SDKで救済しない | [product](spec/v0.0.3/product.md) |
| cacheと保存 | statement LRUと永続model cacheを混同しない。metadataのモデル空間識別は維持。closeでDB/cacheを削除しない | [storage](spec/v0.0.3/storage.md) |
| 配布と合否 | Node CJS/ESM・browser ESMと全assetをtarballへ収録。package内の相対URL、空consumer、実sampleで検証 | [build](spec/v0.0.3/build.md) |

内部moduleの署名は[内部API仕様](spec/v0.0.3/internal-api.md)を使う。テストの不足importを推測でstub化しない。仕様にない判断が必要なら、前提・影響する公開契約・代替案・必要な検査を記録し、既存契約と衝突する変更は合意前に実装しない。

## 5. 検証記録

工程ごとにrun UUID、入力の取得先/版、context/namespace/Pod/container、tool実測版、command/flags、終了状態、log、成果物の相対path、合格・失敗・未確認を記録する。credentialやモデル入力・vectorはlogへ残さない。転送検査のSHAは当該転送の記録に限り、製品runtime-lockの固定digest gateへ持ち込まない。

搬入検査、tool実起動、header probe、本体compile、成果物の実計算、製品試験の結果はそれぞれ記録する。準備やprobeの成功だけで後段の成功を宣言せず、ORT本体compile・4成果物の実計算・製品試験を今回の生成物で実行する。