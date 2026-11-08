module.exports = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/e2e/**/*.test.ts"],
  transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 1800000
};