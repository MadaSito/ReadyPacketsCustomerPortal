import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "migrations/**", "ref/**", "coverage/**", "client/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-console": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      eqeqeq: ["error", "always"],
    },
  },
  {
    files: ["server/**/*.ts", "portable/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/client/**", "@/*"], message: "Server code must not import client code." }] }],
      "no-restricted-syntax": [
        "error",
        { selector: "CallExpression[callee.property.name='exec'][callee.object.name='child_process']", message: "Use execFile/spawn with argument arrays; never a shell string." },
        { selector: "MemberExpression[object.name='sql'][property.name='raw']", message: "sql.raw is forbidden; use parameterized drizzle expressions." },
      ],
    },
  },
  {
    files: ["scripts/**/*.ts", "portable/cli/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Operator-side Node scripts (installer helpers, build script). They print to the operator's terminal.
    files: ["deploy/**/*.mjs", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-console": "off" },
  },
  {
    files: ["client/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      "no-restricted-globals": ["error", { name: "localStorage", message: "No browser storage for portal data." }, { name: "sessionStorage", message: "No browser storage for portal data." }, { name: "indexedDB", message: "No browser storage for portal data." }],
      "no-restricted-properties": ["error", { property: "dangerouslySetInnerHTML", message: "Render text, not HTML." }, { object: "window", property: "localStorage" }, { object: "window", property: "sessionStorage" }],
      "no-restricted-syntax": ["error", { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Render text, not HTML." }],
      "no-restricted-imports": ["error", { patterns: [{ group: ["**/server/**", "@server/*"], allowTypeImports: true, message: "Client may import server TYPES only." }] }],
    },
  },
  { files: ["**/*.test.{ts,tsx}", "tests/**"], rules: { "@typescript-eslint/no-explicit-any": "off", "@typescript-eslint/no-non-null-assertion": "off" } },
);
