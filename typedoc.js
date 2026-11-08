module.exports = {
  entryPoints: ["src/index.ts"],
  tsconfig: "tsconfig.build.json",
  plugin: ["typedoc-plugin-markdown"],
  out: "docs/typedoc-md",
  readme: "none",
  disableSources: true,
  excludePrivate: true,
  excludeProtected: true,
  validation: { notExported: true, invalidLink: true, notDocumented: true },
  treatWarningsAsErrors: true
};