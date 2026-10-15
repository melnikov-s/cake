import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import {
  launchedSessions,
  launchedSessionsSummary,
  launchedSessionStatusLabel,
  type LaunchedSessionStatus,
} from "../lib/cake-chat-launches";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { StatusDot, type StatusDotProps } from "./ui/status-dot";

const dotStatus = {
  running: "running",
  "needs-you": "attention",
  failed: "failed",
  stopped: "interrupted",
  done: "complete",
  idle: "pending",
} satisfies Record<LaunchedSessionStatus, NonNullable<StatusDotProps["status"]>>;

/** Quiet status of the Project Sessions Cake Chat launched; news never starts a turn. */
export const CakeChatLaunchedSessions = observer(function CakeChatLaunchedSessions() {
  const root = useStore(RootStore);
  const [open, setOpen] = useState(false);
  const sessions = launchedSessions(root.sessionCatalogStore.sessions, (sessionId) =>
    root.sessionMetadataStore.sessionActivity(sessionId),
  );
  if (!sessions.length) return null;
  const attention = sessions.some(
    (session) => session.status === "needs-you" || session.status === "failed",
  );
  const running = sessions.some((session) => session.status === "running");
  const summary = launchedSessionsSummary(sessions);
  return (
    <div className="pointer-events-auto mb-1.5 flex min-w-0 justify-start">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="h-7 gap-2 rounded-full bg-card/95 px-2.5 font-mono text-[10px] shadow-sm"
          size="sm"
          variant="outline"
          aria-label={`Launched sessions: ${summary}`}
        >
          <StatusDot status={attention ? "attention" : running ? "running" : "complete"} />
          {summary}
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[min(24rem,calc(100vw-24px))] p-2"
          side="top"
          aria-label="Sessions launched from Cake Chat"
        >
          <div className="mb-1 px-2 py-1">
            <strong className="font-mono text-[10px] uppercase tracking-wider">
              Launched from Cake Chat
            </strong>
          </div>
          <div className="grid max-h-80 gap-1 overflow-y-auto">
            {sessions.map((session) => (
              <Button
                key={session.sessionId}
                className="h-auto min-w-0 justify-start gap-2 px-2.5 py-2 text-left"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  void root.navigationStore
                    .openSessionLink(session.sessionId)
                    .catch((error: unknown) =>
                      root.toastStore.show({
                        tone: "error",
                        title: "Could not open session",
                        message: error instanceof Error ? error.message : String(error),
                      }),
                    );
                }}
              >
                <StatusDot status={dotStatus[session.status]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{session.title}</span>
                  <span className="block truncate font-mono text-[10px] font-normal text-muted-foreground">
                    {launchedSessionStatusLabel[session.status]} · {session.projectName}
                    {session.summary ? ` · ${session.summary}` : ""}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});
