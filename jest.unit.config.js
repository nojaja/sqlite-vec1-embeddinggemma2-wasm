module.exports = {
  testEnvironment: "node",
  testTimeout: 20000,
  testMatch: ["<rootDir>/test/unit/**/*.test.ts"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  clearMocks: true,
  restoreMocks: true,
  coverageProvider: "v8",
  collectCoverageFrom: ["src/**/*.ts"],
  coverageDirectory: "coverage/unit",
  coverageReporters: ["text", "json-summary", "lcov"],
  coverageThreshold: {
    global: { statements: 80, branches: 80, functions: 80, lines: 80 }
  }
};