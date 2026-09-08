import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { WorktreeLandingError } from "../../domain/worktree-landing-data";
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
  managedWorktreeRpc("create-worktree"),
  landingRpc("get-worktree-landing"),
  landingRpc("start-worktree-landing"),
  landingRpc("retry-worktree-landing"),
  landingRpc("cancel-worktree-landing"),
  landingRpc("start-worktree-rebase"),
  managedWorktreeRpc("discard-worktree"),
);
