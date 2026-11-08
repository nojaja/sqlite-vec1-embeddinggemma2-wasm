# 開発方針

- docs/spec/v0.0.3の設計を読み、資材取得、実装、build、unit、integration、E2Eの順に進める。
- Node.js 24、TypeScript、CommonJSを使用し、browserの配布物はESMにする。設定は.js形式。
- コンテナでbuild・SQLite/ORT再生成を行う場合、明示的な別指定がなければ `emscripten/emsdk:6.0.8` を使用する。
- 取得資材はdownloads、モデルはmodelに置く。取得URLと保存先はREADMEおよびassets文書に従う。
- 外部I/Oは型付きmodule境界へ分離する。独自のSQL parser、tokenizer、推論engineを作らない。
- テストの入力・期待値・異常系を維持し、失敗原因を実装で修正して再実行する。coverageは各80%以上。
- 実model・GPU・永続化・offline試験はmockや固定成功reportで代用しない。実行不能な条件は理由とともに報告する。
- build、type-check、test、test:ci、lint、depcruise、typedocとE2Eを実行し、取得/生成不足と実装不適合を区別する。
- install scriptの全許可、backend自動fallback、監査無効化、品質閾値の引下げを行わない。
- コメントとJSDocは日本語。保存するtextはUTF-8 BOMなし、LFとする。
