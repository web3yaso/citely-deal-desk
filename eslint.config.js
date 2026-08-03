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
  {
    // 演示 UI 的三件套是**浏览器**里跑的无构建步骤脚本：document / window /
    // fetch / sessionStorage 不是未定义变量。不给它浏览器 globals，lint 会对
    // 每一行 DOM 调用报 no-undef（本文件加上这段之前，`pnpm lint` 就是红的）。
    files: ["packages/server/src/webapp/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
);
