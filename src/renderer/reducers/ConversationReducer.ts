import { Schema } from "effect";
import { applySnapshot, batch, type Snapshot } from "r-state-tree";
import type {
  ConversationEvent,
  ConversationSnapshot,
  ConversationUpdate,
} from "../../contracts/conversations/conversation-data";
import type { DiscussionSessionUpdate } from "../../contracts/discussion-sessions/discussion-session-data";
import {
  extensionUiEventSchema,
  sessionUsageSchema,
  conversationSnapshotSchema,
  type ConversationSnapshot as RuntimeConversationSnapshot,
  uiPartSchema,
} from "../../contracts/conversations/session-contract";
import { projectionId } from "../../utils/projection-id";
import { modelOptionKey } from "../../utils/model-option-key";
import type { Conversation } from "../models/Conversation";
import { applyConversationCatalog } from "./ConversationCatalogReducer";
import { applyPartUpdate, messageSnapshots, removePart } from "./SessionPartReducer";

export function applyConversationUpdate(model: Conversation, update: ConversationUpdate) {
  if (update._tag === "Snapshot") {
    assertConversationSnapshotIdentity(model, update.snapshot);
    batch(() => {
      applyConversationSnapshot(model, update.snapshot, false);
      model.observedSnapshotRevision += 1;
      model.observationError = undefined;
    });
    return;
  }
  if (update.event._tag === "SnapshotUpdated")
    assertConversationSnapshotIdentity(model, update.event.snapshot);
  else if (update.event.sessionId !== model.sessionId)
    throw new Error(`Conversation event identity collision: ${model.sessionId}`);
  applyConversationEvent(model, update.event);
}

function assertConversationSnapshotIdentity(model: Conversation, snapshot: ConversationSnapshot) {
  if (snapshot.sessionId !== model.sessionId)
    throw new Error(`Conversation snapshot identity collision: ${model.sessionId}`);
}

export function unloadConversationProjection(model: Conversation) {
  batch(() => {
    applySnapshot(model, {
      sessionFile: "",
      parts: [],
      model: undefined,
      preset: undefined,
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
    model.historyCursor = undefined;
    model.earlierParts.splice(0);
    model.observedSnapshotRevision = 0;
    model.observationError = undefined;
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
    assertConversationSnapshotIdentity(model, update.snapshot.conversation);
    batch(() => {
      applyConversationSnapshot(model, update.snapshot.conversation, false);
      model.observedSnapshotRevision += 1;
    });
    return;
  }
  if (update.sessionId !== sessionId)
    throw new Error(`Discussion Session event identity collision: ${sessionId}`);
  if (update.event._tag === "SnapshotUpdated")
    assertConversationSnapshotIdentity(model, update.event.snapshot);
  applyConversationEvent(model, update.event);
}

export function applyConversationSnapshot(
  model: Conversation,
  conversation: ConversationSnapshot,
  preserveActiveTurns = false,
) {
  // Only these local fields survive hydration; do not snapshot the old transcript,
  // model catalog, resources, and Pi tree just to retain them.
  const activeTurnIds = preserveActiveTurns ? model.activeTurnIds.slice() : [];
  const compatibilityDiagnostics = model.extensionUi.compatibilityDiagnostics.slice();
  const parsed = Schema.decodeUnknownSync(conversationSnapshotSchema)({
    ...conversation,
    workspacePath: "",
  });
  const authoritative = conversationSnapshot(parsed);
  batch(() => {
    // A live snapshot is a bounded recent window. Retain evicted originals only
    // after the user explicitly loaded history; ordinary observation stays bounded.
    if (model.earlierParts.length) {
      const sourceIds = parsed.parts.flatMap((part) =>
        "entryId" in part && part.entryId !== undefined ? [Number(part.entryId)] : [],
      );
      const oldest = sourceIds.length ? Math.min(...sourceIds) : undefined;
      const known = new Set(model.earlierParts.map((part) => part.id));
      if (oldest !== undefined)
        model.earlierParts.push(
          ...model.parts
            .map((part) => part.value)
            .filter(
              (part) =>
                "entryId" in part &&
                part.entryId !== undefined &&
                Number(part.entryId) < oldest &&
                !known.has(part.id),
            ),
        );
    }
    applyConversationCatalog(model, parsed);
    applySnapshot(model, {
      ...authoritative,
      activeTurnIds,
      extensionUi: {
        ...authoritative.extensionUi,
        compatibilityDiagnostics,
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
    else if (event._tag === "StreamingChanged") {
      model.streaming = event.streaming;
      // Pi's settled run ends activity even if correlation bookkeeping follows later.
      if (!event.streaming) model.activeTurnIds.splice(0);
    } else if (event._tag === "UsageUpdated")
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
    historyCursor: parsed.historyCursor,
    parts: messageSnapshots(parsed.parts, parsed.sessionId),
    model: parsed.model ? { id: modelOptionKey(parsed.model) } : undefined,
    preset: parsed.preset,
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
