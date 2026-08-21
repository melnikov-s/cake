import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  SessionSnapshot,
  ThinkingLevel,
  ToolOutputContent,
  UiPart,
} from "../ipc/session-contract";
import {
  boundedProjectionKey,
  createLiveMessageProjector,
  formatToolInput,
  formatToolResult,
  toolArtifactId,
  toolFilePath,
  toolResultOutputContent,
  toolResultDiff,
} from "./session-projection";

export interface IsolatedSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  projectTrusted: boolean;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
  modelPurpose: string;
  cancellationMessage: string;
  tools?: string[];
  noTools?: "all";
  bindExtensions?: boolean;
  capturePromptError?: boolean;
  onEvent?(
    event:
      | { type: "part-updated"; part: UiPart }
      | { type: "usage-updated"; usage: NonNullable<SessionSnapshot["usage"]> },
  ): void;
}

export interface IsolatedSessionResult {
  sessionId: string;
  sessionFile: string;
  response: string;
  error?: string;
  usage?: SessionSnapshot["usage"];
}

function sessionUsage(
  session: Pick<AgentSession, "getSessionStats">,
): NonNullable<SessionSnapshot["usage"]> {
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

/** Run one deliberately resource-restricted Pi sidecar session. */
export async function runIsolatedSession(
  options: IsolatedSessionOptions,
): Promise<IsolatedSessionResult> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${options.agentDir}/auth.json`,
    modelsPath: `${options.agentDir}/models.json`,
    modelsStorePath: `${options.agentDir}/models-cache.json`,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: options.systemPrompt,
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.projectTrusted });
  const agentSessionOptions = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime,
    resourceLoader,
    settingsManager,
    sessionManager: options.sessionManager,
  };
  const optionsWithTools = options.tools
    ? { ...agentSessionOptions, tools: options.tools }
    : agentSessionOptions;
  const { session } = await createAgentSession(
    options.noTools ? { ...optionsWithTools, noTools: options.noTools } : optionsWithTools,
  );

  try {
    if (options.signal?.aborted) throw new Error(options.cancellationMessage);
    const abort = () => {
      void session.abort();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.bindExtensions) await session.bindExtensions({ mode: "rpc" });
      if (options.model) {
        const model = modelRuntime.getModel(options.model.provider, options.model.id);
        if (!model)
          throw new Error(
            `Unknown ${options.modelPurpose} model ${options.model.provider}/${options.model.id}`,
          );
        await session.setModel(model);
      }
      if (options.thinkingLevel) session.setThinkingLevel(options.thinkingLevel);

      let response = "";
      let failure = "";
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
      const unsubscribe = session.subscribe((event) => {
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
          options.onEvent?.({
            type: "part-updated",
            part: {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              ...call,
              state: "running",
            },
          });
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
          options.onEvent?.({
            type: "part-updated",
            part: {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              ...nextCall,
              output: formatToolResult(event.partialResult),
              state: "running",
            },
          });
        }
        if (event.type === "tool_execution_end") {
          const call = activeToolCalls.get(event.toolCallId);
          activeToolCalls.delete(event.toolCallId);
          options.onEvent?.({
            type: "part-updated",
            part: {
              id: boundedProjectionKey(`tool-${event.toolCallId}`),
              kind: "tool",
              name: event.toolName,
              input: call?.input ?? "",
              output: formatToolResult(event.result),
              artifactId: toolArtifactId(event.result) ?? call?.artifactId,
              filePath: call?.filePath,
              diff: toolResultDiff(event.toolName, event.result) ?? call?.diff,
              outputContent: toolResultOutputContent(event.result) ?? call?.outputContent,
              state: event.isError ? "error" : "success",
            },
          });
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          response = textFromContent(event.message.content).trim();
          if (event.message.errorMessage) failure = event.message.errorMessage;
          options.onEvent?.({ type: "usage-updated", usage: sessionUsage(session) });
        }
      });
      try {
        await session.prompt(options.prompt, { source: "interactive" });
      } catch (error) {
        if (!options.capturePromptError) throw error;
        failure ||= error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribe();
      }
      if (!session.sessionFile)
        throw new Error(`The ${options.modelPurpose} session was not persisted`);
      return {
        sessionId: session.sessionManager.getSessionId(),
        sessionFile: session.sessionFile,
        response,
        error: failure || undefined,
        usage: sessionUsage(session),
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } finally {
    session.dispose();
  }
}
