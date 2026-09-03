import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ManagedWorktreeError } from "../../services/worktrees/ManagedWorktrees";
import { cakeRpcPayloadSchemas, cakeRpcSuccessSchemas } from "../cake-rpc-contract";

type WorktreeOperation = keyof Pick<
  typeof cakeRpcPayloadSchemas,
  | "create-worktree"
  | "get-worktree-status"
  | "land-worktree"
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
  worktreeRpc("land-worktree"),
  worktreeRpc("rebase-worktree"),
  worktreeRpc("discard-worktree"),
);
