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

type MarkdownProps = Omit<StreamdownProps, "children" | "components" | "isAnimating" | "mode" | "plugins" | "skipHtml"> & {
  children: string;
};

export function Markdown({ children, className, ...props }: MarkdownProps) {
  return (
    <Streamdown
      className={cn("markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}
      components={components}
      // Streaming mode mirrors parsed blocks through passive React state. Store updates already drive rendering.
      isAnimating={false}
      mode="static"
      plugins={plugins}
      skipHtml
      {...props}
    >
      {children}
    </Streamdown>
  );
}
