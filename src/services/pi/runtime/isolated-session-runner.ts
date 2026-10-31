import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  assertInitialModelRegistered,
  registerAgentDirectoryExtensionProviders,
  requireRegisteredModel,
} from "./extension-providers";
import { createPromptCacheLineage } from "./prompt-cache-lineage";
import { createWidgetContextExtension } from "./widget-context-extension";
import { createWidgetBranchTools } from "./widget-branch-tools";
import { cakeBuiltinSkillsOverride } from "./cake-builtin-skills";
import type { WidgetCandidate } from "../../../contracts/widgets/widget-candidate";
import { createNestedToolActivityProjection } from "./nested-tool-activity-projection";
import { canonicalPathIsInsideRoot } from "./workspace-paths";
import type {
  ConversationSnapshot,
  ThinkingLevel,
  ToolOutputContent,
  UiPart,
} from "../../../contracts/conversations/session-contract";
import {
  boundedProjectionKey,
  createLiveMessageProjector,
  formatToolInput,
  formatToolResult,
  toolArtifactId,
  toolArtifactRevision,
  toolFilePath,
  toolResultOutputContent,
  toolResultDiff,
} from "./session-projection";

export interface IsolatedSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  projectTrusted: boolean;
  /** Required unless `widgetBranch` inherits the conversation's own prompt. */
  systemPrompt?: string;
  /**
   * Continues an inherited conversation as a widget side chat. The session keeps
   * the conversation's exact system prompt and tool declarations, so its first
   * request reuses the parent's prompt cache; only what the tools do changes.
   * `write`/`edit` change this operation-local candidate, `read` reads it and
   * skill resources, and every other inherited tool refuses.
   */
  widgetBranch?: {
    readonly candidate: WidgetCandidate;
    /** Whether `widget/state.json` (artifact JSON state) may be edited. */
    readonly allowState: boolean;
    onChange?(): void;
  };
  /** Explicit roots that may contain this session's cache ancestors. */
  promptCacheSessionRoots?: ReadonlyArray<string>;
  prompt: string;
  images?: ReadonlyArray<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
  signal?: AbortSignal;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  modelPurpose: string;
  cancellationMessage: string;
  tools?: string[];
  noTools?: "all";
  customTools?: ToolDefinition[];
  /** Restricts loaded skill and context-file resources to this canonical directory. */
  resourceRoot?: string;
  /** Loads the project skill catalog into the session context. */
  includeSkills?: boolean;
  /** Loads project instruction files such as AGENTS.md into the session context. */
  includeContextFiles?: boolean;
  /** Runs against an in-memory session and does not require a persisted session file. */
  ephemeral?: boolean;
  bindExtensions?: boolean;
  capturePromptError?: boolean;
  onEvent?(
    event:
      | { type: "part-updated"; part: UiPart }
      | { type: "usage-updated"; usage: NonNullable<ConversationSnapshot["usage"]> },
  ): void;
}

export interface IsolatedSessionResult {
  sessionId: string;
  /** Undefined for ephemeral sessions, which are never persisted. */
  sessionFile: string | undefined;
  response: string;
  error?: string;
  /** Why the final assistant reply stopped, for example `"length"` at the output limit. */
  stopReason?: string;
  usage?: ConversationSnapshot["usage"];
}

function sessionUsage(
  session: Pick<AgentSession, "getSessionStats">,
): NonNullable<ConversationSnapshot["usage"]> {
  const stats = session.getSessionStats();
  return {
    tokens: stats.tokens,
    cost: stats.cost,
    context: stats.contextUsage
      ? {
          tokens: stats.contextUsage.tokens,
          contextWindow: stats.contextUsage.contextWindow,
          percent: stats.contextUsage.percent,
        }
      : undefined,
  };
}

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        Reflect.get(item, "type") === "text" &&
        typeof Reflect.get(item, "text") === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function resourcePathIsInside(root: string, resourcePath: string) {
  return canonicalPathIsInsideRoot(root, resourcePath);
}

