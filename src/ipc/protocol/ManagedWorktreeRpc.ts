import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ResolvedManagedWorktreeCleanupPlan,
  ResolvedManagedWorktreeCleanupResult,
} from "../../domain/worktrees/managed-worktree-cleanup-data";
import { WorktreeLandingError } from "../../domain/worktrees/worktree-landing-data";
import { ManagedWorktreeCatalogUpdate } from "../../domain/worktrees/managed-worktree-data";
import { WorktreeOperationCatalogUpdate } from "../../domain/worktrees/worktree-operation-data";
import { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

type ManagedWorktreeOperation = "create-worktree" | "discard-worktree";
type LandingOperation =
  | "get-worktree-landing"
  | "start-worktree-landing"
  | "retry-worktree-landing"
  | "cancel-worktree-landing"
  | "start-worktree-rebase";

const managedWorktreeRpc = <Type extends ManagedWorktreeOperation>(type: Type) =>
  Rpc.make(`managedWorktrees.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: ManagedWorktreeError,
  });

const landingRpc = <Type extends LandingOperation>(type: Type) =>
  Rpc.make(`managedWorktrees.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: WorktreeLandingError,
  });

export const ManagedWorktreeRpc = RpcGroup.make(
  Rpc.make("managedWorktrees.observeCatalog", {
    success: ManagedWorktreeCatalogUpdate,
    error: ManagedWorktreeError,
    stream: true,
  }),
  Rpc.make("managedWorktrees.observeOperations", {
    success: WorktreeOperationCatalogUpdate,
    stream: true,
  }),
  managedWorktreeRpc("create-worktree"),
  landingRpc("get-worktree-landing"),
  landingRpc("start-worktree-landing"),
  landingRpc("retry-worktree-landing"),
  landingRpc("cancel-worktree-landing"),
  landingRpc("start-worktree-rebase"),
  managedWorktreeRpc("discard-worktree"),
  Rpc.make("managedWorktrees.inspectResolvedForProject", {
    payload: { projectPath: ResolvedManagedWorktreeCleanupPlan.fields.projectPath },
    success: ResolvedManagedWorktreeCleanupPlan,
    error: ManagedWorktreeError,
  }),
  Rpc.make("managedWorktrees.discardResolvedForProject", {
    payload: { projectPath: ResolvedManagedWorktreeCleanupPlan.fields.projectPath },
    success: ResolvedManagedWorktreeCleanupResult,
    error: ManagedWorktreeError,
  }),
);
