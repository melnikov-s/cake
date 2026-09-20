import type {
  AgentSession,
  EventBus,
  ResourceLoader,
  SettingsManager,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import {
  resourceDiagnosticSchema,
  type CompatibilityCatalog,
  type ExtensionCompanion,
  type ExtensionUiEvent,
  type ExtensionUiIntent,
  type ResourceDiagnostic,
  type UiPart,
} from "../../../ipc/session-contract";
import { compatibilityCatalog } from "../live/PiCompatibilityProjection";
import { createCakeExtensionUiContext } from "./extension-compatibility";
import { ReloadableResourceLoader } from "./ReloadableResourceLoader";
import type { RuntimeUiRequest } from "./runtime-ui-request";
import { jsonValueSchema, type JsonValue } from "../../../ipc/json-contract";
import {
  cakeCompanionActionChannel,
  cakeCompanionStateChannel,
  cakeCompanionStatePayloadSchema,
  loadExtensionCompanions,
} from "./extension-companions";

interface CakeSessionRuntimeExtensionUiState {
  statuses: Array<{ key: string; text: string }>;
  companions: ExtensionCompanion[];
  title?: string;
}

export interface CakeSessionRuntimeResourceLifecycle {
  readonly compatibility: CompatibilityCatalog;
  readonly extensionUi: CakeSessionRuntimeExtensionUiState;
  readonly reloadPending: () => boolean;
  readonly commandCatalog: () => SlashCommandInfo[];
  readonly requestReload: () => Promise<void>;
  readonly drainReloads: () => Promise<void> | undefined;
  readonly dispatchCompanionAction: (id: string, action: string, value: JsonValue) => Promise<void>;
  readonly dispose: () => void;
}

export async function loadCakeSessionRuntimeResourceLoader(input: {
  readonly makeResourceLoader: () => ResourceLoader;
  readonly trusted: boolean;
}): Promise<ReloadableResourceLoader> {
  const resourceLoader = new ReloadableResourceLoader(input.makeResourceLoader);
  await resourceLoader.reload({ resolveProjectTrust: async () => input.trusted });
  return resourceLoader;
}

export async function createCakeSessionRuntimeResourceLifecycle(input: {
  readonly resourceLoader: ReloadableResourceLoader;
  readonly settingsManager: SettingsManager;
  readonly eventBus: EventBus;
  readonly loadCompanions: boolean;
  readonly workingDirectory: string;
  readonly agentDirectory: string;
  readonly session: AgentSession;
  readonly requestUi: (request: RuntimeUiRequest) => Promise<string | undefined>;
  readonly emitExtensionUiIntent?: (intent: ExtensionUiIntent) => void;
  readonly emitEvent: (event: ExtensionUiEvent) => void;
  readonly emitPart: (part: UiPart) => void;
  readonly removePart: (partId: string) => void;
  readonly emitSnapshot: () => Promise<void>;
}): Promise<CakeSessionRuntimeResourceLifecycle> {
  const { resourceLoader } = input;
  const initialCatalog = compatibilityCatalog(
    resourceLoader,
    input.settingsManager,
    input.workingDirectory,
    input.agentDirectory,
  );
  let loadedCompanions = input.loadCompanions
    ? await loadExtensionCompanions(resourceLoader)
    : { companions: [], diagnostics: [], dispose() {} };
  const diagnostics: ResourceDiagnostic[] = [
    ...initialCatalog.diagnostics,
    ...loadedCompanions.diagnostics,
  ];
  const compatibility: CompatibilityCatalog = {
    ...initialCatalog,
    resources: [...initialCatalog.resources],
    diagnostics,
  };
  const extensionUi: CakeSessionRuntimeExtensionUiState = {
    statuses: [],
    companions: loadedCompanions.companions.map((companion) => ({ ...companion })),
  };
  const diagnosticKeys = new Set(
    compatibility.diagnostics.map(
      (item) => `${item.path ?? ""}:${item.method ?? ""}:${item.message}`,
    ),
  );
  let disposed = false;
  let reloadRequested = 0;
  let reloadCompleted = 0;
  let reloadInFlight: Promise<void> | undefined;

  const pendingCompanionState = new Map<string, JsonValue>();
  const unsubscribeCompanionState = input.eventBus.on(cakeCompanionStateChannel, (value) => {
    const decoded = Schema.decodeUnknownOption(cakeCompanionStatePayloadSchema)(value);
    if (Option.isNone(decoded)) return;
    const { id, state } = decoded.value;
    pendingCompanionState.set(id, state);
    const index = extensionUi.companions.findIndex((item) => item.id === id);
    const companion = extensionUi.companions[index];
    if (!companion) return;
    extensionUi.companions.splice(index, 1, { ...companion, state });
    if (!disposed) input.emitEvent({ kind: "companion-state", id, state });
  });

  let loadedExtensionPaths = resourceLoader
    .getExtensions()
    .extensions.map((extension) => extension.resolvedPath);
  const uiContext = createCakeExtensionUiContext({
    request: input.requestUi,
    state: extensionUi,
    emitState: (event) => {
      if (!disposed) input.emitEvent(event);
    },
    emitIntent: (intent) => {
      if (!disposed) input.emitExtensionUiIntent?.(intent);
    },
    addDiagnostic(method, message, stack) {
      const path = stack
        ? loadedExtensionPaths.find((extensionPath) => stack.includes(extensionPath))
        : undefined;
      const key = `${path ?? ""}:${method}:${message}`;
      if (diagnosticKeys.has(key)) return;
      diagnosticKeys.add(key);
      const diagnosticInput: ResourceDiagnostic = {
        id: `compatibility:${method}:${diagnosticKeys.size}`.slice(0, 8_192),
        severity: "warning",
        source: "compatibility",
        method: method.slice(0, 256),
        message: message.slice(0, 4_096),
      };
      if (path) Object.assign(diagnosticInput, { path: path.slice(0, 8_192) });
      const diagnostic = Schema.decodeUnknownSync(resourceDiagnosticSchema)(diagnosticInput);
      diagnostics.push(diagnostic);
      if (!disposed) input.emitEvent({ kind: "diagnostic", diagnostic });
    },
  });
  try {
    await input.session.bindExtensions({ mode: "rpc", uiContext });
  } catch (error) {
    unsubscribeCompanionState();
    loadedCompanions.dispose();
    throw error;
  }

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
          pendingCompanionState.clear();
          await input.session.reload();
          loadedExtensionPaths = resourceLoader
            .getExtensions()
            .extensions.map((extension) => extension.resolvedPath);
          const reloadedCompanions = input.loadCompanions
            ? await loadExtensionCompanions(resourceLoader)
            : { companions: [], diagnostics: [], dispose() {} };
          if (disposed) {
            reloadedCompanions.dispose();
            break;
          }
          for (const diagnostic of reloadedCompanions.diagnostics) {
            const key = `${diagnostic.path ?? ""}:${diagnostic.method ?? ""}:${diagnostic.message}`;
            if (diagnosticKeys.has(key)) continue;
            diagnosticKeys.add(key);
            diagnostics.push(diagnostic);
            if (!disposed) input.emitEvent({ kind: "diagnostic", diagnostic });
          }
          extensionUi.companions.splice(
            0,
            extensionUi.companions.length,
            ...reloadedCompanions.companions.map((companion) => ({
              ...companion,
              state: pendingCompanionState.get(companion.id) ?? companion.state,
            })),
          );
          const previousCompanions = loadedCompanions;
          loadedCompanions = reloadedCompanions;
          previousCompanions.dispose();
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
    async dispatchCompanionAction(id, action, value) {
      const companion = extensionUi.companions.find((item) => item.id === id);
      if (!companion) throw new Error(`Cake companion ${id} is not active`);
      if (!companion.actions.includes(action))
        throw new Error(`Cake companion ${id} does not declare action ${action}`);
      input.eventBus.emit(cakeCompanionActionChannel, {
        id,
        action,
        value: Schema.decodeUnknownSync(jsonValueSchema)(value),
      });
    },
    dispose() {
      disposed = true;
      unsubscribeCompanionState();
      loadedCompanions.dispose();
    },
  };
}
