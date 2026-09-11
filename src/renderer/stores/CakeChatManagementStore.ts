import { Store } from "r-state-tree";
import { SESSION_TITLE_MAX_LENGTH } from "../../ipc/session-contract";
import type { CakeChatTarget } from "../../domain/cake-chats/cake-chat-data";
import { ClientContext } from "./context/ClientContext";
import type { CakeChatPendingSessionsStore } from "./CakeChatPendingSessionsStore";

export interface CakeChatManagementStoreProps {
  pendingSessions: CakeChatPendingSessionsStore;
  target(sessionId: string): CakeChatTarget;
  removeSession(sessionId: string): void;
  discardPendingSession(sessionId: string): void;
  isSessionResolved(sessionId: string): boolean;
  reportError(error: unknown, context?: string): void;
}

/** Owns Cake Chat rename, tool compaction, resolve, restore, and delete workflows. */
export class CakeChatManagementStore extends Store<CakeChatManagementStoreProps> {
  private resolutionQueue: Promise<void> = Promise.resolve();

  get client() {
    return ClientContext.consume(this)!;
  }

  async toolCompact(sessionId: string, entryId: string, prompt?: string) {
    try {
      await this.client.cakeChats.toolCompact(
        {
          ...this.props.target(sessionId),
          entryId,
          prompt: prompt?.trim() || undefined,
        },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
      return false;
    }
  }

  async renameSession(sessionId: string, name: string) {
    const title = name.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
    if (!title) return false;
    if (this.props.pendingSessions.rename(sessionId, title)) return true;
    try {
      await this.client.cakeChats.rename(
        { ...this.props.target(sessionId), name: title },
        { signal: this.signal },
      );
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted)
        this.props.reportError(error, "Cake Chat could not rename the session");
      return false;
    }
  }

  /** Resolution commands are serialized; the catalog stream remains the only projection writer. */
  async resolveSession(sessionId: string, resolved: boolean) {
    if (this.signal.aborted) return false;
    if (this.props.pendingSessions.conversation(sessionId)?.setDraftResolved(resolved)) return true;
    if (resolved && this.props.pendingSessions.isPending(sessionId)) {
      this.props.discardPendingSession(sessionId);
      return true;
    }
    return this.enqueueResolution([sessionId], resolved, false);
  }

  ensureSessionActive(sessionId: string) {
    if (!this.props.isSessionResolved(sessionId)) return true;
    return this.resolveSession(sessionId, false);
  }

  async resolveSessions(sessionIds: readonly string[], resolved: boolean) {
    const ids = [...sessionIds];
    if (this.signal.aborted) return 0;
    const persistedIds = ids.filter((sessionId) => {
      if (this.props.pendingSessions.conversation(sessionId)?.setDraftResolved(resolved))
        return false;
      if (!resolved || !this.props.pendingSessions.isPending(sessionId)) return true;
      this.props.discardPendingSession(sessionId);
      return false;
    });
    await this.enqueueResolution(persistedIds, resolved, true);
    return ids.length;
  }

  async deleteSession(sessionId: string) {
    if (!this.props.isSessionResolved(sessionId) || this.signal.aborted) return;
    try {
      if (this.props.pendingSessions.conversation(sessionId)?.isDraft) {
        this.props.removeSession(sessionId);
        return;
      }
      await this.resolutionQueue;
      await this.client.cakeChats.deleteResolved(this.props.target(sessionId), {
        signal: this.signal,
      });
      if (!this.signal.aborted) this.props.removeSession(sessionId);
    } catch (error) {
      if (!this.signal.aborted) this.props.reportError(error);
    }
  }

  private enqueueResolution(sessionIds: readonly string[], resolved: boolean, rethrow: boolean) {
    const run = async () => {
      try {
        for (const sessionId of sessionIds) {
          const target = this.props.target(sessionId);
          if (resolved) await this.client.cakeChats.resolve(target, { signal: this.signal });
          else await this.client.cakeChats.restore(target, { signal: this.signal });
          if (this.signal.aborted) return false;
        }
        return true;
      } catch (error) {
        if (!this.signal.aborted) this.props.reportError(error);
        if (rethrow) throw error;
        return false;
      }
    };
    const result = this.resolutionQueue.then(run, run);
    this.resolutionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
