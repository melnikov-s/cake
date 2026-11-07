import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import {
  emptyProjectTodos,
  projectTodoBaseline,
} from "../../../src/contracts/projects/project-todos";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { createMessageOperations } from "../../../src/domain/conversations/cake-message-operations";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { createCakeChatWorktreeOperations } from "../../../src/domain/worktrees/cake-session-worktree-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { coreChatOperations } from "../../../src/services/pi-durable/core-chat-operations";
import { durableArchiveRecallInstructions } from "../../../src/services/pi-durable/durable-archive-recall";
import { TASK_ATTRIBUTION_INSTRUCTIONS } from "../../../src/services/pi-durable/durable-task-attribution";
import { presetGuidance } from "../../../src/contracts/model-presets/preset-context";

const unused = async (): Promise<never> => {
  throw new Error("Reference generation must not execute controls");
};
const operations = new CakeOperationRegistry([
  ...createGlobalControlOperations({ tools: cakeChatControlTools(), invoke: unused }, () => ({
    provider: "test",
    modelId: "test",
    thinkingLevel: "off",
    fastMode: false,
  })),
  ...createProjectTodoOperations({
    select: unused,
    list: unused,
    read: unused,
    create: unused,
    update: unused,
    updateMany: unused,
  }),
  ...createMessageOperations({ list: unused, read: unused, open: unused }),
  ...createCakeChatWorktreeOperations({ merge: unused }),
]);
const reference = coreChatOperations(operations);
const prompt = coordinatorSystemPrompt("", "/docs", false, reference);

const line = (command: string) =>
  reference.split("\n").find((item) => item.startsWith(`${command} {`));

