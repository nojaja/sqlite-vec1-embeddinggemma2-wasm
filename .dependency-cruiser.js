module.exports = {
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    { name: "no-missing-dependencies", severity: "error", from: {}, to: { couldNotResolve: true } },
    { name: "no-test-dependencies", severity: "error", from: { path: "^(src|tooling|scripts)/" }, to: { path: "^(test|PoT|samples)/" } },
    { name: "product-does-not-use-tooling", severity: "error", from: { path: "^src/" }, to: { path: "^(tooling|scripts)/" } },
    { name: "tooling-does-not-use-scripts", severity: "error", from: { path: "^tooling/" }, to: { path: "^scripts/" } },
    { name: "profile-has-no-io", severity: "error", from: { path: "^src/(inference/profile|bridge/protocol)\\.ts$" }, to: { dependencyTypes: ["core", "npm", "npm-dev"] } },
    { name: "workers-do-not-call-host", severity: "error", from: { path: "^src/workers/" }, to: { path: "^src/public/" } },
    { name: "browser-has-no-node-io", severity: "error", from: { path: "^src/(browser|storage/opfs|runtime-assets/browser)" }, to: { dependencyTypes: ["core"] } }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["types", "require", "node", "default"] }
  }
};