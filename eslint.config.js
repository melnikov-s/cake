import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import architecture from "./tools/eslint/module-boundaries.js";
import cake from "./tools/eslint/cake.js";

// These are imperative framework/SDK adapters, not domain execution sites.
// Keep this list explicit so a new boundary requires an architecture decision.
const effectExecutionBoundaries = [
  "src/main/main.ts", // Process entry point, runtime disposal, and Electron smoke hooks.
  "src/renderer/runtime.ts", // The one window-owned renderer runtime.
  "src/services/pi/PiCallbackAdapter.ts", // Final Cake Session capability callbacks supplied to Pi.
  "src/services/pi/PiWorkflows.ts", // Final callbacks required by focused external Pi workflows.
  "src/services/pi/live/WorkflowSandboxLive.ts", // Abortable Promise callbacks supplied to the standalone QuickJS sandbox.
  "src/services/pi/live/ArtifactRuntimeWorker.ts", // Abortable Promise callbacks supplied to the persistent artifact QuickJS worker.
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
  { plugins: { cake } },
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
  // Advisory debt checks: warnings are visible but never become CI gates.
  // Keep these separate from the existing architecture and anti-slop errors.
  {
    files: ["src/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/assets/**", "**/vendor/**", "**/generated/**", "**/build/**", "**/*.d.ts"],
    rules: { "max-lines": ["warn", { max: 1000, skipBlankLines: true, skipComments: true }] },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/assets/**", "**/vendor/**", "**/generated/**", "**/build/**", "**/*.d.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["warn", { ignoreVoid: true }],
      "@typescript-eslint/no-misused-promises": [
        "warn",
        { checksVoidReturn: { attributes: false } },
      ],
      "cake/reactive-collection-contract": [
        "warn",
        {
          // Deliberately nonreactive audio buffers, queues and bookkeeping.
          nonReactiveFields: [
            "ConversationModeStore.phrases",
            "ConversationModeStore.cursors",
            "ConversationModeStore.users",
            "ConversationModeStore.liveReplies",
            "ConversationModeStore.finalizing",
            "ConversationModeStore.preroll",
          ],
        },
      ],
      "cake/cause-recovery-boundaries": "warn",
      "cake/named-effect-operations": "warn",
    },
  },
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: { "cake/domain-native-orchestration": "warn" },
  },
  {
    files: ["src/renderer/components/**/*.{ts,tsx}", "src/renderer/hooks/**/*.{ts,tsx}"],
    ignores: ["src/renderer/components/ui/**"],
    rules: {
      "cake/view-capability-boundaries": "warn",
      "cake/react-effect-ownership": "warn",
      "cake/authoritative-controls": "warn",
    },
  },
  {
    files: [
      "src/renderer/components/settings/settings-text-field.tsx",
      "src/renderer/components/settings/settings-lines-field.tsx",
      "src/renderer/components/settings/settings-packages-field.tsx",
      "src/renderer/components/settings/settings-prompt-field.tsx",
    ],
    // Local editable-draft reconciliation, not workflow activation.
    rules: { "cake/react-effect-ownership": ["warn", { stateCopyExceptions: ["setDraft"] }] },
  },
  {
    files: ["src/renderer/components/slash-command-combobox.tsx"],
    // The input's editable local value reconciles an externally selected draft.
    rules: { "cake/react-effect-ownership": ["warn", { stateCopyExceptions: ["setInputValue"] }] },
  },
  {
    files: ["src/renderer/components/embedded-editor.tsx"],
    // Native WebContentsView theme integration; measurement and cleanup remain valid.
    rules: {
      "cake/react-effect-ownership": [
        "warn",
        { workflowExceptions: ["EmbeddedEditorStore.updateTheme"] },
      ],
    },
  },
  {
    files: ["src/main/main.ts", "src/main/MainApplication.ts", "src/renderer/runtime.ts"],
    // Explicit process/window supervision and final reporting boundaries.
    rules: { "cake/cause-recovery-boundaries": "off" },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: { "cake/deterministic-test-waits": "warn" },
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
