import { Schema } from "effect";
import { applySnapshot, batch, toSnapshot, type Snapshot } from "r-state-tree";
import type { CakeChatUpdate } from "../../domain/cake-chats/cake-chat-data";
import type {
  ConversationEvent,
  ConversationSnapshot,
} from "../../domain/conversations/conversation-data";
import type { ProjectSessionUpdate } from "../../domain/project-sessions/project-session-data";
import {
  extensionUiEventSchema,
  sessionUsageSchema,
  sessionSnapshotSchema,
  type SessionSnapshot,
  uiPartSchema,
} from "../../ipc/session-contract";
import { projectionId } from "../../utils/projection-id";
import { modelOptionKey } from "../../utils/model-option-key";
import { artifactSnapshot } from "./ArtifactReducer";
import type { Session } from "../models/Session";
import { applyConversationCatalog } from "./ConversationCatalogReducer";
import { applyPartUpdate, messageSnapshots, removePart } from "./SessionPartReducer";

export function applyProjectSessionUpdate(
  model: Session,
  sessionId: string,
  update: ProjectSessionUpdate,
) {
  if (update._tag === "Snapshot") {
    if (
      update.snapshot.identity._tag !== "ProjectSession" ||
      update.snapshot.identity.sessionId !== sessionId
    )
      throw new Error(`Project Session identity collision: ${sessionId}`);
    applyConversationSnapshot(model, update.snapshot.conversation, false);
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Project Session event identity collision: ${sessionId}`);
  applyConversationEvent(model, update.event);
}

export function applyCakeChatUpdate(model: Session, sessionId: string, update: CakeChatUpdate) {
  if (update._tag === "Snapshot") {
    if (
      update.snapshot.identity._tag !== "CakeChatSession" ||
      update.snapshot.identity.sessionId !== sessionId
    )
      throw new Error(`Cake Chat identity collision: ${sessionId}`);
    applyConversationSnapshot(model, update.snapshot.conversation, false);
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Cake Chat event identity collision: ${sessionId}`);
  const event = update.event;
  if (event._tag === "ControlRequested") {
    if (
      !model.controlRequests.some((request) => request.controlRequestId === event.controlRequestId)
    )
      model.controlRequests.push(event);
    return;
  }
  applyConversationEvent(model, event);
}

export function applyConversationSnapshot(
  model: Session,
  conversation: ConversationSnapshot,
  preserveActiveTurns = false,
) {
  const current = toSnapshot(model);
  const parsed = Schema.decodeUnknownSync(sessionSnapshotSchema)({
    ...conversation,
    workspacePath: conversation.workingDirectory,
  });
  const authoritative = sessionSnapshot(parsed);
  batch(() => {
    applyConversationCatalog(model, parsed);
    applySnapshot(model, {
      ...authoritative,
      activeTurnIds: preserveActiveTurns ? current.activeTurnIds : [],
      reviewThreads: current.reviewThreads,
      subagentActivities: current.subagentActivities,
      scheduledMessages: current.scheduledMessages,
      releasedSubagentHandleIds: current.releasedSubagentHandleIds,
      backgroundWorkActive: current.backgroundWorkActive,
      controlRequests: current.controlRequests,
      extensionUi: {
        ...authoritative.extensionUi,
        compatibilityDiagnostics: current.extensionUi?.compatibilityDiagnostics ?? [],
      },
    });
  });
}

