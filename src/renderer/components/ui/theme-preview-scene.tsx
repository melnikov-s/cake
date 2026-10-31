import { useLayoutEffect, useRef } from "react";
import type { EditorColorTheme } from "../../../contracts/themes/color-theme";
import { cakeThemeTokens } from "../../../utils/vscode-theme";
import { syntaxTokenStyle, useHighlightedSource } from "../ai-elements/code";
import { SendIcon } from "./icons";

const sample = 'const theme = "Cake";\nreturn theme;';

/** A decorative Cake scene: ordinary app typography on a scaled canvas, not tiny UI controls. */
export function ThemePreviewScene({ theme }: { theme: EditorColorTheme }) {
  const custom = theme === "light" || theme === "dark" ? undefined : theme;
  const colorScheme = custom?.type ?? (theme === "dark" ? "dark" : "light");
  const element = useRef<HTMLDivElement>(null);
  const tokens = useHighlightedSource("preview.ts", sample, true, theme);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target || !custom) return;
    const palette = cakeThemeTokens(custom);
    for (const [name, value] of Object.entries(palette)) target.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(palette)) target.style.removeProperty(name);
    };
  }, [custom]);
  return (
    <div
      ref={element}
      data-color-theme={colorScheme}
      data-slot="theme-preview-scene"
      aria-hidden="true"
      className="pointer-events-none h-44 w-full overflow-hidden bg-background text-foreground"
    >
      <div className="grid h-[calc(100%/0.7)] w-[calc(100%/0.7)] origin-top-left scale-[0.7] grid-cols-[5rem_minmax(0,1fr)] grid-rows-[1.75rem_minmax(0,1fr)] text-left text-xs leading-tight font-normal">
        <div className="col-span-2 flex h-7 items-center gap-1.5 border-b border-border bg-sidebar px-3">
          <span className="size-2 rounded-full bg-traffic-light-close" />
          <span className="size-2 rounded-full bg-attention" />
          <span className="size-2 rounded-full bg-traffic-light-maximize" />
          <span className="ml-auto text-muted-foreground">Cake</span>
        </div>
        <div className="flex flex-col gap-3 border-r border-border bg-sidebar px-1.5 py-3 text-sidebar-foreground">
          <span className="px-1.5 font-medium">Project</span>
          <span className="rounded-sm bg-sidebar-active px-1.5 py-1.5 text-sidebar-selection-foreground">
            Chat
          </span>
          <span className="flex items-center gap-1.5 px-1.5 text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-success" />
            Ready
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
          <div className="self-end rounded-md bg-user-message px-3 py-1.5 text-user-message-foreground">
            Make it feel like Cake.
          </div>
          <div className="text-foreground">Here’s a fresh palette.</div>
          <pre className="min-w-0 rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre">
            <code>
              {tokens
                ? tokens.map((line, index) => (
                    <span className="block" key={index}>
                      {line.map((token) => (
                        <span
                          key={token.offset}
                          className="syntax-token"
                          style={syntaxTokenStyle(token, colorScheme)}
                        >
                          {token.content}
                        </span>
                      ))}
                    </span>
                  ))
                : sample}
            </code>
          </pre>
          <div className="mt-auto flex items-center justify-between gap-1.5 rounded-md border border-border bg-composer px-2 py-1.5 text-composer-foreground">
            <span className="text-muted-foreground">Message…</span>
            <span className="flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground [&_svg]:size-3.5">
              <SendIcon />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
