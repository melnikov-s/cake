import type { WorktreeLandingControl } from "../../contracts/worktrees/worktree-agent-control";
import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";

const proposeSquashMessageInputSchema = Schema.Struct({
  subject: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  body: Schema.optionalKey(Schema.Trim.pipe(Schema.check(Schema.isMaxLength(4_000)))),
});
type ProposeSquashMessageInput = typeof proposeSquashMessageInputSchema.Type;

export function createCakeWorktreeOperations(
  control: WorktreeLandingControl,
): CakeOperationDefinition<ProposeSquashMessageInput>[] {
  return [
    {
      command: "worktrees.proposeSquashMessage",
      topic: "worktrees",
      summary: "Submit the commit message requested by an active worktree squash landing.",
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
        await control.proposeSquashMessage(input);
        return { accepted: true };
      },
    },
  ];
}
