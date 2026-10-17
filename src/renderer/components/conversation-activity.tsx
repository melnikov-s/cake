import { observer, useStore } from "r-state-tree/react";
import {
  launchedSessionActivity,
  launchedSessionNeedsAttention,
  launchedSessionStatusLabel,
} from "../lib/cake-chat-launches";
import { RootStore } from "../stores/RootStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { ActivityMenu } from "./ui/activity-menu";
import { sessionActivityDotStatus } from "../lib/session-activity";
import { ComposerCap } from "./ui/composer-cap";

/** Activity belongs to the pane's conversation, not the window's current selection. */
export const ConversationActivity = observer(function ConversationActivity({
  sessionId,
  subagents,
  sideChat,
  onOpen,
  placement = "header",
}: {
  sessionId: string;
  subagents: SubagentActivityStore;
  sideChat: SideChatStore;
  onOpen?(): void;
  placement?: "header" | "composer" | "strip";
}) {
  const conversationActivity = useStore(RootStore).conversationActivityStore;
  const sessions = conversationActivity.sessionsFor(sessionId);
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
  const menu = (
    <ActivityMenu
      side={placement === "header" ? "bottom" : "top"}
      presentation={placement === "header" ? "pill" : "strip"}
      summary={summary}
      status={attention > 0 ? "attention" : "running"}
      onOpen={onOpen}
      groups={[
        {
          label: "Sessions",
          items: sessions.map((session) => {
            const activity = launchedSessionActivity[session.status];
            return {
              id: session.sessionId,
              title: session.title,
              description: [
                launchedSessionStatusLabel[session.status],
                session.projectName,
                session.summary,
              ]
                .filter(Boolean)
                .join(" · "),
              status: activity && sessionActivityDotStatus[activity],
              accessibleLabel: `Open session: ${session.title}`,
              onSelect: () => void conversationActivity.openSession(session.sessionId),
            };
          }),
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
            status: sessionActivityDotStatus.running,
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
  return placement === "composer" ? <ComposerCap>{menu}</ComposerCap> : menu;
});
