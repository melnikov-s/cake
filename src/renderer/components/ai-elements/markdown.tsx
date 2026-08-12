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

type MarkdownProps = Omit<StreamdownProps, "children" | "components" | "mode" | "plugins" | "skipHtml"> & {
  children: string;
  streaming?: boolean;
};

export function Markdown({ children, className, streaming = false, ...props }: MarkdownProps) {
  return (
    <Streamdown
      className={cn("markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)}
      components={components}
      isAnimating={streaming}
      mode={streaming ? "streaming" : "static"}
      plugins={plugins}
      skipHtml
      {...props}
    >
      {children}
    </Streamdown>
  );
}
