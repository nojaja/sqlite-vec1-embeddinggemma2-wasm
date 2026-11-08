import { validateEmbeddingOptions } from "../../src/official/options";

const worker = { worker: true, runtime: "node" as const, platform: "win32", architecture: "x64" };
const model = { network: "offline" as const };

test("official initializer: omitted embedding remains model-free", () => {
  expect(validateEmbeddingOptions(undefined, { ...worker, worker: false })).toBeUndefined();
});

test("official initializer: rejects embedding on main thread before preparation", () => {
  expect(() => validateEmbeddingOptions({ model }, { ...worker, worker: false })).toThrow("E_ENVIRONMENT");
});

test("official initializer: preserves explicit backends without fallback", () => {
  expect(validateEmbeddingOptions({ model }, worker)?.backend).toBe("wasm");
  expect(validateEmbeddingOptions({ model, backend: "directml" }, worker)?.backend).toBe("directml");
  expect(() => validateEmbeddingOptions({ model, backend: "webgpu" }, worker)).toThrow("E_ENVIRONMENT");
  expect(() => validateEmbeddingOptions({ model, backend: "directml" }, { ...worker, platform: "linux" })).toThrow("E_ENVIRONMENT");
  expect(validateEmbeddingOptions({ model, backend: "webgpu" }, { ...worker, runtime: "browser" })?.backend).toBe("webgpu");
  expect(() => validateEmbeddingOptions({ model, backend: "directml" }, { ...worker, runtime: "browser" })).toThrow("E_ENVIRONMENT");
});

test("official initializer: validates timeout boundaries and model policy", () => {
  expect(validateEmbeddingOptions({ model }, worker)).toMatchObject({ initTimeoutMs: 600000, sqlTimeoutMs: 120000 });
  for (const timeout of [1, 1800000]) expect(validateEmbeddingOptions({ model, initTimeoutMs: timeout, sqlTimeoutMs: timeout }, worker)?.sqlTimeoutMs).toBe(timeout);
  for (const timeout of [0, -1, 1800001, NaN, Infinity]) {
    expect(() => validateEmbeddingOptions({ model, initTimeoutMs: timeout }, worker)).toThrow("E_INPUT");
    expect(() => validateEmbeddingOptions({ model, sqlTimeoutMs: timeout }, worker)).toThrow("E_INPUT");
  }
  expect(() => validateEmbeddingOptions({ model: { network: "other" } } as never, worker)).toThrow("E_INPUT");
  expect(() => validateEmbeddingOptions({ model, backend: "auto" } as never, worker)).toThrow("E_INPUT");
});

test("official initializer: Node inference only accepts the supported platform and runtime matrix", () => {
  expect(validateEmbeddingOptions({ model }, { ...worker, platform: "linux" })?.backend).toBe("wasm");
  for (const platform of ["darwin", "freebsd"]) expect(() => validateEmbeddingOptions({ model }, { ...worker, platform })).toThrow("E_ENVIRONMENT");
  for (const architecture of ["arm64", "ia32"]) expect(() => validateEmbeddingOptions({ model }, { ...worker, architecture })).toThrow("E_ENVIRONMENT");
  for (const nodeMajor of [23, 25]) expect(() => validateEmbeddingOptions({ model }, { ...worker, nodeMajor })).toThrow("E_ENVIRONMENT");
  expect(validateEmbeddingOptions(undefined, { ...worker, platform: "darwin", architecture: "arm64" })).toBeUndefined();
});