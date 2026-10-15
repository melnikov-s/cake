import type { SubagentReportOrigin } from "../../contracts/subagents/subagent-data";

/** Hide only Cake's exact generated envelope, never a guessed paragraph of findings.
 * Delivery text and persisted originals retain the assignment for agent context. */
export function subagentReportFindings(text: string, report: SubagentReportOrigin): string {
  const envelope = `Background subagent ${report.status}: ${report.task.slice(0, 500)}\n\n`;
  return text.startsWith(envelope) && text.length > envelope.length
    ? text.slice(envelope.length)
    : text;
}

export function subagentReportHeading(report: SubagentReportOrigin): string {
  switch (report.status) {
    case "complete":
      return "Subagent complete";
    case "error":
      return report.failurePhase === "start" ? "Subagent failed to start" : "Subagent failed";
    case "aborted":
      return "Subagent aborted";
    case "queued":
      return "Subagent queued";
    case "running":
      return "Subagent running";
  }
}
