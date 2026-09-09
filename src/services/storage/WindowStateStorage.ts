import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import { atomicWriteFile, type AtomicFileStage } from "./internal/atomicFile";

const WINDOW_STATE_DOCUMENT_VERSION = 7;
const WINDOW_STATE_DOCUMENT_NAME = "window-state.json";

const JsonRecord = Schema.Record(Schema.String, Schema.Json);
const decodeJsonRecord = (value: Schema.Schema.Type<typeof Schema.Json> | undefined) => {
  const result = Schema.decodeUnknownResult(JsonRecord)(value);
  return result._tag === "Success" ? result.success : undefined;
};

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

/** Moves Cake Chat composer snapshots from their former session-level owner to the shared child Store. */
const migrateVersion2WindowState = (snapshot: Schema.Schema.Type<typeof Schema.Json>) => {
  const root = decodeJsonRecord(snapshot);
  const rootChildren = decodeJsonRecord(root?.children);
  if (!root || !rootChildren) return snapshot;
  const collection = decodeJsonRecord(rootChildren.cakeChatCollectionStore);
  const collectionChildren = decodeJsonRecord(collection?.children);
  if (!collection || !collectionChildren) return snapshot;
  const loadedSessions = collectionChildren.loadedSessions;
  if (!Array.isArray(loadedSessions)) return snapshot;

  const migratedSessions = loadedSessions.map((session) => {
    const sessionRecord = decodeJsonRecord(session);
    const sessionState = decodeJsonRecord(sessionRecord?.state);
    if (!sessionRecord || !sessionState) return session;
    const legacyAttachments = sessionState.attachments;
    const legacyAnnotations = sessionState.annotations;
    if (legacyAttachments === undefined && legacyAnnotations === undefined) return session;

    const state = { ...sessionState };
    delete state.attachments;
    delete state.annotations;
    const children = decodeJsonRecord(sessionRecord.children) ?? {};
    const composer = decodeJsonRecord(children.composerStore) ?? {};
    const composerState = decodeJsonRecord(composer.state) ?? {};
    return {
      ...sessionRecord,
      state,
      children: {
        ...children,
        composerStore: {
          ...composer,
          state: {
            ...composerState,
            attachments: composerState.attachments ?? legacyAttachments ?? [],
            annotations: composerState.annotations ?? legacyAnnotations ?? [],
          },
          children: decodeJsonRecord(composer.children) ?? {},
        },
      },
    };
  });

  return {
    ...root,
    children: {
      ...rootChildren,
      cakeChatCollectionStore: {
        ...collection,
        children: { ...collectionChildren, loadedSessions: migratedSessions },
      },
    },
  };
};

const chatStoreChildNames = new Set(["chatStore", "chatStores", "draftChatStore"]);

/** Retains local drafts for secondary ChatStore consumers whose draft ownership did not move. */
const migrateStandaloneChatDrafts = (
  snapshot: Schema.Schema.Type<typeof Schema.Json>,
): Schema.Schema.Type<typeof Schema.Json> => {
  const migrateStore = (
    value: Schema.Schema.Type<typeof Schema.Json>,
    isChatStore = false,
  ): Schema.Schema.Type<typeof Schema.Json> => {
    const store = decodeJsonRecord(value);
    if (!store) return value;
    const state = decodeJsonRecord(store.state);
    const children = decodeJsonRecord(store.children);
    const nextState = state ? { ...state } : undefined;
    if (isChatStore && nextState?.draft !== undefined) {
      nextState.localDraft ??= nextState.draft;
      delete nextState.draft;
    }
    const nextChildren = children
      ? Object.fromEntries(
          Object.entries(children).map(([name, childValue]) => [
            name,
            Array.isArray(childValue)
              ? childValue.map((child) => migrateStore(child, chatStoreChildNames.has(name)))
              : migrateStore(childValue, chatStoreChildNames.has(name)),
          ]),
        )
      : undefined;
    const migrated = { ...store };
    if (nextState) migrated.state = nextState;
    if (nextChildren) migrated.children = nextChildren;
    return migrated;
  };

  return migrateStore(snapshot);
};

