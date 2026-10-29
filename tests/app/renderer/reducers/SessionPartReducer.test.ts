import { expect, it } from "vitest";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import {
  applyPartUpdate,
  messageSnapshots,
} from "../../../../src/renderer/reducers/SessionPartReducer";
import { applySnapshot, toSnapshot } from "r-state-tree";
import { Conversation } from "../../../../src/renderer/models/Conversation";

it("inserts late synthetic baseline groups before dialogue without moving actual updates", () => {
  using model = Conversation.create({ sessionId: "session" });
  const user: UiPart = {
    id: "entry-user-text",
    kind: "text",
    role: "user",
    text: "Hello",
    status: "complete",
  };
  const change: UiPart = {
    id: "live-context-2-system-prompt-skills",
    kind: "context",
    title: "Skills",
    text: "New skill",
  };
  const baseline = ["system", "skills", "instructions"].map((source): UiPart => ({
    id: `runtime-system-prompt-${source}`,
    kind: "context",
    title: source,
    text: source,
  }));
  applyPartUpdate(model.parts, user, model.sessionId);
  applyPartUpdate(model.parts, change, model.sessionId);
  for (const part of baseline) applyPartUpdate(model.parts, part, model.sessionId);
  const originals = model.parts.slice();
  for (const part of baseline) applyPartUpdate(model.parts, part, model.sessionId);
  expect(model.uiParts).toEqual([...baseline, user, change]);
  expect(model.parts.every((part, index) => part === originals[index])).toBe(true);
});

it("normalizes reconstructed snapshots without changing content or historical order", () => {
  const user: UiPart = {
    id: "entry-user-text",
    kind: "text",
    role: "user",
    text: "Hello",
    status: "complete",
  };
  const change: UiPart = {
    id: "entry-update-system-prompt-system",
    kind: "context",
    title: "System",
    text: "New rules",
  };
  const baseline: UiPart = {
    id: "runtime-system-prompt-system",
    kind: "context",
    title: "System",
    text: "Current rules",
  };
  using model = Conversation.create({
    sessionId: "session",
    parts: messageSnapshots([user, change, baseline], "session"),
  });
  expect(model.uiParts).toEqual([baseline, user, change]);
});

// Rendering and same-ID renderAs replacement live in transcript-rendering-workflow
// and projection-finish-workflow. These contracts preserve transport identities
// and heterogeneous interview JSON through model serialization, not DOM output.
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
  using model = Conversation.create({
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
  using restored = Conversation.create(toSnapshot(model));
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
