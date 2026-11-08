import { expect, it } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { ProjectTodo } from "../../../src/contracts/projects/project-todos";
import { todoMessageMatches } from "../../../src/renderer/lib/todo-message-matches";

const a = "00000000-0000-4000-8000-000000000011";
const b = "00000000-0000-4000-8000-000000000012";
const todo: ProjectTodo = {
  id: a,
  title: "Task A",
  description: "",
  status: "",
  state: "open",
  revision: 0,
  associations: [
    { kind: "session", sessionId: "source", title: "Source" },
    { kind: "source", ref: "cake://session/chat?message=exact", title: "Exact message" },
    { kind: "source", ref: "cake://session/other?message=other", title: "Other chat" },
    { kind: "source", ref: "cake://session/chat", title: "Whole chat" },
  ],
};
const message: UiPart = {
  kind: "text",
  id: "part",
  entryId: "untagged",
  role: "user",
  text: "Task A cake://session/chat?message=exact",
  status: "complete",
};

it("matches only explicit exact to-do IDs or exact message-source associations", () => {
  expect(todoMessageMatches({ ...message, taskTodoId: a }, "chat", todo)).toBe(true);
  expect(todoMessageMatches({ ...message, taskTodoId: b }, "chat", todo)).toBe(false);
  expect(todoMessageMatches({ ...message, taskTodoId: null }, "chat", todo)).toBe(false);
  expect(todoMessageMatches(message, "chat", todo)).toBe(false);
  expect(todoMessageMatches({ ...message, entryId: "exact" }, "chat", todo)).toBe(true);
  expect(todoMessageMatches({ ...message, entryId: "exact" }, "other", todo)).toBe(false);
  expect(todoMessageMatches({ ...message, entryId: "other" }, "chat", todo)).toBe(false);
  expect(
    todoMessageMatches(
      { ...message, agentSource: { title: "Source", href: "cake://session/source" } },
      "chat",
      todo,
    ),
  ).toBe(false);
});

it("does not treat pending, queued or untagged assistant messages as tagged turns", () => {
  expect(
    todoMessageMatches({ ...message, taskTodoId: a, taskAttributionPending: true }, "chat", todo),
  ).toBe(false);
  expect(
    todoMessageMatches({ ...message, taskTodoId: a, deliveryState: "queued" }, "chat", todo),
  ).toBe(false);
  expect(todoMessageMatches({ ...message, role: "assistant" }, "chat", todo)).toBe(false);
  expect(todoMessageMatches({ ...message, role: "assistant", taskTodoId: a }, "chat", todo)).toBe(
    true,
  );
});
