import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface SubagentParentMessenger {
  readonly send: (text: string) => Promise<void>;
}

/** The sole coordination capability granted directly to a private Subagent Session. */
export function createSubagentParentTool(messenger: SubagentParentMessenger) {
  return defineTool({
    name: "message_parent",
    label: "Message Parent",
    description:
      "Send a concise progress update, blocker, or question to the parent session without waiting for this subagent turn to finish. Final results are delivered automatically.",
    promptSnippet: "Send a progress update, blocker, or question to the parent session",
    promptGuidelines: [
      "Use message_parent only for substantive progress, blockers, or questions that the parent should see before your final report. Do not send acknowledgments or duplicate your final response.",
    ],
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();
      const text = params.text.trim();
      if (!text) throw new Error("Parent message text is required");
      await messenger.send(text);
      return {
        content: [{ type: "text", text: "Message queued to the parent session." }],
        details: { delivered: true },
      };
    },
  });
}
