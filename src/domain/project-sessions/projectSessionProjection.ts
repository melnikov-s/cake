import { Effect } from "effect";
import type { ProjectSessionLocation } from "./project-session-data";
import { ProjectSessionProjection, type WorkingDirectoryReference } from "./project-session-data";

/**
 * Builds the current on-demand Project Session overview. Conversation and
 * focused relationship payloads remain independently authoritative.
 */
export const assemble = Effect.fn("ProjectSessions.assembleProjection")(function* (input: {
  readonly sessionId: string;
  readonly location: ProjectSessionLocation;
  readonly resolved: boolean;
  readonly unread: boolean;
}) {
  const workingDirectory: WorkingDirectoryReference = {
    path: input.location.workingDirectory,
  };
  if (input.location.worktreeName !== undefined)
    Object.assign(workingDirectory, { worktreeName: input.location.worktreeName });
  if (input.location.managedWorktree !== undefined)
    Object.assign(workingDirectory, { managedWorktree: input.location.managedWorktree });

  return yield* ProjectSessionProjection.makeEffect({
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
  });
});
