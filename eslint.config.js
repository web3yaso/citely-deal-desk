import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "demo/golden/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
    },
    rules: {
      // 不变量 5 的护栏之一：判定器 prompt 侧禁止字符串拼接材料。
      // 全局只报警告，adjudicator 目录下由 packages/engine 自己收紧为 error。
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["error"] }],
      eqeqeq: ["error", "always"],
    },
  },
);
