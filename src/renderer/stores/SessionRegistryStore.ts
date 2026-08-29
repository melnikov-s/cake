import { Store, applySnapshot, child, createStore, observable, updateStore } from "r-state-tree";
import type { ArtifactRecord } from "../../ipc/artifact-contract";
import type {
  ChatConfiguration,
  ModelPreset,
  SessionPreview,
  SessionSnapshot,
  UiPart,
} from "../../ipc/session-contract";
import type { ReviewThread } from "../../ipc/review-contract";
import type { DesktopClient } from "../desktop-client";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { ReviewsStore } from "./ReviewsStore";
import type { PluginCommandStore } from "./PluginCommandStore";
import type { SessionCatalogStore } from "./SessionCatalogStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { ProjectSessionStore, type SessionTarget } from "./ProjectSessionStore";
import { toSessionPreviewSnapshot, toSessionSnapshot } from "../../utils/session-snapshot";

export interface SessionRegistryStoreProps {
  client: DesktopClient;
  catalog?: SessionCatalogStore;
  operations: SessionOperationCoordinatorStore;
  reviews(): ReviewsStore;
  pluginCommands(): PluginCommandStore;
  canSubmit(sessionId: string): boolean;
  isActive(sessionId: string): boolean;
  openCommandPane(pane: "changelog" | "tree" | "resources"): Promise<void>;
  persist(): void;
  projectName(workspacePath: string): string;
  abort(): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  handoffSession(entryId: string, prompt?: string, resolveSource?: boolean): Promise<boolean>;
  modelPresets?(): readonly ModelPreset[];
  openModelPresetSettings?(): void;
  newSessionRequest?(
    sessionId: string,
  ): { path: string; configuration?: ChatConfiguration; name?: string } | undefined;
  prepareNewSession?(sessionId: string): Promise<boolean>;
  settings?(): AppearanceSettingsStore | undefined;
}

/** Owns the keyed collection of loaded per-session Store instances for a window. */
export class SessionRegistryStore extends Store<SessionRegistryStoreProps> {
  readonly targets: SessionTarget[] = observable([]);
  // Pi may take time to include a newly started session in its disk-backed listing.
  // Retain all such sessions independently from unsent renderer-owned sessions.
  private readonly unlistedNewSessionIds: Set<string> = observable(new Set<string>());
  // A deferred new session has no runtime yet, so configuration changes are kept
  // locally and delivered with the first prompt instead of runtime commands.
  private readonly pendingConfigurationsBySession: Record<string, ChatConfiguration> = observable(
    {},
  );
  private readonly pendingNamesBySession: Record<string, string> = observable({});
  private readonly temporarySessionIds: Set<string> = observable(new Set<string>());
  private readonly sessionsById = new Map<string, ProjectSessionStore>();
  private readonly sessionWorkspacePaths = new Map<string, string>();
  private readonly pendingPartsBySession = new Map<string, Map<string, UiPart | null>>();
  private readonly pendingStreamingBySession = new Map<string, boolean>();
  private readonly pendingArtifactsBySession = new Map<string, Map<string, ArtifactRecord>>();

  @child
  get sessions(): ProjectSessionStore[] {
    return this.targets.map((target) =>
      createStore(ProjectSessionStore, {
        key: target.sessionId,
        ...target,
        client: this.props.client,
        registry: this,
        operations: this.props.operations,
        reviews: this.props.reviews,
        pluginCommands: this.props.pluginCommands,
        canSubmit: () => this.props.canSubmit(target.sessionId),
        isActive: () => this.props.isActive(target.sessionId),
        openCommandPane: (pane) => this.props.openCommandPane(pane),
        persist: () => this.props.persist(),
        projectName: () => this.props.projectName(target.workspacePath),
        abort: () => this.props.abort(),
        renameSession: (name) => this.props.renameSession(target.sessionId, name),
        handoffSession: (entryId, prompt, resolveSource) =>
          this.props.handoffSession(entryId, prompt, resolveSource),
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        newSessionRequest: () => this.props.newSessionRequest?.(target.sessionId),
        prepareNewSession: () =>
          this.props.prepareNewSession?.(target.sessionId) ?? Promise.resolve(true),
        settings: () => this.props.settings?.(),
      }),
    );
  }

  findModel(sessionId: string) {
    return this.findSession(sessionId)?.model;
  }

