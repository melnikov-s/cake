import type { WorktreeLandingControl } from "../../contracts/worktrees/worktree-agent-control";
import { Schema } from "effect";
import { MergeReadiness, MergeReadinessResult } from "../../contracts/worktrees/auto-merge";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

const proposeSquashMessageInputSchema = Schema.Struct({
  subject: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  body: Schema.optionalKey(Schema.Trim.pipe(Schema.check(Schema.isMaxLength(4_000)))),
});
type ProposeSquashMessageInput = typeof proposeSquashMessageInputSchema.Type;

export function createCakeWorktreeOperations(
  control: WorktreeLandingControl,
): CakeOperationDefinition[] {
  const reportReadiness = control.reportReadiness;
  return [
    ...(reportReadiness
      ? ([
          {
            command: "worktrees.reportReadiness",
            topic: "worktrees",
            summary: "Declare validated task completion for optional auto-merge",
            guidance: [
              "Scope complete + relevant checks passed = ready. Report readyToMerge: true when nothing remains in task scope. Commit the validated work and supply that exact HEAD as validatedCommit.",
              "validationPassed means task-scoped validation, not repo-wide green typecheck/Knip/full suite or exhaustive visual/E2E proof. Choose checks by changed behavior/risk. Unrelated baseline failures or broad-suite timeouts alone do not block readiness or require a completed full suite; report them separately. Triage unclassified failures enough to assess task relevance; do not presume baseline debt or expand scope to fix unrelated issues.",
              "Set taskCompleted and validationPassed truthfully. Unfinished acceptance criteria, known relevant failures and uncommitted/unvalidated task changes block readiness. Never relabel failed task checks as passed. Checkpoints, investigations and generic finished prose are NOT readiness. Keep fixing task-specific regressions; report real external blockers honestly. readyToMerge: false revokes readiness.",
              "This is structured completion metadata, not a replacement for your ordinary final answer, Workboard result or correlated report. Do not send duplicate completion prose. Readiness also serves manual landing; automatic landing is restricted to sessions directly created by the owning project’s own Project Chat, never human/global-chat/nested delegation or later messages.",
              "Cake waits for this turn to complete successfully. Readiness is retained while off. Switching the user-owned project Auto-merge toggle on authorizes only that registered project’s currently valid structured readiness from this app run, never another project or generic completed history. New input/changes invalidate readiness. Do not call worktrees.merge to force automatic landing.",
            ],
            inputSchema: MergeReadiness,
            outputSchema: MergeReadinessResult,
            examples: [
              {
                input: {
                  readyToMerge: true,
                  taskCompleted: true,
                  validationPassed: true,
                  validatedCommit: "a".repeat(40),
                },
              },
            ],
            result:
              "Whether current-run readiness was accepted, independent of Auto-merge being on or off; ineligible declarations include a reason. Automatic merge and resolution require Auto-merge authorization and successful turn completion.",
            execute: (input) => {
              // SAFETY: CakeOperationRegistry parsed this input with MergeReadiness.
              return reportReadiness(input as MergeReadiness);
            },
          },
        ] satisfies CakeOperationDefinition[])
      : []),
    {
      command: "worktrees.proposeSquashMessage",
      topic: "worktrees",
      summary: "Submit requested squash message",
      guidance: [
        "Call this only when Cake explicitly asks this session to prepare a squash commit message.",
        "Inspect the complete worktree change and resolve any requested merge conflicts before proposing the message.",
      ],
      inputSchema: proposeSquashMessageInputSchema,
      examples: [
        {
          input: {
            subject: "Preserve worktree commits when landing",
            body: "Replay worktree commits onto the target branch and keep squash landing as an explicit option.",
          },
        },
      ],
      result: "Confirmation that Cake recorded the message for the current worktree state.",
      limitations: ["Fails unless this workspace has an active squash landing request."],
      async execute(input) {
        // SAFETY: CakeOperationRegistry parsed input with proposeSquashMessageInputSchema.
        await control.proposeSquashMessage(input as ProposeSquashMessageInput);
        return { accepted: true };
      },
    },
  ];
}
