import { expect, it } from "vitest";
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
it("shares exact link and attention rules in mutation help", () => {
  for (const command of ["todos.create", "todos.update", "todos.update-many"]) {
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_LINK_GUIDANCE);
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_ATTENTION_GUIDANCE);
    expect(registry.operationHelp(command)).toContain(PROJECT_TODO_DESCRIPTION_GUIDANCE);
  }
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
