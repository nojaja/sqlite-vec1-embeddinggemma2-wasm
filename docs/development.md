# 開発ガイド

## 1. 開発対象

このprojectでは、[製品仕様](spec/v0.0.1/product.md)と[配布仕様](spec/v0.0.1/build.md)に適合するSQLite/vec1/EmbeddingGemma 2のnpm moduleを作成する。公開API、配布内容、SQL・推論・保存・公式互換・sampleの実動作を受入条件に従って検証する。

外部資材は[READMEの取得URL](../README.md#資材-url-一覧)と[資材一覧](spec/v0.0.1/assets.md)に従ってdownloadsとmodelへ配置する。npm依存の導入はREADMEの `npm install` から開始し、設計・テスト・設定に沿って製品、build処理、sampleを実装する。上流への限定変更はbuild仕様の変更範囲と合格条件に従う。

本書は実施手順であり、製品契約の正本は[設計書一覧](spec/v0.0.1/README.md)である。契約間に矛盾があれば前提と影響を確認し、暗黙のfallbackで回避しない。

## 2. 最小の実施順序

最小とは不要な環境再構築や失敗後の全工程やり直しを避ける順序であり、固定資材や受入gateの削減ではない。初回の各工程はこのproject内で実装する。まだないscriptを既存であるかのように実行しない。

| 順序 | 実施内容 | 次へ進む条件 |
| --- | --- | --- |
| 1 | READMEのURLからdownloads/modelへ資材を取得し、npm installで依存を導入してlockを生成・審査。assetsとLinux toolchainの必要file一覧を作る | npm依存と29 archive、用途別77/13/4deb、mirrorの不足が区別されている。model/G03資材は別工程として管理 |
| 2 | 指定emsdk 6.0.8の専用Linux x64 workspaceを準備。run UUIDを作り必要資材を搬入 | 全必要fileの転送一致とarchive検査。|
| 3 | run専用toolchainへ展開し固定toolとPython moduleを実起動 | [Linux準備条件](spec/v0.0.1/linux-toolchain.md)を満たす。基盤glibcを置換しない |
| 4 | SQLiteのfolder-local builderと検査を実装。未変更上流を新規source rootへ展開し限定patchを適用 | SQLite source構成、build仕様の限定変更（vec1静的組み込み、STRICT VECTOR型ネイティブ受容、上流バグ修正、OPFS void参照等）、再適用不変・対象外不変、header probeが合格 |
| 5 | SQLite8fileを生成して検査。推論用ORT資材（JSEP/JSPI 4file）および画像コーデックWasmを配置・検査 | SQLite loader・SQL/vec1/DISTANCE、ORT・Transformers.js推論動作、run別完了状態・flagsが合格 |
| 6 | 検証済み出力を転送検査後に製品downloadsへ配置。通常SQL入口と公式互換を実装 | モデルなしの公式API・型・9demo・上流smokeが合格。通常SQLを推論環境制限で拒否しない |
| 7 | 固定q4、manifest/license、codec/cache、Worker推論、同期SQL bridge、metadata/VFS/LRUを実装 | unitから実SQLite・実モデル・保存・offlineへ進み、Node/Edgeと明示backendの条件を満たす |
| 8 | E2E、sample、配布と監査を実装し最終tarballを検証 | [受入条件](spec/v0.0.1/acceptance.md)の全gate、3空consumer、Node/Edge sample、全severity0。G03参照生成も別途完了 |

SQLiteの再生成runと推論資材の配置を管理する。「同じrunの一式」はSQLiteの8fileに適用し、異なるvariantや古いloader/Wasmを混ぜない。ORTランタイム資材（JSEP/JSPI 4file）は `onnxruntime-web` パッケージから `dist/ort/` へコピー配置する。製品buildは完成入力だけを読み、builderのsource/patch/reportを読み込まない。検査済み資材を保持し、失敗した工程とその依存後段だけを再実行する。sourceやpatchを変えた場合は新規run/treeで生成し直す。

各工程で関連テストを実行し、失敗原因を修正して同じテストを繰り返す。入力・期待値・異常系・期限・品質閾値を維持し、unit、integration、E2Eまで確認する。期限は[上流smokeの実行設定](spec/v0.0.1/acceptance.md#41-上流smokeの実行設定)に限りNode側60000msを使用し、browser側の既定5000msと他の製品試験は変更しない。

## 3. 失敗時の戻り先

以下の警告・異常に関する行は[推論ビルド仕様](spec/v0.0.1/build.md#4-推論ビルド仕様-scriptsbuildinferencets)および[SQLite再生成仕様](spec/v0.0.1/build.md#2-sqlite-再生成仕様-dockersqlite-runtime-build)と合わせて使う。「warning抑制・降格を成功にしない」は許可外の追加・範囲拡大を指す。

| 症状 | 判定と次の作業 | 成功とは扱わないもの |
| --- | --- | --- |
| remoteに後続directoryがない、gzip/tarがEOF | 展開前に全件照合。不一致fileだけ有限再送。大容量は4MiB分割・part検査・連結・全体検査後rename | file存在・非空 |
| 一致したarchiveが展開不能 | 原本も末尾まで検査して取得失敗と転送失敗を分離。正常原本を保持し原因を記録 | 別版への差替え・HTML保存 |
| Node/CMake/Pythonのlibrary不足 | 専用overlayと指定deb内の限定4 library、stdlib、PATHを確認 | 基盤libc上書き、OS一括APT導入 |
| ORT Wasm/JS資材が見つからない、コピー失敗 | `node_modules/onnxruntime-web/dist/` の存在と指定4資材（JSEP/JSPI）の整合性を確認。npm install状態を再点検 | 欠落資材の無視、別バージョンの無断導入 |
| 生成・配置完了だが推論/SQLが失敗 | SQLite 8 fileの同一run整合性、および `dist/ort/` へのORT資材コピー配置・ABI・runtime optionを確認し再配置・再検証 | syntax/validateだけの成功 |
| 実model/GPU/G03資材がない | 不足と未確認gateを記録。独立した実行可能工程は進めてもreleaseは停止 | mock、既存vector、別backendによる代用 |
| 上流Wasm hash URL試験が5000msでtimeout | [smoke runner仕様](spec/v0.0.1/build.md#上流sqlite-smoke-runner)のNode project60000ms、browser既定維持、子Vite専用aliasと導入済み固定Viteの解決を確認。起動/build時間とassertionを切り分ける | 9/10成功、試験本文変更、別bundler、事前buildした固定結果 |
| 9demo成功後のsmokeや後処理が失敗 | 全体子process上限180000msと各試験期限を区別し、今回のJSON・非0状態と所有子孫終了を確認。Vitest/browser/server終了後に一時treeを削除 | 古いreport、単一demoの成功、終了前のtree削除 |

転送の期限・再送・分割復旧および推論資材の配置仕様は[build仕様](spec/v0.0.1/build.md)を正本とする。

## 4. 設計判断を固定する境界

| 境界 | 維持する決定 | 正本 |
| --- | --- | --- |
| 生成と製品build | 各builderは自身のpackage内で準備・生成・検査を完結させる。SQLiteは専用環境で再生成し、推論資材（ORT等）はonnxruntime-webからコピー配置する。製品buildは検証済みの完成入力だけを読む | [build](spec/v0.0.1/build.md) |
| 環境と資材 | emsdk image指定は固定Node/CMake等の版確認や指定deb集合を免除しない。image内tool流用による別手順化は別提案 | [Linux toolchain](spec/v0.0.1/linux-toolchain.md) |
| ABIと公開面 | 公式SQLite default initializer・型・Worker1を維持。独自DBラッパーAPIへ置換しない | [product](spec/v0.0.1/product.md) |
| 推論所有者 | DB owner Workerと推論Workerを区別。moduleごとにsession一組、推論直列。通常SQLはmodelなし | [inference](spec/v0.0.1/inference.md) |
| backend | wasm既定、WebGPU/DirectML明示。自動fallback・別モデル・別SDKで救済しない | [product](spec/v0.0.1/product.md) |
| cacheと保存 | statement LRUと永続model cacheを混同しない。metadataのモデル空間識別は維持。closeでDB/cacheを削除しない | [storage](spec/v0.0.1/storage.md) |
| 配布と合否 | Node CJS/ESM・browser ESMと全assetをtarballへ収録。package内の相対URL、空consumer、実sampleで検証 | [build](spec/v0.0.1/build.md) |

内部moduleの署名は[内部API仕様](spec/v0.0.1/internal-api.md)を使う。テストの不足importを推測でstub化しない。仕様にない判断が必要なら、前提・影響する公開契約・代替案・必要な検査を記録し、既存契約と衝突する変更は合意前に実装しない。

## 5. 検証記録

工程ごとにrun UUID、入力の取得先/版、context/namespace/Pod/container、tool実測版、command/flags、終了状態、log、成果物の相対path、合格・失敗・未確認を記録する。credentialやモデル入力・vectorはlogへ残さない。転送検査のSHAは当該転送の記録に限り、製品runtime-lockの固定digest gateへ持ち込まない。

搬入検査、tool実起動、header probe、本体compile、成果物の実計算、製品試験の結果はそれぞれ記録する。準備やprobeの成功だけで後段の成功を宣言せず、SQLite本体compile・推論資材コピー配置・成果物の実計算・製品試験を今回の成果物で実行する。