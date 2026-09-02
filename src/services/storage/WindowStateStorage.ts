import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";

const WINDOW_STATE_DOCUMENT_VERSION = 2;
const WINDOW_STATE_DOCUMENT_NAME = "window-state.json";

const EmptyWindowSnapshot: Schema.Schema.Type<typeof Schema.Json> = {
  state: {},
  children: {},
};

const StoredEnvelope = Schema.Struct({
  version: Schema.Int,
  data: Schema.Json,
});

const LegacySelection = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-session"),
    workspacePath: Schema.String,
    sessionId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("cake-chat"), sessionId: Schema.String }),
]);

const LegacyPendingProjectSession = Schema.Struct({
  sessionId: Schema.String,
  workspacePath: Schema.String,
  lifecycle: Schema.Literals(["staged", "saved-draft", "starting"]),
  draft: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.Json)),
  configuration: Schema.optionalKey(Schema.Json),
  name: Schema.optionalKey(Schema.String),
  resolved: Schema.optionalKey(Schema.Boolean),
  stagedPrompt: Schema.optionalKey(
    Schema.Struct({ text: Schema.String, attachments: Schema.Array(Schema.Json) }),
  ),
});

const LegacyWindowState = Schema.Struct({
  projectPath: Schema.optionalKey(Schema.String),
  selectedSessionId: Schema.optionalKey(Schema.String),
  activeConversation: Schema.optionalKey(LegacySelection),
  recentProjectPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  draft: Schema.optionalKey(Schema.String),
  theme: Schema.optionalKey(Schema.Literals(["system", "light", "dark"])),
  workLogViewMode: Schema.optionalKey(Schema.Literals(["auto", "diff", "log"])),
  workLogsExpansion: Schema.optionalKey(
    Schema.Literals(["collapsed", "expanded", "fully-expanded"]),
  ),
  draftsBySession: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  pendingProjectSessions: Schema.optionalKey(Schema.Array(LegacyPendingProjectSession)),
  pendingCakeChat: Schema.optionalKey(
    Schema.Struct({
      sessionId: Schema.String,
      draft: Schema.String,
      configuration: Schema.optionalKey(Schema.Json),
      name: Schema.optionalKey(Schema.String),
      draftSession: Schema.optionalKey(Schema.Boolean),
      resolved: Schema.optionalKey(Schema.Boolean),
      stagedPrompt: Schema.optionalKey(
        Schema.Struct({ text: Schema.String, attachments: Schema.Array(Schema.Json) }),
      ),
    }),
  ),
  lastChatConfiguration: Schema.optionalKey(Schema.Json),
});

type LegacyWindowState = typeof LegacyWindowState.Type;

export class WindowStateReadError extends Schema.TaggedError<WindowStateReadError>()(
  "WindowStateReadError",
  { message: Schema.String },
) {}

export class WindowStateMalformedDocumentError extends Schema.TaggedError<WindowStateMalformedDocumentError>()(
  "WindowStateMalformedDocumentError",
  { message: Schema.String },
) {}

export class WindowStateUnsupportedVersionError extends Schema.TaggedError<WindowStateUnsupportedVersionError>()(
  "WindowStateUnsupportedVersionError",
  { version: Schema.Int, currentVersion: Schema.Int },
) {}

export class WindowStateEncodeError extends Schema.TaggedError<WindowStateEncodeError>()(
  "WindowStateEncodeError",
  { message: Schema.String },
) {}

export class WindowStateWriteError extends Schema.TaggedError<WindowStateWriteError>()(
  "WindowStateWriteError",
  { stage: Schema.Literals(["write", "rename"]), message: Schema.String },
) {}

export class WindowStateStorage extends Context.Service<
  WindowStateStorage,
  {
    readonly load: () => Effect.Effect<
      Schema.Schema.Type<typeof Schema.Json>,
      | WindowStateReadError
      | WindowStateMalformedDocumentError
      | WindowStateUnsupportedVersionError
      | WindowStateEncodeError
      | WindowStateWriteError
    >;
    readonly save: (
      snapshot: Schema.Schema.Type<typeof Schema.Json>,
    ) => Effect.Effect<void, WindowStateEncodeError | WindowStateWriteError>;
  }
>()("cake/services/storage/WindowStateStorage") {}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const writeError = (stage: AtomicFileStage, cause: unknown) =>
  new WindowStateWriteError({ stage, message: messageOf(cause) });

