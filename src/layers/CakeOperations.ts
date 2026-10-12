import type { CakeModelSelection } from "../contracts/model-presets/cake-model-selection";
import type { CakeOperationDefinition } from "../services/pi/runtime/cake-operation-registry";
import type { CakeSessionRuntimeOptions } from "../services/pi/runtime/cake-session-runtime";
import { createCakeSettingsOperations } from "../domain/application/cake-settings-operations";
import { createCakeWorkflowOperations } from "../domain/workflows/cake-workflow-operations";
import { createSessionApplicationOperations } from "../domain/application/cake-session-application-operations";
import { createAgentProjectSettingsOperations } from "../domain/projects/cake-project-settings-operations";
import { createConversationOperations } from "../domain/conversations/cake-conversation-operations";
import { createSessionFamilyOperations } from "../domain/session-families/cake-session-family-operations";
import { createScheduledMessageOperations } from "../domain/scheduled-messages/cake-scheduled-message-operations";
import { createSessionWorktreeOperations } from "../domain/worktrees/cake-session-worktree-operations";
import { Schema } from "effect";
import type { CakeOperationProviders } from "../services/pi/runtime/cake-operation-providers";
import {
  artifactRecordSchema,
  type CakeArtifactV1,
} from "../contracts/artifacts/artifact-contract";
import { createProjectSessionOperations } from "../domain/project-sessions/cake-session-operations";
import { createGlobalControlOperations } from "../domain/application/cake-global-control-operations";
import { createAgentControlOperations } from "../domain/subagents/cake-subagent-operations";
import { createCoordinatorOperations } from "../domain/cake-chats/cake-coordinator-operations";
import { createCakeArtifactOperations } from "../domain/artifacts/cake-artifact-operations";
import { createCakeBrowserOperations } from "../domain/browser/cake-browser-operations";
import { createCakeDrawOperations } from "../domain/draw/cake-draw-operations";
import { createCakeInterviewOperations } from "../domain/interviews/cake-interview-operations";
import { createMessageBoardOperations } from "../domain/artifacts/cake-message-board-operations";
import { createCakeModelOperations } from "../domain/model-presets/cake-model-operations";
import { createCakeNonChatModelOperations } from "../domain/model-preferences/cake-non-chat-model-operations";
import { createCakeSessionPluginOperations } from "../domain/session-plugins/cake-session-plugin-operations";
import { createCakeWorktreeOperations } from "../domain/worktrees/cake-worktree-operations";
import { createCakeVscodeOperations } from "../domain/editor/cake-vscode-operations";

const filterProjectSessionOperations = (
  definitions: CakeOperationDefinition[],
  options: CakeSessionRuntimeOptions,
) =>
  definitions.filter(
    (operation) =>
      (operation.command !== "session.resolve" ||
        (options.currentSessionControl !== undefined &&
          options.currentSessionControl.canResolve?.() !== false)) &&
      (!["session.merge", "sessions.merge"].includes(operation.command) ||
        options.currentSessionControl?.mergeSession !== undefined) &&
      (!["session.discard", "sessions.discard"].includes(operation.command) ||
        options.currentSessionControl?.discardSession !== undefined) &&
      (!(
        [
          "app.state",
          "app.user-selection",
          "app.split",
          "settings.sections",
          "settings.get",
          "settings.update",
          "project.settings.get",
          "project.settings.update",
          "notifications.send",
        ].includes(operation.command) || operation.command.startsWith("session-labels.")
      ) ||
        options.currentSessionControl?.invokeAppControl !== undefined) &&
      (operation.command !== "session.create" ||
        options.currentSessionControl?.createSession !== undefined) &&
      (operation.command !== "session.create-draft" ||
        options.currentSessionControl?.createDraftSession !== undefined) &&
      (operation.command !== "session.fork" ||
        options.currentSessionControl?.forkSession !== undefined) &&
      (operation.command !== "sessions.create-child" ||
        options.currentSessionControl?.createChildSession !== undefined) &&
      (!operation.command.startsWith("sessions.") ||
        operation.command === "sessions.create-child" ||
        options.currentSessionControl?.invokeAppControl !== undefined),
  );

