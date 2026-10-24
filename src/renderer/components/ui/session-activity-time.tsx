import { useEffect, useState } from "react";
import { isActiveSessionActivity, type SessionActivity } from "../../lib/session-activity";
import { cn } from "../../lib/utils";
import { formatElapsed } from "./loading-state";

/** Only this small time leaf ticks; the list and row never subscribe to a seconds clock. */
export function SessionActivityTime({
  modifiedAt,
  workingStartedAt,
  activity,
  activityTime,
  focusMode,
}: {
  modifiedAt: string;
  workingStartedAt?: number;
  activity?: SessionActivity;
  activityTime: string;
  focusMode: boolean;
}) {
  const working = isActiveSessionActivity(activity);
  const startedAt = working && Number.isFinite(workingStartedAt) ? workingStartedAt : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <time
      className={cn(
        "session-time shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground",
        focusMode && "text-xs",
      )}
      dateTime={
        working
          ? startedAt === undefined
            ? undefined
            : new Date(startedAt).toISOString()
          : modifiedAt
      }
      title={working ? undefined : new Date(modifiedAt).toLocaleString()}
    >
      {working
        ? startedAt === undefined
          ? "Working"
          : `Working ${formatElapsed(now - startedAt)}`
        : activityTime}
    </time>
  );
}
