import { child, createStore, Store, observable } from "r-state-tree";
import type { SavedDraft } from "../../domain/project-sessions/saved-draft-data";
import { resolveDraftUpdate } from "../../utils/resolve-draft-update";
import type { Client } from "../client/Client";
import type { RootProjection } from "../models/RootProjection";
import { ClientContext } from "./context/ClientContext";
import { BrowserNavigationStore } from "./BrowserNavigationStore";
import { BrowserSessionStore } from "./BrowserSessionStore";
import { FullscreenSurfaceStore } from "./FullscreenSurfaceStore";
import { ExtensionUiStore } from "./ExtensionUiStore";

/** Browser composition root, connection presentation and cross-surface selection only.
 * No WindowStatePersistence is attached: all navigation and drafts die with this tab.
 */
export class BrowserShellStore extends Store<{ client: Client; projection: RootProjection }> {
  connected = false;
  everConnected = false;
  error: string | undefined;
  private readonly savedRecords: Record<string, SavedDraft> = observable({});
  private loadRevision = 0;
  get savedDrafts() {
    return Object.values(this.savedRecords);
  }
  async refreshSavedDrafts() {
    const revision = ++this.loadRevision;
    try {
      const records = await this.client.savedDrafts.list({ signal: this.signal });
      if (this.signal.aborted || !this.connected || revision !== this.loadRevision) return;
      this.applySavedDraftSnapshot(records);
    } catch (error) {
      if (!this.signal.aborted && this.connected) this.reportError(error);
    }
  }
  applySavedDraftSnapshot(records: ReadonlyArray<SavedDraft>) {
    ++this.loadRevision;
    const ids = new Set(records.map((record) => record.sessionId));
    for (const id of Object.keys(this.savedRecords)) if (!ids.has(id)) delete this.savedRecords[id];
    for (const record of records) {
      const local = this.savedRecords[record.sessionId];
      if (!local || local.revision <= record.revision) {
        this.savedRecords[record.sessionId] = record;
        if (record.status === "activated") this.navigation.materializeSavedDraft(record);
      }
    }
  }
  async updateSavedDraft(record: SavedDraft, text: string) {
    const updated = await this.client.savedDrafts.update({ ...record, text }, record.revision, {
      signal: this.signal,
    });
    this.savedRecords[record.sessionId] = updated;
    return updated;
  }
  async recoverUncertainDraft(record: SavedDraft) {
    const updated = await this.client.savedDrafts.recoverUncertain(
      record.sessionId,
      record.revision,
      { signal: this.signal },
    );
    this.savedRecords[record.sessionId] = updated;
    return updated;
  }
  async activateSavedDraft(record: SavedDraft) {
    const result = await this.client.savedDrafts.activate(
      {
        sessionId: record.sessionId,
        expectedRevision: record.revision,
        workingDirectory: record.projectPath,
      },
      { signal: this.signal },
    );
    this.savedRecords[record.sessionId] = result.record;
    this.navigation.materializeSavedDraft(result.record);
    return result;
  }
  [ClientContext.provide]() {
    return this.props.client;
  }
  get client() {
    return this.props.client;
  }
  @child get fullscreen(): FullscreenSurfaceStore {
    return createStore(FullscreenSurfaceStore, {});
  }
  @child get navigation(): BrowserNavigationStore {
    return createStore(BrowserNavigationStore, {
      projection: this.props.projection,
      savedDrafts: () => this.savedDrafts,
    });
  }
  @child get sessions(): BrowserSessionStore[] {
    return this.navigation.opened.map((target) =>
      createStore(BrowserSessionStore, {
        key: target.sessionId,
        ...target,
        known: () => Boolean(this.props.projection.sessionCatalog.find(target.sessionId)),
        connected: () => this.connected,
        catalogReady: () => this.navigation.synchronizedProjects.has(target.projectPath),
        model: this.props.projection.projectConversation(target.sessionId, target.workingDirectory),
        savedDraft: () => this.savedRecords[target.sessionId],
        updateSavedDraft: (record, text) => this.updateSavedDraft(record, text),
        activateSavedDraft: (record) => this.activateSavedDraft(record),
        recoverUncertainDraft: (record) => this.recoverUncertainDraft(record),
        refreshSavedDrafts: () => this.refreshSavedDrafts(),
      }),
    );
  }
  get active() {
    return this.sessions.find((session) => session.id === this.navigation.sessionId);
  }
  @child get extensionUi(): ExtensionUiStore {
    return createStore(ExtensionUiStore, {
      activeSessionModel: () => this.active?.model,
      sessionContext: () => (this.active ? { sessionId: this.active.id } : undefined),
      setDraft: (value) => {
        const chat = this.active?.chat;
        if (chat) chat.setDraft(resolveDraftUpdate(value, chat.draft));
      },
      requestComposerFocus: () => {
        if (this.active) this.active.focusRevision += 1;
      },
    });
  }
  connectionChanged(connected: boolean) {
    this.connected = connected;
    if (connected) {
      this.everConnected = true;
      void this.refreshSavedDrafts();
    } else {
      this.navigation.synchronizedProjects.clear();
      for (const session of this.sessions) session.disconnected();
      this.extensionUi.clear();
    }
  }
  reportError(error: unknown) {
    this.error = error instanceof Error ? error.message : String(error);
  }
}
