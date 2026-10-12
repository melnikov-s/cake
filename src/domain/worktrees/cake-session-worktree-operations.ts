import { Effect, Schema } from "effect";

import type { RuntimeOperationApi } from "../../services/pi/runtime/cake-operation-providers";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

export function createSessionWorktreeOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const empty = Schema.Struct({});
  return [
    {
      command: "session.merge",
      requires: "mergeSession",
      topic: "sessions",
      summary: "Queue Cake's normal merge workflow for the calling session's Managed Worktree.",
      guidance: [
        "This is the same preserve-commits workflow as the Merge action in Cake. It commits intended uncommitted work through the session agent when necessary and uses Cake's repository landing queue.",
        "The merge targets the checkout from which this session's worktree was created. It does not resolve the session.",
      ],
      inputSchema: empty,
      examples: [{}],
      result: "The accepted Managed Worktree landing operation.",
      execute: (_input, context) => api().mergeSession(undefined, context.signal),
    },
    {
      command: "sessions.merge",
      requires: "mergeSession",
      topic: "sessions",
      summary: "Queue Cake's normal merge workflow for one immediate child session.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      }),
      examples: [{ input: { sessionId: "child-session-id" } }],
      result: "The accepted Managed Worktree landing operation.",
      limitations: ["The target must be an immediate child with its own Managed Worktree."],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().mergeSession((input as { sessionId: string }).sessionId, context.signal);
      },
    },
    {
      command: "session.discard",
      requires: "discardSession",
      topic: "sessions",
      summary: "Discard the calling session's isolated Managed Worktree without resolving it.",
      inputSchema: Schema.Struct({
        keepBranch: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
      examples: [{ input: { keepBranch: false } }],
      result: "A completed Managed Worktree discard receipt.",
      limitations: ["This permanently removes unmerged checkout changes when keepBranch is false."],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().discardSession(
          undefined,
          (input as { keepBranch: boolean }).keepBranch,
          context.signal,
        );
      },
    },
    {
      command: "sessions.discard",
      requires: "discardSession",
      topic: "sessions",
      summary:
        "Discard one immediate child session's isolated Managed Worktree without resolving it.",
      inputSchema: Schema.Struct({
        sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        keepBranch: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
      examples: [{ input: { sessionId: "child-session-id", keepBranch: false } }],
      result: "A completed Managed Worktree discard receipt.",
      limitations: [
        "The target must be an immediate child with its own Managed Worktree.",
        "This permanently removes unmerged checkout changes when keepBranch is false.",
      ],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        const parsed = input as { sessionId: string; keepBranch: boolean };
        return api().discardSession(parsed.sessionId, parsed.keepBranch, context.signal);
      },
    },
  ];
}
