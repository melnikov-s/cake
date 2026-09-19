/**
 * Rejection for accepted input the user withdrew: an abort, a removed queue
 * row, or a cleared queue. It is a cancellation, never a runtime failure.
 */
export class TurnCanceledError extends Error {
  override readonly name = "TurnCanceledError";
}

/** Correlates accepted Pi input with consumption and the actual settled run. */
export class RuntimeTurnCompletion {
  private readonly pending = new Map<
    string,
    {
      content: string;
      consumed: boolean;
      mayTransform: boolean;
      resolve(): void;
      reject(error: Error): void;
    }
  >();

  track(id: string, content: string, mayTransform = false) {
    const completion = new Promise<void>((resolve, reject) => {
      this.pending.set(id, { content, consumed: false, mayTransform, resolve, reject });
    });
    // Delivery can still be awaiting Pi when an abort rejects its completion.
    void completion.catch(() => undefined);
    return completion;
  }

  consume(content: string) {
    const waiting = [...this.pending.values()].filter((item) => !item.consumed);
    const entry =
      waiting.find((item) => item.content === content) ?? waiting.find((item) => item.mayTransform);
    if (entry) entry.consumed = true;
  }

  executingIds() {
    return [...this.pending].filter(([, item]) => item.consumed).map(([id]) => id);
  }

  settle() {
    for (const [id, item] of this.pending) {
      if (!item.consumed) continue;
      this.pending.delete(id);
      item.resolve();
    }
  }

  forget(id: string) {
    this.pending.delete(id);
  }

  finishHandledInput(id: string) {
    this.pending.get(id)?.resolve();
    this.pending.delete(id);
  }

  failHandledInput(id: string, error: unknown) {
    this.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
    this.pending.delete(id);
  }

  /** Rejects one unconsumed correlation whose input was removed from the queue. */
  cancelQueued(content: string) {
    const match = [...this.pending].find(([, item]) => !item.consumed && item.content === content);
    if (!match) return;
    this.pending.delete(match[0]);
    match[1].reject(new TurnCanceledError("Queued input was canceled"));
  }

  cancel(queuedOnly = false) {
    for (const [id, item] of this.pending) {
      if (queuedOnly && item.consumed) continue;
      this.pending.delete(id);
      item.reject(
        new TurnCanceledError(queuedOnly ? "Queued input was canceled" : "Session was aborted"),
      );
    }
  }

  /** Rejects only input already consumed by the active run, preserving held queue work. */
  cancelExecuting() {
    const ids = this.executingIds();
    for (const id of ids) {
      const item = this.pending.get(id);
      if (!item) continue;
      this.pending.delete(id);
      item.reject(new TurnCanceledError("Session was aborted"));
    }
    return ids;
  }
}
