import type { InsetDisclosureSection } from "./ui/inset-disclosures";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { ActivityDisclosure } from "./ui/activity-disclosure";
import { AutoMergeToggle } from "./auto-merge-toggle";
import { ChatIcon, ForkIcon } from "./ui/icons";
import { ComposerCap } from "./ui/composer-cap";
import { textPreview } from "../lib/text-preview";

/** Activity belongs to the pane's conversation, not the window's current selection. */
export const ConversationActivity = observer(function ConversationActivity({
  sessionId,
  subagents,
  sideChat,
  onOpen,
  placement = "header",
  composerSections = [],
}: {
  sessionId: string;
  subagents: SubagentActivityStore;
  sideChat: SideChatStore;
  onOpen?(): void;
  placement?: "header" | "composer" | "strip";
  composerSections?: readonly InsetDisclosureSection[];
}) {
  const root = useStore(RootStore);
  const conversationActivity = root.conversationActivityStore;
  const sessions = conversationActivity
    .sessionsFor(sessionId)
    .filter((session) => session.status === "running");
  const runs = subagents.activeRuns.filter((run) => run.status === "running");
  const running = sessions.length + runs.length;
  if (running === 0 && composerSections.length === 0) return null;
  const activity = (
    <ActivityDisclosure
      key={sessionId}
      presentation={placement === "header" ? "pill" : "inset"}
      sessionCount={sessions.length}
      subagentCount={runs.length}
      sections={composerSections}
      summary={`${running} running`}
      status="running"
      onOpen={onOpen}
      actions={<AutoMergeToggle projectPath={root.projectForSession(sessionId)} />}
      items={[
        ...sessions.map((session) => ({
          id: `session:${session.sessionId}`,
          title: session.title,
          description: ["Running", session.projectName].filter(Boolean).join(" · "),
          icon: <ForkIcon />,
          iconLabel: "Project Session",
          status: "running" as const,
          accessibleLabel: `Open session: ${textPreview(session.title)}`,
          onSelect: () => void conversationActivity.openSession(session.sessionId),
        })),
        ...runs.map((run) => ({
          id: `subagent:${run.key}`,
          title: run.task,
          description: "Running · Temporary subagent",
          icon: <ChatIcon size={14} />,
          iconLabel: "Temporary subagent",
          status: "running" as const,
          accessibleLabel: `Inspect subagent: ${textPreview(run.task)}`,
          onSelect: () => {
            const chatStore = subagents.chatStore(run.key);
            if (!chatStore || !run.handleId) return;
            sideChat.open({
              key: `subagent:${run.key}`,
              navigationTarget: {
                kind: "subagent",
                sessionId: subagents.parentSessionId,
                handleId: run.handleId,
              },
              title: "Subagent",
              eyebrow: () => {
                const current = subagents.run(run.key);
                return `${current?.status ?? run.status}${current?.released ? " · Resources released" : ""}`;
              },
              model: () => subagents.model(run.key),
              chatStore,
            });
          },
        })),
      ]}
    />
  );
  return placement === "composer" ? <ComposerCap>{activity}</ComposerCap> : activity;
});
