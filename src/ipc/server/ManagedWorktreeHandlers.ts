import { Effect } from "effect";
import * as managedWorktrees from "../../domain/managedWorktrees";
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
  "managedWorktrees.get-worktree-status": (request) =>
    Effect.flatMap(RendererConnection, () => managedWorktrees.status(request.workspacePath)).pipe(
      Effect.map((status) => ({ status })),
    ),
  "managedWorktrees.prepare-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.prepareLanding(request.workspacePath, request.requestId),
    ).pipe(Effect.as({ requestId: request.requestId })),
  "managedWorktrees.land-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.land(request.workspacePath, request.requestId, request.request),
    ).pipe(Effect.map((result) => ({ requestId: request.requestId, result }))),
  "managedWorktrees.cancel-worktree-landing": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.cancelLanding(request.workspacePath, request.landingOperationId),
    ).pipe(Effect.as({ requestId: request.requestId })),
  "managedWorktrees.rebase-worktree": (request) =>
    Effect.flatMap(RendererConnection, () => managedWorktrees.rebase(request.workspacePath)).pipe(
      Effect.map((result) => ({ requestId: request.requestId, result })),
    ),
  "managedWorktrees.discard-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.discard(request.workspacePath, request.keepBranch),
    ).pipe(Effect.as({ requestId: request.requestId })),
});
