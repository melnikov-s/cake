import { createMessageOperations } from "../domain/conversations/cake-message-operations";
import { createAttachmentReferenceOperations } from "../domain/conversations/cake-attachment-operations";
import type {
  CakeModelSelection,
  CakeModelLaunch,
} from "../contracts/model-presets/cake-model-selection";
import { createCakeSettingsOperations } from "../domain/application/cake-settings-operations";
import { createCakeWidgetPackageOperations } from "../domain/application/cake-widget-package-operations";
import { createCakeWorkflowOperations } from "../domain/workflows/cake-workflow-operations";
import { createSessionApplicationOperations } from "../domain/application/cake-session-application-operations";
import { createAgentProjectSettingsOperations } from "../domain/projects/cake-project-settings-operations";
import { createConversationOperations } from "../domain/conversations/cake-conversation-operations";
import { createSessionFamilyOperations } from "../domain/session-families/cake-session-family-operations";
import { createScheduledMessageOperations } from "../domain/scheduled-messages/cake-scheduled-message-operations";
import {
  createCakeChatWorktreeOperations,
  createSessionWorktreeOperations,
} from "../domain/worktrees/cake-session-worktree-operations";
import { Schema } from "effect";
import type {
  ProjectCakeOperations,
  CoordinatorCakeOperations,
} from "../contracts/agent/cake-operation-api";
import type { CakeOperationOptions } from "../contracts/agent/cake-operation-options";
import {
  createCakeSessionRuntime,
  type CakeSessionRuntimeOptions,
} from "../services/pi/runtime/cake-session-runtime";
import { createDurableCakeChatRuntime } from "../services/pi-durable/durable-chat-runtime";
import type { RequestInspection } from "../services/pi-durable/request-inspection";
import type { CakeSessionRuntimeSetup } from "../services/pi/CakeSessionRuntimes";
import {
  artifactRecordSchema,
  type CakeArtifactV1,
} from "../contracts/artifacts/artifact-contract";
import { createProjectSessionOperations } from "../domain/project-sessions/cake-session-operations";
import { createGlobalControlOperations } from "../domain/application/cake-global-control-operations";
import { createAgentControlOperations } from "../domain/subagents/cake-subagent-operations";
import { createCoordinatorOperations } from "../domain/cake-chats/cake-coordinator-operations";
import { createCakeChatInstructionOperations } from "../domain/cake-chats/cake-chat-instruction-operations";
import { createCakeChatProjectOperations } from "../domain/projects/cake-chat-project-operations";
import { createCakeArtifactOperations } from "../domain/artifacts/cake-artifact-operations";
import { createCakeBrowserOperations } from "../domain/browser/cake-browser-operations";
import { createCakeInterviewOperations } from "../domain/interviews/cake-interview-operations";
import { createMessageBoardOperations } from "../domain/artifacts/cake-message-board-operations";
import { createCakeModelOperations } from "../domain/model-presets/cake-model-operations";
import { createCakeNonChatModelOperations } from "../domain/model-preferences/cake-non-chat-model-operations";
import { createCakeSessionPluginOperations } from "../domain/session-plugins/cake-session-plugin-operations";
import { createCakeWorktreeOperations } from "../domain/worktrees/cake-worktree-operations";
import { createCakeVscodeOperations } from "../domain/editor/cake-vscode-operations";

export function projectCakeOperations(options: CakeOperationOptions): ProjectCakeOperations {
  return (bridge) => {
    // Capture a lazy resolver: the SDK loads extensions before the session API is ready.
    const resolveApiModel = (selection: CakeModelSelection | undefined, launch?: CakeModelLaunch) =>
      bridge.api().resolveModelSelection(selection, launch);
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
    const readOnlyAuxiliary =
      Boolean(options.auxiliary) &&
      !(options.tools ?? []).some((tool) => tool === "bash" || tool === "edit" || tool === "write");
    const control = options.currentSessionControl;
    const capabilities = {
      ...control,
      setResolved: control?.canResolve?.() === false ? undefined : control?.setResolved,
    };
    const definitions = [
      ...(options.messageReferenceControl
        ? createMessageOperations(options.messageReferenceControl)
        : []),
      ...(options.attachmentReferenceControl
        ? createAttachmentReferenceOperations(options.attachmentReferenceControl)
        : []),
      ...(options.workflowControl ? createCakeWorkflowOperations(options.workflowControl) : []),
      ...(!options.auxiliary && options.tools === undefined
        ? createCakeSettingsOperations((command, input, signal) =>
            bridge.api().invokeAppControl(command, input, signal),
          )
        : []),
      ...(!options.auxiliary && options.tools === undefined
        ? createCakeWidgetPackageOperations((command, input, signal) =>
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
        requestInterview: options.requestInterview
          ? async (record, signal) => {
              // Publish Pi-owned interview metadata before requesting the answer.
              await bridge.publishSnapshot();
              return options.requestInterview?.(record, signal);
            }
          : async () => undefined,
      }),
      ...(options.vscodeControl ? createCakeVscodeOperations(options.vscodeControl) : []),
      ...(options.browserControl ? createCakeBrowserOperations(options.browserControl) : []),
      ...(options.worktreeLandingControl
        ? createCakeWorktreeOperations(options.worktreeLandingControl)
        : []),
      ...(options.agentControl
        ? createAgentControlOperations(options.agentControl, bridge.sessionId, resolveApiModel)
        : []),
    ].filter(
      (definition) =>
        (definition.requires === undefined || capabilities[definition.requires] !== undefined) &&
        (!options.allowedCakeOperations ||
          options.allowedCakeOperations.includes(definition.command)) &&
        (!readOnlyAuxiliary ||
          [
            "session.info",
            "session.usage",
            "context.status",
            "attachments.list",
            "attachments.read",
            "messages.list",
            "messages.read",
          ].includes(definition.command)),
    );
    // An explicitly granted parent control gateway retains its separate authority.
    return [
      ...definitions,
      ...(options.sessionControl
        ? createGlobalControlOperations(options.sessionControl, resolveApiModel)
        : []),
    ];
  };
}

