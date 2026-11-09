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
      ? "Subagents are parent-owned investigators, not Project Sessions or human Side Chats. Context inheritance does not change ownership. Fresh-context subagents require an explicit request; sessions.fork is an allowed context-inheriting subagent. Investigation with an explicitly requested different model uses a private subagent directly with that model, not sessions.fork or sessions.create as a research workaround. Investigation where existing context is not helpful may use a private subagent only when explicitly authorized; otherwise use sessions.fork for useful-context investigation where implementation is not yet clear. Implementation/code changes default to sessions.create, a fresh independent Project Session with a scoped task and managed worktree; never sessions.fork or family children. If code changes become needed, return findings for handoff; never silently expand research into coding."
      : "Subagents are private, hidden, bounded workers—not full Project Sessions. A request for a child session, related session, or Session Family member is not subagent delegation; use sessions.create-child instead.",
    projectAware
      ? "For authorized private investigation, discover registered roots with projects.list, pass projectPath and resolve ambiguous identity first. Omit projectPath for general research; never choose an arbitrary repository for external research. Launch asynchronously/non-blocking with continuation: none (notification) by default, resume only for owed answers/dependencies. Minimize cross-session chatter; completion is automatic."
      : "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    `Use subagents.start asynchronously. continuation: "resume" (default, reply) queues a parent turn with the result; "none" (notification) puts the quiet report in the pending batch. ${replyOrNotificationRule} Both owe a result, including linked results. Resume queues behind active parent work, never steers it. Do not poll. Blocking run/parallel/wait return the result directly instead of adding a continuation. Follow-ups inherit the choice unless overridden; immediate message_parent blockers/questions are unchanged.`,
    "Use subagents.run, subagents.parallel, or subagents.wait only when the user explicitly requires the parent turn to block on delegated work.",
    projectAware
      ? "Project investigators use the registered root, applicable instructions, skills, extensions and MCP, without edit/write. Without projectPath, general researchers get only read, bash and message_parent, no repository resources. Read-only shell retrieval requires working network access; browser/search is not guaranteed. Disclose limits; never invent retrieved evidence. Both modes refuse mutations by default, including shell/MCP writes. For user-requested bounded non-code operations (scripts, process termination, installs), launch with allowMutations: true and exact targets/limits; never use this as an implementation workaround. The worker must report all changes and avoid shared-branch Git mutations unless explicitly instructed. An existing handle cannot gain this flag. These are prompt policies, not a sandbox. Reviewable code implementation belongs in a normal Project Session."
      : "Each subagent has read, bash, edit, write, and one bounded message_parent tool, but no Cake controls, project instructions, skills, or recursive delegation.",
    projectAware
      ? "Handles are parent-owned and available for related follow-ups until explicitly closed or expired while idle; turns have no time limit and an active turn is never expired. Handles, exact grants and Pi history survive backend restart. Safe unfinished work resumes; uncertain tool effects require review rather than replay. Follow-ups are asynchronous; detailed live activity is not retained in Cake Chat history."
      : "Handles are parent-owned and remain available for follow-up until explicitly closed; parallel batches contain at most eight tasks.",
    "Pass todoId to attach supporting findings to the existing open outcome; carry it into implementation/review. Subagent completion never resolves required Project Sessions.",
    "Attachments are not inherited. Pass exact IDs in inputRefs on tasks/follow-ups to grant access. Forwarding shares metadata only; attachments.read reads text/native pixels. Never substitute storage paths or describe unseen images.",
    "Pass exact Cake links in messageRefs to share source identities without reading/paraphrasing. Workers can read only selected refs. Forwarding neither reads message bodies nor grants attachment contents.",
    projectAware
      ? "Omit model unless requested; Cake Chat workers use the user's Subagent default model setting (current model by default). Explicit model overrides it."
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
      ...(model.preset ? { preset: model.preset } : null),
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
      summary: "Run worker; block caller",
      schema: subagentTaskSchema,
      example: {
        task: "Inspect the authentication flow",
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.run(resolveTask(input), parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.start",
      summary: "Start asynchronous investigator",
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
      summary: "Run up to eight workers; block",
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
      summary: "Prompt idle worker asynchronously",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Continue" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "prompt" }, parent, signal),
    }),
    operation({
      command: "subagents.follow-up",
      summary: "Queue worker follow-up",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Also inspect callers" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "follow-up" }, parent, signal),
    }),
    operation({
      command: "subagents.wait",
      summary: "Wait for worker; block",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent, signal, onUpdate) =>
        control.wait(input.handleId, parent, signal, onUpdate),
    }),
    operation({
      command: "subagents.abort",
      summary: "Stop worker",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.abort(input.handleId, parent),
    }),
    operation({
      command: "subagents.close",
      summary: "Release worker",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.close(input.handleId, parent),
    }),
  ];
}
