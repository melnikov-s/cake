import type { SubagentReportOrigin } from "../../contracts/subagents/subagent-data";
import type { CrossSessionBadge } from "./cross-session-presentation";

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

/** The worker's status on its report card, beside the worker's name. */
export function subagentReportBadge(report: SubagentReportOrigin): CrossSessionBadge {
  switch (report.status) {
    case "complete":
      return { label: "Completed", tone: "success", description: "The worker finished its task." };
    case "error":
      return report.failurePhase === "start"
        ? { label: "Failed to start", tone: "destructive", description: "No worker was created." }
        : {
            label: "Failed",
            tone: "destructive",
            description: "The worker stopped with an error.",
          };
    case "aborted":
      return { label: "Aborted", tone: "default", description: "The worker was cancelled." };
    case "queued":
      return { label: "Queued", tone: "default", description: "The worker has not started yet." };
    case "running":
      return { label: "Running", tone: "default", description: "The worker is still running." };
  }
}