function applyConversationEvent(model: Session, event: ConversationEvent) {
  if (event._tag === "SnapshotUpdated") {
    applyConversationSnapshot(model, event.snapshot, true);
    return;
  }
  batch(() => {
    if (event._tag === "PartUpdated")
      applyPartUpdate(
        model.parts,
        Schema.decodeUnknownSync(uiPartSchema)(event.part),
        model.sessionId,
      );
    else if (event._tag === "PartRemoved") removePart(model.parts, event.partId);
    else if (event._tag === "StreamingChanged") model.streaming = event.streaming;
    else if (event._tag === "UsageUpdated")
      model.usage = Schema.decodeUnknownSync(sessionUsageSchema)(event.usage);
    else if (event._tag === "TurnAccepted") {
      // Follow-ups are queued input, not active work. Pi's streaming projection
      // becomes authoritative if and when it starts processing one.
      if (event.delivery !== "follow-up" && !model.activeTurnIds.includes(event.turnId))
        model.activeTurnIds.push(event.turnId);
    } else if (event._tag === "TurnSettled") {
      const index = model.activeTurnIds.indexOf(event.turnId);
      if (index >= 0) model.activeTurnIds.splice(index, 1);
      const previous = model.settledTurns.findIndex((turn) => turn.turnId === event.turnId);
      if (previous >= 0) model.settledTurns.splice(previous, 1);
      model.settledTurns.push({ turnId: event.turnId, outcome: event.outcome });
      if (model.settledTurns.length > 100) model.settledTurns.splice(0, 1);
      model.settledTurnRevision += 1;
    } else if (event._tag === "ExtensionUi")
      applyExtensionUiEvent(model, Schema.decodeUnknownSync(extensionUiEventSchema)(event.event));
  });
}

function applyExtensionUiEvent(model: Session, event: typeof extensionUiEventSchema.Type): void {
  const extensionUi = model.extensionUi;
  if (event.kind === "status") {
    const existing = extensionUi.statuses.findIndex((item) => item.key === event.key);
    if (existing >= 0) extensionUi.statuses.splice(existing, 1);
    if (event.text !== undefined) extensionUi.statuses.push({ key: event.key, text: event.text });
    return;
  }
  if (event.kind === "title") {
    extensionUi.title = event.title;
    return;
  }
  if (!extensionUi.compatibilityDiagnostics.some((item) => item.id === event.diagnostic.id))
    extensionUi.compatibilityDiagnostics.push(event.diagnostic);
}

function sessionSnapshot(parsed: SessionSnapshot): Snapshot<Session> {
  return {
    workingDirectory: parsed.workspacePath,
    sessionId: parsed.sessionId,
    sessionFile: parsed.sessionFile,
    parts: messageSnapshots(parsed.parts, parsed.sessionId),
    model: parsed.model ? { id: modelOptionKey(parsed.model) } : undefined,
    fastMode: parsed.fastMode ?? false,
    fastModeAvailable: parsed.fastModeAvailable ?? false,
    modelOptions: parsed.models.map(({ provider, id, ...option }) => ({
      ...option,
      id: projectionId(parsed.sessionId, modelOptionKey({ provider, id })),
      llmModel: { id: modelOptionKey({ provider, id }) },
    })),
    thinkingLevel: parsed.thinkingLevel,
    availableThinkingLevels: [...parsed.availableThinkingLevels],
    piSettings: parsed.piSettings,
    streaming: parsed.streaming,
    activeTurnIds: [],
    diagnostics: [...parsed.diagnostics],
    commands: parsed.commands.map((command) => ({ ...command })),
    usage: parsed.usage,
    resources: parsed.compatibility.resources.map((resource) => ({
      id: projectionId(parsed.sessionId, resource.id),
      resource: { id: resource.id },
      name: resource.name,
      description: resource.description,
      source: resource.source,
      scope: resource.scope,
      origin: resource.origin,
      enabled: resource.enabled,
      commands: [...resource.commands],
      tools: [...resource.tools],
    })),
    resourceDiagnostics: parsed.compatibility.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      diagnosticKey: diagnostic.id,
      id: projectionId(parsed.sessionId, diagnostic.id),
    })),
    tree: parsed.tree.map(({ id, parentId, ...entry }) => ({
      ...entry,
      piId: id,
      parentPiId: parentId,
      id: projectionId(parsed.sessionId, id),
    })),
    artifacts: (parsed.artifacts ?? []).map(artifactSnapshot),
    extensionUi: {
      title: parsed.extensionUi.title,
      statuses: parsed.extensionUi.statuses.map((status) => ({ ...status })),
      compatibilityDiagnostics: [],
    },
  };
}