const migrateLegacyWindowState = Effect.fn("WindowStateStorage.migrateLegacy")(function* (
  legacy: LegacyWindowState,
) {
  const epoch = "1970-01-01T00:00:00.000Z";
  const pending = [...(legacy.pendingProjectSessions ?? [])];
  if (
    legacy.projectPath &&
    !legacy.selectedSessionId &&
    !pending.some((item) => item.lifecycle === "staged")
  )
    pending.push({
      sessionId: crypto.randomUUID(),
      workspacePath: legacy.projectPath,
      lifecycle: "staged",
      draft: legacy.draft ?? "",
    });
  const selectedSessionId =
    legacy.selectedSessionId ?? pending.find((item) => item.lifecycle === "staged")?.sessionId;
  const targetById = new Map<string, { sessionId: string; workspacePath: string }>();
  if (selectedSessionId && legacy.projectPath)
    targetById.set(selectedSessionId, {
      sessionId: selectedSessionId,
      workspacePath: legacy.projectPath,
    });
  for (const item of pending)
    targetById.set(item.sessionId, {
      sessionId: item.sessionId,
      workspacePath: item.workspacePath,
    });
  for (const sessionId of Object.keys(legacy.draftsBySession ?? {}))
    if (!targetById.has(sessionId) && legacy.projectPath)
      targetById.set(sessionId, { sessionId, workspacePath: legacy.projectPath });

  const temporarySessionIds = pending.map((item) => item.sessionId);
  const pendingConfigurationsBySession = Object.fromEntries(
    pending.flatMap((item) =>
      item.configuration === undefined ? [] : [[item.sessionId, item.configuration]],
    ),
  );
  const pendingNamesBySession = Object.fromEntries(
    pending.flatMap((item) => (item.name === undefined ? [] : [[item.sessionId, item.name]])),
  );
  const draftSessionsById = Object.fromEntries(
    pending.flatMap((item) => {
      if (item.lifecycle !== "saved-draft") return [];
      const prompt = item.stagedPrompt ?? {
        text: item.draft,
        attachments: item.attachments ?? [],
      };
      return [[item.sessionId, { ...prompt, resolved: item.resolved ?? false }]];
    }),
  );
  const sessionChildren = [...targetById.values()].map((target) => {
    const pendingState = pending.find((item) => item.sessionId === target.sessionId);
    return {
      key: target.sessionId,
      state: {},
      children: {
        chatStore: {
          state: {
            draft:
              legacy.draftsBySession?.[target.sessionId] ??
              (target.sessionId === selectedSessionId ? (legacy.draft ?? "") : ""),
          },
          children: {},
        },
        composerStore: {
          state: { attachments: pendingState?.attachments ?? [], annotations: [] },
          children: {},
        },
      },
    };
  });
  const pendingSummaries = pending
    .filter((item) => item.lifecycle !== "staged")
    .map((item) => ({
      sessionId: item.sessionId,
      title: item.name ?? "New chat",
      createdAt: epoch,
      modifiedAt: epoch,
      messageCount: 0,
      resolved: item.resolved ?? false,
      unread: false,
      projectPath: item.workspacePath,
      projectName: item.workspacePath.split("/").filter(Boolean).at(-1) ?? item.workspacePath,
      workingDirectory: item.workspacePath,
      pending: true,
      draft: item.lifecycle === "saved-draft",
    }));

  const selection =
    legacy.activeConversation ??
    (selectedSessionId && legacy.projectPath
      ? {
          kind: "project-session" as const,
          workspacePath: legacy.projectPath,
          sessionId: selectedSessionId,
        }
      : { kind: "workbench" as const });
  const pendingCakeChat = legacy.pendingCakeChat;
  const selectedCakeChatId =
    selection.kind === "cake-chat" ? selection.sessionId : pendingCakeChat?.sessionId;
  const cakeChatTargets = selectedCakeChatId ? [selectedCakeChatId] : [];
  const cakeChatChildren = cakeChatTargets.map((sessionId) => ({
    key: sessionId,
    state: { attachments: pendingCakeChat?.stagedPrompt?.attachments ?? [] },
    children: {
      chatStore: {
        state: { draft: pendingCakeChat?.sessionId === sessionId ? pendingCakeChat.draft : "" },
        children: {},
      },
    },
  }));
  const pendingCakeChatSession = pendingCakeChat
    ? {
        sessionId: pendingCakeChat.sessionId,
        started: false,
        configuration: pendingCakeChat.configuration,
        name: pendingCakeChat.name,
        draftPrompt:
          pendingCakeChat.draftSession && pendingCakeChat.stagedPrompt
            ? {
                ...pendingCakeChat.stagedPrompt,
                resolved: pendingCakeChat.resolved ?? false,
              }
            : undefined,
        createdAt: epoch,
        modifiedAt: epoch,
        messageCount: 0,
      }
    : undefined;

  const migrated = {
    state: {},
    children: {
      appShellStore: {
        state: {
          selection,
          activeConversation:
            selection.kind === "project-session" ||
            (selection.kind === "cake-chat" && selection.sessionId)
              ? selection
              : undefined,
          sessionHistory:
            selection.kind === "project-session" ||
            (selection.kind === "cake-chat" && selection.sessionId)
              ? [selection]
              : [],
          sessionHistoryCursor:
            selection.kind === "project-session" ||
            (selection.kind === "cake-chat" && selection.sessionId)
              ? 0
              : -1,
        },
        children: {},
      },
      projectWorkbenchStore: {
        state: {
          projectPath: legacy.projectPath,
          selectedSessionId,
        },
        children: {},
      },
      projectCatalogStore: {
        state: { recentProjectPaths: legacy.recentProjectPaths ?? [] },
        children: {},
      },
      sessionCatalogStore: {
        state: {},
        children: {},
      },
      sessionRegistry: {
        state: {
          targets: [...targetById.values()],
          unlistedNewSessionIds: pending
            .filter((item) => item.lifecycle === "starting")
            .map((item) => item.sessionId),
          materializedSessionIds: [...targetById.keys()].filter(
            (sessionId) => !temporarySessionIds.includes(sessionId),
          ),
          pendingConfigurationsBySession,
          pendingNamesBySession,
          draftSessionsById,
          temporarySessionIds,
          pendingSummaryMetadataBySession: Object.fromEntries(
            pendingSummaries.map((summary) => [
              summary.sessionId,
              {
                fallbackTitle: summary.title,
                createdAt: summary.createdAt,
                modifiedAt: summary.modifiedAt,
              },
            ]),
          ),
          stagedSessionId: pending.find((item) => item.lifecycle === "staged")?.sessionId,
        },
        children: { sessions: sessionChildren },
      },
      globalChatStore: {
        state: {
          selectedSessionId: selectedCakeChatId,
          targets: cakeChatTargets,
          pendingSessions: pendingCakeChatSession ? [pendingCakeChatSession] : [],
        },
        children: { loadedSessions: cakeChatChildren },
      },
      settingsStore: {
        state: {},
        children: {
          appearance: {
            state: {
              theme: legacy.theme ?? "system",
              workLogViewMode: legacy.workLogViewMode ?? "auto",
              workLogsExpansion: legacy.workLogsExpansion ?? "collapsed",
            },
            children: {},
          },
          modelPresets: {
            state: { lastUsedConfiguration: legacy.lastChatConfiguration },
            children: {},
          },
        },
      },
    },
  };
  const encoded = yield* Effect.try({
    try: () => JSON.stringify(migrated),
    catch: (cause) => new WindowStateMalformedDocumentError({ message: messageOf(cause) }),
  });
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(encoded).pipe(
    Effect.mapError((cause) => new WindowStateMalformedDocumentError({ message: cause.message })),
  );
});

