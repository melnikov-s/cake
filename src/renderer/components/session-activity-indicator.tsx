import type { SessionActivity } from "../lib/session-activity";
import { cn } from "../lib/utils";
import { StatusDot } from "./ui/status-dot";

/** Established session activity language, shared by Project Sessions and the coordinator. */
export function SessionActivityIndicator({
  activity,
  selected,
}: {
  activity: SessionActivity;
  selected: boolean;
}) {
  const label =
    activity === "waiting"
      ? "Waiting for your answer"
      : activity === "running"
        ? "Running"
        : activity === "error"
          ? "Error"
          : activity === "stopped"
            ? "Stopped"
            : "Ready, unread";
  return (
    <StatusDot
      status={activity === "waiting" ? "attention" : activity === "unread" ? "success" : activity}
      className={cn(
        "session-status size-2",
        activity === "waiting" && "session-status-waiting ring-2 ring-attention/20",
        activity === "running" && cn("session-status-running", selected && "bg-primary"),
        activity === "unread" && "session-status-unread ring-2 ring-success/20",
        activity === "error" && "session-status-error ring-2 ring-destructive/20",
        activity === "stopped" && "session-status-stopped",
      )}
      role="img"
      aria-hidden={undefined}
      aria-label={label}
      title={label}
    />
  );
}
