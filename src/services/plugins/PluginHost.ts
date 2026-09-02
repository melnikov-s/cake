import { BrowserWindow, type WebContents } from "electron";
import type { BoundedCompletionInput } from "../pi/model-data";
import type { SessionSnapshot, UtilityModel } from "../../ipc/session-contract";
import type { AgentModelPreference, ResolvedAgentModel } from "../../ipc/plugin-agent-contract";
import type { CakeEvent } from "../../ipc/cake-rpc-contract";
import type { PluginPromiseOperations } from "./PluginRuntime";
import type { CakePaths } from "../../config/CakePaths";
import { PluginBuildService } from "./plugin-build-service";
import { PluginActivationService, type StartupRenderer } from "./plugin-activation-service";
import { PluginBackendManager } from "./plugin-backend-manager";
import { PluginPersistenceRepository } from "./plugin-persistence-repository";
import { PluginAgentHost, type PluginAgentDriver } from "./plugin-agent-host";
import { makePluginAgentOperations } from "./PluginAgentOperations";
import { makePluginAuthoringOperations } from "./PluginAuthoringOperations";
import type { PluginOperationContext } from "./PluginOperationContext";
import { makePluginRuntimeOperations } from "./PluginRuntimeOperations";
import type { PluginAgentResources } from "./PluginResources";
import type { CustomizationState } from "../../plugin/plugin-contract";

export interface PluginHostOptions {
  readonly paths: CakePaths;
  readonly authoringRoot: string;
  readonly applicationRoot: string;
  readonly backendHostPath: string;
  readonly utilityModel: () => UtilityModel | undefined;
  readonly completeModel: (input: BoundedCompletionInput, signal?: AbortSignal) => Promise<string>;
  readonly driver: (workingDirectory: string) => PluginAgentDriver;
  readonly resolveSessionWorkspacePath: (sessionId: string) => Promise<string>;
  readonly resolveAgentModel: (
    preference: AgentModelPreference,
    snapshot: SessionSnapshot,
    utility: UtilityModel | undefined,
  ) => ResolvedAgentModel;
  readonly requireRendererConnection: (connectionId: number) => WebContents;
  readonly isWorkingDirectoryAllowed: (workingDirectory: string) => boolean;
  readonly emitToRenderer: (owner: WebContents, event: CakeEvent) => void;
  readonly broadcast: (event: CakeEvent) => void;
  readonly publishInlineWidget: (compiled: {
    readonly token: string;
    readonly document: string;
  }) => { readonly token: string; readonly url: string };
  readonly refreshApplicationContext: () => void;
  readonly reloadAll: (renderer: StartupRenderer) => void;
  readonly reloadWindowWithFactory: (ownerId: number) => void;
  readonly resourcesChanged: (resources: PluginAgentResources) => Promise<void> | void;
  readonly customizationStateChanged: (state: CustomizationState) => void;
}

export class PluginHost {
  private readonly activation: PluginActivationService;
  private readonly backends: PluginBackendManager;
  private readonly persistence: PluginPersistenceRepository;
  private readonly agents: PluginAgentHost;
  private readonly completionControllers = new Map<string, AbortController>();
  private readonly windowRevisions = new Map<number, string>();
  private readonly healthTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private resources: PluginAgentResources = { skills: [], prompts: [], extensions: [] };

  constructor(private readonly options: PluginHostOptions) {
    this.activation = new PluginActivationService(
      options.paths,
      new PluginBuildService(options.paths, options.authoringRoot, options.applicationRoot),
    );
    this.backends = new PluginBackendManager(
      this.activation.builder,
      options.backendHostPath,
      options.broadcast,
      (pluginId, message) => void this.backendFailed(pluginId, message),
    );
    this.persistence = new PluginPersistenceRepository(
      options.paths.state,
      () => this.activation.snapshot().activeRevision,
    );
    this.agents = new PluginAgentHost({
      utilityModel: options.utilityModel,
      completeModel: options.completeModel,
      driver: options.driver,
      resolveSessionWorkspacePath: options.resolveSessionWorkspacePath,
      resolveModel: options.resolveAgentModel,
      emit: options.emitToRenderer,
    });
    const operationContext: PluginOperationContext = {
      paths: options.paths,
      activation: this.activation,
      backends: this.backends,
      persistence: this.persistence,
      agents: this.agents,
      completionControllers: this.completionControllers,
      windowRevisions: this.windowRevisions,
      healthTimers: this.healthTimers,
      resolveSessionWorkspacePath: options.resolveSessionWorkspacePath,
      isWorkingDirectoryAllowed: options.isWorkingDirectoryAllowed,
      requireRendererConnection: options.requireRendererConnection,
      applicationWindowConnection: (connectionId) => this.applicationWindowConnection(connectionId),
      publishInlineWidget: options.publishInlineWidget,
      customizationChanged: (refreshContext) => this.customizationChanged(refreshContext),
      refreshAgentResources: () => this.refreshAgentResources(),
      rebuildAfterConfigurationChange: (request) => this.rebuildAfterConfigurationChange(request),
      reloadAll: options.reloadAll,
    };
    this.operations = {
      ...makePluginAuthoringOperations(operationContext),
      ...makePluginAgentOperations(operationContext),
      ...makePluginRuntimeOperations(operationContext),
    };
  }