/** Moves coherent draft state beneath ComposerDraftStore while retaining standalone Chat drafts. */
const migrateVersion3WindowState = (snapshot: Schema.Schema.Type<typeof Schema.Json>) => {
  const migrateSession = (value: Schema.Schema.Type<typeof Schema.Json>) => {
    const session = decodeJsonRecord(value);
    const children = decodeJsonRecord(session?.children);
    if (!session || !children) return value;
    const chat = decodeJsonRecord(children.chatStore) ?? {};
    const chatState = decodeJsonRecord(chat.state) ?? {};
    const composer = decodeJsonRecord(children.composerStore) ?? {};
    const composerState = decodeJsonRecord(composer.state) ?? {};
    const composerChildren = decodeJsonRecord(composer.children) ?? {};
    const draft = decodeJsonRecord(composerChildren.draftStore) ?? {};
    const draftState = decodeJsonRecord(draft.state) ?? {};
    const nextChatState = { ...chatState };
    const text = nextChatState.draft;
    delete nextChatState.draft;
    const nextComposerState = { ...composerState };
    const attachments = nextComposerState.attachments;
    const annotations = nextComposerState.annotations;
    const editorContextAttachment = nextComposerState.editorContextAttachment;
    delete nextComposerState.attachments;
    delete nextComposerState.annotations;
    delete nextComposerState.editorContextAttachment;
    const draftEditorContext = draftState.editorContextAttachment ?? editorContextAttachment;
    const migratedDraftState = {
      ...draftState,
      text: draftState.text ?? text ?? "",
      attachments: draftState.attachments ?? attachments ?? [],
      annotations: draftState.annotations ?? annotations ?? [],
    };
    const nextDraftState =
      draftEditorContext === undefined
        ? migratedDraftState
        : { ...migratedDraftState, editorContextAttachment: draftEditorContext };
    return {
      ...session,
      children: {
        ...children,
        chatStore: { ...chat, state: nextChatState },
        composerStore: {
          ...composer,
          state: nextComposerState,
          children: {
            ...composerChildren,
            draftStore: {
              ...draft,
              state: nextDraftState,
              children: decodeJsonRecord(draft.children) ?? {},
            },
          },
        },
      },
    };
  };

  const root = decodeJsonRecord(snapshot);
  const children = decodeJsonRecord(root?.children);
  if (!root || !children) return snapshot;
  const registry = decodeJsonRecord(children.sessionRegistry);
  const registryChildren = decodeJsonRecord(registry?.children);
  const collection = decodeJsonRecord(children.cakeChatCollectionStore);
  const collectionChildren = decodeJsonRecord(collection?.children);
  const nextChildren = { ...children };
  if (registry && registryChildren && Array.isArray(registryChildren.sessions))
    nextChildren.sessionRegistry = {
      ...registry,
      children: {
        ...registryChildren,
        sessions: registryChildren.sessions.map(migrateSession),
      },
    };
  if (collection && collectionChildren && Array.isArray(collectionChildren.loadedSessions))
    nextChildren.cakeChatCollectionStore = {
      ...collection,
      children: {
        ...collectionChildren,
        loadedSessions: collectionChildren.loadedSessions.map(migrateSession),
      },
    };
  return migrateStandaloneChatDrafts({ ...root, children: nextChildren });
};

