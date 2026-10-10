import type {
  AppControlHost,
  AgentControlSource,
  AppControlState,
  AppControlSession,
  AppControlSessionLabel,
  SessionSummaryView,
} from "./app-control-data";

export function getAppState(host: AppControlHost, source?: AgentControlSource): AppControlState {
  const sessions = sortedSessions(host);
  const state: AppControlState = {
    selection: host.state.currentSelection(),
    projectCount: host.state.projects().length,
    sessionCount: sessions.length,
    projects: host.state.projects().map((project) => ({
      path: project.path,
      name: project.name,
      sessionCount: sessions.filter((session) => session.workingDirectory === project.path).length,
    })),
    attentionSessions: sessions
      .filter((session) => host.state.sessionActivity(session.sessionId))
      .map((session) => toControlSession(host, session)),
    recentSessions: sessions.map((session) => toControlSession(host, session)),
  };
  const sessionLayout = host.state.sessionLayout?.(source);
  if (sessionLayout) state.sessionLayout = sessionLayout;
  return state;
}

export function sessionLabels(host: AppControlHost): AppControlSessionLabel[] {
  return [
    ...host.state.globalSessionLabels().map((label) => ({
      ...label,
      scope: "global" as const,
    })),
    ...host.state.projects().flatMap((project) =>
      (project.workflow?.labels ?? []).map((label) => ({
        ...label,
        scope: "project" as const,
        projectPath: project.path,
      })),
    ),
  ];
}

function sortedSessions(host: AppControlHost) {
  return [...host.state.sessions()].sort((left, right) =>
    right.modifiedAt.localeCompare(left.modifiedAt),
  );
}

export function knownSession(host: AppControlHost, sessionId: string) {
  return host.state.sessions().find((session) => session.sessionId === sessionId);
}

export function orderedFamilySessions(
  host: AppControlHost,
  familyId: string,
): SessionSummaryView[] {
  const members = host.state.sessions().filter((session) => session.familyId === familyId);
  const byId = new Map(members.map((session) => [session.sessionId, session]));
  const root = members.find((session) => session.familyDepth === 0);
  if (!root) return [];
  const ordered: SessionSummaryView[] = [];
  const visited = new Set<string>();
  const visit = (session: SessionSummaryView) => {
    if (visited.has(session.sessionId)) return;
    visited.add(session.sessionId);
    ordered.push(session);
    for (const childId of session.familyChildSessionIds ?? []) {
      const child = byId.get(childId);
      if (child) visit(child);
    }
  };
  visit(root);
  // Preserve visibility if a temporarily incomplete projection omits a child link.
  for (const session of members
    .filter((member) => !visited.has(member.sessionId))
    .sort(
      (left, right) =>
        (left.familyDepth ?? 0) - (right.familyDepth ?? 0) ||
        (left.familyChildOrder ?? 0) - (right.familyChildOrder ?? 0),
    ))
    visit(session);
  return ordered;
}

export function toControlSession(
  host: AppControlHost,
  session: SessionSummaryView,
): AppControlSession {
  const activity = host.state.sessionActivity(session.sessionId);
  const result = {
    workspacePath: session.workingDirectory,
    workspaceName: session.projectName,
    sessionId: session.sessionId,
    title: session.title,
    modified: session.modifiedAt,
    messageCount: session.messageCount,
    resolved: session.resolved,
    draft: session.draft,
  };
  const managedWorktree = host.state.managedWorktree(session.workingDirectory);
  const resultWithWorktree = managedWorktree ? { ...result, managedWorktree } : result;
  const resultWithFamily = session.familyId
    ? {
        ...resultWithWorktree,
        familyId: session.familyId,
        familyParentSessionId: session.familyParentSessionId,
        familyChildSessionIds: session.familyChildSessionIds,
        familyChildOrder: session.familyChildOrder,
        familyDepth: session.familyDepth,
      }
    : resultWithWorktree;
  const project = host.state.projects().find((item) => item.path === session.projectPath);
  const labelIds =
    project?.workflow?.assignments.find((assignment) => assignment.sessionId === session.sessionId)
      ?.labelIds ?? [];
  const available = sessionLabels(host);
  const labels = labelIds.flatMap((labelId) => {
    const label = available.find(
      (item) =>
        item.id === labelId && (item.scope === "global" || item.projectPath === project?.path),
    );
    return label ? [label] : [];
  });
  const resultWithLabels = labels.length > 0 ? { ...resultWithFamily, labels } : resultWithFamily;
  return activity ? { ...resultWithLabels, activity } : resultWithLabels;
}