  findSession(sessionId: string) {
    const cached = this.sessionsById.get(sessionId);
    if (cached) return cached;
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session) this.sessionsById.set(sessionId, session);
    return session;
  }

  ensure(sessionId: string) {
    let session = this.findSession(sessionId);
    if (!session) {
      const workspacePath = this.workspacePathFor(sessionId);
      this.targets.push({ sessionId, workspacePath });
      session = this.findSession(sessionId)!;
    }
    return session;
  }

  markNewSessionStarted(sessionId: string) {
    if (!this.temporarySessionIds.delete(sessionId)) return;
    delete this.pendingConfigurationsBySession[sessionId];
    delete this.pendingNamesBySession[sessionId];
    this.unlistedNewSessionIds.add(sessionId);
    this.props.persist();
  }

  retainedNewSessionIds(workspacePath: string) {
    return [...this.temporarySessionIds, ...this.unlistedNewSessionIds].filter(
      (sessionId) => this.sessionWorkspacePaths.get(sessionId) === workspacePath,
    );
  }

  prepareNewSession(workspacePath: string, sessionId: string) {
    this.rememberSessionLocation(sessionId, workspacePath);
    const session = this.ensure(sessionId);
    // Deferred sessions have no Pi runtime snapshot until their first prompt. Seed
    // their workspace-scoped menu from a loaded sibling so skills remain invokable.
    if (session.model.commands.length === 0) {
      const source = this.sessions.find(
        (candidate) =>
          candidate.sessionId !== sessionId &&
          candidate.workspacePath === workspacePath &&
          candidate.hydrated &&
          candidate.model.commands.length > 0,
      );
      if (source)
        session.model.commands.push(
          ...source.model.commands.map((command) => ({
            ...command,
            sourceInfo: { ...command.sourceInfo },
          })),
        );
    }
    session.markHydrated();
    this.temporarySessionIds.add(sessionId);
    this.props.catalog?.upsertPending(
      sessionId,
      workspacePath,
      this.props.projectName(workspacePath),
    );
    return session;
  }

  isTemporarySession(sessionId: string) {
    return this.temporarySessionIds.has(sessionId);
  }

  relocateTemporarySession(sessionId: string, workspacePath: string) {
    if (!this.temporarySessionIds.has(sessionId))
      throw new Error("Only an unsent session can choose another worktree.");
    const session = this.findSession(sessionId);
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (!session || index < 0) throw new Error("Cake could not find that draft session.");
    const previousPath = session.workspacePath;
    if (previousPath === workspacePath) return;
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
    this.targets.splice(index, 1, { sessionId, workspacePath });
    updateStore(session, { ...session.props, workspacePath });
    this.props.catalog?.upsertPending(
      sessionId,
      workspacePath,
      this.props.projectName(workspacePath),
    );
  }

  pendingConfiguration(sessionId: string) {
    return this.pendingConfigurationsBySession[sessionId];
  }

  pendingName(sessionId: string) {
    return this.pendingNamesBySession[sessionId];
  }

  setPendingName(sessionId: string, name: string) {
    if (!this.temporarySessionIds.has(sessionId))
      throw new Error("Only an unsent session can receive an initial name.");
    this.pendingNamesBySession[sessionId] = name;
  }

  setPendingConfiguration(sessionId: string, configuration: ChatConfiguration) {
    this.pendingConfigurationsBySession[sessionId] = configuration;
  }

  discardNewSession(sessionId: string) {
    const index = this.targets.findIndex((target) => target.sessionId === sessionId);
    if (index >= 0) this.targets.splice(index, 1);
    this.sessionsById.delete(sessionId);
    this.temporarySessionIds.delete(sessionId);
    this.unlistedNewSessionIds.delete(sessionId);
    delete this.pendingConfigurationsBySession[sessionId];
    delete this.pendingNamesBySession[sessionId];
    this.sessionWorkspacePaths.delete(sessionId);
    this.pendingPartsBySession.delete(sessionId);
    this.pendingStreamingBySession.delete(sessionId);
    this.pendingArtifactsBySession.delete(sessionId);
    this.props.catalog?.remove(sessionId);
  }

  pendingNewSessions() {
    return [...this.temporarySessionIds].flatMap((sessionId) => {
      const session = this.findSession(sessionId);
      if (!session) return [];
      return [
        {
          sessionId,
          workspacePath: session.workspacePath,
          draft: session.chatStore.draft,
          configuration: this.pendingConfiguration(sessionId),
          name: this.pendingName(sessionId),
        },
      ];
    });
  }

  restorePendingNewSession(state: {
    sessionId: string;
    workspacePath: string;
    draft: string;
    configuration?: ChatConfiguration;
    name?: string;
  }) {
    const session = this.prepareNewSession(state.workspacePath, state.sessionId);
    session.chatStore.setDraft(state.draft);
    if (state.configuration) this.setPendingConfiguration(state.sessionId, state.configuration);
    if (state.name) this.setPendingName(state.sessionId, state.name);
    return session;
  }

  upsert(snapshot: SessionSnapshot) {
    this.rememberSessionLocation(snapshot.sessionId, snapshot.workspacePath);
    if (this.temporarySessionIds.has(snapshot.sessionId))
      this.markNewSessionStarted(snapshot.sessionId);
    else {
      this.temporarySessionIds.delete(snapshot.sessionId);
      delete this.pendingConfigurationsBySession[snapshot.sessionId];
      delete this.pendingNamesBySession[snapshot.sessionId];
    }
    const session = this.ensure(snapshot.sessionId);
    applySnapshot(session.model, toSessionSnapshot(snapshot));
    session.model.applyArtifacts(snapshot.artifacts ?? []);
    this.applyPendingEvents(session);
    session.markHydrated();
    if (snapshot.sessionListed === true && this.unlistedNewSessionIds.delete(snapshot.sessionId))
      this.props.persist();
    else if (snapshot.sessionListed === false) this.unlistedNewSessionIds.add(snapshot.sessionId);
    return session.model;
  }

  upsertPart(sessionId: string, part: UiPart) {
    const session = this.findSession(sessionId);
    if (session) {
      session.model.upsertPart(part);
      return session;
    }
    this.pendingParts(sessionId).set(part.id, part);
    return undefined;
  }

  removePart(sessionId: string, partId: string) {
    const session = this.findSession(sessionId);
    if (session) {
      session.model.removePart(partId);
      return;
    }
    this.pendingParts(sessionId).set(partId, null);
  }

  setStreaming(sessionId: string, streaming: boolean) {
    const session = this.findSession(sessionId);
    if (session) {
      session.model.setStreaming(streaming);
      return session;
    }
    this.pendingStreamingBySession.set(sessionId, streaming);
    return undefined;
  }

  upsertArtifact(record: ArtifactRecord) {
    const sessionId = record.artifact.sessionId;
    const session = this.findSession(sessionId);
    if (session) {
      session.model.upsertArtifact(record);
      return;
    }
    const records = this.pendingArtifactsBySession.get(sessionId) ?? new Map();
    const existing = records.get(record.artifact.id);
    if (!existing || record.artifact.revision >= existing.artifact.revision)
      records.set(record.artifact.id, record);
    this.pendingArtifactsBySession.set(sessionId, records);
  }

  hydratePreview(preview: SessionPreview) {
    this.rememberSessionLocation(preview.sessionId, preview.workspacePath);
    const session = this.ensure(preview.sessionId);
    applySnapshot(session.model, toSessionPreviewSnapshot(preview));
    session.markHydrated();
    return session.model;
  }

  applyReviewThreads(sessionId: string, threads: ReviewThread[]) {
    if (!this.findSession(sessionId) && threads[0])
      this.rememberSessionLocation(sessionId, threads[0].workspacePath);
    const session =
      this.findSession(sessionId) ?? (threads.length > 0 ? this.ensure(sessionId) : undefined);
    if (!session) return undefined;
    session.model.applyReviewThreads(threads);
    return session.model;
  }

  upsertReviewThread(thread: ReviewThread) {
    this.rememberSessionLocation(thread.sessionId, thread.workspacePath);
    const session = this.ensure(thread.sessionId);
    session.model.upsertReviewThread(thread);
    return session.model;
  }

  private pendingParts(sessionId: string) {
    const parts = this.pendingPartsBySession.get(sessionId) ?? new Map<string, UiPart | null>();
    this.pendingPartsBySession.set(sessionId, parts);
    return parts;
  }

  private applyPendingEvents(session: ProjectSessionStore) {
    const sessionId = session.sessionId;
    const parts = this.pendingPartsBySession.get(sessionId);
    if (parts) {
      for (const [partId, part] of parts) {
        if (part) session.model.upsertPart(part);
        else session.model.removePart(partId);
      }
      this.pendingPartsBySession.delete(sessionId);
    }
    const streaming = this.pendingStreamingBySession.get(sessionId);
    if (streaming !== undefined) {
      session.model.setStreaming(streaming);
      this.pendingStreamingBySession.delete(sessionId);
    }
    const artifacts = this.pendingArtifactsBySession.get(sessionId);
    if (artifacts) {
      session.model.applyArtifacts([...artifacts.values()]);
      this.pendingArtifactsBySession.delete(sessionId);
    }
  }

  private workspacePathFor(sessionId: string) {
    const workspacePath =
      this.props.catalog?.find(sessionId)?.workspacePath ??
      this.sessionWorkspacePaths.get(sessionId);
    if (!workspacePath) throw new Error(`Cake could not find session ${sessionId}`);
    return workspacePath;
  }

  private rememberSessionLocation(sessionId: string, workspacePath: string) {
    const prior =
      this.sessionWorkspacePaths.get(sessionId) ??
      this.props.catalog?.find(sessionId)?.workspacePath;
    if (prior && prior !== workspacePath)
      throw new Error(`Session ID collision detected: ${sessionId}`);
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
  }
}
