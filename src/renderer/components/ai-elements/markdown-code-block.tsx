import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockHeader,
  type CustomRendererProps,
} from "streamdown";

export const streamingCodeMarker = "__cake_streaming_code__";

const startLinePattern = /startLine=(\d+)/;
const noLineNumbersPattern = /\bnoLineNumbers\b/;
const lineNumberClasses =
  "block before:mr-4 before:inline-block before:w-6 before:select-none before:text-right before:font-mono before:text-[13px] before:text-muted-foreground/50 before:[counter-increment:line] before:content-[counter(line)]";

function trimTrailingNewlines(code: string) {
  return code.replace(/\n+$/, "");
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
      <CodeBlock code={code} language={language} lineNumbers={lineNumbers} startLine={startLine}>
        <CodeBlockCopyButton />
      </CodeBlock>
    );

  const source = trimTrailingNewlines(visibleCode);
  return (
    <CodeBlockContainer isIncomplete language={language}>
      <CodeBlockHeader language={language} />
      <div className="pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end">
        <div
          className="pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur"
          data-streamdown="code-block-actions"
        >
          <CodeBlockCopyButton code={visibleCode} />
        </div>
      </div>
      <div
        className="overflow-x-auto rounded-md border border-border bg-background p-4 text-sm"
        data-language={language}
        data-streamdown="code-block-body"
      >
        <pre>
          <code
            className={lineNumbers ? "[counter-increment:line_0] [counter-reset:line]" : undefined}
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
  );
}
