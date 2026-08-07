/* Adapted from Vercel AI Elements tool.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Uses Cake tool states. */
import type { UiPart } from "../../../ipc/session-contract";

export function Tool({ part }: { part: Extract<UiPart, { kind: "tool" }> }) {
  return (
    <details className="rounded-xl border border-border bg-muted/35 px-4 py-3" open={part.state === "error"}>
      <summary className="cursor-pointer font-mono text-xs font-semibold"><span className={`tool-state tool-${part.state}`} />{part.name} · {part.state}</summary>
      {part.input && <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{part.input}</pre>}
      {part.output && <pre className="mt-3 overflow-x-auto whitespace-pre-wrap border-t border-border pt-3 text-xs">{part.output}</pre>}
    </details>
  );
}
