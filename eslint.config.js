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
      "@typescript-eslint/no-explicit-any": "error",
      "sonarjs/cognitive-complexity": ["error", 10],
      "jsdoc/require-jsdoc": ["error", {
        exemptEmptyConstructors: false,
        exemptEmptyFunctions: false,
        require: {
          FunctionDeclaration: true,
          FunctionExpression: true,
          ArrowFunctionExpression: true,
          MethodDefinition: true,
          ClassDeclaration: true
        },
        contexts: ["TSInterfaceDeclaration", "TSMethodSignature"]
      }],
      "jsdoc/match-description": ["error", {
        matchDescription: "^[\\s\\S]*処理名:[\\s\\S]*処理概要:[\\s\\S]*実装理由:[\\s\\S]*$",
        contexts: ["any"]
      }],
      "jsdoc/check-param-names": "error",
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
      "jsdoc/require-returns-check": "error"
    }
  },
  {
    files: ["**/*.js"],
    languageOptions: { sourceType: "commonjs", ecmaVersion: 2022 },
    rules: { "no-unused-vars": "error", "no-undef": "off" }
  }
];