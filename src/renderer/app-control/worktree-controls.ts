import { Schema } from "effect";
import type { AppControlResult } from "./app-control-data";
import { bounded } from "./control-arguments";
import { defineControl } from "./control-definition";
export const worktreeControls = [
  defineControl({
    command: "worktrees.merge",
    args: Schema.Struct({
      sessionId: bounded(1, 256),
      workingDirectory: bounded(1, 4096),
    }),
    scope: "internal",
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.worktrees) throw new Error("Managed Worktree controls are unavailable");
      const operationId = await host.worktrees.merge(input);
      return {
        ok: true,
        command,
        ...input,
        operationId,
      };
    },
  }),
  defineControl({
    command: "worktrees.discard",
    args: Schema.Struct({
      sessionId: bounded(1, 256),
      workingDirectory: bounded(1, 4096),
      keepBranch: Schema.Boolean,
    }),
    scope: "internal",
    run: async (input, { host }, command): Promise<AppControlResult> => {
      if (!host.worktrees) throw new Error("Managed Worktree controls are unavailable");
      await host.worktrees.discard(input);
      return {
        ok: true,
        command,
        ...input,
      };
    },
  }),
];