/** Run one deliberately resource-restricted Pi sidecar session. */
export async function runIsolatedSession(
  options: IsolatedSessionOptions,
): Promise<IsolatedSessionResult> {
  const widgetBranch = options.widgetBranch;
  const inherited = widgetBranch ? options.sessionManager.buildSessionContext().messages : [];
  const inheritedSystem = widgetBranch ? getCurrentSystemMessage(inherited) : undefined;
  if (widgetBranch && !inheritedSystem)
    throw new Error("The widget side chat has no inherited system prompt to reuse");
  if (!widgetBranch && options.systemPrompt === undefined)
    throw new Error(`The ${options.modelPurpose} session requires a system prompt`);
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${options.agentDir}/auth.json`,
    modelsPath: `${options.agentDir}/models.json`,
    modelsStorePath: `${options.agentDir}/models-cache.json`,
  });
  // Discovered extensions stay disabled. The agent directory's providers still
  // apply, as do explicit Cake-owned context/cache hooks for widget branches.
  await registerAgentDirectoryExtensionProviders(options.agentDir, modelRuntime);
  const resourceRoot = options.resourceRoot;
  const includeSkills = options.includeSkills || !!widgetBranch;
  const builtinSkills = includeSkills
    ? await cakeBuiltinSkillsOverride(options.agentDir)
    : undefined;
  const promptCacheLineage = options.promptCacheSessionRoots
    ? createPromptCacheLineage()
    : undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: !includeSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !options.includeContextFiles,
    systemPrompt: inheritedSystem ? undefined : options.systemPrompt,
    appendSystemPromptOverride: inheritedSystem ? () => [] : undefined,
    extensionFactories: [
      ...(promptCacheLineage ? [promptCacheLineage.extension] : []),
      ...(inheritedSystem ? [createWidgetContextExtension(inheritedSystem)] : []),
    ],
    skillsOverride: (base) => {
      const current = builtinSkills ? builtinSkills(base) : base;
      return resourceRoot
        ? {
            ...current,
            skills: current.skills.filter((skill) =>
              resourcePathIsInside(resourceRoot, skill.filePath),
            ),
          }
        : current;
    },
    agentsFilesOverride: resourceRoot
      ? (current) => ({
          agentsFiles: current.agentsFiles.filter((file) =>
            resourcePathIsInside(resourceRoot, file.path),
          ),
        })
      : undefined,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.projectTrusted });
  const branchTools = widgetBranch
    ? await createWidgetBranchTools({
        cwd: options.cwd,
        declarations: getCurrentTools(inherited),
        candidate: widgetBranch.candidate,
        allowState: widgetBranch.allowState,
        skills: resourceLoader.getSkills().skills,
        onChange: widgetBranch.onChange,
      })
    : [];
  const selectedTools = widgetBranch ? branchTools.map((tool) => tool.name) : options.tools;
  const selectedModel = options.model
    ? requireRegisteredModel(modelRuntime, {
        provider: options.model.provider,
        modelId: options.model.id,
      })
    : undefined;
  if (!selectedModel)
    assertInitialModelRegistered(modelRuntime, settingsManager, options.sessionManager);
  const agentSessionOptions = {
    model: selectedModel,
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: options.sessionManager,
    customTools: [...(options.customTools ?? []), ...branchTools],
  };
  const optionsWithTools = selectedTools
    ? { ...agentSessionOptions, tools: selectedTools }
    : agentSessionOptions;
  const { session } = await createAgentSession(
    options.noTools && !widgetBranch
      ? { ...optionsWithTools, noTools: options.noTools }
      : optionsWithTools,
  );

  try {
    if (options.signal?.aborted) throw new Error(options.cancellationMessage);
    const abort = () => {
      void session.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (promptCacheLineage && options.promptCacheSessionRoots)
        await promptCacheLineage.attach({
          sessionManager: options.sessionManager,
          sessionRoots: options.promptCacheSessionRoots,
        });
      if (options.bindExtensions || promptCacheLineage || inheritedSystem)
        await session.bindExtensions({ mode: "rpc" });
      if (options.thinkingLevel) session.setThinkingLevel(options.thinkingLevel);

      let response = "";
      let failure = "";
      let stopReason: string | undefined;
      const projectLiveMessage = createLiveMessageProjector();
      const activeToolCalls = new Map<
        string,
        {
          input: string;
          artifactId?: string;
          filePath?: string;
          diff?: string;
          outputContent?: ToolOutputContent[];
        }
      >();
      const nestedActivity = createNestedToolActivityProjection((part) =>
        options.onEvent?.({ type: "part-updated", part }),
      );
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "toolResult")
          nestedActivity.record(event.message.toolCallId, event.message.nestedCalls);
        if (event.type === "agent_settled") nestedActivity.settle();
        for (const part of projectLiveMessage(event)) {
          if (part.kind !== "text" || part.role !== "user")
            options.onEvent?.({ type: "part-updated", part });
        }
        if (event.type === "tool_execution_start") {
          const call = {
            input: formatToolInput(event.toolName, event.args),
            artifactId: toolArtifactId(event.args),
            filePath: toolFilePath(event.toolName, event.args),
          };
          activeToolCalls.set(event.toolCallId, call);
          nestedActivity.project(
            {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              ...call,
              state: "running",
            },
            event.parentToolCallId,
          );
        }
        if (event.type === "tool_execution_update") {
          const call = activeToolCalls.get(event.toolCallId) ?? {
            input: formatToolInput(event.toolName, event.args),
            artifactId: toolArtifactId(event.args),
            filePath: toolFilePath(event.toolName, event.args),
            diff: undefined,
          };
          const diff = toolResultDiff(event.toolName, event.partialResult) ?? call.diff;
          const outputContent = toolResultOutputContent(event.partialResult) ?? call.outputContent;
          const nextCall = diff || outputContent ? { ...call, diff, outputContent } : call;
          activeToolCalls.set(event.toolCallId, nextCall);
          nestedActivity.project(
            {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              ...nextCall,
              output: formatToolResult(event.partialResult),
              state: "running",
            },
            event.parentToolCallId,
          );
        }
        if (event.type === "tool_execution_end") {
          const call = activeToolCalls.get(event.toolCallId);
          activeToolCalls.delete(event.toolCallId);
          nestedActivity.project(
            {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              input: call?.input ?? "",
              output: formatToolResult(event.result),
              artifactId: toolArtifactId(event.result) ?? call?.artifactId,
              artifactRevision: toolArtifactRevision(event.result),
              filePath: call?.filePath,
              diff: toolResultDiff(event.toolName, event.result) ?? call?.diff,
              outputContent: toolResultOutputContent(event.result) ?? call?.outputContent,
              state: event.isError ? "error" : "success",
            },
            event.parentToolCallId,
          );
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          response = textFromContent(event.message.content).trim();
          stopReason = event.message.stopReason;
          if (event.message.errorMessage) failure = event.message.errorMessage;
          options.onEvent?.({ type: "usage-updated", usage: sessionUsage(session) });
        }
      });
      try {
        await session.prompt(options.prompt, {
          source: "interactive",
          images: options.images ? [...options.images] : undefined,
        });
      } catch (error) {
        if (!options.capturePromptError) throw error;
        failure ||= error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribe();
        nestedActivity.clear();
      }
      if (!options.ephemeral && !session.sessionFile)
        throw new Error(`The ${options.modelPurpose} session was not persisted`);
      return {
        sessionId: session.sessionManager.getSessionId(),
        sessionFile: session.sessionFile,
        response,
        error: failure || undefined,
        stopReason,
        usage: sessionUsage(session),
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } finally {
    session.dispose();
  }
}
