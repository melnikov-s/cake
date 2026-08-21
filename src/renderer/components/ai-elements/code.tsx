/* Inspired by Vercel AI Elements code-block.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). */
import { code } from "@streamdown/code";
import { useEffect, useState, type CSSProperties, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type HighlightResult = ReturnType<typeof code.highlight>;
export type HighlightTokens = NonNullable<HighlightResult>["tokens"];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

type HighlightToken = HighlightTokens[number][number];

export function syntaxTokenStyle(token: HighlightToken): CSSProperties {
  const style = {
    ...token.htmlStyle,
    // Shiki exposes the light color as `color` and the dark color as a CSS
    // variable. Keep both values available so the renderer can switch themes
    // without allowing a stale dark token color to bleed into light mode.
    "--shiki-light": token.htmlStyle?.color ?? "var(--foreground)",
  };
  // SAFETY: React's CSSProperties omits custom properties, but this object is a valid inline CSS map.
  return style as CSSProperties;
}

const languages = new Map<string, HighlightLanguage>([
  ["c", "c"],
  ["cc", "cpp"],
  ["cpp", "cpp"],
  ["css", "css"],
  ["go", "go"],
  ["html", "html"],
  ["htm", "html"],
  ["java", "java"],
  ["js", "javascript"],
  ["cjs", "javascript"],
  ["mjs", "javascript"],
  ["jsx", "jsx"],
  ["json", "json"],
  ["md", "markdown"],
  ["mdx", "mdx"],
  ["php", "php"],
  ["py", "python"],
  ["rb", "ruby"],
  ["rs", "rust"],
  ["scss", "scss"],
  ["sh", "shellscript"],
  ["bash", "shellscript"],
  ["sql", "sql"],
  ["svelte", "svelte"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["tsx", "tsx"],
  ["vue", "vue"],
  ["xml", "xml"],
  ["svg", "xml"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
]);

export function languageForSource(path: string): HighlightLanguage {
  return languages.get(path.split(".").pop()?.toLowerCase() ?? "") ?? "markdown";
}

export function highlightSource(
  path: string,
  source: string,
  apply: (tokens: HighlightTokens) => void,
) {
  const accept = (result: NonNullable<HighlightResult>) => apply(result.tokens);
  const immediate = code.highlight(
    // Use a high-contrast light theme for source diffs; github-light renders
    // punctuation and other neutral TypeScript tokens too faintly here.
    {
      code: source,
      language: languageForSource(path),
      themes: ["github-light-high-contrast", "github-dark"],
    },
    accept,
  );
  if (immediate) accept(immediate);
}

export function useHighlightedSource(path: string, source: string) {
  const [tokens, setTokens] = useState<HighlightTokens>();
  useEffect(() => {
    let active = true;
    setTokens(undefined);
    highlightSource(path, source, (next) => {
      if (active) setTokens(next);
    });
    return () => {
      active = false;
    };
  }, [path, source]);
  return tokens;
}

export function CodeBlock({ className, ...props }: ComponentProps<"pre">) {
  return (
    <pre
      className={cn(
        "my-3 max-w-full overflow-x-auto rounded-xl bg-foreground p-4 font-mono text-xs leading-6 text-background",
        className,
      )}
      {...props}
    />
  );
}
