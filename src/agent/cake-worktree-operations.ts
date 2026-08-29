import { z } from "zod";
import type { CakeOperationDefinition } from "./cake-operation-registry";

const proposeSquashMessageInputSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().max(4_000).optional(),
  })
  .strict();

export interface WorktreeLandingControl {
  proposeSquashMessage(message: { subject: string; body?: string }): Promise<void>;
}

export function createCakeWorktreeOperations(
  control: WorktreeLandingControl,
): CakeOperationDefinition<z.infer<typeof proposeSquashMessageInputSchema>>[] {
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