/** Moves Project Session pending and observation policy into their focused child Stores. */
const migrateVersion4WindowState = (snapshot: Schema.Schema.Type<typeof Schema.Json>) => {
  const root = decodeJsonRecord(snapshot);
  const rootChildren = decodeJsonRecord(root?.children);
  const registry = decodeJsonRecord(rootChildren?.sessionRegistry);
  const registryState = decodeJsonRecord(registry?.state);
  const registryChildren = decodeJsonRecord(registry?.children);
  if (!root || !rootChildren || !registry || !registryState) return snapshot;

  const nextRegistryState = { ...registryState };
  const take = (name: string) => {
    const value = nextRegistryState[name];
    delete nextRegistryState[name];
    return value;
  };
  const stagedSessionIds = take("stagedSessionIds");
  const stagedSessionId = Schema.decodeUnknownResult(Schema.String)(take("stagedSessionId"));
  const pendingState = {
    unlistedNewSessionIds: take("unlistedNewSessionIds") ?? [],
    configurationsBySession: take("pendingConfigurationsBySession") ?? {},
    namesBySession: take("pendingNamesBySession") ?? {},
    draftsBySession: take("draftSessionsById") ?? {},
    temporarySessionIds: take("temporarySessionIds") ?? [],
    summaryMetadataBySession: take("pendingSummaryMetadataBySession") ?? {},
    stagedSessionIds:
      stagedSessionIds ?? (stagedSessionId._tag === "Success" ? [stagedSessionId.success] : []),
  };
  const observationState = {
    materializedSessionIds: take("materializedSessionIds") ?? [],
  };
  return {
    ...root,
    children: {
      ...rootChildren,
      sessionRegistry: {
        ...registry,
        state: nextRegistryState,
        children: {
          ...registryChildren,
          pendingSessions: { state: pendingState, children: {} },
          observationRetention: { state: observationState, children: {} },
        },
      },
    },
  };
};

/** Moves Cake Chat identity and pending state into focused child Stores and selects via its layout. */
const migrateVersion5WindowState = (snapshot: Schema.Schema.Type<typeof Schema.Json>) => {
  const root = decodeJsonRecord(snapshot);
  const rootChildren = decodeJsonRecord(root?.children);
  const collection = decodeJsonRecord(rootChildren?.cakeChatCollectionStore);
  const collectionState = decodeJsonRecord(collection?.state);
  const collectionChildren = decodeJsonRecord(collection?.children);
  if (!root || !rootChildren || !collection || !collectionState) return snapshot;

  const nextCollectionState = { ...collectionState };
  const selectedSessionId = Schema.decodeUnknownResult(Schema.String)(
    nextCollectionState.selectedSessionId,
  );
  const targets = nextCollectionState.targets ?? [];
  const pendingSessions = nextCollectionState.pendingSessions ?? [];
  delete nextCollectionState.selectedSessionId;
  delete nextCollectionState.targets;
  delete nextCollectionState.pendingSessions;

  const nextCollectionChildren = { ...collectionChildren };
  const loadedSessions = nextCollectionChildren.loadedSessions ?? [];
  delete nextCollectionChildren.loadedSessions;
  const existingLayout = decodeJsonRecord(nextCollectionChildren.sessionLayoutStore);
  const existingLayoutState = decodeJsonRecord(existingLayout?.state);
  if (
    selectedSessionId._tag === "Success" &&
    (!existingLayoutState || existingLayoutState.layout === undefined)
  ) {
    const paneId = `cake-chat-pane:${selectedSessionId.success}`;
    nextCollectionChildren.sessionLayoutStore = {
      state: {
        ...existingLayoutState,
        layout: {
          kind: "pane",
          paneId,
          history: [selectedSessionId.success],
          historyCursor: 0,
        },
        focusedPaneId: paneId,
      },
      children: decodeJsonRecord(existingLayout?.children) ?? {},
    };
  }
  nextCollectionChildren.registry = {
    state: { targets },
    children: { sessions: loadedSessions },
  };
  nextCollectionChildren.pendingSessions = {
    state: { sessions: pendingSessions },
    children: {},
  };

  return {
    ...root,
    children: {
      ...rootChildren,
      cakeChatCollectionStore: {
        ...collection,
        state: nextCollectionState,
        children: nextCollectionChildren,
      },
    },
  };
};

