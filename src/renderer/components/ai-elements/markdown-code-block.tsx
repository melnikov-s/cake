import type { ReactNode } from "react";
import { CodeBlock, CodeBlockContainer, type CustomRendererProps } from "streamdown";
import { CopyButton } from "../ui/copy-button";

export const streamingCodeMarker = "__cake_streaming_code__";

const startLinePattern = /startLine=(\d+)/;
const noLineNumbersPattern = /\bnoLineNumbers\b/;
const lineNumberClasses =
  "block before:mr-4 before:inline-block before:w-6 before:select-none before:text-right before:font-mono before:text-sm before:text-muted-foreground/50 before:[counter-increment:line] before:content-[counter(line)]";

/** A fence's final newline is not part of the snippet; pasting it into a shell would run it. */
export function trimTrailingNewlines(code: string) {
  return code.replace(/\n+$/, "");
}

/**
 * The bordered box around one code snippet. The scrolling code body stops short of a
 * right gutter that holds the copy button, so code never runs underneath it.
 */
function CodeSnippetFrame({ code, children }: { code: string; children: ReactNode }) {
  return (
    <div
      data-slot="code-snippet"
      className="relative my-4 min-w-0 rounded-md border border-border bg-background [&_[data-streamdown=code-block-body]]:mr-9 [&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-transparent [&_[data-streamdown=code-block-body]]:pr-2 [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-body]_code>span]:before:text-xs"
    >
      {children}
      <CopyButton
        label="code"
        className="absolute top-1.5 right-1.5"
        getText={async () => trimTrailingNewlines(code)}
      />
    </div>
  );
}

/** Renders a growing fence as plain code and delegates a settled fence to Streamdown once. */
export function MarkdownCodeBlock({ code, language, meta }: CustomRendererProps) {
  const startLineMatch = meta?.match(startLinePattern);
  const startLine = startLineMatch ? Number.parseInt(startLineMatch[1]!, 10) : undefined;
  const lineNumbers = !meta || !noLineNumbersPattern.test(meta);
  const markerLine = `${streamingCodeMarker}\n`;
  const changing = meta?.split(/\s+/).includes(streamingCodeMarker) ?? false;
  const visibleCode =
    changing && code.startsWith(markerLine) ? code.slice(markerLine.length) : code;

  if (!changing)
    return (
      <CodeSnippetFrame code={code}>
        <CodeBlock
          code={code}
          language={language}
          lineNumbers={lineNumbers}
          startLine={startLine}
        />
      </CodeSnippetFrame>
    );

  const source = trimTrailingNewlines(visibleCode);
  return (
    <CodeSnippetFrame code={visibleCode}>
      <CodeBlockContainer isIncomplete language={language}>
        <div
          className="overflow-x-auto p-4 text-sm"
          data-language={language}
          data-streamdown="code-block-body"
        >
          <pre>
            <code
              className={
                lineNumbers ? "[counter-increment:line_0] [counter-reset:line]" : undefined
              }
              style={
                lineNumbers && startLine && startLine > 1
                  ? { counterReset: `line ${startLine - 1}` }
                  : undefined
              }
            >
              {source.split("\n").map((line, index) => (
                <span className={lineNumbers ? lineNumberClasses : "block"} key={index}>
                  {line || "\n"}
                </span>
              ))}
            </code>
          </pre>
        </div>
      </CodeBlockContainer>
    </CodeSnippetFrame>
  );
}
