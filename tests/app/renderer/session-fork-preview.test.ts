import { expect, it } from "vitest";
import { Conversation } from "../../../src/renderer/models/Conversation";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { projectSessionForkPreview } from "../../../src/renderer/lib/session-fork-preview";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";

function message(entryId: string): UiPart {
  return {
    id: `part-${entryId}`,
    entryId,
    kind: "text",
    role: "assistant",
    text: entryId,
    status: "complete",
  };
}

it("projects only the chosen branch through the fork point without claiming runtime readiness", () => {
  using source = Conversation.create({
    sessionId: "source",
    sessionFile: "/source.jsonl",
    streaming: true,
    activeTurnIds: ["running"],
    parts: messageSnapshots(
      [
        message("root"),
        { id: "reasoning", kind: "reasoning", text: "Thinking", status: "complete" },
        message("selected"),
        message("later"),
      ],
      "source",
    ),
    tree: [
      { id: "root", piId: "root" },
      { id: "selected", piId: "selected", parentPiId: "root" },
      { id: "later", piId: "later", parentPiId: "selected" },
    ],
    thinkingLevel: "high",
  });
  using preview = Conversation.create({ sessionId: "preview" });
  projectSessionForkPreview(source, preview, "selected");
  expect(preview.uiParts.map((part) => part.id)).toEqual([
    "part-root",
    "reasoning",
    "part-selected",
  ]);
  expect(preview.parts[0]!.id).not.toBe(source.parts[0]!.id);
  expect(preview.sessionFile).toBe("");
  expect(preview.observedSnapshotRevision).toBe(0);
  expect(preview.streaming).toBe(false);
  expect(preview.activeTurnIds).toEqual([]);
  expect(preview.thinkingLevel).toBe("high");
  expect(source.uiParts).toHaveLength(4);
  source.parts[0]!.text = "Changed later";
  expect(preview.parts[0]!.text).toBe("root");
});

it("shows known ancestors for an inactive branch instead of displaying another branch's tail", () => {
  using source = Conversation.create({
    sessionId: "source",
    parts: messageSnapshots([message("root"), message("active")], "source"),
    tree: [
      { id: "root", piId: "root" },
      { id: "active", piId: "active", parentPiId: "root" },
      { id: "inactive", piId: "inactive", parentPiId: "root" },
    ],
  });
  using preview = Conversation.create({ sessionId: "preview" });
  projectSessionForkPreview(source, preview, "inactive");
  expect(preview.uiParts.map((part) => part.id)).toEqual(["part-root"]);
});
