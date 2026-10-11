import {
  CodeBlock,
  CodeBlockContainer,
  CodeBlockCopyButton,
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

  const copyButton = (source: string) => (
    <CodeBlockCopyButton
      code={source}
      className="absolute top-2 right-2 z-10 rounded-md bg-background/80 p-1.5 opacity-0 backdrop-blur transition-opacity hover:text-foreground focus:opacity-100 group-hover/code:opacity-100 group-focus-within/code:opacity-100"
    />
  );

  if (!changing)
    return (
      <div className="group/code relative my-4 [&_[data-streamdown=code-block]]:my-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden">
        <CodeBlock
          code={code}
          language={language}
          lineNumbers={lineNumbers}
          startLine={startLine}
        />
        {copyButton(code)}
      </div>
    );

  const source = trimTrailingNewlines(visibleCode);
  return (
    <CodeBlockContainer
      className="group/code relative my-4 gap-0 rounded-none border-0 bg-transparent p-0"
      isIncomplete
      language={language}
    >
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
      {copyButton(visibleCode)}
    </CodeBlockContainer>
  );
}
