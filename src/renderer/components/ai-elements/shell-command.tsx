import { useState } from "react";
import type { UiPart } from "../../../ipc/session-contract";
import { Badge } from "../ui/badge";
import { DisclosureTrigger } from "../ui/disclosure-trigger";
import { TerminalIcon } from "../ui/icons";
import { fencedCode, Markdown } from "./markdown";

function commandStatus(state: Extract<UiPart, { kind: "command" }>["state"]) {
  return state === "running" ? "running" : state === "success" ? "complete" : "failed";
}

/** Renders a user-invoked `!` or `!!` command independently from agent work logs. */
export function ShellCommand({ part }: { part: Extract<UiPart, { kind: "command" }> }) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = part.output.length > 0;
  const open = hasOutput && expanded;
  const prefix = part.excludeFromContext ? "!!" : "!";

  return (
    <div
      data-slot="shell-command"
      className="overflow-hidden rounded-xl border border-border/80 bg-muted/35"
    >
      <DisclosureTrigger
        className="px-4 py-3"
        title={`${prefix} ${part.command}`}
        status={commandStatus(part.state)}
        open={open}
        disabled={!hasOutput}
        badge={
          part.excludeFromContext ? (
            <Badge variant="mono" size="xs">
              no context
            </Badge>
          ) : undefined
        }
        trailing={<TerminalIcon />}
        onClick={() => setExpanded((value) => !value)}
      />
      {hasOutput && (
        <div
          data-slot="shell-command-output"
          className="max-h-64 overflow-auto border-t border-border/60 px-4 pb-3"
          hidden={!open}
        >
          <Markdown className="pt-3 text-xs" highlightCode={part.state !== "running"}>
            {fencedCode(part.output, "text")}
          </Markdown>
        </div>
      )}
    </div>
  );
}
