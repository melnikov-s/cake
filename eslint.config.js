import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// These are imperative framework/SDK adapters, not domain execution sites.
// Keep this list explicit so a new boundary requires an architecture decision.
const effectExecutionBoundaries = [
  "src/main/main.ts", // Process entry point, runtime disposal, and Electron smoke hooks.
  "src/renderer/runtime.ts", // The one window-owned renderer runtime.
  "src/layers/CakeChatEnvironmentLive.ts", // Final Promise callbacks supplied to Pi.
  "src/domain/projectSessionRuntime.ts", // Final Project Session capability callbacks supplied to Pi.
  "src/services/pi/ProjectSessionRuntimeHostLive.ts", // Artifact repository Promise callbacks supplied to Pi.
  "src/services/worktrees/ManagedWorktreeEngineAdapter.ts", // Existing imperative worktree engine port.
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
              message: "Renderer Stores and Models use Client and passive reactive state.",
            },
          ],
          patterns: [
            {
              group: ["../../ipc/client/*", "../../ipc/protocol/*", "../runtime", "../observers/*"],
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
