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
      expect(baseline).toContain(rule);
    expect(baseline).toContain("Sections: Needs attention, Ready to Merge, Active, Snoozed, Done.");
    expect(baseline).toContain("No extra guide reads needed");
    expect(baseline.match(/Session-linked/g)).toHaveLength(1);
    expect(baseline).toContain("only when all required sessions resolve");
    expect(baseline.length).toBeLessThan(2300);
  }
});
it("excludes routine actions while preserving durable work across both chats, help and guide", () => {
  for (const rule of [
    "Track durable ongoing building, multi-step research and discussions/decisions to revisit",
    "Reuse existing/session-created items",
    "No new to-dos for routine one-shot actions",
    "merge approved work, open websites, navigate, direct answers/lookups",
    "even with multiple tools, delegation, verification or blockers",
    "Update underlying tasks for blockers, not administrative umbrella items",
    "Attribution may be null; never create just to attribute turns",
    "Assistant-maintained, not user chores",
  ])
    expect(PROJECT_TODO_CREATION_RULE).toContain(rule);
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

it("documents caller-selected list sizes and the separate update-many cap", () => {
  const help = registry.operationHelp("todos.list");
  expect(help).toContain("List limit defaults to 20");
  expect(help).toContain("positive safe integer page size");
  expect(help).toContain("todos.update-many in batches of at most 50");
  expect(help).not.toContain("(max 50)");
});

it("shares exact link and attention rules in mutation help", () => {
  for (const command of ["todos.create", "todos.update", "todos.update-many"]) {
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_LINK_GUIDANCE);
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_ATTENTION_GUIDANCE);
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_DESCRIPTION_GUIDANCE);
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
    expect(help).toContain("Short task name, at most 80 characters. Put details in description.");
    expect(help).toContain("Titles: short task names, max 80 characters; details in description.");
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
        "at most 80 characters; move details to description",
      );
  }
  expect(guide).toContain("at most 80 characters");
  expect(guide).toContain("Omit title when editing other fields on legacy long-title items");
});

it("preserves evidence, closure, association replacement and dismissed requests", () => {
  for (const rule of [
    "exact findings originals",
    "never invent refs",
    "updates replace the whole list",
    "public worker handles",
    "Sources do not affect closure",
    "subagent-only items close explicitly",
  ])
    expect(PROJECT_TODO_LINK_GUIDANCE).toContain(rule);
  expect(PROJECT_TODO_CLOSING_RULE).toContain("Research stays open awaiting review");
  expect(PROJECT_TODO_ATTENTION_GUIDANCE).toContain("Never revive/reword a dismissed request");
  for (const rule of [
    "Session-linked items close through session resolution",
    "Restore never reopens",
    "Associations replace the whole list",
    "Snooze",
    "Side chats share",
  ])
    expect(guide).toContain(rule === "Snooze" ? "snooze/unsnooze" : rule);
});
