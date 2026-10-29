import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import architecture from "./tools/eslint/module-boundaries.js";

// These are imperative framework/SDK adapters, not domain execution sites.
// Keep this list explicit so a new boundary requires an architecture decision.
const effectExecutionBoundaries = [
  "src/main/main.ts", // Process entry point, runtime disposal, and Electron smoke hooks.
  "src/renderer/runtime.ts", // The one window-owned renderer runtime.
  "src/services/pi/PiCallbackAdapter.ts", // Final Cake Session capability callbacks supplied to Pi.
  "src/services/pi/PiWorkflows.ts", // Final callbacks required by focused external Pi workflows.
  "src/services/pi/live/WorkflowSandboxLive.ts", // Abortable Promise callbacks supplied to the standalone QuickJS sandbox.
  "src/layers/ProjectSessionRuntimeHostLive.ts", // Final artifact and renderer callbacks supplied to Pi.
  "src/layers/DesktopSharingLive.ts", // Durable account-binding callback supplied to the Node authentication boundary.
];
const executionApi = "/^run(Fork|Callback|Promise|Sync)(Exit)?(With)?$/";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
      "native/**/.build/**",
      // The companion extension is a Node CJS asset executed by the embedded
      // server's extension host, not application source.
      "src/assets/vscode-companion/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...[
    { files: ["src/**/*.{ts,tsx}"], execution: true, ignores: effectExecutionBoundaries },
    { files: effectExecutionBoundaries, execution: false, ignores: [] },
  ].map(({ files, execution, ignores }) => ({
    files,
    ignores: [...ignores, "src/main/main.ts", "src/renderer/runtime.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...(execution
          ? [
              `MemberExpression[computed=false][property.name=${executionApi}]`,
              `MemberExpression[computed=true][property.value=${executionApi}]`,
              `ImportSpecifier[imported.name=${executionApi}]`,
              `Property[parent.type=ObjectPattern][key.name=${executionApi}]`,
            ].map((selector) => ({
              selector,
              message:
                "Execute Effects only at an approved runtime or external callback boundary. Compose Effects internally; renderer infrastructure uses Runtime.execute.",
            }))
          : []),
        ...[
          "ImportSpecifier[imported.name=ManagedRuntime]",
          "ImportDeclaration[source.value='effect/ManagedRuntime']",
          "MemberExpression[property.name=ManagedRuntime]",
        ].map((selector) => ({
          selector,
          message: "ManagedRuntime belongs only in the main and renderer runtime roots.",
        })),
      ],
    },
  })),
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-empty-object-type": [
        "error",
        { allowInterfaces: "with-single-extends" },
      ],
    },
  },
  {
    files: ["src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: { architecture },
    rules: { "architecture/module-boundaries": "error" },
  },
  {
    files: ["src/renderer/stores/**/*.{ts,tsx}", "src/renderer/models/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect",
              message: "Renderer Stores and Models use Client and passive reactive state.",
            },
          ],
          patterns: [
            {
              group: [
                "effect/*",
                "**/ipc/client/**",
                "**/ipc/protocol/**",
                "**/renderer/runtime",
                "../runtime",
                "**/observers/**",
              ],
              message:
                "Effect RPC and synchronization mechanics belong to renderer infrastructure.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/renderer/observers/models.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../stores/!(RootStore)", "../client/*"],
              message:
                "The Model observer depends only on RootStore observation demand, Runtime, and passive Models.",
            },
          ],
        },
      ],
    },
  },
);
