import { Effect, Stream } from "effect";
import type {
  PiSessionAcquireOptions,
  PiSessionError,
  PiSessionEvent,
  PiSessionHandle,
  PiSessions,
  PiSessionUpdate,
} from "../../services/pi/PiSessions";
import type { PiQueuedMessages } from "../../services/pi/conversation-data";
import type {
  Annotation,
  Attachment,
  ChatConfiguration,
  PiSettingUpdate,
  SessionSnapshot,
  ThinkingLevel,
} from "../../ipc/session-contract";
import { toJsonValue } from "../../utils/to-json-value";
import {
  TurnId,
  type ConversationEvent,
  type ConversationSnapshot,
  type ConversationUpdate,
  type QueuedConversationMessages,
} from "./conversation-data";

export * from "./conversation-data";

/** Maps Pi's transient runtime queue into Cake's conversation projection. */
export const projectQueuedMessages = (queued: PiQueuedMessages): QueuedConversationMessages => ({
  steering: [...queued.steering],
  followUp: [...queued.followUp],
});

export const projectPreviewSnapshot = (preview: {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly parts: ReadonlyArray<unknown>;
}): ConversationSnapshot => ({
  workingDirectory: preview.workspacePath,
  sessionId: preview.sessionId,
  sessionFile: preview.sessionFile,
  parts: preview.parts.map(toJsonValue),
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: [],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

export const projectSnapshot = (snapshot: SessionSnapshot): ConversationSnapshot => {
  const projected: ConversationSnapshot = {
    workingDirectory: snapshot.workspacePath,
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    parts: snapshot.parts.map(toJsonValue),
    models: snapshot.models.map(toJsonValue),
    thinkingLevel: snapshot.thinkingLevel,
    availableThinkingLevels: [...snapshot.availableThinkingLevels],
    streaming: snapshot.streaming,
    diagnostics: [...snapshot.diagnostics],
    commands: snapshot.commands.map(toJsonValue),
    compatibility: toJsonValue(snapshot.compatibility),
    extensionUi: toJsonValue(snapshot.extensionUi),
    tree: snapshot.tree.map(toJsonValue),
  };
  if (snapshot.sessionListed !== undefined)
    Object.assign(projected, { sessionListed: snapshot.sessionListed });
  if (snapshot.model !== undefined)
    Object.assign(projected, { model: toJsonValue(snapshot.model) });
  if (snapshot.fastMode !== undefined) Object.assign(projected, { fastMode: snapshot.fastMode });
  if (snapshot.fastModeAvailable !== undefined)
    Object.assign(projected, { fastModeAvailable: snapshot.fastModeAvailable });
  if (snapshot.piSettings !== undefined)
    Object.assign(projected, { piSettings: toJsonValue(snapshot.piSettings) });
  if (snapshot.usage !== undefined)
    Object.assign(projected, { usage: toJsonValue(snapshot.usage) });
  if (snapshot.artifacts !== undefined)
    Object.assign(projected, { artifacts: snapshot.artifacts.map(toJsonValue) });
  return projected;
};

const projectEvent = (event: PiSessionEvent): ConversationEvent => {
  switch (event.type) {
    case "snapshot-updated":
      return { _tag: "SnapshotUpdated", snapshot: projectSnapshot(event.snapshot) };
    case "part-updated":
      return { _tag: "PartUpdated", sessionId: event.sessionId, part: toJsonValue(event.part) };
    case "part-removed":
      return { _tag: "PartRemoved", sessionId: event.sessionId, partId: event.partId };
    case "streaming":
      return { _tag: "StreamingChanged", sessionId: event.sessionId, streaming: event.streaming };
    case "usage-updated":
      return { _tag: "UsageUpdated", sessionId: event.sessionId, usage: event.usage };
    case "extension-ui":
      return { _tag: "ExtensionUi", sessionId: event.sessionId, event: toJsonValue(event.event) };
    case "turn-accepted":
      return {
        _tag: "TurnAccepted",
        sessionId: event.sessionId,
        turnId: TurnId.make(event.turnId),
        delivery: event.delivery,
      };
    case "turn-settled": {
      const settled: ConversationEvent = {
        _tag: "TurnSettled",
        sessionId: event.sessionId,
        turnId: TurnId.make(event.turnId),
        outcome: event.outcome,
      };
      if (event.message !== undefined) Object.assign(settled, { message: event.message });
      return settled;
    }
  }
};

const projectUpdates = (updates: Stream.Stream<PiSessionUpdate, PiSessionError>) =>
  updates.pipe(
    Stream.mapAccum(
      () => 0,
      (revision, update) => {
        const nextRevision = revision + 1;
        const projected: ConversationUpdate =
          update._tag === "Snapshot"
            ? {
                _tag: "Snapshot",
                revision: nextRevision,
                snapshot: projectSnapshot(update.snapshot),
              }
            : { _tag: "Event", revision: nextRevision, event: projectEvent(update.event) };
        return [nextRevision, [projected]] as const;
      },
    ),
  );

export const acquire = Effect.fn("Conversations.acquire")(function* (
  sessions: PiSessions["Service"],
  options: PiSessionAcquireOptions,
) {
  return yield* sessions.acquire(options);
});

/** Acquires one scoped Pi handle at the point a shared conversation operation uses it. */
export const use = Effect.fn("Conversations.use")(function* <A, E, R, E2, R2>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  operation: (handle: PiSessionHandle) => Effect.Effect<A, E2, R2>,
): Effect.fn.Return<A, E | E2, R | R2> {
  return yield* operation(yield* acquisition);
});

export type ConversationDelivery = "prompt" | "steer" | "follow-up";

export const deliver = Effect.fn("Conversations.deliver")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  delivery: ConversationDelivery,
  text: string,
  attachments: ReadonlyArray<Attachment>,
  renderUserMessageAsMarkdown: boolean,
) {
  return yield* use(acquisition, (handle) => {
    switch (delivery) {
      case "prompt":
        return handle.prompt(text, attachments, renderUserMessageAsMarkdown);
      case "steer":
        return handle.steer(text, attachments, renderUserMessageAsMarkdown);
      case "follow-up":
        return handle.followUp(text, attachments, renderUserMessageAsMarkdown);
    }
  });
});