  get agentResources(): PluginAgentResources {
    return this.resources;
  }

  recoveryContext(): string | undefined {
    const state = this.activation.snapshot();
    if (!state.recoveryRequired && state.diagnostics.length === 0) return undefined;
    return JSON.stringify(
      {
        failedRevision: state.failedRevision,
        pendingRevision: state.pendingRevision,
        lastKnownGoodRevision: state.lastKnownGoodRevision,
        diagnostics: state.diagnostics,
      },
      null,
      2,
    );
  }

  startupRenderer(): StartupRenderer {
    return this.activation.startupRenderer();
  }

  customizationState(): CustomizationState {
    return this.activation.snapshot();
  }

  async initializeCustomization(): Promise<void> {
    await this.activation.load();
    const startupRenderer = this.activation.startupRenderer();
    if (startupRenderer.kind === "custom") {
      try {
        await this.backends.activate(startupRenderer.revision);
      } catch (error) {
        await this.activation.fail(startupRenderer.revision, {
          phase: "backend",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.refreshAgentResources();
    this.options.customizationStateChanged(this.activation.snapshot());
  }

  dispose(): void {
    this.agents.dispose();
    for (const controller of this.completionControllers.values()) controller.abort();
    this.completionControllers.clear();
    for (const timer of this.healthTimers.values()) clearTimeout(timer);
    this.healthTimers.clear();
    this.windowRevisions.clear();
    this.backends[Symbol.dispose]();
  }

  disposeOwner(ownerId: number): void {
    this.agents.disposeOwner(ownerId);
    this.windowRevisions.delete(ownerId);
    const timer = this.healthTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    this.healthTimers.delete(ownerId);
    for (const [key, controller] of this.completionControllers)
      if (key.startsWith(`${ownerId}:`)) {
        controller.abort();
        this.completionControllers.delete(key);
      }
  }

  trackRenderer(ownerId: number, renderer: StartupRenderer): void {
    const previous = this.healthTimers.get(ownerId);
    if (previous) clearTimeout(previous);
    this.healthTimers.delete(ownerId);
    if (renderer.kind === "factory") {
      this.windowRevisions.delete(ownerId);
      return;
    }
    this.windowRevisions.set(ownerId, renderer.revision);
    this.healthTimers.set(
      ownerId,
      setTimeout(() => {
        if (this.windowRevisions.get(ownerId) !== renderer.revision) return;
        void this.activation
          .fail(renderer.revision, {
            phase: "render",
            message: "The custom interface did not finish loading within 10 seconds.",
          })
          .then(() => {
            this.customizationChanged(true);
            this.options.reloadWindowWithFactory(ownerId);
          });
      }, 10_000),
    );
  }

  rendererProcessGone(ownerId: number, reason: string): void {
    const revision = this.windowRevisions.get(ownerId);
    if (!revision) return;
    const timer = this.healthTimers.get(ownerId);
    if (timer) clearTimeout(timer);
    this.healthTimers.delete(ownerId);
    void this.activation
      .fail(revision, {
        phase: "runtime",
        message: `Customization renderer process exited: ${reason}.`,
      })
      .then(() => {
        this.customizationChanged(true);
        this.options.reloadWindowWithFactory(ownerId);
      });
  }

  readonly operations: PluginPromiseOperations;

  private applicationWindowConnection(connectionId: number): WebContents {
    const sender = this.options.requireRendererConnection(connectionId);
    if (!BrowserWindow.fromWebContents(sender))
      throw new Error("Plugin agents require an application window");
    return sender;
  }

  private customizationChanged(refreshContext: boolean): void {
    if (refreshContext) this.options.refreshApplicationContext();
    this.options.customizationStateChanged(this.activation.snapshot());
  }

  private async refreshAgentResources(): Promise<void> {
    this.resources = (await this.activation.builder.repository.inspect()).agentResources;
    await this.options.resourcesChanged(this.resources);
  }

  private async rebuildAfterConfigurationChange(request: string): Promise<void> {
    await this.backends.stop();
    const candidate = await this.activation.validate(undefined, request);
    if (candidate.diagnostics.length > 0) {
      await this.activation.recoverFromRejected(candidate.revision);
      this.customizationChanged(true);
      this.options.reloadAll({ kind: "factory" });
      return;
    }
    const activation = await this.activation.activateValidated(
      candidate.revision,
      candidate.sourceRevision,
      request,
    );
    try {
      await this.backends.activate(candidate.revision);
    } catch (error) {
      await this.activation.fail(candidate.revision, {
        phase: "backend",
        message: error instanceof Error ? error.message : String(error),
      });
      this.customizationChanged(true);
      this.options.reloadAll({ kind: "factory" });
      return;
    }
    this.customizationChanged(false);
    this.options.reloadAll({
      kind: "custom",
      revision: candidate.revision,
      path: activation.indexHtml,
    });
  }

  private async backendFailed(pluginId: string, message: string): Promise<void> {
    const revision = this.activation.snapshot().activeRevision;
    await this.activation.fail(revision, { phase: "backend", pluginId, message });
    await this.backends.stop();
    this.customizationChanged(true);
    this.options.reloadAll({ kind: "factory" });
  }
}
