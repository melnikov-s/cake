import type { SessionPurpose } from "../../contracts/project-sessions/session-purpose";
import {
  SESSION_TITLE_MAX_LENGTH,
  type PiSessionSummary,
} from "../../contracts/conversations/session-contract";
import type {
  ProjectSessionLocation,
  ProjectSessionSummary,
} from "../../contracts/project-sessions/project-session-data";
import type { ProjectSessionArchiveMetadata } from "../../services/storage/SessionArchiveStorage";
import {
  familyChildren,
  familyDepth,
  familyMember,
  type SessionFamily,
  type SpawnedSession,
} from "../../contracts/session-families/session-family-document";

export const summary = (
  item: PiSessionSummary,
  location: ProjectSessionLocation,
  resolved: boolean,
  unreadIds: ReadonlySet<string>,
  running: boolean,
  family?: SessionFamily,
  spawn?: SpawnedSession,
  recoveryIssue?: string,
  latestTurnOutcome?: ProjectSessionSummary["latestTurnOutcome"],
  workingStartedAt?: number,
  purpose: SessionPurpose = "user",
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: item.id,
    purpose,
    title: item.title,
    createdAt: item.created,
    modifiedAt: item.modified,
    messageCount: item.messageCount,
    resolved,
    unread: unreadIds.has(item.id),
    running,
    projectPath: location.projectPath,
    projectName: location.projectName,
    workingDirectory: location.workingDirectory,
  };
  if (item.parentSessionId !== undefined)
    Object.assign(projected, { parentSessionId: item.parentSessionId });
  if (location.managedWorktree !== undefined)
    Object.assign(projected, {
      worktreeName: location.managedWorktree.branch.replace(/^agent\//, ""),
    });
  if (workingStartedAt !== undefined && running) Object.assign(projected, { workingStartedAt });
  if (recoveryIssue !== undefined) Object.assign(projected, { recoveryIssue });
  if (latestTurnOutcome !== undefined) Object.assign(projected, { latestTurnOutcome });
  applyFamilySummary(projected, family);
  if (spawn?.requester.kind === "cake-chat")
    Object.assign(projected, {
      cakeChatLaunch: {
        requesterSessionId: spawn.requester.sessionId,
        ...(spawn.launchedAt ? { launchedAt: spawn.launchedAt } : null),
        ...(spawn.lastReport ? { lastReport: spawn.lastReport } : null),
      },
    });
  return projected;
};

function applyFamilySummary(projected: ProjectSessionSummary, family?: SessionFamily) {
  if (!family) return;
  const member = familyMember(family, projected.sessionId);
  const depth = familyDepth(family, projected.sessionId);
  if (!member || depth === undefined) return;
  Object.assign(projected, {
    familyId: family.familyId,
    familyParentSessionId: member.parentSessionId ?? member.sessionId,
    familyChildSessionIds: familyChildren(family, member.sessionId).map((child) => child.sessionId),
    familyDepth: depth,
  });
  if (member.parentSessionId) {
    const order = familyChildren(family, member.parentSessionId).findIndex(
      (sibling) => sibling.sessionId === member.sessionId,
    );
    Object.assign(projected, { familyChildOrder: order });
  }
}

export const archivedSummary = (
  entry: ProjectSessionArchiveMetadata,
  title: string,
  unreadIds: ReadonlySet<string>,
  family?: SessionFamily,
  purpose: SessionPurpose = "user",
): ProjectSessionSummary => {
  const projected: ProjectSessionSummary = {
    sessionId: entry.sessionId,
    purpose,
    title: title.slice(0, SESSION_TITLE_MAX_LENGTH),
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    messageCount: 0,
    resolved: true,
    unread: unreadIds.has(entry.sessionId),
    running: false,
    projectPath: entry.projectPath,
    projectName: entry.projectName,
    workingDirectory: entry.workingDirectory,
  };
  if (entry.worktreeName) Object.assign(projected, { worktreeName: entry.worktreeName });
  applyFamilySummary(projected, family);
  return projected;
};
