import { Schema } from "effect";
import { applySnapshot, batch, toSnapshot, type Snapshot } from "r-state-tree";
import type {
  ConversationEvent,
  ConversationSnapshot,
  ConversationUpdate,
} from "../../domain/conversations/conversation-data";
import type { DiscussionSessionUpdate } from "../../domain/discussion-sessions/discussion-session-data";
import {
  extensionUiEventSchema,
  sessionUsageSchema,
  conversationSnapshotSchema,
  type ConversationSnapshot as RuntimeConversationSnapshot,
  uiPartSchema,
} from "../../ipc/session-contract";
import { projectionId } from "../../utils/projection-id";
import { modelOptionKey } from "../../utils/model-option-key";
import type { Conversation } from "../models/Conversation";
import { applyConversationCatalog } from "./ConversationCatalogReducer";
import { applyPartUpdate, messageSnapshots, removePart } from "./SessionPartReducer";

export function applyConversationUpdate(model: Conversation, update: ConversationUpdate) {
  if (update._tag === "Snapshot") {
    batch(() => {
      applyConversationSnapshot(model, update.snapshot, false);
      model.observedSnapshotRevision += 1;
    });
    return;
  }
  if (update.event._tag !== "SnapshotUpdated" && update.event.sessionId !== model.sessionId)
    throw new Error(`Conversation event identity collision: ${model.sessionId}`);
  applyConversationEvent(model, update.event);
}

export function unloadConversationProjection(model: Conversation) {
  batch(() => {
    applySnapshot(model, {
      sessionFile: "",
      parts: [],
      model: undefined,
      fastMode: false,
      fastModeAvailable: false,
      modelOptions: [],
      thinkingLevel: "off",
      availableThinkingLevels: [],
      piSettings: undefined,
      streaming: false,
      activeTurnIds: [],
      diagnostics: [],
      commands: [],
      usage: undefined,
      resources: [],
      resourceDiagnostics: [],
      tree: [],
      extensionUi: { statuses: [], compatibilityDiagnostics: [] },
    });
    model.observedSnapshotRevision = 0;
    model.settledTurnRevision = 0;
    model.settledTurns.splice(0);
  });
}

/** Applies one Discussion Session sidecar observation to its own `Conversation` Model. */
export function applyDiscussionSessionUpdate(
  model: Conversation,
  sessionId: string,
  update: DiscussionSessionUpdate,
) {
  if (update._tag === "Snapshot") {
    if (
      update.snapshot.identity._tag !== "DiscussionSession" ||
      update.snapshot.identity.sessionId !== sessionId
    )
      throw new Error(`Discussion Session identity collision: ${sessionId}`);
    batch(() => {
      applyConversationSnapshot(model, update.snapshot.conversation, false);
      model.observedSnapshotRevision += 1;
    });
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Discussion Session event identity collision: ${sessionId}`);
  applyConversationEvent(model, update.event);
}

export function applyConversationSnapshot(
  model: Conversation,
  conversation: ConversationSnapshot,
  preserveActiveTurns = false,
) {
  const current = toSnapshot(model);
  const parsed = Schema.decodeUnknownSync(conversationSnapshotSchema)({
    ...conversation,
    workspacePath: "",
  });
  const authoritative = conversationSnapshot(parsed);
  batch(() => {
    applyConversationCatalog(model, parsed);
    applySnapshot(model, {
      ...authoritative,
      activeTurnIds: preserveActiveTurns ? current.activeTurnIds : [],
      extensionUi: {
        ...authoritative.extensionUi,
        compatibilityDiagnostics: current.extensionUi?.compatibilityDiagnostics ?? [],
      },
    });
  });
}

function applyConversationEvent(model: Conversation, event: ConversationEvent) {
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

function applyExtensionUiEvent(
  model: Conversation,
  event: typeof extensionUiEventSchema.Type,
): void {
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
  if (event.kind === "companion-state") {
    const index = extensionUi.companions.findIndex((item) => item.id === event.id);
    const companion = extensionUi.companions[index];
    if (companion) extensionUi.companions.splice(index, 1, { ...companion, state: event.state });
    return;
  }
  if (!extensionUi.compatibilityDiagnostics.some((item) => item.id === event.diagnostic.id))
    extensionUi.compatibilityDiagnostics.push(event.diagnostic);
}

function conversationSnapshot(parsed: RuntimeConversationSnapshot): Snapshot<Conversation> {
  return {
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
    extensionUi: {
      title: parsed.extensionUi.title,
      statuses: parsed.extensionUi.statuses.map((status) => ({ ...status })),
      companions: parsed.extensionUi.companions?.map((companion) => ({ ...companion })) ?? [],
      compatibilityDiagnostics: [],
    },
  };
}
