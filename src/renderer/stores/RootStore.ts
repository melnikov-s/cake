import { Store, child, createStore, mount } from "r-state-tree";
import type { DesktopClient, DesktopClientEvent } from "../desktop-client";
import { DesktopClientContext, SessionCacheContext } from "./StoreContext";
import { SessionCacheStore } from "./SessionCacheStore";
import { MainChatStore } from "./MainChatStore";
import { SidebarStore } from "./SidebarStore";
import { BrowseStore } from "./BrowseStore";
import { ChangesStore } from "./ChangesStore";
import { ReviewsStore } from "./ReviewsStore";
import { SettingsStore } from "./SettingsStore";
import { ExtensionUiStore } from "./ExtensionUiStore";
import { ArtifactInteractionStore } from "./ArtifactInteractionStore";
import { MessageComposerStore } from "./MessageComposerStore";
import { AppControlBridge } from "../app-control-bridge";
import { GlobalChatStore } from "./GlobalChatStore";
import { NavigationStore } from "./NavigationStore";
import { ChatConfigurationStore } from "./ChatConfigurationStore";
import { TranscriptViewStore } from "./TranscriptViewStore";
import { CustomizationStore } from "./CustomizationStore";
import { PluginCommandStore } from "./PluginCommandStore";
import { InlineWidgetStore } from "./InlineWidgetStore";
import { MessageCommentsStore } from "./MessageCommentsStore";

export class RootStore extends Store<{ client: DesktopClient }> {
  readonly appControl: AppControlBridge;

  [DesktopClientContext.provide]() {
    return this.props.client;
  }

  [SessionCacheContext.provide]() {
    return this.sessionCache;
  }

  @child
  get pluginCommandStore(): PluginCommandStore { return createStore(PluginCommandStore); }

  @child
  get inlineWidgetStore(): InlineWidgetStore { return createStore(InlineWidgetStore, { client: this.client }); }

  get client() {
    const client = DesktopClientContext.consume(this);
    if (!client) throw new Error("DesktopClientContext is not provided");
    return client;
  }

  @child
  get customizationStore(): CustomizationStore {
    return createStore(CustomizationStore, { client: this.client });
  }

  @child
  get sessionCache(): SessionCacheStore {
    return createStore(SessionCacheStore);
  }

  @child
  get mainTranscriptViewStore(): TranscriptViewStore {
    return createStore(TranscriptViewStore);
  }

  @child
  get globalTranscriptViewStore(): TranscriptViewStore {
    return createStore(TranscriptViewStore);
  }

  @child
  get sidebarStore(): SidebarStore {
    return createStore(SidebarStore, {
      activeSession: () => this.mainChatStore.projectPath && this.mainChatStore.selectedSessionId
        ? { workspacePath: this.mainChatStore.projectPath, sessionId: this.mainChatStore.selectedSessionId }
        : undefined
    });
  }

