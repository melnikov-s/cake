import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import type { CakeOperationDefinition } from "../../../src/contracts/agent/cake-operation";
import { jsonObjectSchema } from "../../../src/contracts/serialization/json-contract";

const context = () => ({
  signal: new AbortController().signal,
  toolCallId: "call-1",
  runtime: {},
});

const execute = vi.fn<(input: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));

function operation(
  command: string,
  inputSchema: CakeOperationDefinition["inputSchema"],
): CakeOperationDefinition {
  return {
    command,
    topic: command.split(".")[0]!,
    summary: command,
    inputSchema,
    examples: [],
    result: "The decoded input.",
    execute,
  };
}

const subagentsStart = operation(
  "subagents.start",
  Schema.Struct({ task: Schema.String, projectPath: Schema.optionalKey(Schema.String) }),
);
const attachmentsRead = operation(
  "attachments.read",
  Schema.Struct({ reference: Schema.String, offset: Schema.optionalKey(Schema.Int) }),
);
const messagesRead = operation("messages.read", Schema.Struct({ ref: Schema.String }));
const sessionFork = operation(
  "session.fork",
  Schema.Struct({
    prompt: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
  }),
);
/** Global application controls validate across a boundary and publish only JSON Schema. */
const sessionsCreate: CakeOperationDefinition = {
  ...operation("sessions.create", jsonObjectSchema),
  inputJsonSchema: {
    type: "object",
    properties: {
      workspacePath: { type: "string" },
      name: { type: "string" },
      initialPrompt: { type: "string" },
    },
    required: ["workspacePath", "name", "initialPrompt"],
    additionalProperties: false,
  },
};
const registry = new CakeOperationRegistry([
  subagentsStart,
  attachmentsRead,
  messagesRead,
  sessionFork,
  sessionsCreate,
]);
const invoke = (command: string, input: object) =>
  registry.invoke({ command, input }, context()).then((result) => result.structuredContent);

describe("Cake operation input aliases", () => {
  it.each([
    ["subagents.start", { prompt: "Inspect" }, { task: "Inspect" }],
    ["subagents.start", { initialPrompt: "Inspect" }, { task: "Inspect" }],
    ["attachments.read", { id: "a1", offset: 2 }, { reference: "a1", offset: 2 }],
    ["messages.read", { reference: "cake://m" }, { ref: "cake://m" }],
    ["session.fork", { task: "Continue", name: "Fork" }, { prompt: "Continue", title: "Fork" }],
  ])("accepts an unambiguous alias for %s", async (command, input, decoded) => {
    await invoke(command, input);
    expect(execute).toHaveBeenLastCalledWith(decoded, expect.anything());
  });

  it("renames aliases before forwarding a JSON-Schema-only global control", async () => {
    await invoke("sessions.create", { workspacePath: "/p", title: "Fix", prompt: "Do it" });
    expect(execute).toHaveBeenLastCalledWith(
      { workspacePath: "/p", name: "Fix", initialPrompt: "Do it" },
      expect.anything(),
    );
  });

  it("rejects an alias given together with its field instead of guessing", async () => {
    await expect(invoke("subagents.start", { task: "A", prompt: "B" })).rejects.toThrow(
      'subagents.start received both "prompt" and "task". Use only "task"',
    );
  });

  it("names the expected fields when an unknown field is given", async () => {
    await expect(invoke("attachments.read", { path: "/tmp/x" })).rejects.toThrow(
      'attachments.read does not accept input field "path". Expected fields: reference (required), offset. Request {"command":"attachments.read.help"} for the exact schema.',
    );
  });

  it("adds expected fields to ordinary schema errors", async () => {
    await expect(invoke("subagents.start", {})).rejects.toThrow(
      /Invalid subagents\.start input: Missing key[\s\S]*Expected fields: task \(required\), projectPath\./,
    );
  });

  it("lists accepted aliases in operation help", async () => {
    const help = await invoke("subagents.start.help", {});
    expect(help).toContain("Aliases: task (also accepted as initialPrompt, prompt, text, message)");
  });

  it("leaves a declared field alone even if another operation would alias it", async () => {
    const both = new CakeOperationRegistry([
      operation(
        "sessions.ambiguous",
        Schema.Struct({ text: Schema.String, prompt: Schema.String }),
      ),
    ]);
    await expect(
      both.invoke({ command: "sessions.ambiguous", input: { task: "x" } }, context()),
    ).rejects.toThrow('does not accept input field "task"');
  });
});
