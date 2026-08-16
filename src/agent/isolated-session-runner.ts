import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  createAgentSession,
  type SessionManager
} from "@earendil-works/pi-coding-agent";

export interface IsolatedSessionOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  projectTrusted: boolean;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
  model?: { provider: string; id: string };
  modelPurpose: string;
  cancellationMessage: string;
  tools?: string[];
  noTools?: "all";
  bindExtensions?: boolean;
  capturePromptError?: boolean;
}

export interface IsolatedSessionResult {
  sessionId: string;
  sessionFile: string;
  response: string;
  error?: string;
}

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } =>
      typeof item === "object" && item !== null && Reflect.get(item, "type") === "text" && typeof Reflect.get(item, "text") === "string")
    .map((item) => item.text)
    .join("\n");
}

/** Run one deliberately resource-restricted Pi sidecar session. */
export async function runIsolatedSession(options: IsolatedSessionOptions): Promise<IsolatedSessionResult> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: options.projectTrusted });
  const modelRuntime = await ModelRuntime.create({
    authPath: `${options.agentDir}/auth.json`,
    modelsPath: `${options.agentDir}/models.json`,
    modelsStorePath: `${options.agentDir}/models-cache.json`
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
    systemPrompt: options.systemPrompt
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
    options.noTools
      ? { ...optionsWithTools, noTools: options.noTools }
      : optionsWithTools,
  );

  try {
    if (options.signal?.aborted) throw new Error(options.cancellationMessage);
    const abort = () => { void session.abort(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (options.bindExtensions) await session.bindExtensions({ mode: "rpc" });
      if (options.model) {
        const model = modelRuntime.getModel(options.model.provider, options.model.id);
        if (!model) throw new Error(`Unknown ${options.modelPurpose} model ${options.model.provider}/${options.model.id}`);
        await session.setModel(model);
      }

      let response = "";
      let failure = "";
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        response = textFromContent(event.message.content).trim();
        if (event.message.errorMessage) failure = event.message.errorMessage;
      });
      try {
        await session.prompt(options.prompt, { source: "interactive" });
      } catch (error) {
        if (!options.capturePromptError) throw error;
        failure ||= error instanceof Error ? error.message : String(error);
      } finally {
        unsubscribe();
      }
      if (!session.sessionFile) throw new Error(`The ${options.modelPurpose} session was not persisted`);
      return {
        sessionId: session.sessionManager.getSessionId(),
        sessionFile: session.sessionFile,
        response,
        error: failure || undefined
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } finally {
    session.dispose();
  }
}
