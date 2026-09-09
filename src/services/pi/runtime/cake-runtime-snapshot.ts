import type {
  AgentSession,
  SettingsManager,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type { ArtifactRecord } from "../../../ipc/artifact-contract";
import type {
  CompatibilityCatalog,
  ExtensionUiState,
  ModelOption,
  PiSettings,
  SessionSnapshot,
  UiPart,
} from "../../../ipc/session-contract";
import { piBuiltinSlashCommands, slashCommandSchema } from "../../../ipc/session-contract";
import { supportsFastMode } from "../fast-mode";
import { projectSessionEntries, projectTree } from "./session-projection";

export interface CakeRuntimeSnapshotInput {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly sessionListed: boolean;
  readonly auxiliary: boolean;
  readonly session: AgentSession;
  readonly settingsManager: SettingsManager;
  readonly models: ModelOption[];
  readonly artifacts: ArtifactRecord[];
  readonly queuedParts: readonly UiPart[];
  readonly transientParts: readonly UiPart[];
  readonly fastMode: boolean;
  readonly commands: readonly SlashCommandInfo[];
  readonly slashCommands: readonly string[] | undefined;
  readonly usage: SessionSnapshot["usage"];
  readonly compatibility: CompatibilityCatalog;
  readonly extensionUi: ExtensionUiState;
  readonly diagnostics: readonly string[];
  readonly reloadPending: boolean;
}

export function projectCakeRuntimeSnapshot(input: CakeRuntimeSnapshotInput): SessionSnapshot {
  const { session, settingsManager } = input;
  const globalSettings = settingsManager.getGlobalSettings();
  const branchParts = projectSessionEntries(session.sessionManager.getBranch(), undefined, {
    live: session.isStreaming,
  });
  return {
    workspacePath: input.workspacePath,
    sessionId: input.sessionId,
    sessionFile: session.sessionFile ?? "",
    sessionListed: input.sessionListed,
    parts: [...branchParts, ...input.queuedParts, ...input.transientParts],
    model: session.model
      ? { provider: session.model.provider, id: session.model.id, name: session.model.name }
      : undefined,
    fastMode: input.fastMode,
    fastModeAvailable: supportsFastMode(session.model),
    models: input.models,
    thinkingLevel: session.thinkingLevel,
    availableThinkingLevels: session.getAvailableThinkingLevels(),
    piSettings: {
      defaultProvider: settingsManager.getDefaultProvider(),
      defaultModel: settingsManager.getDefaultModel(),
      defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
      autoCompact: session.autoCompactionEnabled,
      autoResizeImages: settingsManager.getImageAutoResize(),
      blockImages: settingsManager.getBlockImages(),
      enableSkillCommands: settingsManager.getEnableSkillCommands(),
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      transport: settingsManager.getTransport(),
      httpIdleTimeoutMs: settingsManager.getHttpIdleTimeoutMs(),
      hideThinkingBlock: settingsManager.getHideThinkingBlock(),
      mermaidRenderingMode: settingsManager.getMermaidRenderingMode(),
      showCacheMissNotices: settingsManager.getShowCacheMissNotices(),
      collapseChangelog: settingsManager.getCollapseChangelog(),
      quietStartup: settingsManager.getQuietStartup(),
      enableInstallTelemetry: settingsManager.getEnableInstallTelemetry(),
      defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
      doubleEscapeAction: settingsManager.getDoubleEscapeAction(),
      treeFilterMode: settingsManager.getTreeFilterMode(),
      anthropicExtraUsageWarning: settingsManager.getWarnings().anthropicExtraUsage ?? true,
      retryEnabled: globalSettings.retry?.enabled ?? true,
      shellPath: globalSettings.shellPath ?? "",
      shellCommandPrefix: globalSettings.shellCommandPrefix ?? "",
      npmCommand: globalSettings.npmCommand ?? [],
      packages: globalSettings.packages ?? [],
      extensions: globalSettings.extensions ?? [],
      skills: globalSettings.skills ?? [],
      prompts: globalSettings.prompts ?? [],
      reloadPending: input.reloadPending,
    } satisfies PiSettings,
    streaming: session.isStreaming,
    diagnostics: [...input.diagnostics],
    commands: input.auxiliary
      ? []
      : [
          ...piBuiltinSlashCommands.filter(
            (command) => !input.slashCommands || input.slashCommands.includes(command.name),
          ),
          ...input.commands,
        ].flatMap((command) => {
          const parsed = Schema.decodeUnknownOption(slashCommandSchema)(command);
          return Option.isSome(parsed) ? [parsed.value] : [];
        }),
    usage: input.usage,
    compatibility: input.compatibility,
    extensionUi: {
      title: input.extensionUi.title,
      statuses: input.extensionUi.statuses.map((status) => ({ ...status })),
    },
    tree: input.auxiliary ? [] : projectTree(session.sessionManager),
    artifacts: input.artifacts,
  };
}