export function coordinatorCakeOperations(
  options: CakeOperationOptions,
): CoordinatorCakeOperations {
  const control = options.globalControl;
  if (!control) throw new Error("The coordinator control is unavailable");
  return (bridge) => {
    return [
      ...createGlobalControlOperations(control, bridge.resolveModel),
      ...(options.messageReferenceControl
        ? createMessageOperations(options.messageReferenceControl)
        : []),
      ...(options.attachmentReferenceControl
        ? createAttachmentReferenceOperations(options.attachmentReferenceControl)
        : []),
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
      ...createCakeArtifactOperations(
        { appendEntry: () => undefined },
        {
          ...options,
          persistArtifact: async () => {
            throw new Error("Artifact publication is unavailable in Cake Chat");
          },
        },
      ).filter((operation) =>
        [
          "artifacts.link",
          "artifacts.state.read",
          "artifacts.selection.capture",
          "artifacts.source",
        ].includes(operation.command),
      ),
      ...(options.browserControl ? createCakeBrowserOperations(options.browserControl) : []),
      ...(options.vscodeControl ? createCakeVscodeOperations(options.vscodeControl) : []),
      ...(options.cakeChatInstructions
        ? createCakeChatInstructionOperations(options.cakeChatInstructions)
        : []),
      ...(options.cakeChatWorktrees
        ? createCakeChatWorktreeOperations(options.cakeChatWorktrees)
        : []),
      ...(options.cakeChatProjects
        ? createCakeChatProjectOperations(options.cakeChatProjects)
        : []),
    ].filter(
      (operation) =>
        !options.allowedCakeOperations || options.allowedCakeOperations.includes(operation.command),
    );
  };
}

export const createProjectSessionRuntime = (options: CakeSessionRuntimeSetup) =>
  createCakeSessionRuntime(configureCakeSessionRuntime(options));

export const createCoordinatorRuntime = (
  options: CakeSessionRuntimeSetup,
  inspection?: RequestInspection,
) => createDurableCakeChatRuntime(configureCakeSessionRuntime(options), inspection);

/** Consume feature controls at composition, never forward their bundle into Pi. */
export function configureCakeSessionRuntime(
  options: CakeSessionRuntimeSetup,
): CakeSessionRuntimeOptions {
  const {
    messageReferenceControl,
    attachmentReferenceControl,
    allowedCakeOperations,
    workflowControl,
    requestInterview,
    sessionPluginControl,
    modelPresets,
    nonChatModelPreferences,
    vscodeControl,
    browserControl,
    worktreeLandingControl,
    globalControl,
    cakeChatInstructions,
    cakeChatWorktrees,
    cakeChatProjects,
    sessionControl,
    agentControl,
    generateInlineWidget,
    reviseInlineWidget,
    resolveArtifact,
    hasLinkedArtifacts,
    listArtifactMetadata,
    historyArtifact,
    restoreArtifact,
    linkArtifact,
    unlinkArtifact,
    importArtifactFile,
    readArtifactState,
    replaceArtifactState,
    updateArtifactState,
    ...runtime
  } = options;
  const featureOptions: CakeOperationOptions = {
    messageReferenceControl,
    attachmentReferenceControl,
    cwd: runtime.cwd,
    tools: runtime.tools,
    auxiliary: runtime.auxiliary,
    currentSessionControl: runtime.currentSessionControl,
    persistArtifact: runtime.persistArtifact,
    messageBoardControl: runtime.messageBoardControl,
    allowedCakeOperations,
    workflowControl,
    requestInterview,
    sessionPluginControl,
    modelPresets,
    nonChatModelPreferences,
    vscodeControl,
    browserControl,
    worktreeLandingControl,
    globalControl,
    cakeChatInstructions,
    cakeChatWorktrees,
    cakeChatProjects,
    sessionControl,
    agentControl,
    generateInlineWidget,
    reviseInlineWidget,
    resolveArtifact,
    hasLinkedArtifacts,
    listArtifactMetadata,
    historyArtifact,
    restoreArtifact,
    linkArtifact,
    unlinkArtifact,
    importArtifactFile,
    readArtifactState,
    replaceArtifactState,
    updateArtifactState,
  };
  return {
    ...runtime,
    operations: globalControl ? undefined : projectCakeOperations(featureOptions),
    coordinator: globalControl
      ? { operations: coordinatorCakeOperations(featureOptions), modelPresets }
      : undefined,
    partialPricingCoverage: agentControl !== undefined,
  };
}
