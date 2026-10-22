import { describe, expect, it } from "vitest";
import chatGuide from "../../../docs/agent/cake-chat.md?raw";
import {
  emptyProjectTodos,
  PROJECT_TODO_AUTO_COMPLETION_RULE,
  PROJECT_TODO_LINK_GUIDANCE,
  projectTodoBaseline,
} from "../../../src/contracts/projects/project-todos";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const unused = async () => {
  throw new Error("Guidance discovery must not mutate or inspect to-dos");
};
const registry = new CakeOperationRegistry(
  createProjectTodoOperations({
    list: unused,
    read: unused,
    create: unused,
    update: unused,
    updateMany: unused,
  }),
);
const baseline = projectTodoBaseline(emptyProjectTodos());

describe("application-owned to-do link guidance", () => {
  it.each([
    ["injected baseline", baseline],
    ["shipped Cake Chat reference", chatGuide],
    ...["todos.create", "todos.update", "todos.update-many"].map((command) => [
      `${command}.help`,
      registry.operationHelp(command),
    ]),
  ])("shares the canonical link policy in %s", (_surface, guidance) => {
    expect(guidance).toContain(PROJECT_TODO_LINK_GUIDANCE);
  });

  it("prioritizes relevant review and outcome links, including no-PR local work", () => {
    for (const requirement of [
      "a few high-value, descriptively titled links when available and relevant",
      "an existing PR/MR as the primary review destination for PR-based work",
      "an issue/ticket for requirements or discussion",
      "a usable preview, deployment or artifact to inspect the outcome",
      "the exact useful report or code change/commit",
      "especially for no-PR local merge workflows such as Cake",
      "the associated Cake session",
      "Omit irrelevant or redundant links",
      "never invent a PR/MR or create one merely to populate a to-do",
      "Update links as work evolves, including adding a PR/MR once created",
    ]) {
      expect(PROJECT_TODO_LINK_GUIDANCE).toContain(requirement);
    }
  });

  it("pins investigation findings when available, independently of notification or summary timing", () => {
    for (const requirement of [
      "For investigation/research to-dos, attach or update a kind=source link",
      "with a descriptive title such as 'Investigation findings'",
      "to the exact original findings message",
      "when the application's retained result-message ref becomes available (completion/report metadata or messages.list)",
      "Use that exact ref; never invent message IDs",
      "or substitute a session-only link, a summary, or a moving ?message=last destination",
      "Keep the original report reachable from the to-do even when another conversation topic defers its notification or summary",
      "Do not copy reports into artifacts, request extra report wakeups or change delivery/completion/lifecycle semantics just to attach a link",
    ]) {
      expect(PROJECT_TODO_LINK_GUIDANCE).toContain(requirement);
    }
  });

  it("keeps private worker links public and preserves their explicit completion semantics", () => {
    expect(PROJECT_TODO_LINK_GUIDANCE).toContain(
      "Use kind=subagent with its public handleId and parentSessionId to link a private worker, never its private Pi session ID",
    );
    expect(PROJECT_TODO_LINK_GUIDANCE).toContain(
      "Subagents have no resolve lifecycle: completion, error, abort or release never automatically closes a to-do; subagent-only items require explicit done",
    );
  });

  it("keeps required session lifecycle separate from contextual links during updates", () => {
    expect(PROJECT_TODO_LINK_GUIDANCE).toContain(
      "Session associations are required work (lifecycle); source links are context only and never affect automatic completion",
    );
    expect(PROJECT_TODO_LINK_GUIDANCE).toContain(
      "Preserve required session associations and existing subagent associations when updating links; association updates replace the complete list",
    );
    expect(baseline).toContain(PROJECT_TODO_AUTO_COMPLETION_RULE);
    expect(baseline).toContain(
      "Source/report links do not block completion; source-only items remain open",
    );
  });
});