/** Moves active Project path and Project-open snapshot ownership into ProjectOpenStore. */
const migrateVersion6WindowState = (snapshot: Schema.Schema.Type<typeof Schema.Json>) => {
  const root = decodeJsonRecord(snapshot);
  const rootChildren = decodeJsonRecord(root?.children);
  const workbench = decodeJsonRecord(rootChildren?.projectWorkbenchStore);
  const workbenchState = decodeJsonRecord(workbench?.state);
  const workbenchChildren = decodeJsonRecord(workbench?.children);
  if (!root || !rootChildren || !workbench || !workbenchState) return snapshot;

  const nextWorkbenchState = { ...workbenchState };
  const projectPath = nextWorkbenchState.projectPath;
  delete nextWorkbenchState.projectPath;
  const projectOpen = decodeJsonRecord(workbenchChildren?.projectOpenStore);
  const projectOpenState = decodeJsonRecord(projectOpen?.state) ?? {};
  return {
    ...root,
    children: {
      ...rootChildren,
      projectWorkbenchStore: {
        ...workbench,
        state: nextWorkbenchState,
        children: {
          ...workbenchChildren,
          projectOpenStore: {
            ...projectOpen,
            state: {
              ...projectOpenState,
              ...(projectPath === undefined ? null : { projectPath }),
            },
            children: decodeJsonRecord(projectOpen?.children) ?? {},
          },
        },
      },
    },
  };
};

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

  const selection = legacy.activeConversation
    ? legacy.activeConversation.kind === "project-session"
      ? { kind: "project-session" as const, sessionId: legacy.activeConversation.sessionId }
      : legacy.activeConversation
    : selectedSessionId && legacy.projectPath
      ? { kind: "project-session" as const, sessionId: selectedSessionId }
      : { kind: "workbench" as const };
  const pendingCakeChat = legacy.pendingCakeChat;
  const selectedCakeChatId =
    selection.kind === "cake-chat" ? selection.sessionId : pendingCakeChat?.sessionId;
  const cakeChatTargets = selectedCakeChatId ? [selectedCakeChatId] : [];
  const cakeChatChildren = cakeChatTargets.map((sessionId) => ({
    key: sessionId,
    state: {},
    children: {
      chatStore: {
        state: { draft: pendingCakeChat?.sessionId === sessionId ? pendingCakeChat.draft : "" },
        children: {},
      },
      composerStore: {
        state: {
          attachments: pendingCakeChat?.stagedPrompt?.attachments ?? [],
          annotations: [],
        },
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
      cakeChatCollectionStore: {
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
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    encoded,
  ).pipe(
    Effect.mapError((cause) => new WindowStateMalformedDocumentError({ message: cause.message })),
  );
  return migrateVersion6WindowState(
    migrateVersion5WindowState(migrateVersion4WindowState(migrateVersion3WindowState(decoded))),
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
          if (envelope.success.version === WINDOW_STATE_DOCUMENT_VERSION)
            return envelope.success.data;
          if (envelope.success.version === 2) {
            const migrated = migrateVersion6WindowState(
              migrateVersion5WindowState(
                migrateVersion4WindowState(
                  migrateVersion3WindowState(migrateVersion2WindowState(envelope.success.data)),
                ),
              ),
            );
            yield* saveUnlocked(migrated);
            return migrated;
          }
          if (envelope.success.version === 3) {
            const migrated = migrateVersion6WindowState(
              migrateVersion5WindowState(
                migrateVersion4WindowState(migrateVersion3WindowState(envelope.success.data)),
              ),
            );
            yield* saveUnlocked(migrated);
            return migrated;
          }
          if (envelope.success.version === 4) {
            const migrated = migrateVersion6WindowState(
              migrateVersion5WindowState(migrateVersion4WindowState(envelope.success.data)),
            );
            yield* saveUnlocked(migrated);
            return migrated;
          }
          if (envelope.success.version === 5) {
            const migrated = migrateVersion6WindowState(
              migrateVersion5WindowState(envelope.success.data),
            );
            yield* saveUnlocked(migrated);
            return migrated;
          }
          if (envelope.success.version === 6) {
            const migrated = migrateVersion6WindowState(envelope.success.data);
            yield* saveUnlocked(migrated);
            return migrated;
          }
          return yield* new WindowStateUnsupportedVersionError({
            version: envelope.success.version,
            currentVersion: WINDOW_STATE_DOCUMENT_VERSION,
          });
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
