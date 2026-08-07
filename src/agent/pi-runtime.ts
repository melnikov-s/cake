import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type InlineExtension
} from "@earendil-works/pi-coding-agent";

export const piRuntimeVersion = "0.84.0" as const;

export type FoundationRuntimeEvent =
  | { type: "text-delta"; text: string }
  | { type: "session-ready"; sessionId: string };

export interface FoundationRuntimeOptions {
  cwd: string;
  agentDir: string;
  requestConfirm(title: string, message: string, signal?: AbortSignal): Promise<boolean>;
  onEvent(event: FoundationRuntimeEvent): void;
}

export interface FoundationRuntime {
  readonly sessionId: string;
  readonly sessionFile: undefined;
  run(): Promise<void>;
  dispose(): void;
}

const foundationExtension: InlineExtension = (pi) => {
  pi.registerCommand("cake-foundation", {
    description: "Exercise Cake's Pi session and extension UI boundaries",
    async handler(_args, ctx) {
      const accepted = await ctx.ui.confirm(
        "Pi extension confirmation",
        "This request came from a Pi extension running outside the renderer."
      );
      const chunks = accepted
        ? ["Pi", " session", " boundary", " is", " alive."]
        : ["Pi", " extension", " confirmation", " was", " declined."];

      for (const content of chunks) {
        pi.sendMessage({ customType: "cake.foundation", content, display: true });
      }
    }
  });
};

function unsupported(name: string): never {
  throw new Error(`Pi extension UI method ${name} is not supported by the S0 Cake adapter`);
}

function createExtensionUiContext(
  requestConfirm: FoundationRuntimeOptions["requestConfirm"]
): ExtensionUIContext {
  const noop = () => undefined;

  return {
    select: async () => undefined,
    confirm: (title, message, options) => requestConfirm(title, message, options?.signal),
    input: async () => undefined,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    custom: async () => unsupported("custom"),
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    get theme() {
      return unsupported("theme");
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme selection is not supported in S0" }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop
  };
}

function projectEvent(event: AgentSessionEvent): FoundationRuntimeEvent | undefined {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    return { type: "text-delta", text: event.assistantMessageEvent.delta };
  }

  if (
    event.type === "message_end" &&
    event.message.role === "custom" &&
    event.message.customType === "cake.foundation" &&
    typeof event.message.content === "string"
  ) {
    return { type: "text-delta", text: event.message.content };
  }

  return undefined;
}

export async function createFoundationRuntime(
  options: FoundationRuntimeOptions
): Promise<FoundationRuntime> {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: [foundationExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    noTools: "all",
    resourceLoader,
    sessionManager: SessionManager.inMemory(options.cwd),
    settingsManager
  });
  const unsubscribe = session.subscribe((event) => {
    const projected = projectEvent(event);
    if (projected) options.onEvent(projected);
  });

  await session.bindExtensions({
    mode: "rpc",
    uiContext: createExtensionUiContext(options.requestConfirm)
  });
  options.onEvent({ type: "session-ready", sessionId: session.sessionId });

  let disposed = false;
  return {
    sessionId: session.sessionId,
    sessionFile: undefined,
    async run() {
      if (disposed) throw new Error("The Pi foundation runtime has been disposed");
      await session.prompt("/cake-foundation", { source: "extension" });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      session.dispose();
    }
  };
}
