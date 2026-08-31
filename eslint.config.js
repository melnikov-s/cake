import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

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
);
