import { Store, snapshot } from "r-state-tree";

/** Window-owned focused conversation and its navigation history. Conversations own their drafts/read state. */
export class SessionLayoutStore extends Store {
  @snapshot history: readonly string[] = [];
  @snapshot historyCursor = -1;

  get focusedSessionId() {
    return this.history[this.historyCursor];
  }

  get focusedSessionHistory(): readonly string[] {
    return this.history;
  }

  restoreFocusedHistorySession(sessionId: string) {
    const cursor = this.history.lastIndexOf(sessionId);
    if (cursor < 0) return false;
    this.historyCursor = cursor;
    return true;
  }

  ensureSession(sessionId: string) {
    this.showSession(sessionId);
  }

  showSession(sessionId: string) {
    if (this.focusedSessionId === sessionId) return;
    this.history = [...this.history.slice(0, this.historyCursor + 1), sessionId];
    this.historyCursor = this.history.length - 1;
  }

  replaceSession(from: string, to: string) {
    this.history = this.history.map((id) => (id === from ? to : id));
  }

  removeSessions(sessionIds: readonly string[]) {
    const removed = new Set(sessionIds);
    const retainedBefore = this.history
      .slice(0, this.historyCursor + 1)
      .filter((id) => !removed.has(id));
    this.history = this.history.filter((id) => !removed.has(id));
    this.historyCursor = this.history.length ? Math.max(0, retainedBefore.length - 1) : -1;
  }

  clear() {
    this.history = [];
    this.historyCursor = -1;
  }

  goBack() {
    if (this.historyCursor <= 0) return undefined;
    this.historyCursor -= 1;
    return this.focusedSessionId;
  }

  goForward() {
    if (this.historyCursor >= this.history.length - 1) return undefined;
    this.historyCursor += 1;
    return this.focusedSessionId;
  }
}