export const cakeOperationProviders: CakeOperationProviders = {
  project(options, bridge) {
    // Capture a lazy resolver: the SDK loads extensions before the session API is ready.
    const resolveApiModel = (selection: CakeModelSelection | undefined) =>
      bridge.api().resolveModelSelection(selection);
    const persistArtifact =
      options.persistArtifact ??
      (async (artifact: CakeArtifactV1) =>
        Schema.decodeUnknownSync(artifactRecordSchema)({
          artifact,
          workspacePath: options.cwd,
          digest: "0".repeat(64),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
    const configuredDrawControl = options.drawControl;
    const drawControl = configuredDrawControl
      ? {
          ...configuredDrawControl,
          canMutate: () =>
            configuredDrawControl.canMutate() &&
            !(options.currentSessionControl?.resolved() ?? false),
        }
      : undefined;
    const readOnlyAuxiliary =
      Boolean(options.auxiliary) &&
      !(options.tools ?? []).some((tool) => tool === "bash" || tool === "edit" || tool === "write");
    const definitions = [
      ...filterProjectSessionOperations(
        [
          ...(options.workflowControl ? createCakeWorkflowOperations(options.workflowControl) : []),
          ...(!options.auxiliary &&
          options.tools === undefined &&
          options.currentSessionControl?.invokeAppControl
            ? createCakeSettingsOperations((command, input, signal) =>
                bridge.api().invokeAppControl(command, input, signal),
              )
            : []),
          ...createProjectSessionOperations(bridge.api),
          ...createSessionApplicationOperations(bridge.api),
          ...createAgentProjectSettingsOperations(bridge.api),
          ...createConversationOperations(bridge.api),
          ...createSessionFamilyOperations(bridge.api),
          ...createScheduledMessageOperations(bridge.api),
          ...createSessionWorktreeOperations(bridge.api),
        ],
        options,
      ),
      ...(!options.auxiliary && options.tools === undefined && options.nonChatModelPreferences
        ? createCakeNonChatModelOperations(options.nonChatModelPreferences, {
            getAvailableOfType: bridge.getAvailableOfType,
          })
        : []),
      ...(options.modelPresets ? createCakeModelOperations(options.modelPresets) : []),
      ...(options.sessionPluginControl && options.generateInlineWidget
        ? createCakeSessionPluginOperations({
            ...options.sessionPluginControl,
            generate: options.generateInlineWidget,
          })
        : []),
      ...createCakeArtifactOperations(bridge.host, { ...options, persistArtifact }),
      ...(options.messageBoardControl
        ? createMessageBoardOperations(options.messageBoardControl)
        : []),
      ...createCakeInterviewOperations(bridge.host, {
        requestInterview: options.requestInterview ?? (async () => undefined),
      }),
      ...(options.vscodeControl ? createCakeVscodeOperations(options.vscodeControl) : []),
      ...(options.browserControl ? createCakeBrowserOperations(options.browserControl) : []),
      ...(drawControl ? createCakeDrawOperations(drawControl) : []),
      ...(options.worktreeLandingControl
        ? createCakeWorktreeOperations(options.worktreeLandingControl)
        : []),
      ...(options.agentControl
        ? createAgentControlOperations(options.agentControl, bridge.sessionId, resolveApiModel)
        : []),
    ].filter(
      (definition) =>
        (!options.allowedCakeOperations ||
          options.allowedCakeOperations.includes(definition.command)) &&
        (!readOnlyAuxiliary ||
          ["session.info", "session.usage", "context.status"].includes(definition.command)),
    );
    // An explicitly granted parent control gateway retains its separate authority.
    return [
      ...definitions,
      ...(options.sessionControl
        ? createGlobalControlOperations(options.sessionControl, resolveApiModel)
        : []),
    ];
  },
  coordinator(options, bridge) {
    if (!options.globalControl) throw new Error("The coordinator control is unavailable");
    return [
      ...createGlobalControlOperations(options.globalControl, bridge.resolveModel),
      ...createCakeModelOperations(options.modelPresets ?? (() => ({ presets: [] }))),
      ...(options.agentControl
        ? createAgentControlOperations(
            options.agentControl,
            () => bridge.sessionId,
            bridge.resolveModel,
            true,
          )
        : []),
      ...createCoordinatorOperations(bridge),
    ].filter(
      (operation) =>
        !options.allowedCakeOperations || options.allowedCakeOperations.includes(operation.command),
    );
  },
};
