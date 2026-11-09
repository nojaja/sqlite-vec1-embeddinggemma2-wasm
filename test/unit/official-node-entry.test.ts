import initialize from "../../src/official/node";
import { initializeOfficialRuntime } from "../../src/official/initialize";

jest.mock("../../src/official/initialize", () => ({
  initializeOfficialRuntime: jest.fn().mockResolvedValue({
    oo1: {},
    embedding: { close: jest.fn() }
  })
}));

test("official Node entry: allows embedding on main thread without E_ENVIRONMENT", async () => {
  const result = await initialize({ embedding: { model: { network: "offline" } } });
  expect(result).toBeDefined();
  expect(initializeOfficialRuntime).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining({ embedding: { model: { network: "offline" } } }),
    expect.objectContaining({ worker: false, runtime: "node" }),
    expect.any(Function)
  );
});