export const makeWindowStateStorageLive = (userDataDirectory: string) =>
  Layer.effect(
    WindowStateStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const documentPath = path.join(userDataDirectory, WINDOW_STATE_DOCUMENT_NAME);
      const lock = yield* Semaphore.make(1);

      const saveUnlocked = Effect.fn("WindowStateStorage.save")(function* (
        snapshot: Schema.Schema.Type<typeof Schema.Json>,
      ) {
        const data = yield* Schema.encodeEffect(Schema.Json)(snapshot).pipe(
          Effect.mapError((cause) => new WindowStateEncodeError({ message: cause.message })),
        );
        const content = yield* Effect.try({
          try: () =>
            `${JSON.stringify({ version: WINDOW_STATE_DOCUMENT_VERSION, data }, null, 2)}\n`,
          catch: (cause) => new WindowStateEncodeError({ message: messageOf(cause) }),
        });
        yield* atomicWriteFile(fileSystem, path, documentPath, content, writeError);
      });

      const loadUnlocked = Effect.fn("WindowStateStorage.load")(function* () {
        const exists = yield* fileSystem
          .exists(documentPath)
          .pipe(Effect.mapError((cause) => new WindowStateReadError({ message: cause.message })));
        if (!exists) return EmptyWindowSnapshot;
        const text = yield* fileSystem
          .readFileString(documentPath)
          .pipe(Effect.mapError((cause) => new WindowStateReadError({ message: cause.message })));
        const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
          text,
        ).pipe(
          Effect.mapError(
            (cause) => new WindowStateMalformedDocumentError({ message: cause.message }),
          ),
        );
        const envelope = yield* Effect.result(Schema.decodeUnknownEffect(StoredEnvelope)(parsed));
        if (envelope._tag === "Success") {
          if (envelope.success.version !== WINDOW_STATE_DOCUMENT_VERSION)
            return yield* new WindowStateUnsupportedVersionError({
              version: envelope.success.version,
              currentVersion: WINDOW_STATE_DOCUMENT_VERSION,
            });
          return envelope.success.data;
        }
        const legacy = yield* Schema.decodeUnknownEffect(LegacyWindowState)(parsed).pipe(
          Effect.mapError(
            (cause) => new WindowStateMalformedDocumentError({ message: cause.message }),
          ),
        );
        const migrated = yield* migrateLegacyWindowState(legacy);
        yield* saveUnlocked(migrated);
        return migrated;
      });

      return WindowStateStorage.of({
        load: Effect.fn("WindowStateStorage.loadSerialized")(() =>
          lock.withPermits(1)(loadUnlocked()),
        ),
        save: Effect.fn("WindowStateStorage.saveSerialized")((snapshot) =>
          lock.withPermits(1)(saveUnlocked(snapshot)),
        ),
      });
    }),
  );
