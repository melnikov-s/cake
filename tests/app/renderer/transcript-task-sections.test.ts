import { expect, it } from "vitest";
import { applySnapshot } from "r-state-tree";
import { Message } from "../../../src/renderer/models/Message";
import { messageSnapshots } from "../../../src/renderer/reducers/SessionPartReducer";
import { transcriptTaskSections } from "../../../src/renderer/lib/transcript-task-sections";
import { groupTranscriptParts } from "../../../src/renderer/components/chat-transcript-items";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import { researchOrigin } from "../../fixtures/subagent-report";

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

it("attributes preceding attachments to their own turn across switches, repeats and unresolved inputs", () => {
  const image = (id: string): UiPart => ({
    id,
    kind: "attachment",
    attachmentKind: "image",
    mediaType: "image/png",
    name: id,
    data: "pixels",
  });
  const items = groupTranscriptParts([
    user("a", "A"),
    image("a-shot"),
    answer("a-answer"),
    user("b", "B"),
    image("b-shot"),
    image("b-detail"),
    answer("b-answer"),
    user("b-followup", "B"),
    image("b-followup-shot"),
    user("none", null),
    image("none-shot"),
    user("a-return", "A"),
    image("a-return-shot"),
    { ...user("pending"), taskAttributionPending: true },
    image("pending-shot"),
  ]);
  const result = transcriptTaskSections(items);
  expect(items.map((item, index) => [item.id, result.sections[index]!.todoId])).toEqual([
    ["a-shot", "A"],
    ["a", "A"],
    ["a-answer", "A"],
    ["b-shot", "B"],
    ["b-detail", "B"],
    ["b", "B"],
    ["b-answer", "B"],
    ["b-followup-shot", "B"],
    ["b-followup", "B"],
    ["none-shot", undefined],
    ["none", undefined],
    ["a-return-shot", "A"],
    ["a-return", "A"],
    ["pending-shot", undefined],
    ["pending", undefined],
  ]);
  expect(
    result.sections.flatMap((section, index) => (section.start ? [items[index]!.id] : [])),
  ).toEqual(["a-shot", "b-shot", "a-return-shot"]);
  expect(result.sections[5]!.startIndex).toBe(3);
  expect(result.sections[8]!.startIndex).toBe(3);
});

it("uses known incoming associations once per switch and lets explicit human attribution clear a section", () => {
  const items = groupTranscriptParts([
    user("a", "A"),
    answer("a-answer"),
    answer("incoming-b"),
    answer("incoming-b-followup"),
    answer("discussion-continuation"),
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

const incomingReports: UiPart[] = [
  {
    ...user("session-report"),
    crossSession: {
      version: 1,
      messageId: "10000000-0000-4000-8000-000000000001",
      threadId: "10000000-0000-4000-8000-000000000001",
      sequence: 1,
      expectsResponse: false,
      sender: { sessionId: "source", title: "Source", kind: "project-session" },
    },
  },
  { ...user("worker-report"), subagentReport: researchOrigin },
  {
    ...user("agent-update"),
    agentSource: { title: "Source", href: "cake://session/source" },
  },
  {
    id: "source-card",
    kind: "tool",
    name: "cake",
    input: "",
    state: "success",
    messageReference: "cake://session/source?message=original",
  },
];

it.each(incomingReports)("isolates $id from the conversational topic", (report) => {
  const items = groupTranscriptParts([
    user("a", "A"),
    answer("a-answer"),
    report,
    answer("a-continuation"),
  ]);
  for (const sourceTodo of ["A", "B", undefined]) {
    const sections = transcriptTaskSections(items, (item) =>
      item.id === report.id ? sourceTodo : undefined,
    ).sections;
    expect(sections.map((s) => s.todoId)).toEqual(["A", "A", sourceTodo, "A"]);
    expect(sections.map((s) => s.start)).toEqual([
      true,
      false,
      sourceTodo === "B",
      sourceTodo !== "A",
    ]);
    expect(sections.map((s) => s.startIndex)).toEqual(
      sourceTodo === "A" ? [0, 0, 0, 0] : [0, 0, 2, 3],
    );
  }
});

it("keeps multiple unrelated and unassigned reports out of the surrounding discussion", () => {
  const items = groupTranscriptParts([
    user("a", "A"),
    ...incomingReports,
    answer("a-continuation"),
    user("unassigned", null),
    {
      ...user("later-report"),
      agentSource: { title: "Source", href: "cake://session/source" },
    },
    answer("unassigned-continuation"),
  ]);
  const sources = new Map([
    ["session-report", "B"],
    ["worker-report", "C"],
    ["source-card", "B"],
    ["later-report", "B"],
  ]);
  const sections = transcriptTaskSections(items, (item) => sources.get(item.id)).sections;
  expect(sections.map((s) => s.todoId)).toEqual([
    "A",
    "B",
    "C",
    undefined,
    "B",
    "A",
    undefined,
    "B",
    undefined,
  ]);
});

it("starts a pending follow-up ungrouped, then honors settled continuation, switch and null decisions", () => {
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
  expect(sections().map((section) => section.todoId)).toEqual(["A", "A", undefined, undefined]);
  expect(sections().filter((section) => section.start)).toHaveLength(1);
  expect(model.update(user("follow-up", "A"))).toBe(true);
  expect(model.value).not.toHaveProperty("taskAttributionPending");
  expect(sections().filter((section) => section.start)).toHaveLength(1);
  expect(model.update(user("follow-up", "B"))).toBe(true);
  expect(sections().map((section) => section.todoId)).toEqual(["A", "A", "B", "B"]);
  // Full snapshot refreshes distinguish unresolved from explicit none.
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
