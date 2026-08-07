/* Inspired by Vercel AI Elements response.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Raw HTML is never parsed. */
import { CodeBlock } from "./code";

export function Markdown({ children }: { children: string }) {
  const chunks = children.split(/```/g);
  return (
    <div className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {chunks.map((chunk, index) => index % 2
        ? <CodeBlock key={index}><code>{chunk.replace(/^\w+\n/, "")}</code></CodeBlock>
        : <span key={index}>{chunk}</span>)}
    </div>
  );
}
