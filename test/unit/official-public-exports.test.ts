jest.mock("../../downloads/sqlite-official/sqlite3-bundler-friendly.mjs", () => ({ __esModule: true, default: jest.fn() }));
jest.mock("../../downloads/sqlite-official/sqlite3-worker1-promiser.mjs", () => ({ __esModule: true, default: jest.fn() }));

import * as nodeEntry from "../../src/index";
import * as browserEntry from "../../src/index-browser";

test("v0.0.3 exports: official default initializers replace the legacy Promise database API", () => {
  expect(nodeEntry).toHaveProperty("default", expect.any(Function));
  expect(browserEntry).toHaveProperty("default", expect.any(Function));
  expect(browserEntry).toHaveProperty("sqlite3Worker1Promiser", expect.any(Function));
  expect(nodeEntry).not.toHaveProperty("openVectorDatabase");
  expect(browserEntry).not.toHaveProperty("openVectorDatabase");
});