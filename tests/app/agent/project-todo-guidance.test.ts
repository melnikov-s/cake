import { describe, expect, it } from "vitest";
import chatGuide from "../../../docs/agent/chat-todos.md?raw";
import {
  emptyProjectTodos,
  PROJECT_TODO_AUTO_COMPLETION_RULE,
  PROJECT_TODO_CLOSING_RULE,
  PROJECT_TODO_CREATION_RULE,
  PROJECT_TODO_DESCRIPTION_GUIDANCE,
  PROJECT_TODO_SUMMARY_GUIDANCE,
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
    ["shipped Cake Chat reference", chatGuide],
    ...["todos.create", "todos.update", "todos.update-many"].map((command) => [
      `${command}.help`,
      registry.operationHelp(command),
    ]),
  ])("shares the canonical link policy in %s", (_surface, guidance) => {
    expect(guidance).toContain(PROJECT_TODO_LINK_GUIDANCE);
  });

  it("loads detailed link policy on demand while preserving baseline lifecycle rules", () => {
    expect(baseline).toContain("read `chat-todos.md`");
    expect(baseline).toContain(
      "Before starting unsettled work, reviewing findings or editing/reconciling items",
    );
    expect(baseline).toContain(
      "Source/report links do not block completion; source-only items remain open",
    );
    expect(baseline).toContain("Restore never reopens a to-do");
    expect(baseline).toContain("Open items never authorize polling or wakes");
    expect(baseline.length).toBeLessThan(3_200);
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

describe("latest-update to-do writing guidance", () => {
  it.each([
    ["Project Chat system baseline", baseline],
    ["global Cake Chat system baseline", projectTodoBaseline(emptyProjectTodos(), "Cake Chat")],
    ["shipped operational reference", chatGuide],
    ...["todos.create", "todos.update", "todos.update-many"].map((command) => [
      `${command}.help`,
      registry.operationHelp(command),
    ]),
  ])(
    "shares the writing policy in %s without custom project instructions",
    (_surface, guidance) => {
      expect(guidance).toContain(PROJECT_TODO_DESCRIPTION_GUIDANCE);
    },
  );

  it("requires concise, evidence-based updates as work changes without status polling", () => {
    for (const requirement of [
      "Titles identify tasks; descriptions give the latest update, not a task restatement",
      "Use one or two short sentences",
      "Update when meaningful progress, findings, completion, review/merge readiness or blockers change",
      "using available events and evidence",
      "Say when no findings or fix exist",
      "never claim finished, merged or fixed without evidence",
      "Do not poll, schedule timers or wake workers merely for status",
      "preserve notification behavior",
    ]) {
      expect(PROJECT_TODO_DESCRIPTION_GUIDANCE).toContain(requirement);
    }
  });

  it("focuses summaries on user outcomes and keeps provenance in linked evidence", () => {
    for (const requirement of [
      "user-relevant outcome, current state and remaining blockers or decisions",
      "Omit commit hashes, commit messages and routine implementation/test bookkeeping",
      "keep technical provenance in linked reports or code references",
      "Retain verification gaps or failures that affect readiness",
    ]) {
      expect(PROJECT_TODO_SUMMARY_GUIDANCE).toContain(requirement);
    }
    expect(PROJECT_TODO_DESCRIPTION_GUIDANCE).toContain(PROJECT_TODO_SUMMARY_GUIDANCE);
  });

  it("shows the approved updates and keeps the description current even when status is used", () => {
    for (const example of [
      "Preset prompts are implemented. Review and merge still pending.",
      "Apple Silicon packaging is implemented. Review, merge and release remain pending; downloaded-app first launch and release CI are unverified.",
      "Startup delays first display, but the full ~500 ms remains unexplained. No fix implemented.",
      "Live widget-theme fix is underway, including System mode. No findings reported yet.",
    ]) {
      expect(chatGuide).toContain(example);
    }
    expect(chatGuide).toContain(
      "The required `description` carries this update even when optional freeform `status` is used",
    );
    expect(registry.operationHelp("todos.create")).toContain(
      "Startup investigation is underway. No findings reported yet.",
    );
  });
});

describe("when to-dos are created and closed", () => {
  const globalBaseline = projectTodoBaseline(emptyProjectTodos(), "Cake Chat");

  it.each([
    ["Project Chat baseline", baseline],
    ["global Cake Chat baseline", globalBaseline],
    ["todos.create.help", registry.operationHelp("todos.create")],
    ["todos.update.help", registry.operationHelp("todos.update")],
  ])("%s carries the creation and/or closing rules", (surface, guidance) => {
    if (surface !== "todos.update.help") expect(guidance).toContain(PROJECT_TODO_CREATION_RULE);
    if (surface !== "todos.create.help") expect(guidance).toContain(PROJECT_TODO_CLOSING_RULE);
  });

  it("tracks every unsettled request, including delegated work and brainstorms", () => {
    for (const requirement of [
      "Every user request that isn't fully settled in the same reply gets a to-do, created before or as the work starts.",
      "delegated work of any kind (subagents, background lookups, sessions)",
      "brainstorms and open-ended discussions",
      '"look into", "find out", "research" or "come back to me"',
      "The only exceptions are quick factual answers fully given inline and casual conversation.",
      "A follow-up on an existing topic updates that item instead of creating a new one.",
    ]) {
      expect(PROJECT_TODO_CREATION_RULE).toContain(requirement);
      expect(chatGuide).toContain(requirement);
    }
  });

  it("keeps research open until the user reviewed it, while session-linked items close on resolve", () => {
    for (const requirement of [
      "Close a to-do yourself when the work is actually done: the change merged or shipped, the requested operation finished and was checked, or the user said they're satisfied with the outcome.",
      "Research, investigations, brainstorms and lookups stay open after the report arrives.",
      'Set the status to "Report delivered; awaiting your review", link the report, and close the to-do only after the user has read it and either said they\'re satisfied or moved on without follow-ups.',
      "Closing automatically when the linked session is resolved still applies",
    ]) {
      expect(PROJECT_TODO_CLOSING_RULE).toContain(requirement);
      expect(chatGuide).toContain(requirement);
    }
    expect(PROJECT_TODO_CLOSING_RULE).toContain(
      "resolve the session rather than marking the item done by hand",
    );
    expect(chatGuide).toContain(PROJECT_TODO_AUTO_COMPLETION_RULE);
  });

  it("drops the old judgment-based creation guidance everywhere agents read it", () => {
    for (const surface of [
      baseline,
      globalBaseline,
      chatGuide,
      ...["todos.list", "todos.create", "todos.update", "todos.update-many"].map((command) =>
        registry.operationHelp(command),
      ),
    ]) {
      expect(surface).not.toMatch(/discretionary/i);
      expect(surface).not.toContain("not one per question");
      expect(surface).not.toContain("one item per question");
      expect(surface).not.toContain("do not require items");
      expect(surface).not.toContain("todos.create/update when useful");
    }
  });

  it("gives global Cake Chat its own list and documents it", () => {
    expect(globalBaseline).toContain("## Cake Chat to-dos (application context)");
    expect(globalBaseline).toContain("separate from every Project Chat's list");
    expect(baseline).toContain("## Project Chat to-dos (application context)");
    expect(baseline).not.toContain("separate from every Project Chat's list");
    expect(chatGuide).toContain(
      "Project Chat and global Cake Chat (not coding sessions) have `todos.list`",
    );
    expect(chatGuide).not.toContain("Project Chat (not global Cake Chat");
  });
});
