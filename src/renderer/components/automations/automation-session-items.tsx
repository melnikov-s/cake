import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { NavItem } from "../ui/nav-item";
import { RepeatIcon } from "../ui/icons";
import { sessionDisplayId } from "../../lib/session-display-id";
import { SessionActivityIndicator } from "../session-activity-indicator";

export const AutomationSessionItems = observer(function AutomationSessionItems({
  projectPath,
}: {
  projectPath?: string;
}) {
  const root = useStore(RootStore);
  const selection = root.appShellStore.selection;
  const knownIds = root.automationSessionsStore.catalog.unresolvedSessions.map(
    (item) => item.sessionId,
  );
  return (
    <>
      {root.automationSessionsStore.sessionsForProject(projectPath).map((session) => (
        <NavItem
          key={session.sessionId}
          icon={<RepeatIcon />}
          label={
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate">{session.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {sessionDisplayId(session.sessionId, knownIds)}
              </span>
            </span>
          }
          description={
            <span className="block truncate">
              {session.running ? "Running · Automation" : "Needs review · Automation"}
            </span>
          }
          active={
            selection.kind === "automation-session" && selection.sessionId === session.sessionId
          }
          onClick={() => root.navigationStore.openAutomationSession(session.sessionId)}
          trailing={
            <SessionActivityIndicator
              activity={session.running ? "running" : session.unread ? "unread" : undefined}
            />
          }
        />
      ))}
    </>
  );
});
