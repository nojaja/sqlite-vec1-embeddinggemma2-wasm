# v0.0.1 永続化・整合性・復旧仕様

## 1. 通常接続と推論接続

通常接続は公式SQLiteのmemory、kvvfs、OPFS、OPFS-WL、SAH poolを上流どおり利用する。非空DBをモデル未bindとして拒否したり、管理表を追加したりしない。利用者transaction、pragma、trace、authorizerも公式契約を維持する。

embedding有効moduleでopenする接続だけは、open時のauto-extension内で同一接続のmetadataを検証する。read/write可能な新規空DBを標準とする。モデルの異なる生BLOBを利用者が直接INSERTしたことまでは検知できない。モデル空間の整合はDB単位のmetadataと利用者の保存ルールの両方で守る。

## 2. 正確な保存形式

`sqlite_schema.sql`と比較するDDLは次の文字列である。空白と列構成を勝手に変更しない。

```sql
CREATE TABLE _svw_meta(id INTEGER PRIMARY KEY CHECK(id=1), metadata TEXT NOT NULL) STRICT
```

1行だけ、id=1。metadata列は次の7項目を持つJSON object。値の型も厳密に一致させ、余分な項目を許可しない。backend/runtimeGenerationは保存しない。

```json
{
  "productVersion": "0.0.3",
  "modelId": "embeddinggemma-2",
  "revision": "daa72c51243991dfcaf9f9137d2c573d8f7790c0",
  "fingerprint": "5e730f96377d880c7ca94c9ddc9cd5f600e5237e106f5e4dc7d9448140026ac7",
  "profile": "embeddinggemma-2/q4/768",
  "dimension": 768,
  "dtype": "q4"
}
```

追加schemaVersionやcreatedAtを要求しない。identityから生成する項目はmodelId、revision、fingerprint、profile。残りはproductVersion（`"0.0.3"`：npm パッケージ版 `"0.0.1"` とは独立した保存メタデータ形式契約の固定バージョン識別子）、dimension（`768`）、dtype（`"q4"`）の固定値。`"0.0.3"` 以外の `productVersion`（例: `"0.0.1"`, `"0.0.2"`）は `E_MODEL_MISMATCH` として拒否する。backendを変えて同一論理空間を再openできる。

metadata表がない場合、`sqlite_schema`のうち `name NOT LIKE 'sqlite_%'` の件数0だけを新規空DBとしてbindする。非0はE_MODEL_UNBOUND。BEGIN IMMEDIATE内でDDLとbind付きINSERTを行いCOMMITする。失敗時ROLLBACK。JSONをSQLへ連結しない。

既存表はDDL完全一致、全行数1、id=1のJSON解析、objectのkey数/各値一致を要求する。不一致・欠落・余剰・不正JSONはE_MODEL_MISMATCH。上流C APIのprepare/step/finalizeで内部SQLを実行し、temporary Wasm allocationをfinallyで解放する。JS文字列bindの公式互換修正も通常capi向けに維持する。

### 2.1 予約領域の保護

metadata初期bind後にauthorizerを設置する。引数の先頭2つの名前にcase-insensitive `_svw_` prefixが含まれ、actionがSQLITE_READ以外なら拒否する。PRAGMA writable_schemaは読取り指定でも拒否する。業務table・通常transaction・他pragmaを旧ラッパーの禁止一覧で一律遮断しない。

公開sqlite3_set_authorizerは内部保護と利用者callbackを合成する。functionまたはWasm function pointerと引数を保持し、内部拒否を優先、それ以外は利用者の戻り値を尊重する。利用者のcallback解除で保護を解除しない。DB close時に登録pointerを解放し、module終了時は元bindingへ戻す。

## 3. Browser保存

製品sampleの推奨は公式installOpfsSAHPoolVfsと返されたOpfsSAHPoolDb。`clearOnInit:false`、`preserveOnInitFailure:true`、初期capacity=6、DELETE journal、synchronous=FULL、DB close後pauseVfsを使用する。利用者が公式APIで別optionを指定することまで製品initializerが勝手に上書きしない。

SAH poolの所有・排他は公式VFSの実装に委ね、同じorigin/directoryを別ownerから同時利用しない。demoのclearOnInit=trueは隔離originでの公式demo契約であり、製品sampleの非破壊設定とは別。kvvfs/sessionやOPFS-WLを推奨DB保存方式に読み替えない。

モデルcacheは `.svw-models`、業務DBのpool領域とは別。moduleのpool追跡は自分がinstallして返されたpoolだけとする。終了処理でremoveVfs/wipeFiles/clearOnInitを呼ばない。容量不足や初期化失敗で既存データを消して再作成しない。

HTTPS/信頼されたlocalhost、COOP=same-origin、COEP=require-corp、crossOriginIsolated、SAB、対応Wasm機能を必要とする。Wasm MIMEはapplication/wasm、CSPは配置したscript/worker/connectとwasm-unsafe-evalに限定し、任意blob/eval Workerを前提にしない。quota/eviction/サイトデータ削除を永続保存保証の例外として扱い、利用アプリがstorage estimateと明示backupを管理する。

## 4. Node file VFS

### 4.1 公開利用

