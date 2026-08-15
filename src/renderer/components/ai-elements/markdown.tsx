import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import { Streamdown, type Components, type StreamdownProps } from "streamdown";
import { cn } from "@/lib/utils";

const components: Components = {
  a(allProps) {
    const props = { ...allProps };
    delete props.node;
    return <a {...props} target="_blank" rel="noreferrer" />;
  }
};

const mermaid = createMermaidPlugin({ config: { securityLevel: "strict" } });
const plugins = { code, math, mermaid };
const emptyStaticBlocks: string[] = [];
const staticBlocks: NonNullable<StreamdownProps["parseMarkdownIntoBlocksFn"]> = () => emptyStaticBlocks;

type MarkdownProps = Omit<StreamdownProps, "children" | "components" | "isAnimating" | "mode" | "parseMarkdownIntoBlocksFn" | "plugins" | "skipHtml"> & {
  children: string;
};

export function Markdown({ children, className, ...props }: MarkdownProps) {
  return (
    <Streamdown
      {...props}
      className={cn("markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}
      components={components}
      // Streamdown mirrors parsed blocks through passive state even in static mode. The static render path does not
      // consume those blocks, so keep their identity stable and let Store updates drive the rendered source directly.
      isAnimating={false}
      mode="static"
      parseMarkdownIntoBlocksFn={staticBlocks}
      plugins={plugins}
      skipHtml
    >
      {children}
    </Streamdown>
  );
}

export function fencedCode(source: string, language: string) {
  const longestFence = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}
