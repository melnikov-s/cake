import { expect, it } from "vitest";
import { Schema } from "effect";
import { fullProjectTodos } from "../helpers/projectTodoHarness";
import guide from "../../../docs/agent/chat-todos.md?raw";
import {
  emptyProjectTodos,
  projectTodoBaseline,
  PROJECT_TODO_AUTO_COMPLETION_RULE,
  PROJECT_TODO_CREATION_RULE,
  PROJECT_TODO_CLOSING_RULE,
  PROJECT_TODO_DESCRIPTION_GUIDANCE,
  PROJECT_TODO_LINK_GUIDANCE,
  PROJECT_TODO_ATTENTION_GUIDANCE,
} from "../../../src/contracts/projects/project-todos";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
const unused = async () => {
  throw Error("Help must not access/mutate state");
};
const registry = new CakeOperationRegistry(
  createProjectTodoOperations({
    select: unused,
    list: unused,
    read: unused,
    create: unused,
    update: unused,
    updateMany: unused,
  }),
);
it("keeps self-contained lifecycle, writing and attention rules in both baselines", () => {
  for (const chat of ["Cake Chat", "Project Chat"] as const) {
    const baseline = projectTodoBaseline(emptyProjectTodos(), chat);
    for (const rule of [
      PROJECT_TODO_AUTO_COMPLETION_RULE,
      PROJECT_TODO_CREATION_RULE,
      PROJECT_TODO_CLOSING_RULE,
      PROJECT_TODO_DESCRIPTION_GUIDANCE,
      PROJECT_TODO_ATTENTION_GUIDANCE,
    ])
      expect(baseline.split(rule)).toHaveLength(2);
  }
});
it("shares one creation rule across the baseline, help and guide", () => {
  expect(guide).toContain(PROJECT_TODO_CREATION_RULE);
  expect(registry.operationHelp("todos.create")).toContain(PROJECT_TODO_CREATION_RULE);
});
it("retains bounded admission-time previews independently of list page sizes", () => {
  const todos = fullProjectTodos();
  const baseline = projectTodoBaseline({
    ...todos,
    items: todos.items.map((item) => ({
      ...item,
      description: "d".repeat(300),
      status: "s".repeat(300),
    })),
  });
  expect(baseline.match(/"descriptionPreview":/g)).toHaveLength(20);
  expect(baseline).toContain(`"descriptionPreview":"${"d".repeat(240)}"`);
  expect(baseline).toContain(`"statusPreview":"${"s".repeat(240)}"`);
  expect(baseline).not.toContain('"title":"Task 20"');
});

it("shares exact link, attention and description rules in mutation help", () => {
  for (const command of ["todos.create", "todos.update", "todos.update-many"]) {
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_LINK_GUIDANCE);
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_ATTENTION_GUIDANCE);
    const help = registry.operationHelp(command);
    expect(help).toContain(PROJECT_TODO_DESCRIPTION_GUIDANCE);
    expect(help).toContain('"description":{');
    expect(help).toContain('"title":"Latest update"');
  }
});
it("exposes and enforces actionable title limits on every title mutation tool", async () => {
  const context = {
    signal: new AbortController().signal,
    toolCallId: "title-limit",
    runtime: {} as never,
  };
  for (const operation of registry
    .definitions()
    .filter((item) =>
      ["todos.create", "todos.update", "todos.update-many"].includes(item.command),
    )) {
    const help = registry.operationHelp(operation.command);
    expect(help).toContain('"maxLength":80');
    const input = (title: string) =>
      operation.command === "todos.create"
        ? { title, description: "Task details." }
        : operation.command === "todos.update"
          ? { id: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, title }
          : {
              updates: [{ id: "00000000-0000-4000-8000-000000000001", expectedRevision: 0, title }],
            };
    expect(Schema.is(operation.inputSchema)(input("T".repeat(80)))).toBe(true);
    for (const length of [81, 513])
      await expect(operation.execute(input("T".repeat(length)), context)).rejects.toThrow(
        "at most 80 characters; use Latest update (description)",
      );
  }
});
