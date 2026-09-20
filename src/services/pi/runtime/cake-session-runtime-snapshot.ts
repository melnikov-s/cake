import type {
  AgentSession,
  SettingsManager,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { Option, Schema } from "effect";
import type {
  CompatibilityCatalog,
  ExtensionUiState,
  ModelOption,
  PiSettings,
  ConversationSnapshot,
  UiPart,
} from "../../../ipc/session-contract";
import { piBuiltinSlashCommands, slashCommandSchema } from "../../../ipc/session-contract";
import { supportsFastMode } from "../fast-mode";
import { projectConversationDisplay } from "./conversation-display-projection";
import { projectTree } from "./session-projection";
import { projectPiSettings } from "./settings-translation";

export interface CakeSessionRuntimeSnapshotInput {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly sessionListed: boolean;
  readonly auxiliary: boolean;
  readonly session: AgentSession;
  readonly settingsManager: SettingsManager;
  readonly models: ModelOption[];
  readonly queuedParts: readonly UiPart[];
  readonly transientParts: readonly UiPart[];
  readonly fastMode: boolean;
  readonly commands: readonly SlashCommandInfo[];
  readonly slashCommands: readonly string[] | undefined;
  readonly usage: ConversationSnapshot["usage"];
  readonly compatibility: CompatibilityCatalog;
  readonly extensionUi: ExtensionUiState;
  readonly diagnostics: readonly string[];
  readonly reloadPending: boolean;
}

export function projectCakeSessionRuntimeSnapshot(
  input: CakeSessionRuntimeSnapshotInput,
): ConversationSnapshot {
  const { session, settingsManager } = input;
  const branchParts = projectConversationDisplay(session.sessionManager, {
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
      ...projectPiSettings(settingsManager, {
        autoCompact: session.autoCompactionEnabled,
        steeringMode: session.steeringMode,
        followUpMode: session.followUpMode,
      }),
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
      companions: input.extensionUi.companions?.map((companion) => ({ ...companion })) ?? [],
    },
    tree: input.auxiliary ? [] : projectTree(session.sessionManager),
  };
}
