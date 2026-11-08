import { StatementLifecycle } from "../../src/sqlite/statement-lifecycle";

const identity = { modelId: "embeddinggemma-2", revision: "fixed", fingerprint: "fixed", profile: "fixed", backend: "wasm", runtimeGeneration: 1 };

test("statement lifecycle: keeps ROW cache and creates fresh generation after DONE/reset", () => {
  const lifecycle = new StatementLifecycle(identity, 120000);
  const first = lifecycle.enter(1, 10);
  lifecycle.leave(10, 100);
  expect(lifecycle.enter(1, 10)).toBe(first);
  lifecycle.leave(10, 101);
  const second = lifecycle.enter(1, 10);
  expect(second.generation).toBeGreaterThan(first.generation);
  expect(second.cache).not.toBe(first.cache);
  lifecycle.leave(10, 100);
  lifecycle.reset(10);
  expect(lifecycle.enter(1, 10).generation).toBeGreaterThan(second.generation);
});

test("statement lifecycle: interleaves statements and connections without sharing", () => {
  const lifecycle = new StatementLifecycle(identity, 120000);
  const first = lifecycle.enter(1, 10);
  expect(lifecycle.current()).toBe(first);
  expect(() => lifecycle.enter(1, 20)).toThrow("E_PROTOCOL");
  lifecycle.leave(10, 100);
  const other = lifecycle.enter(1, 20);
  lifecycle.leave(20, 100);
  const second = lifecycle.enter(2, 30);
  lifecycle.leave(30, 100);
  expect(new Set([first.cache, other.cache, second.cache]).size).toBe(3);
  expect(lifecycle.enter(1, 10)).toBe(first);
});

test("statement lifecycle: disposes error/finalize/close and rejects missing context", () => {
  const lifecycle = new StatementLifecycle(identity, 120000);
  expect(() => lifecycle.current()).toThrow("E_PROTOCOL");
  const failed = lifecycle.enter(1, 10);
  lifecycle.leave(10, 1);
  expect(() => failed.cache.resolve({ operation: "query", body: "x", title: undefined }, () => null)).toThrow("E_PROTOCOL");
  lifecycle.enter(1, 10);
  lifecycle.leave(10, 100);
  lifecycle.reset(10);
  const fresh = lifecycle.enter(1, 10);
  lifecycle.leave(10, 100);
  lifecycle.close(1);
  expect(() => fresh.cache.resolve({ operation: "query", body: "x", title: undefined }, () => null)).toThrow("E_PROTOCOL");
});

test("statement lifecycle: paused row time counts and cancellation precedes cache hits", () => {
  let now = 0;
  const lifecycle = new StatementLifecycle(identity, 100, () => now);
  lifecycle.enter(1, 10);
  lifecycle.leave(10, 100);
  now = 100;
  expect(() => lifecycle.enter(1, 10)).toThrow("E_TIMEOUT");
  lifecycle.enter(1, 20);
  lifecycle.cancel();
  expect(() => lifecycle.current()).toThrow("E_CANCELLED");
});

test("statement lifecycle: retains only counters after execution disposal", () => {
  const lifecycle = new StatementLifecycle(identity, 120000);
  const execution = lifecycle.enter(1, 10);
  const value = new Uint8Array(3072); new DataView(value.buffer).setFloat32(0, 1, true);
  const input = { operation: "query" as const, body: "same", title: undefined };
  execution.cache.resolve(input, () => value);
  execution.cache.resolve(input, () => value);
  lifecycle.leave(10, 101);
  expect(lifecycle.statistics()).toMatchObject({ hit: 1, miss: 1, actualInference: 1, entries: 0, bytes: 0 });
  expect(JSON.stringify(lifecycle.statistics())).not.toContain("same");
});

test("statement lifecycle: nested native PROFILE does not end the owning step", () => {
  const lifecycle = new StatementLifecycle(identity, 120000);
  const execution = lifecycle.enter(1, 10);
  lifecycle.leave(999, 101);
  expect(lifecycle.current()).toBe(execution);
  lifecycle.leave(10, 101);
  expect(() => lifecycle.current()).toThrow("E_PROTOCOL");
});