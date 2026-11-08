import type { WorktreeLandingControl } from "../../contracts/worktrees/worktree-agent-control";
import { Schema } from "effect";
import { MergeReadiness } from "../../contracts/worktrees/auto-merge";
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
              "Report readyToMerge: true when requested work is complete, proportionately validated, and has no known clear regression caused by this change. Commit the validated work and supply that exact HEAD as validatedCommit.",
              "validationPassed means sufficient relevant evidence, not repo-wide green typecheck/Knip/full suite or exhaustive visual/E2E proof. Report unrelated/pre-existing failures and infrastructure timeouts separately; bounded triage of relevant unclassified failures is enough. Do not expand scope to fix unrelated issues.",
              "Set taskCompleted and validationPassed truthfully. Checkpoints, investigations, pending task-specific validation and generic finished prose are NOT readiness. Keep fixing task-specific regressions; report real external blockers honestly. readyToMerge: false revokes readiness.",
              "This is structured completion metadata, not a replacement for your ordinary final answer, Workboard result or correlated report. Do not send duplicate completion prose.",
              "Cake waits for this turn to complete successfully. Readiness is retained while off. Switching the user-owned Auto-merge toggle on authorizes currently valid structured readiness from this app run, never generic completed history. New input/changes invalidate readiness. Do not call worktrees.merge to force automatic landing.",
            ],
            inputSchema: MergeReadiness,
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
              "Whether this declaration is eligible; actual merge and resolution happen only after successful turn completion.",
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
