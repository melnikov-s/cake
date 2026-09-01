import type { WebContents } from "electron";
import type { CakePaths } from "../../config/CakePaths";
import type { StartupRenderer, PluginActivationService } from "./plugin-activation-service";
import type { PluginAgentHost } from "./plugin-agent-host";
import type { PluginBackendManager } from "./plugin-backend-manager";
import type { PluginPersistenceRepository } from "./plugin-persistence-repository";

export interface PluginOperationContext {
  readonly paths: CakePaths;
  readonly activation: PluginActivationService;
  readonly backends: PluginBackendManager;
  readonly persistence: PluginPersistenceRepository;
  readonly agents: PluginAgentHost;
  readonly completionControllers: Map<string, AbortController>;
  readonly windowRevisions: Map<number, string>;
  readonly healthTimers: Map<number, ReturnType<typeof setTimeout>>;
  readonly resolveSessionWorkspacePath: (sessionId: string) => Promise<string>;
  readonly isWorkingDirectoryAllowed: (workingDirectory: string) => boolean;
  readonly requireRendererConnection: (connectionId: number) => WebContents;
  readonly applicationWindowConnection: (connectionId: number) => WebContents;
  readonly publishInlineWidget: (compiled: {
    readonly token: string;
    readonly document: string;
  }) => { readonly token: string; readonly url: string };
  readonly customizationChanged: (refreshApplicationContext: boolean) => void;
  readonly refreshAgentResources: () => Promise<void>;
  readonly rebuildAfterConfigurationChange: (request: string) => Promise<void>;
  readonly reloadAll: (renderer: StartupRenderer) => void;
}
