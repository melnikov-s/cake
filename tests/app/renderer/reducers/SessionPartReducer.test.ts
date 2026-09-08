import { expect, it } from "vitest";
import { messageSnapshots } from "../../../../src/renderer/reducers/SessionPartReducer";

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
