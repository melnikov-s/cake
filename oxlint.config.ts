import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
  overrides: [
    {
      // Raw Pi values terminate in the adapter. Runtime inspection is the
      // boundary mechanism; the rules that keep its Cake-facing outputs typed
      // remain enabled.
      files: ["src/services/pi/runtime/**/*.{ts,tsx}"],
      rules: {
        "anti-slop/no-reflect-get": "off",
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
      },
    },
    {
      // Shared IPC schemas and preload receive untrusted cross-process values.
      // They must accept and inspect unknown input before returning typed data.
      files: ["src/ipc/**/*.{ts,tsx}", "src/preload/**/*.{ts,tsx}"],
      rules: {
        "anti-slop/no-runtime-typeof": "off",
        "anti-slop/no-unknown-parameters": "off",
      },
    },
    {
      // Electron smoke tests intentionally probe for properties that must not
      // exist on sandboxed globals.
      files: ["tests/electron/**/*.{ts,tsx}"],
      rules: {
        "anti-slop/no-reflect-get": "off",
        "anti-slop/no-runtime-typeof": "off",
      },
    },
    {
      // CSS Highlights and the Highlight constructor are experimental browser
      // globals that TypeScript's DOM library does not expose consistently.
      files: [
        "src/renderer/app.tsx",
        "src/renderer/components/renderer-error-boundary.tsx",
        "src/renderer/main.tsx",
        "src/renderer/plugin-runtime.ts",
      ],
      rules: {
        "anti-slop/no-reflect-get": "off",
        "anti-slop/no-runtime-typeof": "off",
      },
    },
  ],
});
