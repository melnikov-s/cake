import type { ConversationSnapshot } from "../../../../src/contracts/conversations/conversation-data";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";

/** A deterministic coding transcript: user, reasoning, tool result, assistant per turn. */
export function conversationHydrationFixture(
  partCount = 240,
  sessionId = "hydration",
): Omit<ConversationSnapshot, "parts"> & { parts: UiPart[] } {
  const parts = Array.from({ length: partCount }, (_, index): UiPart => {
    const id = `part-${index}`;
    switch (index % 4) {
      case 0:
        return {
          id,
          entryId: String(index),
          kind: "text",
          role: "user",
          text: `Request ${index}: ${"inspect the implementation ".repeat(12)}`,
          status: "complete",
        };
      case 1:
        return {
          id,
          kind: "reasoning",
          text: `Reasoning ${index}: ${"check snapshot semantics ".repeat(24)}`,
          status: "complete",
        };
      case 2:
        return {
          id,
          kind: "tool",
          name: "read",
          input: JSON.stringify({ path: `src/module-${index}.ts` }),
          output: `Result ${index}\n${"export const value = 1;\n".repeat(96)}`,
          state: "success",
          ...(index % 12 === 2
            ? { outputContent: [{ type: "text" as const, text: "Structured tool output" }] }
            : {}),
        };
      default:
        return {
          id,
          entryId: String(index),
          kind: "text",
          role: "assistant",
          text: `Answer ${index}: ${"Preserve identity and authoritative state. ".repeat(24)}`,
          status: "complete",
        };
    }
  });
  return {
    sessionId,
    sessionFile: `/sessions/${sessionId}.jsonl`,
    parts,
    models: [],
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    streaming: false,
    diagnostics: [],
    commands: [],
    compatibility: { resources: [], diagnostics: [] },
    extensionUi: { statuses: [] },
    tree: [],
  };
}
