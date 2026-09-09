import type {
  AgentSession,
  ResourceLoader,
  SettingsManager,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  CompatibilityCatalog,
  ExtensionUiEvent,
  ExtensionUiIntent,
  ResourceDiagnostic,
  UiPart,
} from "../../../ipc/session-contract";
import { compatibilityCatalog } from "../live/PiCompatibilityProjection";
import { createCakeExtensionUiContext } from "./extension-compatibility";
import { ReloadableResourceLoader } from "./ReloadableResourceLoader";
import type { RuntimeUiRequest } from "./runtime-ui-request";

interface CakeRuntimeExtensionUiState {
  statuses: Array<{ key: string; text: string }>;
  title?: string;
}

export interface CakeRuntimeResourceLifecycle {
  readonly compatibility: CompatibilityCatalog;
  readonly extensionUi: CakeRuntimeExtensionUiState;
  readonly reloadPending: () => boolean;
  readonly commandCatalog: () => SlashCommandInfo[];
  readonly requestReload: () => Promise<void>;
  readonly drainReloads: () => Promise<void> | undefined;
  readonly dispose: () => void;
}

export async function loadCakeRuntimeResourceLoader(input: {
  readonly makeResourceLoader: () => ResourceLoader;
  readonly trusted: boolean;
}): Promise<ReloadableResourceLoader> {
  const resourceLoader = new ReloadableResourceLoader(input.makeResourceLoader);
  await resourceLoader.reload({ resolveProjectTrust: async () => input.trusted });
  return resourceLoader;
}

export async function createCakeRuntimeResourceLifecycle(input: {
  readonly resourceLoader: ReloadableResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly workingDirectory: string;
  readonly agentDirectory: string;
  readonly session: AgentSession;
  readonly requestUi: (request: RuntimeUiRequest) => Promise<string | undefined>;
  readonly emitExtensionUiIntent?: (intent: ExtensionUiIntent) => void;
  readonly emitEvent: (event: ExtensionUiEvent) => void;
  readonly emitPart: (part: UiPart) => void;
  readonly removePart: (partId: string) => void;
  readonly emitSnapshot: () => Promise<void>;
}): Promise<CakeRuntimeResourceLifecycle> {
  const { resourceLoader } = input;
  const initialCatalog = compatibilityCatalog(
    resourceLoader,
    input.settingsManager,
    input.workingDirectory,
    input.agentDirectory,
  );
  const diagnostics: ResourceDiagnostic[] = [...initialCatalog.diagnostics];
  const compatibility: CompatibilityCatalog = {
    ...initialCatalog,
    resources: [...initialCatalog.resources],
    diagnostics,
  };
  const extensionUi: CakeRuntimeExtensionUiState = { statuses: [] };
  const diagnosticKeys = new Set(
    compatibility.diagnostics.map((item) => `${item.method ?? ""}:${item.message}`),
  );
  let disposed = false;
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;

  const uiContext = createCakeExtensionUiContext({
    request: input.requestUi,
    state: extensionUi,
    emitState: (event) => {
      if (!disposed) input.emitEvent(event);
    },
    emitIntent: (intent) => {
      if (!disposed) input.emitExtensionUiIntent?.(intent);
    },
    addDiagnostic(method, message) {
      const key = `${method}:${message}`;
      if (diagnosticKeys.has(key)) return;
      diagnosticKeys.add(key);
      const diagnostic: ResourceDiagnostic = {
        id: `compatibility:${method}:${diagnosticKeys.size}`,
        severity: "warning",
        source: "compatibility",
        method,
        message,
      };
      diagnostics.push(diagnostic);
      if (!disposed) input.emitEvent({ kind: "diagnostic", diagnostic });
    },
  });
  await input.session.bindExtensions({ mode: "rpc", uiContext });

  const drainReloads = () => {
    if (reloadInFlight) return reloadInFlight;
    if (
      reloadCompleted >= reloadRequested ||
      input.session.isStreaming ||
      input.session.isCompacting
    )
      return;
    reloadInFlight = (async () => {
      try {
        while (
          !disposed &&
          reloadCompleted < reloadRequested &&
          !input.session.isStreaming &&
          !input.session.isCompacting
        ) {
          const target = reloadRequested;
          input.emitPart({
            id: "pi-reload-status",
            kind: "notice",
            tone: "info",
            title: "Reloading Pi",
            detail: "Refreshing settings, extensions, skills, prompts, and tools.",
          });
          await input.session.reload();
          reloadCompleted = target;
        }
        if (!disposed && reloadCompleted >= reloadRequested) input.removePart("pi-reload-status");
      } catch (error) {
        reloadCompleted = reloadRequested;
        if (!disposed)
          input.emitPart({
            id: "pi-reload-status",
            kind: "notice",
            tone: "error",
            title: "Pi reload failed",
            detail: error instanceof Error ? error.message : String(error),
          });
        throw error;
      } finally {
        reloadInFlight = undefined;
        await input.emitSnapshot();
      }
    })();
    return reloadInFlight;
  };

  return {
    compatibility,
    extensionUi,
    reloadPending: () => reloadCompleted < reloadRequested || Boolean(reloadInFlight),
    commandCatalog() {
      // Read live Pi-owned collections. Captured extension contexts become stale
      // when Pi reloads and assert if snapshots try to use them afterward.
      const extensionCommands = input.session.extensionRunner
        .getRegisteredCommands()
        .map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension" as const,
          sourceInfo: command.sourceInfo,
        }));
      const templateCommands = input.session.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        argumentHint: template.argumentHint,
        source: "prompt" as const,
        sourceInfo: template.sourceInfo,
      }));
      const skillCommands = resourceLoader.getSkills().skills.map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
        sourceInfo: skill.sourceInfo,
      }));
      return [...extensionCommands, ...templateCommands, ...skillCommands];
    },
    async requestReload() {
      reloadRequested += 1;
      if (input.session.isStreaming || input.session.isCompacting) {
        input.emitPart({
          id: "pi-reload-status",
          kind: "notice",
          tone: "info",
          title: "Pi reload queued",
          detail: "Cake will reload Pi after the current response settles.",
        });
        await input.emitSnapshot();
        return;
      }
      await drainReloads();
    },
    drainReloads,
    dispose() {
      disposed = true;
    },
  };
}
