import { Effect, Schema } from "effect";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import type { CakeChatWorktreeControl } from "../../contracts/agent/cake-operation-options";

import { WorktreeMergeAndResolveReport } from "../../contracts/worktrees/worktree-merge-data";

const sessionIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

const mergeResult =
  "A structured landing report: outcome (landed | awaiting-agent | stalled | failed | in-progress | canceled), operationId, sessionId, workingDirectory, phase, targetBranch, landedCommit, conflictFiles, pauseReason, error, worktreeState and nextStep.";

/** Shared behavior guidance for every surface that exposes Cake's native worktree merge. */
const worktreeMergeGuidance = [
  "This is Cake's normal Merge workflow, identical to the Merge action in the Cake UI: Cake prompts the owning session to commit any uncommitted worktree changes, replays the worktree branch onto the branch it was created from through Cake's serialized repository landing queue, and marks the worktree landed. It never resolves the session.",
  "The call waits until the landing lands, fails, stalls, or needs the owning agent (bounded to about two minutes), then returns a structured report. Follow its nextStep text.",
  "Conflicts: Cake rebases the worktree branch onto the target and, on conflicts, prompts the owning session to resolve them inside its own worktree (outcome awaiting-agent with conflictFiles). When that turn ends Cake retries automatically. If the worktree is still blocked the outcome is stalled; once the owner has finished, call worktrees.merge again to retry.",
  "Calling worktrees.merge while a landing for the same worktree is running returns its current progress instead of starting another; calling it on a stalled landing retries it.",
  "Never land Cake-managed worktree work by hand: no git merge, cherry-pick, rebase, stash or commit in the target (project root) checkout. A failure caused by uncommitted changes in the target checkout is for the user to resolve.",
];

export function createSessionWorktreeOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  return [
    {
      command: "worktrees.merge",
      requires: "mergeSession",
      topic: "worktrees",
      summary: "Land managed worktree",
      guidance: [
        ...worktreeMergeGuidance,
        "Omit sessionId to merge the calling session's own Managed Worktree. Commit your intended changes first so the landing can complete within this call; otherwise Cake queues a commit turn for you after this one.",
        "When Cake reports awaiting-agent for your own worktree, finish your turn: the queued follow-up asks you to commit or resolve conflicts, then Cake continues the landing.",
      ],
      inputSchema: Schema.Struct({ sessionId: Schema.optionalKey(sessionIdSchema) }),
      examples: [
        { description: "Merge the calling session's own worktree." },
        { input: { sessionId: "1a2b3c4d" }, description: "Merge an immediate child's worktree." },
      ],
      result: mergeResult,
      limitations: [
        "A sessionId target must be an immediate child with its own isolated Managed Worktree.",
        "Sessions that share their parent's Working Directory have no worktree of their own to merge.",
      ],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        return api().mergeSession((input as { sessionId?: string }).sessionId, context.signal);
      },
    },
    {
      command: "worktrees.discard",
      requires: "discardSession",
      topic: "worktrees",
      summary: "Discard managed worktree; keep session",
      inputSchema: Schema.Struct({
        sessionId: Schema.optionalKey(sessionIdSchema),
        keepBranch: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      }),
      examples: [
        { input: { keepBranch: false } },
        { input: { sessionId: "1a2b3c4d", keepBranch: true } },
      ],
      result: "A completed Managed Worktree discard receipt.",
      limitations: [
        "A sessionId target must be an immediate child with its own isolated Managed Worktree.",
        "This permanently removes unmerged checkout changes when keepBranch is false. Use it only when the user asks to throw the work away.",
      ],
      execute: (input, context) => {
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        const parsed = input as { sessionId?: string; keepBranch: boolean };
        return api().discardSession(parsed.sessionId, parsed.keepBranch, context.signal);
      },
    },
  ];
}

/** Cake Chat may land any Project Session's own Managed Worktree by session reference. */
export function createCakeChatWorktreeOperations(
  control: CakeChatWorktreeControl,
): CakeOperationDefinition[] {
  return [
    {
      command: "worktrees.merge-and-resolve",
      topic: "worktrees",
      summary: "Land managed worktree and resolve on success",
      guidance: [
        "Use the owning Project Session's sessionId when the user authorizes landing and resolution. This reuses Cake UI Merge & resolve and the serialized backend landing workflow.",
        "The call waits up to about two minutes, returning landed-and-resolved, resolution-failed, awaiting-agent, stalled, failed, in-progress or canceled. Inspect landed and resolved separately: successful Git landing is not proof of resolution.",
        "Resolve-after-success intent is persisted through owner commit/conflict turns and supported restart recovery. Awaiting-agent or in-progress needs no second invocation to resolve after successful landing; report progress rather than polling.",
        "Duplicate requests join the existing landing and retain resolve intent; stalled landings retry. Already-landed unchanged work resolves without relanding. New unlanded work must land first.",
        "Failed, blocked, stalled or canceled landings never resolve. Resolution failures retain intent and report partial resolvedSessionIds; retry this command to finish resolution. cleanupFailures are warnings after committed resolution, not a failed Git merge.",
        "Use worktrees.merge instead for an intentional merge-only exception. No manual Git landing fallback.",
      ],
      inputSchema: Schema.Struct({ sessionId: sessionIdSchema }),
      outputSchema: WorktreeMergeAndResolveReport,
      canonicalSessionIds: true,
      examples: [{ input: { sessionId: "1a2b3c4d" } }],
      result:
        "Structured landing and lifecycle receipt with outcome, landed, resolved, operationId, sessionId, workingDirectory, phase, landedCommit, resolutionError, resolvedSessionIds, cleanupFailures and nextStep.",
      limitations: [
        "The target must own a Cake-managed worktree and support native Project Session resolution. Lifecycle policy still requires inactive family members; this command does not override resolution authority.",
        "Authorization to merge alone does not grant authorization to resolve.",
      ],
      execute: (input, context) =>
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        control.mergeAndResolve((input as { sessionId: string }).sessionId, context.signal),
    },
    {
      command: "worktrees.merge",
      topic: "worktrees",
      summary: "Land managed worktree",
      guidance: [
        ...worktreeMergeGuidance,
        "Use this when the user asks to land, merge or ship a session's work. Do not ask sessions to hand-merge into the project root.",
        "If the session has uncommitted work or conflicts, Cake prompts that session to handle them in its own worktree; report the outcome to the user instead of polling.",
      ],
      inputSchema: Schema.Struct({ sessionId: sessionIdSchema }),
      examples: [{ input: { sessionId: "1a2b3c4d" } }],
      result: mergeResult,
      limitations: [
        "The target must own an isolated Managed Worktree: a Project Session or an existing task Side Chat. Side Chats remain read-only; recover uncommitted work or conflict resolution into an independent Project Session. Family children sharing a directory are merged through their parent.",
      ],
      execute: (input, context) =>
        // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
        control.merge((input as { sessionId: string }).sessionId, context.signal),
    },
  ];
}