  @child
  get browseStore(): BrowseStore {
    return createStore(BrowseStore, {
      client: this.client,
      projectPath: () => this.mainChatStore.projectPath,
      sessionId: () => this.mainChatStore.session?.sessionId,
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get changesStore(): ChangesStore {
    return createStore(ChangesStore, {
      client: this.client,
      projectPath: () => this.mainChatStore.projectPath,
      sessionId: () => this.mainChatStore.session?.sessionId,
      startOperation: () => this.mainChatStore.startOperation(),
      finishOperation: (operationId) => this.mainChatStore.finishOperation(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get reviewsStore(): ReviewsStore {
    return createStore(ReviewsStore, {
      client: this.client,
      sessionCache: this.sessionCache,
      context: () => this.mainChatStore.sessionContext(),
      model: () => this.mainChatStore.session?.model,
      startOperation: () => this.mainChatStore.startOperation(),
      finishOperation: (operationId) => this.mainChatStore.finishOperation(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get messageCommentsStore(): MessageCommentsStore {
    return createStore(MessageCommentsStore, {
      client: this.client,
      sessionCache: this.sessionCache,
      reviews: () => this.reviewsStore,
      context: () => this.mainChatStore.sessionContext(),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get settingsStore(): SettingsStore {
    return createStore(SettingsStore, {
      client: this.client,
      sessionContext: () => this.mainChatStore.sessionContext(),
      startOperation: () => this.mainChatStore.startOperation(),
      finishOperation: (operationId) => this.mainChatStore.finishOperation(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get mainChatConfigurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.mainChatStore.session,
      startOperation: () => this.mainChatStore.startOperation(),
      setModel: (operationId, provider, modelId) => {
        const context = this.mainChatStore.sessionContext();
        if (!context) throw new Error("No active session");
        return this.client.setModel({ operationId, ...context, provider, modelId });
      },
      setThinkingLevel: (operationId, level) => {
        const context = this.mainChatStore.sessionContext();
        if (!context) throw new Error("No active session");
        return this.client.setThinkingLevel({ operationId, ...context, level });
      },
      finishOperation: (operationId) => this.mainChatStore.finishOperation(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get extensionUiStore(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      client: this.client,
      activeSessionId: () => this.mainChatStore.session?.sessionId,
      sessionContext: () => this.mainChatStore.sessionContext(),
      operationActive: (operationId) => this.mainChatStore.activeOperations.includes(operationId),
      setDraft: (value) => this.mainChatStore.setDraft(typeof value === "function" ? value(this.mainChatStore.draft) : value),
      requestComposerFocus: () => this.messageComposerStore.requestFocus(),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get artifactInteractionStore(): ArtifactInteractionStore {
    return createStore(ArtifactInteractionStore, {
      client: this.client,
      sessionContext: () => this.mainChatStore.sessionContext(),
      isActiveSession: (workspacePath, sessionId) => this.mainChatStore.isActiveSession(workspacePath, sessionId),
      operationActive: (operationId) => this.mainChatStore.activeOperations.includes(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get messageComposerStore(): MessageComposerStore {
    return createStore(MessageComposerStore, {
      client: this.client,
      sessionCache: this.sessionCache,
      reviews: () => this.reviewsStore,
      projectPath: () => this.mainChatStore.projectPath,
      sessionId: () => this.mainChatStore.session?.sessionId,
      canonicalParts: () => this.mainChatStore.canonicalParts,
      draft: () => this.mainChatStore.draft,
      setDraft: (value) => this.mainChatStore.setDraft(value),
      canSubmit: () => this.mainChatStore.canSubmit,
      isStreaming: () => this.mainChatStore.isStreaming,
      openCommandPane: (pane) => this.mainChatStore.openCommandPane(pane),
      matchesPluginCommand: (input) => this.pluginCommandStore.matches(input),
      runPluginCommand: (input) => this.pluginCommandStore.run(input),
      startOperation: () => this.mainChatStore.startOperation(),
      finishOperation: (operationId) => this.mainChatStore.finishOperation(operationId),
      reportError: (error) => this.mainChatStore.setError(error)
    });
  }

  @child
  get mainChatStore(): MainChatStore {
    return createStore(MainChatStore, {
      sidebar: () => this.sidebarStore,
      browse: () => this.browseStore,
      changes: () => this.changesStore,
      reviews: () => this.reviewsStore,
      settings: () => this.settingsStore,
      extensionUi: () => this.extensionUiStore,
      artifacts: () => this.artifactInteractionStore,
      composer: () => this.messageComposerStore,
      transcriptView: () => this.mainTranscriptViewStore,
      pluginCommands: () => this.pluginCommandStore
    });
  }

  @child
  get globalChatStore(): GlobalChatStore {
    return createStore(GlobalChatStore, {
      port: {
        open: (input) => this.client.openGlobalChat(input),
        prompt: (input) => this.client.promptGlobalChat(input),
        abort: (operationId) => this.client.abortGlobalChat(operationId),
        clear: (input) => this.client.clearGlobalChat(input)
      },
      tools: () => this.appControl.listTools(),
      sessions: () => this.sessionCache
    });
  }

  @child
  get globalChatConfigurationStore(): ChatConfigurationStore {
    return createStore(ChatConfigurationStore, {
      session: () => this.globalChatStore.session,
      startOperation: () => this.globalChatStore.startOperation(),
      setModel: (operationId, provider, modelId) => this.client.setGlobalChatModel({ operationId, provider, modelId }),
      setThinkingLevel: (operationId, level) => this.client.setGlobalChatThinkingLevel({ operationId, level }),
      finishOperation: (operationId) => this.globalChatStore.finishOperation(operationId),
      reportError: (error) => this.globalChatStore.reportError(error)
    });
  }

  @child
  get navigationStore(): NavigationStore {
    return createStore(NavigationStore);
  }

  constructor(props: RootStore["props"]) {
    super(props);
    this.appControl = new AppControlBridge({
      currentSession: () => this.mainChatStore.projectPath && this.mainChatStore.selectedSessionId
        ? { workspacePath: this.mainChatStore.projectPath, sessionId: this.mainChatStore.selectedSessionId }
        : undefined,
      projects: () => this.sidebarStore.projects,
      sessions: () => this.sidebarStore.sessions,
      sessionActivity: (workspacePath, sessionId) => this.sidebarStore.sessionActivity(workspacePath, sessionId),
      readSession: async (workspacePath, sessionId) => {
        const cached = this.sessionCache.find(sessionId, workspacePath);
        if (cached?.sessionFile) return cached.uiParts;
        return (await this.client.loadSession(workspacePath, sessionId))?.parts;
      },
      openSession: async (workspacePath, sessionId) => {
        await this.mainChatStore.openSession(workspacePath, sessionId);
        this.navigationStore.openChat();
      },
      createSession: async (workspacePath) => {
        await this.mainChatStore.startNewSession(workspacePath);
        this.navigationStore.openChat();
      },
      sendSessionMessage: (workspacePath, sessionId, text, delivery) => this.runControlOperation((operationId) =>
        this.client.submit({ operationId, workspacePath, sessionId, text, delivery, attachments: [] })),
      abortSession: (workspacePath, sessionId) => this.runControlOperation((operationId) =>
        this.client.abort({ operationId, workspacePath, sessionId })),
      renameSession: (workspacePath, sessionId, title) => this.mainChatStore.renameSession(workspacePath, sessionId, title),
      setSessionArchived: (workspacePath, sessionId, archived) => this.mainChatStore.archiveSession(workspacePath, sessionId, archived),
      setSessionModel: (workspacePath, sessionId, provider, modelId) => this.runControlOperation((operationId) =>
        this.client.setModel({ operationId, workspacePath, sessionId, provider, modelId })),
      customizationState: () => this.customizationStore.state,
      plugins: () => this.customizationStore.plugins,
      listCustomizationFiles: () => this.client.listCustomizationFiles(),
      readCustomizationFile: (path) => this.client.readCustomizationFile(path),
      writeCustomizationFile: (path, content, expectedWorkingRevision) => this.client.writeCustomizationFile(path, content, expectedWorkingRevision),
      buildCustomization: (expectedBaseRevision, request, expectedSourceRevision) => this.client.buildCustomization(expectedBaseRevision, request, expectedSourceRevision),
      rollbackCustomization: () => this.client.rollbackCustomization(),
      useFactoryCustomization: () => this.client.useFactoryCustomization(),
      setPluginEnabled: (pluginId, enabled) => this.client.setPluginEnabled(pluginId, enabled)
    });
    this.effect(() => this.client.subscribe((event) => {
      try {
        this.receive(event);
      } catch (error) {
        const context = `Desktop event: ${event.type}`;
        if (event.type.startsWith("global-chat-")) this.globalChatStore.reportError(error, context);
        else this.mainChatStore.setError(error, context);
      }
    }));
    this.effect(() => { void this.customizationStore.hydrate(); });
  }

  private receive(event: DesktopClientEvent) {
    this.customizationStore.receive(event);
    if (event.type === "global-chat-control-requested") {
      void this.appControl.invoke(event.invocation)
        .catch((error) => ({ ok: false as const, name: event.invocation.name, error: error instanceof Error ? error.message : String(error) }))
        .then((result) => this.client.respondToGlobalChatControl(event.controlRequestId, result));
      return;
    }
    if (event.type.startsWith("global-chat-")) {
      this.globalChatStore.receive(event);
      return;
    }
    this.changesStore.receive(event);
    this.reviewsStore.receive(event);
    this.settingsStore.receive(event);
    this.extensionUiStore.receive(event);
    this.artifactInteractionStore.receive(event);
    if (event.type === "session-snapshot-received") {
      const previousSessionId = this.mainChatStore.session?.sessionId;
      if (event.operationId && !this.mainChatStore.acceptSessionSnapshot(event)) return;
      const previous = this.sessionCache.find(event.snapshot.sessionId, event.snapshot.workspacePath);
      const wasStreaming = previous?.streaming ?? false;
      this.sessionCache.upsert(event.snapshot);
      const opening = this.mainChatStore.openingSession(event.snapshot.workspacePath, event.snapshot.sessionId);
      this.sidebarStore.updateSessionActivity(event.snapshot.workspacePath, event.snapshot.sessionId, event.snapshot.streaming, wasStreaming, opening);
      this.messageComposerStore.reconcile(event.snapshot.sessionId);
      if (event.operationId || this.mainChatStore.isActiveSession(event.snapshot.workspacePath, event.snapshot.sessionId)) {
        this.mainChatStore.applySessionSnapshot(event.snapshot, event.operationId ? previousSessionId : undefined, Boolean(event.operationId));
        void this.changesStore.refresh();
      }
      return;
    }
    if (event.type === "part-updated") {
      this.sessionCache.find(event.sessionId)?.upsertPart(event.part);
      this.messageComposerStore.reconcile(event.sessionId);
      return;
    }
    if (event.type === "part-removed") {
      this.sessionCache.find(event.sessionId)?.removePart(event.partId);
      return;
    }
    if (event.type === "streaming-changed") {
      const session = this.sessionCache.find(event.sessionId);
      const wasStreaming = session?.streaming ?? false;
      session?.setStreaming(event.streaming);
      if (session) {
        const opening = this.mainChatStore.openingSession(session.workspacePath, event.sessionId);
        this.sidebarStore.updateSessionActivity(session.workspacePath, event.sessionId, event.streaming, wasStreaming, opening);
      }
      return;
    }
    if (event.type === "artifact-updated" || event.type === "artifact-requested") {
      this.sessionCache.find(event.record.artifact.sessionId, event.record.workspacePath)?.upsertArtifact(event.record);
      if (event.type === "artifact-updated") return;
    }
    if (event.type === "review-threads-received") {
      this.sessionCache.applyReviewThreads(event.workspacePath, event.sessionId, event.threads);
      this.mainChatStore.receive(event);
      return;
    }
    if (event.type === "review-thread-updated") {
      this.sessionCache.upsertReviewThread(event.thread);
      this.mainChatStore.receive(event);
      if (this.changesStore.path !== undefined && event.thread.workspacePath === this.mainChatStore.projectPath) void this.changesStore.refresh();
      return;
    }
    this.mainChatStore.receive(event);
  }

  private async runControlOperation(action: (operationId: string) => Promise<void>) {
    const operationId = this.mainChatStore.startOperation();
    try {
      await action(operationId);
    } catch (error) {
      this.mainChatStore.finishOperation(operationId);
      throw error;
    }
  }
}

export function mountRootStore(client: DesktopClient) {
  return mount(createStore(RootStore, { client }));
}
