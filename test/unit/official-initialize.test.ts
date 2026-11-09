import { initializeOfficialRuntime } from "../../src/official/initialize";
import { registerEmbeddingExtension } from "../../src/official/registration";
import type { OfficialFactory } from "../../src/official/types";

jest.mock("../../src/official/registration", () => ({ registerEmbeddingExtension: jest.fn() }));

test("official initializer: forwards official options and never prepares omitted embedding", async () => {
  const close = jest.fn(async () => {});
  jest.mocked(registerEmbeddingExtension).mockReturnValue({ close });
  const factory = jest.fn(async () => ({})) as unknown as jest.MockedFunction<OfficialFactory>;
  const prepare = jest.fn();
  const print = jest.fn();
  await initializeOfficialRuntime(factory, { print }, { worker: false, runtime: "node", platform: "win32", architecture: "x64" }, prepare);
  expect(factory).toHaveBeenCalledWith({ print });
  expect(prepare).not.toHaveBeenCalled();
});

test("official initializer: awaits READY and releases session after all DBs close", async () => {
  const extensionClose = jest.fn(async () => {});
  jest.mocked(registerEmbeddingExtension).mockReturnValue({ close: extensionClose });
  const sessionClose = jest.fn(async () => {});
  const infer = jest.fn();
  const session = { infer, close: sessionClose, identity: { modelId: "embeddinggemma-2", revision: "r", fingerprint: "f", profile: "p", backend: "wasm", runtimeGeneration: 1 }, information: { ready: true } };
  const prepare = jest.fn(async () => session);
  const factory = jest.fn(async () => ({})) as unknown as OfficialFactory;
  const result = await initializeOfficialRuntime(factory, { embedding: { model: { network: "offline" } } }, { worker: true, runtime: "node", platform: "linux", architecture: "x64" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(registerEmbeddingExtension).toHaveBeenCalledWith(expect.anything(), infer, expect.objectContaining({ identity: session.identity, timeoutMs: 120000 }));
  await result.embedding.close();
  expect(extensionClose).toHaveBeenCalledTimes(1);
  expect(sessionClose).toHaveBeenCalledTimes(1);
});

test("official initializer: releases SAH pool handles without removing persistent data", async () => {
  const close = jest.fn(async () => {});
  jest.mocked(registerEmbeddingExtension).mockReturnValue({ close });
  const pool = { pauseVfs: jest.fn(), removeVfs: jest.fn() };
  const install = jest.fn(async () => pool);
  const factory = jest.fn(async () => ({ installOpfsSAHPoolVfs: install })) as unknown as OfficialFactory;
  const result = await initializeOfficialRuntime(factory, {}, { worker: true, runtime: "browser", platform: "browser", architecture: "browser" });
  await result.installOpfsSAHPoolVfs!({ clearOnInit: false, preserveOnInitFailure: true });
  await result.embedding.close();
  expect(pool.pauseVfs).toHaveBeenCalledTimes(1);
  expect(pool.removeVfs).not.toHaveBeenCalled();
});