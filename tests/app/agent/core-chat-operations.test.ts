import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { cakeChatControlTools } from "../../../src/contracts/application/window-control-definitions";
import {
  emptyProjectTodos,
  projectTodoBaseline,
  PROJECT_TODO_AUTO_COMPLETION_RULE,
  PROJECT_TODO_CREATION_RULE,
} from "../../../src/contracts/projects/project-todos";
import { createGlobalControlOperations } from "../../../src/domain/application/cake-global-control-operations";
import { createMessageOperations } from "../../../src/domain/conversations/cake-message-operations";
import { createProjectTodoOperations } from "../../../src/domain/projects/project-todo-operations";
import { createWidgetAttachmentOperations } from "../../../src/domain/widgets/cake-widget-attachment-operations";
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
const attachWidget = vi.fn(async () => ({ attached: true }));
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
  ...createCakeChatWorktreeOperations({ merge: unused, mergeAndResolve: unused }),
  ...createWidgetAttachmentOperations(attachWidget),
]);
const reference = coreChatOperations(operations);
const prompt = coordinatorSystemPrompt("", "/docs", false, reference);

const line = (command: string) =>
  reference.split("\n").find((item) => item.startsWith(`${command} {`));
const inputSchema = (command: string): { required?: string[]; properties?: object } => {
  const help = operations.operationHelp(command);
  if (!help) throw new Error(`Missing ${command}`);
  return JSON.parse(help.split("Input schema:\n")[1]!.split("\n")[0]!);
};
/** Top-level keys of a `{a, b?:"x"|{c}}` calling sketch. */
const topLevelKeys = (sketch: string) => {
  const keys: { name: string; optional: boolean }[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of sketch.slice(1, -1) + ",") {
    if (character === '"') quoted = !quoted;
    if (!quoted && "{[".includes(character)) depth += 1;
    if (!quoted && "}]".includes(character)) depth -= 1;
    if (!quoted && depth === 0 && character === ",") {
      const name = current.trim().match(/^[A-Za-z]+/)?.[0] ?? "";
      if (name) keys.push({ name, optional: current.trim()[name.length] === "?" });
      current = "";
    } else current += character;
  }
  return keys;
};

describe("core coordinator calling reference", () => {
  it("projects real launch and scoped lifecycle contracts, not Project Session-local controls", () => {
    expect(line("sessions.create")).toBe(
      'sessions.create {workspacePath, name, initialPrompt, worktreeName?, model?, resultDelivery?:"reply"|"notification"|"ignore", todoId?}',
    );
    expect(line("sessions.fork")).toBe(
      'sessions.fork {workspacePath, name, initialPrompt, worktreeName, resultDelivery?:"reply"|"notification"|"ignore", todoId?}',
    );
    expect(line("sessions.send")).toContain('delivery?:"fyi"|"prompt"|"steer"|"queue"');
    expect(line("sessions.send")).toContain("sessionId");
    expect(line("sessions.send")).not.toContain("sessionId?");
    expect(line("worktrees.merge")).toBe("worktrees.merge {sessionId}");
    expect(line("worktrees.merge-and-resolve")).toBe("worktrees.merge-and-resolve {sessionId}");
    expect(line("sessions.resolve")).toBe(
      'sessions.resolve {targets:[{kind:"project", sessionId}], resolved}',
    );
    expect(line("messages.read")).toBe("messages.read {ref, offset?, maxChars?}");
    expect(reference).not.toContain("session.create ");
    expect(reference).not.toContain("session.resolve ");
  });

  it("renders every registered required input, plus caller-required targets, as required", () => {
    // Shared contracts may default a key for some callers; permanent chats must still pass it.
    const callerRequired: Record<string, readonly string[]> = { "sessions.send": ["sessionId"] };
    const sketches = reference.split("\n").filter((item) => /^[a-z-]+(\.[a-z-]+)+ \{/.test(item));
    expect(sketches.length).toBeGreaterThan(10);
    for (const sketch of sketches) {
      const command = sketch.slice(0, sketch.indexOf(" {"));
      const schema = inputSchema(command);
      const keys = topLevelKeys(sketch.slice(command.length + 1));
      for (const key of [...(schema.required ?? []), ...(callerRequired[command] ?? [])])
        expect(keys, `${command} ${key}`).toContainEqual({ name: key, optional: false });
      for (const key of keys) {
        expect(Object.keys(schema.properties ?? {}), `${command} ${key.name}`).toContain(key.name);
        expect(key.optional, `${command} ${key.name}`).toBe(
          !schema.required?.includes(key.name) && !callerRequired[command]?.includes(key.name),
        );
      }
    }
    expect(Object.keys(callerRequired).every((command) => line(command))).toBe(true);
  });

  it("keeps deterministic tool prune separate from model compaction controls", () => {
    expect(line("sessions.tool-prune")).toBe("sessions.tool-prune {sessionId}");
  });

  it("exposes the unified attachment operations without a second plugin recipe", () => {
    expect(line("widgets.attach")).toContain("lineageId");
    expect(line("widgets.attach")).toContain("target");
    expect(line("widgets.attach")).toContain('"tab"');
    expect(line("widgets.detach")).toBe("widgets.detach {id}");
    expect(line("widgets.attachments")).toBe("widgets.attachments {}");
    expect(reference).not.toContain("plugins.present");
    expect(attachWidget).not.toHaveBeenCalled();
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
      "remainingWork?",
      'state?:"open"|"done"',
      "associations?",
      "needsAttention?",
      "attentionReason?",
      "attentionRequestId?",
    ])
      expect(line("todos.update")).toContain(key);
  });

  it("includes each shared contract once, without specialist schemas", () => {
    const assembled = `${prompt}\n${projectTodoBaseline(emptyProjectTodos())}`;
    expect(assembled.split(PROJECT_TODO_AUTO_COMPLETION_RULE)).toHaveLength(2);
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
    // Ratchets at the current sizes: growth requires a deliberate budget edit.
    expect(reference.length).toBeLessThanOrEqual(3064);
    expect(prompt.length).toBeLessThanOrEqual(8844);
  });

  it.each([
    ["Cake Chat", 14195],
    ["Project Chat", 14119],
  ] as const)(
    "bounds the shipped %s ingredients with recall, to-dos, attribution and preset guidance",
    (chat, budget) => {
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
      // Ratchet at the current size: growth requires a deliberate budget edit.
      expect(Buffer.byteLength(assembled)).toBeLessThanOrEqual(budget);
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
        "widgets.attach",
        "widgets.detach",
        "widgets.attachments",
      ])
        expect(
          assembled.split("\n").filter((item) => item.startsWith(`${command} {`)),
        ).toHaveLength(1);
      expect(assembled.match(/<original-conversation /g)).toHaveLength(1);
      expect(assembled.split(PROJECT_TODO_CREATION_RULE)).toHaveLength(2);
    },
  );

  it("keeps the companion's recall and authority without coordinator or to-do instructions", () => {
    const assembled = [
      coordinatorSystemPrompt("", "/docs", true, reference),
      durableArchiveRecallInstructions("companion"),
    ].join("\n\n");
    expect(assembled.match(/<original-conversation /g)).toHaveLength(1);
    expect(assembled).not.toMatch(
      /Core chat operations|cake-todo|to-dos \(application context\)|plugins\.present|hello-sample/,
    );
    // Ratchet at the current size: growth requires a deliberate budget edit.
    expect(Buffer.byteLength(assembled)).toBeLessThanOrEqual(2949);
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
