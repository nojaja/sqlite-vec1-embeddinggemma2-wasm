import { VectorError } from "../errors";
import { isSecureBrowserUrl } from "../runtime-assets/browser-model";
import { MODEL_REVISION } from "../runtime-assets/model-contract";

export interface OfficialBrowserAssets {
  worker: string;
  manifest: string;
  modelBase: string;
}

export function resolveOfficialBrowserAssets(
  entryUrl: string,
  modelBase?: string
): OfficialBrowserAssets {
  let entry: URL;
  try {
    entry = new URL(entryUrl);
  } catch {
    throw new VectorError("E_ASSET_INTEGRITY");
  }
  if (!isSecureBrowserUrl(entry)) {
    throw new VectorError("E_ASSET_INTEGRITY");
  }

  const worker = new URL("../workers/inference-browser.mjs", entry).href;
  const manifest = new URL("../../manifests/embeddinggemma2-q4.json", entry).href;

  let resolvedModelBase: string;
  if (modelBase !== undefined) {
    let base: URL;
    try {
      base = new URL(modelBase);
    } catch {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    const valid = isSecureBrowserUrl(base)
      && base.origin === entry.origin
      && base.username === ""
      && base.password === ""
      && base.search === ""
      && base.hash === ""
      && base.pathname.endsWith("/");
    if (!valid) {
      throw new VectorError("E_ASSET_INTEGRITY");
    }
    resolvedModelBase = base.href;
  } else {
    resolvedModelBase = new URL(`../../model/embeddinggemma-2-ONNX/${MODEL_REVISION}/`, entry).href;
  }

  return {
    worker,
    manifest,
    modelBase: resolvedModelBase
  };
}
