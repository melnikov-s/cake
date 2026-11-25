import type { InsetDisclosureSection } from "./ui/inset-disclosures";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import type { SubagentActivityStore } from "../stores/SubagentActivityStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { Button } from "./ui/button";
import { ActivityDisclosure } from "./ui/activity-disclosure";
import { AutoMergeToggle, canShowAutoMerge } from "./auto-merge-toggle";
import { SessionPurposeIndicator } from "./ui/session-purpose-indicator";
import { ComposerCap } from "./ui/composer-cap";
import { textPreview } from "../lib/text-preview";
import { subagentTitle } from "../lib/subagent-title";

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
  const projectPath =
    running > 0 && placement !== "header" ? root.projectForSession(sessionId) : undefined;
  const showAutoMerge =
    projectPath !== undefined &&
    projectPath === root.workspaceProjectPath &&
    canShowAutoMerge(root.projectCatalogStore.find(projectPath));
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
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => root.activityHistoryStore.open(root.projectForSession(sessionId))}
          >
            History
          </Button>
          {showAutoMerge && <AutoMergeToggle projectPath={projectPath} />}
        </>
      }
      items={[
        ...sessions.map((session) => ({
          id: `session:${session.sessionId}`,
          title: session.title,
          description: ["Running", session.projectName].filter(Boolean).join(" · "),
          icon: (
            <SessionPurposeIndicator
              purpose={root.sessionCatalogStore.sessionPurpose(session.sessionId) ?? "user"}
            />
          ),
          iconLabel: "Project Session",
          status: "running" as const,
          accessibleLabel: `Open session: ${textPreview(session.title)}`,
          onSelect: () => void conversationActivity.openSession(session.sessionId),
        })),
        ...runs.map((run) => ({
          id: `subagent:${run.key}`,
          title: subagentTitle(run),
          fullText: run.task,
          description: "Running · Temporary subagent",
          icon: <SessionPurposeIndicator purpose="subagent" />,
          iconLabel: "Temporary subagent",
          status: "running" as const,
          accessibleLabel: `Inspect subagent: ${subagentTitle(run)}`,
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
