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
  "managedWorktrees.land-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.land(request.workspacePath, request.request),
    ).pipe(Effect.map((result) => ({ requestId: request.requestId, result }))),
  "managedWorktrees.discard-worktree": (request) =>
    Effect.flatMap(RendererConnection, () =>
      managedWorktrees.discard(request.workspacePath, request.keepBranch),
    ).pipe(Effect.as({ requestId: request.requestId })),
});
