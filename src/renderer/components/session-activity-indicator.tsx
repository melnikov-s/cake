import { sessionActivityDotStatus, type SessionActivity } from "../lib/session-activity";
import { cn } from "../lib/utils";
import { StatusDot } from "./ui/status-dot";

/** Established session activity language, shared by Project Sessions and the coordinator. */
export function SessionActivityIndicator({ activity }: { activity: SessionActivity | undefined }) {
  const status = activity && sessionActivityDotStatus[activity];
  if (!status) return null;
  const label =
    activity === "waiting"
      ? "Waiting for your answer"
      : activity === "running"
        ? "Running"
        : activity === "error"
          ? "Error"
          : "Ready, unread";
  return (
    <StatusDot
      status={status}
      className={cn(
        "session-status size-2",
        activity === "waiting" && "session-status-waiting ring-2 ring-attention/20",
        activity === "running" && "session-status-running",
        activity === "unread" && "session-status-unread ring-2 ring-success/20",
        activity === "error" && "session-status-error ring-2 ring-destructive/20",
      )}
      role="img"
      aria-hidden={undefined}
      aria-label={label}
      title={label}
    />
  );
}
