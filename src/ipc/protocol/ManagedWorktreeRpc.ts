import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

type WorktreeOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "create-worktree"
  | "get-worktree-status"
  | "prepare-worktree-landing"
  | "land-worktree"
  | "cancel-worktree-landing"
  | "rebase-worktree"
  | "discard-worktree"
>;

const worktreeRpc = <Type extends WorktreeOperation>(type: Type) =>
  Rpc.make(`managedWorktrees.${type}` as const, {
    payload: cakeRpcPayloadSchemas[type],
    success: cakeRpcSuccessSchemas[type],
    error: ManagedWorktreeError,
  });

export const ManagedWorktreeRpc = RpcGroup.make(
  worktreeRpc("create-worktree"),
  worktreeRpc("get-worktree-status"),
  worktreeRpc("prepare-worktree-landing"),
  worktreeRpc("land-worktree"),
  worktreeRpc("cancel-worktree-landing"),
  worktreeRpc("rebase-worktree"),
  worktreeRpc("discard-worktree"),
);
