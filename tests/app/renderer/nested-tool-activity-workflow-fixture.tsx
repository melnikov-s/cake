import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { nestedEntries, nestedScript } from "../../fixtures/nested-tool-activity";

// The live authority emits a parent tool record with stable nested IDs. Pi event
// adaptation is verified in services/pi/nested-tool-activity.test.ts; the renderer
// receives this contract, never a hand-assembled AgentSession.
export function liveNestedActivity(output: string, state: "running" | "success"): UiPart {
  return {
    id: "tool-script",
    kind: "tool",
    name: "codemode",
    input: nestedScript,
    state: "running",
    nestedCalls: {
      calls: [
        {
          id: "tool-script/1",
          name: "read",
          input: "a.ts",
          filePath: "a.ts",
          state,
          output,
          outputContent: [{ type: "text", text: output }],
          outputAvailability: "live",
        },
      ],
    },
  };
}

export function savedNestedActivity(): UiPart[] {
  // Retain the real saved-history codec and metadata-only Pi fixture.
  return projectSessionEntries(nestedEntries());
}
