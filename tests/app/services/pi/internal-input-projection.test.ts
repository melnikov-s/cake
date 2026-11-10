import { expect, it } from "vitest";
import type { UiPart } from "../../../../src/contracts/conversations/session-contract";
import {
  passiveNoticeParts,
  queuedAutomaticInputPart,
  type AutomaticInput,
} from "../../../../src/services/pi/runtime/internal-input-projection";

const row: Extract<UiPart, { kind: "text" }> = {
  id: "queued-1",
  kind: "text",
  role: "user",
  text: "Hidden model prompt",
  status: "complete",
  deliveryState: "queued",
  queuedInput: {
    itemId: "20000000-0000-4000-8000-000000000001",
    text: "Hidden model prompt",
    attachments: [],
    renderUserMessageAsMarkdown: false,
  },
};
const update = (id: string) => ({
  id,
  text: `Report ${id}`,
  source: { title: "Worker", href: "cake://session/worker" },
});
const queued = (origin: AutomaticInput) => queuedAutomaticInputPart(origin, row);

it("names an opened attention item and counts, never inlines, its held reports", () => {
  const opened = { _tag: "AttentionItem", todoId: "todo", title: "Review merge fix" } as const;
  expect(queued(opened)).toMatchObject({
    text: "Needs attention: Review merge fix",
    queuedInput: { text: "Needs attention: Review merge fix", internal: "AttentionItem" },
  });
  expect(queued({ ...opened, updates: [update("a")] })).toMatchObject({
    text: "Needs attention: Review merge fix (+1 report)",
  });
  const withReports = queued({ ...opened, updates: [update("a"), update("b"), update("c")] });
  expect(withReports).toMatchObject({ text: "Needs attention: Review merge fix (+3 reports)" });
  expect(withReports).not.toHaveProperty("renderAs");
  // Delivered, the reports still show as their own attributed transcript rows.
  expect(passiveNoticeParts({ ...opened, updates: [update("a")] })).toHaveLength(1);
});

it("keeps the genuine batch path: contents when present, the generic label only when empty", () => {
  expect(queued({ _tag: "UpdateBatch", notices: [] })).toMatchObject({
    text: "Batched updates",
    queuedInput: { internal: "UpdateBatch" },
  });
  expect(queued({ _tag: "UpdateBatch", notices: [], updates: [update("a")] })).toMatchObject({
    text: "Report a",
  });
});
