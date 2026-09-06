import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// These are imperative framework/SDK adapters, not domain execution sites.
// Keep this list explicit so a new boundary requires an architecture decision.
const effectExecutionBoundaries = [
  "src/main/main.ts", // Process entry point and Electron smoke hooks.
  "src/main/MainApplication.ts", // Electron lifecycle callbacks.
  "src/renderer/RendererRuntime.ts", // All renderer commands and subscriptions.
  "src/layers/CakeChatEnvironmentLive.ts", // Pi tool callbacks.
  "src/layers/ProjectSessionEnvironmentLive.ts", // Pi tool callbacks.
  "src/layers/ProjectSessionRuntimeOptionsLive.ts", // Pi runtime callbacks.
  "src/services/cake-chats/CakeChatEnvironment.ts", // Pi application controls.
  "src/services/pi/ProjectSessionIntegrationsLive.ts", // Pi repository callbacks.
  "src/services/worktrees/ManagedWorktreeEngineAdapter.ts", // Promise worktree engine.
  "src/services/vscode/VsCodeServerLive.ts", // Synchronous manager state callback.
  "src/services/storage/ReviewStorageLive.ts", // Synchronous test adapter factory.
];
const executionApi = "/^run(Fork|Callback|Promise|Sync)(Exit)?(With)?$/";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/node_modules/**",
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
    ignores: [...ignores, "src/main/main.ts", "src/renderer/RendererRuntime.ts"],
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
                "Execute Effects only at an approved runtime or external callback boundary. Compose Effects internally; renderer infrastructure uses RendererRuntime.execute.",
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
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/services/pi/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@earendil-works/pi-coding-agent",
                "@earendil-works/pi-coding-agent/*",
                "@earendil-works/pi-ai",
                "@earendil-works/pi-ai/*",
                "@earendil-works/pi-tui",
                "@earendil-works/pi-tui/*",
              ],
              message: "Ordinary Pi package imports belong beneath src/services/pi.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@earendil-works/pi-coding-agent",
              message: "Renderer code must use Cake-owned client contracts.",
            },
            {
              name: "electron",
              message: "Renderer code must use the typed preload bridge.",
            },
          ],
          patterns: [
            {
              group: ["node:*", "electron/*", "../agent/*", "../main/*", "../preload/*"],
              message: "Renderer code cannot import privileged process modules.",
            },
          ],
        },
      ],
    },
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
              message: "Renderer Stores and Models use RendererClient and passive reactive state.",
            },
          ],
          patterns: [
            {
              group: [
                "../../ipc/client/*",
                "../../ipc/protocol/*",
                "../RendererRuntime",
                "../RendererModelSynchronizer",
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
    files: ["src/renderer/RendererModelSynchronizer.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./stores/*", "./client/*"],
              message: "The Model synchronizer depends only on CakeIpcClient and passive Models.",
            },
          ],
        },
      ],
    },
  },
);
