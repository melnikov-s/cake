import { Effect } from "effect";
import { defaultProjectSettings } from "./application-data";
import { getState, trustProject } from "./application";
import { generateWorktreeName, utilityModelSelection } from "./utilityWork";
import type { WorktreeLandRequest } from "../ipc/worktree-contract";
import { ProjectAccess } from "../services/projects/ProjectAccess";
import { Terminal } from "../services/terminal/Terminal";
import { ManagedWorktreeError, ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";

const policyError = (operation: string, cause: unknown) =>
  new ManagedWorktreeError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const requireAllowed = Effect.fn("ManagedWorktrees.requireAllowed")(function* (
  workingDirectory: string,
) {
  const access = yield* ProjectAccess;
  if (!(yield* access.isAllowed(workingDirectory)))
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireAllowed",
      message: "Project path was not selected by the user",
    });
});

const requireRecord = Effect.fn("ManagedWorktrees.requireRecord")(function* (
  workingDirectory: string,
  allowedStates: ReadonlySet<"active" | "landed">,
) {
  const service = yield* ManagedWorktrees;
  const record = (yield* service.records()).find((candidate) => {
    const state = candidate.state ?? "active";
    return (
      candidate.worktreePath === workingDirectory &&
      ((state === "active" && allowedStates.has("active")) ||
        (state === "landed" && allowedStates.has("landed")))
    );
  });
  if (!record)
    return yield* new ManagedWorktreeError({
      operation: "ManagedWorktrees.requireRecord",
      message: "Cake could not find that worktree",
    });
  return record;
});

export const create = Effect.fn("ManagedWorktrees.create")(function* (input: {
  readonly projectPath: string;
  readonly baseWorktreePath?: string;
  readonly worktreeName?: string;
  readonly firstUserMessage?: string;
}) {
  yield* requireAllowed(input.projectPath);
  const state = yield* getState();
  let worktreeName = input.worktreeName;
  if (!worktreeName && input.firstUserMessage && state.utilityModel) {
    worktreeName = yield* generateWorktreeName({
      selection: utilityModelSelection(state.utilityModel),
      firstUserMessage: input.firstUserMessage,
    }).pipe(Effect.catch(() => Effect.succeed(undefined)));
  }
  const record = yield* (yield* ManagedWorktrees).create(
    input.projectPath,
    input.baseWorktreePath,
    worktreeName,
    state.projects.find((project) => project.path === input.projectPath)?.settings ??
      defaultProjectSettings(),
  );
  const access = yield* ProjectAccess;
  yield* access
    .allow(record.worktreePath)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)));
  if (state.trustedProjectPaths.includes(record.projectPath))
    yield* trustProject(record.worktreePath).pipe(
      Effect.mapError((cause) => policyError("ManagedWorktrees.create", cause)),
    );
  return record;
});

export const status = Effect.fn("ManagedWorktrees.status")(function* (workingDirectory: string) {
  return yield* (yield* ManagedWorktrees).status(workingDirectory);
});

export const prepareLanding = Effect.fn("ManagedWorktrees.prepareLanding")(function* (
  workingDirectory: string,
  operationId: string,
) {
  yield* requireRecord(workingDirectory, new Set(["active"]));
  return yield* (yield* ManagedWorktrees).prepareLanding(workingDirectory, operationId);
});

export const land = Effect.fn("ManagedWorktrees.land")(function* (
  workingDirectory: string,
  operationId: string,
  request: WorktreeLandRequest,
) {
  yield* requireRecord(workingDirectory, new Set(["active"]));
  return yield* (yield* ManagedWorktrees).land(workingDirectory, operationId, request);
});

export const cancelLanding = Effect.fn("ManagedWorktrees.cancelLanding")(function* (
  workingDirectory: string,
  operationId: string,
) {
  return yield* (yield* ManagedWorktrees).cancelLanding(workingDirectory, operationId);
});

export const rebase = Effect.fn("ManagedWorktrees.rebase")(function* (workingDirectory: string) {
  yield* requireRecord(workingDirectory, new Set(["active"]));
  return yield* (yield* ManagedWorktrees).rebase(workingDirectory);
});

export const discard = Effect.fn("ManagedWorktrees.discard")(function* (
  workingDirectory: string,
  keepBranch: boolean,
) {
  yield* requireRecord(workingDirectory, new Set(["active", "landed"]));
  yield* (yield* Terminal)
    .closeWorkingDirectory(workingDirectory)
    .pipe(Effect.mapError((cause) => policyError("ManagedWorktrees.discard", cause)));
  yield* (yield* ManagedWorktrees).discard(workingDirectory, keepBranch);
});
