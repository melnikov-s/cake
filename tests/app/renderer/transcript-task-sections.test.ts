import { expect, it } from "vitest";
import { transcriptTaskSections } from "../../../src/renderer/lib/transcript-task-sections";
import { groupTranscriptParts } from "../../../src/renderer/components/chat-transcript-items";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";

function user(id: string, todoId?: string | null): UiPart {
  return {
    kind: "text",
    id,
    entryId: id,
    role: "user",
    text: id,
    status: "complete",
    ...(todoId === undefined ? null : { taskTodoId: todoId }),
  };
}
function answer(id: string): UiPart {
  return { kind: "text", id, role: "assistant", text: id, status: "complete" };
}

it("starts one section at each A → B → A transition, not on follow-ups or status updates", () => {
  const parts = [
    user("casual", null),
    answer("casual-answer"),
    user("a1", "A"),
    answer("a1-answer"),
    user("a-followup", "A"),
    answer("followup-answer"),
    user("b", "B"),
    answer("b-answer"),
    user("a2", "A"),
    answer("a2-answer"),
    user("casual2", null),
    answer("casual2-answer"),
  ];
  const items = groupTranscriptParts(parts);
  const before = items.map((item) => item.id);
  const sections = transcriptTaskSections(items).sections;
  expect(sections.filter((section) => section.start).map((section) => section.todoId)).toEqual([
    "A",
    "B",
    "A",
  ]);
  expect(sections.map((s) => s.todoId)).toEqual([
    undefined,
    undefined,
    "A",
    "A",
    "A",
    "A",
    "B",
    "B",
    "A",
    "A",
    undefined,
    undefined,
  ]);
  expect(items.map((item) => item.id)).toEqual(before);
  // Latest task state/title are deliberately not inputs to section boundaries.
  expect(transcriptTaskSections(items).sections).toEqual(sections);
});

it("does not guess an unresolved input belongs to the previous task; activity and wide widgets retain their section identity", () => {
  const parts: UiPart[] = [
    user("a", "A"),
    { id: "widget", kind: "tool", name: "cake", input: "", state: "success", artifactId: "wide" },
    answer("after-widget"),
    user("pending"),
    answer("pending-answer"),
  ];
  const result = transcriptTaskSections(groupTranscriptParts(parts));
  expect(result.sections.map((s) => s.todoId)).toEqual(["A", "A", "A", undefined, undefined]);
  expect(result.sections.filter((s) => s.start)).toHaveLength(1);
});
