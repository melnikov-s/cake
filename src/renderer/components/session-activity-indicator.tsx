import {
  sessionActivityDotStatus,
  type SessionActivity,
  type SessionWorkActivity,
} from "../lib/session-activity";
import { cn } from "../lib/utils";
import { StatusDot } from "./ui/status-dot";

/** Established session activity language, shared by Project Sessions and the coordinator. */
export function SessionActivityIndicator({
  activity,
}: {
  activity: SessionActivity | SessionWorkActivity | undefined;
}) {
  const status = activity && sessionActivityDotStatus[activity];
  if (!status) return null;
  const label =
    activity === "blocked"
      ? "Needs your input"
      : activity === "waiting"
        ? "Waiting for your answer"
        : activity === "running"
          ? "Running"
          : activity === "error"
            ? "Error"
            : activity === "stopped"
              ? "Stopped"
              : activity === "ready"
                ? "Ready for review"
                : "Ready, unread";
  return (
    <StatusDot
      status={status}
      className={cn(
        "session-status size-2",
        activity === "blocked" && "ring-2 ring-attention/20",
        activity === "waiting" && "session-status-waiting ring-2 ring-attention/20",
        activity === "running" && "session-status-running",
        (activity === "unread" || activity === "ready") && "ring-2 ring-success/20",
        activity === "unread" && "session-status-unread",
        activity === "ready" && "session-status-ready",
        activity === "error" && "session-status-error ring-2 ring-destructive/20",
      )}
      role="img"
      aria-hidden={undefined}
      aria-label={label}
      title={label}
    />
  );
}
