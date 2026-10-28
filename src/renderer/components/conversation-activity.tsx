import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { ActivityDisclosure } from "./ui/activity-disclosure";
import { ChatIcon, ForkIcon } from "./ui/icons";
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
  const sessions = conversationActivity
    .sessionsFor(sessionId)
    .filter((session) => session.status === "running");
  const runs = subagents.activeRuns.filter((run) => run.status === "running");
  const running = sessions.length + runs.length;
  if (running === 0) return null;
  const activity = (
    <ActivityDisclosure
      presentation={placement === "header" ? "pill" : "strip"}
      summary={`${running} running`}
      status="running"
      onOpen={onOpen}
      items={[
        ...sessions.map((session) => ({
          id: `session:${session.sessionId}`,
          title: session.title,
          description: ["Running", session.projectName].filter(Boolean).join(" · "),
          icon: <ChatIcon size={14} />,
          iconLabel: "Project Session",
          status: "running" as const,
          accessibleLabel: `Open session: ${session.title}`,
          onSelect: () => void conversationActivity.openSession(session.sessionId),
        })),
        ...runs.map((run) => ({
          id: `subagent:${run.key}`,
          title: run.task,
          description: "Running · Temporary subagent",
          icon: <ForkIcon />,
          iconLabel: "Temporary subagent",
          status: "running" as const,
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
      ]}
    />
  );
  return placement === "composer" ? (
    <ComposerCap className="pb-5">{activity}</ComposerCap>
  ) : (
    activity
  );
});
