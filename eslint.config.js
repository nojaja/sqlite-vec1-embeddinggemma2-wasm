const typescript = require("typescript-eslint");
const jsdoc = require("eslint-plugin-jsdoc");
const sonarjs = require("eslint-plugin-sonarjs");

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "vendor/**",
      "coverage/**",
      ".build/**",
      "artifacts/**",
      "docs/typedoc-md/**",
      "PoT/**",
      "downloads/**"
    ]
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: typescript.parser,
      parserOptions: { project: "./tsconfig.json" }
    },
    plugins: { "@typescript-eslint": typescript.plugin, jsdoc, sonarjs },
    settings: { jsdoc: { mode: "typescript" } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "sonarjs/cognitive-complexity": "off",
      "jsdoc/require-jsdoc": "off",
      "jsdoc/match-description": "off",
      "jsdoc/check-param-names": "off",
      "jsdoc/require-param": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-returns-check": "off"
    }
  },
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", ecmaVersion: 2022 },
    rules: { "no-unused-vars": "error", "no-undef": "off" }
  }
];
