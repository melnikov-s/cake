import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  pluginAgentOpenOptionsSchema,
  pluginCompletionRequestSchema,
  sessionRefSchema,
} from "../../../src/ipc/plugin-agent-contract";

describe("plugin agent contracts", () => {
  const ref = { kind: "cake.session-ref" as const, id: JSON.stringify({ sessionId: "session" }) };

  it("validates session-aware targets and bounded completion selectors", () => {
    expect(
      Schema.decodeUnknownSync(pluginAgentOpenOptionsSchema)({
        session: { kind: "fork" },
        model: { prefer: "utility" },
      }),
    ).toMatchObject({ session: { kind: "fork", visibility: "private" } });
    expect(
      Schema.decodeUnknownSync(pluginCompletionRequestSchema)({
        model: { prefer: "default" },
        context: { kind: "session", target: ref, selection: { kind: "recent-messages", count: 4 } },
        instructions: "Summarize",
      }),
    ).toMatchObject({ maximumOutputCharacters: 8_192 });
  });

  it("rejects malformed references and oversized prompts deterministically", () => {
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(sessionRefSchema)({ kind: "cake.workspace-ref", id: ref.id }),
      ),
    ).toBe(false);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(pluginAgentOpenOptionsSchema)({
          session: { kind: "attach", target: { ...ref, id: "x".repeat(8_193) } },
        }),
      ),
    ).toBe(false);
    expect(
      Option.isSome(
        Schema.decodeUnknownOption(pluginCompletionRequestSchema)({
          context: { kind: "session", selection: { kind: "recent-messages", count: 101 } },
          instructions: "Summarize",
        }),
      ),
    ).toBe(false);
  });
});
