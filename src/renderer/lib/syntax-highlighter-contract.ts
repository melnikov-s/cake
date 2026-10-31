import type { CodeHighlighterPlugin } from "streamdown";
import type { ImportedColorTheme } from "../../contracts/themes/color-theme";

export const syntaxThemes = ["github-light-high-contrast", "github-dark"] as const;
export const supportedSyntaxLanguages = [
  "c",
  "cpp",
  "css",
  "go",
  "html",
  "java",
  "javascript",
  "jsx",
  "json",
  "markdown",
  "mdx",
  "php",
  "python",
  "ruby",
  "rust",
  "scss",
  "shellscript",
  "sql",
  "svelte",
  "typescript",
  "tsx",
  "vue",
  "xml",
  "yaml",
] as const;
export type SupportedSyntaxLanguage = (typeof supportedSyntaxLanguages)[number];
export const maxHighlightCharacters = 200_000;

export type SyntaxHighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;
export type SyntaxHighlightRequest = {
  id: number;
  code: string;
  language: SupportedSyntaxLanguage;
  theme?: ImportedColorTheme;
};
export type SyntaxHighlightResponse = {
  id: number;
  result?: SyntaxHighlightResult;
  error?: string;
  metrics?: {
    coldLanguage: boolean;
    loadMs: number;
    tokenizeMs: number;
  };
};
