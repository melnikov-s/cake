import { Effect, Stream } from "effect";
import type {
  PiSessionAcquireOptions,
  PiSessionError,
  PiSessionEvent,
  PiSessionHandle,
  PiSessions,
  PiSessionUpdate,
} from "../services/pi/PiSessions";
import type { PiQueuedMessages } from "../services/pi/conversation-data";
import type { SessionSnapshot } from "../ipc/session-contract";
import { toJsonValue } from "../utils/to-json-value";
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

export const observe = (handle: PiSessionHandle) => projectUpdates(handle.updates);
