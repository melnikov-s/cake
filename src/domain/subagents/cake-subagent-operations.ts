import { Schema } from "effect";
import { ParentContinuation } from "../../contracts/conversations/parent-continuation";
import { replyOrNotificationRule } from "../../contracts/conversations/result-delivery";
import { inputRefsSchema } from "../../contracts/conversations/task-input";
import { messageRefsSchema } from "../../contracts/conversations/message-reference";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelLaunch,
} from "../../contracts/model-presets/cake-model-selection";
import { type JsonObject, type JsonValue } from "../../contracts/serialization/json-contract";
import type { AgentOperationControl } from "../../contracts/agent/cake-operation-options";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import type { SubagentTaskInput as DomainSubagentTaskInput } from "../../contracts/subagents/subagent-data";
import {
  parallelSubagentSchema,
  subagentTaskSchema,
  type SubagentTaskInput,
} from "../../contracts/subagents/subagent-tool-input";

export function createAgentControlOperations(
  control: AgentOperationControl,
  parentSessionId: () => string | undefined,
  resolveModel: (
    selection: CakeModelSelection | undefined,
    launch: CakeModelLaunch,
  ) => ExplicitCakeModelSelection,
  projectAware = false,
): CakeOperationDefinition[] {
  const promptSchema = Schema.Struct({
    continuation: Schema.optionalKey(ParentContinuation),
    handleId: Schema.String.check(Schema.isUUID()),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
    inputRefs: Schema.optionalKey(inputRefsSchema),
    messageRefs: Schema.optionalKey(messageRefsSchema),
  });
  const handleSchema = Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) });
  const guidance = [
    projectAware
      ? "Subagents are private, hidden general research or project investigators—not full Project Sessions. Use sessions.create for implementation in an independent Project Session, not an investigation worker."
      : "Subagents are private, hidden, bounded workers—not full Project Sessions. A request for a child session, related session, or Session Family member is not subagent delegation; use sessions.create-child instead.",
    projectAware
      ? "Use a project investigator when broader research, project-loaded resources or context isolation helps. Discover exact registered roots with projects.list, supply projectPath, and clarify ambiguous project identity before starting. Omit projectPath for general research unrelated to a registered repository; never choose an arbitrary project for external research. No separate delegation permission is needed for Cake Chat investigations."
      : "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    `Use subagents.start for ordinary delegation. continuation: "resume" (default, reply) starts a queued parent turn with the result so you can answer the user; choose "none" (notification) for a quiet report without a parent LLM turn. ${replyOrNotificationRule} Both owe a result, including linked results. Resume queues behind active parent work, never steers it. Do not poll. Blocking run/parallel/wait return the result directly instead of adding a continuation. Follow-ups inherit the choice unless overridden; immediate message_parent blockers/questions are unchanged.`,
    "Use subagents.run, subagents.parallel, or subagents.wait only when the user explicitly requires the parent turn to block on delegated work.",
    projectAware
      ? "Project investigators use the registered project root and normal applicable instructions, skills, extensions and MCP. They omit edit/write tools. Without projectPath, general researchers receive only read, bash and message_parent, no repository instructions, skills, extensions or MCP. Public web retrieval through read-only shell requests is possible only if network access works; no browser/search tool is guaranteed. Disclose access limits and never invent retrieved evidence. By default both modes are investigation-only and refuse all mutations, including shell/MCP writes. Set allowMutations: true on subagents.start only when the user's request needs bounded operational changes such as running scripts, killing processes or installing packages; the worker then stays within the assignment, reports exactly what it changed and avoids shared-branch Git mutations unless explicitly instructed. Name the exact targets and limits in the task. The flag cannot be added to an existing handle. These are prompt policies, not a sandbox. Code implementation that needs review still belongs in a normal Project Session."
      : "Each subagent has read, bash, edit, write, and one bounded message_parent tool, but no Cake controls, project instructions, skills, or recursive delegation.",
    projectAware
      ? "Handles are parent-owned and available for related follow-ups until explicitly closed or expired while idle; turns have no time limit and an active turn is never expired. Handles, exact grants and Pi history survive backend restart. Safe unfinished work resumes; uncertain tool effects require review rather than replay. Follow-ups are asynchronous; detailed live activity is not retained in Cake Chat history."
      : "Handles are parent-owned and remain available for follow-up until explicitly closed; parallel batches contain at most eight tasks.",
    "Attachments are not inherited. Select exact attachment IDs in inputRefs on a task or follow-up to grant that worker access. Forwarding shares only metadata; the worker must explicitly call attachments.read to inspect text or native image pixels. Never substitute a storage path or describe unseen image content.",
    "Pass exact Cake message links in messageRefs to share source identities without reading or paraphrasing them. Workers may explicitly read only the selected references; forwarding does not read message bodies or grant attached input contents.",
    projectAware
      ? "Omit model unless the user explicitly asks for a specific model. When omitted, a subagent uses the user's Subagent default model setting: by default your current model, thinking level, and Fast mode, or else the configured default preset, the utility model, one chosen preset, or one chosen model. An explicit model always overrides that setting."
      : "Omit model unless the user explicitly asks for a specific model. When omitted, a subagent uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling session's current model. Only when no default preset is configured does it use the calling session's current settings.",
  ];
  const resolveTask = (input: SubagentTaskInput): DomainSubagentTaskInput => {
    // An omitted model follows the user's Subagent default model setting.
    const model = resolveModel(input.model, "subagent");
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
    guidance: ["subagents.start", "subagents.run", "subagents.parallel"].includes(
      definition.command,
    )
      ? guidance
      : definition.command === "subagents.prompt" || definition.command === "subagents.follow-up"
        ? [
            'Follow-ups are asynchronous on every caller surface and inherit the handle continuation choice. Override with "resume" (reply) when the user is waiting on the answer or "none" (notification) for background work; waiting requires an explicit user request and subagents.wait.',
            ...guidance.slice(5, 8),
          ]
        : guidance.slice(5, 6),
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
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.run(resolveTask(input), parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.start",
      summary:
        "Start an asynchronous investigator; select projectPath for registered code or omit it for general research. Cake queues its final report.",
      schema: subagentTaskSchema,
      example: projectAware
        ? {
            task: "Explain the authentication flow with file/line evidence",
            projectPath: "/registered/project",
          }
        : { task: "Monitor the test run", continuation: "none" },
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
          },
        ],
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.parallel({ tasks: input.tasks.map(resolveTask) }, parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.prompt",
      summary: "Start an asynchronous prompt on an idle subagent and return after acceptance.",
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
