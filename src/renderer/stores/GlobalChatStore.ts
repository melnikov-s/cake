import { Store, child, createStore, observable } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { RendererClientContext } from "../client/RendererClientContext";
import type { JsonObject } from "../../ipc/json-contract";
import type {
  ApplicationState,
  Attachment,
  ChatConfiguration,
  ModelPreset,
} from "../../ipc/session-contract";
import type { CakeChatSummary } from "../../domain/cake-chat-data";
import { compareSessionSummariesForSidebar } from "../../utils/session-summary-order";
import { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";
import type { AppearanceSettingsStore } from "./AppearanceSettingsStore";
import { CakeChatSessionStore } from "./CakeChatSessionStore";
import { describeError } from "../error-details";

type CakeChatSummaryProjection = CakeChatSummary & { draft?: boolean };

interface CakeControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

export interface GlobalChatStoreProps {
  nativeClient: Pick<
    DesktopClient,
    "showComposerContextMenu" | "rewordComposerSelection" | "generateSessionTitle"
  >;
  tools(): ReadonlyArray<CakeControlTool>;
  modelPresets?(): readonly ModelPreset[];
  defaultConfiguration?(): ChatConfiguration | undefined;
  openModelPresetSettings?(): void;
  settings?(): AppearanceSettingsStore | undefined;
  persist?(): void;
  prepareSessionResolution?(sessionIds: readonly string[]): Promise<boolean>;
}

/** Owns the Cake Chat session collection, selection, and per-session Store instances. */
export class GlobalChatStore extends Store<GlobalChatStoreProps> {
  selectedSessionId: string | undefined;
  hydrated = false;
  error: string | undefined;
  errorDetails: string | undefined;
  readonly summaries: CakeChatSummaryProjection[] = observable([]);
  readonly targets: string[] = observable([]);
  readonly resolvedSessionIds: string[] = observable([]);
  private initialization: Promise<void> | undefined;
  private pendingSessionId: string | undefined;
  private pendingConfiguration: ChatConfiguration | undefined;
  private pendingName: string | undefined;
  private pendingDraftPrompt:
    | { text: string; attachments: Attachment[]; resolved: boolean }
    | undefined;
  private resolutionQueue: Promise<void> = Promise.resolve();

  @child
  get operations(): SessionOperationCoordinatorStore {
    return createStore(SessionOperationCoordinatorStore);
  }

  get client() {
    return RendererClientContext.consume(this)!;
  }
  get sessionId() {
    return this.selectedSessionId;
  }
  get nativeClient() {
    return this.props.nativeClient;
  }

  @child
  get loadedSessions(): CakeChatSessionStore[] {
    return this.targets.map((sessionId) =>
      createStore(CakeChatSessionStore, {
        key: sessionId,
        sessionId,
        collection: this,
        operations: this.operations,
        modelPresets: () => this.props.modelPresets?.() ?? [],
        openModelPresetSettings: () => this.props.openModelPresetSettings?.(),
        settings: () => this.props.settings?.(),
        persist: () => this.props.persist?.(),
      }),
    );
  }

  get activeSession() {
    return this.selectedSessionId ? this.findSession(this.selectedSessionId) : undefined;
  }

  findSession(sessionId: string) {
    return this.loadedSessions.find((session) => session.sessionId === sessionId);
  }

  target(sessionId: string) {
    return { sessionId, tools: this.props.tools() };
  }

  /** Explicit application startup. Repeated callers share the same initialization. */
  initialize() {
    if (!this.initialization) this.initialization = this.performInitialization();
    return this.initialization;
  }

  private async performInitialization() {
    try {
      const summaries: CakeChatSummaryProjection[] = [
        ...(await this.client.cakeChats.list({ signal: this.signal })),
      ];
      if (this.signal.aborted) return;
      const persistedPendingSessionId = this.pendingSessionId;
      if (
        persistedPendingSessionId &&
        summaries.some((summary) => summary.sessionId === persistedPendingSessionId)
      )
        this.markSessionStarted(persistedPendingSessionId);
      this.replaceSummaries(summaries);
      this.hydrated = true;
      if (this.pendingSessionId) {
        this.selectedSessionId = this.pendingSessionId;
        return;
      }
      const recent = summaries.find((summary) => !summary.resolved);
      if (recent) await this.open(recent.sessionId);
      else this.prepareNewSession();
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not load sessions");
    }
  }

  async open(sessionId?: string) {
    if (!sessionId) return;
    if (!this.targets.includes(sessionId)) this.targets.push(sessionId);
    try {
      await this.client.cakeChats.open(this.target(sessionId), { signal: this.signal });
      if (!this.signal.aborted) this.selectedSessionId = sessionId;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  async startNewSession(prompt?: string) {
    await this.initialize();
    if (this.signal.aborted) return;
    const pending = this.pendingSessionId ? this.findSession(this.pendingSessionId) : undefined;
    const session = pending ?? this.prepareNewSession();
    // A startup open is accepted before its snapshot arrives. Once the user
    // explicitly chooses a new chat, that late snapshot must not steal selection.
    this.selectedSessionId = session.sessionId;
    if (prompt?.trim()) await session.submit(prompt);
  }

  isPendingSession(sessionId: string) {
    return this.pendingSessionId === sessionId;
  }

  pendingSessionConfiguration(sessionId: string) {
    return this.isPendingSession(sessionId)
      ? (this.pendingConfiguration ?? this.props.defaultConfiguration?.())
      : undefined;
  }

  setPendingSessionConfiguration(sessionId: string, configuration: ChatConfiguration) {
    if (!this.isPendingSession(sessionId)) return;
    this.pendingConfiguration = configuration;
    this.props.persist?.();
  }

  isDraftSession(sessionId: string) {
    return this.isPendingSession(sessionId) && this.pendingDraftPrompt !== undefined;
  }

  draftSessionPrompt(sessionId: string) {
    return this.isDraftSession(sessionId) ? this.pendingDraftPrompt : undefined;
  }

  createDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isPendingSession(sessionId)) return false;
    this.pendingDraftPrompt = { text, attachments: attachments.slice(), resolved: false };
    this.updateSummary(sessionId, (summary) => ({
      ...summary,
      draft: true,
      modifiedAt: new Date().toISOString(),
    }));
    this.props.persist?.();
    return true;
  }

  updateDraftSession(sessionId: string, text: string, attachments: Attachment[]) {
    if (!this.isDraftSession(sessionId)) return false;
    this.pendingDraftPrompt = {
      text,
      attachments: attachments.slice(),
      resolved: this.pendingDraftPrompt?.resolved ?? false,
    };
    this.props.persist?.();
    return true;
  }

  activateDraftSession(sessionId: string) {
    if (!this.isDraftSession(sessionId)) return undefined;
    const prompt = this.pendingDraftPrompt;
    this.pendingDraftPrompt = undefined;
    this.updateSummary(sessionId, (summary) => ({ ...summary, draft: false, resolved: false }));
    this.props.persist?.();
    return prompt;
  }

  applyGeneratedDraftName(sessionId: string, name: string) {
    if (!this.isDraftSession(sessionId) || this.pendingName) return;
    this.pendingName = name;
    this.updateSummary(sessionId, (summary) => ({ ...summary, title: name }));
    this.props.persist?.();
  }

  newSessionRequest(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return undefined;
    return {
      tools: this.props.tools(),
      configuration: this.pendingSessionConfiguration(sessionId),
      name: this.pendingName,
    };
  }

  markSessionStarted(sessionId: string) {
    if (!this.isPendingSession(sessionId)) return;
    this.pendingSessionId = undefined;
    this.pendingConfiguration = undefined;
    this.pendingName = undefined;
    this.pendingDraftPrompt = undefined;
    this.props.persist?.();
  }

  pendingSessionState() {
    if (!this.pendingSessionId) return undefined;
    return {
      sessionId: this.pendingSessionId,
      draft: this.findSession(this.pendingSessionId)?.chatStore.draft ?? "",
      configuration: this.pendingConfiguration,
      name: this.pendingName,
      draftSession: this.pendingDraftPrompt !== undefined,
      resolved: this.pendingDraftPrompt?.resolved ?? false,
      stagedPrompt: this.pendingDraftPrompt
        ? {
            text: this.pendingDraftPrompt.text,
            attachments: this.pendingDraftPrompt.attachments,
          }
        : undefined,
    };
  }

  restorePendingSession(input: {
    sessionId: string;
    draft: string;
    configuration?: ChatConfiguration;
    name?: string;
    draftSession?: boolean;
    resolved?: boolean;
    stagedPrompt?: { text: string; attachments: Attachment[] };
  }) {
    if (this.pendingSessionId && this.pendingSessionId !== input.sessionId) {
      const targetIndex = this.targets.indexOf(this.pendingSessionId);
      if (targetIndex >= 0) this.targets.splice(targetIndex, 1);
      const summaryIndex = this.summaries.findIndex(
        (summary) => summary.sessionId === this.pendingSessionId,
      );
      if (summaryIndex >= 0) this.summaries.splice(summaryIndex, 1);
      this.pendingSessionId = undefined;
    }
    const session = this.prepareNewSession(input.sessionId, input.name);
    this.pendingConfiguration = input.configuration;
    this.pendingName = input.name;
    this.pendingDraftPrompt =
      input.draftSession && input.stagedPrompt
        ? { ...input.stagedPrompt, resolved: input.resolved ?? false }
        : undefined;
    if (this.pendingDraftPrompt)
      this.updateSummary(input.sessionId, (summary) => ({
        ...summary,
        draft: true,
        resolved: this.pendingDraftPrompt?.resolved ?? false,
      }));
    session.chatStore.setDraft(input.draft);
  }

  async handoff(sessionId: string, entryId: string, prompt?: string, resolveSource = false) {
    try {
      const result = await this.client.cakeChats.handoff(
        {
          ...this.target(sessionId),
          entryId,
          prompt: prompt?.trim() || undefined,
          resolveSource,
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return false;
      await this.open(result.sessionId);
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
      return false;
    }
  }

  async renameSession(sessionId: string, name: string) {
    name = name.trim();
    if (!name) return false;
    if (this.isPendingSession(sessionId)) {
      this.pendingName = name;
      this.updateSummary(sessionId, (summary) => ({
        ...summary,
        title: name,
        modifiedAt: new Date().toISOString(),
      }));
      this.props.persist?.();
      return true;
    }
    try {
      await this.client.cakeChats.rename(
        { ...this.target(sessionId), name },
        { signal: this.signal },
      );
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error, "Cake Chat could not rename the session");
      return false;
    }
  }

  applyApplicationState(state: ApplicationState) {
    this.resolvedSessionIds.splice(
      0,
      this.resolvedSessionIds.length,
      ...state.resolvedCakeChatSessionIds,
    );
    this.applyResolvedState();
  }

  /** Resolution mutations are queued so an older response cannot overwrite newer application state. */
  async resolveSession(sessionId: string, resolved: boolean) {
    if (resolved && !(await (this.props.prepareSessionResolution?.([sessionId]) ?? true))) return;
    if (this.signal.aborted) return;
    if (this.isDraftSession(sessionId) && this.pendingDraftPrompt) {
      this.pendingDraftPrompt = { ...this.pendingDraftPrompt, resolved };
      this.updateSummary(sessionId, (summary) => ({ ...summary, resolved }));
      this.props.persist?.();
      return;
    }
    if (resolved && this.isPendingSession(sessionId)) {
      this.discardPendingSession(sessionId);
      return;
    }
    await this.enqueueResolution([sessionId], resolved, false);
  }

  async deleteSession(sessionId: string) {
    if (!this.isSessionResolved(sessionId) || this.signal.aborted) return;
    try {
      await this.resolutionQueue;
      await this.client.cakeChats.deleteResolved(this.target(sessionId), {
        signal: this.signal,
      });
      if (this.signal.aborted) return;
      this.removeSession(sessionId);
      if (this.selectedSessionId === sessionId) this.selectedSessionId = undefined;
    } catch (error) {
      if (!this.signal.aborted) this.reportError(error);
    }
  }

  isSessionResolved(sessionId: string) {
    return this.resolvedSessionIds.includes(sessionId);
  }

  async resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const ids = [...sessionIds];
    if (resolved && !(await (this.props.prepareSessionResolution?.(ids) ?? true))) return 0;
    if (this.signal.aborted) return 0;
    const persistedIds = ids.filter((sessionId) => {
      if (this.isDraftSession(sessionId) && this.pendingDraftPrompt) {
        this.pendingDraftPrompt = { ...this.pendingDraftPrompt, resolved };
        this.updateSummary(sessionId, (summary) => ({ ...summary, resolved }));
        this.props.persist?.();
        return false;
      }
      if (!resolved || !this.isPendingSession(sessionId)) return true;
      this.discardPendingSession(sessionId);
      return false;
    });
    await this.enqueueResolution(persistedIds, resolved, true);
    return ids.length;
  }

  private enqueueResolution(sessionIds: readonly string[], resolved: boolean, rethrow: boolean) {
    const run = async () => {
      try {
        for (const sessionId of sessionIds) {
          const target = this.target(sessionId);
          if (resolved) await this.client.cakeChats.resolve(target, { signal: this.signal });
          else await this.client.cakeChats.restore(target, { signal: this.signal });
          if (this.signal.aborted) return;
          const index = this.resolvedSessionIds.indexOf(sessionId);
          if (resolved && index < 0) this.resolvedSessionIds.push(sessionId);
          if (!resolved && index >= 0) this.resolvedSessionIds.splice(index, 1);
          this.updateSummary(sessionId, (summary) => ({ ...summary, resolved }));
        }
      } catch (error) {
        if (!this.signal.aborted) this.reportError(error);
        if (rethrow) throw error;
      }
    };
    const result = this.resolutionQueue.then(run, run);
    this.resolutionQueue = result.catch(() => undefined);
    return result;
  }

  async openSession(sessionId: string) {
    if (!this.hydrated) await this.initialize();
    if (sessionId === this.pendingSessionId || sessionId === this.selectedSessionId) {
      this.selectedSessionId = sessionId;
      return;
    }
    return this.open(sessionId);
  }

  reportError(error: unknown, context?: string) {
    if (this.activeSession) this.activeSession.reportError(error, context);
    else {
      const described = describeError(error, context);
      this.error = described.message;
      this.errorDetails = described.details;
    }
  }

  private prepareNewSession(sessionId: string = crypto.randomUUID(), name?: string) {
    if (this.pendingSessionId) return this.findSession(this.pendingSessionId)!;
    const now = new Date().toISOString();
    this.pendingSessionId = sessionId;
    this.pendingConfiguration = undefined;
    this.pendingName = name;
    this.targets.push(sessionId);
    this.summaries.unshift({
      sessionId,
      title: name ?? "New chat",
      createdAt: now,
      modifiedAt: now,
      messageCount: 0,
      resolved: false,
    });
    this.selectedSessionId = sessionId;
    return this.findSession(sessionId)!;
  }

  private discardPendingSession(sessionId: string) {
    this.removeSession(sessionId);
    this.pendingSessionId = undefined;
    this.pendingConfiguration = undefined;
    this.pendingName = undefined;
    this.pendingDraftPrompt = undefined;
    if (this.selectedSessionId === sessionId) {
      const next = this.loadedSessions[0];
      if (next) this.selectedSessionId = next.sessionId;
      else this.prepareNewSession();
    }
  }

  private removeSession(sessionId: string) {
    const targetIndex = this.targets.indexOf(sessionId);
    if (targetIndex >= 0) this.targets.splice(targetIndex, 1);
    const summaryIndex = this.summaries.findIndex((summary) => summary.sessionId === sessionId);
    if (summaryIndex >= 0) this.summaries.splice(summaryIndex, 1);
    this.props.persist?.();
  }

  private replaceSummaries(summaries: readonly CakeChatSummaryProjection[]) {
    const resolvedIds = new Set(this.resolvedSessionIds);
    const pending = this.pendingSessionId
      ? this.summaries.find((summary) => summary.sessionId === this.pendingSessionId)
      : undefined;
    const next = summaries.map((summary) => ({
      ...summary,
      resolved: resolvedIds.has(summary.sessionId),
    }));
    if (pending && !next.some((summary) => summary.sessionId === pending.sessionId))
      next.push(pending);
    next.sort(compareSessionSummariesForSidebar);
    this.summaries.splice(0, this.summaries.length, ...next);
  }

  private updateSummary(
    sessionId: string,
    update: (summary: CakeChatSummaryProjection) => CakeChatSummaryProjection,
  ) {
    const index = this.summaries.findIndex((summary) => summary.sessionId === sessionId);
    const summary = this.summaries[index];
    if (index >= 0 && summary) this.summaries.splice(index, 1, update(summary));
  }

  private applyResolvedState() {
    const resolvedIds = new Set(this.resolvedSessionIds);
    for (let index = 0; index < this.summaries.length; index += 1) {
      const summary = this.summaries[index]!;
      if (summary.draft) continue;
      const resolved = resolvedIds.has(summary.sessionId);
      if (summary.resolved !== resolved) this.summaries.splice(index, 1, { ...summary, resolved });
    }
  }
}
