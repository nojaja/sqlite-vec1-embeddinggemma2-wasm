import { resolveOfficialBrowserAssets } from "../../src/official/browser-inference";

test("official browser: resolves package-relative assets independently of document URL", () => {
  const urls = resolveOfficialBrowserAssets("https://example.test/package/dist/index-browser.mjs");
  expect(urls.worker).toBe("https://example.test/package/dist/workers/inference-browser.mjs");
  expect(urls.manifest).toBe("https://example.test/package/manifests/embeddinggemma2-q4.json");
  expect(urls.modelBase).toContain("/package/model/embeddinggemma-2-ONNX/");
});

test("official browser: honors explicit same-origin model root and rejects unsafe URLs", () => {
  const entry = "https://example.test/package/dist/index-browser.mjs";
  expect(resolveOfficialBrowserAssets(entry, "https://example.test/assets/").modelBase).toBe("https://example.test/assets/");
  for (const url of ["https://other.test/assets/", "https://user:password@example.test/assets/", "https://example.test/assets/?token=bad", "https://example.test/assets/#bad", "https://example.test/assets"]) {
    expect(() => resolveOfficialBrowserAssets(entry, url)).toThrow("E_ASSET_INTEGRITY");
  }
});