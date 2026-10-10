import { expect, it } from "vitest";
import { messageSnapshots } from "../../../../src/renderer/reducers/SessionPartReducer";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { Conversation } from "../../../../src/renderer/models/Conversation";

it("maps Pi identities without retaining renamed transport fields", () => {
  const snapshots = messageSnapshots(
    [
      {
        id: "text",
        kind: "text",
        role: "user",
        entryId: "pi-text",
        text: "Hello",
        status: "complete",
      },
      { id: "skill", kind: "skill", entryId: "pi-skill", name: "Skill", content: "Instructions" },
      {
        id: "compaction",
        kind: "compaction",
        firstKeptEntryId: "pi-kept",
        summary: "Summary",
        tokensBefore: 10,
      },
      {
        id: "tool",
        kind: "tool",
        name: "read",
        input: "{}",
        state: "success",
        outputContent: [
          { type: "text", text: "Image" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
      },
    ],
    "session",
  );
  expect(snapshots[0]).toEqual({
    id: "session:text",
    partKey: "text",
    kind: "text",
    role: "user",
    piId: "pi-text",
    text: "Hello",
    status: "complete",
  });
  expect(snapshots[1]).toEqual({
    id: "session:skill",
    partKey: "skill",
    kind: "skill",
    piId: "pi-skill",
    name: "Skill",
    content: "Instructions",
  });
  expect(snapshots[2]).toEqual({
    id: "session:compaction",
    partKey: "compaction",
    kind: "compaction",
    firstKeptPiId: "pi-kept",
    summary: "Summary",
    tokensBefore: 10,
  });
  expect(snapshots[3]?.outputContent?.map((content) => content.type)).toEqual(["text", "image"]);
});

it("round-trips interview definitions and results with heterogeneous JSON through Models", () => {
  const options = [null, "one", 7, false];
  const choices = [...options, ["nested"], { option: "object" }];
  const interview = {
    id: "call",
    sessionId: "session",
    request: {
      protocol: "cake.request/v1" as const,
      id: "choice",
      title: "Choose",
      responseSchema: { type: "object" as const, properties: { choice: { enum: options } } },
      view: {
        type: "widget" as const,
        language: "html" as const,
        source: "<button>Choose</button>",
      },
      fallback: { markdown: "Choose" },
    },
  };
  const interviewResult = { interviewId: "call", cancelled: false, value: { choices } };
  const model = Conversation.create({
    sessionId: "session",
    parts: messageSnapshots(
      [
        {
          id: "tool-call",
          kind: "tool",
          name: "cake",
          input: "",
          state: "success",
          interview,
          interviewResult,
        },
      ],
      "session",
    ),
  });
  const restored = Conversation.create(toSnapshot(model));
  expect(restored.uiParts[0]).toMatchObject({ interview, interviewResult });
  const delta = {
    id: "tool-call",
    kind: "tool" as const,
    name: "cake",
    input: "",
    state: "success" as const,
    output: "Live result",
  };
  restored.parts[0]!.update(delta);
  expect(restored.uiParts[0]).toMatchObject({ interview, interviewResult, output: "Live result" });
  applySnapshot(restored.parts[0]!, messageSnapshots([delta], "session")[0]!);
  const replaced = restored.uiParts[0];
  expect(replaced?.kind === "tool" ? replaced.interview : undefined).toBeUndefined();
});
