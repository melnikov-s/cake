import { useEffect, useState } from "react";
import { Callout } from "@/components/ui/callout";
import type { UiPart } from "../../ipc/session-contract";

function retryDuration(milliseconds: number) {
  const seconds = Math.ceil(Math.max(0, milliseconds) / 1_000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds < 3_600) return `${Math.ceil(seconds / 60)} minute${seconds <= 60 ? "" : "s"}`;
  return `${Math.ceil(seconds / 3_600)} hour${seconds <= 3_600 ? "" : "s"}`;
}

export function RetryNotice({ part }: { part: Extract<UiPart, { kind: "notice" }> }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (part.retryAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [part.retryAt]);

  const retryAt = part.retryAt;
  const countdown =
    retryAt === undefined
      ? undefined
      : `Next retry in ${retryDuration(retryAt - now)}, at ${new Date(retryAt).toLocaleTimeString(
          [],
          {
            hour: "numeric",
            minute: "2-digit",
            second: retryAt - now < 60_000 ? "2-digit" : undefined,
          },
        )}. Press Stop to cancel.`;

  return (
    <Callout
      variant={part.tone === "error" ? "error" : part.tone === "warning" ? "warning" : "default"}
      role={part.tone === "error" ? "alert" : "status"}
    >
      <strong className="block text-xs font-semibold">{part.title}</strong>
      {part.detail && <span className="block text-xs text-muted-foreground">{part.detail}</span>}
      {countdown && <span className="block text-xs text-muted-foreground">{countdown}</span>}
    </Callout>
  );
}
