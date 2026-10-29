import { expect, it } from "vitest";
import { applySnapshot } from "r-state-tree";
import { Message } from "../../../src/renderer/models/Message";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { transcriptTaskSections } from "../../../src/renderer/lib/transcript-task-sections";
import { groupTranscriptParts } from "../../../src/renderer/components/chat-transcript-items";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";

function user(id: string, todoId?: string | null): Extract<UiPart, { kind: "text" }> {
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

it("uses known incoming associations once per switch and lets explicit human attribution clear a section", () => {
  const items = groupTranscriptParts([
    user("a", "A"),
    answer("a-answer"),
    answer("incoming-b"),
    answer("incoming-b-followup"),
    user("back-to-a", "A"),
    answer("a-return-answer"),
    user("casual", null),
    answer("casual-answer"),
  ]);
  const linked = new Map([
    ["incoming-b", "B"],
    ["incoming-b-followup", "B"],
    ["casual", "A"],
  ]);
  const sections = transcriptTaskSections(items, (item) => linked.get(item.id)).sections;
  expect(sections.map((section) => section.todoId)).toEqual([
    "A",
    "A",
    "B",
    "B",
    "A",
    "A",
    undefined,
    undefined,
  ]);
  expect(sections.filter((section) => section.start).map((section) => section.todoId)).toEqual([
    "A",
    "B",
    "A",
  ]);
});

it("keeps a pending follow-up in flow but honors settled continuation, switch, null and error decisions", () => {
  const pending: UiPart = { ...user("follow-up"), taskAttributionPending: true };
  const model = Message.create(messageSnapshots([pending], "chat")[0]);
  const sections = () =>
    transcriptTaskSections(
      groupTranscriptParts([
        user("a", "A"),
        answer("a-answer"),
        model.value,
        answer("followup-answer"),
      ]),
    ).sections;
  expect(sections().map((section) => section.todoId)).toEqual(["A", "A", "A", "A"]);
  expect(sections().filter((section) => section.start)).toHaveLength(1);
  expect(model.update(user("follow-up", "A"))).toBe(true);
  expect(model.value).not.toHaveProperty("taskAttributionPending");
  expect(sections().filter((section) => section.start)).toHaveLength(1);
  expect(model.update(user("follow-up", "B"))).toBe(true);
  expect(sections().map((section) => section.todoId)).toEqual(["A", "A", "B", "B"]);
  // Full snapshot refreshes also clear provisional presentation. Both an
  // unrelated model decision and a reported classifier failure settle to null.
  applySnapshot(model, messageSnapshots([pending], "chat")[0]!);
  applySnapshot(model, messageSnapshots([user("follow-up", null)], "chat")[0]!);
  expect(model.value).not.toHaveProperty("taskAttributionPending");
  expect(sections().map((section) => section.todoId)).toEqual(["A", "A", undefined, undefined]);
});

it("does not guess missing attribution belongs to the previous task; activity and wide widgets retain their section identity", () => {
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
