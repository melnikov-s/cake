import { Effect, SubscriptionRef } from "effect";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { ReviewStorage } from "../../services/storage/ReviewStorage";
import {
  SessionFamilyStorage,
  familyChildren,
  familyDepth,
  familyMember,
} from "../../services/storage/SessionFamilyStorage";
import { SubagentCoordinator } from "../../services/subagents/SubagentCoordinator";
import type { ProjectSessionLocation } from "./project-session-data";
import {
  ProjectSessionProjection,
  type SessionFamilyReference,
  type WorkingDirectoryReference,
} from "./project-session-data";

/**
 * Assembles the current Project Session aggregate projection from focused
 * authorities. Related payloads remain with those authorities; only bounded
 * references and summaries cross this boundary.
 */
export const assemble = Effect.fn("ProjectSessions.assembleProjection")(function* (input: {
  readonly sessionId: string;
  readonly location: ProjectSessionLocation;
  readonly resolved: boolean;
  readonly unread: boolean;
}) {
  const reviews = yield* ReviewStorage;
  const subagents = yield* SubagentCoordinator;
  const families = yield* SessionFamilyStorage;
  const artifacts = yield* ArtifactStorage;

  const [reviewRecords, subagentState, family, artifactCatalog] = yield* Effect.all(
    [
      reviews.listDiscussionRecords(input.location.workingDirectory, input.sessionId),
      SubscriptionRef.get(subagents.state),
      families.familyForMember(input.sessionId),
      artifacts.catalog(),
    ] as const,
    { concurrency: "unbounded" },
  );

  const member = family && familyMember(family, input.sessionId);
  const depth = family && familyDepth(family, input.sessionId);
  let familyProjection: SessionFamilyReference | undefined;
  if (family && member && depth !== undefined) {
    familyProjection = {
      familyId: family.familyId,
      rootProjectSessionId: family.parentSessionId,
      childProjectSessionIds: familyChildren(family, input.sessionId).map(
        (child) => child.sessionId,
      ),
      depth,
    };
    if (member.parentSessionId !== undefined)
      Object.assign(familyProjection, { parentProjectSessionId: member.parentSessionId });
  }
  const effectiveArtifactLinks = artifactCatalog.links.filter(
    (link) =>
      (link.target.type === "session" && link.target.sessionId === input.sessionId) ||
      (link.target.type === "family" && link.target.familyId === family?.familyId),
  );
  const workingDirectory: WorkingDirectoryReference = {
    path: input.location.workingDirectory,
  };
  if (input.location.worktreeName !== undefined)
    Object.assign(workingDirectory, { worktreeName: input.location.worktreeName });
  if (input.location.managedWorktree !== undefined)
    Object.assign(workingDirectory, { managedWorktree: input.location.managedWorktree });

  const projection: ProjectSessionProjection = {
    identity: {
      _tag: "ProjectSession",
      sessionId: input.sessionId,
      projectPath: input.location.projectPath,
      workingDirectory: input.location.workingDirectory,
    },
    project: { path: input.location.projectPath, name: input.location.projectName },
    workingDirectory,
    lifecycle: { resolved: input.resolved, unread: input.unread },
    primaryConversation: { sessionId: input.sessionId },
    discussionSessions: reviewRecords.flatMap((record) =>
      record.agentSessionId === undefined
        ? []
        : [
            {
              threadId: record.id,
              sessionId: record.agentSessionId,
              status: record.status,
              anchor: record.anchor.view ?? "file",
            },
          ],
    ),
    subagentSessions: [...subagentState.handles.values()]
      .filter((handle) => handle.parentSessionId === input.sessionId)
      .map((handle) => ({ handleId: handle.handleId, status: handle.status, task: handle.task })),
    reviewThreads: reviewRecords.map((record) => ({
      threadId: record.id,
      status: record.status,
      anchor: record.anchor.view ?? "file",
      updatedAt: record.updatedAt,
    })),
    artifactLinks: effectiveArtifactLinks,
  };
  if (familyProjection !== undefined) Object.assign(projection, { family: familyProjection });
  return yield* ProjectSessionProjection.makeEffect(projection);
});