describe("core coordinator calling reference", () => {
  it("projects real launch and scoped lifecycle contracts, not Project Session-local controls", () => {
    expect(line("sessions.create")).toBe(
      'sessions.create {workspacePath, name, initialPrompt, worktreeName?, model?, resultDelivery?:"reply"|"notification"|"ignore"}',
    );
    expect(line("sessions.fork")).toBe(
      'sessions.fork {workspacePath, name, initialPrompt, worktreeName, resultDelivery?:"reply"|"notification"|"ignore"}',
    );
    expect(line("sessions.send")).toContain('delivery?:"fyi"|"prompt"|"steer"|"queue"');
    expect(line("sessions.send")).toContain("sessionId");
    expect(line("sessions.send")).not.toContain("sessionId?");
    expect(line("worktrees.merge")).toBe("worktrees.merge {sessionId}");
    expect(line("sessions.resolve")).toBe(
      'sessions.resolve {targets:[{kind:"project", sessionId}], resolved}',
    );
    expect(line("messages.read")).toBe("messages.read {ref, offset?, maxChars?}");
    expect(reference).not.toContain("session.create ");
    expect(reference).not.toContain("session.resolve ");
  });

  it("exposes complete common to-do editing and generated association shapes", () => {
    expect(line("todos.list")).toContain('state?:"open"|"done"');
    expect(line("todos.list")).toContain("query?");
    expect(line("todos.read")).toBe("todos.read {id}");
    expect(line("todos.create")).toContain('{kind:"session", sessionId, title}');
    for (const key of [
      "id",
      "expectedRevision",
      "title?",
      "description?",
      'state?:"open"|"done"',
      "associations?",
      "needsAttention?",
      "attentionReason?",
    ])
      expect(line("todos.update")).toContain(key);
    expect(reference).toContain("Revision conflict: reread");
  });

  it("keeps security/workflow distinctions once, alongside existing baseline policy", () => {
    const assembled = `${prompt}\n${projectTodoBaseline(emptyProjectTodos())}`;
    for (const rule of [
      "Code changes: sessions.create",
      "supply a new worktreeName",
      "Context-dependent investigations: sessions.fork",
      "Private subagents require an explicit request",
      "Never edit settings files",
      "no checkout edits, installs, generated files or Git mutations",
      "notification by default",
      "Launch asynchronously",
      "reply for owed answers/dependencies",
      "fyi cannot request reply or forward attachments",
      "Receipt is intake, not execution",
      "never manual Git landing",
      "Inspect outcome/nextStep",
      "merging never resolves",
      "Resolve only when authorized",
      "resolved:false restores",
      "Execution/report arrival is not resolution",
      "Session-linked to-dos close through session resolution",
      "Restore never reopens a to-do",
      "replaced as a whole",
      "Reuse existing/session-created items",
      "dismissed request",
      "Standalone completion/reopening",
      "Known report ref: read directly",
      "nextOffset as offset",
      '"Full agent response"',
      "not verified success",
      "advanced options or contract errors",
      "No prerequisite guide reads",
    ])
      expect(assembled).toContain(rule);
    expect(assembled.match(/Full agent response/g)).toHaveLength(1);
    expect(assembled.match(/Session-linked to-dos close through session resolution/g)).toHaveLength(
      1,
    );
    expect(prompt.match(/sessions\.create \{/g)).toHaveLength(1);
    for (const specialist of [
      "subagents.start {",
      "widgets.present {",
      "settings.window.update {",
      "Input schema:",
      "$schema",
    ])
      expect(reference).not.toContain(specialist);
  });

  it(`bounds prompt size (${reference.length} reference; ${prompt.length} coordinator; ${projectTodoBaseline(emptyProjectTodos()).length} empty to-do baseline chars)`, () => {
    expect(reference.length).toBeLessThan(3500);
    expect(prompt.length).toBeLessThan(7000);
  });

  it.each(["Cake Chat", "Project Chat"] as const)(
    "bounds the shipped %s ingredients with recall, to-dos, attribution and preset guidance",
    (chat) => {
      const docs = `/Users/user/.pi/agent/cake-docs/${"a".repeat(64)}`;
      const assembled = [
        coordinatorSystemPrompt("", docs, false, reference),
        durableArchiveRecallInstructions("project-chat:fixture"),
        projectTodoBaseline(emptyProjectTodos(), chat),
        TASK_ATTRIBUTION_INSTRUCTIONS,
        presetGuidance({
          id: "00000000-0000-4000-8000-000000000001",
          prompt: "Be concise; retain necessary constraints.",
        }),
      ].join("\n\n");
      // Budget shipped ingredients, not user instructions, skills or populated list data.
      expect(Buffer.byteLength(assembled)).toBeLessThan(9000);
      for (const command of [
        "sessions.create",
        "sessions.fork",
        "todos.create",
        "todos.update",
        "sessions.send",
        "sessions.abort",
        "worktrees.merge",
        "sessions.resolve",
        "messages.read",
      ])
        expect(
          assembled.split("\n").filter((item) => item.startsWith(`${command} {`)),
        ).toHaveLength(1);
      expect(assembled).toContain("all required sessions resolve");
      expect(assembled).toContain("Reports/completion grant no merge/resolve approval");
      expect(assembled).toContain("shared/project instructions take precedence");
      expect(assembled.match(/Zoom relevant remembered dialogue/g)).toHaveLength(1);
      expect(assembled).not.toContain("Memory: Zoom");
    },
  );

  it("keeps the companion's recall and authority without coordinator or to-do instructions", () => {
    const assembled = [
      coordinatorSystemPrompt("", "/docs", true, reference),
      durableArchiveRecallInstructions("companion"),
    ].join("\n\n");
    expect(assembled).toContain("Never edit settings files");
    expect(assembled).toContain("Reports/completion grant no merge/resolve approval");
    expect(assembled).toContain("no sibling or arbitrary database access");
    expect(assembled).not.toMatch(/Core chat operations|cake-todo|to-dos \(application context\)/);
    expect(Buffer.byteLength(assembled)).toBeLessThan(3500);
  });

  it("never advertises missing/disabled controls or injects coordinator controls into the companion", () => {
    expect(coreChatOperations(new CakeOperationRegistry([]))).toBe("");
    const hidden = operations
      .definitions()
      .map((definition) => ({ ...definition, available: () => false }));
    expect(coreChatOperations(new CakeOperationRegistry(hidden))).toBe("");
    expect(coordinatorSystemPrompt("", "/docs", true, reference)).not.toContain(
      "Core chat operations",
    );
  });

  it("uses changed registered requiredness, literal values and local refs without another handwritten schema", () => {
    const definition = operations.definitions().find((item) => item.command === "sessions.create");
    if (!definition) throw new Error("Missing create operation");
    const changed = new CakeOperationRegistry([
      {
        ...definition,
        inputSchema: Schema.Struct({}),
        inputJsonSchema: {
          type: "object",
          required: ["newRequired", "worktreeName"],
          properties: {
            newRequired: { type: "string" },
            worktreeName: { type: "string" },
            resultDelivery: { $ref: "#/definitions/delivery" },
            advanced: { type: "string" },
          },
          definitions: { delivery: { enum: ["new-value"] } },
        },
      },
    ]);
    expect(coreChatOperations(changed)).toContain(
      'sessions.create {newRequired, worktreeName, resultDelivery?:"new-value"}',
    );
    expect(coreChatOperations(changed)).not.toContain("advanced?");
  });
});
