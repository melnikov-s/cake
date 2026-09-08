import { Effect } from "effect";
import * as managedWorktrees from "../../domain/managedWorktrees";
import * as worktreeLandings from "../../domain/worktreeLandings";
import { ManagedWorktreeRpc } from "../protocol/ManagedWorktreeRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const managedWorktreeHandlers = ManagedWorktreeRpc.of({
  "managedWorktrees.create-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.create({
        projectPath: request.path,
        baseWorktreePath: request.baseWorktreePath,
        worktreeName: request.worktreeName,
        firstUserMessage: request.firstUserMessage,
      }),
    ).pipe(Effect.map((record) => ({ requestId: request.requestId, record }))),
  "managedWorktrees.get-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () => worktreeLandings.inspect(request)),
  "managedWorktrees.start-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () =>
      worktreeLandings.start({
        operationId: request.requestId,
        workspacePath: request.workspacePath,
        sessionId: request.sessionId,
        strategy: request.strategy,
        allowDirtyTarget: request.allowDirtyTarget,
        commitBeforeLanding: request.commitBeforeLanding,
      }),
    ).pipe(Effect.map((operation) => ({ requestId: request.requestId, operation }))),
  "managedWorktrees.retry-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () =>
      worktreeLandings.retry({
        workspacePath: request.workspacePath,
        sessionId: request.sessionId,
      }),
    ).pipe(Effect.map((operation) => ({ requestId: request.requestId, operation }))),
  "managedWorktrees.cancel-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () => worktreeLandings.cancel(request.workspacePath)).pipe(
      Effect.as({ requestId: request.requestId }),
    ),
  "managedWorktrees.start-worktree-rebase": (request) =>
    Effect.flatMap(RendererConnection, () =>
      worktreeLandings.startRebase({
        operationId: request.requestId,
        workspacePath: request.workspacePath,
        sessionId: request.sessionId,
      }),
    ).pipe(Effect.map((operation) => ({ requestId: request.requestId, operation }))),
  "managedWorktrees.discard-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.discard(request.workspacePath, request.keepBranch),
    ).pipe(Effect.as({ requestId: request.requestId })),
});
