import { resolveOfficialBrowserAssets } from "../../src/official/browser-inference";
import { MODEL_REPOSITORY, MODEL_REVISION } from "../../src/runtime-assets/model-contract";

test("official browser: resolves package-relative assets and default Hugging Face CDN URL independently of document URL", () => {
  const urls = resolveOfficialBrowserAssets("https://example.test/package/dist/index-browser.mjs");
  expect(urls.worker).toBe("https://example.test/package/dist/workers/inference-browser.mjs");
  expect((urls as { dbWorker?: string }).dbWorker).toBe("https://example.test/package/dist/workers/db-browser.mjs");
  expect(urls.manifest).toBe("https://example.test/package/manifests/embeddinggemma2-q4.json");
  expect(urls.modelBase).toBe(`https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/`);
});

test("official browser: allows cross-origin HTTPS/loopback CDN modelBaseUrl and rejects unsafe URLs", () => {
  const entry = "https://example.test/package/dist/index-browser.mjs";
  expect(
    resolveOfficialBrowserAssets(entry, {
      modelBaseUrl: "https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/"
    }).modelBase
  ).toBe("https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/main/");
  expect(
    resolveOfficialBrowserAssets(entry, "http://127.0.0.1:8080/models/").modelBase
  ).toBe("http://127.0.0.1:8080/models/");

  for (const url of [
    "http://other.test/assets/",
    "https://user:password@example.test/assets/",
    "https://example.test/assets/?token=bad",
    "https://example.test/assets/#bad",
    "https://example.test/assets"
  ]) {
    expect(() => resolveOfficialBrowserAssets(entry, url)).toThrow("E_ASSET_INTEGRITY");
  }
});

test("official browser: resolves explicit workerUrl and manifestUrl options for bundlers and CDNs", () => {
  const entry = "https://example.test/assets/index-browser.mjs";
  const resolved = resolveOfficialBrowserAssets(entry, {
    workerUrl: "./workers/custom-inference.mjs",
    dbWorkerUrl: "./workers/custom-db.mjs",
    manifestUrl: "https://example.test/static/embeddinggemma2-q4.json",
    modelBaseUrl: "https://cdn.example.com/models/gemma2/"
  } as Parameters<typeof resolveOfficialBrowserAssets>[1]);
  expect(resolved.worker).toBe("https://example.test/assets/workers/custom-inference.mjs");
  expect((resolved as { dbWorker?: string }).dbWorker).toBe("https://example.test/assets/workers/custom-db.mjs");
  expect(resolved.manifest).toBe("https://example.test/static/embeddinggemma2-q4.json");
  expect(resolved.modelBase).toBe("https://cdn.example.com/models/gemma2/");
});
