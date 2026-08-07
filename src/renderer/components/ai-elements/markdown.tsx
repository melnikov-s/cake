import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./code";

const components: Components = {
  a(allProps) {
    const props = { ...allProps };
    delete props.node;
    return <a {...props} target="_blank" rel="noreferrer" />;
  },
  pre(allProps) {
    const props = { ...allProps };
    delete props.node;
    const { className, ...preProps } = props;
    return <CodeBlock className={cn("markdown-code-block", className)} {...preProps} />;
  },
  table(allProps) {
    const props = { ...allProps };
    delete props.node;
    const { className, ...tableProps } = props;
    return (
      <div className="markdown-table-wrap">
        <table className={className} {...tableProps} />
      </div>
    );
  }
};

export function Markdown({ children, className, ...props }: Omit<ComponentProps<"div">, "children"> & { children: string }) {
  return (
    <div className={cn("markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere]", className)} {...props}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