Node initializerは `node-file` VFSを明示登録するが既定VFSを変えない。通常memory constructorと独立する。利用者は `new sqlite3.oo1.DB({filename,vfs:"node-file",flags:"c"})` 等の公式方式で選択する。SQLite本体はWasm、I/OはNode標準fs、SQLite JS StructBinder/VFS helperを使う。native SQLite addon、NODEFS mount、独自journal engineを代用しない。

io_methodsはversion1、VFS version1、mxPathname=1024、szOsFileは当該buildのsqlite3_file structから取得。offsetを手書き固定しない。xShm/xFetchによるWAL/mmapは提供しない。標準運用はDELETE/FULL、temp_store=MEMORY、foreign_keys=ON、trusted_schema=OFF、cache_size=-32768。これらを通常全接続へ強制する公開契約にはしない。

### 4.2 pathと所有

NodeSqliteFilesはfile pointerをkeyにdescriptor、canonical filename、main DB所有lock、一時directory、removeOnCloseを保持する。pathにはNULを許可しない。親を必要時作成し、親/既存祖先にsymlinkがなく、最終pathが未作成か通常fileであることを確認する。実在親のrealpathSync.nativeとbasenameを結合する。openはmode0600、read/write/create flagと利用可能ならO_NOFOLLOWを適用し、fstatでも通常fileを確認する。

hardlink別名、外部プログラムとの同時open、悪意あるpath差替えを安全に協調する一般purpose OS lockは保証しない。専用directoryと単一ownerが前提。symlink/reparse pointや特殊fileはE_STORAGE。

main DBのcanonical pathをWindowsでは小文字化してSHA-256 keyへ変換する。Windowsはnamed pipe `\\.\pipe\svw-sqlite-<key>`、LinuxはNUL先頭abstract socket `svw-sqlite-<key>` のlistener排他を使う。このhashはDB所有識別だけで、成果物hash合否ではない。

listener専用helper Workerはeval=true、execArgv=[]、4-byte SABで取得結果を同期通知する。取得待機最大10000ms、状態1成功、2 EADDRINUSE、3その他失敗。競合はE_DATABASE_LOCKED、その他/timeoutはE_STORAGEでhelperを停止する。DB所有WorkerのparentPort終了でもlistenerが終了し、同process内のowner Worker強制終了から再取得可能にする。PIDの生存推測やstale file削除を使わない。

releaseは一度だけ行い、helperへ通知してclose完了の状態4を最大10000ms待つ。失敗はE_STORAGE、helper terminate。processまたはowner終了でkernelが排他を解放する。モデルcacheのmkdir lockとは別の仕組み。

### 4.3 I/O契約

| callback | 動作・異常系 |
| --- | --- |
| xOpen | main lock取得後に通常fdをopen。失敗時lock/所有tempを回収しpMethods=NULL |
| xRead | partial readをloop、EOF残りを0埋め。要求未満はSQLITE_IOERR_SHORT_READ |
| xWrite | partial writeを全byte完了までloop、0進行/例外をWRITE error |
| xTruncate/xFileSize | ftruncate/fstat。int64 offsetは安全なNumber範囲だけを受理 |
| xSync | fsyncSyncを実行。失敗をFSYNC error。no-op成功不可 |
| xClose | entriesから外しfd close、finallyでlockと所有temp/delete-on-closeを回収 |
| xDelete | canonical通常fileをunlink。syncDirはLinux等POSIXで親fd fsync、Windowsはdirectory fsyncなし |
| xAccess | R_OKと必要ならW_OKで確認。不足はfalse |
| xLock/xUnlock/xCheckReservedLock | 外側kernel排他を前提にhandle内lock levelを保持 |
| xFileControl | 未対応はSQLITE_NOTFOUND。未知opcodeを成功扱いしない |
| xSectorSize/xDeviceCharacteristics | 4096、0。未検証atomic/safe-append能力を宣言しない |
| xRandomness/xCurrentTime/xSleep | Node crypto、Julian day、Atomics同期waitを使用 |

callbackはJS例外をC/Wasmへ漏らさず対応SQLite codeへ変換する。binding/struct/function pointerは生存file/DBより先に解放しない。filename=nullは所有mkdtemp配下のtemporary fileを作りcloseで回収する。利用者のDB本体をdisposeで削除しない。

## 5. 復旧とtransaction

業務表とvec1仮想表に外部キーによる自動整合はない。INSERT/UPDATE/DELETEは公式transactionで両方を変更する。途中の画像decode/推論失敗をcatchしてtransaction全体をrollbackする。入力不正はmodelを故障させず、次の正常queryが動作する。device/runtime故障はsessionをFAILEDにし、backend自動切替を行わない。

同一版backupはDB、package tarball、model cache、model/runtime manifests、外部画像原本の対応manifestを一組として保持する。全owner/Workerを停止し、一貫したDB imageを別pathまたは別poolへ復元する。開いたDBを直接上書きしない。metadata、fingerprint、quick_checkと業務ID/content revisionを確認してから切り替える。

crash復旧はSQLiteのrollback journalを使う。commit前に99行以上の大きな未commit更新をspillさせたprocess kill/同process owner Worker terminate後、再openしcommit済み行だけが残ることとquick_check=okを検査する。正常close/reopenだけをcrash試験の代用にしない。

電源断、物理disk故障、OSやbrowserの保存保証を超えるdurability、全クラッシュ注入点の実証、GPU物理取り外しを一部の成功から保証しない。強制停止でcommit境界不明なら自動再実行せず、復旧後の実データを照合する。
