import { Schema } from "effect";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
} from "../../contracts/model-presets/cake-model-selection";
import { type JsonObject, type JsonValue } from "../../contracts/serialization/json-contract";
import type { CakeSessionRuntimeOptions } from "../../services/pi/runtime/cake-session-runtime";
import type { CakeOperationDefinition } from "../../services/pi/runtime/cake-operation-registry";
import type { SubagentTaskInput as DomainSubagentTaskInput } from "../../contracts/subagents/subagent-data";
import {
  parallelSubagentSchema,
  subagentTaskSchema,
  type SubagentTaskInput,
} from "../../contracts/subagents/subagent-tool-input";

export function createAgentControlOperations(
  control: NonNullable<CakeSessionRuntimeOptions["agentControl"]>,
  parentSessionId: () => string | undefined,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
  projectAware = false,
): CakeOperationDefinition[] {
  const promptSchema = Schema.Struct({
    handleId: Schema.String.check(Schema.isUUID()),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  });
  const handleSchema = Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) });
  const guidance = [
    projectAware
      ? "Subagents are private, hidden project investigators—not full Project Sessions. Use sessions.create for implementation in an independent Project Session, not an investigation worker."
      : "Subagents are private, hidden, bounded workers—not full Project Sessions. A request for a child session, related session, or Session Family member is not subagent delegation; use sessions.create-child instead.",
    projectAware
      ? "Delegate every question depending on a registered project's code, architecture, configuration or current behavior. Discover exact project paths with app.state, supply projectPath, and clarify ambiguous project identity before starting. No separate delegation permission is needed for Cake Chat investigations."
      : "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    "Use subagents.start for ordinary delegation so the parent turn remains independent and the user can continue messaging it. Start multiple handles for parallel work; Cake automatically queues each compact final report to the parent, so do not poll.",
    "Use subagents.run, subagents.parallel, or subagents.wait only when the user explicitly requires the parent turn to block on delegated work.",
    projectAware
      ? "Project investigators use the registered project root and normal applicable instructions, skills, extensions and MCP. They omit edit/write and prohibit all mutations, including shell/MCP writes, even if their parent requests them. This is an investigation-only prompt policy, not a read-only sandbox. Implementation belongs in a normal Project Session."
      : "Each subagent has read, bash, edit, write, and one bounded message_parent tool, but no Cake controls, project instructions, skills, or recursive delegation.",
    projectAware
      ? "Handles are parent-owned and available for related follow-ups until explicitly closed or the backend exits. Workers are in-memory and never restored after restart. Follow-ups are asynchronous; detailed live activity is not retained in Cake Chat history."
      : "Handles are parent-owned and remain available for follow-up until explicitly closed; parallel batches contain at most eight tasks.",
    "When model is omitted, a subagent inherits the calling session's current model, thinking level, and Fast mode setting.",
  ];
  const resolveTask = (input: SubagentTaskInput): DomainSubagentTaskInput => {
    const model = resolveModel(input.model);
    return {
      ...input,
      model: {
        prefer: "exact",
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
      },
      fastMode: model.fastMode,
    };
  };
  const operation = <Input>(definition: {
    command: string;
    summary: string;
    schema: Schema.ConstraintDecoder<Input, never>;
    example: JsonObject;
    run(
      input: Input,
      parent: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
  }): CakeOperationDefinition => ({
    command: definition.command,
    topic: "subagents",
    summary: definition.summary,
    guidance,
    inputSchema: definition.schema,
    examples: [{ input: definition.example }],
    result:
      "A bounded handle, activity projection, or final delegated result with attributed usage.",
    limitations: [
      "Subagents can message only their parent and cannot use Cake application controls or delegate further work.",
    ],
    async execute(input, context) {
      const parent = parentSessionId();
      if (!parent) throw new Error("The parent Cake session is not ready");
      // SAFETY: CakeOperationRegistry parsed input with this definition's schema.
      return definition.run(
        input as Input,
        parent,
        context.signal,
        context.onUpdate,
        `tool-${context.toolCallId}`,
      );
    },
  });
  return [
    operation({
      command: "subagents.run",
      summary:
        "Explicitly block the parent tool call while one isolated subagent runs and return its final result.",
      schema: subagentTaskSchema,
      example: {
        task: "Inspect the authentication flow",
        model: "Sol",
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.run(resolveTask(input), parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.start",
      summary:
        "Start one isolated parent-owned subagent asynchronously. Cake queues its compact final report to the parent without interrupting active work.",
      schema: subagentTaskSchema,
      example: projectAware
        ? {
            task: "Explain the authentication flow with file/line evidence",
            projectPath: "/registered/project",
            model: "Sol",
          }
        : { task: "Monitor the test run", model: "Sol" },
      run: (input, parent, signal, _onUpdate, anchor) =>
        control.start(resolveTask(input), parent, signal, anchor),
    }),
    operation({
      command: "subagents.parallel",
      summary:
        "Explicitly block the parent while up to eight bounded subagent tasks run concurrently.",
      schema: parallelSubagentSchema,
      example: {
        tasks: [
          {
            task: "Inspect tests",
            model: "Sol",
          },
        ],
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.parallel({ tasks: input.tasks.map(resolveTask) }, parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.prompt",
      summary: "Send a normal prompt to an idle subagent and wait for its turn.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Continue" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "prompt" }, parent, signal),
    }),
    operation({
      command: "subagents.follow-up",
      summary: "Queue a follow-up using Pi's normal queue policy.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Also inspect callers" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "follow-up" }, parent, signal),
    }),
    operation({
      command: "subagents.wait",
      summary:
        "Explicitly block the parent until a background subagent finishes; normally let Cake queue its report instead.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent, signal, onUpdate) =>
        control.wait(input.handleId, parent, signal, onUpdate),
    }),
    operation({
      command: "subagents.abort",
      summary: "Cancel active work in a subagent.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.abort(input.handleId, parent),
    }),
    operation({
      command: "subagents.close",
      summary: "Release a subagent handle and its hidden runtime.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.close(input.handleId, parent),
    }),
  ];
}
