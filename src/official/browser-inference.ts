import { VectorError } from "../errors";
import { isSecureBrowserUrl } from "../runtime-assets/browser-model";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../runtime-assets/model-contract";

/**
 * 処理名: ブラウザ公式資材 URL 群
 */
export interface OfficialBrowserAssets {
  worker: string;
  manifest: string;
  modelBase: string;
}

/**
 * 処理名: 公式ブラウザ資材 URL 解決
 * 処理概要: entry URL からパッケージルートを導出し、推論ワーカー、マニフェスト、モデル配置先の絶対 URL を解決する。
 * 実装理由: ドキュメントの URL や HTML の配置階層に依存せず、常に同一パッケージ内の資材を安全に参照するため。
 * @param entryUrl - ブラウザエントリの URL。
 * @param modelRootUrl - 任意の明示的モデル配置先 URL (省略時はパッケージ内パス)。
 * @returns 解決済み資材 URL 群。
 */
export function resolveOfficialBrowserAssets(
  entryUrl: string,
  modelRootUrl?: string
): OfficialBrowserAssets {
  let entryParsed: URL;
  try {
    entryParsed = new URL(entryUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  // entryUrl (例: "https://example.test/package/dist/index-browser.mjs") から packageRoot を導出
  const packageRoot = new URL("../", entryParsed);
  if (!packageRoot.href.endsWith("/")) {
    packageRoot.href += "/";
  }

  const worker = new URL("dist/workers/inference-browser.mjs", packageRoot).href;
  const manifest = new URL("manifests/embeddinggemma2-q4.json", packageRoot).href;

  let modelBase: string;
  if (modelRootUrl !== undefined) {
    if (!modelRootUrl.endsWith("/")) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    let parsed: URL;
    try {
      parsed = new URL(modelRootUrl);
    } catch {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    if (!isSecureBrowserUrl(parsed)) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }

    if (parsed.origin !== entryParsed.origin) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    modelBase = modelRootUrl;
  } else {
    modelBase = new URL(`model/${MODEL_REPOSITORY.split("/")[1]}/${MODEL_REVISION}/`, packageRoot).href;
  }

  return {
    worker,
    manifest,
    modelBase
  };
}