/** Prompts an idle conversation or queues a follow-up behind its active turn. */
export const deliverWhenAvailable = Effect.fn("Conversations.deliverWhenAvailable")(function* <
  E,
  R,
>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  text: string,
  attachments: ReadonlyArray<Attachment>,
  renderUserMessageAsMarkdown: boolean,
) {
  return yield* use(acquisition, (handle) =>
    handle
      .snapshot()
      .pipe(
        Effect.flatMap((snapshot) =>
          snapshot.streaming
            ? handle.followUp(text, attachments, renderUserMessageAsMarkdown)
            : handle.prompt(text, attachments, renderUserMessageAsMarkdown),
        ),
      ),
  );
});

export const abort = Effect.fn("Conversations.abort")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
) {
  yield* use(acquisition, (handle) => handle.abort());
});

export const compact = Effect.fn("Conversations.compact")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  instructions?: string,
) {
  yield* use(acquisition, (handle) => handle.compact(instructions));
});

export const editMessage = Effect.fn("Conversations.editMessage")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  entryId: string,
  text: string,
  attachments: ReadonlyArray<Attachment>,
  renderUserMessageAsMarkdown: boolean,
) {
  yield* use(acquisition, (handle) =>
    handle.editMessage(entryId, text, attachments, renderUserMessageAsMarkdown),
  );
});

export const applyConfiguration = Effect.fn("Conversations.applyConfiguration")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  configuration: ChatConfiguration,
) {
  yield* use(acquisition, (handle) => handle.applyConfiguration(configuration));
});

export const setModel = Effect.fn("Conversations.setModel")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  provider: string,
  modelId: string,
) {
  yield* use(acquisition, (handle) => handle.setModel(provider, modelId));
});

export const setThinkingLevel = Effect.fn("Conversations.setThinkingLevel")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  level: ThinkingLevel,
) {
  yield* use(acquisition, (handle) => handle.setThinkingLevel(level));
});

export const setFastMode = Effect.fn("Conversations.setFastMode")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  enabled: boolean,
) {
  yield* use(acquisition, (handle) => handle.setFastMode(enabled));
});

export const setPiSetting = Effect.fn("Conversations.setPiSetting")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  update: PiSettingUpdate,
) {
  yield* use(acquisition, (handle) => handle.setPiSetting(update));
});

export const authenticate = Effect.fn("Conversations.authenticate")(function* <E, R>(
  acquisition: Effect.Effect<PiSessionHandle, E, R>,
  operation:
    | { readonly _tag: "Login"; readonly provider: string; readonly authType: "api_key" | "oauth" }
    | { readonly _tag: "Logout"; readonly provider: string },
) {
  yield* use(acquisition, (handle) =>
    operation._tag === "Login"
      ? handle.login(operation.provider, operation.authType)
      : handle.logout(operation.provider),
  );
});

/** Detaches RPC-decoded attachments from their input arrays before passing them to Pi. */
export const projectAttachments = (values: ReadonlyArray<Attachment>): ReadonlyArray<Attachment> =>
  values.map((value): Attachment => {
    switch (value.kind) {
      case "file":
        return { kind: "file", name: value.name, path: value.path };
      case "image":
        return {
          kind: "image",
          name: value.name,
          mimeType: value.mimeType,
          data: value.data,
        };
      case "source":
        return {
          kind: "source",
          name: value.name,
          location: {
            path: value.location.path,
            range: {
              start: { line: value.location.range.start.line },
              end: { line: value.location.range.end.line },
            },
          },
        };
      case "annotation":
        return {
          kind: "annotation",
          annotations: value.annotations.map((annotation) => {
            const projected: Annotation = {
              id: annotation.id,
              messageId: annotation.messageId,
              selectedText: annotation.selectedText,
              startOffset: annotation.startOffset,
              endOffset: annotation.endOffset,
              contextBefore: annotation.contextBefore,
              contextAfter: annotation.contextAfter,
            };
            if (annotation.entryId !== undefined)
              Object.assign(projected, { entryId: annotation.entryId });
            if (annotation.comment !== undefined)
              Object.assign(projected, { comment: annotation.comment });
            return projected;
          }),
        };
    }
  });

export const observe = (handle: PiSessionHandle) => projectUpdates(handle.updates);
