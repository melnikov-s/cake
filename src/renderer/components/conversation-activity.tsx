import { observer, useStore } from "r-state-tree/react";
import {
  launchedSessionNeedsAttention,
  launchedSessionStatusLabel,
  type LaunchedSessionStatus,
} from "../lib/cake-chat-launches";
import { RootStore } from "../stores/RootStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { ActivityMenu } from "./ui/activity-menu";
import type { StatusDotProps } from "./ui/status-dot";

const dotStatus = {
  running: "running",
  "needs-you": "attention",
  failed: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
  done: "complete",
  idle: "pending",
} satisfies Record<LaunchedSessionStatus, StatusDotProps["status"]>;

/** Activity belongs to the pane's conversation, not the window's current selection. */
export const ConversationActivity = observer(function ConversationActivity({
  sessionId,
  subagents,
  sideChat,
  onOpen,
}: {
  sessionId: string;
  subagents: SubagentActivityStore;
  sideChat: SideChatStore;
  onOpen?(): void;
}) {
  const activity = useStore(RootStore).conversationActivityStore;
  const sessions = activity.sessionsFor(sessionId);
  const runs = subagents.activeRuns;
  const attention = sessions.filter((session) =>
    launchedSessionNeedsAttention(session.status),
  ).length;
  const running = sessions.filter((session) => session.status === "running").length + runs.length;
  if (running === 0 && attention === 0) return null;
  const summary =
    attention > 0
      ? `${attention} ${attention === 1 ? "needs" : "need"} attention`
      : `${running} running`;
  return (
    <ActivityMenu
      summary={summary}
      status={attention > 0 ? "attention" : "running"}
      onOpen={onOpen}
      groups={[
        {
          label: "Sessions",
          items: sessions.map((session) => ({
            id: session.sessionId,
            title: session.title,
            description: [
              launchedSessionStatusLabel[session.status],
              session.projectName,
              session.summary,
            ]
              .filter(Boolean)
              .join(" · "),
            status: dotStatus[session.status],
            accessibleLabel: `Open session: ${session.title}`,
            onSelect: () => void activity.openSession(session.sessionId),
          })),
        },
        {
          label: "Subagents for this chat",
          items: runs.map((run) => ({
            id: run.key,
            title: run.task,
            description:
              run.status === "running"
                ? "Running · Temporary subagent"
                : "Queued · Temporary subagent",
            status: run.status === "running" ? "running" : "pending",
            action: "Inspect",
            accessibleLabel: `Inspect subagent: ${run.task}`,
            onSelect: () => {
              const chatStore = subagents.chatStore(run.key);
              if (!chatStore) return;
              sideChat.open({
                key: `subagent:${run.key}`,
                title: "Subagent",
                eyebrow: () => {
                  const current = subagents.run(run.key);
                  return `${current?.status ?? run.status}${current?.released ? " · Resources released" : ""}`;
                },
                chatStore,
              });
            },
          })),
        },
      ]}
    />
  );
});
